import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  BrewingHostToWebview,
  BrewingMethods,
  BrewingWebviewToHost,
  RpcResponse,
} from '../../shared/protocol';
import type { Deps } from '../repos/commands';
import { renderWebview, webviewOptions } from './webviewHtml';

export class BrewingPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly onDidCloseEmitter = new vscode.EventEmitter<void>();
  readonly onDidClose = this.onDidCloseEmitter.event;

  private buffer = '';
  private currentStatus: 'brewing' | 'success' | 'error' = 'brewing';

  static open(deps: Deps, repo: string, title: string, command: string): BrewingPanel {
    return new BrewingPanel(deps, repo, title, command);
  }

  private constructor(
    deps: Deps,
    readonly repo: string,
    readonly title: string,
    readonly command: string,
  ) {
    const repoName = path.basename(repo);
    const panelTitle = `☕ Brewing: ${title} (${repoName})`;
    this.panel = vscode.window.createWebviewPanel(
      'branchAndBrew.brewing',
      panelTitle,
      vscode.ViewColumn.Active,
      webviewOptions(deps.extensionUri),
    );

    this.subscriptions.push(
      this.panel.webview.onDidReceiveMessage((msg: BrewingWebviewToHost) => void this.receive(msg)),
      this.panel.onDidDispose(() => {
        this.subscriptions.forEach((s) => s.dispose());
        this.onDidCloseEmitter.fire();
        this.onDidCloseEmitter.dispose();
      }),
    );

    this.panel.webview.html = renderWebview(this.panel.webview, deps.extensionUri, {
      title: panelTitle,
      scripts: ['brewing/main.js'],
      styles: ['brewing/main.css'],
    });
  }

  appendOutput(chunk: string): void {
    this.buffer += chunk;
    void this.panel.webview.postMessage({
      kind: 'event',
      event: 'output',
      chunk,
    } satisfies BrewingHostToWebview);
  }

  finish(status: 'success' | 'error', exitCode?: number, error?: string): void {
    this.currentStatus = status;
    void this.panel.webview.postMessage({
      kind: 'event',
      event: 'status',
      status,
      exitCode,
      error,
    } satisfies BrewingHostToWebview);
  }

  private async receive(msg: BrewingWebviewToHost): Promise<void> {
    let response: RpcResponse;
    try {
      response = { kind: 'response', id: msg.id, result: await this.handle(msg.method as keyof BrewingMethods) };
    } catch (e) {
      response = { kind: 'response', id: msg.id, error: (e as Error).message };
    }
    try {
      await this.panel.webview.postMessage(response);
    } catch {
      // Disposed
    }
  }

  private async handle<M extends keyof BrewingMethods>(method: M): Promise<BrewingMethods[M]['result']> {
    if (method === 'init') {
      return {
        title: this.title,
        repoName: path.basename(this.repo),
        command: this.command,
        status: this.currentStatus,
        initialLines: this.buffer ? [this.buffer] : [],
      } as BrewingMethods[M]['result'];
    }
    if (method === 'close') {
      this.panel.dispose();
      return undefined as BrewingMethods[M]['result'];
    }
    throw new Error(`unknown method ${String(method)}`);
  }

  dispose(): void {
    this.panel.dispose();
  }
}
