import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getStatus, gitDir } from '../git/status';
import { interactiveRebaseRepo, linearRepo, pausedRebaseRepo, type Fixture } from '../../../test/fixtures/repos';
import { checkRebaseStart, listRebaseCommits, RebaseSession } from './session';
import { readRebaseState } from './state';
import type { TodoEntry } from './todo';

const scriptsDir = path.resolve(__dirname, '../../../scripts');

describe('RebaseSession', () => {
  const fixtures: Fixture[] = [];
  const sessions: RebaseSession[] = [];
  afterAll(async () => {
    await Promise.all(sessions.map((s) => s.dispose()));
    fixtures.forEach((f) => f.dispose());
  });
  const open = (f: Fixture) => {
    fixtures.push(f);
    const session = new RebaseSession({ repo: f.dir, scriptsDir, nodePath: process.execPath });
    sessions.push(session);
    return session;
  };
  const subjects = async (f: Fixture) => (await f.git('log', '--format=%s')).split('\n');
  const by = (entries: TodoEntry[], subject: string) => entries.find((e) => e.subject === subject)!;

  it('lists the commits git would rebase, oldest first', async () => {
    const f = await interactiveRebaseRepo();
    fixtures.push(f);
    expect((await listRebaseCommits(f.dir, 'main')).map((e) => e.subject))
      .toEqual(['Add one', 'Add two', 'Fix two', 'Change a', 'Add fvie', 'Debug junk']);
    expect((await listRebaseCommits(f.dir, null)).map((e) => e.subject)[0]).toBe('Base');
    expect(await checkRebaseStart(f.dir, (await listRebaseCommits(f.dir, 'main'))[0].hash)).toEqual({ dirty: false, publishedOn: [] });
    f.write('a.txt', 'dirty\n');
    f.write('untracked.txt', 'x\n');
    expect((await checkRebaseStart(f.dir)).dirty).toBe(true);
  });

  it('reorders, squashes, rewords and drops in one run with a conflict midway', async () => {
    const f = await interactiveRebaseRepo();
    const session = open(f);
    const all = await listRebaseCommits(f.dir, 'main');
    const plan: TodoEntry[] = [
      by(all, 'Add one'),
      by(all, 'Add two'),
      { ...by(all, 'Fix two'), action: 'squash' },
      { ...by(all, 'Add fvie'), action: 'reword', message: 'Add five' },
      by(all, 'Change a'),
      by(all, 'Debug junk'),
    ];

    // The squash has no prepared message: git waits in the message editor.
    const first = await session.start({ onto: 'main', entries: plan });
    expect(first).toMatchObject({ phase: 'message', message: { text: 'Add two\n\nFix two' } });
    expect(session.pendingMessage?.hash).toBeTruthy();

    // The reword uses its prepared message; "Change a" then conflicts with main.
    const second = await session.answerMessage('Add two, fixed');
    expect(second.phase).toBe('paused');
    expect((await getStatus(f.dir)).conflicted).toBe(1);
    const state = readRebaseState(await gitDir(f.dir))!;
    expect([state.step, state.total]).toEqual([5, 6]);
    expect(state.remaining.map((e) => e.subject)).toEqual(['Debug junk']);

    // Continue is refused while the conflict is unresolved, and says why.
    const refused = await session.continue();
    expect(refused.phase).toBe('paused');
    expect((refused as { error?: string }).error).toBeTruthy();

    // Resolve, drop the remaining commit while paused, continue.
    f.write('a.txt', 'main and topic\n');
    await f.git('add', 'a.txt');
    const last = await session.continue(state.remaining.map((e) => ({ ...e, action: 'drop' as const })));
    expect(last).toEqual({ phase: 'done' });

    expect(await subjects(f)).toEqual(['Change a', 'Add five', 'Add two, fixed', 'Add one', 'Main change', 'Base']);
    expect(readFileSync(path.join(f.dir, 'two.txt'), 'utf8')).toBe('two, fixed\n');
    expect(readFileSync(path.join(f.dir, 'a.txt'), 'utf8')).toBe('main and topic\n');
    expect(readFileSync(path.join(f.dir, 'dir with space/five é.txt'), 'utf8')).toBe('five\r\n');
    expect(existsSync(path.join(f.dir, 'junk.txt'))).toBe(false);
    expect((await getStatus(f.dir)).operation).toBeUndefined();
    expect(await f.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('topic');
  });

  it('stops for an edit, skips a commit and aborts back to where it started', async () => {
    const f = await interactiveRebaseRepo();
    const session = open(f);
    const before = await f.git('rev-parse', 'HEAD');
    const all = await listRebaseCommits(f.dir, 'main');
    const plan = all.map((e) => (e.subject === 'Add one' ? { ...e, action: 'edit' as const } : e));

    expect((await session.start({ onto: 'main', entries: plan })).phase).toBe('paused');
    expect(readRebaseState(await gitDir(f.dir))!.amend).toBe(true);
    // Amend the stopped commit, then go on to the conflict in "Change a" and skip it.
    f.write('one.txt', 'one, amended\n');
    await f.git('commit', '-a', '--amend', '--no-edit');
    expect((await session.continue()).phase).toBe('paused');
    expect((await getStatus(f.dir)).conflicted).toBe(1);
    expect(await session.skip()).toEqual({ phase: 'done' });
    expect(await subjects(f)).toEqual(['Debug junk', 'Add fvie', 'Fix two', 'Add two', 'Add one', 'Main change', 'Base']);
    expect(readFileSync(path.join(f.dir, 'one.txt'), 'utf8')).toBe('one, amended\n');

    // A second rebase, aborted while git waits for a message.
    // (While git waits, it holds this repository's command queue: read the tip first.)
    const head = await f.git('rev-parse', 'topic');
    const again = await listRebaseCommits(f.dir, 'main~1');
    const waiting = await session.start({ onto: 'main~1', entries: again.map((e, i) => (i === 1 ? { ...e, action: 'reword' as const } : e)) });
    expect(waiting.phase).toBe('message');
    await session.abort();
    expect((await getStatus(f.dir)).operation).toBeUndefined();
    expect(await f.git('rev-parse', 'HEAD')).toBe(head);
    expect(head).not.toBe(before);
  });

  it('refuses to start when the commits are not the ones in the table', async () => {
    const f = await interactiveRebaseRepo();
    const session = open(f);
    const all = await listRebaseCommits(f.dir, 'main');
    await expect(session.start({ onto: 'main', entries: all.slice(1) })).rejects.toThrow(/not the ones in the table/);
    expect((await getStatus(f.dir)).operation).toBeUndefined();
    expect((await subjects(f))[0]).toBe('Debug junk');
  });

  it('runs a plain rebase and continues one that was started elsewhere', async () => {
    const linear = await linearRepo();
    const plain = open(linear);
    await linear.git('switch', '-c', 'side', 'HEAD~1');
    await linear.commit('Side', { 's.txt': 's\n' });
    expect(await plain.start({ onto: 'main' })).toEqual({ phase: 'done' });
    expect(await subjects(linear)).toEqual(['Side', 'Third', 'Second', 'First']);

    const paused = await pausedRebaseRepo();
    const session = open(paused);
    paused.write('a.txt', 'resolved\n');
    await paused.git('add', 'a.txt');
    expect(await session.continue()).toEqual({ phase: 'done' });
    expect(await subjects(paused)).toEqual(['Topic 2', 'Topic 1', 'Main change', 'Base']);
  });
});
