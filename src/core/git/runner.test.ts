import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GitCancelledError, GitError, GitTimeoutError, gitEnv, queueKey, run } from './runner';
import { removeTempDir } from '../../../test/fixtures/cleanup';

const tmp = mkdtempSync(path.join(tmpdir(), 'bab-runner-'));
afterAll(() => removeTempDir(tmp));

/**
 * Runs node in place of git. The runner prepends `-C <repo>`, which node reads as `--conditions <repo>`,
 * so the remaining args are ordinary node args.
 */
const fakeGit = (script: string, options: Parameters<typeof run>[2] = {}, repo = tmp) =>
  run(repo, ['-e', script], { gitPath: process.execPath, ...options });

describe('run', () => {
  it('returns stdout and exit code 0', async () => {
    const r = await run(tmp, ['--version']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^git version /);
  });

  it('returns a non-zero exit code instead of throwing', async () => {
    const r = await run(tmp, ['rev-parse', '--git-dir']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/not a git repository/);
  });

  it('passes extra env and always disables the terminal prompt', async () => {
    const r = await fakeGit('process.stdout.write(process.env.FOO + "," + process.env.GIT_TERMINAL_PROMPT)', {
      env: { FOO: 'bar', GIT_TERMINAL_PROMPT: '1' },
    });
    expect(r.stdout).toBe('bar,0');
    expect(gitEnv().GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('writes input to stdin and keeps arguments intact (no shell)', async () => {
    const r = await fakeGit(
      'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d+"|"+process.argv.slice(1).join("|")))',
      { input: 'héllo' },
    );
    expect(r.stdout).toBe('héllo|');
    const tricky = await run(tmp, ['-e', 'process.stdout.write(process.argv[1])', '$(echo hi) & "x"; rm -rf /'], {
      gitPath: process.execPath,
    });
    expect(tricky.stdout).toBe('$(echo hi) & "x"; rm -rf /');
  });

  it('rejects with GitTimeoutError after the timeout', async () => {
    await expect(fakeGit('setTimeout(()=>{},10000)', { timeoutMs: 200 })).rejects.toBeInstanceOf(GitTimeoutError);
  });

  it('rejects with GitCancelledError when aborted', async () => {
    const ac = new AbortController();
    const p = fakeGit('setTimeout(()=>{},10000)', { signal: ac.signal, timeoutMs: 0 });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toBeInstanceOf(GitCancelledError);
    await expect(fakeGit('1', { signal: ac.signal })).rejects.toBeInstanceOf(GitCancelledError);
  });

  it('rejects with GitError when the executable is missing', async () => {
    await expect(run(tmp, ['status'], { gitPath: path.join(tmp, 'no-such-git') })).rejects.toBeInstanceOf(GitError);
  });

  it('runs commands for one repo one at a time, other repos in parallel', async () => {
    const log = path.join(tmp, 'order.log');
    // 'a' stays open until 'c' (another repo) has finished, so the test does not depend on how fast
    // node starts under load; the cap only keeps a broken queue from hanging for long.
    const step = (tag: string, waitForC: boolean) =>
      `const f=require("fs");const L=${JSON.stringify(log)};f.appendFileSync(L,"${tag}+");` +
      `const t=Date.now();const end=()=>f.appendFileSync(L,"${tag}-");` +
      (waitForC
        ? `const w=()=>f.readFileSync(L,"utf8").includes("c-")||Date.now()-t>8000?end():setTimeout(w,10);w()`
        : `setTimeout(end,10)`);
    const other = mkdtempSync(path.join(tmpdir(), 'bab-runner-other-'));
    await Promise.all([fakeGit(step('a', true)), fakeGit(step('b', false)), fakeGit(step('c', false), {}, other)]);
    removeTempDir(other);
    const order = readFileSync(log, 'utf8');
    expect(order.indexOf('a-')).toBeLessThan(order.indexOf('b+'));
    expect(order.indexOf('c-')).toBeLessThan(order.indexOf('a-'));
  });

  it('a failed command does not block the queue', async () => {
    await expect(fakeGit('setTimeout(()=>{},10000)', { timeoutMs: 100 })).rejects.toThrow();
    expect((await fakeGit('process.stdout.write("ok")')).stdout).toBe('ok');
  });
});

describe('queueKey', () => {
  it('folds case on Windows and macOS only', () => {
    expect(queueKey('/A/b', 'win32')).toBe(queueKey('/a/B', 'win32'));
    expect(queueKey('/A/b', 'linux')).not.toBe(queueKey('/a/B', 'linux'));
  });
});
