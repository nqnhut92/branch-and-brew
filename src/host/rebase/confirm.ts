import * as vscode from 'vscode';
import { checkRebaseStart } from '../../core/rebase/session';
import { identityOk } from '../identityWarning';
import { repoName, type Deps } from '../repos/commands';

/**
 * The questions before a rebase starts: identity, uncommitted changes (offer to stash) and commits
 * that are already on a remote branch. Undefined when the user backs out.
 */
export async function confirmRebaseStart(deps: Deps, repo: string, oldestHash?: string): Promise<{ autostash: boolean } | undefined> {
  if (!await identityOk(deps, repo)) return undefined;
  const check = await checkRebaseStart(repo, oldestHash);
  if (check.dirty) {
    const ok = await vscode.window.showWarningMessage(
      `${repoName(repo)} has uncommitted changes, and git does not rebase over them.`,
      { modal: true, detail: 'Stash them for the rebase? Git puts them back when the rebase ends.' }, 'Stash and Rebase');
    if (!ok) return undefined;
  }
  if (check.publishedOn.length) {
    const where = check.publishedOn.slice(0, 3).join(', ') + (check.publishedOn.length > 3 ? '…' : '');
    const ok = await vscode.window.showWarningMessage(
      `These commits are already on ${where}.`,
      { modal: true, detail: 'A rebase rewrites them, so the next push needs a force push and others who have them must re-sync.' },
      'Rebase Anyway');
    if (!ok) return undefined;
  }
  return { autostash: check.dirty };
}
