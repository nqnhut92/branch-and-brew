import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  AZURE_API, AZURE_PROFILE_API, AZURE_SCOPE, GITHUB_API, getAzureProfile, getGitHubUser, listAzureOrganizations, listAzureRepos,
  listGitHubRepos, type HttpGet,
} from '../../core/accounts/hosts';
import {
  AZURE_HOST, GITHUB_HOST, accountForHost, parseCredentialPrompt, removeAccount, upsertAccount, type Account, type RemoteRepo,
} from '../../core/accounts/model';
import { fetchWithHeaders, resolveProxy } from '../../core/java/download';

const ACCOUNTS_KEY = 'branchAndBrew.accounts';
const secretKey = (id: string) => `branchAndBrew.account.${id}`;

/** Scopes asked of VS Code's built-in providers. `repo` lets GitHub list and clone private repositories. */
const SCOPES = { github: ['repo', 'read:user'], microsoft: [AZURE_SCOPE] } as const;

/** The part of `vscode.authentication` used here; the integration tests replace it. */
export interface AuthBackend {
  getSession(providerId: string, scopes: readonly string[], options: vscode.AuthenticationGetSessionOptions): Thenable<vscode.AuthenticationSession | undefined>;
}

export interface AccountsOverrides {
  auth?: AuthBackend;
  githubApi?: string;
  azureProfileApi?: string;
  azureApi?: string;
  allowHttpLocalhost?: boolean;
}

/**
 * Hosting accounts. GitHub and Azure DevOps sign in through VS Code's own authentication
 * providers, which keep the tokens; another HTTPS host gets a token kept in VS Code's secret
 * storage. The list itself (no secrets) is in globalState.
 */
export class Accounts implements vscode.Disposable {
  overrides: AccountsOverrides = {};
  /** How many of git's credential prompts were answered from an account (tests). */
  answered = 0;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private cache: Account[] | undefined;

  constructor(private readonly context: Pick<vscode.ExtensionContext, 'globalState' | 'secrets'>) {}

  list(): Account[] {
    if (this.cache !== undefined) return [...this.cache];
    const stored = this.context.globalState.get<Account[]>(ACCOUNTS_KEY);
    this.cache = Array.isArray(stored) ? stored.filter((a) => a && typeof a.id === 'string' && typeof a.host === 'string') : [];
    return [...this.cache];
  }

  private async save(accounts: Account[]): Promise<void> {
    this.cache = [...accounts];
    await this.context.globalState.update(ACCOUNTS_KEY, accounts);
    this.changed.fire();
  }

  private get auth(): AuthBackend {
    return this.overrides.auth ?? vscode.authentication;
  }

  private readonly get: HttpGet = (url, headers) => {
    const http = vscode.workspace.getConfiguration('http');
    const noProxy = [...(http.get<string[]>('noProxy') ?? []), process.env.NO_PROXY ?? process.env.no_proxy ?? ''].filter(Boolean).join(',');
    return fetchWithHeaders(url, { headers, proxy: resolveProxy(http.get<string>('proxy')), noProxy, allowHttpLocalhost: this.overrides.allowHttpLocalhost });
  };

  /**
   * The account's token. Without `interactive` nothing is ever shown: a session that needs the
   * user to sign in again reads as no token.
   */
  async token(account: Account, interactive = false): Promise<string | undefined> {
    if (account.kind === 'generic') return this.context.secrets.get(secretKey(account.id));
    const provider = account.kind === 'github' ? 'github' : 'microsoft';
    const session = await this.auth.getSession(provider, SCOPES[provider], interactive ? { createIfNone: true } : { silent: true });
    return session?.accessToken;
  }

  /** Signs in to GitHub through VS Code and records who that is. */
  async addGitHub(): Promise<Account> {
    const session = await this.auth.getSession('github', SCOPES.github, { createIfNone: true });
    if (!session) throw new Error('GitHub sign-in was cancelled.');
    const user = await getGitHubUser(this.get, session.accessToken, this.overrides.githubApi ?? GITHUB_API);
    const account: Account = { id: randomUUID(), kind: 'github', label: user.login, host: GITHUB_HOST, username: user.login, expiresAt: user.tokenExpiresAt };
    await this.save(upsertAccount(this.list(), account));
    return account;
  }

