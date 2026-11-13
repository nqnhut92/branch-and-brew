import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { run } from '../git/runner';
import { ensureAskpassWrapper, startAskpass } from './askpass';
import { removeTempDir } from '../../../test/fixtures/cleanup';

const dir = mkdtempSync(path.join(tmpdir(), 'bab askpass é-'));
afterAll(() => removeTempDir(dir));
const mainScript = path.resolve(__dirname, '../../../scripts/askpass.js');

/** `git credential fill` asks through GIT_ASKPASS when no credential helper has an answer. */
async function fill(env: Record<string, string>) {
  return run(dir, ['-c', 'credential.helper=', 'credential', 'fill'], {
    input: 'protocol=https\nhost=example.invalid\n\n',
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, 'none') },
  });
}

describe('askpass', () => {
  it('writes an executable wrapper', () => {
    const file = ensureAskpassWrapper(dir);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o111).not.toBe(0);
  });

  it('answers git credential prompts through the extension', async () => {
    const prompts: string[] = [];
    const askpass = await startAskpass({
      wrapperPath: ensureAskpassWrapper(dir), mainScript, nodePath: process.execPath,
      onPrompt: async (p) => { prompts.push(p); return p.startsWith('Username') ? 'nick' : 's3cret'; },
    });
    try {
      const r = await fill(askpass.env);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('username=nick');
      expect(r.stdout).toContain('password=s3cret');
      expect(prompts[0]).toMatch(/^Username for 'https:\/\/example.invalid'/);
      expect(prompts[1]).toMatch(/^Password for 'https:\/\/nick@example.invalid'/);
    } finally { await askpass.close(); }
  });

  it('fails the git command when the user cancels', async () => {
    const askpass = await startAskpass({
      wrapperPath: ensureAskpassWrapper(dir), mainScript, nodePath: process.execPath, onPrompt: async () => undefined,
    });
    try {
      const r = await fill(askpass.env);
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).not.toContain('password=');
    } finally { await askpass.close(); }
  });
});
