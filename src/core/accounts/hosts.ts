import type { RemoteRepo } from './model';

/** GET returning the body and the response headers (lower-case names). */
export type HttpGet = (url: string, headers: Record<string, string>) => Promise<{ text: string; headers: Record<string, string | string[] | undefined> }>;

// ---- GitHub REST API (docs.github.com/en/rest) ---------------------------------------------------

export const GITHUB_API = 'https://api.github.com';
const GITHUB_HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const githubAuth = (token: string) => ({ ...GITHUB_HEADERS, Authorization: `Bearer ${token}` });

export interface GitHubUser {
  login: string;
  /** From the `github-authentication-token-expiration` response header, sent for tokens that expire. */
  tokenExpiresAt?: string;
}

/** "2026-12-01 10:00:00 UTC" (or with a numeric offset) as an ISO date; undefined when unreadable. */
export function parseGitHubExpiry(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  const m = text?.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/);
  if (!m) return undefined;
  const zone = m[3] === 'UTC' ? 'Z' : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
  const at = Date.parse(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

/** `GET /user`: who the token belongs to. */
export async function getGitHubUser(get: HttpGet, token: string, api = GITHUB_API): Promise<GitHubUser> {
  const res = await get(`${api}/user`, githubAuth(token));
  const login = (JSON.parse(res.text) as { login?: unknown }).login;
  if (typeof login !== 'string' || !login) throw new Error('unexpected answer from GitHub (no login)');
  return { login, tokenExpiresAt: parseGitHubExpiry(res.headers['github-authentication-token-expiration']) };
}

interface GitHubRepo { full_name?: string; clone_url?: string; description?: string | null; private?: boolean; pushed_at?: string | null }

/** `GET /user/repos`, 100 per page, most recently pushed first, until a page comes back short. */
export async function listGitHubRepos(get: HttpGet, token: string, api = GITHUB_API, maxPages = 20): Promise<RemoteRepo[]> {
  const repos: RemoteRepo[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await get(`${api}/user/repos?per_page=100&page=${page}&sort=pushed`, githubAuth(token));
    const items = JSON.parse(res.text) as GitHubRepo[];
    if (!Array.isArray(items)) throw new Error('unexpected answer from GitHub (not a list)');
    for (const r of items) {
      if (typeof r.full_name !== 'string' || typeof r.clone_url !== 'string') continue;
      repos.push({ name: r.full_name, cloneUrl: r.clone_url, description: r.description ?? undefined, private: r.private, updatedAt: r.pushed_at ?? undefined });
    }
    if (items.length < 100) break;
  }
  return repos;
}

// ---- Azure DevOps REST API (learn.microsoft.com/rest/api/azure/devops) ---------------------------

export const AZURE_PROFILE_API = 'https://app.vssps.visualstudio.com';
export const AZURE_API = 'https://dev.azure.com';
/** The Azure DevOps resource; `/.default` asks for the permissions the user has there. */
export const AZURE_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';
const azureAuth = (token: string) => ({ Accept: 'application/json', Authorization: `Bearer ${token}` });

export interface AzureProfile {
  id: string;
  displayName: string;
  emailAddress?: string;
}

/** `GET _apis/profile/profiles/me`. */
export async function getAzureProfile(get: HttpGet, token: string, base = AZURE_PROFILE_API): Promise<AzureProfile> {
  const res = await get(`${base}/_apis/profile/profiles/me?api-version=7.1`, azureAuth(token));
  const p = JSON.parse(res.text) as Partial<AzureProfile>;
  if (typeof p.id !== 'string' || !p.id) throw new Error('unexpected answer from Azure DevOps (no profile id)');
  return { id: p.id, displayName: p.displayName || p.emailAddress || p.id, emailAddress: p.emailAddress };
}

/** `GET _apis/accounts?memberId=`: the organizations the user belongs to. */
export async function listAzureOrganizations(get: HttpGet, token: string, memberId: string, base = AZURE_PROFILE_API): Promise<string[]> {
  const res = await get(`${base}/_apis/accounts?memberId=${encodeURIComponent(memberId)}&api-version=7.1`, azureAuth(token));
  const value = (JSON.parse(res.text) as { value?: { accountName?: string }[] }).value;
  if (!Array.isArray(value)) throw new Error('unexpected answer from Azure DevOps (no organization list)');
  return value.map((a) => a.accountName).filter((n): n is string => typeof n === 'string' && !!n).sort((a, b) => a.localeCompare(b));
}

interface AzureRepo { name?: string; remoteUrl?: string; isDisabled?: boolean; project?: { name?: string } }

/** `GET {organization}/_apis/git/repositories`: every repository of one organization. */
export async function listAzureRepos(get: HttpGet, token: string, organization: string, base = AZURE_API): Promise<RemoteRepo[]> {
  const res = await get(`${base}/${encodeURIComponent(organization)}/_apis/git/repositories?api-version=7.1`, azureAuth(token));
  const value = (JSON.parse(res.text) as { value?: AzureRepo[] }).value;
  if (!Array.isArray(value)) throw new Error('unexpected answer from Azure DevOps (no repository list)');
  return value
    .filter((r) => typeof r.name === 'string' && typeof r.remoteUrl === 'string' && !r.isDisabled)
    .map((r) => ({ name: `${r.project?.name ?? organization}/${r.name}`, cloneUrl: r.remoteUrl!, private: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
