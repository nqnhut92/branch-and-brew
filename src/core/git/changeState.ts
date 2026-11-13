/** Working tree entry and what can be done with it. Pure, so the log webview can use it too. */

/** One entry of the working tree as `git status` sees it. */
export interface WorkingChange {
  path: string;
  /** Previous path of a renamed file. */
  oldPath?: string;
  /** Staged status letter (index against HEAD), or "." when nothing is staged. */
  index: string;
  /** Unstaged status letter (working tree against index), or ".". "?" for an untracked entry. */
  worktree: string;
  conflicted: boolean;
}

export const isStaged = (c: WorkingChange) => !c.conflicted && c.index !== '.';
export const isUnstaged = (c: WorkingChange) => c.conflicted || c.worktree !== '.';
