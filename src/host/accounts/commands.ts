import * as path from 'node:path';
import * as vscode from 'vscode';
import { cloneRepo, cloneTarget } from '../../core/accounts/clone';
import { hostOfUrl, type Account, type RemoteRepo } from '../../core/accounts/model';
import { addPaths, type Deps } from '../repos/commands';
import type { Accounts } from './service';

/**
 * Clones into `<parent>/<name>` with a progress notification, registers the repository in the
 * group and applies the group's identity profile. Resolves with the new folder.
 */
export async function cloneInto(deps: Deps, url: string, parent: string, groupId?: string): Promise<string> {
  const target = cloneTarget(url, parent);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Cloning ${path.basename(target)}`, cancellable: true },
    (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      return cloneRepo(url, parent, { env: deps.networkEnv(), signal: abort.signal });
    },
  );
  await addPaths(deps, [target], groupId);
  return target;
}

/** Asks where to clone and into which group, then clones. */
async function cloneWithQuestions(deps: Deps, url: string): Promise<string | undefined> {
  const folder = (await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, openLabel: 'Clone into this folder', title: `Where to clone ${url}`,
  }))?.[0];
  if (!folder) return undefined;
  const groups = deps.store.list.groups;
  let groupId: string | undefined;
  if (groups.length) {
    const pick = await vscode.window.showQuickPick(
      [{ label: 'Ungrouped', id: undefined as string | undefined }, ...groups.map((g) => ({
        label: g.name, id: g.id as string | undefined,
        description: deps.store.list.profiles.find((p) => p.id === g.profileId)?.label,
      }))],
      { title: 'Add to group', placeHolder: 'The group\'s identity profile is applied to the clone' });
    if (!pick) return undefined;
    groupId = pick.id;
  }
  const target = await cloneInto(deps, url, folder.fsPath, groupId);
  void vscode.window.showInformationMessage(`Cloned into ${target}.`);
  return target;
}

const describeRepo = (r: RemoteRepo) => [r.private ? 'private' : '', r.updatedAt ? `pushed ${r.updatedAt.slice(0, 10)}` : ''].filter(Boolean).join(' · ');

export function registerAccountCommands(deps: Deps, accounts: Accounts): vscode.Disposable[] {
  const reg = (id: string, fn: (...args: never[]) => unknown) => vscode.commands.registerCommand(`branchAndBrew.${id}`, fn);
  const guard = <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) => (...args: A) =>
    fn(...args).catch((e: Error) => void vscode.window.showErrorMessage(e.message));

  const accountArg = async (node?: Account): Promise<Account | undefined> => {
    if (node?.id) return node;
    const list = accounts.list();
    if (!list.length) return void vscode.window.showInformationMessage('No accounts yet. Add one first.');
    return (await vscode.window.showQuickPick(list.map((a) => ({ label: a.label, description: a.host, account: a })), { title: 'Account' }))?.account;
  };

  return [
    reg('addAccount', guard(async () => {
      const pick = await vscode.window.showQuickPick([
        { label: '$(github) GitHub', detail: 'Sign in through VS Code', what: 'github' as const },
        { label: '$(azure-devops) Azure DevOps', detail: 'Sign in with a Microsoft account through VS Code', what: 'azure' as const },
        { label: '$(key) Other HTTPS host…', detail: 'A host name, a user name and a token; the token is kept in VS Code\'s secret storage', what: 'generic' as const },
      ], { title: 'Add account' });
      if (!pick) return undefined;
      if (pick.what === 'github') return accounts.addGitHub();
      if (pick.what === 'azure') return accounts.addAzure();
      const host = await vscode.window.showInputBox({ title: 'Add account (1/4): host', placeHolder: 'git.example.com', validateInput: (v) => (v.trim() ? undefined : 'Required') });
      if (!host) return undefined;
      const username = await vscode.window.showInputBox({ title: 'Add account (2/4): user name', validateInput: (v) => (v.trim() ? undefined : 'Required') });
      if (!username) return undefined;
      const token = await vscode.window.showInputBox({ title: 'Add account (3/4): token', password: true, ignoreFocusOut: true, validateInput: (v) => (v ? undefined : 'Required') });
      if (!token) return undefined;
      const expires = await vscode.window.showInputBox({
        title: 'Add account (4/4): token expiry', placeHolder: 'YYYY-MM-DD, or leave empty',
        prompt: 'Shown as a warning in the Accounts view two weeks before that day',
        validateInput: (v) => (!v.trim() || !Number.isNaN(Date.parse(v.trim())) ? undefined : 'Not a date'),
      });
      if (expires === undefined) return undefined;
      return accounts.addGeneric({ host, username, token, expiresAt: expires.trim() ? new Date(expires.trim()).toISOString() : undefined });
    })),

    reg('browseAccount', guard(async (node?: Account) => {
      const account = await accountArg(node);
      if (!account) return undefined;
      let organization: string | undefined;
      if (account.kind === 'azure') {
        const organizations = await accounts.organizations(account);
        if (!organizations.length) return void vscode.window.showInformationMessage(`${account.label} belongs to no Azure DevOps organization.`);
        organization = organizations.length === 1 ? organizations[0] : await vscode.window.showQuickPick(organizations, { title: 'Azure DevOps organization' });
        if (!organization) return undefined;
      }
      const repos = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Loading repositories of ${organization ?? account.label}` },
        () => accounts.repos(account, organization));
      const pick = await vscode.window.showQuickPick(
        repos.map((r) => ({ label: r.name, description: describeRepo(r), detail: r.description, repo: r })),
        { title: `Clone from ${organization ?? account.label} (${repos.length} repositories)`, placeHolder: 'Type to filter', matchOnDescription: true, matchOnDetail: true });
      return pick ? cloneWithQuestions(deps, pick.repo.cloneUrl) : undefined;
    })),

    reg('cloneUrl', guard(async () => {
      const url = await vscode.window.showInputBox({
        title: 'Clone repository', placeHolder: 'https://host/path/repo.git',
        prompt: 'An account for the same host answers when git asks for credentials',
        validateInput: (v) => (!v.trim() || hostOfUrl(v.trim()) ? undefined : 'Enter an https or ssh URL'),
      });
      return url?.trim() ? cloneWithQuestions(deps, url.trim()) : undefined;
    })),

    reg('removeAccount', guard(async (node?: Account) => {
      const account = await accountArg(node);
      if (!account) return;
      const detail = account.kind === 'generic'
        ? 'Its token is deleted from VS Code\'s secret storage.'
        : 'The sign-in itself stays in VS Code; sign out from the Accounts menu in the activity bar.';
      const ok = await vscode.window.showWarningMessage(`Remove the account ${account.label} (${account.host})?`, { modal: true, detail }, 'Remove');
      if (ok) await accounts.remove(account.id);
    })),
  ];
}
