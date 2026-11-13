import * as vscode from 'vscode';
import { cloneInto, registerAccountCommands } from './accounts/commands';
import { Accounts } from './accounts/service';
import { ACCOUNTS_VIEW_ID, AccountsTreeProvider } from './accounts/view';
import { startAskpassHost } from './askpassHost';
import { GIT_SCHEME, GitContentProvider } from './gitContent';
import { describeToolchain, registerJavaCommands, runMaven } from './java/commands';
import { jdkLabel, Toolchain } from './java/toolchain';
import { buildStateText, MavenStatus } from './maven/status';
import { detectProjectKinds } from '../core/project/detect';
import type { ConflictFile, Side } from '../core/merge/stages';
import { resolveFile, takeWhole } from './merge/commands';
import { LogPanel } from './panels/logPanel';
import type { MergePanel } from './panels/mergePanel';
import { RebasePanel } from './panels/rebasePanel';
import { BackgroundFetch } from './repos/backgroundFetch';
import { VIEW_ID } from './repos/bulk';
import { registerRepoCommands } from './repos/commands';
import { RepoStates } from './repos/state';
import { RepoStore } from './repos/store';
import { RepoTreeProvider } from './repos/treeProvider';
import { RepoWatcher } from './repos/watcher';

/** Returned from activate for integration tests; not a public API. */
export interface TestApi {
  store: RepoStore;
  states: RepoStates;
  tree: RepoTreeProvider;
  /** Opens the log of a repository, or the history of one file in it. */
  openLog(repo: string, file?: string): LogPanel;
  /** Opens a conflicted file in the three-pane merge; undefined when it has no line-by-line editor. */
  resolveFile(repo: string, file: string): Promise<MergePanel | undefined>;
  /** Resolves a conflicted file with one side's whole version. */
  takeWhole(repo: string, file: ConflictFile, side: Side): Promise<boolean>;
  /** Opens the rebase table for the current branch onto `onto`; without it, the running rebase. */
  openRebase(repo: string, onto?: string): RebasePanel;
  accounts: Accounts;
  /** Clones `url` into `<parent>/<name>`, registers it in the group and applies the group's profile. */
  cloneInto(url: string, parent: string, groupId?: string): Promise<string>;
  /** Extra environment for network git commands (tests switch off the machine's credential helpers). */
  setGitEnv(env: Record<string, string>): void;
  java: Toolchain;
  mavenStatus: MavenStatus;
  /** Runs Maven goals in a repository with its own JDK; resolves with the exit code. */
  runMaven(repo: string, goals: string[]): Promise<number | undefined>;
  describeToolchain(repo: string): string[];
}

export async function activate(context: vscode.ExtensionContext): Promise<TestApi> {
  const store = new RepoStore(context.globalState);
  const states = new RepoStates();
  const tree = new RepoTreeProvider(store, states);
  const watcher = new RepoWatcher((repo) => void states.refresh(repo));
  let networkEnv: Record<string, string> = {};
  let extraGitEnv: Record<string, string> = {};
  const accounts = new Accounts(context);
  const accountsTree = new AccountsTreeProvider(accounts);
  const java = new Toolchain(context);
  const mavenStatus = new MavenStatus();
  const deps = {
    store, states, networkEnv: () => ({ ...networkEnv, ...extraGitEnv }), extensionUri: context.extensionUri,
    projectKinds: (repo: string) => detectProjectKinds(repo),
    terminalEnv: (repo: string) => (detectProjectKinds(repo).includes('maven') ? java.env(repo) : {}),
  };
  tree.extras = {
    kinds: deps.projectKinds,
    mark: (repo) => {
      const state = mavenStatus.get(repo);
      return state && buildStateText(state);
    },
    java: (repo) => {
      if (!deps.projectKinds(repo).includes('maven')) return undefined;
      const r = java.resolve(repo);
      return r.jdk ? `Java: ${jdkLabel(r.jdk)}, ${r.source}` : r.feature ? `Java: ${r.feature} needed (${r.source}), not installed` : 'Java: version not stated in pom.xml';
    },
  };

  const syncRepos = () => {
    const repos = store.list.repos.map((r) => r.path);
    void watcher.sync(repos);
    return states.refreshAll(repos);
  };

  context.subscriptions.push(
    store, states, tree, watcher, java, mavenStatus, accounts, accountsTree,
    vscode.window.createTreeView(ACCOUNTS_VIEW_ID, { treeDataProvider: accountsTree }),
    ...registerAccountCommands(deps, accounts),
    ...registerJavaCommands(deps, java, mavenStatus),
    mavenStatus.onDidChange((repo) => tree.redraw(repo)),
    java.onDidChange(() => tree.redraw()),
    vscode.window.createTreeView(VIEW_ID, { treeDataProvider: tree, canSelectMany: true, showCollapseAll: true }),
    ...registerRepoCommands(deps),
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContentProvider()),
    new BackgroundFetch(store, states, deps.networkEnv),
    store.onDidChange(() => void syncRepos()),
    // Working-tree edits do not touch .git; catch up when the user comes back to VS Code.
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) void states.refreshAll(store.list.repos.map((r) => r.path));
    }),
  );

  try {
    networkEnv = (await startAskpassHost(context, (prompt) => accounts.answer(prompt))).env;
  } catch (e) {
    // Without askpass, git still uses its credential helpers; prompts then fail instead of hanging.
    console.error('branch-and-brew: askpass unavailable', e);
  }
  void syncRepos();
  return { store, states, tree, openLog: (repo, file) => LogPanel.open(deps, repo, file),
    resolveFile: (repo, file) => resolveFile(deps, repo, file),
    takeWhole: (repo, file, side) => takeWhole(deps, repo, file, side),
    accounts,
    cloneInto: (url, parent, groupId) => cloneInto(deps, url, parent, groupId),
    setGitEnv: (env) => { extraGitEnv = env; },
    java, mavenStatus,
    runMaven: (repo, goals) => runMaven(java, mavenStatus, repo, 'Maven', goals),
    describeToolchain: (repo) => describeToolchain(java, repo),
    openRebase: (repo, onto) => RebasePanel.open(deps, repo, onto === undefined ? undefined : { onto, label: onto }),
  };
}

export function deactivate(): void {}
