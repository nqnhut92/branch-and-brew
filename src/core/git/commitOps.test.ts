import { describe, expect, it } from 'vitest';
import { linearRepo, mergeRepo } from '../../../test/fixtures/repos';
import { getChanges } from './changes';
import { checkoutCommit, cherryPick, createBranchAt, createTag, isValidTagName, reset, revert } from './commitOps';
import { getLog } from './log';
import { GitCommandError } from './ops';
import { getStatus } from './status';

describe('commit actions', () => {
  it('checks out a commit, and creates a branch and a tag on it', async () => {
    const f = await linearRepo();
    try {
      const [third, second] = await getLog(f.dir);
      await createBranchAt(f.dir, 'from-second', second.hash);
      await createTag(f.dir, 'v1', second.hash);
      expect(await f.git('rev-parse', 'from-second', 'v1')).toBe(`${second.hash}\n${second.hash}`);
      expect((await getStatus(f.dir)).branch).toBe('main');
      await expect(createTag(f.dir, 'v1', third.hash)).rejects.toBeInstanceOf(GitCommandError);
      expect(await isValidTagName(f.dir, 'v2.0')).toBe(true);
      expect(await isValidTagName(f.dir, 'bad name')).toBe(false);
      expect(await isValidTagName(f.dir, '-x')).toBe(false);

      await checkoutCommit(f.dir, second.hash);
      const s = await getStatus(f.dir);
      expect(s.branch).toBeUndefined();
      expect(s.oid).toBe(second.hash);
    } finally { f.dispose(); }
  });

  it('cherry-picks and reverts, merges included', async () => {
    const f = await mergeRepo();
    try {
      const log = await getLog(f.dir);
      const by = (subject: string) => log.find((c) => c.subject === subject)!;
      await f.git('switch', '-c', 'side', by('Base').hash);
      await cherryPick(f.dir, by('Main work').hash);
      await cherryPick(f.dir, by('Merge feature').hash, true);
      expect((await f.git('ls-files')).split('\n')).toEqual(['a.txt', 'f.txt', 'm.txt']);
      await f.git('switch', 'main');
      await revert(f.dir, by('Merge feature').hash, true);
      await revert(f.dir, by('Main work').hash);
      expect(await f.git('ls-files')).toBe('a.txt');
      expect((await getLog(f.dir))[0].subject).toBe('Revert "Main work"');
    } finally { f.dispose(); }
  });

  it('resets soft, mixed and hard', async () => {
    const f = await linearRepo();
    try {
      const [third, second, first] = await getLog(f.dir);
      await reset(f.dir, 'soft', second.hash);
      expect((await getChanges(f.dir)).map((c) => [c.path, c.index])).toEqual([['dir with space/b.txt', 'A']]);
      await reset(f.dir, 'mixed', first.hash);
      expect((await getChanges(f.dir)).map((c) => c.index)).toEqual(['.', '.']);
      await reset(f.dir, 'hard', third.hash);
      expect(await getChanges(f.dir)).toEqual([]);
      expect((await getStatus(f.dir)).oid).toBe(third.hash);
    } finally { f.dispose(); }
  });
});
