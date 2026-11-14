import { describe, expect, it } from 'vitest';
import { diff3Chunks } from './diff3';
import { accept, choiceOf, ignore, isResolved, pendingSides, sidesOf, startSessions, unresolvedConflicts } from './session';

const L = (s: string) => s.split('');
const chunks = diff3Chunks(L('abcdefghij'), L('aBcdeXghiJ'), L('abcDeXghiK')); // mine, theirs, same, conflict

describe('merge session', () => {
  it('starts with automatic chunks accepted when they were applied', () => {
    const applied = startSessions(chunks, true);
    expect(applied.map((s) => [s.kind, s.taken, isResolved(s)])).toEqual([
      ['mine', ['mine'], true], ['theirs', ['theirs'], true], ['same', ['mine'], true], ['conflict', [], false],
    ]);
    expect(unresolvedConflicts(applied)).toBe(1);
    const plain = startSessions(chunks, false);
    expect(plain.map((s) => pendingSides(s))).toEqual([['mine'], ['theirs'], ['mine'], ['mine', 'theirs']]);
    expect(unresolvedConflicts(plain)).toBe(1);
  });

  it('offers the sides a chunk kind has', () => {
    expect(['unchanged', 'mine', 'theirs', 'same', 'conflict'].map((k) => sidesOf(k as never))).toEqual([
      [], ['mine'], ['theirs'], ['mine'], ['mine', 'theirs'],
    ]);
  });

  it('accepts one side, then adds the other below it, in either order', () => {
    const conflict = startSessions(chunks, true)[3];
    const mine = accept(conflict, 'mine');
    expect([choiceOf(mine), isResolved(mine), pendingSides(mine)]).toEqual(['mine', true, ['theirs']]);
    const both = accept(mine, 'theirs');
    expect(choiceOf(both)).toBe('mine-theirs');
    expect(isResolved(both)).toBe(true);
    expect(choiceOf(accept(accept(conflict, 'theirs'), 'mine'))).toBe('theirs-mine');
    expect(accept(mine, 'mine')).toBe(mine);
  });

  it('resolves a conflict when both sides are ignored, and keeps base', () => {
    const conflict = startSessions(chunks, true)[3];
    const one = ignore(conflict, 'mine');
    expect(isResolved(one)).toBe(false);
    const both = ignore(one, 'theirs');
    expect([isResolved(both), choiceOf(both), pendingSides(both)]).toEqual([true, 'base', []]);
    const kept = accept(ignore(conflict, 'theirs'), 'mine');
    expect([choiceOf(kept), isResolved(kept), pendingSides(kept)]).toEqual(['mine', true, []]);
  });
});
