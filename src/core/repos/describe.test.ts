import { describe, expect, it } from 'vitest';
import type { RepoStatus } from '../git/status';
import { describeStatus, rowState, summarizePull } from './describe';

const base: RepoStatus = { branch: 'main', oid: 'abcdef1234', ahead: 0, behind: 0, changed: 0, conflicted: 0 };

describe('describeStatus', () => {
  it('covers the common cases', () => {
    expect(describeStatus(base)).toBe('main · up to date');
    expect(describeStatus({ ...base, ahead: 1, behind: 2, changed: 3 })).toBe('main ↑1 ↓2 · 3 changed');
    expect(describeStatus({ ...base, behind: 2 })).toBe('main ↓2');
    expect(describeStatus({ ...base, branch: undefined, operation: 'rebase', changed: 1, conflicted: 1 }))
      .toBe('detached abcdef1 · rebasing · 1 conflict');
    expect(describeStatus({ ...base, oid: undefined })).toBe('main · up to date');
    expect(describeStatus({ ...base, branch: undefined, oid: undefined })).toBe('no commits · up to date');
  });

  it('maps to a row state', () => {
    expect(rowState(base)).toBe('clean');
    expect(rowState({ ...base, behind: 1 })).toBe('changed');
    expect(rowState({ ...base, operation: 'merge' })).toBe('operation');
    expect(rowState({ ...base, operation: 'merge', conflicted: 1, changed: 1 })).toBe('conflict');
    expect(rowState(undefined, 'boom')).toBe('error');
  });
});

describe('summarizePull', () => {
  it('names conflicts and failures with the git error line', () => {
    const text = summarizePull([
      { repo: '/r/a', result: 'ok' },
      { repo: '/r/b', result: 'conflict' },
      { repo: '/r/c', result: 'failed', message: 'hint: something\nfatal: Could not read from remote repository.\nmore' },
    ], (r) => r.split('/').pop()!);
    expect(text).toBe('Pulled 1 of 3 repositories. Conflict: b. Failed: c (Could not read from remote repository.).');
  });
});
