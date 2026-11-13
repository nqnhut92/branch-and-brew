import * as path from 'node:path';
import * as vscode from 'vscode';
import { getCommitDetail } from '../../core/git/show';
import { gitDir } from '../../core/git/status';
import { pathKey } from '../../core/repos/model';
import { listRebaseCommits, RebaseSession, type Outcome } from '../../core/rebase/session';
import { pauseKind, readRebaseState } from '../../core/rebase/state';
import { serializeTodo, validateTodo, type TodoEntry } from '../../core/rebase/todo';
import type {
  RebaseChanged, RebaseMethods, RebasePerform, RebaseState, RebaseView, RebaseWebviewToHost, RpcResponse,
} from '../../shared/protocol';
import { runFileAction } from '../log/actions';
import { resolveConflicts } from '../merge/commands';
import type { Deps } from '../repos/commands';
import { confirmRebaseStart } from '../rebase/confirm';
import { renderWebview, webviewOptions } from './webviewHtml';

export interface RebaseTarget {
  /** Commit or branch to rebase onto; null rebases from the root commit. */
  onto: string | null;
  /** How the target is shown to the user. */
  label: string;
}

type Handlers = { [M in keyof RebaseMethods]: (params: RebaseMethods[M]['params']) => Promise<RebaseMethods[M]['result']> };

export function newRebaseSession(deps: Deps, repo: string): RebaseSession {
  return new RebaseSession({
    repo,
    scriptsDir: vscode.Uri.joinPath(deps.extensionUri, 'scripts').fsPath,
    // VS Code's own binary runs the editor scripts as Node, so the user needs no Node install.
    nodePath: process.execPath,
  });
}

/**
 * The interactive rebase of one repository: the table before it starts, and the same table with
 * Continue, Skip and Abort every time it pauses. One panel per repository.
 */
export class RebasePanel implements vscode.Disposable {
  private static readonly panels = new Map<string, RebasePanel>();

  /**
   * With a target, opens the table to prepare a rebase onto it. Without one, shows the rebase
   * that is running in the repository. A panel whose rebase is running is never replaced.
   */
  static open(deps: Deps, repo: string, target?: RebaseTarget, session?: RebaseSession): RebasePanel {
    const key = pathKey(repo);
    const existing = RebasePanel.panels.get(key);
    if (existing && (!target || existing.started)) {
      existing.panel.reveal();
      return existing;
    }
    existing?.dispose();
    const created = new RebasePanel(deps, repo, target, session ?? newRebaseSession(deps, repo), () => {
      if (RebasePanel.panels.get(key) === created) RebasePanel.panels.delete(key);
    });
    RebasePanel.panels.set(key, created);
    return created;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** True once the rebase has been started here, or when the panel shows one started elsewhere. */
  private started: boolean;
  private notice?: string;
  private signature = '';
  private state?: RebaseState;
  private readonly waiters: { test(s: RebaseState): boolean; resolve(s: RebaseState): void }[] = [];

  private constructor(
    private readonly deps: Deps, readonly repo: string, private readonly target: RebaseTarget | undefined,
    private readonly session: RebaseSession, onDispose: () => void,
  ) {
    this.started = !target;
    const title = `Rebase: ${path.basename(repo)}`;
    this.panel = vscode.window.createWebviewPanel('branchAndBrew.rebase', title, vscode.ViewColumn.Active, {
      ...webviewOptions(deps.extensionUri),
      // The table holds edits that cannot be reloaded: actions, order and typed messages.
      retainContextWhenHidden: true,
    });
    this.subscriptions.push(
      this.panel.webview.onDidReceiveMessage((msg: RebaseWebviewToHost) => void this.receive(msg)),
      this.panel.onDidDispose(() => {
        onDispose();
        this.subscriptions.forEach((s) => s.dispose());
        void this.session.dispose();
      }),
      deps.states.onDidChange((changed) => {
        if (pathKey(changed) !== pathKey(repo)) return;
        const signature = this.currentSignature();
        if (signature === this.signature) return;
        this.signature = signature;
        void this.panel.webview.postMessage({ kind: 'event', event: 'changed' } satisfies RebaseChanged);
      }),
    );
    this.signature = this.currentSignature();
    this.panel.webview.html = renderWebview(this.panel.webview, deps.extensionUri, {
      title, scripts: ['rebase/main.js'], styles: ['rebase/main.css'],
    });
  }

  private currentSignature(): string {
    const s = this.deps.states.get(this.repo).status;
    return s ? JSON.stringify([s.oid, s.branch, s.changed, s.conflicted, s.operation]) : '';
  }

  private async receive(msg: RebaseWebviewToHost): Promise<void> {
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
      response = { kind: 'response', id: msg.id, result: await this.handle(msg.method as keyof RebaseMethods, msg.params as never) };
    } catch (e) {
      const error = (e as Error).message;
      void vscode.window.showErrorMessage(`${path.basename(this.repo)}: ${error}`);
      response = { kind: 'response', id: msg.id, error };
    }
    try { await this.panel.webview.postMessage(response); } catch { /* disposed */ }
  }

  /** Runs one method of the rebase protocol. Public so the integration tests can call it directly. */
  handle<M extends keyof RebaseMethods>(method: M, params: RebaseMethods[M]['params']): Promise<RebaseMethods[M]['result']> {
    const handler = this.handlers[method] as ((p: RebaseMethods[M]['params']) => Promise<RebaseMethods[M]['result']>) | undefined;
    if (!handler) return Promise.reject(new Error(`unknown method ${String(method)}`));
    return handler(params);
  }

