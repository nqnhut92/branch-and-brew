import { describe, expect, it } from 'vitest';
import { linearRepo, mergeRepo } from '../../../test/fixtures/repos';
import { getLog } from './log';
import { blame, changedFiles, getCommitDetail, parseDetail, parseNameStatus, showFile } from './show';

describe('parsers', () => {
  it('reads name-status records, renames included', () => {
    expect(parseNameStatus('M\0a b.txt\0R100\0old é.txt\0new.txt\0D\0gone\0')).toEqual([
      { status: 'M', path: 'a b.txt' },
      { status: 'R', oldPath: 'old é.txt', path: 'new.txt' },
      { status: 'D', path: 'gone' },
    ]);
    expect(parseNameStatus('')).toEqual([]);
  });

  it('keeps a multi-line message whole', () => {
    const out = ['h', 'p1 p2', 'A', 'a@x', '10', 'C', 'c@x', '20', 'Subject\n\nBody line\n\n'].join('\x1f');
    expect(parseDetail(out)).toEqual({
      hash: 'h', parents: ['p1', 'p2'], author: 'A', email: 'a@x', date: 10,
      committer: 'C', committerEmail: 'c@x', commitDate: 20, message: 'Subject\n\nBody line',
    });
  });
});

describe('commit detail on fixtures', () => {
  it('lists the files of a commit, a root commit and a merge', async () => {
    const f = await mergeRepo();
    try {
      const log = await getLog(f.dir);
      const by = (subject: string) => log.find((c) => c.subject === subject)!.hash;
      const merge = await getCommitDetail(f.dir, by('Merge feature'));
      expect(merge.message).toBe('Merge feature');
      expect(merge.parents).toHaveLength(2);
      expect(merge.author).toBe('Fixture');
      expect(merge.files).toEqual([{ status: 'A', path: 'f.txt' }]);
      expect((await getCommitDetail(f.dir, by('Base'))).files).toEqual([{ status: 'A', path: 'a.txt' }]);
      expect((await getCommitDetail(f.dir, by('Main work'))).files).toEqual([{ status: 'A', path: 'm.txt' }]);
    } finally { f.dispose(); }
  });

  it('reads file content at a revision, compares revisions and blames', async () => {
    const f = await linearRepo();
    try {
      const [third, second, first] = await getLog(f.dir);
      expect(await showFile(f.dir, first.hash, 'a.txt')).toBe('one\n');
      expect(await showFile(f.dir, second.hash, 'a.txt')).toBe('one\ntwo\n');
      expect(await showFile(f.dir, third.hash, 'dir with space/b.txt')).toBe('b\n');
      expect(await showFile(f.dir, first.hash, 'missing.txt')).toBe('');
      expect(await changedFiles(f.dir, first.hash, third.hash)).toEqual([
        { status: 'M', path: 'a.txt' }, { status: 'A', path: 'dir with space/b.txt' },
      ]);
      f.write('a.txt', 'changed\n');
      expect(await changedFiles(f.dir, third.hash)).toEqual([{ status: 'M', path: 'a.txt' }]);
      expect(await showFile(f.dir, '', 'a.txt')).toBe('one\ntwo\n');
      const lines = (await blame(f.dir, 'a.txt', third.hash)).trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain(first.hash.slice(0, 7));
      expect(lines[1]).toContain(second.hash.slice(0, 7));
      expect(lines[1]).toContain('Fixture');
    } finally { f.dispose(); }
  });
});
