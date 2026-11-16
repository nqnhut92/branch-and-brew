import type { RemoteRepo } from './model';
import { folderNameOf } from './model';

/** "Project" part of "Project/name" (the owner on GitHub); the whole name when it has no slash. */
export function projectOf(repo: Pick<RemoteRepo, 'name'>): string {
  const i = repo.name.indexOf('/');
  return i < 0 ? '' : repo.name.slice(0, i);
}

/** Repository part of "Project/name". */
export function shortNameOf(repo: Pick<RemoteRepo, 'name'>): string {
  const i = repo.name.indexOf('/');
  return i < 0 ? repo.name : repo.name.slice(i + 1);
}

/**
 * Repositories whose "Project/name" contains every word of `query` (any case, any order), so a
 * word with a slash such as "team/sample" matches across the project and the repository.
 */
export function filterRepos<T extends Pick<RemoteRepo, 'name'>>(repos: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...repos];
  return repos.filter((r) => {
    const name = r.name.toLowerCase();
    return words.every((w) => name.includes(w));
  });
}

export interface ProjectGroup<T> {
  project: string;
  repos: T[];
}

/** Repositories grouped by project, projects and their repositories in name order. */
export function groupByProject<T extends Pick<RemoteRepo, 'name'>>(repos: readonly T[]): ProjectGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const r of repos) {
    const key = projectOf(r);
    const list = map.get(key);
    if (list) list.push(r);
    else map.set(key, [r]);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  return [...map.entries()]
    .sort(([a], [b]) => byName(a, b))
    .map(([project, list]) => ({ project, repos: list.sort((a, b) => byName(shortNameOf(a), shortNameOf(b))) }));
}

/**
 * Folder names that appear more than once among `urls`: they would clone into the same folder,
 * so only the first of each can go. Returns, for each later duplicate, the url it clashes with.
 */
export function folderClashes(urls: readonly string[]): Map<string, string> {
  const seen = new Map<string, string>();
  const clashes = new Map<string, string>();
  for (const url of urls) {
    const key = folderNameOf(url).toLowerCase();
    const first = seen.get(key);
    if (first === undefined) seen.set(key, url);
    else clashes.set(url, first);
  }
  return clashes;
}
