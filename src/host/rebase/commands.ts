import * as vscode from 'vscode';
import { listBranches } from '../../core/git/refs';
import { getCommitDetail } from '../../core/git/show';
import { listRebaseCommits } from '../../core/rebase/session';
import { RebasePanel } from '../panels/rebasePanel';
import { repoName, type Deps } from '../repos/commands';
import { confirmRebaseStart } from './confirm';

const short = (hash: string) => hash.slice(0, 8);

/** The rebase already running in the repository, shown in its panel; false when there is none. */
async function showRunning(deps: Deps, repo: string): Promise<boolean> {
  const operation = (await deps.states.refresh(repo)).status?.operation;
  if (operation === 'rebase') {
    RebasePanel.open(deps, repo);
    return true;
  }
  if (operation) {
    void vscode.window.showWarningMessage(`${repoName(repo)} is in the middle of a ${operation}; finish or abort it first.`);
    return true;
  }
  return false;
}

/** Repo row: continue the running rebase, or pick what to rebase the current branch onto. */
export async function interactiveRebase(deps: Deps, repo: string): Promise<RebasePanel | undefined> {
  if (await showRunning(deps, repo)) return undefined;
  const status = deps.states.get(repo).status;
  const branches = (await listBranches(repo)).filter((b) => !b.current);
  const upstream = status?.upstream;
  const pick = await vscode.window.showQuickPick(
    branches
      .sort((a, b) => Number(b.name === upstream) - Number(a.name === upstream))
      .map((b) => ({ label: b.name, description: b.name === upstream ? 'upstream' : b.remote ? 'remote' : undefined })),
    { title: `Rebase ${status?.branch ?? 'HEAD'} onto`, placeHolder: 'The commits not on that branch go into the table', matchOnDescription: true },
  );
  return pick ? RebasePanel.open(deps, repo, { onto: pick.label, label: pick.label }) : undefined;
}

/** Log: the table with the commits from `hash` up to HEAD. */
export async function interactiveRebaseFrom(deps: Deps, repo: string, hash: string): Promise<RebasePanel | undefined> {
  if (await showRunning(deps, repo)) return undefined;
  const [parent] = (await getCommitDetail(repo, hash)).parents;
  return RebasePanel.open(deps, repo, parent
    ? { onto: parent, label: `${short(parent)} (the commit before ${short(hash)})` }
    : { onto: null, label: 'the first commit' });
}

/** Log: `git rebase <hash>`. Opens the panel only when the rebase stops. True when it ran. */
export async function rebaseOnto(deps: Deps, repo: string, hash: string): Promise<boolean> {
  if (await showRunning(deps, repo)) return false;
  const commits = await listRebaseCommits(repo, hash);
  const go = await confirmRebaseStart(deps, repo, commits[0]?.hash);
  if (!go) return false;
  const panel = RebasePanel.open(deps, repo, { onto: hash, label: short(hash) });
  try {
    const view = await panel.runPlain(hash, go.autostash);
    if (view.phase === 'done') panel.dispose();
  } catch (e) {
    panel.dispose();
    void vscode.window.showErrorMessage(`${repoName(repo)}: ${(e as Error).message}`);
  }
  return true;
}
