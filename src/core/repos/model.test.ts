import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addRepos, createGroup, deleteGroup, deleteProfile, emptyList, moveRepo, parseList, pathKey, profileFor, removeRepo,
  renameGroup, reposInGroup, setGroupProfile, upsertProfile,
} from './model';

const a = path.resolve('/repos/a');
const b = path.resolve('/repos/b');

describe('repo list model', () => {
  it('adds without duplicates and removes', () => {
    let { list, added } = addRepos(emptyList(), [a, b, a]);
    expect(added).toEqual([a, b]);
    ({ list, added } = addRepos(list, [a]));
    expect(added).toEqual([]);
    list = removeRepo(list, a);
    expect(list.repos.map((r) => r.path)).toEqual([b]);
  });

  it('treats paths case-insensitively on Windows and macOS', () => {
    expect(pathKey('/X/Repo', 'win32')).toBe(pathKey('/x/repo', 'win32'));
    expect(pathKey('/X/Repo', 'linux')).not.toBe(pathKey('/x/repo', 'linux'));
  });

  it('groups: create, move, rename, delete keeps repos ungrouped', () => {
    let list = addRepos(emptyList(), [a, b]).list;
    const { list: l2, group } = createGroup(list, ' Work ');
    list = moveRepo(l2, a, group.id);
    expect(reposInGroup(list, group.id).map((r) => r.path)).toEqual([a]);
    expect(reposInGroup(list, undefined).map((r) => r.path)).toEqual([b]);
    list = renameGroup(list, group.id, 'Job');
    expect(list.groups[0].name).toBe('Job');
    list = deleteGroup(list, group.id);
    expect(list.groups).toEqual([]);
    expect(list.repos.every((r) => r.groupId === undefined)).toBe(true);
  });

  it('profiles apply through the group and are unassigned when deleted', () => {
    let list = upsertProfile(emptyList(), { label: 'Work', name: 'Nick', email: 'n@w' });
    const profile = list.profiles[0];
    const created = createGroup(addRepos(list, [a]).list, 'Work');
    list = setGroupProfile(moveRepo(created.list, a, created.group.id), created.group.id, profile.id);
    expect(profileFor(list, a)).toEqual(profile);
    expect(profileFor(list, b)).toBeUndefined();
    list = upsertProfile(list, { ...profile, email: 'new@w' });
    expect(list.profiles).toHaveLength(1);
    expect(profileFor(list, a)?.email).toBe('new@w');
    list = deleteProfile(list, profile.id);
    expect(list.groups[0].profileId).toBeUndefined();
  });

  it('parses stored data defensively', () => {
    expect(parseList(undefined)).toEqual(emptyList());
    expect(parseList({ version: 2 })).toEqual(emptyList());
    expect(parseList({ version: 1, repos: [{ path: a, groupId: 'gone' }, { nope: 1 }], groups: [] }).repos)
      .toEqual([{ path: a }]);
  });
});
