import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { conflictRepo, createRepo, linearRepo, pausedRebaseRepo } from '../../../test/fixtures/repos';
import { getStatus, parseStatus } from './status';

describe('parseStatus', () => {
  it('reads branch headers and counts entries, including a rename with its extra field', () => {
    const out = [
      '# branch.oid 1234abcd', '# branch.head feature/x', '# branch.upstream origin/feature/x', '# branch.ab +2 -3',
      '1 .M N... 100644 100644 100644 aaa aaa a b.txt',
      '2 R. N... 100644 100644 100644 aaa aaa R100 new name.txt', 'old name.txt',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? untracked é.txt', '',
    ].join('\0');
    expect(parseStatus(out)).toEqual({
      oid: '1234abcd', branch: 'feature/x', upstream: 'origin/feature/x', ahead: 2, behind: 3, changed: 4, conflicted: 1,
    });
  });

  it('handles detached HEAD, unborn branches and no upstream', () => {
    expect(parseStatus('# branch.oid (initial)\0# branch.head main\0')).toEqual({ branch: 'main', ahead: 0, behind: 0, changed: 0, conflicted: 0 });
    expect(parseStatus('# branch.oid abc\0# branch.head (detached)\0').branch).toBeUndefined();
  });
});

describe('getStatus on fixtures', () => {
  it('clean repo', async () => {
    const f = await linearRepo();
    try {
      const s = await getStatus(f.dir);
      expect(s).toMatchObject({ branch: 'main', changed: 0, conflicted: 0, ahead: 0, behind: 0 });
      expect(s.operation).toBeUndefined();
    } finally { f.dispose(); }
  });

  it('ahead and behind its upstream, with changes', async () => {
    const f = await createRepo('ab');
    try {
      await f.commit('Base', { 'a.txt': 'a\n' });
      await f.git('branch', 'up');
      await f.git('branch', '--set-upstream-to=up');
      await f.commit('Mine', { 'b.txt': 'b\n' });
      await f.git('switch', 'up');
      await f.commit('Theirs 1', { 'c.txt': 'c\n' });
      await f.commit('Theirs 2', { 'd.txt': 'd\n' });
      await f.git('switch', 'main');
      writeFileSync(path.join(f.dir, 'new.txt'), 'x');
      expect(await getStatus(f.dir)).toMatchObject({ upstream: 'up', ahead: 1, behind: 2, changed: 1 });
    } finally { f.dispose(); }
  });

  it('merge conflict', async () => {
    const f = await conflictRepo();
    try {
      expect(await getStatus(f.dir)).toMatchObject({ conflicted: 2, operation: 'merge' });
    } finally { f.dispose(); }
  });

  it('paused rebase', async () => {
    const f = await pausedRebaseRepo();
    try {
      const s = await getStatus(f.dir);
      expect(s.operation).toBe('rebase');
      expect(s.branch).toBeUndefined();
      expect(s.conflicted).toBe(1);
    } finally { f.dispose(); }
  });
});
