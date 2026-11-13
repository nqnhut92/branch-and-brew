import * as assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getStatus } from '../../src/core/git/status';
import type { TestApi } from '../../src/host/extension';
import type { MergePanel } from '../../src/host/panels/mergePanel';
import { interactiveRebaseRepo, linearRepo, pausedRebaseRepo, type Fixture } from '../fixtures/repos';

async function api(): Promise<TestApi> {
  return vscode.extensions.getExtension<TestApi>('nqnhut92.branch-and-brew')!.activate();
}

const closed = (panel: MergePanel) => new Promise<void>((resolve) => panel.onDidClose(resolve));

suite('Interactive rebase', () => {
  const fixtures: Fixture[] = [];

  suiteTeardown(async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await new Promise((r) => setTimeout(r, 500));
    fixtures.forEach((f) => f.dispose());
  });

  test('reorder, squash, reword and drop in one run, with a conflict resolved midway', async () => {
    const f = await interactiveRebaseRepo();
    fixtures.push(f);
    const { openRebase, resolveFile } = await api();
    const panel = openRebase(f.dir, 'main');
    const subjects = (s: { rows: { subject: string }[] }) => s.rows.map((r) => r.subject);

    const plan = await panel.whenState((s) => s.phase === 'plan' && s.rows.length === 6);
    assert.deepStrictEqual(plan.errors, []);
    assert.deepStrictEqual(subjects(plan), ['Add one', 'Add two', 'Fix two', 'Change a', 'Add fvie', 'Debug junk']);
    assert.deepStrictEqual([plan.incoming, plan.outgoing], [6, 6]);

    // A squash in the first row cannot run, and the table says so.
    panel.perform({ action: 'setAction', index: 0, value: 'squash' });
    assert.match((await panel.whenState((s) => !!s.problem)).problem!, /cannot be squash/);
    panel.perform({ action: 'reset' });
    await panel.whenState((s) => !s.problem && s.rows[0].action === 'pick');

    // Squash "Fix two" into "Add two"; reword "Add fvie" and move it above "Change a".
    panel.perform({ action: 'setAction', index: 2, value: 'squash' });
    panel.perform({ action: 'setAction', index: 4, value: 'reword' });
    panel.perform({ action: 'setMessage', index: 4, value: 'Add five' });
    panel.perform({ action: 'move', index: 4, to: 3 });
    const edited = await panel.whenState((s) => s.rows[3]?.subject === 'Add fvie' && s.rows[3].action === 'reword');
    assert.deepStrictEqual(subjects(edited), ['Add one', 'Add two', 'Fix two', 'Add fvie', 'Change a', 'Debug junk']);
    assert.deepStrictEqual([edited.incoming, edited.outgoing], [6, 5]);

    // Start: the squash has no prepared message, so git waits and the message box fills.
    panel.perform({ action: 'start' });
    const asking = await panel.whenState((s) => s.phase === 'message' && !s.busy);
    assert.strictEqual(asking.pendingMessage, 'Add two\n\nFix two');
    panel.perform({ action: 'setMessage', value: 'Add two, fixed' });
    await panel.whenState((s) => s.pendingMessage === 'Add two, fixed');
    panel.perform({ action: 'continue' });

    // The reword uses its prepared message; "Change a" stops on a conflict.
    const paused = await panel.whenState((s) => s.phase === 'paused' && !s.busy);
    assert.strictEqual(paused.pause, 'conflict');
    assert.strictEqual(paused.done, 5);
    assert.deepStrictEqual(subjects(paused), ['Debug junk']);
    assert.strictEqual((await getStatus(f.dir)).conflicted, 1);

    // Resolve it in the three-pane merge, whose titles now speak of a rebase.
    const merge = (await resolveFile(f.dir, 'a.txt'))!;
    const init = await merge.handle('init', null);
    assert.match(init.labels.theirs, /commit being applied/);
    await merge.whenState((s) => s.conflicts === 1);
    merge.perform({ action: 'accept', side: 'theirs', conflict: 0 });
    await merge.whenState((s) => s.unresolved === 0);
    const saved = closed(merge);
    merge.perform({ action: 'save' });
    await saved;

    // While paused the remaining rows are still editable: drop the last commit, then continue.
    await panel.whenState((s) => s.phase === 'paused' && s.pause === 'stopped' && !s.busy);
    panel.perform({ action: 'setAction', index: 0, value: 'drop' });
    await panel.whenState((s) => s.rows[0]?.action === 'drop');
    panel.perform({ action: 'continue' });
    const done = await panel.whenState((s) => s.phase === 'done' && !s.busy);
    assert.deepStrictEqual(done.errors, []);

    assert.deepStrictEqual((await f.git('log', '--format=%s')).split('\n'),
      ['Change a', 'Add five', 'Add two, fixed', 'Add one', 'Main change', 'Base']);
    assert.strictEqual(readFileSync(path.join(f.dir, 'two.txt'), 'utf8'), 'two, fixed\n');
    assert.strictEqual(readFileSync(path.join(f.dir, 'a.txt'), 'utf8'), 'topic\n');
    assert.strictEqual(readFileSync(path.join(f.dir, 'dir with space/five é.txt'), 'utf8'), 'five\r\n');
    assert.ok(!existsSync(path.join(f.dir, 'junk.txt')), 'the dropped commit is gone');
    const status = await getStatus(f.dir);
    assert.deepStrictEqual([status.operation, status.branch, status.changed], [undefined, 'topic', 0]);
    panel.dispose();
  });

  test('a rebase started outside shows its progress and aborts back to the start', async () => {
    const f = await pausedRebaseRepo();
    fixtures.push(f);
    const before = await f.git('rev-parse', 'topic');
    const panel = (await api()).openRebase(f.dir);
    const paused = await panel.whenState((s) => s.phase === 'paused');
    assert.strictEqual(paused.pause, 'conflict');
    assert.deepStrictEqual([paused.done, paused.rows.length], [1, 1]);
    const view = await panel.handle('state', null);
    assert.deepStrictEqual([view.branch, view.step, view.total], ['topic', 1, 2]);

    // The Abort button asks in a modal dialog, which a test cannot answer; the step after it runs here.
    assert.strictEqual((await panel.abortNow()).phase, 'done');
    await panel.whenState((s) => s.phase === 'done');
    assert.strictEqual((await getStatus(f.dir)).operation, undefined);
    assert.strictEqual(await f.git('rev-parse', 'HEAD'), before);
    panel.dispose();
  });

  test('the log menu rebases onto a commit and opens the table from a commit', async () => {
    const f = await linearRepo();
    fixtures.push(f);
    const main = await f.git('rev-parse', 'main');
    await f.git('switch', '-c', 'side', 'main~1');
    const one = await f.commit('Side one', { 's1.txt': '1\n' });
    await f.commit('Side two', { 's2.txt': '2\n' });
    const { openLog, openRebase, states } = await api();
    await states.refresh(f.dir);
    const log = openLog(f.dir);

    // "Interactive rebase from here" on Side one: both side commits go into the table.
    assert.strictEqual(await log.handle('commitAction', { action: 'rebaseInteractive', hash: one }), false);
    const panel = openRebase(f.dir);
    const plan = await panel.whenState((s) => s.phase === 'plan' && s.rows.length > 0);
    assert.deepStrictEqual(plan.rows.map((r) => r.subject), ['Side one', 'Side two']);
    panel.dispose();

    // "Rebase current branch onto this" on the tip of main: no conflict, so no panel stays open.
    assert.strictEqual(await log.handle('commitAction', { action: 'rebaseOnto', hash: main }), true);
    assert.deepStrictEqual((await f.git('log', '--format=%s')).split('\n'), ['Side two', 'Side one', 'Third', 'Second', 'First']);
    assert.strictEqual((await getStatus(f.dir)).operation, undefined);
    log.dispose();
  });
});
