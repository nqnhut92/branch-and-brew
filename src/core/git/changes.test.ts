import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { conflictRepo, createRepo, linearRepo } from '../../../test/fixtures/repos';
import { discard, getChanges, isStaged, isUnstaged, parseChanges, stage, unstage } from './changes';

describe('parseChanges', () => {
  it('reads ordinary, renamed, conflicted and untracked entries', () => {
    const out = [
      '# branch.oid abc',
      '1 .M N... 100644 100644 100644 h1 h2 dir with space/a b.txt',
      '1 A. N... 000000 100644 100644 h1 h2 new.txt',
      '2 R. N... 100644 100644 100644 h1 h2 R100 moved é.txt', 'old.txt',
      'u UU N... 100644 100644 100644 100644 h1 h2 h3 both.txt',
      '? untracked dir/',
    ].join('\0') + '\0';
    const changes = parseChanges(out);
    expect(changes).toEqual([
      { path: 'dir with space/a b.txt', index: '.', worktree: 'M', conflicted: false },
      { path: 'new.txt', index: 'A', worktree: '.', conflicted: false },
      { path: 'moved é.txt', oldPath: 'old.txt', index: 'R', worktree: '.', conflicted: false },
      { path: 'both.txt', index: 'U', worktree: 'U', conflicted: true },
      { path: 'untracked dir/', index: '.', worktree: '?', conflicted: false },
    ]);
    expect(changes.map(isStaged)).toEqual([false, true, true, false, false]);
    expect(changes.map(isUnstaged)).toEqual([true, false, false, true, true]);
  });
});

describe('working tree on fixtures', () => {
  it('stages, unstages and discards', async () => {
    const f = await linearRepo();
    const read = (p: string) => readFileSync(path.join(f.dir, p), 'utf8');
    try {
      expect(await getChanges(f.dir)).toEqual([]);
      f.write('a.txt', 'edited\n');
      f.write('new file.txt', 'new\n');
      await f.git('mv', 'dir with space/b.txt', 'dir with space/c.txt');
      let changes = await getChanges(f.dir);
      expect(changes.map((c) => [c.path, c.index, c.worktree])).toEqual([
        ['a.txt', '.', 'M'], ['dir with space/c.txt', 'R', '.'], ['new file.txt', '.', '?'],
      ]);

      await stage(f.dir, ['a.txt', 'new file.txt']);
      changes = await getChanges(f.dir);
      expect(changes.map((c) => [c.path, c.index, c.worktree])).toEqual([
        ['a.txt', 'M', '.'], ['dir with space/c.txt', 'R', '.'], ['new file.txt', 'A', '.'],
      ]);
      await unstage(f.dir, ['a.txt']);
      expect((await getChanges(f.dir))[0]).toMatchObject({ path: 'a.txt', index: '.', worktree: 'M' });

      for (const c of await getChanges(f.dir)) await discard(f.dir, c);
      expect(await getChanges(f.dir)).toEqual([]);
      expect(read('a.txt')).toBe('one\ntwo\n');
      expect(read('dir with space/b.txt')).toBe('b\n');
      expect(existsSync(path.join(f.dir, 'new file.txt'))).toBe(false);
      expect(existsSync(path.join(f.dir, 'dir with space/c.txt'))).toBe(false);

      f.write('scratch/x.txt', 'x\n');
      await discard(f.dir, (await getChanges(f.dir))[0]);
      expect(existsSync(path.join(f.dir, 'scratch'))).toBe(false);
    } finally { f.dispose(); }
  });

  it('unstages before the first commit and reports conflicts', async () => {
    const empty = await createRepo('unborn');
    const conflict = await conflictRepo();
    try {
      empty.write('a.txt', 'a\n');
      await stage(empty.dir, ['a.txt']);
      expect((await getChanges(empty.dir))[0]).toMatchObject({ index: 'A' });
      await unstage(empty.dir, ['a.txt']);
      expect((await getChanges(empty.dir))[0]).toMatchObject({ index: '.', worktree: '?' });

      const conflicted = (await getChanges(conflict.dir)).filter((c) => c.conflicted).map((c) => c.path);
      expect(conflicted.sort()).toEqual(['both.txt', 'crlf.txt']);
    } finally { empty.dispose(); conflict.dispose(); }
  });
});
