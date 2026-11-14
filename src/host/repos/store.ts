import * as vscode from 'vscode';
import { parseList, type RepoList } from '../../core/repos/model';

const KEY = 'branchAndBrew.repoList';
/** How often a write is repeated when VS Code has undone it. */
const ATTEMPTS = 5;
/** How many of its own earlier writes the store remembers in order to recognise them. */
const REMEMBERED = 64;

/** The list as it reads after a round trip through globalState, as comparable text. */
const canon = (value: unknown) => JSON.stringify(parseList(JSON.parse(JSON.stringify(value ?? null))));

/** Repository list in globalState: every window shows the same list. Not synced, because paths are per machine. */
export class RepoStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<RepoList>();
  readonly onDidChange = this.changed.event;
  /**
   * The newest list this window wrote. VS Code keeps every globalState key of an extension in one
   * object and, some time after a write, hands back the value it stored earlier, so a write to
   * another key (the accounts) can undo this one. A value that reads back as one of this store's
   * own earlier writes is such an echo and is ignored; any other value was written by another
   * window and is taken over.
   */
  private current: RepoList | undefined;
  private readonly written: string[] = [];

  constructor(private readonly memento: vscode.Memento) {}

  get list(): RepoList {
    const stored = parseList(this.memento.get(KEY));
    if (this.current === undefined) return stored;
    const text = canon(stored);
    if (text === canon(this.current) || this.written.includes(text)) return this.current;
    this.current = stored;
    return stored;
  }

  async update(change: (list: RepoList) => RepoList): Promise<RepoList> {
    const next = change(this.list);
    this.current = next;
    const text = canon(next);
    this.written.push(text);
    if (this.written.length > REMEMBERED) this.written.shift();
    // Write again while the memento reads back something else, so the stored copy is right too.
    for (let attempt = 0; attempt < ATTEMPTS && this.current === next; attempt++) {
      await this.memento.update(KEY, next);
      if (canon(this.memento.get(KEY)) === text) break;
    }
    this.changed.fire(next);
    return next;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
