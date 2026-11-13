import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { run, type RunResult } from '../../src/core/git/runner';
import { removeTempDir } from './cleanup';

/**
 * Builds throwaway git repositories in a temp folder for tests. Folder names contain a space and
 * non-ASCII characters on purpose. Identity, dates and the default branch are fixed so hashes are
 * stable across machines.
 */
export interface Fixture {
  dir: string;
  git(...args: string[]): Promise<string>;
  /** Runs git with extra environment variables; returns the full result without throwing. */
  gitWith(env: Record<string, string>, ...args: string[]): Promise<RunResult>;
  write(file: string, content: string): void;
  commit(message: string, files?: Record<string, string>): Promise<string>;
  dispose(): void;
}

let clock = 0;

export async function createRepo(name = 'repo'): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), 'bab fixture é-'));
  const dir = path.join(root, `${name} ü`);
  mkdirSync(dir);

  const gitWith = (extra: Record<string, string>, ...args: string[]) => {
    const when = `${1_700_000_000 + clock++ * 60} +0000`;
    return run(dir, ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], {
      env: {
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_DATE: when,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'),
        GIT_EDITOR: 'true',
        ...extra,
      },
    });
  };
  const git = async (...args: string[]) => {
    const r = await gitWith({}, ...args);
    if (r.exitCode !== 0) throw Object.assign(new Error(`git ${args.join(' ')} failed: ${r.stderr}`), { result: r });
    return r.stdout.trim();
  };
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  };
  const commit = async (message: string, files: Record<string, string> = {}) => {
    for (const [f, c] of Object.entries(files)) write(f, c);
    await git('add', '-A');
    await git('commit', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };

  writeFileSync(path.join(root, 'empty-gitconfig'), '');
  await git('init', '-b', 'main');
  // Commands run outside this helper (product code under test) need an identity too; CI runners
  // have none, and git on Windows cannot guess an email from the host name.
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  // Product code runs git without this helper's -c flags; Windows runners set core.autocrlf=true
  // globally, which would rewrite line endings on checkout and restore.
  await git('config', 'core.autocrlf', 'false');
  return { dir, git, gitWith, write, commit, dispose: () => removeTempDir(root) };
}

/** main: three commits in a line. */
export async function linearRepo(): Promise<Fixture> {
  const f = await createRepo('linear');
  await f.commit('First', { 'a.txt': 'one\n' });
  await f.commit('Second', { 'a.txt': 'one\ntwo\n' });
  await f.commit('Third', { 'dir with space/b.txt': 'b\n' });
  return f;
}

/** main with a feature branch merged back by a merge commit. */
export async function mergeRepo(): Promise<Fixture> {
  const f = await createRepo('merge');
  await f.commit('Base', { 'a.txt': 'base\n' });
  await f.git('switch', '-c', 'feature');
  await f.commit('Feature work', { 'f.txt': 'feature\n' });
  await f.git('switch', 'main');
  await f.commit('Main work', { 'm.txt': 'main\n' });
  await f.git('merge', '--no-ff', '-m', 'Merge feature', 'feature');
  return f;
}

/** A merge stopped on conflicts: one CRLF text conflict and one file added on both sides. */
export async function conflictRepo(): Promise<Fixture> {
  const f = await createRepo('conflict');
  await f.commit('Base', { 'crlf.txt': 'a\r\nb\r\nc\r\n' });
  await f.git('switch', '-c', 'theirs');
  await f.commit('Theirs', { 'crlf.txt': 'a\r\nTHEIRS\r\nc\r\n', 'both.txt': 'theirs\n' });
  await f.git('switch', 'main');
  await f.commit('Mine', { 'crlf.txt': 'a\r\nMINE\r\nc\r\n', 'both.txt': 'mine\n' });
  await f.git('merge', 'theirs').then(
    () => { throw new Error('expected a conflict'); },
    () => undefined,
  );
  return f;
}

/** A rebase of `topic` onto `main` paused on a conflict in its first commit. */
export async function pausedRebaseRepo(): Promise<Fixture> {
  const f = await createRepo('rebase');
  await f.commit('Base', { 'a.txt': 'base\n' });
  await f.git('switch', '-c', 'topic');
  await f.commit('Topic 1', { 'a.txt': 'topic\n' });
  await f.commit('Topic 2', { 't.txt': 't\n' });
  await f.git('switch', 'main');
  await f.commit('Main change', { 'a.txt': 'main\n' });
  await f.git('switch', 'topic');
  await f.git('rebase', 'main').then(
    () => { throw new Error('expected the rebase to stop'); },
    () => undefined,
  );
  return f;
}

