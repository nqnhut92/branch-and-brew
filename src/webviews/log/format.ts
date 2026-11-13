/** Small pure helpers of the log view. */

export interface RefTag {
  label: string;
  kind: 'head' | 'branch' | 'tag';
}

/** Turns git's decorations ("HEAD -> main", "origin/main", "tag: v1", "HEAD") into tags to draw. */
export function refTags(refs: readonly string[]): RefTag[] {
  return refs.map((ref): RefTag => {
    if (ref.startsWith('HEAD -> ')) return { label: ref.slice('HEAD -> '.length), kind: 'head' };
    if (ref.startsWith('tag: ')) return { label: ref.slice('tag: '.length), kind: 'tag' };
    return { label: ref, kind: ref === 'HEAD' ? 'head' : 'branch' };
  });
}

const two = (n: number) => String(n).padStart(2, '0');

/** Local time as 2026-11-13 09:05, the same width in every row. */
export function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The slice of rows to draw for a scroll position, with a few extra rows on each side. */
export function visibleRange(scrollTop: number, viewportHeight: number, rowHeight: number, count: number, overscan = 8) {
  // A scroll position left over from a longer list must not point past the end of this one.
  const start = Math.min(count, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const end = Math.min(count, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { start, end: Math.max(start, end) };
}

/** Status letters of a working tree entry, staged then unstaged, e.g. "M·", "·M", "A·", "??". */
export function changeLetters(change: { index: string; worktree: string }): string {
  if (change.worktree === '?') return '??';
  const letter = (s: string) => (s === '.' ? '·' : s);
  return letter(change.index) + letter(change.worktree);
}
