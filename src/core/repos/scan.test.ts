import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scanForRepos } from './scan';
import { removeTempDir } from '../../../test/fixtures/cleanup';

const root = mkdtempSync(path.join(tmpdir(), 'bab scan é-'));
afterAll(() => removeTempDir(root));
const repo = (p: string, gitFile = false) => {
  const dir = path.join(root, p);
  mkdirSync(dir, { recursive: true });
  if (gitFile) writeFileSync(path.join(dir, '.git'), 'gitdir: elsewhere');
  else mkdirSync(path.join(dir, '.git'));
};

describe('scanForRepos', () => {
  it('finds repos to depth 3, skips node_modules, target and nested repos', async () => {
    repo('a');
    repo('a/nested');
    repo('group/b');
    repo('group/deep/c');
    repo('one/two/three/too-deep');
    repo('node_modules/pkg');
    repo('x/target/gen');
    repo('wt', true);
    const found = (await scanForRepos(root)).map((p) => path.relative(root, p).split(path.sep).join('/'));
    expect(found).toEqual(['a', 'group/b', 'group/deep/c', 'wt']);
  });

  it('returns the root itself when it is a repo', async () => {
    expect(await scanForRepos(path.join(root, 'a'))).toEqual([path.join(root, 'a')]);
  });
});
