import { listBranches, type BranchInfo } from './refs';
import { run, type RunOptions, type RunResult } from './runner';

/** A git command that failed; message is git's own stderr (or stdout), trimmed. */
export class GitCommandError extends Error {
  override name = 'GitCommandError';
  constructor(readonly args: readonly string[], readonly result: RunResult) {
    super((result.stderr || result.stdout).trim() || `git ${args[0]} failed with exit code ${result.exitCode}`);
  }
}

/** Runs git and throws a GitCommandError on a non-zero exit code. */
export async function git(repo: string, args: string[], options?: RunOptions): Promise<string> {
  const r = await run(repo, args, options);
  if (r.exitCode !== 0) throw new GitCommandError(args, r);
  return r.stdout;
}

/** Network commands can wait on credentials; give them longer than the 60 s default. */
const NETWORK_TIMEOUT = 10 * 60_000;

export const fetch = (repo: string, options?: RunOptions) =>
  git(repo, ['fetch', '--prune'], { timeoutMs: NETWORK_TIMEOUT, ...options });

/** Plain `git pull`, so the user's own config chooses merge or rebase. */
export const pull = (repo: string, options?: RunOptions) =>
  git(repo, ['pull'], { timeoutMs: NETWORK_TIMEOUT, ...options });

export const merge = (repo: string, ref: string, options?: RunOptions) =>
  git(repo, ['merge', ref], options);

export const abortMerge = (repo: string, options?: RunOptions) =>
  git(repo, ['merge', '--abort'], options);

/** Pushes; a branch without upstream is pushed to `remote` and tracks it. */
export async function push(repo: string, branch: string, hasUpstream: boolean, remote = 'origin', options?: RunOptions) {
  const args = hasUpstream ? ['push'] : ['push', '--set-upstream', remote, branch];
  return git(repo, args, { timeoutMs: NETWORK_TIMEOUT, ...options });
}

export { listBranches };
export type BranchRef = Pick<BranchInfo, 'name' | 'remote' | 'current'>;

/** Switches to a local branch, or creates a tracking branch for a remote one. */
export function switchBranch(repo: string, branch: BranchRef, options?: RunOptions) {
  if (!branch.remote) return git(repo, ['switch', branch.name], options);
  const local = branch.name.slice(branch.name.indexOf('/') + 1);
  return git(repo, ['switch', '--track', '-c', local, branch.name], options);
}

export async function isValidBranchName(repo: string, name: string): Promise<boolean> {
  const r = await run(repo, ['check-ref-format', '--branch', name], { noQueue: true });
  return r.exitCode === 0;
}

export const createBranch = (repo: string, name: string, options?: RunOptions) =>
  git(repo, ['switch', '-c', name], options);

export const deleteBranch = (repo: string, name: string, force = false, options?: RunOptions) =>
  git(repo, ['branch', force ? '-D' : '-d', name], options);

export const stash = (repo: string, message?: string, options?: RunOptions) =>
  git(repo, ['stash', 'push', '--include-untracked', ...(message ? ['-m', message] : [])], options);

export const stashPop = (repo: string, options?: RunOptions) => git(repo, ['stash', 'pop'], options);

export async function stashCount(repo: string, options?: RunOptions): Promise<number> {
  const out = await git(repo, ['stash', 'list', '--format=%gd'], { noQueue: true, ...options });
  return out.split('\n').filter(Boolean).length;
}

export async function remotes(repo: string, options?: RunOptions): Promise<string[]> {
  return (await git(repo, ['remote'], { noQueue: true, ...options })).split('\n').filter(Boolean);
}
