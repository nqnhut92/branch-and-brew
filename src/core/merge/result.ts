import { slice, type Chunk } from './diff3';

export interface Sides {
  base: readonly string[];
  mine: readonly string[];
  theirs: readonly string[];
}

/** What a chunk's place in the result holds. */
export type Choice = 'base' | 'mine' | 'theirs' | 'mine-theirs' | 'theirs-mine';

/** The lines a chunk contributes to the result for a choice. */
export function chunkLines(chunk: Chunk, sides: Sides, choice: Choice): string[] {
  const mine = slice(sides.mine, chunk.mine);
  const theirs = slice(sides.theirs, chunk.theirs);
  switch (choice) {
    case 'base': return slice(sides.base, chunk.base);
    case 'mine': return mine;
    case 'theirs': return theirs;
    case 'mine-theirs': return [...mine, ...theirs];
    case 'theirs-mine': return [...theirs, ...mine];
  }
}

/** Where a changed chunk sits in the result, and what was put there. */
export interface ResultRegion {
  /** Index into the chunk list. */
  chunk: number;
  start: number;
  length: number;
  choice: Choice;
}

export interface MergeResult {
  lines: string[];
  /** One region per changed chunk, in order. Unchanged chunks have none. */
  regions: ResultRegion[];
}

/** A chunk that merges without a decision: changed on one side only, or the same on both. */
export const isAutomatic = (chunk: Chunk) => chunk.kind === 'mine' || chunk.kind === 'theirs' || chunk.kind === 'same';

/** The side an automatic chunk takes its lines from. */
export const automaticChoice = (chunk: Chunk): Choice => (chunk.kind === 'theirs' ? 'theirs' : 'mine');

/**
 * The starting result: base, with every non-conflicting change already applied when
 * `applyNonConflicting` is set. Conflicts start as their base lines.
 */
export function buildResult(chunks: readonly Chunk[], sides: Sides, applyNonConflicting: boolean): MergeResult {
  const lines: string[] = [];
  const regions: ResultRegion[] = [];
  chunks.forEach((chunk, index) => {
    const choice: Choice = applyNonConflicting && isAutomatic(chunk) ? automaticChoice(chunk) : 'base';
    const content = chunkLines(chunk, sides, chunk.kind === 'unchanged' ? 'base' : choice);
    if (chunk.kind !== 'unchanged') regions.push({ chunk: index, start: lines.length, length: content.length, choice });
    lines.push(...content);
  });
  return { lines, regions };
}
