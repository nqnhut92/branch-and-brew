/**
 * Hosting accounts: who the user is on a git host. Tokens are never part of this model; they
 * stay in VS Code's authentication sessions or secret storage.
 */
export type AccountKind = 'github' | 'azure' | 'generic';

export interface Account {
  id: string;
  kind: AccountKind;
  /** Shown in the Accounts view: the login or display name. */
  label: string;
  /** Host git talks to, with the port when it has one: "github.com", "dev.azure.com", "git.example.com:8443". */
  host: string;
  /** User name given to git. */
  username: string;
  /** When the token stops working (ISO date), where that is known. */
  expiresAt?: string;
}

export const GITHUB_HOST = 'github.com';
export const AZURE_HOST = 'dev.azure.com';

/** Adds an account, replacing one of the same kind on the same host. */
export function upsertAccount(accounts: readonly Account[], account: Account): Account[] {
  return [...accounts.filter((a) => !(a.kind === account.kind && sameHost(a.host, account.host))), account];
}

export const removeAccount = (accounts: readonly Account[], id: string): Account[] => accounts.filter((a) => a.id !== id);

const sameHost = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** True when `host` is served by the account. Azure DevOps also answers on `<org>.visualstudio.com`. */
export function servesHost(account: Account, host: string): boolean {
  const h = host.toLowerCase();
  if (sameHost(account.host, h)) return true;
  return account.kind === 'azure' && (h === 'ssh.dev.azure.com' || h.endsWith('.visualstudio.com'));
}

/** The account for a host: one added for exactly that host wins over a built-in kind. */
export function accountForHost(accounts: readonly Account[], host: string): Account | undefined {
  const matches = accounts.filter((a) => servesHost(a, host));
  return matches.find((a) => a.kind === 'generic') ?? matches[0];
}

export interface CredentialPrompt {
  field: 'username' | 'password';
  host: string;
  /** User name in the URL git is asking about, when there is one. */
  user?: string;
}

/**
 * Reads git's credential prompts: "Username for 'https://host': " and
 * "Password for 'https://user@host': ". Anything else (an ssh passphrase, say) is not ours.
 */
export function parseCredentialPrompt(prompt: string): CredentialPrompt | undefined {
  const m = prompt.match(/^(Username|Password) for '([a-z][a-z0-9+.-]*):\/\/(?:([^@'/]*)@)?([^'/]+)\/?.*'/i);
  if (!m || !/^https?$/i.test(m[2])) return undefined;
  let user: string | undefined;
  try {
    user = m[3] ? decodeURIComponent(m[3]) : undefined;
  } catch {
    user = m[3];
  }
  return { field: m[1].toLowerCase() as 'username' | 'password', host: m[4], user };
}

/** Host (with port) of a clone URL, for https and ssh forms; undefined for local paths. */
export function hostOfUrl(url: string): string | undefined {
  const scp = url.match(/^[^@/\s]+@([^:/\s]+):/);
  if (scp) return scp[1];
  try {
    const u = new URL(url);
    return u.protocol === 'file:' ? undefined : u.host || undefined;
  } catch {
    return undefined;
  }
}

/** Folder a clone lands in: the last path segment without `.git`. */
export function folderNameOf(url: string): string {
  const last = url.replace(/[/\\]+$/, '').split(/[/\\:]/).pop() ?? '';
  let name = last.replace(/\.git$/i, '');
  try {
    name = decodeURIComponent(name);
  } catch {
    // Keep the raw segment.
  }
  return name.replace(/[<>:"|?*]/g, '_') || 'repository';
}

const DAY = 24 * 60 * 60 * 1000;

/** What to say about a token's expiry: nothing while it is more than `warnDays` away. */
export function expiryNotice(expiresAt: string | undefined, now: Date = new Date(), warnDays = 14): string | undefined {
  if (!expiresAt) return undefined;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return undefined;
  const days = Math.ceil((at - now.getTime()) / DAY);
  if (days <= 0) return 'token expired';
  return days <= warnDays ? `token expires in ${days} ${days === 1 ? 'day' : 'days'}` : undefined;
}

/** A repository on a host, as the browse list shows it. */
export interface RemoteRepo {
  /** "owner/name" on GitHub, "project/name" on Azure DevOps. */
  name: string;
  cloneUrl: string;
  description?: string;
  private?: boolean;
  /** Last push or update, ISO date. */
  updatedAt?: string;
}
