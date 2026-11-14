import * as path from 'node:path';
import * as vscode from 'vscode';
import { setIdentity, type IdentityProfile } from '../../core/git/identity';
import * as ops from '../../core/git/ops';
import { getStatus } from '../../core/git/status';
import {
  addRepos, createGroup, deleteGroup, deleteProfile, moveRepo, profileFor, removeRepo, renameGroup, reposInGroup,
  setGroupProfile, upsertProfile, type Group,
} from '../../core/repos/model';
import { mapLimit } from '../../core/repos/pool';
import { scanForRepos } from '../../core/repos/scan';
import { identityOk } from '../identityWarning';
import { resolveConflicts } from '../merge/commands';
import { BrewingPanel } from '../panels/brewingPanel';
import { LogPanel } from '../panels/logPanel';
import { MergePanel } from '../panels/mergePanel';
import { interactiveRebase } from '../rebase/commands';
import { pullAll } from './bulk';
import type { RepoStates } from './state';
import type { RepoStore } from './store';
import type { GroupNode, Node, RepoNode } from './treeProvider';

export interface Deps {
  store: RepoStore;
  states: RepoStates;
  /** Environment for network commands (askpass). */
  networkEnv: () => Record<string, string>;
  extensionUri: vscode.Uri;
  extensionMode?: vscode.ExtensionMode;
  /** Kinds of project at the repository root ("maven"); see core/project/detect.ts. */
  projectKinds?: (repo: string) => string[];
  /** Environment for terminals opened on the repository (JAVA_HOME, PATH). */
  terminalEnv?: (repo: string) => Record<string, string>;
}

const name = (repo: string) => path.basename(repo);
export { name as repoName };

