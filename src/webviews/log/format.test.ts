import { describe, expect, it } from 'vitest';
import { changeLetters, formatDate, refTags, visibleRange } from './format';

describe('log view helpers', () => {
  it('turns decorations into tags', () => {
    expect(refTags(['HEAD -> main', 'origin/main', 'tag: v1.0', 'HEAD'])).toEqual([
      { label: 'main', kind: 'head' }, { label: 'origin/main', kind: 'branch' },
      { label: 'v1.0', kind: 'tag' }, { label: 'HEAD', kind: 'head' },
    ]);
  });

  it('filters out remote branches that are not in scope', () => {
    const branches = [
      { name: 'main', remote: false },
      { name: 'origin/main', remote: true },
      { name: 'origin/devin/other', remote: true },
    ];
    const tags = refTags(['HEAD -> main', 'origin/devin/other', 'origin/main', 'tag: v1.0'], ['main'], branches);
    expect(tags).toEqual([
      { label: 'main', kind: 'head' },
      { label: 'v1.0', kind: 'tag' },
    ]);
  });

  it('formats dates at a fixed width in local time', () => {
    const d = new Date(2026, 0, 5, 9, 7);
    expect(formatDate(d.getTime() / 1000)).toBe('2026-01-05 09:07');
  });

  it('draws only the rows near the viewport', () => {
    expect(visibleRange(0, 240, 24, 50_000)).toEqual({ start: 0, end: 18 });
    expect(visibleRange(24_000, 240, 24, 50_000)).toEqual({ start: 992, end: 1018 });
    expect(visibleRange(999_999, 240, 24, 10)).toEqual({ start: 10, end: 10 });
    expect(visibleRange(0, 240, 24, 3)).toEqual({ start: 0, end: 3 });
  });

  it('shows staged and unstaged letters', () => {
    expect(changeLetters({ index: 'M', worktree: '.' })).toBe('M·');
    expect(changeLetters({ index: '.', worktree: 'D' })).toBe('·D');
    expect(changeLetters({ index: '.', worktree: '?' })).toBe('??');
  });
});
