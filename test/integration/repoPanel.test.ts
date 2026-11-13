import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { PullOutcome } from '../../src/core/repos/describe';
import { emptyList } from '../../src/core/repos/model';
import type { TestApi } from '../../src/host/extension';
import type { Node } from '../../src/host/repos/treeProvider';
import { createRepo, type Fixture } from '../fixtures/repos';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { removeTempDir } from '../fixtures/cleanup';

async function api(): Promise<TestApi> {
  const ext = vscode.extensions.getExtension<TestApi>('nqnhut92.branch-and-brew')!;
  return ext.activate();
}

async function until<T>(get: () => T | undefined, timeoutMs: number): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

suite('Repository panel', () => {
  const fixtures: Fixture[] = [];
  let root: string;

  suiteSetup(async () => {
    const { store } = await api();
    await store.update(() => emptyList());
    root = mkdtempSync(path.join(tmpdir(), 'bab panel é-'));
  });
  suiteTeardown(async function () {
    this.timeout(60_000);
    const { store } = await api();
    await store.update(() => emptyList());
    // Let the extension drop its file watchers on these repos before deleting them (Windows locks).
    await new Promise((r) => setTimeout(r, 1000));
    fixtures.forEach((f) => f.dispose());
    removeTempDir(root);
  });

  test('scanning one folder registers 10 repositories and the tree lists them', async () => {
    const { store, states, tree } = await api();
    // Ten repos spread over three levels, plus noise that must be skipped.
    for (let i = 0; i < 10; i++) {
      const f = await createRepo(`r${i}`);
      fixtures.push(f);
      await f.commit('Init', { 'a.txt': `${i}\n` });
      const level = path.join(root, ...['team', 'sub'].slice(0, i % 3));
      mkdirSync(level, { recursive: true });
      const clone = path.join(level, `repo ${i}`);
      await f.git('clone', '-q', f.dir, clone);
      await f.git('-C', clone, 'config', 'user.name', 'Fixture');
      await f.git('-C', clone, 'config', 'user.email', 'fixture@example.invalid');
    }
    mkdirSync(path.join(root, 'node_modules', 'x', '.git'), { recursive: true });

    const added = await vscode.commands.executeCommand<string[]>('branchAndBrew.scanFolder', vscode.Uri.file(root));
    assert.strictEqual(added.length, 10);
    assert.strictEqual(store.list.repos.length, 10);
    const rows = tree.getChildren() as Node[];
    assert.strictEqual(rows.length, 10);
    for (const r of store.list.repos) {
      const s = await until(() => states.get(r.path).status, 10_000);
      assert.strictEqual(s.branch, 'main');
      assert.strictEqual(s.upstream, 'origin/main');
    }
  });

  test('status updates within a second of a commit made outside VS Code', async () => {
    const { store, states } = await api();
    const repo = store.list.repos[0].path;
    await until(() => states.get(repo).status, 10_000);
    await new Promise((r) => setTimeout(r, 1500)); // let watchers settle
    const before = states.get(repo).status!.oid;
    const start = Date.now();
    await fixtures[0].git('-C', repo, 'commit', '--allow-empty', '-m', 'Outside');
    const s = await until(() => {
      const st = states.get(repo).status;
      return st && st.oid !== before ? st : undefined;
    }, 5_000);
    const elapsed = Date.now() - start;
    assert.strictEqual(s.ahead, 1);
    console.log(`      status refreshed ${elapsed} ms after the commit`);
    assert.ok(elapsed < 1000, `took ${elapsed} ms`);
  });

  test('Pull all reports the conflicted repository', async () => {
    const { store, states } = await api();
    const conflicted = store.list.repos[1].path;
    // Clone "repo i" was cloned from fixtures[i]; both change the same line.
    const origin = fixtures[Number(path.basename(conflicted).replace('repo ', ''))];
    await origin.commit('Theirs', { 'a.txt': 'theirs\n' });
    const inClone = (...args: string[]) => origin.git('-C', conflicted, ...args);
    await inClone('config', 'pull.rebase', 'false');
    writeFileSync(path.join(conflicted, 'a.txt'), 'mine\n');
    await inClone('commit', '-am', 'Mine');

    const outcomes = await vscode.commands.executeCommand<PullOutcome[]>('branchAndBrew.pullAll');
    assert.strictEqual(outcomes.length, 10);
    const byRepo = new Map(outcomes.map((o) => [o.repo, o.result]));
    assert.strictEqual(byRepo.get(conflicted), 'conflict');
    assert.strictEqual(outcomes.filter((o) => o.result === 'ok').length, 9, JSON.stringify(outcomes));
    const s = await until(() => {
      const st = states.get(conflicted).status;
      return st?.operation === 'merge' ? st : undefined;
    }, 5_000);
    assert.strictEqual(s.conflicted, 1);
  });
});
