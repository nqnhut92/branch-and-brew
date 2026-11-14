import * as path from 'node:path';
import * as vscode from 'vscode';
import { getChanges } from '../../core/git/changes';
import { emptyLaneState, layoutLanes, resetLanes, type LaneState } from '../../core/git/lanes';
import { getLog, PAGE_SIZE } from '../../core/git/log';
import { listBranches } from '../../core/git/refs';
import { MAX_SCOPE, defaultScope } from '../../core/git/scope';
import { getCommitDetail } from '../../core/git/show';
import { pathKey } from '../../core/repos/model';
import type {
  LogChanged, LogMethods, LogPage, LogRendered, LogWebviewToHost, RpcResponse,
} from '../../shared/protocol';
import { runBranchAction, runCommitAction, runFileAction } from '../log/actions';
import type { Deps } from '../repos/commands';
import { renderWebview, webviewOptions } from './webviewHtml';

type Handlers = { [M in keyof LogMethods]: (params: LogMethods[M]['params']) => Promise<LogMethods[M]['result']> };

/**
 * The commit log of one repository, or the history of one file in it. One panel per repository
 * (and per file); asking again reveals the existing panel.
 */
export class LogPanel implements vscode.Disposable {
  private static readonly open_ = new Map<string, LogPanel>();

  static open(deps: Deps, repo: string, file?: string): LogPanel {
    const key = `${pathKey(repo)}\0${file ?? ''}`;
    const existing = LogPanel.open_.get(key);
    if (existing) {
      existing.panel.reveal();
      return existing;
    }
    const created = new LogPanel(deps, repo, file, () => LogPanel.open_.delete(key));
    LogPanel.open_.set(key, created);
    return created;
  }

  static refreshAll(): void {
    for (const panel of LogPanel.open_.values()) {
      panel.refresh();
    }
  }

  static refreshRepo(repo: string): void {
    for (const panel of LogPanel.open_.values()) {
      if (pathKey(panel.repo) === pathKey(repo)) {
        panel.refresh();
      }
    }
  }