/**
 * main with `count` commits and a merged side branch every 50 commits, written with
 * `git fast-import` so tens of thousands of commits take a second or two. No files.
 */
export async function bigRepo(count: number): Promise<Fixture> {
  const f = await createRepo('big');
  const who = 'Fixture <fixture@example.invalid>';
  const lines: string[] = [];
  let mark = 0;
  const commit = (ref: string, message: string, from?: number, merge?: number) => {
    mark++;
    const when = `${1_600_000_000 + mark * 60} +0000`;
    lines.push(`commit ${ref}`, `mark :${mark}`, `author ${who} ${when}`, `committer ${who} ${when}`,
      `data ${Buffer.byteLength(message)}`, message);
    if (from) lines.push(`from :${from}`);
    if (merge) lines.push(`merge :${merge}`);
    return mark;
  };
  let tip = commit('refs/heads/main', 'Commit 1');
  while (mark < count) {
    if (mark % 50 === 0) {
      const n = mark;
      const side = commit('refs/heads/side', `Side work ${n}`, tip);
      tip = commit('refs/heads/main', `Main work ${n}`, tip);
      tip = commit('refs/heads/main', `Merge side ${n}`, tip, side);
    } else tip = commit('refs/heads/main', `Commit ${mark + 1}`, tip);
  }
  const r = await run(f.dir, ['fast-import', '--quiet'], { input: lines.join('\n') + '\n', timeoutMs: 120_000 });
  if (r.exitCode !== 0) throw new Error(`git fast-import failed: ${r.stderr}`);
  return f;
}

export const FIVE_CONFLICTS_FILE = 'src dir/crlf é.txt';

/**
 * A merge stopped on conflicts in one CRLF file with five conflicting chunks, plus one change on
 * each side alone, one change made identically on both sides, and a file added on both sides.
 * Lines 3, 9, 15, 21 and 27 conflict; mine alone changed 6, theirs alone 12, both changed 18.
 */
export async function fiveConflictRepo(): Promise<Fixture> {
  const f = await createRepo('five conflicts');
  const text = (change: (n: number) => string | undefined) =>
    Array.from({ length: 30 }, (_, i) => change(i + 1) ?? `line ${i + 1}`).join('\r\n') + '\r\n';
  const conflicts = [3, 9, 15, 21, 27];
  await f.commit('Base', { [FIVE_CONFLICTS_FILE]: text(() => undefined) });
  await f.git('switch', '-c', 'theirs');
  await f.commit('Theirs', {
    [FIVE_CONFLICTS_FILE]: text((n) => (conflicts.includes(n) ? `theirs ${n}` : n === 12 ? 'theirs only 12' : n === 18 ? 'both 18' : undefined)),
    'both.txt': 'theirs\n',
  });
  await f.git('switch', 'main');
  await f.commit('Mine', {
    [FIVE_CONFLICTS_FILE]: text((n) => (conflicts.includes(n) ? `mine ${n}` : n === 6 ? 'mine only 6' : n === 18 ? 'both 18' : undefined)),
    'both.txt': 'mine\n',
  });
  await f.git('merge', 'theirs').then(
    () => { throw new Error('expected a conflict'); },
    () => undefined,
  );
  return f;
}

/**
 * `topic` with six commits on top of Base, and `main` one commit ahead that conflicts with
 * "Change a". Made for one interactive rebase of topic onto main that reorders, squashes
 * ("Fix two" into "Add two"), rewords ("Add fvie"), drops ("Debug junk") and stops on a conflict.
 */
export async function interactiveRebaseRepo(): Promise<Fixture> {
  const f = await createRepo('interactive rebase');
  await f.commit('Base', { 'a.txt': 'base\n' });
  await f.git('switch', '-c', 'topic');
  await f.commit('Add one', { 'one.txt': 'one\n' });
  await f.commit('Add two', { 'two.txt': 'two\n' });
  await f.commit('Fix two', { 'two.txt': 'two, fixed\n' });
  await f.commit('Change a', { 'a.txt': 'topic\n' });
  await f.commit('Add fvie', { 'dir with space/five é.txt': 'five\r\n' });
  await f.commit('Debug junk', { 'junk.txt': 'junk\n' });
  await f.git('switch', 'main');
  await f.commit('Main change', { 'a.txt': 'main\n' });
  await f.git('switch', 'topic');
  return f;
}
