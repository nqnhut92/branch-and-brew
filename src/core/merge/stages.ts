import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { git } from '../git/ops';
import { run, runBytes, type RunOptions } from '../git/runner';
import { diff3Chunks, type Chunk } from './diff3';
import {
  MAX_MERGE_BYTES, decodeText, detectEol, encodeText, isBinary, joinLines, splitLines, type Eol, type TextEncoding,
} from './text';

/** A conflicted path and the blob it has in each stage of the index; a missing stage is undefined. */
export interface ConflictFile {
  path: string;
  /** Stage 1: the common ancestor. */
  base?: string;
  /** Stage 2: the branch that is checked out ("ours"). */
  mine?: string;
  /** Stage 3: the branch being merged in ("theirs"). */
  theirs?: string;
}

export type Side = 'mine' | 'theirs';

/** Parses `git ls-files -u -z`: "<mode> <oid> <stage>\t<path>" per entry. */
export function parseUnmerged(output: string): ConflictFile[] {
  const files = new Map<string, ConflictFile>();
  for (const entry of output.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [, oid, stage] = entry.slice(0, tab).split(' ');
    const file = entry.slice(tab + 1);
    const f = files.get(file) ?? { path: file };
    if (stage === '1') f.base = oid;
    else if (stage === '2') f.mine = oid;
    else if (stage === '3') f.theirs = oid;
    files.set(file, f);
  }
  return [...files.values()];
}

/** How the two sides disagree, in the words `git status` uses. */
export function describeConflict(f: ConflictFile): string {
  if (f.mine && f.theirs) return f.base ? 'both modified' : 'both added';
  if (f.mine) return f.base ? 'deleted by them' : 'added by us';
  if (f.theirs) return f.base ? 'deleted by us' : 'added by them';
  return 'both deleted';
}

export async function listConflicts(repo: string, options?: RunOptions): Promise<ConflictFile[]> {
  return parseUnmerged(await git(repo, ['ls-files', '-u', '-z'], { noQueue: true, ...options }));
}

async function readBlob(repo: string, oid: string): Promise<Buffer> {
  const r = await runBytes(repo, ['cat-file', 'blob', oid]);
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `cannot read ${oid}`);
  return r.stdout;
}

async function blobSize(repo: string, oid: string): Promise<number> {
  return Number(await git(repo, ['cat-file', '-s', oid], { noQueue: true }));
}

/** How the result is written back: the way the file on the current branch was. */
export interface TextFormat {
  encoding: TextEncoding;
  eol: Eol;
  finalNewline: boolean;
}

export interface TextMerge {
  kind: 'text';
  base: string[];
  mine: string[];
  theirs: string[];
  chunks: Chunk[];
  format: TextFormat;
}

/** A conflict that cannot be edited line by line; `reason` says why. */
export interface WholeFileMerge {
  kind: 'whole';
  reason: 'missing-stage' | 'binary' | 'too-large';
}

/**
 * Reads the three stages of a conflicted file and compares them. A file with a missing stage
 * (added by both, deleted by one side), a binary file or one over 2 MB comes back as `whole`:
 * it can only be resolved by taking one side or deleting it.
 */
export async function loadMerge(repo: string, file: ConflictFile): Promise<TextMerge | WholeFileMerge> {
  if (!file.base || !file.mine || !file.theirs) return { kind: 'whole', reason: 'missing-stage' };
  const oids = [file.base, file.mine, file.theirs];
  const sizes = await Promise.all(oids.map((oid) => blobSize(repo, oid)));
  if (sizes.some((s) => s > MAX_MERGE_BYTES)) return { kind: 'whole', reason: 'too-large' };
  const blobs = await Promise.all(oids.map((oid) => readBlob(repo, oid)));
  if (blobs.some(isBinary)) return { kind: 'whole', reason: 'binary' };
  const [base, mine, theirs] = blobs.map(decodeText);
  const mineLines = splitLines(mine.text);
  const sides = { base: splitLines(base.text).lines, mine: mineLines.lines, theirs: splitLines(theirs.text).lines };
  return {
    kind: 'text', ...sides, chunks: diff3Chunks(sides.base, sides.mine, sides.theirs),
    format: { encoding: mine.encoding, eol: detectEol(mine.text), finalNewline: mineLines.finalNewline },
  };
}

/** Resolves a whole file with one side's version; a side that deleted the file deletes it. */
export async function takeSide(repo: string, file: ConflictFile, side: Side, options?: RunOptions): Promise<void> {
  if (!file[side]) return deleteFile(repo, file.path, options);
  await git(repo, ['checkout', side === 'mine' ? '--ours' : '--theirs', '--', file.path], options);
  await git(repo, ['add', '--', file.path], options);
}

/** Resolves a conflict by removing the file. */
export async function deleteFile(repo: string, file: string, options?: RunOptions): Promise<void> {
  await git(repo, ['rm', '-q', '-f', '--', file], options);
}

/** Writes the merged lines in the file's original encoding and line endings, then stages it. */
export async function saveResult(repo: string, file: string, lines: readonly string[], format: TextFormat, options?: RunOptions): Promise<void> {
  const text = joinLines(lines, format.eol, format.finalNewline);
  await writeFile(path.join(repo, file), encodeText(text, format.encoding));
  // Written exactly as intended: git must not convert line endings on the way into the index
  // differently from how it would for any other edit, so a plain `git add` is right.
  const r = await run(repo, ['add', '--', file], options);
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'git add failed');
}
