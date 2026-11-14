import { isStaged, isUnstaged, type WorkingChange } from './changeState';
import { git } from './ops';
import { run, type RunOptions } from './runner';

export { isStaged, isUnstaged, type WorkingChange };

/** Parses the file entries of `git status --porcelain=v2 -z`; header lines are skipped. */
export function parseChanges(output: string): WorkingChange[] {
  const fields = output.split('\0');
  const changes: WorkingChange[] = [];
  // Paths may contain spaces, so a path is everything after a fixed number of fields.
  const rest = (f: string, skip: number) => f.split(' ').slice(skip).join(' ');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const xy = f.slice(2, 4);
    if (f.startsWith('1 ')) changes.push({ path: rest(f, 8), index: xy[0], worktree: xy[1], conflicted: false });
    else if (f.startsWith('2 ')) changes.push({ path: rest(f, 9), oldPath: fields[++i], index: xy[0], worktree: xy[1], conflicted: false });
    else if (f.startsWith('u ')) changes.push({ path: rest(f, 10), index: xy[0], worktree: xy[1], conflicted: true });
    else if (f.startsWith('? ')) changes.push({ path: f.slice(2), index: '.', worktree: '?', conflicted: false });
  }
  return changes;
}

export async function getChanges(repo: string, options?: RunOptions): Promise<WorkingChange[]> {
  const r = await run(repo, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--ignore-submodules=dirty'], { noQueue: true, ...options });
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'git status failed');
  return parseChanges(r.stdout);
}

export const stage = (repo: string, paths: string[], options?: RunOptions) =>
  git(repo, ['add', '-A', '--', ...paths], options);

/** `git reset -- <paths>` rather than `restore --staged`, which fails before the first commit. */
export const unstage = (repo: string, paths: string[], options?: RunOptions) =>
  git(repo, ['reset', '-q', '--', ...paths], options);

/**
 * Throws away every change to one entry, staged or not: an untracked entry is deleted, a newly
 * added file is removed, anything else goes back to its content in HEAD.
 */
export async function discard(repo: string, change: WorkingChange, options?: RunOptions): Promise<void> {
  if (change.worktree === '?') {
    await git(repo, ['clean', '-f', '-d', '--', change.path], options);
    return;
  }
  if (change.index === 'A' || change.oldPath) await git(repo, ['rm', '-f', '-q', '--', change.path], options);
  const restore = change.oldPath ?? (change.index === 'A' ? undefined : change.path);
  if (restore) await git(repo, ['restore', '--source=HEAD', '--staged', '--worktree', '--', restore], options);
}
