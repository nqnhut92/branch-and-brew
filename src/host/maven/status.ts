import * as vscode from 'vscode';
import { pathKey } from '../../core/repos/model';

export type BuildState = 'running' | 'passed' | 'failed';

const TEXT: Record<BuildState, string> = { running: 'Maven running', passed: 'Maven passed', failed: 'Maven failed' };
export const buildStateText = (state: BuildState) => TEXT[state];

/** The result of the last Maven run per repository, shown as a mark on its row. */
export class MavenStatus implements vscode.Disposable {
  private readonly states = new Map<string, BuildState>();
  private readonly changed = new vscode.EventEmitter<string>();
  /** Fires the repository whose mark changed. */
  readonly onDidChange = this.changed.event;

  get(repo: string): BuildState | undefined {
    return this.states.get(pathKey(repo));
  }

  set(repo: string, state: BuildState): void {
    this.states.set(pathKey(repo), state);
    this.changed.fire(repo);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
