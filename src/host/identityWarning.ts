import * as vscode from 'vscode';
import { checkIdentity } from '../core/git/identity';
import { profileFor } from '../core/repos/model';
import { repoName, type Deps } from './repos/commands';

/** Before an action that writes commits: warn about a missing or unexpected identity. */
export async function identityOk(deps: Deps, repo: string): Promise<boolean> {
  const identity = (await deps.states.refresh(repo)).identity;
  const problem = identity && checkIdentity(identity, profileFor(deps.store.list, repo));
  if (!problem) return true;
  const what = problem.kind === 'missing'
    ? `${repoName(repo)} has no ${problem.keys.join(' and ')}.`
    : `${repoName(repo)} commits as ${identity.name} <${identity.email}>, not as its group's profile "${problem.profile.label}".`;
  return (await vscode.window.showWarningMessage(what, { modal: true }, 'Continue anyway')) !== undefined;
}
