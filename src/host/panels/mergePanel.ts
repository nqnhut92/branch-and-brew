import * as path from 'node:path';
import * as vscode from 'vscode';
import { saveResult, type ConflictFile, type TextMerge } from '../../core/merge/stages';
import { pathKey } from '../../core/repos/model';
import type {
  MergeInit, MergeMethods, MergePerform, MergeState, MergeWebviewToHost, RpcResponse,
} from '../../shared/protocol';
import type { Deps } from '../repos/commands';
import { renderWebview, webviewOptions } from './webviewHtml';

/** Column titles. In a rebase git's "ours" is the branch being rebased onto, so the words change. */
function labels(rebasing: boolean): MergeInit['labels'] {
  return rebasing
    ? { mine: 'Mine: rebased so far (read-only)', theirs: 'Theirs: commit being applied (read-only)' }
    : { mine: 'Mine: current branch (read-only)', theirs: 'Theirs: incoming (read-only)' };
}

/** The three-pane merge editor for one conflicted text file. One panel per file. */
export class MergePanel implements vscode.Disposable {
  private static readonly panels = new Map<string, MergePanel>();

  static open(deps: Deps, repo: string, file: ConflictFile, merge: TextMerge, onSaved?: () => void): MergePanel {
    const key = `${pathKey(repo)}\0${file.path}`;
    MergePanel.panels.get(key)?.dispose(); // stale content: the stages may have changed
    const created = new MergePanel(deps, repo, file, merge, () => MergePanel.panels.delete(key), onSaved);
    MergePanel.panels.set(key, created);
    return created;
  }

  private readonly panel: vscode.WebviewPanel;
  private state?: MergeState;
  private readonly waiters: { test(s: MergeState): boolean; resolve(s: MergeState): void }[] = [];
  private readonly closed = new vscode.EventEmitter<void>();
  private readonly closedWithUnresolved = new vscode.EventEmitter<void>();
  /** Why the panel is going away: the user closed it, or saving did. */
  private closing: 'closed' | 'saved' = 'closed';
  /** Fires when the panel is closed, saved or not. */
  readonly onDidClose = this.closed.event;
  /** Fires when the panel is closed by the user while unresolved conflicts remain in the view. */
  readonly onDidCloseWithUnresolved = this.closedWithUnresolved.event;

  private constructor(
    private readonly deps: Deps, readonly repo: string, readonly file: ConflictFile, private readonly merge: TextMerge,
    onDispose: () => void, private readonly onSaved?: () => void,
  ) {
    const title = `Merge: ${path.basename(file.path)}`;
    this.panel = vscode.window.createWebviewPanel('branchAndBrew.merge', title, vscode.ViewColumn.Active, {
      ...webviewOptions(deps.extensionUri),
      // Unlike the log, this view holds work that cannot be reloaded: the half-merged result.
      retainContextWhenHidden: true,
    });
    const messages = this.panel.webview.onDidReceiveMessage((msg: MergeWebviewToHost) => void this.receive(msg));
    this.panel.onDidDispose(() => {
      onDispose();
      messages.dispose();
      // A webview panel cannot cancel its own close, so this cannot be a question asked in time.
      // It is a notification, not a modal: nobody can answer a dialog about work already gone, and
      // a modal would hold up the window (and the integration tests) until someone dismissed it.
      if (this.closing === 'closed' && this.state && this.state.unresolved > 0) {
        this.closedWithUnresolved.fire();
        void vscode.window.showWarningMessage(
          `${path.basename(this.file.path)}: ${this.state.unresolved} unresolved conflict${this.state.unresolved === 1 ? '' : 's'} were not saved. ` +
          'The conflict is still in git; open the file again to resolve it.',
        );
      }
      this.closed.fire();
    });
    const workerUrl = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(deps.extensionUri, 'dist', 'webviews', 'monaco', 'editor.worker.js')).toString();
    this.panel.webview.html = renderWebview(this.panel.webview, deps.extensionUri, {
      title, scripts: ['merge/main.js'], styles: ['merge/main.css'], state: { workerUrl },
    });
  }

  private async receive(msg: MergeWebviewToHost): Promise<void> {
    if (msg.kind === 'event') {
      this.state = msg;
      for (const w of this.waiters.filter((x) => x.test(msg))) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(msg);
      }
      return;
    }
    let response: RpcResponse;
    try {
      response = { kind: 'response', id: msg.id, result: await this.handle(msg.method as keyof MergeMethods, msg.params as never) };
    } catch (e) {
      const error = (e as Error).message;
      void vscode.window.showErrorMessage(`${path.basename(this.file.path)}: ${error}`);
      response = { kind: 'response', id: msg.id, error };
    }
    // Saving closes the panel; there is then nobody left to answer.
    try { await this.panel.webview.postMessage(response); } catch { /* disposed */ }
  }

  /** Runs one method of the merge protocol. Public so the integration tests can call it directly. */
  async handle<M extends keyof MergeMethods>(method: M, params: MergeMethods[M]['params']): Promise<MergeMethods[M]['result']> {
    if (method === 'init') {
      const { base, mine, theirs, chunks } = this.merge;
      const rebasing = this.deps.states.get(this.repo).status?.operation === 'rebase';
      const applyNonConflicting = vscode.workspace.getConfiguration('branchAndBrew').get('merge.applyNonConflictingChanges', true);
      return { path: this.file.path, labels: labels(rebasing), base, mine, theirs, chunks, applyNonConflicting } satisfies MergeInit;
    }
    const { lines, unresolved } = params as MergeMethods['save']['params'];
    if (unresolved > 0) {
      const ok = await vscode.window.showWarningMessage(
        `${unresolved} ${unresolved === 1 ? 'conflict is' : 'conflicts are'} not resolved in ${path.basename(this.file.path)}. ` +
        'Saving keeps the base lines there and marks the file as resolved.',
        { modal: true }, 'Save anyway');
      if (!ok) return false;
    }
    await saveResult(this.repo, this.file.path, lines, this.merge.format);
    void this.deps.states.refresh(this.repo);
    // Saving closes the panel too, but it is not a close that loses the work.
    this.closing = 'saved';
    this.panel.dispose();
    this.onSaved?.();
    return true;
  }

  /** Presses one of the view's buttons from the host. */
  perform(action: Omit<MergePerform, 'kind' | 'event'>): void {
    void this.panel.webview.postMessage({ kind: 'event', event: 'perform', ...action } satisfies MergePerform);
  }

  /** Resolves with the view's first reported state that passes `test` (tests). */
  whenState(test: (s: MergeState) => boolean = () => true): Promise<MergeState> {
    if (this.state && test(this.state)) return Promise.resolve(this.state);
    return new Promise((resolve) => this.waiters.push({ test, resolve }));
  }

  dispose(): void {
    this.panel.dispose();
  }
}
