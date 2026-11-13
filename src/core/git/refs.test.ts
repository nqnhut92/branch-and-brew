import { describe, expect, it } from 'vitest';
import { createRepo, mergeRepo } from '../../../test/fixtures/repos';
import { listBranches, parseBranches, type BranchInfo } from './refs';
import { MAX_SCOPE, defaultScope, mainBranch, toggleScope } from './scope';

const b = (name: string, extra: Partial<BranchInfo> = {}): BranchInfo =>
  ({ name, remote: name.includes('/'), current: false, hash: 'h-' + name, date: 0, merged: false, ...extra });

describe('parseBranches', () => {
  it('reads fields, skips origin/HEAD and marks merged refs', () => {
    const line = (...f: string[]) => f.join('\0');
    const out = [
      line('*', 'refs/heads/topic', 'aaa', '1700000100', 'origin/topic'),
      line(' ', 'refs/remotes/origin/HEAD', 'bbb', '1700000000', ''),
      line(' ', 'refs/remotes/origin/main', 'bbb', '1700000000', ''),
    ].join('\n') + '\n';
    expect(parseBranches(out, new Set(['refs/remotes/origin/main']))).toEqual([
      { name: 'topic', remote: false, current: true, hash: 'aaa', date: 1700000100, upstream: 'origin/topic', merged: false },
      { name: 'origin/main', remote: true, current: false, hash: 'bbb', date: 1700000000, merged: true },
    ]);
  });
});

describe('scope', () => {
  it('finds the main branch, local before remote, main before master before develop', () => {
    expect(mainBranch([b('develop'), b('master'), b('origin/main')])?.name).toBe('master');
    expect(mainBranch([b('topic'), b('origin/develop')])?.name).toBe('origin/develop');
    expect(mainBranch([b('topic')])).toBeUndefined();
  });

  it('defaults to the current branch, its upstream and main', () => {
    const branches = [b('topic', { current: true, upstream: 'origin/topic' }), b('origin/topic'), b('main'), b('other')];
    expect(defaultScope(branches)).toEqual(['topic', 'origin/topic', 'main']);
    expect(defaultScope([b('main', { current: true })])).toEqual(['main']);
    expect(defaultScope([b('main')])).toEqual(['HEAD', 'main']);
    expect(defaultScope([])).toEqual(['HEAD']);
  });

  it('toggles branches but keeps between one and six', () => {
    expect(toggleScope(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleScope(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleScope(['a'], 'a')).toEqual(['a']);
    const full = Array.from({ length: MAX_SCOPE }, (_, i) => `b${i}`);
    expect(toggleScope(full, 'extra')).toEqual(full);
  });
});

describe('listBranches', () => {
  it('lists branches newest first and dims the ones merged into main', async () => {
    const f = await mergeRepo();
    try {
      await f.git('switch', '-c', 'open');
      await f.commit('Open work', { 'o.txt': 'o\n' });
      const branches = await listBranches(f.dir);
      expect(branches.map((x) => x.name)).toEqual(['open', 'main', 'feature']);
      expect(branches.map((x) => x.merged)).toEqual([false, false, true]);
      expect(branches.find((x) => x.current)?.name).toBe('open');
    } finally { f.dispose(); }
  });

  it('returns nothing for a repository without commits', async () => {
    const f = await createRepo('empty');
    try {
      expect(await listBranches(f.dir)).toEqual([]);
    } finally { f.dispose(); }
  });
});
