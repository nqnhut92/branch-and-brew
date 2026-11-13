import * as vscode from 'vscode';
import { fetch } from '../../core/git/ops';
import { pathKey } from '../../core/repos/model';
import { mapLimit } from '../../core/repos/pool';
import type { RepoStates } from './state';
import type { RepoStore } from './store';

/** A repo that keeps failing waits at most this long between tries. */
const RETRY_CEILING_MS = 60 * 60_000;

/**
 * Fetches every registered repo every `branchAndBrew.fetchIntervalMinutes` minutes (0 = off).
 * Errors stay quiet, and a repo that failed is left alone for a while instead of being fetched
 * again every round: an offline laptop or a remote that is gone would otherwise try forever.
 */
export class BackgroundFetch implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private readonly config: vscode.Disposable;
  /** When each repo last failed a fetch, and how many times in a row. */
  private readonly failures = new Map<string, { at: number; tries: number }>();

  constructor(private readonly store: RepoStore, private readonly states: RepoStates, private readonly env: () => Record<string, string>) {
    this.config = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('branchAndBrew.fetchIntervalMinutes')) this.schedule();
    });
    this.schedule();
  }

  private schedule(): void {
    clearInterval(this.timer);
    const minutes = vscode.workspace.getConfiguration('branchAndBrew').get<number>('fetchIntervalMinutes', 0);
    if (minutes > 0) this.timer = setInterval(() => void this.run(), Math.max(1, minutes) * 60_000);
  }

  /** One interval after the first failure, then twice as long each time, up to an hour. */
  private retryDelay(tries: number): number {
    const minutes = Math.max(1, vscode.workspace.getConfiguration('branchAndBrew').get<number>('fetchIntervalMinutes', 0));
    return Math.min(RETRY_CEILING_MS, minutes * 60_000 * 2 ** Math.min(tries - 1, 6));
  }

  private async run(): Promise<void> {
    const repos = this.store.list.repos;
    // A repo taken out of the list must not keep its failure around.
    const registered = new Set(repos.map((r) => pathKey(r.path)));
    for (const key of this.failures.keys()) if (!registered.has(key)) this.failures.delete(key);

    const now = Date.now();
    await mapLimit(repos, 3, async (r) => {
      const key = pathKey(r.path);
      const failed = this.failures.get(key);
      if (failed && now - failed.at < this.retryDelay(failed.tries)) return;
      try {
        // Background fetch must never prompt; GIT_TERMINAL_PROMPT=0 is already set and askpass is left out.
        await fetch(r.path, { env: { ...this.env(), GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never' } });
        this.failures.delete(key);
      } catch {
        this.failures.set(key, { at: Date.now(), tries: (failed?.tries ?? 0) + 1 });
      }
      // The status is local and cheap, so it is read even when the fetch was skipped.
      await this.states.refresh(r.path);
    });
  }

  dispose(): void {
    clearInterval(this.timer);
    this.config.dispose();
  }
}
