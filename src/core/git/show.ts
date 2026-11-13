import { git } from './ops';
import type { RunOptions } from './runner';

export interface FileChange {
  /** Status letter: A, M, D, R, C, T. */
  status: string;
  path: string;
  /** Previous path of a renamed or copied file. */
  oldPath?: string;
}

export interface CommitDetail {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  /** Author date, Unix seconds. */
  date: number;
  committer: string;
  committerEmail: string;
  commitDate: number;
  /** Full message, subject and body. */
  message: string;
  /** Changes against the first parent (everything, for a root commit). */
  files: FileChange[];
}

const READ = { noQueue: true } as const;
const DETAIL_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%B'].join('%x1f');

/** Parses `--name-status -z`: "M\0path\0", and "R100\0old\0new\0" for renames and copies. */
export function parseNameStatus(output: string): FileChange[] {
  const fields = output.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i + 1 < fields.length; i++) {
    const status = fields[i][0];
    if (!status) continue;
    if (status === 'R' || status === 'C') {
      files.push({ status, oldPath: fields[i + 1], path: fields[i + 2] });
      i += 2;
    } else {
      files.push({ status, path: fields[i + 1] });
      i += 1;
    }
  }
  return files;
}

export function parseDetail(output: string): Omit<CommitDetail, 'files'> {
  const [hash, parents, author, email, date, committer, committerEmail, commitDate, ...message] = output.split('\x1f');
  return {
    hash, parents: parents ? parents.split(' ') : [], author, email, date: Number(date),
    committer, committerEmail, commitDate: Number(commitDate),
    message: message.join('\x1f').replace(/\n+$/, ''),
  };
}

export async function getCommitDetail(repo: string, hash: string, options?: RunOptions): Promise<CommitDetail> {
  const [detail, files] = await Promise.all([
    git(repo, ['show', '-s', `--format=${DETAIL_FORMAT}`, hash, '--'], { ...READ, ...options }),
    // --diff-merges=first-parent (git 2.31+): a merge lists what it brought into the branch.
    git(repo, ['diff-tree', '--root', '-r', '-z', '-M', '--name-status', '--no-commit-id', '--diff-merges=first-parent', hash, '--'],
      { ...READ, ...options }),
  ]);
  return { ...parseDetail(detail), files: parseNameStatus(files) };
}

/** Files that differ between `from` and `to`; without `to`, between `from` and the working tree. */
export async function changedFiles(repo: string, from: string, to?: string, options?: RunOptions): Promise<FileChange[]> {
  const out = await git(repo, ['diff', '--name-status', '-z', '-M', from, ...(to ? [to] : []), '--'], { ...READ, ...options });
  return parseNameStatus(out);
}

/**
 * Content of a file at a revision (`git show <rev>:<path>`); use rev "" for the index. A file that
 * does not exist there reads as empty, which is what a diff of an added or deleted file needs.
 */
export async function showFile(repo: string, rev: string, path: string, options?: RunOptions): Promise<string> {
  try {
    return await git(repo, ['show', `${rev}:${path}`], { ...READ, ...options });
  } catch {
    return '';
  }
}

/** `git blame` as text, one line per source line: short hash, author, date, line. */
export function blame(repo: string, path: string, rev?: string, options?: RunOptions): Promise<string> {
  return git(repo, ['blame', '--date=short', ...(rev ? [rev] : []), '--', path], { ...READ, ...options });
}
