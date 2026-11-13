import { execFile } from 'node:child_process';
import * as path from 'node:path';

export interface RunOptions {
  /** Extra environment variables, merged over the process environment. */
  env?: Record<string, string | undefined>;
  /** Kill git and reject after this many milliseconds. 0 disables. Default 60 s. */
  timeoutMs?: number;
  /** Cancels the command; the promise rejects with a GitCancelledError. */
  signal?: AbortSignal;
  /** Data written to git's stdin. */
  input?: string;
  /** Path to the git executable. Default "git" from PATH. */
  gitPath?: string;
  /** Skip the per-repo queue (read-only commands that may run in parallel). */
  noQueue?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitError extends Error {
  constructor(message: string, readonly args: readonly string[], readonly stderr = '') {
    super(message);
    this.name = 'GitError';
  }
}
export class GitTimeoutError extends GitError {
  override name = 'GitTimeoutError';
}
export class GitCancelledError extends GitError {
  override name = 'GitCancelledError';
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 512 * 1024 * 1024;

/** Tail of the promise chain per repository, so commands in one repo run one at a time. */
const queues = new Map<string, Promise<unknown>>();

export function queueKey(repoPath: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(repoPath);
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/**
 * Runs `git -C repoPath ...args` without a shell. A non-zero exit code is returned, not thrown;
 * failures to run at all, timeouts and cancellation reject.
 */
export function run(repoPath: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  if (options.noQueue) return spawnGit(repoPath, args, options);
  const key = queueKey(repoPath);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => spawnGit(repoPath, args, options));
  queues.set(key, next);
  const cleanup = () => {
    if (queues.get(key) === next) queues.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

/** Environment for every git call: never prompt on a hidden terminal, stable English messages. */
export function gitEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: 'C', ...extra, GIT_TERMINAL_PROMPT: '0' };
}

interface RawResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

function spawnGit(repoPath: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  return spawnRaw(repoPath, args, options).then((r) => ({ ...r, stdout: r.stdout.toString('utf8') }));
}

/**
 * Like `run`, but stdout comes back as bytes: for file content whose encoding must survive.
 * Never queued, so use it for read-only commands only.
 */
export function runBytes(repoPath: string, args: readonly string[], options: RunOptions = {}): Promise<RawResult> {
  return spawnRaw(repoPath, args, options);
}

function spawnRaw(repoPath: string, args: readonly string[], options: RunOptions): Promise<RawResult> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(new GitCancelledError('git command cancelled', args));

  return new Promise<RawResult>((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = execFile(
      options.gitPath ?? 'git',
      ['-C', repoPath, ...args],
      {
        env: gitEnv(options.env),
        encoding: 'buffer',
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        signal,
        timeout: timeoutMs > 0 ? timeoutMs : undefined,
        killSignal: 'SIGKILL',
      },
      (error, stdoutBuf, stderrBuf) => {
        const stdout = stdoutBuf;
        const stderr = stderrBuf.toString('utf8');
        if (!error) return resolve({ stdout, stderr, exitCode: 0 });
        const err = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
        if (err.name === 'AbortError') return reject(new GitCancelledError('git command cancelled', args, stderr));
        if (err.killed) return reject(new GitTimeoutError(`git timed out after ${timeoutMs} ms`, args, stderr));
        if (typeof err.code === 'number') return resolve({ stdout, stderr, exitCode: err.code });
        reject(new GitError(`could not run git: ${err.message}`, args, stderr));
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}
