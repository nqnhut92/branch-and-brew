import * as path from 'node:path';
import * as vscode from 'vscode';
import { folderClashes } from '../../core/accounts/browse';
import { cloneRepo, cloneTarget, lastMessage, parseCloneProgress } from '../../core/accounts/clone';
import { folderNameOf, type Account, type RemoteRepo } from '../../core/accounts/model';
import { GitCancelledError } from '../../core/git/runner';
import { mapLimit } from '../../core/repos/pool';
import type {
  CloneHostToWebview, CloneInit, CloneItemEvent, CloneList, CloneRegisteredEvent, CloneMethods, CloneStartResult, CloneWebviewToHost, RpcResponse,
} from '../../shared/protocol';
import { addPaths, type Deps } from '../repos/commands';
import { renderWebview, webviewOptions } from '../panels/webviewHtml';
import { askDestination, type Destination } from './destination';
import type { Accounts } from './service';

/** Clones that run at once; the same as Pull all. */
const PARALLEL = 3;

/** Repository lists already fetched in this session, so reopening the tab does not fetch again. */
const lists = new Map<string, RemoteRepo[]>();

/**
 * The tab for browsing one account (or Azure DevOps organization) and cloning any number of its
 * repositories: tick them, answer the folder and group questions once, and each repository
 * shows its own progress. One tab per account and organization.
 */
export class ClonePanel implements vscode.Disposable {
  private static readonly panels = new Map<string, ClonePanel>();

  static open(deps: Deps, accounts: Accounts, memento: vscode.Memento, account: Account, organization?: string): ClonePanel {
    const key = `${account.id}|${organization ?? ''}`;
    const existing = ClonePanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return existing;
    }
    const created = new ClonePanel(deps, accounts, memento, account, organization, key);
    ClonePanel.panels.set(key, created);
    return created;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly itemEmitter = new vscode.EventEmitter<CloneItemEvent>();
  /** Every progress event the panel sends to its page; the integration tests listen here. */
  readonly onDidItem = this.itemEmitter.event;
  private readonly registeredEmitter = new vscode.EventEmitter<string[]>();
  /** Fires with the registered folder names whenever they change; the tests listen here. */
  readonly onDidRegisteredChange = this.registeredEmitter.event;
  private registeredKey = '';
  private destination?: Destination;
  /** Lets a run stop its queue when the panel is closed. */
  private disposed = false;

  private constructor(
    private readonly deps: Deps, private readonly accounts: Accounts, private readonly memento: vscode.Memento,
    private readonly account: Account, private readonly organization: string | undefined, key: string,
  ) {
    const title = `Clone: ${organization ?? account.label}`;
    this.panel = vscode.window.createWebviewPanel('branchAndBrew.clone', title, vscode.ViewColumn.Active, {
      ...webviewOptions(deps.extensionUri),
      // The ticked repositories and the progress of a running clone cannot be rebuilt.
      retainContextWhenHidden: true,
    });
    this.subscriptions.push(
      this.panel.webview.onDidReceiveMessage((msg: CloneWebviewToHost) => void this.receive(msg)),
      // A repository removed from the list, or added by a clone, changes what "in list" means.
      deps.store.onDidChange(() => this.pushRegistered()),
      this.panel.onDidDispose(() => {
        this.disposed = true;
        ClonePanel.panels.delete(key);
        for (const c of this.controllers.values()) c.abort();
        this.subscriptions.forEach((s) => s.dispose());
        this.itemEmitter.dispose();
        this.registeredEmitter.dispose();
      }),
    );
    this.panel.webview.html = renderWebview(this.panel.webview, deps.extensionUri, {
      title, scripts: ['clone/main.js'], styles: ['clone/main.css'],
    });
  }

  private async receive(msg: CloneWebviewToHost): Promise<void> {
    let response: RpcResponse;
    try {
      response = { kind: 'response', id: msg.id, result: await this.handle(msg.method as keyof CloneMethods, msg.params as never) };
    } catch (e) {
      const error = (e as Error).message;
      void vscode.window.showErrorMessage(error);
      response = { kind: 'response', id: msg.id, error };
    }
    try { await this.panel.webview.postMessage(response); } catch { /* disposed */ }
  }

