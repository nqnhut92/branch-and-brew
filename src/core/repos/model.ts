import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { IdentityProfile } from '../git/identity';

/** The registered repositories, their groups and the identity profiles. Plain JSON, stored as is. */
export interface RepoList {
  version: 1;
  groups: Group[];
  repos: RepoEntry[];
  profiles: IdentityProfile[];
}

export interface Group {
  id: string;
  name: string;
  /** Identity profile written as local config to every repo in the group. */
  profileId?: string;
}

export interface RepoEntry {
  path: string;
  groupId?: string;
}

export const emptyList = (): RepoList => ({ version: 1, groups: [], repos: [], profiles: [] });

/** Normalised key for comparing paths: resolved, case-folded where the file system usually is. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const r = path.resolve(p);
  return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r;
}

const sameRepo = (a: string, b: string) => pathKey(a) === pathKey(b);

/** Adds repositories that are not registered yet; returns the new list and the paths actually added. */
export function addRepos(list: RepoList, paths: string[], groupId?: string): { list: RepoList; added: string[] } {
  const added: string[] = [];
  const repos = [...list.repos];
  for (const p of paths) {
    if (repos.some((r) => sameRepo(r.path, p))) continue;
    repos.push({ path: path.resolve(p), groupId });
    added.push(path.resolve(p));
  }
  return { list: { ...list, repos }, added };
}

export function removeRepo(list: RepoList, repoPath: string): RepoList {
  return { ...list, repos: list.repos.filter((r) => !sameRepo(r.path, repoPath)) };
}

export function moveRepo(list: RepoList, repoPath: string, groupId: string | undefined): RepoList {
  return { ...list, repos: list.repos.map((r) => (sameRepo(r.path, repoPath) ? { ...r, groupId } : r)) };
}

export function createGroup(list: RepoList, name: string): { list: RepoList; group: Group } {
  const group: Group = { id: randomUUID(), name: name.trim() };
  return { list: { ...list, groups: [...list.groups, group] }, group };
}

export function renameGroup(list: RepoList, groupId: string, name: string): RepoList {
  return { ...list, groups: list.groups.map((g) => (g.id === groupId ? { ...g, name: name.trim() } : g)) };
}

/** Deletes the group; its repositories stay registered, ungrouped. */
export function deleteGroup(list: RepoList, groupId: string): RepoList {
  return {
    ...list,
    groups: list.groups.filter((g) => g.id !== groupId),
    repos: list.repos.map((r) => (r.groupId === groupId ? { path: r.path } : r)),
  };
}

export function setGroupProfile(list: RepoList, groupId: string, profileId: string | undefined): RepoList {
  return { ...list, groups: list.groups.map((g) => (g.id === groupId ? { ...g, profileId } : g)) };
}

export function upsertProfile(list: RepoList, profile: Omit<IdentityProfile, 'id'> & { id?: string }): RepoList {
  const full: IdentityProfile = { ...profile, id: profile.id ?? randomUUID() };
  const exists = list.profiles.some((p) => p.id === full.id);
  return { ...list, profiles: exists ? list.profiles.map((p) => (p.id === full.id ? full : p)) : [...list.profiles, full] };
}

/** Deletes a profile and unassigns it from every group. */
export function deleteProfile(list: RepoList, profileId: string): RepoList {
  return {
    ...list,
    profiles: list.profiles.filter((p) => p.id !== profileId),
    groups: list.groups.map((g) => (g.profileId === profileId ? { id: g.id, name: g.name } : g)),
  };
}

/** The profile that applies to a repository through its group, if any. */
export function profileFor(list: RepoList, repoPath: string): IdentityProfile | undefined {
  const repo = list.repos.find((r) => sameRepo(r.path, repoPath));
  const group = list.groups.find((g) => g.id === repo?.groupId);
  return list.profiles.find((p) => p.id === group?.profileId);
}

export function reposInGroup(list: RepoList, groupId: string | undefined): RepoEntry[] {
  return list.repos.filter((r) => r.groupId === groupId);
}

/** Accepts whatever was stored; anything unreadable becomes an empty list rather than an error. */
export function parseList(value: unknown): RepoList {
  const v = value as Partial<RepoList> | undefined;
  if (!v || v.version !== 1 || !Array.isArray(v.repos)) return emptyList();
  const groups = Array.isArray(v.groups) ? v.groups : [];
  const ids = new Set(groups.map((g) => g.id));
  return {
    version: 1,
    groups,
    repos: v.repos.filter((r) => typeof r?.path === 'string')
      .map((r) => (r.groupId && !ids.has(r.groupId) ? { path: r.path } : r)),
    profiles: Array.isArray(v.profiles) ? v.profiles : [],
  };
}
