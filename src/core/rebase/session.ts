import { git } from '../git/ops';
import { run, type RunResult } from '../git/runner';
import { detectOperation, gitDir } from '../git/status';
import { startEditorBridge, type EditorBridge } from './editorBridge';
import { readRebaseState } from './state';
import {
  decideMessage, matchPlan, parseTodo, sameCommit, serializeTodo, stripComments, type TodoEntry,
} from './todo';

export interface SessionOptions {
  repo: string;
  /** Folder holding the editor scripts. */
  scriptsDir: string;
  /** Node binary that runs them (VS Code's own binary in the extension). */
  nodePath: string;
  /** Extra environment for git. */
  env?: Record<string, string>;
}

export interface PendingMessage {
  /** Commit whose message git is asking for. */
  hash?: string;
  /** Git's proposal, without comment lines. */
  text: string;
}

/**
 * Where a rebase command left things: finished, stopped (conflict, edit, or a refusal whose
 * reason is in `error`), or waiting inside git's message editor for an answer.
 */
export type Outcome =
  | { phase: 'done' }
  | { phase: 'paused'; error?: string }
  | { phase: 'message'; message: PendingMessage };

export interface StartOptions {
  /** Commit or branch to rebase onto; null rebases from the root commit. */
  onto: string | null;
  /** The prepared list. Without it the rebase is not interactive. */
  entries?: readonly TodoEntry[];
  /** Stash uncommitted changes first; git puts them back when the rebase ends. */
  autostash?: boolean;
}

type Settled = { kind: 'exit'; result: RunResult } | { kind: 'message'; message: PendingMessage };

/** Commits `git rebase -i <onto>` would list, oldest first; `onto` null means from the root. */
export async function listRebaseCommits(repo: string, onto: string | null): Promise<TodoEntry[]> {
  const range = onto === null ? ['HEAD'] : ['--right-only', '--cherry-pick', `${onto}...HEAD`];
  const out = await git(repo, ['log', '--reverse', '--topo-order', '--no-merges', '--format=%H%x1f%s%x1e', ...range, '--'], { noQueue: true });
  return out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((record) => {
    const [hash, subject] = record.split('\x1f');
    return { action: 'pick' as const, hash, subject: subject ?? '' };
  });
}

export interface StartCheck {
  /** Tracked files have uncommitted changes; git refuses to rebase without a stash. */
  dirty: boolean;
  /** Remote branches that already contain the oldest commit to rebase. */
  publishedOn: string[];
}

/** What to tell the user before a rebase starts. */
export async function checkRebaseStart(repo: string, oldestHash?: string): Promise<StartCheck> {
  const status = await git(repo, ['status', '--porcelain', '--untracked-files=no'], { noQueue: true });
  const remote = oldestHash
    ? await git(repo, ['branch', '-r', '--format=%(refname:short)', '--contains', oldestHash], { noQueue: true })
    : '';
  return {
    dirty: status.trim().length > 0,
    publishedOn: remote.split('\n').map((l) => l.trim()).filter((l) => l && !l.endsWith('/HEAD')),
  };
}

/**
 * Drives one rebase in one repository through git's editor hooks: the sequence editor writes the
 * prepared todo list, the message editor answers from the prepared messages or waits for the
 * user. Every command resolves when git exits or when it starts waiting for a message.
 */
export class RebaseSession {
  private bridge?: Promise<EditorBridge>;
  /** What the sequence editor writes the next time git opens it. */
  private nextTodo?: string;
  /** Set for the start of a rebase: git's own list must hold the same commits. */
  private expected?: readonly TodoEntry[];
  private sequenceError?: string;
  private readonly messages = new Map<string, string>();
  private waiting?: { message: PendingMessage; resolve(text: string | null): void };
  private settle?: (s: Settled) => void;

  constructor(private readonly options: SessionOptions) {}

  /** The message git is waiting for, if any. */
  get pendingMessage(): PendingMessage | undefined {
    return this.waiting?.message;
  }

  /** The message prepared for a commit, if any. */
  messageFor(hash: string): string | undefined {
    for (const [key, text] of this.messages) if (sameCommit(key, hash)) return text;
    return undefined;
  }

  /** Remembers the messages typed in the table. */
  setMessages(entries: readonly TodoEntry[]): void {
    for (const e of entries) {
      if (e.action === 'other') continue;
      for (const key of [...this.messages.keys()]) if (sameCommit(key, e.hash)) this.messages.delete(key);
      if (e.message?.trim() && (e.action === 'reword' || e.action === 'squash')) this.messages.set(e.hash, e.message);
    }
  }

