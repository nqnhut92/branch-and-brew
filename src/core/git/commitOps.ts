import { git } from './ops';
import type { RunOptions } from './runner';

/** Actions of the log's commit menu. Each throws a GitCommandError carrying git's own message. */

/** Checks a commit out with a detached HEAD. */
export const checkoutCommit = (repo: string, hash: string, options?: RunOptions) =>
  git(repo, ['switch', '--detach', hash], options);

/** Creates a branch at a commit without switching to it. */
export const createBranchAt = (repo: string, name: string, hash: string, options?: RunOptions) =>
  git(repo, ['branch', '--', name, hash], options);

export const createTag = (repo: string, name: string, hash: string, options?: RunOptions) =>
  git(repo, ['tag', '--', name, hash], options);

/** A merge commit is picked or reverted relative to its first parent. */
const mainline = (isMerge: boolean) => (isMerge ? ['-m', '1'] : []);

export const cherryPick = (repo: string, hash: string, isMerge = false, options?: RunOptions) =>
  git(repo, ['cherry-pick', ...mainline(isMerge), hash], options);

export const revert = (repo: string, hash: string, isMerge = false, options?: RunOptions) =>
  git(repo, ['revert', '--no-edit', ...mainline(isMerge), hash], options);

export type ResetMode = 'soft' | 'mixed' | 'hard';

export const reset = (repo: string, mode: ResetMode, hash: string, options?: RunOptions) =>
  git(repo, ['reset', `--${mode}`, hash], options);

export async function isValidTagName(repo: string, name: string): Promise<boolean> {
  try {
    await git(repo, ['check-ref-format', `refs/tags/${name}`], { noQueue: true });
    return !name.startsWith('-');
  } catch {
    return false;
  }
}
