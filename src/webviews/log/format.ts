/** Small pure helpers of the log view. */

export interface RefTag {
  label: string;
  kind: 'head' | 'branch' | 'tag';
}

/** Turns git's decorations ("HEAD -> main", "origin/main", "tag: v1", "HEAD") into tags to draw. */
export function refTags(
  refs: readonly string[],
  scope?: readonly string[],
  branches?: readonly { name: string; remote?: boolean }[],
): RefTag[] {
  const scopeSet = scope ? new Set(scope) : null;
  const remoteBranchNames = new Set(
    branches ? branches.filter((b) => b.remote).map((b) => b.name) : [],
  );

  return refs
    .map((ref): RefTag | null => {
      if (ref.startsWith('HEAD -> ')) return { label: ref.slice('HEAD -> '.length), kind: 'head' };
      if (ref.startsWith('tag: ')) return { label: ref.slice('tag: '.length), kind: 'tag' };
      if (ref === 'HEAD') return { label: 'HEAD', kind: 'head' };

      const isRemote = remoteBranchNames.has(ref) || (branches ? false : /^[\w.-]+\/[\w.-]+/.test(ref));
      const isLocal = branches ? branches.some((b) => !b.remote && b.name === ref) : false;

      if (isRemote && !isLocal && scopeSet && !scopeSet.has(ref)) {
        return null;
      }

      return { label: ref, kind: 'branch' };
    })
    .filter((t): t is RefTag => t !== null);
}

const two = (n: number) => String(n).padStart(2, '0');

/** Local time as 2026-11-13 09:05, the same width in every row. */
export function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Date formatted with user system locale and time, e.g. "1 Nov 2026, 8:31 PM". */
export function formatSystemDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
  } catch {
    return formatDate(unixSeconds);
  }
}

/** Detailed date with seconds and timezone, e.g. "11 November 2026 at 6:57:29 PM GMT+7". */
export function formatFullDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

/** Formats author or committer as "Name <email>" like SourceTree. */
export function formatPerson(name?: string, email?: string): string {
  if (name && email) return `${name} <${email}>`;
  if (name) return name;
  if (email) return `<${email}>`;
  return '';
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
