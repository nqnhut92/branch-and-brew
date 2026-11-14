import { describe, expect, it } from 'vitest';
import { createRepo } from '../../../test/fixtures/repos';
import { getStatus } from './status';
import {
  GitCommandError, createBranch, fetch, isValidBranchName, listBranches, merge, pull, push, stash, stashCount, stashPop, switchBranch,
} from './ops';

/** A bare "remote" plus a clone of it, both throwaway. */
async function remoteAndClone() {
  const origin = await createRepo('origin');
  await origin.commit('Base', { 'a.txt': 'base\n' });
  const clone = await createRepo('clone');
  await clone.git('remote', 'add', 'origin', origin.dir);
  await clone.git('fetch', 'origin');
  await clone.git('switch', '-C', 'main', '--track', 'origin/main');
  return { origin, clone, dispose: () => { origin.dispose(); clone.dispose(); } };
}

describe('git operations', () => {
  it('fetch, pull and push with an upstream; push sets one when missing', async () => {
    const { origin, clone, dispose } = await remoteAndClone();
    try {
      await origin.commit('Remote change', { 'r.txt': 'r\n' });
      await fetch(clone.dir);
      expect((await getStatus(clone.dir)).behind).toBe(1);
      await pull(clone.dir);
      expect((await getStatus(clone.dir)).behind).toBe(0);

      await createBranch(clone.dir, 'topic');
      await clone.commit('Topic', { 't.txt': 't\n' });
      await push(clone.dir, 'topic', false);
      expect((await getStatus(clone.dir)).upstream).toBe('origin/topic');
    } finally { dispose(); }
  });

  it('pull reports a conflict as an error and leaves a merge in progress', async () => {
    const { origin, clone, dispose } = await remoteAndClone();
    try {
      await origin.commit('Theirs', { 'a.txt': 'theirs\n' });
      await clone.commit('Mine', { 'a.txt': 'mine\n' });
      await clone.git('config', 'pull.rebase', 'false');
      await expect(pull(clone.dir)).rejects.toBeInstanceOf(GitCommandError);
      expect(await getStatus(clone.dir)).toMatchObject({ operation: 'merge', conflicted: 1 });
    } finally { dispose(); }
  });

  it('lists and switches branches, including a remote one', async () => {
    const { origin, clone, dispose } = await remoteAndClone();
    try {
      await origin.git('branch', 'feature');
      await fetch(clone.dir);
      const branches = await listBranches(clone.dir);
      expect(branches).toContainEqual(expect.objectContaining({ name: 'main', remote: false, current: true }));
      const remoteFeature = branches.find((b) => b.name === 'origin/feature')!;
      expect(remoteFeature.remote).toBe(true);
      await switchBranch(clone.dir, remoteFeature);
      expect(await getStatus(clone.dir)).toMatchObject({ branch: 'feature', upstream: 'origin/feature' });
      expect(await isValidBranchName(clone.dir, 'ok/name')).toBe(true);
      expect(await isValidBranchName(clone.dir, 'bad..name')).toBe(false);
    } finally { dispose(); }
  });

  it('stashes untracked changes and pops them back', async () => {
    const { clone, dispose } = await remoteAndClone();
    try {
      clone.write('new.txt', 'n');
      await stash(clone.dir, 'wip');
      expect((await getStatus(clone.dir)).changed).toBe(0);
      expect(await stashCount(clone.dir)).toBe(1);
      await stashPop(clone.dir);
      expect((await getStatus(clone.dir)).changed).toBe(1);
    } finally { dispose(); }
  });

  it('merges a branch into the current one', async () => {
    const repo = await createRepo('merge-test');
    try {
      await repo.commit('Base', { 'file.txt': 'base\n' });
      await repo.git('branch', 'feature');
      await repo.commit('Main change', { 'main.txt': 'main\n' });
      await merge(repo.dir, 'feature');
      expect((await getStatus(repo.dir)).operation).toBeUndefined();
      expect((await getStatus(repo.dir)).conflicted).toBe(0);
    } finally { repo.dispose(); }
  });
});
