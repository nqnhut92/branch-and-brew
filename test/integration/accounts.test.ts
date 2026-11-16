import * as assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getIdentity } from '../../src/core/git/identity';
import { createGroup, pathKey, setGroupProfile, upsertProfile } from '../../src/core/repos/model';
import type { TestApi } from '../../src/host/extension';
import { removeTempDir } from '../fixtures/cleanup';
import { gitHttpBackend, startGitHttpServer, type GitHttpServer } from '../fixtures/gitHttpServer';
import { linearRepo, type Fixture } from '../fixtures/repos';

async function api(): Promise<TestApi> {
  return vscode.extensions.getExtension<TestApi>('nqnhut92.branch-and-brew')!.activate();
}

/** Waits for a value that a globalState write makes visible; VS Code persists it, so a read can lag. */
async function until<T>(get: () => T | Promise<T> | undefined | false, timeoutMs = 5_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await get();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

suite('Accounts and clone (stub hosts)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bab accounts é-'));
  const fixtures: Fixture[] = [];
  let server: GitHttpServer | undefined;
  let stub: http.Server | undefined;

  suiteSetup(async () => {
    const { accounts, setGitEnv } = await api();
    await accounts.clear(); // left by a run that was killed
    // No stored credentials: the machine's credential helpers (keychain, Credential Manager)
    // are out of the picture, so only the extension can answer git.
    writeFileSync(path.join(root, 'empty-gitconfig'), '');
    setGitEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig') });
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const { accounts, setGitEnv, store } = await api();
    await accounts.clear();
    accounts.overrides = {};
    setGitEnv({});
    await store.update((l) => ({ ...l, repos: l.repos.filter((r) => !pathKey(r.path).startsWith(pathKey(root))) }));
    await server?.close();
    stub?.close();
    fixtures.forEach((f) => f.dispose());
    removeTempDir(root);
  });

  test('a private repository clones with the account\'s token and the next fetch asks for nothing', async function () {
    this.timeout(120_000);
    if (!gitHttpBackend()) {
      console.log('      skipped: this git has no http-backend to play the private host');
      return this.skip();
    }
    const { accounts, cloneInto, store, states } = await api();
    // The private host: a bare repository behind Basic authentication.
    const source = await linearRepo();
    fixtures.push(source);
    const served = path.join(root, 'served');
    mkdirSync(served);
    await source.git('clone', '--bare', '.', path.join(served, 'private repo.git'));
    server = await startGitHttpServer(served, 'nick', 'tok-123');
    const url = `http://${server.host}/private%20repo.git`;

    // Without an account nobody can answer: stop that clone instead of typing into its prompt.
    // (The prompt is a VS Code input box, which a test cannot fill in; this just proves the host is private.)
    const account = await accounts.addGeneric({ host: `http://${server.host}/`, username: 'nick', token: 'tok-123' });
    await until(() => accounts.list().some((a) => a.id === account.id));
    assert.strictEqual(account.host, server.host);
    assert.strictEqual(await accounts.token(account), 'tok-123');
    assert.ok(!JSON.stringify(accounts.list()).includes('tok-123'), 'the token is not in the account list');

    // A group with an identity profile: the clone gets that identity.
    let groupId = '';
    await store.update((l) => {
      const withProfile = upsertProfile(l, { id: 'work-profile', label: 'Work', name: 'Work Nick', email: 'nick@work.invalid' });
      const created = createGroup(withProfile, 'Cloned');
      groupId = created.group.id;
      return setGroupProfile(created.list, groupId, 'work-profile');
    });

    const parent = path.join(root, 'clones');
    mkdirSync(parent);
    const before = accounts.answered;
    const target = await cloneInto(url, parent, groupId);
    assert.strictEqual(target, path.join(parent, 'private repo'));
    assert.strictEqual(readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n');
    assert.ok(server.unauthorized > 0, 'the host asked for credentials');
    assert.ok(server.authorized > 0, 'and got the right ones');
    assert.ok(accounts.answered >= before + 2, 'user name and password both came from the account');
    // The repository list is a globalState write; on a loaded runner the read back lags it.
    const registered = await until(() => store.list.repos.find((r) => pathKey(r.path) === pathKey(target))?.groupId);
    assert.strictEqual(registered, groupId);
    assert.deepStrictEqual(await getIdentity(target).then((i) => [i.name, i.email, i.emailScope]), ['Work Nick', 'nick@work.invalid', 'local']);
    assert.ok(!readFileSync(path.join(target, '.git', 'config'), 'utf8').includes('tok-123'), 'the token is not written into the clone');

    // The next fetch: the account answers again, nothing is asked, the new commit arrives.
    await source.commit('Fourth', { 'new.txt': 'new\n' });
    await source.git('push', path.join(served, 'private repo.git'), 'main');
    const authorized = server.authorized;
    await vscode.commands.executeCommand('branchAndBrew.fetch', { kind: 'repo', path: target });
    assert.ok(server.authorized > authorized, 'the fetch reached the host with credentials');
    const state = await states.refresh(target);
    assert.strictEqual(state.error, undefined);
    assert.strictEqual(state.status?.behind, 1);

    // A wrong token fails the clone with git's error; it neither hangs nor asks.
    const wrong = await accounts.addGeneric({ host: server.host, username: 'nick', token: 'wrong' });
    await until(() => accounts.list().some((a) => a.id === wrong.id && a.host === server!.host));
    await until(async () => (await accounts.token(wrong)) === 'wrong');
    assert.strictEqual(accounts.list().filter((a) => a.host === server!.host).length, 1, 'one account per host');
    mkdirSync(path.join(root, 'denied'));
    await assert.rejects(cloneInto(url, path.join(root, 'denied')), /Authentication failed|403|401/i);
    assert.ok(!existsSync(path.join(root, 'denied', 'private repo', '.git')));
  });

  test('a GitHub sign-in lists the account\'s repositories and answers git for github.com', async () => {
    const { accounts } = await api();
    // The GitHub REST API, as far as it is used.
    const seen: string[] = [];
    stub = http.createServer((req, res) => {
      seen.push(`${req.headers.authorization} ${req.url}`);
      if (req.headers.authorization !== 'Bearer gho_session') return void res.writeHead(401).end('{"message":"Bad credentials"}');
      if (req.url === '/user') return void res.writeHead(200, { 'github-authentication-token-expiration': '2026-11-20 00:00:00 UTC' }).end('{"login":"octo-nick"}');
      if (req.url?.startsWith('/user/repos')) {
        return void res.writeHead(200).end(JSON.stringify([
          { full_name: 'octo-nick/private-tool', clone_url: 'https://github.com/octo-nick/private-tool.git', private: true, pushed_at: '2026-11-10T00:00:00Z' },
          { full_name: 'octo-nick/site', clone_url: 'https://github.com/octo-nick/site.git', private: false, description: 'A site' },
        ]));
      }
      res.writeHead(404).end('{}');
    });
    await new Promise<void>((r) => stub!.listen(0, '127.0.0.1', r));
    const requested: { provider: string; scopes: readonly string[]; options: vscode.AuthenticationGetSessionOptions }[] = [];
    accounts.overrides = {
      githubApi: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`, allowHttpLocalhost: true,
      // Stands in for VS Code's GitHub sign-in, which needs a browser and a real account.
      auth: {
        getSession: async (provider, scopes, options) => {
          requested.push({ provider, scopes, options });
          return { id: 's1', accessToken: 'gho_session', account: { id: '1', label: 'octo-nick' }, scopes };
        },
      },
    };

    const account = await accounts.addGitHub();
    assert.deepStrictEqual([account.kind, account.host, account.label, account.username], ['github', 'github.com', 'octo-nick', 'octo-nick']);
    assert.strictEqual(account.expiresAt, '2026-11-20T00:00:00.000Z');
    assert.deepStrictEqual(requested[0], { provider: 'github', scopes: ['repo', 'read:user'], options: { createIfNone: true } });

    // The list is a globalState write; wait until it reads back before git's prompts are answered from it.
    await until(() => accounts.list().some((a) => a.id === account.id));

    const repos = await accounts.repos(account);
    assert.deepStrictEqual(repos.map((r) => [r.name, r.private]), [['octo-nick/private-tool', true], ['octo-nick/site', false]]);

    // Git's prompts for github.com are answered from the session, silently.
    assert.strictEqual(await until(() => accounts.answer("Username for 'https://github.com': ")), 'octo-nick');
    assert.strictEqual(await until(() => accounts.answer("Password for 'https://octo-nick@github.com': ")), 'gho_session');
    assert.deepStrictEqual(requested[requested.length - 1].options, { silent: true });
    assert.strictEqual(await accounts.answer("Password for 'https://gitlab.com': "), undefined);
    assert.strictEqual(await accounts.answer("Enter passphrase for key '/x/id_ed25519': "), undefined);

    await accounts.remove(account.id);
    assert.strictEqual(await accounts.answer("Password for 'https://octo-nick@github.com': "), undefined);
  });
});

suite('Clone tab', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bab clone tab é-'));
  const fixtures: Fixture[] = [];

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const { store } = await api();
    await store.update((l) => ({ ...l, repos: l.repos.filter((r) => !pathKey(r.path).startsWith(pathKey(root))) }));
    fixtures.forEach((f) => f.dispose());
    removeTempDir(root);
  });

  test('clones several repositories, reports each, registers the good ones and cleans up the failed one', async function () {
    this.timeout(120_000);
    const { openClonePanel, store } = await api();
    const source = await linearRepo();
    fixtures.push(source);
    const served = path.join(root, 'served');
    mkdirSync(path.join(served, 'other'), { recursive: true });
    await source.git('clone', '--bare', '.', path.join(served, 'alpha repo.git'));
    await source.git('clone', '--bare', '.', path.join(served, 'beta.git'));
    await source.git('clone', '--bare', '.', path.join(served, 'other', 'beta.git'));
    const [alpha, beta, clash, missing] = ['alpha repo.git', 'beta.git', 'other/beta.git', 'gone.git'].map((n) => path.join(served, n));
    const parent = path.join(root, 'ü clones');
    mkdirSync(parent);

    const panel = openClonePanel({ id: 'clone-tab', kind: 'generic', host: 'example.invalid', label: 'Clone tab', username: 'nick' });
    const last = new Map<string, string>();
    const percents = new Map<string, number[]>();
    panel.onDidItem((e) => {
      last.set(e.url, e.status);
      percents.set(e.url, [...(percents.get(e.url) ?? []), e.percent ?? 0]);
    });
    await panel.run([alpha, beta, clash, missing], { folder: parent });

    assert.deepStrictEqual([alpha, beta, clash, missing].map((u) => last.get(u)), ['done', 'done', 'error', 'error']);
    // The runner's git may check out CRLF (core.autocrlf), so compare without the line endings.
    assert.strictEqual(readFileSync(path.join(parent, 'alpha repo', 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'one\ntwo\n');
    assert.ok(existsSync(path.join(parent, 'beta', '.git')));
    assert.ok(!existsSync(path.join(parent, 'gone')), 'a failed clone leaves no folder behind');
    assert.ok(percents.get(alpha)!.includes(100));
    const registered = await until(() => {
      const paths = store.list.repos.map((r) => pathKey(r.path));
      return paths.includes(pathKey(path.join(parent, 'alpha repo'))) && paths.includes(pathKey(path.join(parent, 'beta')));
    });
    assert.ok(registered);

    // "In list" follows the list: removing a repository tells the open tab at once.
    const seen: string[][] = [];
    panel.onDidRegisteredChange((names) => seen.push(names));
    await store.update((l) => ({ ...l, repos: l.repos.filter((r) => pathKey(r.path) !== pathKey(path.join(parent, 'beta'))) }));
    await until(() => seen.length > 0);
    assert.ok(seen[0].includes('alpha repo') && !seen[0].includes('beta'), `after the removal: ${seen[0].join(', ')}`);

    // A retry of the failed one into the same folder works once the source exists.
    await source.git('clone', '--bare', '.', missing);
    last.clear();
    await panel.run([missing], { folder: parent });
    assert.strictEqual(last.get(missing), 'done');
    panel.dispose();
  });
});
