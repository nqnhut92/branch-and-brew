import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseTodo, type TodoEntry } from './todo';

export interface RebaseState {
  /** `merge` is the interactive machinery (`.git/rebase-merge`); `apply` the older patch-based one. */
  backend: 'merge' | 'apply';
  /** Branch being rebased, undefined for a detached HEAD. */
  branch?: string;
  /** Commit the branch is being rebased onto. */
  onto?: string;
  /** Commands already run; the last one is where the rebase stopped. */
  done: TodoEntry[];
  remaining: TodoEntry[];
  /** Step N of M. */
  step: number;
  total: number;
  /** Commit the rebase stopped at (a conflict, or an `edit`). */
  stoppedHash?: string;
  /** True when it stopped for `edit`: the commit is applied and can be amended. */
  amend: boolean;
}

/** Builds the state from the files of the rebase folder; `read` returns undefined for a missing file. */
export function parseRebaseState(backend: 'merge' | 'apply', read: (name: string) => string | undefined): RebaseState {
  const text = (name: string) => read(name)?.trim() || undefined;
  const head = text('head-name');
  const branch = head?.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : undefined;
  if (backend === 'apply') {
    const step = Number(text('next') ?? 0);
    return { backend, branch, onto: text('onto'), done: [], remaining: [], step, total: Number(text('last') ?? step), amend: false };
  }
  const done = parseTodo(read('done') ?? '');
  const remaining = parseTodo(read('git-rebase-todo') ?? '');
  return {
    backend, branch, onto: text('onto'), done, remaining,
    step: done.length, total: done.length + remaining.length,
    stoppedHash: text('stopped-sha'), amend: read('amend') !== undefined,
  };
}

/** Reads the rebase in progress from the git directory, or undefined when there is none. */
export function readRebaseState(gitDir: string): RebaseState | undefined {
  for (const [folder, backend] of [['rebase-merge', 'merge'], ['rebase-apply', 'apply']] as const) {
    const dir = path.join(gitDir, folder);
    if (!existsSync(dir)) continue;
    return parseRebaseState(backend, (name) => {
      try {
        return readFileSync(path.join(dir, name), 'utf8');
      } catch {
        return undefined;
      }
    });
  }
  return undefined;
}

export type PauseKind = 'conflict' | 'edit' | 'stopped';

/** Why a rebase is waiting: conflicted files, an `edit` stop, or anything else Continue resumes. */
export function pauseKind(state: RebaseState, conflicted: number): PauseKind {
  if (conflicted > 0) return 'conflict';
  return state.amend ? 'edit' : 'stopped';
}
