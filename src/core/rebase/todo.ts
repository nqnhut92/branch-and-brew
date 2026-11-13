/**
 * The todo list of an interactive rebase: model, checks and git's file format. Pure: the rebase
 * webview imports this file, so it must not import node or the git runner.
 */

export const ACTIONS = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'] as const;
export type TodoAction = typeof ACTIONS[number];

export interface TodoEntry {
  /** `other` is a line this model does not edit (exec, break, label, merge…); it is kept as is. */
  action: TodoAction | 'other';
  hash: string;
  subject: string;
  /** New message for a reword, or for the commit a squash produces. */
  message?: string;
  /** The whole line, for `other`. */
  raw?: string;
}

const SHORT: Record<string, TodoAction> = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' };

/**
 * Parses git-rebase-todo (also the `done` file). Recent git writes `pick <hash> # <subject>`,
 * older git `pick <hash> <subject>`; both are accepted, as are the one-letter commands.
 */
export function parseTodo(text: string): TodoEntry[] {
  const entries: TodoEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(\S+)\s+([0-9a-fA-F]{4,64})(?:\s+(.*))?$/);
    const action = m && (SHORT[m[1]] ?? ((ACTIONS as readonly string[]).includes(m[1]) ? m[1] as TodoAction : undefined));
    if (!m || !action) {
      entries.push({ action: 'other', hash: '', subject: trimmed, raw: trimmed });
      continue;
    }
    entries.push({ action, hash: m[2].toLowerCase(), subject: (m[3] ?? '').replace(/^#\s?/, '') });
  }
  return entries;
}

/** Writes the list in git's todo format. Dropped commits are written as `drop` lines. */
export function serializeTodo(entries: readonly TodoEntry[]): string {
  const lines = entries.map((e) => (e.action === 'other' ? e.raw ?? e.subject : `${e.action} ${e.hash} # ${e.subject}`));
  return (lines.length ? lines.join('\n') : 'noop') + '\n';
}

const kept = (e: TodoEntry) => e.action === 'pick' || e.action === 'reword' || e.action === 'edit';
const melds = (e: TodoEntry) => e.action === 'squash' || e.action === 'fixup';

/**
 * What is wrong with the list, or undefined. `hasPrevious` is true while a rebase is running and
 * a commit has already been applied, so the remaining list may start with a squash.
 */
export function validateTodo(entries: readonly TodoEntry[], hasPrevious = false): string | undefined {
  let previous = hasPrevious;
  for (const e of entries) {
    if (melds(e) && !previous) return `"${e.subject}" cannot be ${e.action}: there is no commit before it to combine with.`;
    if (kept(e) || melds(e)) previous = true;
  }
  if (!hasPrevious && entries.length && !entries.some((e) => kept(e) || e.action === 'other')) {
    return 'Every commit is dropped; nothing would be left of the branch.';
  }
  return undefined;
}

/** Commits going in and commits coming out. */
export function countResult(entries: readonly TodoEntry[]): { incoming: number; outgoing: number } {
  return { incoming: entries.filter((e) => e.action !== 'other').length, outgoing: entries.filter(kept).length };
}

/** Squashes every commit that is not dropped into the first one. */
export function squashAll(entries: readonly TodoEntry[]): TodoEntry[] {
  let first = true;
  return entries.map((e) => {
    if (e.action === 'drop' || e.action === 'other') return e;
    if (first) {
      first = false;
      return melds(e) ? { ...e, action: 'pick' as const } : e;
    }
    return { ...e, action: 'squash' as const };
  });
}

export function moveEntry<T>(entries: readonly T[], from: number, to: number): T[] {
  const list = [...entries];
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return list;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return list;
}

/** True when two hashes name the same commit, one of them possibly abbreviated. */
export function sameCommit(a: string, b: string): boolean {
  return !!a && !!b && (a.startsWith(b) || b.startsWith(a));
}

/**
 * Compares the prepared list with the one git generated for the same rebase. They must hold the
 * same commits (in any order); otherwise the history moved since the table was drawn.
 */
export function matchPlan(planned: readonly TodoEntry[], actual: readonly TodoEntry[]): string | undefined {
  const ours = planned.filter((e) => e.action !== 'other');
  const theirs = actual.filter((e) => e.action !== 'other');
  const missing = theirs.filter((t) => !ours.some((o) => sameCommit(o.hash, t.hash)));
  const extra = ours.filter((o) => !theirs.some((t) => sameCommit(o.hash, t.hash)));
  if (!missing.length && !extra.length && ours.length === theirs.length) return undefined;
  return 'The commits to rebase are not the ones in the table any more. Reload the table and try again.';
}

export type MessageDecision = { kind: 'keep' } | { kind: 'use'; text: string } | { kind: 'ask' };

/**
 * Decides what to answer when git opens the message editor, from the commands already done (the
 * last one is the one being applied) and the messages prepared in the table.
 */
export function decideMessage(done: readonly TodoEntry[], lookup: (hash: string) => string | undefined): MessageDecision {
  const current = done[done.length - 1];
  if (!current) return { kind: 'keep' };
  if (current.action === 'reword') {
    const text = lookup(current.hash);
    return text?.trim() ? { kind: 'use', text } : { kind: 'ask' };
  }
  if (current.action === 'squash') {
    // The message set on any squash row of this chain, the latest row first.
    for (let i = done.length - 1; i >= 0 && melds(done[i]); i--) {
      const text = done[i].action === 'squash' ? lookup(done[i].hash) : undefined;
      if (text?.trim()) return { kind: 'use', text };
    }
    return { kind: 'ask' };
  }
  return { kind: 'keep' };
}

/** A message as git hands it to the editor, without its comment lines. */
export function stripComments(text: string): string {
  return text.split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}
