import type { BranchInfo } from './refs';

/** Which branches the log shows. Pure, so the log webview can use it too. */

const MAIN_NAMES = ['main', 'master', 'develop'];
/** The log shows at most this many branches at once. */
export const MAX_SCOPE = 6;

/** `main`, `master` or `develop`, whichever exists first; a local branch wins over a remote one. */
export function mainBranch(branches: readonly BranchInfo[]): BranchInfo | undefined {
  for (const remote of [false, true]) {
    for (const name of MAIN_NAMES) {
      const found = branches.find((b) => b.remote === remote && (remote ? b.name.slice(b.name.indexOf('/') + 1) : b.name) === name);
      if (found) return found;
    }
  }
  return undefined;
}

/** The scope with only the current branch left in it; HEAD when the repository is detached. */
export function onlyCurrent(branches: readonly BranchInfo[]): string[] {
  return [branches.find((b) => b.current)?.name ?? 'HEAD'];
}

/**
 * What the log shows before the user picks anything: the current branch (HEAD when detached), its
 * upstream, and the main branch.
 */
export function defaultScope(branches: readonly BranchInfo[]): string[] {
  const current = branches.find((b) => b.current);
  const scope = onlyCurrent(branches);
  const add = (name?: string) => { if (name && !scope.includes(name) && branches.some((b) => b.name === name)) scope.push(name); };
  add(current?.upstream);
  add(mainBranch(branches)?.name);
  return scope;
}

/** Adds or removes a branch; refuses to go past MAX_SCOPE or to empty the scope. */
export function toggleScope(scope: readonly string[], name: string): string[] {
  if (scope.includes(name)) return scope.length > 1 ? scope.filter((s) => s !== name) : [...scope];
  return scope.length >= MAX_SCOPE ? [...scope] : [...scope, name];
}
