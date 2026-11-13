import { describe, expect, it } from 'vitest';
import {
  countResult, decideMessage, matchPlan, moveEntry, parseTodo, serializeTodo, squashAll, stripComments, validateTodo,
  type TodoEntry,
} from './todo';

const e = (action: TodoEntry['action'], hash: string, subject = hash): TodoEntry => ({ action, hash, subject });

describe('parseTodo', () => {
  it('reads both line formats, short commands and other lines', () => {
    const todo = [
      'pick 1111111 # New format',
      'pick 2222222 Old format',
      'r 3333333 # Short reword',
      'f 4444444',
      '',
      '# Rebase abc..def onto abc (4 commands)',
      'exec make test',
      'break',
      'fixup -C 5555555 # amend message',
    ].join('\r\n');
    expect(parseTodo(todo)).toEqual([
      { action: 'pick', hash: '1111111', subject: 'New format' },
      { action: 'pick', hash: '2222222', subject: 'Old format' },
      { action: 'reword', hash: '3333333', subject: 'Short reword' },
      { action: 'fixup', hash: '4444444', subject: '' },
      { action: 'other', hash: '', subject: 'exec make test', raw: 'exec make test' },
      { action: 'other', hash: '', subject: 'break', raw: 'break' },
      { action: 'other', hash: '', subject: 'fixup -C 5555555 # amend message', raw: 'fixup -C 5555555 # amend message' },
    ]);
  });

  it('keeps a subject that itself starts with a hash sign', () => {
    expect(parseTodo('pick abcdef1 # #42 fix')[0].subject).toBe('#42 fix');
  });
});

describe('serializeTodo', () => {
  it('round-trips through parseTodo', () => {
    const entries = [e('pick', 'aaaaaaa', 'A'), e('squash', 'bbbbbbb', 'B'), e('drop', 'ccccccc', 'C'),
      { action: 'other' as const, hash: '', subject: 'exec x', raw: 'exec x' }];
    const text = serializeTodo(entries);
    expect(text).toBe('pick aaaaaaa # A\nsquash bbbbbbb # B\ndrop ccccccc # C\nexec x\n');
    expect(parseTodo(text)).toEqual(entries);
  });

  it('writes noop for an empty list', () => {
    expect(serializeTodo([])).toBe('noop\n');
  });
});

describe('validateTodo', () => {
  it('refuses a squash or fixup with nothing before it', () => {
    expect(validateTodo([e('squash', 'a'), e('pick', 'b')])).toMatch(/cannot be squash/);
    expect(validateTodo([e('drop', 'a'), e('fixup', 'b'), e('pick', 'c')])).toMatch(/cannot be fixup/);
    expect(validateTodo([e('pick', 'a'), e('squash', 'b'), e('fixup', 'c')])).toBeUndefined();
  });

  it('allows a leading squash while a rebase is running', () => {
    expect(validateTodo([e('squash', 'a')], true)).toBeUndefined();
    expect(validateTodo([e('drop', 'a')], true)).toBeUndefined();
  });

  it('refuses dropping everything before the start', () => {
    expect(validateTodo([e('drop', 'a'), e('drop', 'b')])).toMatch(/Every commit is dropped/);
    expect(validateTodo([])).toBeUndefined();
  });
});

describe('list operations', () => {
  it('counts commits in and out', () => {
    expect(countResult([e('pick', 'a'), e('squash', 'b'), e('reword', 'c'), e('drop', 'd'), e('edit', 'f'),
      { action: 'other', hash: '', subject: 'break' }])).toEqual({ incoming: 5, outgoing: 3 });
  });

  it('squashes everything kept into the first kept commit', () => {
    expect(squashAll([e('drop', 'a'), e('fixup', 'b'), e('reword', 'c'), e('pick', 'd')]).map((x) => x.action))
      .toEqual(['drop', 'pick', 'squash', 'squash']);
  });

  it('moves a row and ignores impossible moves', () => {
    expect(moveEntry(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveEntry(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    expect(moveEntry(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveEntry(['a', 'b', 'c'], 1, 3)).toEqual(['a', 'b', 'c']);
  });

  it('matches the prepared list with git\'s list by abbreviated hash', () => {
    const planned = [e('reword', 'bbbbbbbbbbbbbbbb'), e('drop', 'aaaaaaaaaaaaaaaa')];
    expect(matchPlan(planned, [e('pick', 'aaaaaaa'), e('pick', 'bbbbbbb')])).toBeUndefined();
    expect(matchPlan(planned, [e('pick', 'aaaaaaa')])).toMatch(/not the ones in the table/);
    expect(matchPlan(planned, [e('pick', 'aaaaaaa'), e('pick', 'bbbbbbb'), e('pick', 'ccccccc')])).toMatch(/not the ones/);
  });
});

describe('decideMessage', () => {
  const messages: Record<string, string> = { r1: 'Reworded', s2: 'Combined' };
  const lookup = (hash: string) => messages[hash];

  it('keeps git\'s message for a pick or an edit', () => {
    expect(decideMessage([e('pick', 'p1')], lookup)).toEqual({ kind: 'keep' });
    expect(decideMessage([], lookup)).toEqual({ kind: 'keep' });
  });

  it('uses the prepared message of a reword, or asks', () => {
    expect(decideMessage([e('pick', 'p1'), e('reword', 'r1')], lookup)).toEqual({ kind: 'use', text: 'Reworded' });
    expect(decideMessage([e('reword', 'r9')], lookup)).toEqual({ kind: 'ask' });
  });

  it('uses the message set on a squash row of the chain, or asks', () => {
    expect(decideMessage([e('pick', 'p1'), e('squash', 's2'), e('fixup', 'f3'), e('squash', 's4')], lookup))
      .toEqual({ kind: 'use', text: 'Combined' });
    expect(decideMessage([e('pick', 'p1'), e('squash', 's2'), e('pick', 'p5'), e('squash', 's6')], lookup)).toEqual({ kind: 'ask' });
  });
});

describe('stripComments', () => {
  it('drops comment lines and extra blank lines', () => {
    const text = '# This is a combination of 2 commits.\n# This is the 1st commit message:\n\nAdd two\n\n# This is the commit message #2:\n\nFix two\n\n# Please enter the commit message\n';
    expect(stripComments(text)).toBe('Add two\n\nFix two');
  });
});