  /** Runs one method of the clone protocol. Public so the integration tests can call it directly. */
  async handle<M extends keyof CloneMethods>(method: M, params: CloneMethods[M]['params']): Promise<CloneMethods[M]['result']> {
    switch (method) {
      case 'init': return { source: this.organization ?? this.account.label } satisfies CloneInit as CloneMethods[M]['result'];
      case 'load': return await this.load((params as CloneMethods['load']['params']).refresh) as CloneMethods[M]['result'];
      case 'start': return await this.start((params as CloneMethods['start']['params']).urls) as CloneMethods[M]['result'];
      case 'retry': {
        const { urls } = params as CloneMethods['retry']['params'];
        if (this.destination) void this.run(urls, this.destination);
        return undefined as CloneMethods[M]['result'];
      }
      case 'cancel': {
        const { url } = params as CloneMethods['cancel']['params'];
        if (url) this.controllers.get(url)?.abort();
        else for (const c of this.controllers.values()) c.abort();
        return undefined as CloneMethods[M]['result'];
      }
      default: throw new Error(`unknown method ${String(method)}`);
    }
  }

  private async load(refresh: boolean): Promise<CloneList> {
    const key = `${this.account.id}|${this.organization ?? ''}`;
    let repos = refresh ? undefined : lists.get(key);
    if (!repos) {
      repos = await this.accounts.repos(this.account, this.organization);
      lists.set(key, repos);
    }
    const registered = this.registeredNames();
    this.registeredKey = registered.join('\n');
    return { repos, registered };
  }

  private registeredNames(): string[] {
    return this.deps.store.list.repos.map((r) => path.basename(r.path).toLowerCase());
  }

  /** Tells the page which folder names are registered now, when that differs from what it was last told. */
  private pushRegistered(): void {
    if (this.disposed) return;
    const registered = this.registeredNames();
    const key = registered.join('\n');
    if (key === this.registeredKey) return;
    this.registeredKey = key;
    this.registeredEmitter.fire(registered);
    void this.panel.webview.postMessage({ kind: 'event', event: 'registered', registered } satisfies CloneRegisteredEvent);
  }

  private async start(urls: string[]): Promise<CloneStartResult> {
    const count = urls.length;
    const destination = await askDestination(this.deps, this.memento, `Where to clone ${count} ${count === 1 ? 'repository' : 'repositories'}`);
    if (!destination) return { started: false };
    this.destination = destination;
    void this.run(urls, destination);
    return { started: true, destination: destination.folder, group: destination.groupName };
  }

  private send(event: Omit<CloneItemEvent, 'kind' | 'event'>): void {
    if (this.disposed) return;
    const message: CloneItemEvent = { kind: 'event', event: 'item', ...event };
    this.itemEmitter.fire(message);
    void this.panel.webview.postMessage(message satisfies CloneHostToWebview);
  }

  /** Clones `urls` three at a time; every one reports through `item` events and none rejects. */
  async run(urls: string[], destination: Destination): Promise<void> {
    const clashes = folderClashes(urls);
    const todo = urls.filter((u) => {
      if (this.controllers.has(u)) return false;
      const first = clashes.get(u);
      if (first === undefined) return true;
      this.send({ url: u, status: 'error', error: `Same folder name as ${folderNameOf(first)}; clone it on its own.` });
      return false;
    });
    for (const u of todo) {
      this.controllers.set(u, new AbortController());
      this.send({ url: u, status: 'queued', percent: 0 });
    }
    await mapLimit(todo, PARALLEL, async (url) => {
      const abort = this.controllers.get(url)!;
      try {
        if (abort.signal.aborted || this.disposed) return this.send({ url, status: 'cancelled' });
        this.send({ url, status: 'cloning', percent: 0, phase: 'Starting' });
        cloneTarget(url, destination.folder);
        let last = '';
        let tail = '';
        const target = await cloneRepo(url, destination.folder, {
          env: this.deps.networkEnv(), signal: abort.signal,
          onStderr: (chunk) => {
            tail = (tail + chunk).slice(-4000);
            const p = parseCloneProgress(chunk);
            if (!p || `${p.phase}${p.percent}` === last) return;
            last = `${p.phase}${p.percent}`;
            this.send({ url, status: 'cloning', percent: p.percent, phase: p.phase });
          },
        }).catch((e: Error) => { throw e instanceof GitCancelledError ? e : Object.assign(e, { tail }); });
        await addPaths(this.deps, [target], destination.groupId);
        this.send({ url, status: 'done', percent: 100, folder: target });
      } catch (e) {
        if (e instanceof GitCancelledError) return this.send({ url, status: 'cancelled' });
        const tail = (e as { tail?: string }).tail;
        this.send({ url, status: 'error', error: (tail && lastMessage(tail)) || (e as Error).message });
      } finally {
        this.controllers.delete(url);
      }
    });
  }

  dispose(): void {
    this.panel.dispose();
  }
}
