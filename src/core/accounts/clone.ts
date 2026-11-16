import { existsSync, readdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { git } from '../git/ops';
import type { RunOptions } from '../git/runner';
import { folderNameOf } from './model';

/** Cloning can wait on a slow network or a credential prompt. */
const CLONE_TIMEOUT = 60 * 60_000;

/** Where a clone of `url` under `parent` goes; throws when a non-empty folder is in the way. */
export function cloneTarget(url: string, parent: string): string {
  const target = path.join(parent, folderNameOf(url));
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} already exists and is not empty.`);
  return target;
}

/**
 * `git clone <url> <parent>/<name>`; resolves with the new repository's folder. A clone that
 * fails or is cancelled takes its half-written folder with it, so the next try finds the way free.
 * It skips the per-folder git queue: that queue is keyed by `parent`, and clones into one parent
 * would otherwise run one after another.
 */
export async function cloneRepo(url: string, parent: string, options?: RunOptions): Promise<string> {
  const target = cloneTarget(url, parent);
  const existed = existsSync(target);
  try {
    await git(parent, ['clone', '--progress', '--', url, target], { timeoutMs: CLONE_TIMEOUT, noQueue: true, ...options });
  } catch (e) {
    if (!existed) rmSync(target, { recursive: true, force: true });
    throw e;
  }
  return target;
}

export interface CloneProgress {
  /** What git is doing: "Receiving objects", "Resolving deltas". */
  phase: string;
  /** Share of the whole clone, 0 to 100. */
  percent: number;
}

/** Where each phase sits on the way from 0 to 100 (receiving takes most of the time). */
const PHASES: Record<string, [from: number, span: number]> = {
  'Enumerating objects': [0, 0],
  'Counting objects': [0, 0],
  'Compressing objects': [0, 0],
  'Receiving objects': [0, 80],
  'Resolving deltas': [80, 15],
  'Updating files': [95, 5],
  'Checking out files': [95, 5],
};

const PROGRESS_LINE = /^(?:remote: )?(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Checking out files):\s+(\d+)%/;

/**
 * The newest progress line in a chunk of `git clone --progress` output. Git rewrites one line
 * with carriage returns, so a chunk can hold several; a line cut off by the chunk is skipped.
 */
export function parseCloneProgress(chunk: string): CloneProgress | undefined {
  const lines = chunk.split(/[\r\n]+/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(PROGRESS_LINE);
    if (!m) continue;
    const [from, span] = PHASES[m[1]];
    return { phase: m[1], percent: Math.round(from + (span * Math.min(100, Number(m[2]))) / 100) };
  }
  return undefined;
}

/** Last non-empty line of git's output that is not a progress line, for an error shown to the user. */
export function lastMessage(text: string): string {
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !PROGRESS_LINE.test(l));
  return lines[lines.length - 1] ?? '';
}