  private async view(): Promise<RebaseView> {
    const name = path.basename(this.repo);
    const status = (await this.deps.states.refresh(this.repo)).status;
    this.signature = this.currentSignature();
    const rebase = status?.operation === 'rebase' ? readRebaseState(await gitDir(this.repo)) : undefined;
    if (rebase) {
      this.started = true;
      const pending = this.session.pendingMessage;
      return {
        name, branch: rebase.branch, onto: this.target?.label ?? rebase.onto?.slice(0, 8) ?? '',
        phase: pending ? 'message' : 'paused',
        done: rebase.done,
        rows: rebase.remaining.map((e) => ({ ...e, message: this.session.messageFor(e.hash) })),
        step: rebase.step, total: rebase.total,
        pause: pending ? undefined : { kind: pauseKind(rebase, status?.conflicted ?? 0), hash: rebase.stoppedHash, conflicts: status?.conflicted ?? 0 },
        pendingMessage: pending, notice: this.notice,
      };
    }
    if (this.target && !this.started) {
      const rows = await listRebaseCommits(this.repo, this.target.onto);
      return { name, branch: status?.branch, onto: this.target.label, phase: 'plan', done: [], rows, step: 0, total: rows.length, notice: this.notice };
    }
    return { name, branch: status?.branch, onto: this.target?.label ?? '', phase: 'done', done: [], rows: [], step: 0, total: 0, notice: this.notice };
  }

  /** Runs a rebase command with a spinner on the repo row, then describes where it stopped. */
  private async drive(command: () => Promise<Outcome>): Promise<RebaseView> {
    this.notice = undefined;
    this.deps.states.setBusy(this.repo, 'rebasing');
    let outcome: Outcome;
    try {
      outcome = await command();
    } finally {
      this.deps.states.setBusy(this.repo, undefined);
    }
    const view = await this.view();
    if (outcome.phase === 'done') {
      void vscode.window.showInformationMessage(`Rebase of ${view.name} finished.`);
    } else if (outcome.phase === 'paused' && outcome.error && !view.pause?.conflicts) {
      // Not a conflict: git refused or stopped for another reason; say which.
      view.notice = this.notice = outcome.error;
    }
    return view;
  }

  /** The remaining rows as git has them, to see whether the table changed them. */
  private async remaining(): Promise<{ rows: TodoEntry[]; hasPrevious: boolean }> {
    const rebase = readRebaseState(await gitDir(this.repo));
    return { rows: rebase?.remaining ?? [], hasPrevious: (rebase?.done.length ?? 0) > 0 };
  }

  /** Validates the edited remaining rows; returns them when they differ from git's list. */
  private async edited(rows: TodoEntry[]): Promise<TodoEntry[] | undefined> {
    const current = await this.remaining();
    const problem = validateTodo(rows, current.hasPrevious);
    if (problem) throw new Error(problem);
    this.session.setMessages(rows);
    return serializeTodo(rows) === serializeTodo(current.rows) ? undefined : rows;
  }

  /** Starts a rebase that is not interactive (the log's "Rebase current branch onto this"). */
  runPlain(onto: string, autostash: boolean): Promise<RebaseView> {
    this.started = true;
    return this.drive(() => this.session.start({ onto, autostash }));
  }

  /** Aborts the rebase without asking; the panel's Abort button asks first. */
  async abortNow(): Promise<RebaseView> {
    this.notice = undefined;
    await this.session.abort();
    return this.view();
  }

  private readonly handlers: Handlers = {
    init: () => this.view(),
    state: () => this.view(),
    detail: ({ hash }) => getCommitDetail(this.repo, hash),

    start: async ({ rows }) => {
      if (!this.target || this.started) throw new Error('This rebase has already started.');
      const problem = validateTodo(rows);
      if (problem) throw new Error(problem);
      const go = await confirmRebaseStart(this.deps, this.repo, rows.find((r) => r.action !== 'other')?.hash);
      if (!go) return this.view();
      const { onto } = this.target;
      this.started = true;
      try {
        return await this.drive(() => this.session.start({ onto, entries: rows, autostash: go.autostash }));
      } catch (e) {
        this.started = false; // git refused before anything changed
        throw e;
      }
    },

    continue: async ({ rows, message }) => {
      const pending = this.session.pendingMessage;
      if (pending) {
        const text = message ?? pending.text;
        if (!text.trim()) throw new Error('The commit message is empty.');
        return this.drive(() => this.session.answerMessage(text));
      }
      const edited = await this.edited(rows);
      return this.drive(() => this.session.continue(edited));
    },

    skip: async ({ rows }) => {
      const edited = await this.edited(rows);
      return this.drive(() => this.session.skip(edited));
    },

    abort: async () => {
      const ok = await vscode.window.showWarningMessage(
        `Abort the rebase of ${path.basename(this.repo)}? The branch goes back to where it was before the rebase started.`,
        { modal: true }, 'Abort Rebase');
      return ok ? this.abortNow() : this.view();
    },

    resolve: async () => {
      await resolveConflicts(this.deps, this.repo);
      return null;
    },

    diff: async ({ hash, path: file, oldPath }) => {
      await runFileAction(this.deps, this.repo, { action: 'diff', hash, path: file, oldPath }, () => undefined);
      return null;
    },
  };

  /** Presses one of the view's controls from the host. */
  perform(action: Omit<RebasePerform, 'kind' | 'event'>): void {
    void this.panel.webview.postMessage({ kind: 'event', event: 'perform', ...action } satisfies RebasePerform);
  }

  /** Resolves with the view's first reported state that passes `test` (tests). */
  whenState(test: (s: RebaseState) => boolean = () => true, fresh = false): Promise<RebaseState> {
    if (!fresh && this.state && test(this.state)) return Promise.resolve(this.state);
    return new Promise((resolve) => this.waiters.push({ test, resolve }));
  }

  dispose(): void {
    this.panel.dispose();
  }
}
