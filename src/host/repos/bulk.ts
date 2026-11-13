import * as path from 'node:path';
import * as vscode from 'vscode';
import { pull } from '../../core/git/ops';
import { getStatus } from '../../core/git/status';
import { summarizePull, type PullOutcome } from '../../core/repos/describe';
import { mapLimit } from '../../core/repos/pool';
import type { RepoStates } from './state';

export const VIEW_ID = 'branchAndBrew.repos';

/**
 * Pulls repositories three at a time with progress on the view, then shows one summary that
 * names conflicts and failures. A dirty repository is tried anyway; git refuses when it would
 * overwrite local changes, and that is reported as a failure.
 */
export async function pullAll(repos: string[], states: RepoStates, env: Record<string, string>): Promise<PullOutcome[]> {
  if (!repos.length) return [];
  let done = 0;
  const outcomes = await vscode.window.withProgress(
    { location: { viewId: VIEW_ID }, title: 'Pull all' },
    async (progress) => {
      const settled = await mapLimit(repos, 3, async (repo): Promise<PullOutcome> => {
        states.setBusy(repo, 'pulling');
        try {
          await pull(repo, { env });
          return { repo, result: 'ok' };
        } catch (e) {
          const s = await getStatus(repo).catch(() => undefined);
          if (s && (s.conflicted || s.operation)) return { repo, result: 'conflict' };
          return { repo, result: 'failed', message: (e as Error).message };
        } finally {
          states.setBusy(repo, undefined);
          void states.refresh(repo);
          progress.report({ message: `${++done} of ${repos.length}` });
        }
      });
      return settled.map((s, i): PullOutcome =>
        s.status === 'fulfilled' ? s.value : { repo: repos[i], result: 'failed', message: String(s.reason) });
    },
  );
  const text = summarizePull(outcomes, (r) => path.basename(r));
  const bad = outcomes.some((o) => o.result !== 'ok');
  void (bad ? vscode.window.showWarningMessage(text) : vscode.window.showInformationMessage(text));
  return outcomes;
}
