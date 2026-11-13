import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepo, type Fixture } from '../../../test/fixtures/repos';
import { editorCommand, shPath, shQuote, startEditorBridge, type EditorBridge, type EditorHandler } from './editorBridge';

const scriptsDir = path.resolve(__dirname, '../../../scripts');
let fixture: Fixture | undefined;
let bridge: EditorBridge | undefined;
afterEach(async () => {
  await bridge?.close();
  fixture?.dispose();
  bridge = fixture = undefined;
});

async function fourCommits() {
  const f = await createRepo('bridge');
  for (const n of ['Base', 'One', 'Two', 'Three']) await f.commit(n, { [`${n}.txt`]: `${n}\n` });
  return f;
}

const fail: EditorHandler = async () => { throw new Error('unexpected editor call'); };
const start = (onSequence: EditorHandler, onMessage: EditorHandler = fail) =>
  startEditorBridge({ scriptsDir, nodePath: process.execPath, onSequence, onMessage });
const subjects = async (f: Fixture) => (await f.git('log', '--format=%s')).split('\n');

describe('editor bridge', () => {
  it('drives git rebase -i: reorder, reword and drop through the scripts', async () => {
    fixture = await fourCommits();
    const calls: string[] = [];
    bridge = await start(
      async (todo) => {
        calls.push('sequence');
        const [one, two, three] = todo.split('\n').filter((l) => l.startsWith('pick '));
        return [three.replace(/^pick/, 'reword'), one, two.replace(/^pick/, 'drop'), ''].join('\n');
      },
      async (message) => {
        calls.push('message');
        expect(message.split('\n')[0]).toBe('Three');
        return 'Three, reworded\n';
      },
    );
    const r = await fixture.gitWith(bridge.env, 'rebase', '-i', 'HEAD~3');
    expect(r.stderr).not.toMatch(/error|fatal/i);
    expect(r.exitCode).toBe(0);
    expect(calls).toEqual(['sequence', 'message']);
    expect(await subjects(fixture)).toEqual(['One', 'Three, reworded', 'Base']);
  });

  it('pauses on edit and rewrites the remaining todo with --edit-todo', async () => {
    fixture = await fourCommits();
    bridge = await start(async (todo) => todo.replace(/^pick (\S+ (?:# )?One)$/m, 'edit $1'));
    expect((await fixture.gitWith(bridge.env, 'rebase', '-i', 'HEAD~3')).exitCode).toBe(0);
    expect(await fixture.git('status')).toMatch(/interactive rebase in progress/);

    await bridge.close();
    // --edit-todo reopens the remaining todo through GIT_SEQUENCE_EDITOR; drop "Two" while paused.
    bridge = await start(async (todo) => todo.replace(/^pick (\S+ (?:# )?Two)$/m, 'drop $1'), fail);
    expect((await fixture.gitWith(bridge.env, 'rebase', '--edit-todo')).exitCode).toBe(0);
    expect((await fixture.gitWith(bridge.env, 'rebase', '--continue')).exitCode).toBe(0);
    expect(await subjects(fixture)).toEqual(['Three', 'One', 'Base']);
  });

  it('aborts the rebase when the handler returns null', async () => {
    fixture = await fourCommits();
    const before = await fixture.git('rev-parse', 'HEAD');
    bridge = await start(async () => null);
    const r = await fixture.gitWith(bridge.env, 'rebase', '-i', 'HEAD~3');
    expect(r.exitCode).not.toBe(0);
    expect(await fixture.git('rev-parse', 'HEAD')).toBe(before);
  });

  it('rejects a caller without the token', async () => {
    fixture = await fourCommits();
    bridge = await start(async (t) => t);
    const r = await fixture.gitWith({ ...bridge.env, BAB_BRIDGE_TOKEN: 'wrong' }, 'rebase', '-i', 'HEAD~3');
    expect(r.exitCode).not.toBe(0);
  });
});

describe('shell quoting for git editor commands', () => {
  it('quotes single quotes and spaces', () => {
    expect(shQuote("it's here")).toBe(`'it'\\''s here'`);
  });
  it('uses forward slashes on Windows', () => {
    expect(shPath('C:\\Program Files\\Code\\Code.exe', 'win32')).toBe('C:/Program Files/Code/Code.exe');
    expect(editorCommand('C:\\a b\\node.exe', 'C:\\x\\s.js', 'win32')).toBe(`'C:/a b/node.exe' 'C:/x/s.js'`);
    expect(shPath('/a\\b', 'darwin')).toBe('/a\\b');
  });
});
