import * as vscode from 'vscode';
import { run } from '../../core/git/runner';
import { pathKey } from '../../core/repos/model';

const DEBOUNCE_MS = 300;

/**
 * Watches each repository's git directory and calls `onChange(repo)` 300 ms after the last event.
 * Non-recursive on the git dir (HEAD, index, MERGE_HEAD, rebase-merge…) plus recursive on refs/
 * in the common dir, so worktrees work and the expensive recursive watch stays small.
 */
export class RepoWatcher implements vscode.Disposable {
  private readonly watched = new Map<string, { disposables: vscode.Disposable[]; timer?: NodeJS.Timeout }>();

  constructor(private readonly onChange: (repo: string) => void) {}

  async sync(repos: string[]): Promise<void> {
    const wanted = new Map(repos.map((r) => [pathKey(r), r]));
    for (const [key, w] of this.watched) {
      if (!wanted.has(key)) {
        this.stop(w);
        this.watched.delete(key);
      }
    }
    await Promise.all([...wanted].filter(([key]) => !this.watched.has(key)).map(([key, repo]) => this.watch(key, repo)));
  }

  private async watch(key: string, repo: string): Promise<void> {
    // --path-format=absolute (git 2.31+) makes both answers absolute, worktrees included.
    const r = await run(repo, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { noQueue: true });
    if (r.exitCode !== 0) return;
    const [gitDir, commonDir] = r.stdout.trim().split(/\r?\n/);
    const entry: { disposables: vscode.Disposable[]; timer?: NodeJS.Timeout } = { disposables: [] };
    const fire = () => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.onChange(repo), DEBOUNCE_MS);
    };
    const patterns = [
      new vscode.RelativePattern(vscode.Uri.file(gitDir), '*'),
      new vscode.RelativePattern(vscode.Uri.file(commonDir), 'refs/**'),
      new vscode.RelativePattern(vscode.Uri.file(commonDir), 'packed-refs'),
    ];
    for (const pattern of patterns) {
      const w = vscode.workspace.createFileSystemWatcher(pattern);
      entry.disposables.push(w, w.onDidChange(fire), w.onDidCreate(fire), w.onDidDelete(fire));
    }
    this.watched.set(key, entry);
  }

  private stop(w: { disposables: vscode.Disposable[]; timer?: NodeJS.Timeout }): void {
    clearTimeout(w.timer);
    w.disposables.forEach((d) => d.dispose());
  }

  dispose(): void {
    this.watched.forEach((w) => this.stop(w));
    this.watched.clear();
  }
}
