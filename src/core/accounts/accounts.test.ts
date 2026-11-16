import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { linearRepo, type Fixture } from '../../../test/fixtures/repos';
import { removeTempDir } from '../../../test/fixtures/cleanup';
import { filterRepos, folderClashes, groupByProject, projectOf, shortNameOf } from './browse';
import { cloneRepo, cloneTarget, lastMessage, parseCloneProgress } from './clone';
import {
  getAzureProfile, getGitHubUser, listAzureOrganizations, listAzureRepos, listGitHubRepos, parseGitHubExpiry, type HttpGet,
} from './hosts';
import {
  accountForHost, expiryNotice, folderNameOf, hostOfUrl, parseCredentialPrompt, removeAccount, upsertAccount, type Account,
} from './model';

const account = (kind: Account['kind'], host: string, id = `${kind}-${host}`): Account => ({ id, kind, host, label: id, username: 'nick' });

describe('accounts', () => {
  it('keeps one account per kind and host', () => {
    let list = upsertAccount([], account('github', 'github.com', 'a'));
    list = upsertAccount(list, account('github', 'GitHub.com', 'b'));
    list = upsertAccount(list, account('generic', 'git.example.com', 'c'));
    expect(list.map((a) => a.id)).toEqual(['b', 'c']);
    expect(removeAccount(list, 'b').map((a) => a.id)).toEqual(['c']);
  });

  it('finds the account for a host, a generic one first', () => {
    const list = [account('github', 'github.com'), account('azure', 'dev.azure.com'), account('generic', 'git.example.com:8443'), account('generic', 'github.com', 'pat')];
    expect(accountForHost(list, 'GITHUB.com')?.id).toBe('pat');
    expect(accountForHost(list, 'dev.azure.com')?.kind).toBe('azure');
    expect(accountForHost(list, 'contoso.visualstudio.com')?.kind).toBe('azure');
    expect(accountForHost(list, 'git.example.com:8443')?.kind).toBe('generic');
    expect(accountForHost(list, 'git.example.com')).toBeUndefined();
    expect(accountForHost(list, 'evil-github.com')).toBeUndefined();
  });

  it('reads git credential prompts and nothing else', () => {
    expect(parseCredentialPrompt("Username for 'https://github.com': ")).toEqual({ field: 'username', host: 'github.com', user: undefined });
    expect(parseCredentialPrompt("Password for 'https://nick%40work@dev.azure.com': ")).toEqual({ field: 'password', host: 'dev.azure.com', user: 'nick@work' });
    expect(parseCredentialPrompt("Password for 'http://127.0.0.1:8080': ")).toEqual({ field: 'password', host: '127.0.0.1:8080', user: undefined });
    expect(parseCredentialPrompt("Enter passphrase for key '/home/n/.ssh/id_ed25519': ")).toBeUndefined();
    expect(parseCredentialPrompt("Password for 'ftp://example.com': ")).toBeUndefined();
    expect(parseCredentialPrompt('Are you sure you want to continue connecting (yes/no)?')).toBeUndefined();
  });

  it('takes host and folder name from clone URLs', () => {
    expect(hostOfUrl('https://github.com/nick/repo.git')).toBe('github.com');
    expect(hostOfUrl('https://org@dev.azure.com/org/Project/_git/My%20Repo')).toBe('dev.azure.com');
    expect(hostOfUrl('git@github.com:nick/repo.git')).toBe('github.com');
    expect(hostOfUrl('http://127.0.0.1:8080/x.git')).toBe('127.0.0.1:8080');
    expect(hostOfUrl('/tmp/local/repo')).toBeUndefined();
    expect(folderNameOf('https://github.com/nick/repo.git')).toBe('repo');
    expect(folderNameOf('https://org@dev.azure.com/org/Project/_git/My%20Repo/')).toBe('My Repo');
    expect(folderNameOf('git@github.com:nick/tool.git')).toBe('tool');
    expect(folderNameOf('https://example.com/')).toBe('example.com');
  });

  it('warns about a token only when it is close to expiry', () => {
    const now = new Date('2026-11-13T00:00:00Z');
    expect(expiryNotice(undefined, now)).toBeUndefined();
    expect(expiryNotice('2027-06-01T00:00:00Z', now)).toBeUndefined();
    expect(expiryNotice('2026-11-20T00:00:00Z', now)).toBe('token expires in 7 days');
    expect(expiryNotice('2026-11-13T12:00:00Z', now)).toBe('token expires in 1 day');
    expect(expiryNotice('2026-11-01T00:00:00Z', now)).toBe('token expired');
    expect(expiryNotice('not a date', now)).toBeUndefined();
  });
});

