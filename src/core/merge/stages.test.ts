import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIVE_CONFLICTS_FILE, conflictRepo, createRepo, fiveConflictRepo } from '../../../test/fixtures/repos';
import { getStatus } from '../git/status';
import { buildResult, chunkLines } from './result';
import { deleteFile, describeConflict, listConflicts, loadMerge, parseUnmerged, saveResult, takeSide } from './stages';

describe('parseUnmerged', () => {
  it('groups stages by path and names the kind of conflict', () => {
    const out = [
      '100644 aaa 1\tdir with space/a é.txt', '100644 bbb 2\tdir with space/a é.txt', '100644 ccc 3\tdir with space/a é.txt',
      '100644 ddd 2\tboth.txt', '100644 eee 3\tboth.txt',
      '100644 fff 1\tgone.txt', '100644 ggg 3\tgone.txt',
    ].join('\0') + '\0';
    const files = parseUnmerged(out);
    expect(files).toEqual([
      { path: 'dir with space/a é.txt', base: 'aaa', mine: 'bbb', theirs: 'ccc' },
      { path: 'both.txt', mine: 'ddd', theirs: 'eee' },
      { path: 'gone.txt', base: 'fff', theirs: 'ggg' },
    ]);
    expect(files.map(describeConflict)).toEqual(['both modified', 'both added', 'deleted by us']);
  });
});

