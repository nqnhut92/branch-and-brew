import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { run, type RunOptions } from './runner';

export type Operation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface RepoStatus {
  /** Branch name, or undefined when HEAD is detached. */
  branch?: string;
  /** Commit hash, or undefined on an unborn branch. */
  oid?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  /** Staged, unstaged and untracked entries (conflicts included). */
  changed: number;
  conflicted: number;
  operation?: Operation;
}

/**
 * Parses `git status --porcelain=v2 --branch -z`. Entries are NUL-terminated; a rename or copy
 * (type 2) carries one extra NUL-terminated field, its original path.
 */
export function parseStatus(output: string): Omit<RepoStatus, 'operation'> {
  const s: Omit<RepoStatus, 'operation'> = { ahead: 0, behind: 0, changed: 0, conflicted: 0 };
  const fields = output.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.startsWith('# ')) {
      const [, key, ...rest] = f.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid' && value !== '(initial)') s.oid = value;
      else if (key === 'branch.head' && value !== '(detached)') s.branch = value;
      else if (key === 'branch.upstream') s.upstream = value;
      else if (key === 'branch.ab') {
        const m = value.match(/^\+(\d+) -(\d+)$/);
        if (m) { s.ahead = Number(m[1]); s.behind = Number(m[2]); }
      }
      continue;
    }
    const type = f[0];
    if (type === '1' || type === '?') s.changed++;
    else if (type === '2') { s.changed++; i++; }
    else if (type === 'u') { s.changed++; s.conflicted++; }
  }
  return s;
}

/** Detects an operation in progress from the files git leaves in the git directory. */
export function detectOperation(gitDir: string): Operation | undefined {
  const has = (p: string) => existsSync(path.join(gitDir, p));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  return undefined;
}

/** Absolute git directory of a repository (handles worktrees and `.git` files). */
export async function gitDir(repo: string, options?: RunOptions): Promise<string> {
  const r = await run(repo, ['rev-parse', '--absolute-git-dir'], { noQueue: true, ...options });
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'not a git repository');
  return r.stdout.trim();
}

export async function getStatus(repo: string, options?: RunOptions): Promise<RepoStatus> {
  // --no-optional-locks: background refreshes must not take the index lock (git-status docs).
  const r = await run(repo, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z'], { noQueue: true, ...options });
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'git status failed');
  return { ...parseStatus(r.stdout), operation: detectOperation(await gitDir(repo, options)) };
}