  /** Signs in to Azure DevOps with a Microsoft account through VS Code. */
  async addAzure(): Promise<Account> {
    const session = await this.auth.getSession('microsoft', SCOPES.microsoft, { createIfNone: true });
    if (!session) throw new Error('Microsoft sign-in was cancelled.');
    const profile = await getAzureProfile(this.get, session.accessToken, this.overrides.azureProfileApi ?? AZURE_PROFILE_API);
    // Git wants a user name that is not empty; Azure DevOps ignores which one.
    const account: Account = { id: randomUUID(), kind: 'azure', label: profile.emailAddress ?? profile.displayName, host: AZURE_HOST, username: profile.emailAddress ?? 'azure' };
    await this.save(upsertAccount(this.list(), account));
    return account;
  }

  /** Another HTTPS host: the token goes to secret storage, the rest to the list. */
  async addGeneric(input: { host: string; username: string; token: string; expiresAt?: string }): Promise<Account> {
    const host = input.host.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!host || !input.username.trim() || !input.token) throw new Error('Host, user name and token are all needed.');
    const account: Account = { id: randomUUID(), kind: 'generic', label: input.username.trim(), host, username: input.username.trim(), expiresAt: input.expiresAt };
    if (host.toLowerCase() === GITHUB_HOST && !account.expiresAt) {
      // GitHub says when a personal access token expires; a failure here must not block adding it.
      account.expiresAt = await getGitHubUser(this.get, input.token, this.overrides.githubApi ?? GITHUB_API).then((u) => u.tokenExpiresAt, () => undefined);
    }
    const before = this.list();
    await this.context.secrets.store(secretKey(account.id), input.token);
    await this.save(upsertAccount(before, account));
    // The account it replaced, if any, leaves its secret behind otherwise.
    for (const old of before) if (old.kind === 'generic' && old.host.toLowerCase() === host.toLowerCase()) await this.context.secrets.delete(secretKey(old.id));
    return account;
  }

  /** Forgets the account here. A GitHub or Microsoft sign-in stays in VS Code's Accounts menu. */
  async remove(id: string): Promise<void> {
    await this.context.secrets.delete(secretKey(id));
    await this.save(removeAccount(this.list(), id));
  }

  /** Removes all accounts and cleans up their secrets. */
  async clear(): Promise<void> {
    for (const a of this.list()) await this.context.secrets.delete(secretKey(a.id));
    await this.save([]);
  }

  /** Azure DevOps organizations of the account. */
  async organizations(account: Account): Promise<string[]> {
    const token = await this.token(account, true);
    if (!token) throw new Error('Not signed in.');
    const base = this.overrides.azureProfileApi ?? AZURE_PROFILE_API;
    return listAzureOrganizations(this.get, token, (await getAzureProfile(this.get, token, base)).id, base);
  }

  /** Repositories the account can see; Azure DevOps needs the organization. */
  async repos(account: Account, organization?: string): Promise<RemoteRepo[]> {
    const token = await this.token(account, true);
    if (!token) throw new Error('Not signed in.');
    if (account.kind === 'github' || (account.kind === 'generic' && account.host.toLowerCase() === GITHUB_HOST)) {
      return listGitHubRepos(this.get, token, this.overrides.githubApi ?? GITHUB_API);
    }
    if (account.kind === 'azure' && organization) return listAzureRepos(this.get, token, organization, this.overrides.azureApi ?? AZURE_API);
    throw new Error(`${account.host} has no repository list this extension can read; clone by URL instead.`);
  }

  /**
   * Answers one of git's credential prompts from the account for that host, without showing
   * anything. Undefined when no account fits; the prompt then goes to the user.
   */
  async answer(prompt: string): Promise<string | undefined> {
    const asked = parseCredentialPrompt(prompt);
    const account = asked && accountForHost(this.list(), asked.host);
    if (!asked || !account) return undefined;
    let answer: string | undefined;
    try {
      answer = asked.field === 'username' ? account.username : await this.token(account);
    } catch {
      answer = undefined;
    }
    if (answer) this.answered++;
    return answer || undefined;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