describe('GitHub REST', () => {
  it('reads the user and the token expiry header', async () => {
    const calls: [string, Record<string, string>][] = [];
    const get: HttpGet = async (url, headers) => {
      calls.push([url, headers]);
      return { text: '{"login":"nick"}', headers: { 'github-authentication-token-expiration': '2026-12-01 10:00:00 UTC' } };
    };
    expect(await getGitHubUser(get, 't0ken')).toEqual({ login: 'nick', tokenExpiresAt: '2026-12-01T10:00:00.000Z' });
    expect(calls[0][0]).toBe('https://api.github.com/user');
    expect(calls[0][1]).toMatchObject({ Authorization: 'Bearer t0ken', Accept: 'application/vnd.github+json' });
    expect(parseGitHubExpiry('2026-12-01 10:00:00 +0200')).toBe('2026-12-01T08:00:00.000Z');
    expect(parseGitHubExpiry('soon')).toBeUndefined();
    expect(parseGitHubExpiry(undefined)).toBeUndefined();
    await expect(getGitHubUser(async () => ({ text: '{}', headers: {} }), 't')).rejects.toThrow(/no login/);
  });

  it('lists repositories page by page', async () => {
    const page = (n: number, count: number) => Array.from({ length: count }, (_, i) => ({
      full_name: `nick/repo-${n}-${i}`, clone_url: `https://github.com/nick/repo-${n}-${i}.git`, private: i % 2 === 0, description: null, pushed_at: '2026-11-01T00:00:00Z',
    }));
    const urls: string[] = [];
    const get: HttpGet = async (url) => {
      urls.push(url);
      const n = Number(new URL(url).searchParams.get('page'));
      return { text: JSON.stringify(n === 1 ? page(1, 100) : [...page(2, 3), { broken: true }]), headers: {} };
    };
    const repos = await listGitHubRepos(get, 't', 'https://ghe.example.com/api/v3');
    expect(repos).toHaveLength(103);
    expect(repos[0]).toEqual({ name: 'nick/repo-1-0', cloneUrl: 'https://github.com/nick/repo-1-0.git', private: true, description: undefined, updatedAt: '2026-11-01T00:00:00Z' });
    expect(urls).toEqual([
      'https://ghe.example.com/api/v3/user/repos?per_page=100&page=1&sort=pushed',
      'https://ghe.example.com/api/v3/user/repos?per_page=100&page=2&sort=pushed',
    ]);
    await expect(listGitHubRepos(async () => ({ text: '{"message":"Bad credentials"}', headers: {} }), 't')).rejects.toThrow(/not a list/);
  });
});

describe('Azure DevOps REST', () => {
  it('reads the profile, the organizations and an organization\'s repositories', async () => {
    const get: HttpGet = async (url, headers) => {
      expect(headers.Authorization).toBe('Bearer entra');
      if (url === 'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1') return { text: '{"id":"abc-1","displayName":"Nick","emailAddress":"n@example.invalid"}', headers: {} };
      if (url === 'https://app.vssps.visualstudio.com/_apis/accounts?memberId=abc-1&api-version=7.1') return { text: '{"count":2,"value":[{"accountName":"zeta"},{"accountName":"contoso"}]}', headers: {} };
      if (url === 'https://dev.azure.com/contoso/_apis/git/repositories?api-version=7.1') {
        return { text: JSON.stringify({ value: [
          { name: 'web', remoteUrl: 'https://contoso@dev.azure.com/contoso/Shop/_git/web', project: { name: 'Shop' } },
          { name: 'old', remoteUrl: 'https://contoso@dev.azure.com/contoso/Shop/_git/old', project: { name: 'Shop' }, isDisabled: true },
          { name: 'api', remoteUrl: 'https://contoso@dev.azure.com/contoso/Core/_git/api', project: { name: 'Core' } },
        ] }), headers: {} };
      }
      throw new Error(`unexpected ${url}`);
    };
    const profile = await getAzureProfile(get, 'entra');
    expect(profile).toEqual({ id: 'abc-1', displayName: 'Nick', emailAddress: 'n@example.invalid' });
    expect(await listAzureOrganizations(get, 'entra', profile.id)).toEqual(['contoso', 'zeta']);
    expect(await listAzureRepos(get, 'entra', 'contoso')).toEqual([
      { name: 'Core/api', cloneUrl: 'https://contoso@dev.azure.com/contoso/Core/_git/api', private: true },
      { name: 'Shop/web', cloneUrl: 'https://contoso@dev.azure.com/contoso/Shop/_git/web', private: true },
    ]);
    await expect(listAzureRepos(async () => ({ text: '{}', headers: {} }), 't', 'x')).rejects.toThrow(/no repository list/);
  });
});

