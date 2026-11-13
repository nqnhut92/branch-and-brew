import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { conflictRepo, linearRepo, mergeRepo, pausedRebaseRepo } from './repos';

describe('fixture repos', () => {
  it('linear: three commits, path with spaces and non-ASCII', async () => {
    const f = await linearRepo();
    try {
      expect(f.dir).toMatch(/ ü$/);
      expect((await f.git('rev-list', '--count', 'HEAD'))).toBe('3');
      expect(await f.git('status', '--porcelain')).toBe('');
    } finally { f.dispose(); }
  });

  it('merge: HEAD is a merge commit', async () => {
    const f = await mergeRepo();
    try {
      expect((await f.git('log', '-1', '--format=%P')).split(' ')).toHaveLength(2);
    } finally { f.dispose(); }
  });

  it('conflict: CRLF conflict and both-added file', async () => {
    const f = await conflictRepo();
    try {
      expect(existsSync(path.join(f.dir, '.git', 'MERGE_HEAD'))).toBe(true);
      const status = await f.git('status', '--porcelain');
      expect(status).toContain('UU crlf.txt');
      expect(status).toContain('AA both.txt');
      expect(readFileSync(path.join(f.dir, 'crlf.txt'), 'utf8')).toContain('\r\n');
    } finally { f.dispose(); }
  });

  it('paused rebase: rebase-merge state on disk', async () => {
    const f = await pausedRebaseRepo();
    try {
      const dir = path.join(f.dir, '.git', 'rebase-merge');
      expect(existsSync(dir)).toBe(true);
      expect(readFileSync(path.join(dir, 'git-rebase-todo'), 'utf8')).toMatch(/pick .* Topic 2/);
    } finally { f.dispose(); }
  });
});
