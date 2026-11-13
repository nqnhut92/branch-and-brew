import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getChanges } from '../../src/core/git/changes';
import { layoutLanes } from '../../src/core/git/lanes';
import { getLog } from '../../src/core/git/log';
import { addRepos, emptyList } from '../../src/core/repos/model';
import type { TestApi } from '../../src/host/extension';
import { GIT_SCHEME } from '../../src/host/gitContent';
import { bigRepo, linearRepo, mergeRepo, type Fixture } from '../fixtures/repos';

async function api(): Promise<TestApi> {
  return vscode.extensions.getExtension<TestApi>('nqnhut92.branch-and-brew')!.activate();
}

const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;

async function until<T>(get: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

suite('Commit log', () => {
  const fixtures: Fixture[] = [];
  const track = (f: Fixture) => { fixtures.push(f); return f; };

  suiteTeardown(async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const { store } = await api();
    await store.update(() => emptyList());
    // Let the extension drop its file watchers on these repos before deleting them (Windows locks).
    await new Promise((r) => setTimeout(r, 1000));
    fixtures.forEach((f) => f.dispose());
  });

  test('the merge fixture is drawn with the lanes of git log --graph', async () => {
    const f = track(await mergeRepo());
    const panel = (await api()).openLog(f.dir);
    const shown = await panel.whenRendered();
    assert.deepStrictEqual(shown.errors, []);
    assert.strictEqual(shown.commits, 4);
    assert.strictEqual(shown.domRows, 4);
    assert.strictEqual(shown.uncommitted, 0);
    assert.strictEqual(shown.graph, 'Graph on', 'the toolbar says the graph is drawn');

    // Star column of every commit in `git log --graph`, in the order the log lists them.
    const graph = await f.git('log', '--graph', '--topo-order', '--format=%H');
    const expected = graph.split('\n').flatMap((line) => {
      const m = line.match(/^([|\\/ ]*)\*[|\\/ ]*[0-9a-f]{40}/);
      return m ? [m[1].length / 2] : [];
    });
    assert.deepStrictEqual(shown.lanes, expected);
    assert.deepStrictEqual(shown.lanes, layoutLanes(await getLog(f.dir)).rows.map((r) => r.lane));

    const init = await panel.handle('init', null);
    assert.deepStrictEqual(init.scope, ['main']);
    assert.deepStrictEqual(init.branches.map((b) => [b.name, b.merged]), [['main', false], ['feature', true]]);
  });

  test('commit detail lists files and a file opens in the native diff editor', async () => {
    const f = track(await linearRepo());
    const panel = (await api()).openLog(f.dir);
    await panel.whenRendered();
    const [third, second] = await getLog(f.dir);
    const detail = await panel.handle('detail', { hash: second.hash });
    assert.strictEqual(detail.message, 'Second');
    assert.deepStrictEqual(detail.files, [{ status: 'M', path: 'a.txt' }]);

    await panel.handle('fileAction', { action: 'diff', hash: second.hash, path: 'a.txt' });
    const input = await until(() => {
      const i = activeTab()?.input;
      return i instanceof vscode.TabInputTextDiff && i;
    });
    assert.strictEqual(input.original.scheme, GIT_SCHEME);
    assert.strictEqual(input.modified.scheme, GIT_SCHEME);
    const [before, after] = await Promise.all([input.original, input.modified].map((u) => vscode.workspace.openTextDocument(u)));
    assert.strictEqual(before.getText(), 'one\n');
    assert.strictEqual(after.getText(), 'one\ntwo\n');

    // Blame and the history of one file.
    await panel.handle('fileAction', { action: 'blame', hash: third.hash, path: 'a.txt' });
    const blame = await until(() => {
      const e = vscode.window.activeTextEditor;
      return e?.document.uri.scheme === GIT_SCHEME && /Fixture/.test(e.document.getText()) && e;
    });
    assert.strictEqual(blame.document.lineCount, 3);
    const history = (await api()).openLog(f.dir, 'a.txt');
    const shown = await history.whenRendered();
    assert.strictEqual(shown.commits, 2);
    assert.deepStrictEqual(shown.lanes, []);
    // A filtered list has no graph, and the toolbar says why instead of leaving an empty column.
    assert.strictEqual(shown.graph, 'Graph off: file history');
    assert.deepStrictEqual(shown.errors, []);
  });

  test('comparing a commit with its parent or the working tree opens its files', async () => {
    const f = track(await linearRepo());
    const hash = await f.commit('Two files', { 'a.txt': 'x\n', 'c.txt': 'c\n' });
    const panel = (await api()).openLog(f.dir);
    await panel.handle('commitAction', { action: 'comparePrevious', hash });
    await until(() => activeTab()?.label.includes('↔ previous'));
    f.write('a.txt', 'working\n');
    await panel.handle('commitAction', { action: 'compareWorkingTree', hash });
    const tab = await until(() => activeTab()?.label.includes('↔ working tree') && activeTab());
    assert.ok(tab.input instanceof vscode.TabInputTextDiff, 'one changed file opens in the diff editor');
    assert.strictEqual(tab.input.modified.scheme, 'file');
    await panel.handle('commitAction', { action: 'copyHash', hash });
    assert.strictEqual(await vscode.env.clipboard.readText(), hash);
  });

  test('uncommitted changes appear as the first row and can be staged and unstaged', async () => {
    const f = track(await linearRepo());
    const { store, states, openLog } = await api();
    await store.update((l) => addRepos(l, [f.dir]).list);
    await until(() => states.get(f.dir).status);
    await new Promise((r) => setTimeout(r, 1500)); // let the watchers settle
    const panel = openLog(f.dir);
    assert.strictEqual((await panel.whenRendered()).uncommitted, 0);

    // A change made outside VS Code reaches the open log through the repo watcher.
    const again = panel.whenRendered(true);
    f.write('new file.txt', 'new\n');
    await f.git('add', 'new file.txt');
    let shown = await again;
    while (shown.uncommitted !== 1) shown = await panel.whenRendered(true);
    assert.strictEqual(shown.domRows, 4, 'three commits and the uncommitted row');

    const [change] = await panel.handle('changes', null);
    assert.deepStrictEqual([change.path, change.index, change.worktree], ['new file.txt', 'A', '.']);
    assert.strictEqual(await panel.handle('fileAction', { action: 'unstage', hash: null, path: change.path }), true);
    assert.deepStrictEqual((await getChanges(f.dir)).map((c) => c.worktree), ['?']);
    assert.strictEqual(await panel.handle('fileAction', { action: 'stage', hash: null, path: change.path }), true);
    assert.deepStrictEqual((await getChanges(f.dir)).map((c) => c.index), ['A']);

    await panel.handle('fileAction', { action: 'diff', hash: null, path: change.path });
    const input = await until(() => {
      const i = activeTab()?.input;
      return i instanceof vscode.TabInputTextDiff && i.modified.scheme === 'file' && i;
    });
    assert.strictEqual(input.original.scheme, GIT_SCHEME);
  });

  test('a repository with 50,000 commits opens its first page in under one second', async function () {
    this.timeout(180_000);
    const f = track(await bigRepo(50_000));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const { openLog } = await api();
    const start = Date.now();
    const panel = openLog(f.dir);
    const shown = await panel.whenRendered();
    const elapsed = Date.now() - start;
    console.log(`      first page of 50,000 commits on screen after ${elapsed} ms`);
    assert.deepStrictEqual(shown.errors, []);
    assert.strictEqual(shown.commits, 500);
    // Virtualised: a screenful of rows in the DOM, not 500.
    assert.ok(shown.domRows > 0 && shown.domRows < 120, `${shown.domRows} rows in the DOM`);
    // The done-when line is one second. Shared CI runners start a webview several times slower
    // than a developer machine, so there the limit only guards against a real regression.
    const limit = process.env.CI ? 5000 : 1000;
    assert.ok(elapsed < limit, `took ${elapsed} ms`);

    // Later pages continue the graph; a page deep in the history is just as quick.
    const second = await panel.handle('page', { scope: ['main'], skip: 500 });
    assert.strictEqual(second.commits.length, 500);
    assert.strictEqual(second.rows?.length, 500);
    const deepStart = Date.now();
    const deep = await panel.handle('page', { scope: ['main'], skip: 45_000 });
    assert.strictEqual(deep.commits.length, 500);
    assert.strictEqual(deep.rows, null, 'a page out of order has no graph');
    assert.ok(Date.now() - deepStart < 1000);
    const found = await panel.handle('page', { scope: ['main'], skip: 0, search: 'Merge side 25000' });
    assert.deepStrictEqual(found.commits.map((c) => c.subject), ['Merge side 25000']);
  });
});