  refresh(): void {
    void this.deps.states.refresh(this.repo);
    void this.panel.webview.postMessage({ kind: 'event', event: 'changed' } satisfies LogChanged);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Lane layout carried from page to page; `nextSkip` is the page it continues at. */
  private lanes: LaneState = emptyLaneState();
  private nextSkip = 0;
  private signature = '';
  private rendered?: LogRendered;
  private readonly renderWaiters: ((r: LogRendered) => void)[] = [];

  private constructor(private readonly deps: Deps, readonly repo: string, readonly file: string | undefined, onDispose: () => void) {
    const name = path.basename(repo);
    const title = file ? `History: ${path.basename(file)} — ${name}` : `Log: ${name}`;
    this.panel = vscode.window.createWebviewPanel('branchAndBrew.log', title, vscode.ViewColumn.Active, webviewOptions(deps.extensionUri));
    this.subscriptions.push(
      this.panel.webview.onDidReceiveMessage((msg: LogWebviewToHost) => void this.receive(msg)),
      this.panel.onDidDispose(() => {
        onDispose();
        this.subscriptions.forEach((s) => s.dispose());
      }),
      this.panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          this.refresh();
        }
      }),
      deps.states.onDidChange((changed) => {
        if (pathKey(changed) === pathKey(repo)) this.repoChanged();
      }),
    );
    this.signature = this.currentSignature();
    this.panel.webview.html = renderWebview(this.panel.webview, deps.extensionUri, {
      title, scripts: ['log/main.js'], styles: ['log/main.css'],
    });
  }

  /** What the repo panel knows about the repository; a change means the log is out of date. */
  private currentSignature(): string {
    const s = this.deps.states.get(this.repo).status;
    return s ? JSON.stringify([s.oid, s.branch, s.ahead, s.behind, s.changed, s.conflicted, s.operation]) : '';
  }

  private repoChanged(): void {
    const signature = this.currentSignature();
    if (signature === this.signature) return;
    this.signature = signature;
    void this.panel.webview.postMessage({ kind: 'event', event: 'changed' } satisfies LogChanged);
  }

  private async receive(msg: LogWebviewToHost): Promise<void> {
    if (msg.kind === 'event') {
      this.rendered = msg;
      this.renderWaiters.splice(0).forEach((resolve) => resolve(msg));
      return;
    }
    let response: RpcResponse;
    try {
      response = { kind: 'response', id: msg.id, result: await this.handle(msg.method as keyof LogMethods, msg.params as never) };
    } catch (e) {
      const error = (e as Error).message;
      void vscode.window.showErrorMessage(`${path.basename(this.repo)}: ${error}`);
      response = { kind: 'response', id: msg.id, error };
    }
    // The panel may have been closed while the method ran; there is then nobody to answer.
    try { await this.panel.webview.postMessage(response); } catch { /* disposed */ }
  }

  /** Runs one method of the log protocol. Public so the integration tests can call it directly. */
  handle<M extends keyof LogMethods>(method: M, params: LogMethods[M]['params']): Promise<LogMethods[M]['result']> {
    const handler = this.handlers[method] as ((p: LogMethods[M]['params']) => Promise<LogMethods[M]['result']>) | undefined;
    if (!handler) return Promise.reject(new Error(`unknown method ${String(method)}`));
    return handler(params);
  }

  private readonly handlers: Handlers = {
    init: async () => {
      const branches = await listBranches(this.repo);
      return { name: path.basename(this.repo), branches, scope: defaultScope(branches), maxScope: MAX_SCOPE, path: this.file };
    },

    /** The view found the carried graph unusable: the next page starts the graph again. */
    resetGraph: async () => {
      this.lanes = resetLanes(this.lanes);
      this.nextSkip = 0;
      return null;
    },

    page: async ({ scope, skip, search }): Promise<LogPage> => {
      const filtered = !!search?.trim() || !!this.file;
      const branches = await listBranches(this.repo);
      const known = new Set(branches.map((b) => b.name));
      const validScope = scope.filter((name) => known.has(name) || name === 'HEAD');
      const safeScope = validScope.length ? validScope : defaultScope(branches);
      const [commits, changes] = await Promise.all([
        getLog(this.repo, { revs: safeScope.slice(0, MAX_SCOPE), skip, search, path: this.file }),
        skip === 0 && !this.file ? getChanges(this.repo) : undefined,
      ]);
      let rows: LogPage['rows'] = null;
      let graph: LogPage['graph'] = 'none';
      if (skip === 0 && !filtered) {
        // The first page always starts a new graph, whatever the previous filter left behind.
        this.lanes = resetLanes(this.lanes);
        const layout = layoutLanes(commits, this.lanes);
        rows = layout.rows;
        this.lanes = layout.state;
        this.nextSkip = commits.length;
        graph = commits.length ? 'first' : 'none';
      } else if (!filtered && skip === this.nextSkip) {
        // The graph continues from the previous page; a page out of order gets none.
        const layout = layoutLanes(commits, this.lanes);
        rows = layout.rows;
        this.lanes = layout.state;
        this.nextSkip = skip + commits.length;
        graph = 'carried';
      }
      return { commits, rows, done: commits.length < PAGE_SIZE, changes, graph };
    },

    branches: () => listBranches(this.repo),
    detail: ({ hash }) => getCommitDetail(this.repo, hash),
    changes: () => getChanges(this.repo),
    commitAction: ({ action, hash }) => runCommitAction(this.deps, this.repo, action, hash),
    branchAction: ({ action, branch }) => runBranchAction(this.deps, this.repo, action, branch),
    fileAction: (params) => runFileAction(this.deps, this.repo, params, (file) => LogPanel.open(this.deps, this.repo, file)),
  };

  /** Resolves with the webview's next report that it has drawn a page (tests). */
  whenRendered(fresh = false): Promise<LogRendered> {
    if (this.rendered && !fresh) return Promise.resolve(this.rendered);
    return new Promise((resolve) => this.renderWaiters.push(resolve));
  }

  dispose(): void {
    this.panel.dispose();
  }
}
