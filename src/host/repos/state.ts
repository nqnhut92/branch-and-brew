import * as vscode from 'vscode';
import { getIdentity, type Identity } from '../../core/git/identity';
import { getStatus, type RepoStatus } from '../../core/git/status';
import { mapLimit } from '../../core/repos/pool';
import { pathKey } from '../../core/repos/model';

export interface RepoState {
  status?: RepoStatus;
  identity?: Identity;
  error?: string;
  /** Set while an action runs on this repo, shown as a spinner. */
  busy?: string;
}

/** Live status of every registered repository, refreshed on demand. */
export class RepoStates implements vscode.Disposable {
  private readonly states = new Map<string, RepoState>();
  private readonly changed = new vscode.EventEmitter<string>();
  /** Fires the repo path whose state changed. */
  readonly onDidChange = this.changed.event;

  get(repo: string): RepoState {
    return this.states.get(pathKey(repo)) ?? {};
  }

  async refresh(repo: string): Promise<RepoState> {
    const key = pathKey(repo);
    try {
      const [status, identity] = await Promise.all([getStatus(repo), getIdentity(repo)]);
      this.states.set(key, { status, identity, busy: this.states.get(key)?.busy });
    } catch (e) {
      this.states.set(key, { error: (e as Error).message, busy: this.states.get(key)?.busy });
    }
    this.changed.fire(repo);
    return this.get(repo);
  }

  refreshAll(repos: string[]): Promise<unknown> {
    return mapLimit(repos, 4, (r) => this.refresh(r));
  }

  setBusy(repo: string, busy: string | undefined): void {
    const key = pathKey(repo);
    this.states.set(key, { ...this.states.get(key), busy });
    this.changed.fire(repo);
  }

  forget(repo: string): void {
    this.states.delete(pathKey(repo));
  }

  dispose(): void {
    this.changed.dispose();
  }
}
