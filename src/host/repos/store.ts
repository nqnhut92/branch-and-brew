import * as vscode from 'vscode';
import { parseList, type RepoList } from '../../core/repos/model';

const KEY = 'branchAndBrew.repoList';

/** Repository list in globalState: every window shows the same list. Not synced, because paths are per machine. */
export class RepoStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<RepoList>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly memento: vscode.Memento) {}

  get list(): RepoList {
    return parseList(this.memento.get(KEY));
  }

  async update(change: (list: RepoList) => RepoList): Promise<RepoList> {
    const next = change(this.list);
    await this.memento.update(KEY, next);
    this.changed.fire(next);
    return next;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
