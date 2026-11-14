/** Messages between the extension host and webviews. Every webview message has a `type`. */

// ---- Request and response with ids, used by the React webviews -------------------------------

/** A webview asks the host to run `method`; the host answers with a response of the same id. */
export interface RpcRequest {
  kind: 'request';
  id: number;
  method: string;
  params: unknown;
}

export interface RpcResponse {
  kind: 'response';
  id: number;
  result?: unknown;
  /** Set instead of `result` when the method failed; already shown to the user by the host. */
  error?: string;
}

// ---- Log panel --------------------------------------------------------------------------------

import type { WorkingChange } from '../core/git/changes';
import type { LaneRow } from '../core/git/lanes';
import type { Commit } from '../core/git/log';
import type { BranchInfo } from '../core/git/refs';
import type { CommitDetail, FileChange } from '../core/git/show';

export type { BranchInfo, Commit, CommitDetail, FileChange, LaneRow, WorkingChange };

export interface LogInit {
  /** Folder name of the repository. */
  name: string;
  branches: BranchInfo[];
  /** Branches shown before the user picks any. */
  scope: string[];
  maxScope: number;
  /** Set when the panel shows the history of one file. */
  path?: string;
}

export interface LogPage {
  commits: Commit[];
  /** Graph rows for `commits`; null when the list is filtered (search, file history). */
  rows: LaneRow[] | null;
  /** No more commits after this page. */
  done: boolean;
  /** Working tree entries, sent with the first page only. */
  changes?: WorkingChange[];
  /** Set when the graph is being carried from page to page. */
  graph: 'carried' | 'first' | 'none';
}

export type CommitAction =
  | 'checkout' | 'branch' | 'tag' | 'cherryPick' | 'revert'
  | 'compareWorkingTree' | 'comparePrevious' | 'copyHash' | 'copyMessage' | 'reset'
  | 'rebaseOnto' | 'rebaseInteractive';

export type BranchAction = 'switch' | 'merge' | 'rebase' | 'delete';

export type FileAction =
  | 'diff' | 'open' | 'stage' | 'unstage' | 'discard' | 'history' | 'blame'
  /** Conflicted files only. */
  | 'resolve' | 'takeMine' | 'takeTheirs';

export interface FileActionParams {
  action: FileAction;
  /** Commit the file list belongs to, or null for the working tree. */
  hash: string | null;
  path: string;
  oldPath?: string;
  /** The working tree entry, required for discard. */
  change?: WorkingChange;
}

/** Methods of the log panel: per method name, its parameters and its result. */
export interface LogMethods {
  init: { params: null; result: LogInit };
  page: { params: { scope: string[]; skip: number; search?: string }; result: LogPage };
  branches: { params: null; result: BranchInfo[] };
  detail: { params: { hash: string }; result: CommitDetail };
  changes: { params: null; result: WorkingChange[] };
  /** Both answer true when the repository may have changed and the log should reload. */
  commitAction: { params: { action: CommitAction; hash: string }; result: boolean };
  branchAction: { params: { action: BranchAction; branch: string }; result: boolean };
  fileAction: { params: FileActionParams; result: boolean };
  /** Drops the carried graph so the next page starts fresh, e.g. after a search that hid it. */
  resetGraph: { params: null; result: null };
}

/** Sent by the log webview after it has drawn a page; the integration tests read it. */
export interface LogRendered {
  kind: 'event';
  event: 'rendered';
  /** Commits loaded so far. */
  commits: number;
  /** Row elements actually in the DOM (the table is virtualised). */
  domRows: number;
  /** Lane of each of the first rows, as drawn. */
  lanes: number[];
  uncommitted: number;
  /** Text of the toolbar's graph marker, e.g. "Graph on" (the tests read it). */
  graph?: string;
  errors: string[];
}

/** Sent by the host when the repository changed outside the panel. */
export interface LogChanged {
  kind: 'event';
  event: 'changed';
}

export interface LogGraphReset {
  kind: 'event';
  event: 'graphReset';
}
export type LogWebviewToHost = RpcRequest | LogRendered;
export type LogHostToWebview = RpcResponse | LogChanged | LogGraphReset;

// ---- Merge panel ------------------------------------------------------------------------------

import type { Chunk } from '../core/merge/diff3';

export type { Chunk };

export interface MergeInit {
  /** Path of the conflicted file, relative to the repository. */
  path: string;
  /** Column titles; they differ between a merge and a rebase. */
  labels: { mine: string; theirs: string };
  base: string[];
  mine: string[];
  theirs: string[];
  chunks: Chunk[];
  /** Start with every non-conflicting change already in the result. */
  applyNonConflicting: boolean;
}

export interface MergeMethods {
  init: { params: null; result: MergeInit };
  /** Writes the result and stages the file. False when the user cancelled. */
  save: { params: { lines: string[]; unresolved: number }; result: boolean };
  /** Aborts git merge and closes the panel. */
  abort: { params: null; result: boolean };
}