/** Repo from a tree node, or ask for one when run from the command palette. */
async function repoArg(deps: Deps, node?: Node): Promise<string | undefined> {
  if (node?.kind === 'repo') return node.path;
  const repos = deps.store.list.repos;
  if (!repos.length) {
    void vscode.window.showInformationMessage('No repositories registered yet.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: name(r.path), description: r.path, repo: r.path })),
    { title: 'Repository', matchOnDescription: true },
  );
  return pick?.repo;
}

async function groupArg(deps: Deps, node?: Node, title = 'Group'): Promise<Group | undefined> {
  if (node?.kind === 'group' && node.group.id) return node.group;
  const groups = deps.store.list.groups;
  if (!groups.length) {
    void vscode.window.showInformationMessage('No groups yet. Create one first.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(groups.map((g) => ({ label: g.name, group: g })), { title });
  return pick?.group;
}

export interface ActStream {
  onOutput: (chunk: string) => void;
}

export interface ActOptions {
  command?: string;
  progressTitle?: string;
  forceProgress?: boolean;
}

/** Runs a git action on one repo with a spinner on its row, an optional progress dialog, and an error message on failure. */
export async function act<T>(
  deps: Deps,
  repo: string,
  label: string,
  action: (stream: ActStream) => Promise<T>,
  options?: ActOptions | string,
): Promise<T | undefined> {
  const commandStr = typeof options === 'string' ? options : options?.command;
  const progressTitle = typeof options === 'string' ? label : options?.progressTitle ?? label;
  const forceProgress = typeof options === 'object' && options?.forceProgress;
  const isTest = deps.extensionMode === vscode.ExtensionMode.Test;
  const showProgress = (forceProgress || !isTest) && vscode.workspace.getConfiguration('branchAndBrew').get('showBrewingProgress', true);

  let brewingPanel: BrewingPanel | undefined;
  if (showProgress && commandStr) {
    try {
      brewingPanel = BrewingPanel.open(deps, repo, progressTitle, commandStr);
    } catch {
      // Ignored if webview cannot be opened
    }
  }

  deps.states.setBusy(repo, label);
  try {
    const result = await action({
      onOutput: (chunk) => {
        brewingPanel?.appendOutput(chunk);
      },
    });
    brewingPanel?.finish('success');
    return result;
  } catch (e) {
    const errorMsg = (e as Error).message;
    brewingPanel?.finish('error', 1, errorMsg);
    void vscode.window.showErrorMessage(`${name(repo)}: ${errorMsg}`);
    return undefined;
  } finally {
    deps.states.setBusy(repo, undefined);
    await deps.states.refresh(repo);
    LogPanel.refreshRepo(repo);
  }
}

/** Writes the group's profile as local identity to the given repos. */
async function applyProfile(deps: Deps, repos: string[], profile: IdentityProfile): Promise<void> {
  const failed: string[] = [];
  await mapLimit(repos, 4, async (repo) => {
    try {
      await setIdentity(repo, 'local', profile);
    } catch {
      failed.push(name(repo));
    }
    void deps.states.refresh(repo);
  });
  if (failed.length) void vscode.window.showWarningMessage(`Could not set identity in: ${failed.join(', ')}`);
}

/** Registers repositories and applies their group's identity profile; returns the ones that were new. */
export async function addPaths(deps: Deps, paths: string[], groupId?: string): Promise<string[]> {
  let added: string[] = [];
  const list = await deps.store.update((l) => {
    const r = addRepos(l, paths, groupId);
    added = r.added;
    return r.list;
  });
  const profile = added.length ? profileFor(list, added[0]) : undefined;
  if (profile) await applyProfile(deps, added, profile);
  return added;
}

async function pickGroupForNew(deps: Deps): Promise<string | undefined | null> {
  const groups = deps.store.list.groups;
  if (!groups.length) return undefined;
  const pick = await vscode.window.showQuickPick(
    [{ label: 'Ungrouped', id: undefined as string | undefined }, ...groups.map((g) => ({ label: g.name, id: g.id as string | undefined }))],
    { title: 'Add to group' },
  );
  return pick ? pick.id : null;
}

export function registerRepoCommands(deps: Deps): vscode.Disposable[] {
  const { store, states } = deps;
  const reg = (id: string, fn: (...args: never[]) => unknown) => vscode.commands.registerCommand(`branchAndBrew.${id}`, fn);

  return [
    reg('addRepository', async (arg?: unknown) => {
      const uris = Array.isArray(arg) && arg.length > 0 && arg.every((u) => u instanceof vscode.Uri)
        ? (arg as vscode.Uri[])
        : arg instanceof vscode.Uri
          ? [arg]
          : undefined;
      const picked = uris ?? await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Add repository',
      });
      if (!picked?.length) return [];
      const repos: string[] = [];
      for (const uri of picked) {
        const found = await scanForRepos(uri.fsPath, 0);
        if (found.length) repos.push(...found);
        else void vscode.window.showWarningMessage(`${uri.fsPath} is not a git repository.`);
      }
      const groupId = await pickGroupForNew(deps);
      if (groupId === null) return [];
      return addPaths(deps, repos, groupId);
    }),

    reg('scanFolder', async (arg?: unknown) => {
      const rootUri = arg instanceof vscode.Uri ? arg : undefined;
      const folder = rootUri ?? (await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, openLabel: 'Scan for repositories',
      }))?.[0];
      if (!folder) return [];
      const found = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Scanning for repositories' },
        () => scanForRepos(folder.fsPath, 3),
      );
      if (!found.length) {
        void vscode.window.showInformationMessage('No git repositories found (searched 3 levels deep).');
        return [];
      }
      let groupId: string | undefined;
      const folderName = path.basename(folder.fsPath) || 'Repositories';
      if (!rootUri) {
        const existing = store.list.groups.find((g) => g.name.toLowerCase() === folderName.toLowerCase());
        if (existing) {
          groupId = existing.id;
        } else {
          const created = createGroup(store.list, folderName);
          await store.update(() => created.list);
          groupId = created.group.id;
        }
      }
      const added = await addPaths(deps, found, groupId);
      void vscode.window.showInformationMessage(
        `Found ${found.length} repositories, added ${added.length}${found.length > added.length ? ' (the rest were already registered)' : ''}${groupId ? ` to group "${folderName}"` : ''}.`,
      );
      return added;
    }),

    reg('refresh', () => {
      LogPanel.refreshAll();
      return states.refreshAll(store.list.repos.map((r) => r.path));
    }),

    reg('pullAll', () => pullAll(store.list.repos.map((r) => r.path), states, deps.networkEnv())),

    reg('pullGroup', async (node?: GroupNode) => {
      const group = node?.group ?? await groupArg(deps, node);
      if (!group) return [];
      return pullAll(reposInGroup(store.list, group.id || undefined).map((r) => r.path), states, deps.networkEnv());
    }),

    reg('showLog', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      return repo ? LogPanel.open(deps, repo) : undefined;
    }),

    reg('interactiveRebase', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      return repo ? interactiveRebase(deps, repo) : undefined;
    }),

    reg('resolveConflicts', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      if (repo) await resolveConflicts(deps, repo);
    }),

    reg('abortMerge', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      if (!repo) return;
      const ok = await vscode.window.showWarningMessage(
        `Abort merge in ${name(repo)}? This will discard all merge changes and reset to HEAD.`,
        { modal: true },
        'Abort Merge',
      );
      if (ok !== 'Abort Merge') return;
      await act(deps, repo, 'aborting merge', async () => {
        await ops.abortMerge(repo);
        MergePanel.closeAllForRepo(repo);
        return true;
      });
    }),

    reg('fetch', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      if (repo) {
        await act(
          deps,
          repo,
          'fetching',
          (stream) => ops.fetch(repo, { env: deps.networkEnv(), ...stream }),
          'git fetch --prune --progress',
        );
      }
    }),

    reg('pull', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      if (!repo) return;
      await act(
        deps,
        repo,
        'pulling',
        async (stream) => {
          try {
            await ops.pull(repo, { env: deps.networkEnv(), ...stream });
          } catch (e) {
            const s = await getStatus(repo).catch(() => undefined);
            if (s?.conflicted) throw new Error(`pull stopped with ${s.conflicted} conflicted file(s); resolve them, then continue.`);
            throw e;
          }
        },
        'git pull --progress',
      );
    }),

    reg('push', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      if (!repo) return;
      const s = states.get(repo).status ?? await getStatus(repo);
      if (!s.branch) return void vscode.window.showWarningMessage(`${name(repo)}: HEAD is detached; switch to a branch to push.`);
      let remote = 'origin';
      if (!s.upstream) {
        const remotes = await ops.remotes(repo);
        if (!remotes.length) return void vscode.window.showWarningMessage(`${name(repo)} has no remote.`);
        if (remotes.length > 1) {
          const pick = await vscode.window.showQuickPick(remotes, { title: `Push ${s.branch} to` });
          if (!pick) return;
          remote = pick;
        } else remote = remotes[0];
      }
      await act(
        deps,
        repo,
        'pushing',
        (stream) => ops.push(repo, s.branch!, !!s.upstream, remote, { env: deps.networkEnv(), ...stream }),
        `git push ${remote} ${s.branch} --progress`,
      );
    }),

    reg('merge', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      if (!repo) return;
      if (!await identityOk(deps, repo)) return;
      const status = states.get(repo).status ?? await getStatus(repo);
      if (!status.branch) {
        void vscode.window.showWarningMessage(`${name(repo)}: HEAD is detached; cannot merge.`);
        return;
      }
      const branches = await ops.listBranches(repo);
      const otherBranches = branches.filter((b) => !b.current);
      if (!otherBranches.length) {
        void vscode.window.showInformationMessage(`${name(repo)}: No other branches to merge.`);
        return;
      }
      const pick = await vscode.window.showQuickPick(
        otherBranches.map((b) => ({
          label: b.name,
          description: b.remote ? 'remote' : undefined,
          detail: `Merge '${b.name}' into '${status.branch}'`,
        })),
        {
          title: `Merge into '${status.branch}'`,
          placeHolder: `Select branch to merge into '${status.branch}'`,
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );
      if (!pick) return;
      const ok = await vscode.window.showWarningMessage(
        `Merge branch "${pick.label}" into "${status.branch}"?`,
        { modal: true },
        'Merge',
      );
      if (!ok) return;
      await act(
        deps,
        repo,
        `merging ${pick.label}`,
        async (stream) => {
          try {
            const out = await ops.merge(repo, pick.label, stream);
            if (out.includes('Already up to date')) {
              void vscode.window.showInformationMessage(`${name(repo)}: Already up to date.`);
            } else {
              void vscode.window.showInformationMessage(`${name(repo)}: Merged '${pick.label}' into '${status.branch}'.`);
            }
          } catch (e) {
            const s = await getStatus(repo).catch(() => undefined);
            if (s?.conflicted) {
              const resolve = 'Resolve Conflicts';
              void vscode.window.showWarningMessage(
                `Merge into ${status.branch} resulted in ${s.conflicted} conflict(s).`,
                resolve,
              ).then((action) => {
                if (action === resolve) void resolveConflicts(deps, repo);
              });
              return;
            }
            throw e;
          }
        },
        `git merge ${pick.label}`,
      );
    }),

    reg('switchBranch', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      if (!repo) return;
      const branches = await ops.listBranches(repo);
      const localNames = new Set(branches.filter((b) => !b.remote).map((b) => b.name));
      const items = branches
        // A remote branch that already has a local branch of the same name adds nothing.
        .filter((b) => !b.remote || !localNames.has(b.name.slice(b.name.indexOf('/') + 1)))
        .map((b) => ({
          label: `${b.current ? '$(check) ' : ''}${b.name}`,
          description: b.remote ? 'remote' : undefined,
          branch: b,
        }));
      const pick = await vscode.window.showQuickPick(items, { title: `Switch branch in ${name(repo)}`, matchOnDescription: true });
      if (pick && !pick.branch.current) {
        await act(
          deps,
          repo,
          `switching to ${pick.branch.name}`,
          (stream) => ops.switchBranch(repo, pick.branch, stream),
          `git switch ${pick.branch.name}`,
        );
      }
    }),

    reg('newBranch', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      if (!repo) return;
      const branchName = await vscode.window.showInputBox({
        title: `New branch in ${name(repo)}`,
        prompt: 'Created from the current commit and checked out',
        validateInput: async (v) => (!v.trim() ? undefined : (await ops.isValidBranchName(repo, v.trim())) ? undefined : 'Not a valid branch name'),
      });
      if (branchName?.trim()) await act(deps, repo, 'creating branch', () => ops.createBranch(repo, branchName.trim()));
    }),

    reg('stash', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      if (!repo) return;
      const message = await vscode.window.showInputBox({ title: `Stash changes in ${name(repo)}`, prompt: 'Message (optional)' });
      if (message !== undefined) await act(deps, repo, 'stashing', () => ops.stash(repo, message.trim() || undefined));
    }),

    reg('stashPop', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      if (!repo) return;
      if (!(await ops.stashCount(repo))) return void vscode.window.showInformationMessage(`${name(repo)} has no stash.`);
      await act(deps, repo, 'popping stash', () => ops.stashPop(repo));
    }),

    reg('openHere', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      if (repo) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repo), { forceNewWindow: false });
    }),

    reg('openNewWindow', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      if (repo) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repo), { forceNewWindow: true });
    }),

    reg('openTerminal', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      if (repo) vscode.window.createTerminal({ name: name(repo), cwd: repo, env: deps.terminalEnv?.(repo) }).show();
    }),

    reg('gitIdentity', async (node?: RepoNode) => {
      const repo = await repoArg(deps, node);
      if (!repo) return;
      const state = await states.refresh(repo);
      const id = state.identity ?? {};
      const current = id.name || id.email ? `${id.name ?? '(no name)'} <${id.email ?? 'no email'}>` : 'not set';
      const profiles = store.list.profiles;
      const pick = await vscode.window.showQuickPick([
        { label: '$(edit) Set for this repository…', action: 'local' as const },
        { label: '$(globe) Set globally…', action: 'global' as const },
        ...profiles.map((p) => ({ label: `$(account) Use profile ${p.label}`, description: `${p.name} <${p.email}>`, action: 'profile' as const, profile: p })),
      ], { title: `Git identity for ${name(repo)}: ${current}${id.emailScope ? ` (${id.emailScope})` : ''}` });
      if (!pick) return;
      if (pick.action === 'profile' && 'profile' in pick) {
        await act(deps, repo, 'setting identity', () => setIdentity(repo, 'local', pick.profile));
        return;
      }
      const entered = await askIdentity(id.name, id.email);
      if (!entered) return;
      await act(deps, repo, 'setting identity', () => setIdentity(repo, pick.action as 'local' | 'global', entered));
      if (pick.action === 'global') void states.refreshAll(store.list.repos.map((r) => r.path));
    }),

    reg('manageProfiles', async () => {
      const profiles = store.list.profiles;
      const pick = await vscode.window.showQuickPick([
        { label: '$(add) New profile…', profile: undefined as IdentityProfile | undefined, remove: false },
        ...profiles.map((p) => ({ label: `$(edit) ${p.label}`, description: `${p.name} <${p.email}>`, profile: p, remove: false })),
        ...profiles.map((p) => ({ label: `$(trash) Delete ${p.label}`, profile: p, remove: true })),
      ], { title: 'Identity profiles' });
      if (!pick) return;
      if (pick.remove && pick.profile) {
        const ok = await vscode.window.showWarningMessage(
          `Delete profile "${pick.profile.label}"? Groups using it lose it; repo config stays as is.`, { modal: true }, 'Delete');
        if (ok) await store.update((l) => deleteProfile(l, pick.profile!.id));
        return;
      }
      const label = await vscode.window.showInputBox({ title: 'Profile name', value: pick.profile?.label, prompt: 'For example Work or Personal' });
      if (!label?.trim()) return;
      const entered = await askIdentity(pick.profile?.name, pick.profile?.email);
      if (!entered) return;
      const list = await store.update((l) => upsertProfile(l, { id: pick.profile?.id, label: label.trim(), ...entered }));
      if (pick.profile) {
        // Re-apply an edited profile to the groups that use it.
        const profile = list.profiles.find((p) => p.id === pick.profile!.id)!;
        const repos = list.groups.filter((g) => g.profileId === profile.id).flatMap((g) => reposInGroup(list, g.id).map((r) => r.path));
        if (repos.length) await applyProfile(deps, repos, profile);
      }
    }),

    reg('setGroupProfile', async (node?: GroupNode) => {
      const group = await groupArg(deps, node, 'Set identity profile for group');
      if (!group) return;
      const profiles = store.list.profiles;
      if (!profiles.length) {
        void vscode.window.showInformationMessage('No identity profiles yet.', 'Create one').then((c) => {
          if (c) void vscode.commands.executeCommand('branchAndBrew.manageProfiles');
        });
        return;
      }
      const pick = await vscode.window.showQuickPick([
        ...profiles.map((p) => ({ label: p.label, description: `${p.name} <${p.email}>`, id: p.id as string | undefined })),
        { label: 'No profile', description: 'Leave repo identities as they are', id: undefined as string | undefined },
      ], { title: `Identity profile for ${group.name}` });
      if (!pick) return;
      const list = await store.update((l) => setGroupProfile(l, group.id, pick.id));
      const profile = list.profiles.find((p) => p.id === pick.id);
      if (profile) await applyProfile(deps, reposInGroup(list, group.id).map((r) => r.path), profile);
    }),

    reg('createGroup', async () => {
      const groupName = await vscode.window.showInputBox({ title: 'New group', prompt: 'Group name' });
      if (groupName?.trim()) await store.update((l) => createGroup(l, groupName).list);
    }),

    reg('renameGroup', async (node?: GroupNode) => {
      const group = await groupArg(deps, node, 'Rename group');
      if (!group) return;
      const groupName = await vscode.window.showInputBox({ title: 'Rename group', value: group.name });
      if (groupName?.trim()) await store.update((l) => renameGroup(l, group.id, groupName));
    }),

    reg('deleteGroup', async (node?: GroupNode) => {
      const group = await groupArg(deps, node, 'Delete group');
      if (!group) return;
      const inGroup = reposInGroup(store.list, group.id);
      if (!inGroup.length) {
        await store.update((l) => deleteGroup(l, group.id));
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Delete group "${group.name}" (${inGroup.length} ${inGroup.length === 1 ? 'repository' : 'repositories'})?`,
        { modal: true },
        'Delete Group & Repositories',
        'Delete Group Only (Keep Repositories)',
      );
      if (choice === 'Delete Group & Repositories') {
        await store.update((l) => deleteGroup(l, group.id, true));
      } else if (choice === 'Delete Group Only (Keep Repositories)') {
        await store.update((l) => deleteGroup(l, group.id, false));
      }
    }),

    reg('moveToGroup', async (node?: RepoNode, selected?: Node[]) => {
      const repos = selected?.some((n) => n.kind === 'repo') ? selected.filter((n) => n.kind === 'repo').map((n) => n.path) : [await repoArg(deps, node)].filter((r): r is string => !!r);
      if (!repos.length) return;
      const groups = store.list.groups;
      const pick = await vscode.window.showQuickPick([
        ...groups.map((g) => ({ label: g.name, id: g.id as string | undefined, create: false })),
        { label: '$(add) New group…', id: undefined as string | undefined, create: true },
        { label: 'Ungrouped', id: undefined as string | undefined, create: false },
      ], { title: `Move ${repos.length === 1 ? name(repos[0]) : `${repos.length} repositories`} to` });
      if (!pick) return;
      let groupId = pick.id;
      if (pick.create) {
        const groupName = await vscode.window.showInputBox({ title: 'New group', prompt: 'Group name' });
        if (!groupName?.trim()) return;
        await store.update((l) => {
          const r = createGroup(l, groupName);
          groupId = r.group.id;
          return r.list;
        });
      }
      const list = await store.update((l) => repos.reduce((acc, r) => moveRepo(acc, r, groupId), l));
      const profile = profileFor(list, repos[0]);
      if (profile) await applyProfile(deps, repos, profile);
    }),

    reg('removeRepository', async (node?: RepoNode, selected?: Node[]) => {
      const repos = selected?.some((n) => n.kind === 'repo') ? selected.filter((n) => n.kind === 'repo').map((n) => n.path) : [await repoArg(deps, node)].filter((r): r is string => !!r);
      if (!repos.length) return;
      const what = repos.length === 1 ? `"${name(repos[0])}"` : `${repos.length} repositories`;
      const ok = await vscode.window.showWarningMessage(
        `Remove ${what} from the list? Nothing is deleted on disk.`, { modal: true }, 'Remove');
      if (!ok) return;
      await store.update((l) => repos.reduce((acc, r) => removeRepo(acc, r), l));
      repos.forEach((r) => states.forget(r));
    }),
  ];
}

async function askIdentity(name?: string, email?: string): Promise<{ name: string; email: string } | undefined> {
  const n = await vscode.window.showInputBox({ title: 'user.name', value: name, validateInput: (v) => (v.trim() ? undefined : 'Required') });
  if (!n?.trim()) return undefined;
  const e = await vscode.window.showInputBox({
    title: 'user.email', value: email, validateInput: (v) => (/^\S+@\S+$/.test(v.trim()) ? undefined : 'Enter an email address'),
  });
  if (!e?.trim()) return undefined;
  return { name: n.trim(), email: e.trim() };
}

