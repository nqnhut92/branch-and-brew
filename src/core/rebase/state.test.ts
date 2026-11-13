import { afterAll, describe, expect, it } from 'vitest';
import { gitDir } from '../git/status';
import { pausedRebaseRepo, linearRepo, type Fixture } from '../../../test/fixtures/repos';
import { parseRebaseState, pauseKind, readRebaseState } from './state';

describe('parseRebaseState', () => {
  const files: Record<string, string> = {
    'head-name': 'refs/heads/topic\n',
    onto: '1234567890abcdef\n',
    done: 'pick aaaaaaa # One\nsquash bbbbbbb # Two\n',
    'git-rebase-todo': 'pick ccccccc # Three\n\n# Rebase 1234567..ccccccc onto 1234567 (3 commands)\n',
    'stopped-sha': 'bbbbbbb\n',
  };

  it('reads branch, progress and the stopped commit', () => {
    const s = parseRebaseState('merge', (n) => files[n]);
    expect(s).toMatchObject({ backend: 'merge', branch: 'topic', onto: '1234567890abcdef', step: 2, total: 3, stoppedHash: 'bbbbbbb', amend: false });
    expect(s.done.map((d) => d.action)).toEqual(['pick', 'squash']);
    expect(s.remaining.map((d) => d.subject)).toEqual(['Three']);
    expect(pauseKind(s, 1)).toBe('conflict');
    expect(pauseKind(s, 0)).toBe('stopped');
  });

  it('knows an edit stop from the amend file and a detached HEAD', () => {
    const s = parseRebaseState('merge', (n) => ({ ...files, amend: 'bbbbbbb\n', 'head-name': 'detached HEAD\n' })[n]);
    expect(s.branch).toBeUndefined();
    expect(pauseKind(s, 0)).toBe('edit');
  });

  it('reads the progress of the apply backend', () => {
    expect(parseRebaseState('apply', (n) => ({ next: '2\n', last: '5\n', 'head-name': 'refs/heads/x\n' } as Record<string, string>)[n]))
      .toMatchObject({ backend: 'apply', branch: 'x', step: 2, total: 5 });
  });
});

describe('readRebaseState', () => {
  const fixtures: Fixture[] = [];
  afterAll(() => fixtures.forEach((f) => f.dispose()));

  it('reads a rebase paused on a conflict', async () => {
    const f = await pausedRebaseRepo();
    fixtures.push(f);
    const s = readRebaseState(await gitDir(f.dir))!;
    expect(s.branch).toBe('topic');
    expect(s.done.map((d) => d.subject)).toEqual(['Topic 1']);
    expect(s.remaining.map((d) => d.subject)).toEqual(['Topic 2']);
    expect([s.step, s.total]).toEqual([1, 2]);
    expect(s.stoppedHash).toBeTruthy();
  });

  it('is undefined without a rebase', async () => {
    const f = await linearRepo();
    fixtures.push(f);
    expect(readRebaseState(await gitDir(f.dir))).toBeUndefined();
  });
});
