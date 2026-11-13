import { describe, expect, it } from 'vitest';
import { bigRepo, createRepo, linearRepo, mergeRepo } from '../../../test/fixtures/repos';
import { layoutLanes } from './lanes';
import { getLog, matchesSearch, parseLog, PAGE_SIZE } from './log';

describe('parseLog', () => {
  it('splits records and fields, keeps subjects with separators-like text', () => {
    const rec = (...f: string[]) => f.join('\x1f');
    const out = [
      rec('a'.repeat(40), 'b'.repeat(40) + ' ' + 'c'.repeat(40), 'Nick', 'n@x', '1700000000', 'HEAD -> main, tag: v1', 'Merge: a, b | c'),
      rec('b'.repeat(40), '', 'Ann', 'a@x', '1690000000', '', ''),
    ].join('\0') + '\0';
    expect(parseLog(out)).toEqual([
      { hash: 'a'.repeat(40), parents: ['b'.repeat(40), 'c'.repeat(40)], author: 'Nick', email: 'n@x', date: 1700000000,
        refs: ['HEAD -> main', 'tag: v1'], subject: 'Merge: a, b | c' },
      { hash: 'b'.repeat(40), parents: [], author: 'Ann', email: 'a@x', date: 1690000000, refs: [], subject: '' },
    ]);
  });
});

describe('getLog on fixtures', () => {
  it('reads the merge fixture in topological order with refs and pages', async () => {
    const f = await mergeRepo();
    try {
      const all = await getLog(f.dir);
      expect(all.map((c) => c.subject).sort()).toEqual(['Base', 'Feature work', 'Main work', 'Merge feature']);
      // Topological: every commit comes before its parents.
      const index = new Map(all.map((c, i) => [c.hash, i]));
      for (const [i, c] of all.entries()) for (const p of c.parents) expect(index.get(p)!).toBeGreaterThan(i);
      expect(all[0].parents).toHaveLength(2);
      expect(all[0].refs).toContain('HEAD -> main');
      expect(all.find((c) => c.subject === 'Feature work')!.refs).toContain('feature');
      const page = await getLog(f.dir, { skip: 1, limit: 2 });
      expect(page.map((c) => c.hash)).toEqual(all.slice(1, 3).map((c) => c.hash));
    } finally { f.dispose(); }
  });

  it('returns nothing for an unborn branch', async () => {
    const f = await createRepo('empty');
    try {
      expect(await getLog(f.dir)).toEqual([]);
    } finally { f.dispose(); }
  });
});

describe('search and path filter', () => {
  it('matches subject, author, email and hash prefix, ignoring case', () => {
    const c = { hash: 'abc123', parents: [], author: 'Nick Nguyen', email: 'nick@example.com', date: 0, refs: [], subject: 'Fix Crash' };
    expect(['fix cr', 'NGUYEN', 'example.com', 'abc1', '  '].map((t) => matchesSearch(c, t))).toEqual([true, true, true, true, true]);
    expect(['c123', 'other'].map((t) => matchesSearch(c, t))).toEqual([false, false]);
  });

  it('searches the whole history and pages the matches', async () => {
    const f = await linearRepo();
    try {
      expect((await getLog(f.dir, { search: 'second' })).map((c) => c.subject)).toEqual(['Second']);
      expect((await getLog(f.dir, { search: 'fixture@' })).map((c) => c.subject)).toEqual(['Third', 'Second', 'First']);
      expect((await getLog(f.dir, { search: 'fixture', skip: 1, limit: 1 })).map((c) => c.subject)).toEqual(['Second']);
      expect(await getLog(f.dir, { search: 'nothing like this' })).toEqual([]);
    } finally { f.dispose(); }
  });

  it('limits history to one path, spaces included', async () => {
    const f = await linearRepo();
    try {
      expect((await getLog(f.dir, { path: 'a.txt' })).map((c) => c.subject)).toEqual(['Second', 'First']);
      expect((await getLog(f.dir, { path: 'dir with space/b.txt' })).map((c) => c.subject)).toEqual(['Third']);
    } finally { f.dispose(); }
  });
});

describe('large history', () => {
  it('reads and lays out the first page of 50,000 commits in under a second', async () => {
    const f = await bigRepo(50_000);
    try {
      expect(Number(await f.git('rev-list', '--count', 'HEAD'))).toBeGreaterThanOrEqual(50_000);
      // Best of three: the first run also pays for a cold file cache.
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        const commits = await getLog(f.dir);
        const { rows } = layoutLanes(commits);
        best = Math.min(best, performance.now() - start);
        expect(commits).toHaveLength(PAGE_SIZE);
        expect(rows).toHaveLength(PAGE_SIZE);
      }
      console.log(`first page of 50,000 commits: ${best.toFixed(0)} ms`);
      expect(best).toBeLessThan(1000);
      const deep = await getLog(f.dir, { skip: 40_000 });
      expect(deep).toHaveLength(PAGE_SIZE);
    } finally { f.dispose(); }
  }, 120_000);
});