describe('conflicts on fixtures', () => {
  it('loads five conflict chunks from a CRLF file and saves the result with CRLF', async () => {
    const f = await fiveConflictRepo();
    try {
      const files = await listConflicts(f.dir);
      expect(files.map((x) => [x.path, describeConflict(x)]).sort()).toEqual([['both.txt', 'both added'], [FIVE_CONFLICTS_FILE, 'both modified']]);
      const file = files.find((x) => x.path === FIVE_CONFLICTS_FILE)!;
      const merge = await loadMerge(f.dir, file);
      if (merge.kind !== 'text') throw new Error('expected a text merge');
      expect(merge.format).toEqual({ encoding: 'utf8', eol: 'crlf', finalNewline: true });
      expect(merge.chunks.filter((c) => c.kind !== 'unchanged').map((c) => c.kind))
        .toEqual(['conflict', 'mine', 'conflict', 'theirs', 'conflict', 'same', 'conflict', 'conflict']);
      expect(merge.mine.some((l) => l.includes('\r'))).toBe(false);

      // Resolve: mine, theirs, mine then theirs, theirs then mine, mine.
      const result = buildResult(merge.chunks, merge, true);
      const choices = ['mine', 'theirs', 'mine-theirs', 'theirs-mine', 'mine'] as const;
      const lines: string[] = [];
      let conflict = 0;
      let at = 0;
      for (const region of result.regions) {
        lines.push(...result.lines.slice(at, region.start));
        const chunk = merge.chunks[region.chunk];
        lines.push(...(chunk.kind === 'conflict' ? chunkLines(chunk, merge, choices[conflict++]) : result.lines.slice(region.start, region.start + region.length)));
        at = region.start + region.length;
      }
      lines.push(...result.lines.slice(at));
      await saveResult(f.dir, file.path, lines, merge.format);

      const saved = readFileSync(path.join(f.dir, file.path), 'utf8');
      const expected = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
      Object.assign(expected, {
        2: 'mine 3', 5: 'mine only 6', 8: 'theirs 9', 11: 'theirs only 12', 14: 'mine 15\r\ntheirs 15',
        17: 'both 18', 20: 'theirs 21\r\nmine 21', 26: 'mine 27',
      });
      expect(saved).toBe(expected.join('\r\n') + '\r\n');
      expect((await listConflicts(f.dir)).map((x) => x.path)).toEqual(['both.txt']);

      // The file added on both sides has no base: only a whole side can be taken.
      const both = files.find((x) => x.path === 'both.txt')!;
      expect(await loadMerge(f.dir, both)).toEqual({ kind: 'whole', reason: 'missing-stage' });
      await takeSide(f.dir, both, 'theirs');
      expect(readFileSync(path.join(f.dir, 'both.txt'), 'utf8')).toBe('theirs\n');
      expect(await listConflicts(f.dir)).toEqual([]);
      expect((await getStatus(f.dir)).conflicted).toBe(0);
    } finally { f.dispose(); }
  });

  it('takes mine, deletes a file, and follows a deletion on the chosen side', async () => {
    const f = await conflictRepo();
    const g = await createRepo('deleted by them');
    try {
      const files = await listConflicts(f.dir);
      await takeSide(f.dir, files.find((x) => x.path === 'crlf.txt')!, 'mine');
      expect(readFileSync(path.join(f.dir, 'crlf.txt'), 'utf8')).toBe('a\r\nMINE\r\nc\r\n');
      await deleteFile(f.dir, 'both.txt');
      expect(existsSync(path.join(f.dir, 'both.txt'))).toBe(false);
      expect(await listConflicts(f.dir)).toEqual([]);

      await g.commit('Base', { 'a.txt': 'base\n' });
      await g.git('switch', '-c', 'theirs');
      await g.git('rm', '-q', 'a.txt');
      await g.commit('Theirs deletes');
      await g.git('switch', 'main');
      await g.commit('Mine edits', { 'a.txt': 'mine\n' });
      await g.git('merge', 'theirs').catch(() => undefined);
      const [file] = await listConflicts(g.dir);
      expect(describeConflict(file)).toBe('deleted by them');
      expect(await loadMerge(g.dir, file)).toEqual({ kind: 'whole', reason: 'missing-stage' });
      await takeSide(g.dir, file, 'theirs');
      expect(existsSync(path.join(g.dir, 'a.txt'))).toBe(false);
      expect((await getStatus(g.dir)).conflicted).toBe(0);
    } finally { f.dispose(); g.dispose(); }
  });

  it('refuses to edit binary and oversized files, and keeps a UTF-16 file in UTF-16', async () => {
    const f = await createRepo('odd files');
    const utf16 = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]).toString('latin1');
    try {
      const big = (tag: string) => `${tag}\n` + 'x'.repeat(80).concat('\n').repeat(30_000);
      const write = (files: Record<string, string>) => { for (const [name, content] of Object.entries(files)) f.write(name, content); };
      // Latin-1 strings carry raw bytes through the fixture's string-based writer.
      const bytes = (content: string) => Buffer.from(content, 'latin1') as unknown as string;
      write({ 'bin.dat': bytes('\x00base'), 'big.txt': big('base'), 'wide.txt': bytes(utf16('one\r\ntwo\r\n')) });
      await f.commit('Base');
      await f.git('switch', '-c', 'theirs');
      write({ 'bin.dat': bytes('\x00theirs'), 'big.txt': big('theirs'), 'wide.txt': bytes(utf16('one\r\nTHEIRS\r\n')) });
      await f.commit('Theirs');
      await f.git('switch', 'main');
      write({ 'bin.dat': bytes('\x00mine'), 'big.txt': big('mine'), 'wide.txt': bytes(utf16('one\r\nMINE\r\n')) });
      await f.commit('Mine');
      await f.git('merge', 'theirs').catch(() => undefined);

      const files = new Map((await listConflicts(f.dir)).map((x) => [x.path, x]));
      expect(await loadMerge(f.dir, files.get('bin.dat')!)).toEqual({ kind: 'whole', reason: 'binary' });
      expect(await loadMerge(f.dir, files.get('big.txt')!)).toEqual({ kind: 'whole', reason: 'too-large' });
      const wide = await loadMerge(f.dir, files.get('wide.txt')!);
      if (wide.kind !== 'text') throw new Error('expected a text merge');
      expect(wide.format).toEqual({ encoding: 'utf16le', eol: 'crlf', finalNewline: true });
      expect([wide.base, wide.mine, wide.theirs]).toEqual([['one', 'two'], ['one', 'MINE'], ['one', 'THEIRS']]);
      await saveResult(f.dir, 'wide.txt', ['one', 'MINE', 'THEIRS'], wide.format);
      expect(readFileSync(path.join(f.dir, 'wide.txt')).equals(Buffer.from(utf16('one\r\nMINE\r\nTHEIRS\r\n'), 'latin1'))).toBe(true);
    } finally { f.dispose(); }
  });
});
