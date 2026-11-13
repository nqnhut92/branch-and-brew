import { describe, expect, it } from 'vitest';
import { diff3Chunks } from './diff3';
import { automaticChoice, buildResult, chunkLines, isAutomatic } from './result';

const L = (s: string) => s.split('');
const sides = { base: L('abcdefghij'), mine: L('aBcdeXghiJ'), theirs: L('abcDeXghiK') };
const chunks = diff3Chunks(sides.base, sides.mine, sides.theirs);

describe('merge result', () => {
  it('starts from base with non-conflicting changes applied', () => {
    const r = buildResult(chunks, sides, true);
    expect(r.lines.join('')).toBe('aBcDeXghij');
    expect(r.regions.map((x) => [chunks[x.chunk].kind, x.start, x.length, x.choice])).toEqual([
      ['mine', 1, 1, 'mine'], ['theirs', 3, 1, 'theirs'], ['same', 5, 1, 'mine'], ['conflict', 9, 1, 'base'],
    ]);
  });

  it('starts from plain base when asked to apply nothing', () => {
    const r = buildResult(chunks, sides, false);
    expect(r.lines).toEqual(sides.base);
    expect(r.regions.every((x) => x.choice === 'base')).toBe(true);
  });

  it('gives the lines of every choice for a chunk', () => {
    const conflict = chunks.find((c) => c.kind === 'conflict')!;
    expect(isAutomatic(conflict)).toBe(false);
    expect(['base', 'mine', 'theirs', 'mine-theirs', 'theirs-mine'].map((c) => chunkLines(conflict, sides, c as never).join('')))
      .toEqual(['j', 'J', 'K', 'JK', 'KJ']);
    expect(chunks.filter(isAutomatic).map(automaticChoice)).toEqual(['mine', 'theirs', 'mine']);
  });

  it('keeps regions of zero lines for deletions and insertions', () => {
    const s = { base: L('abc'), mine: L('ac'), theirs: L('abcX') };
    const c = diff3Chunks(s.base, s.mine, s.theirs);
    const applied = buildResult(c, s, true);
    expect(applied.lines.join('')).toBe('acX');
    expect(applied.regions.map((x) => [x.start, x.length])).toEqual([[1, 0], [2, 1]]);
    const plain = buildResult(c, s, false);
    expect(plain.regions.map((x) => [x.start, x.length])).toEqual([[1, 1], [3, 0]]);
  });
});
