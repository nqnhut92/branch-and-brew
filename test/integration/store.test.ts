import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { addRepos, pathKey } from '../../src/core/repos/model';
import type { TestApi } from '../../src/host/extension';

async function api(): Promise<TestApi> {
  return vscode.extensions.getExtension<TestApi>('nqnhut92.branch-and-brew')!.activate();
}

suite('Repository list in globalState', () => {
  const paths = Array.from({ length: 40 }, (_, i) => path.join('/virtual bab é', `repo ${i}`));

  suiteTeardown(async () => {
    const { store, accounts } = await api();
    await accounts.clear();
    await store.update((l) => ({ ...l, repos: l.repos.filter((r) => !paths.some((p) => pathKey(p) === pathKey(r.path))) }));
  });

  // VS Code keeps all of an extension's globalState keys in one object and gives it back the
  // value it stored earlier, so a write to another key can undo this one (seen on Linux CI).
  test('writes next to writes of other keys are not undone', async () => {
    const { store, accounts } = await api();
    for (let i = 0; i < paths.length; i++) {
      // The account list lives under another globalState key of the same extension.
      void accounts.addGeneric({ host: `noise-${i}.invalid`, username: 'nick', token: 'tok' });
      await store.update((l) => addRepos(l, [paths[i]]).list);
    }
    await new Promise((r) => setTimeout(r, 1_500));
    const have = new Set(store.list.repos.map((r) => pathKey(r.path)));
    const missing = paths.filter((p) => !have.has(pathKey(p)));
    assert.deepStrictEqual(missing, [], 'every registered repository is still in the list');
  });
});