/** Sent by the merge webview after every change; the integration tests read it. */
export interface MergeState {
  kind: 'event';
  event: 'state';
  editors: number;
  /** Conflicting chunks not resolved yet. */
  unresolved: number;
  /** Non-conflicting changes not applied yet. */
  pendingAutomatic: number;
  conflicts: number;
  /** Monaco base theme in use. */
  theme: string;
  errors: string[];
}

/** Sent by the host to drive the view: what the gutter and toolbar buttons do. */
export interface MergePerform {
  kind: 'event';
  event: 'perform';
  action: 'accept' | 'ignore' | 'applyNonConflicting' | 'save';
  side?: 'mine' | 'theirs';
  /** Which conflict, counted from 0 among the conflicting chunks. */
  conflict?: number;
}

export type MergeWebviewToHost = RpcRequest | MergeState;
export type MergeHostToWebview = RpcResponse | MergePerform;

// ---- Rebase panel -----------------------------------------------------------------------------

import type { PauseKind } from '../core/rebase/state';
import type { TodoAction, TodoEntry } from '../core/rebase/todo';

export type { PauseKind, TodoAction, TodoEntry };

/**
 * plan: the table before the rebase starts. paused: git stopped and waits for Continue.
 * message: git is waiting for a commit message. done: no rebase is running any more.
 */
export type RebasePhase = 'plan' | 'paused' | 'message' | 'done';

export interface RebaseView {
  /** Folder name of the repository. */
  name: string;
  /** Branch being rebased; undefined for a detached HEAD. */
  branch?: string;
  /** What it goes onto, as shown to the user. */
  onto: string;
  phase: RebasePhase;
  /** Commands already run (read-only rows). */
  done: TodoEntry[];
  /** The editable rows: the whole plan, or what remains of a running rebase. */
  rows: TodoEntry[];
  step: number;
  total: number;
  pause?: { kind: PauseKind; hash?: string; conflicts: number };
  /** The message git is waiting for (phase `message`). */
  pendingMessage?: { hash?: string; text: string };
  /** Shown above the table, e.g. why Continue was refused. */
  notice?: string;
}

export interface RebaseMethods {
  init: { params: null; result: RebaseView };
  state: { params: null; result: RebaseView };
  detail: { params: { hash: string }; result: CommitDetail };
  start: { params: { rows: TodoEntry[] }; result: RebaseView };
  /** `rows` replaces the remaining list; `message` answers the message git waits for. */
  continue: { params: { rows: TodoEntry[]; message?: string }; result: RebaseView };
  skip: { params: { rows: TodoEntry[] }; result: RebaseView };
  abort: { params: null; result: RebaseView };
  /** Opens the list of conflicted files. */
  resolve: { params: null; result: null };
  diff: { params: { hash: string; path: string; oldPath?: string }; result: null };
}

/** Sent by the rebase webview after every change; the integration tests read it. */
export interface RebaseState {
  kind: 'event';
  event: 'state';
  phase: RebasePhase;
  /** A request to the host is running. */
  busy: boolean;
  rows: { action: TodoEntry['action']; subject: string }[];
  done: number;
  incoming: number;
  outgoing: number;
  /** Why the list cannot run, if it cannot. */
  problem?: string;
  pause?: PauseKind;
  /** Text of the message box while git waits for a message. */
  pendingMessage?: string;
  errors: string[];
}

/** Sent by the host to drive the view: what its buttons and controls do. */
export interface RebasePerform {
  kind: 'event';
  event: 'perform';
  action: 'setAction' | 'move' | 'setMessage' | 'squashAll' | 'reset' | 'start' | 'continue' | 'skip';
  /** Row, counted from 0 among the editable rows. Without it, setMessage fills the pending message. */
  index?: number;
  /** New position for `move`. */
  to?: number;
  value?: string;
}

/** Sent by the host when the repository changed outside the panel. */
export interface RebaseChanged {
  kind: 'event';
  event: 'changed';
}

export type RebaseWebviewToHost = RpcRequest | RebaseState;
export type RebaseHostToWebview = RpcResponse | RebasePerform | RebaseChanged;

// ---- Brewing Progress Dialog (TortoiseGit style) -------------------------------------------

export interface BrewingInit {
  title: string;
  repoName: string;
  command: string;
  initialLines?: string[];
  status: 'brewing' | 'success' | 'error';
}

export interface BrewingMethods {
  init: { params: null; result: BrewingInit };
  close: { params: null; result: void };
}

export interface BrewingOutputEvent {
  kind: 'event';
  event: 'output';
  chunk: string;
}

export interface BrewingStatusEvent {
  kind: 'event';
  event: 'status';
  status: 'brewing' | 'success' | 'error';
  exitCode?: number;
  error?: string;
}

export type BrewingHostToWebview = RpcResponse | BrewingOutputEvent | BrewingStatusEvent;
export type BrewingWebviewToHost = RpcRequest;

