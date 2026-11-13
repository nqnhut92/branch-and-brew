import type { Chunk, ChunkKind } from './diff3';
import { automaticChoice, isAutomatic, type Choice } from './result';

export type Side = 'mine' | 'theirs';

/** What the user has done with one changed chunk. */
export interface ChunkSession {
  /** Index into the chunk list. */
  chunk: number;
  kind: ChunkKind;
  /** Sides accepted into the result, in the order they were accepted. */
  taken: Side[];
  /** Sides the user chose to leave out. */
  ignored: Side[];
}

/** The sides a chunk can take lines from: both for a conflict, the changed side otherwise. */
export function sidesOf(kind: ChunkKind): Side[] {
  if (kind === 'conflict') return ['mine', 'theirs'];
  if (kind === 'theirs') return ['theirs'];
  return kind === 'unchanged' ? [] : ['mine'];
}

/** Sessions for every changed chunk; automatic chunks start accepted when they were pre-applied. */
export function startSessions(chunks: readonly Chunk[], applied: boolean): ChunkSession[] {
  return chunks.flatMap((chunk, index): ChunkSession[] => {
    if (chunk.kind === 'unchanged') return [];
    const taken: Side[] = applied && isAutomatic(chunk) ? [automaticChoice(chunk) as Side] : [];
    return [{ chunk: index, kind: chunk.kind, taken, ignored: [] }];
  });
}

/** Sides that still offer an accept arrow and an ignore button. */
export const pendingSides = (s: ChunkSession): Side[] => sidesOf(s.kind).filter((side) => !s.taken.includes(side) && !s.ignored.includes(side));

/**
 * A conflict is resolved once one side is accepted (the other side can still be added after it)
 * or both sides are ignored. Any other chunk is resolved once its side is accepted or ignored.
 */
export const isResolved = (s: ChunkSession) => s.taken.length > 0 || pendingSides(s).length === 0;

export const unresolvedConflicts = (sessions: readonly ChunkSession[]) =>
  sessions.filter((s) => s.kind === 'conflict' && !isResolved(s)).length;

/** What the chunk's place in the result holds for what has been accepted so far. */
export function choiceOf(s: ChunkSession): Choice {
  if (s.taken.length === 2) return s.taken[0] === 'mine' ? 'mine-theirs' : 'theirs-mine';
  return s.taken[0] ?? 'base';
}

/** Accepts a side: the first one replaces the base lines, a second one is added below the first. */
export function accept(s: ChunkSession, side: Side): ChunkSession {
  if (!pendingSides(s).includes(side)) return s;
  return { ...s, taken: [...s.taken, side] };
}

export function ignore(s: ChunkSession, side: Side): ChunkSession {
  if (!pendingSides(s).includes(side)) return s;
  return { ...s, ignored: [...s.ignored, side] };
}
