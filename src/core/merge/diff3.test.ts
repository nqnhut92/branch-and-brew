import { describe, expect, it } from 'vitest';
import { diff3Chunks, slice, type Chunk } from './diff3';

const L = (s: string) => s.split('');

/** Chunks must tile each of the three files exactly, in order. */
function expectCovers(chunks: Chunk[], base: string[], mine: string[], theirs: string[]) {
  for (const [side, lines] of [['base', base], ['mine', mine], ['theirs', theirs]] as const) {
    let at = 0;
    for (const c of chunks) {
      expect(c[side].start, side).toBe(at);
      at += c[side].length;
    }
    expect(at, side).toBe(lines.length);
  }
}

describe('diff3Chunks', () => {
  it('finds the four kinds of change', () => {
    const base = L('abcdefghij');
    const mine = L('aBcdeXghiJ'); // b→B (mine only), f→X (same on both), j→J (conflict)
    const theirs = L('abcDeXghiK'); // d→D (theirs only)
    const chunks = diff3Chunks(base, mine, theirs);
    expectCovers(chunks, base, mine, theirs);
    expect(chunks.map((c) => c.kind)).toEqual(['unchanged', 'mine', 'unchanged', 'theirs', 'unchanged', 'same', 'unchanged', 'conflict']);
    const conflict = chunks[chunks.length - 1];
    expect([slice(base, conflict.base), slice(mine, conflict.mine), slice(theirs, conflict.theirs)]).toEqual([['j'], ['J'], ['K']]);
    const mineOnly = chunks[1];
    expect([slice(base, mineOnly.base), slice(mine, mineOnly.mine), slice(theirs, mineOnly.theirs)]).toEqual([['b'], ['B'], ['b']]);
  });

  it('handles insertions, deletions and changes at both ends', () => {
    const cases: [string, string, string][] = [
      ['abc', 'xabc', 'abcy'], // insert at start (mine), insert at end (theirs)
      ['abcde', 'abde', 'abcdXe'], // delete (mine), insert (theirs)
      ['abc', 'abc', 'abc'],
      ['', 'ab', 'cd'], // both added, no base
      ['abc', '', 'abc'], // mine emptied the file
      ['abc', 'aXc', 'aYc'],
      ['abcdef', 'Xbcdef', 'abcdeY'],
    ];
    for (const [b, m, t] of cases) {
      const chunks = diff3Chunks(L(b), L(m), L(t));
      expectCovers(chunks, L(b), L(m), L(t));
      for (const c of chunks) {
        if (c.kind === 'unchanged') expect(slice(L(m), c.mine)).toEqual(slice(L(b), c.base));
        if (c.kind === 'mine') expect(slice(L(t), c.theirs)).toEqual(slice(L(b), c.base));
        if (c.kind === 'theirs') expect(slice(L(m), c.mine)).toEqual(slice(L(b), c.base));
        if (c.kind === 'same') expect(slice(L(m), c.mine)).toEqual(slice(L(t), c.theirs));
      }
    }
    expect(diff3Chunks(L(''), L('ab'), L('cd')).map((c) => c.kind)).toEqual(['conflict']);
    expect(diff3Chunks(L('abc'), L('abc'), L('abc')).map((c) => c.kind)).toEqual(['unchanged']);
    expect(diff3Chunks([], [], [])).toEqual([]);
  });
});
