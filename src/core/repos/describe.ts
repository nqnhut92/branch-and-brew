import type { RepoStatus } from '../git/status';

const OPERATION_LABEL = { merge: 'merging', rebase: 'rebasing', 'cherry-pick': 'cherry-picking', revert: 'reverting' } as const;

/** The short text after the repo name: "main ↑1 ↓2 · 3 changed", "up to date", "rebasing · 1 conflict". */
export function describeStatus(s: RepoStatus): string {
  const head = s.branch ?? (s.oid ? `detached ${s.oid.slice(0, 7)}` : 'no commits');
  const parts: string[] = [];
  if (s.operation) parts.push(OPERATION_LABEL[s.operation]);
  if (s.conflicted) parts.push(`${s.conflicted} conflict${s.conflicted === 1 ? '' : 's'}`);
  const other = s.changed - s.conflicted;
  if (other) parts.push(`${other} changed`);
  const sync = [s.ahead ? `↑${s.ahead}` : '', s.behind ? `↓${s.behind}` : ''].filter(Boolean).join(' ');
  const branch = sync ? `${head} ${sync}` : head;
  if (!parts.length && !sync) return `${branch} · up to date`;
  return [branch, ...parts].join(' · ');
}

export type RowState = 'clean' | 'changed' | 'conflict' | 'operation' | 'error';

export function rowState(s: RepoStatus | undefined, error?: string): RowState {
  if (error || !s) return 'error';
  if (s.conflicted) return 'conflict';
  if (s.operation) return 'operation';
  return s.changed || s.ahead || s.behind ? 'changed' : 'clean';
}

export type PullOutcome =
  | { repo: string; result: 'ok' }
  | { repo: string; result: 'conflict' }
  | { repo: string; result: 'failed'; message: string };

/** One-line summary of a bulk pull, naming the repositories that need attention. */
export function summarizePull(outcomes: PullOutcome[], name: (repo: string) => string): string {
  const ok = outcomes.filter((o) => o.result === 'ok').length;
  const conflicts = outcomes.filter((o) => o.result === 'conflict').map((o) => name(o.repo));
  const failed = outcomes.filter((o): o is Extract<PullOutcome, { result: 'failed' }> => o.result === 'failed');
  const parts = [`Pulled ${ok} of ${outcomes.length} repositories.`];
  if (conflicts.length) parts.push(`Conflict: ${conflicts.join(', ')}.`);
  if (failed.length) parts.push(`Failed: ${failed.map((f) => `${name(f.repo)} (${firstLine(f.message)})`).join(', ')}.`);
  return parts.join(' ');
}

function firstLine(s: string): string {
  const line = s.split('\n').map((l) => l.trim()).find((l) => /error|fatal/i.test(l)) ?? s.split('\n')[0] ?? '';
  return line.replace(/^(error|fatal):\s*/i, '').slice(0, 120);
}
