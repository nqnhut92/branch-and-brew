import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getStatus } from '../../src/core/git/status';
import { listConflicts } from '../../src/core/merge/stages';
import type { TestApi } from '../../src/host/extension';
import type { MergePanel } from '../../src/host/panels/mergePanel';
import { FIVE_CONFLICTS_FILE, fiveConflictRepo, type Fixture } from '../fixtures/repos';

async function api(): Promise<TestApi> {
  return vscode.extensions.getExtension<TestApi>('nqnhut92.branch-and-brew')!.activate();
}

const closed = (panel: MergePanel) => new Promise<void>((resolve) => panel.onDidClose(resolve));

const closedWithUnresolved = (panel: MergePanel) => new Promise<void>((resolve) => panel.onDidCloseWithUnresolved(resolve));

/** Lines 1..30 of the fixture file with the given replacements, CRLF throughout. */
function expected(changes: Record<number, string>): string {
  return Array.from({ length: 30 }, (_, i) => changes[i + 1] ?? `line ${i + 1}`).join('\r\n') + '\r\n';
}

suite('Three-pane merge', () => {
  const fixtures: Fixture[] = [];

  suiteSetup(async () => {
    // A run that was killed halfway can leave the setting changed in the test profile.
    await vscode.workspace.getConfiguration('branchAndBrew')
      .update('merge.applyNonConflictingChanges', undefined, vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await new Promise((r) => setTimeout(r, 500));
    fixtures.forEach((f) => f.dispose());
  });

  test('the editors follow a VS Code theme switch', async function () {
    this.timeout(60_000);
    const f = await fiveConflictRepo();
    fixtures.push(f);
    const { resolveFile } = await api();
    const panel = (await resolveFile(f.dir, FIVE_CONFLICTS_FILE))!;
    const config = vscode.workspace.getConfiguration('workbench');
    const original = config.inspect<string>('colorTheme')?.globalValue;
    const within = <T>(p: Promise<T>, what: string) =>
      Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Monaco did not follow the switch to ${what}`)), 20_000))]);
    try {
      // Built-in themes that exist in every supported VS Code version.
      await config.update('colorTheme', 'Default Dark+', vscode.ConfigurationTarget.Global);
      await within(panel.whenState((s) => s.theme === 'vs-dark'), 'dark');
      await config.update('colorTheme', 'Default Light+', vscode.ConfigurationTarget.Global);
      await within(panel.whenState((s) => s.theme === 'vs'), 'light');
      await config.update('colorTheme', 'Default High Contrast', vscode.ConfigurationTarget.Global);
      await within(panel.whenState((s) => s.theme === 'hc-black'), 'high contrast');
    } finally {
      await config.update('colorTheme', original, vscode.ConfigurationTarget.Global);
    }
  });

  test('five conflict chunks, CRLF and a both-added file resolve end to end', async () => {
    const f = await fiveConflictRepo();
    fixtures.push(f);
    const { resolveFile, takeWhole } = await api();
    const panel = (await resolveFile(f.dir, FIVE_CONFLICTS_FILE))!;
    const opened = await panel.whenState();
    assert.deepStrictEqual(opened.errors, []);
    assert.strictEqual(opened.editors, 3);
    assert.strictEqual(opened.conflicts, 5);
    assert.strictEqual(opened.unresolved, 5);
    assert.strictEqual(opened.pendingAutomatic, 0, 'non-conflicting changes are applied on open');

    // Mine; theirs; mine then theirs; theirs then mine; mine with theirs ignored.
    const press = (action: 'accept' | 'ignore', side: 'mine' | 'theirs', conflict: number) => panel.perform({ action, side, conflict });
    press('accept', 'mine', 0);
    press('accept', 'theirs', 1);
    press('accept', 'mine', 2);
    press('accept', 'theirs', 2);
    press('accept', 'theirs', 3);
    press('accept', 'mine', 3);
    await panel.whenState((s) => s.unresolved === 1);
    press('ignore', 'theirs', 4);
    press('accept', 'mine', 4);
    const resolved = await panel.whenState((s) => s.unresolved === 0);
    assert.deepStrictEqual(resolved.errors, []);

    const done = closed(panel);
    panel.perform({ action: 'save' });
    await done;
    assert.strictEqual(readFileSync(path.join(f.dir, FIVE_CONFLICTS_FILE), 'utf8'), expected({
      3: 'mine 3', 6: 'mine only 6', 9: 'theirs 9', 12: 'theirs only 12', 15: 'mine 15\r\ntheirs 15',
      18: 'both 18', 21: 'theirs 21\r\nmine 21', 27: 'mine 27',
    }));

    // The file added on both sides has no common ancestor: a whole side is taken.
    const [both] = await listConflicts(f.dir);
    assert.strictEqual(both.path, 'both.txt');
    assert.strictEqual(await resolveFile(f.dir, 'missing.txt'), undefined);
    assert.strictEqual(await takeWhole(f.dir, both, 'theirs'), true);
    assert.strictEqual(readFileSync(path.join(f.dir, 'both.txt'), 'utf8'), 'theirs\n');

    assert.deepStrictEqual(await listConflicts(f.dir), []);
    assert.strictEqual((await getStatus(f.dir)).conflicted, 0);
    assert.ok(!/^(U.|.U|AA|DD) /m.test(await f.git('status', '--porcelain')), 'git status shows no conflict');
    await f.git('commit', '--no-edit');
    assert.strictEqual((await getStatus(f.dir)).operation, undefined, 'the merge is concluded');
  });

  test('with the setting off the result starts as base and Apply Non-Conflicting fills it in', async () => {
    const f = await fiveConflictRepo();
    fixtures.push(f);
    const config = vscode.workspace.getConfiguration('branchAndBrew');
    await config.update('merge.applyNonConflictingChanges', false, vscode.ConfigurationTarget.Global);
    try {
      const panel = (await (await api()).resolveFile(f.dir, FIVE_CONFLICTS_FILE))!;
      const opened = await panel.whenState();
      assert.strictEqual(opened.pendingAutomatic, 3);
      assert.strictEqual(opened.unresolved, 5);
      panel.perform({ action: 'applyNonConflicting' });
      await panel.whenState((s) => s.pendingAutomatic === 0);
      for (let i = 0; i < 5; i++) panel.perform({ action: 'accept', side: 'theirs', conflict: i });
      await panel.whenState((s) => s.unresolved === 0);
      const done = closed(panel);
      panel.perform({ action: 'save' });
      await done;
      assert.strictEqual(readFileSync(path.join(f.dir, FIVE_CONFLICTS_FILE), 'utf8'), expected({
        3: 'theirs 3', 6: 'mine only 6', 9: 'theirs 9', 12: 'theirs only 12', 15: 'theirs 15', 18: 'both 18', 21: 'theirs 21', 27: 'theirs 27',
      }));
    } finally {
      await config.update('merge.applyNonConflictingChanges', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('closing a clean panel does not ask about unsaved conflicts', async () => {
    const f = await fiveConflictRepo();
    fixtures.push(f);
    const panel = (await (await api()).resolveFile(f.dir, FIVE_CONFLICTS_FILE))!;
    await panel.whenState();
    // Resolve everything, then close before saving.
    for (let i = 0; i < 5; i++) panel.perform({ action: 'accept', side: 'theirs', conflict: i });
    await panel.whenState((s) => s.unresolved === 0);
    // Both listeners have to be in place before the close: the events fire while it happens.
    let askedAboutUnresolved = false;
    panel.onDidCloseWithUnresolved(() => { askedAboutUnresolved = true; });
    const closedOk = closed(panel);
    panel.dispose();
    await closedOk;
    assert.strictEqual(askedAboutUnresolved, false, 'clean close should not fire the unresolved-close event');
  });

  test('closing a panel with unresolved conflicts fires the unresolved-close event', async () => {
    const f = await fiveConflictRepo();
    fixtures.push(f);
    const panel = (await (await api()).resolveFile(f.dir, FIVE_CONFLICTS_FILE))!;
    await panel.whenState();
    // Leave one conflict unresolved, then close the panel.
    panel.perform({ action: 'accept', side: 'theirs', conflict: 0 });
    await panel.whenState((s) => s.unresolved === 4);
    // Both listeners have to be in place before the close: the events fire while it happens.
    const withUnresolved = closedWithUnresolved(panel);
    const closedOk = closed(panel);
    panel.dispose();
    await withUnresolved;
    // The plain close event still fires for every close.
    await closedOk;
  });
});