describe('cloneRepo', () => {
  const fixtures: Fixture[] = [];
  const tmp = mkdtempSync(path.join(tmpdir(), 'bab clone é-'));
  afterAll(() => {
    fixtures.forEach((f) => f.dispose());
    removeTempDir(tmp);
  });

  it('clones into a folder named after the repository and refuses a folder in the way', async () => {
    const source = await linearRepo();
    fixtures.push(source);
    const target = await cloneRepo(source.dir, tmp);
    expect(target).toBe(path.join(tmp, path.basename(source.dir)));
    expect(cloneTarget('https://example.com/a/empty.git', tmp)).toBe(path.join(tmp, 'empty'));
    mkdirSync(path.join(tmp, 'taken'));
    writeFileSync(path.join(tmp, 'taken', 'file'), 'x');
    await expect(cloneRepo('https://example.invalid/a/taken.git', tmp)).rejects.toThrow(/already exists/);
    await expect(cloneRepo(source.dir, tmp)).rejects.toThrow(/already exists/);
  });
});

describe('clone progress', () => {
  it('reads the newest progress line, with carriage returns', () => {
    expect(parseCloneProgress('Receiving objects:  10% (1/10)\rReceiving objects:  50% (5/10)\r')).toEqual({ phase: 'Receiving objects', percent: 40 });
    expect(parseCloneProgress('remote: Counting objects: 100% (5/5), done.\n')).toEqual({ phase: 'Counting objects', percent: 0 });
    expect(parseCloneProgress('Resolving deltas: 100% (3/3), done.\n')).toEqual({ phase: 'Resolving deltas', percent: 95 });
    expect(parseCloneProgress('Updating files: 50% (1/2)\r\n')).toEqual({ phase: 'Updating files', percent: 98 });
  });

  it('ignores text that is not progress, and handles CRLF', () => {
    expect(parseCloneProgress("Cloning into 'x'...\r\n")).toBeUndefined();
    expect(parseCloneProgress('Receiving objects:  4')).toBeUndefined();
    expect(lastMessage("Cloning into 'x'...\r\nReceiving objects: 10% (1/10)\r\nfatal: repository not found\r\n")).toBe('fatal: repository not found');
  });

  it('removes the folder of a clone that failed, but not one that was there', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'bab clone é-'));
    try {
      // Sources that exist but are not repositories, so git refuses them the same way everywhere.
      mkdirSync(path.join(parent, 'src', 'no such repo'), { recursive: true });
      await expect(cloneRepo(path.join(parent, 'src', 'no such repo'), parent)).rejects.toThrow();
      expect(existsSync(path.join(parent, 'no such repo'))).toBe(false);
      mkdirSync(path.join(parent, 'src', 'empty'));
      mkdirSync(path.join(parent, 'empty'));
      await expect(cloneRepo(path.join(parent, 'src', 'empty'), parent)).rejects.toThrow();
      expect(existsSync(path.join(parent, 'empty'))).toBe(true);
    } finally {
      removeTempDir(parent);
    }
  });
});

describe('browse list', () => {
  const repos = [
    { name: 'Access Applause/Applause v2' }, { name: 'Access Applause/AccessApplause' },
    { name: 'Access Architecture Team/Sample.Feature.Flags' }, { name: 'Zeta/api' },
  ];

  it('splits a name into project and repository', () => {
    expect(projectOf(repos[0])).toBe('Access Applause');
    expect(shortNameOf(repos[0])).toBe('Applause v2');
    expect(projectOf({ name: 'lonely' })).toBe('');
    expect(shortNameOf({ name: 'lonely' })).toBe('lonely');
  });

  it('filters on every word in any order and case', () => {
    expect(filterRepos(repos, '').length).toBe(4);
    expect(filterRepos(repos, 'applause V2').map((r) => r.name)).toEqual(['Access Applause/Applause v2']);
    expect(filterRepos(repos, 'team/sample').length).toBe(1);
    expect(filterRepos(repos, 'nothing')).toEqual([]);
  });

  it('groups by project in name order', () => {
    expect(groupByProject(repos).map((g) => [g.project, g.repos.map(shortNameOf)])).toEqual([
      ['Access Applause', ['AccessApplause', 'Applause v2']],
      ['Access Architecture Team', ['Sample.Feature.Flags']],
      ['Zeta', ['api']],
    ]);
  });

  it('finds folder names that clash', () => {
    const a = 'https://dev.azure.com/o/P1/_git/api';
    const b = 'https://dev.azure.com/o/P2/_git/API';
    const c = 'https://dev.azure.com/o/P2/_git/web';
    expect([...folderClashes([a, b, c])]).toEqual([[b, a]]);
  });
});