  private ensureBridge(): Promise<EditorBridge> {
    this.bridge ??= startEditorBridge({
      scriptsDir: this.options.scriptsDir,
      nodePath: this.options.nodePath,
      onSequence: async (content) => {
        if (this.nextTodo === undefined) return content;
        if (this.expected) {
          this.sequenceError = matchPlan(this.expected, parseTodo(content));
          if (this.sequenceError) return null;
        }
        const todo = this.nextTodo;
        this.nextTodo = undefined;
        return todo;
      },
      onMessage: async (content) => {
        const state = readRebaseState(await gitDir(this.options.repo));
        const decision = decideMessage(state?.done ?? [], (hash) => this.messageFor(hash));
        if (decision.kind === 'keep') return content;
        if (decision.kind === 'use') return decision.text.replace(/\s*$/, '\n');
        const current = state?.done[state.done.length - 1];
        const message: PendingMessage = { hash: current?.hash, text: stripComments(content) };
        return new Promise<string | null>((resolve) => {
          this.waiting = { message, resolve };
          this.fire({ kind: 'message', message });
        });
      },
    });
    return this.bridge;
  }

  private fire(s: Settled): void {
    const settle = this.settle;
    this.settle = undefined;
    settle?.(s);
  }

  private nextSettled(): Promise<Settled> {
    return new Promise((resolve) => { this.settle = resolve; });
  }

  /** Runs a rebase command with the editor bridge; no timeout, it may wait for the user. */
  private async runGit(args: string[]): Promise<Settled> {
    const bridge = await this.ensureBridge();
    const settled = this.nextSettled();
    run(this.options.repo, args, { env: { ...this.options.env, ...bridge.env }, timeoutMs: 0 }).then(
      (result) => this.fire({ kind: 'exit', result }),
      (e: Error) => this.fire({ kind: 'exit', result: { exitCode: -1, stdout: '', stderr: e.message } }),
    );
    return settled;
  }

  private async outcome(settled: Settled): Promise<Outcome> {
    if (settled.kind === 'message') return { phase: 'message', message: settled.message };
    const { result } = settled;
    const error = result.exitCode === 0 ? undefined : this.sequenceError ?? ((result.stderr || result.stdout).trim() || 'git rebase failed');
    this.sequenceError = undefined;
    this.nextTodo = undefined;
    this.expected = undefined;
    if (detectOperation(await gitDir(this.options.repo)) === 'rebase') return { phase: 'paused', error };
    if (error) throw new Error(error);
    return { phase: 'done' };
  }

  async start(options: StartOptions): Promise<Outcome> {
    const args = ['rebase'];
    if (options.entries) {
      args.push('-i');
      this.nextTodo = serializeTodo(options.entries);
      this.expected = options.entries;
      this.setMessages(options.entries);
    }
    if (options.autostash) args.push('--autostash');
    args.push(options.onto === null ? '--root' : options.onto);
    return this.outcome(await this.runGit(args));
  }

  /** Rewrites the remaining todo list of the paused rebase (`git rebase --edit-todo`). */
  async editTodo(entries: readonly TodoEntry[]): Promise<void> {
    this.nextTodo = serializeTodo(entries);
    this.expected = undefined;
    this.setMessages(entries);
    const settled = await this.runGit(['rebase', '--edit-todo']);
    this.nextTodo = undefined;
    if (settled.kind === 'exit' && settled.result.exitCode !== 0) {
      throw new Error((settled.result.stderr || settled.result.stdout).trim() || 'git rebase --edit-todo failed');
    }
  }

  /** Continues; `entries`, when given, replaces the remaining todo list first. */
  async continue(entries?: readonly TodoEntry[]): Promise<Outcome> {
    if (entries) await this.editTodo(entries);
    return this.outcome(await this.runGit(['rebase', '--continue']));
  }

  async skip(entries?: readonly TodoEntry[]): Promise<Outcome> {
    if (entries) await this.editTodo(entries);
    return this.outcome(await this.runGit(['rebase', '--skip']));
  }

  /** Answers the message git is waiting for; null makes git stop there instead. */
  async answerMessage(text: string | null): Promise<Outcome> {
    const waiting = this.waiting;
    if (!waiting) throw new Error('git is not waiting for a message');
    this.waiting = undefined;
    const settled = this.nextSettled();
    waiting.resolve(text === null ? null : text.replace(/\s*$/, '\n'));
    return this.outcome(await settled);
  }

  async abort(): Promise<void> {
    // Git is still running while it waits for a message; make it stop before aborting.
    if (this.waiting) await this.answerMessage(null).catch(() => undefined);
    if (detectOperation(await gitDir(this.options.repo)) !== 'rebase') return;
    await git(this.options.repo, ['rebase', '--abort'], { env: this.options.env });
  }

  async dispose(): Promise<void> {
    this.waiting?.resolve(null);
    this.waiting = undefined;
    const bridge = this.bridge;
    this.bridge = undefined;
    if (bridge) await (await bridge).close();
  }
}
