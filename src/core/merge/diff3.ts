import { diffIndices } from 'node-diff3';

/** A run of lines: `start` is the index of the first line, `length` may be zero. */
export interface Range {
  start: number;
  length: number;
}

/**
 * - unchanged: the same in base, mine and theirs
 * - mine / theirs: changed on that side only
 * - same: changed on both sides in the same way
 * - conflict: changed on both sides differently
 */
export type ChunkKind = 'unchanged' | 'mine' | 'theirs' | 'same' | 'conflict';

/** One piece of a three-way comparison, with where it sits in each of the three files. */
export interface Chunk {
  kind: ChunkKind;
  base: Range;
  mine: Range;
  theirs: Range;
}

const sameLines = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

interface Hunk {
  side: 'mine' | 'theirs';
  /** Range replaced in base. */
  base: Range;
  /** Number of lines that replace it on this side. */
  length: number;
}

function hunks(base: readonly string[], other: readonly string[], side: Hunk['side']): Hunk[] {
  return diffIndices([...base], [...other]).map((d) => ({ side, base: { start: d.buffer1[0], length: d.buffer1[1] }, length: d.buffer2[1] }));
}

/**
 * Three-way diff by lines into ordered chunks that together cover all three files.
 *
 * The line diffs (base against mine, base against theirs) are node-diff3's. Its own three-way
 * regions do not say where a one-sided deletion sits in each file, so the two diffs are combined
 * here by diff3's rule: changes whose base ranges overlap or touch form one chunk, and a chunk
 * with changes from both sides is a conflict unless both sides ended up with the same lines.
 */
export function diff3Chunks(base: readonly string[], mine: readonly string[], theirs: readonly string[]): Chunk[] {
  const all = [...hunks(base, mine, 'mine'), ...hunks(base, theirs, 'theirs')]
    .sort((x, y) => x.base.start - y.base.start || x.base.length - y.base.length);
  const chunks: Chunk[] = [];
  const at = { base: 0, mine: 0, theirs: 0 };
  const push = (kind: ChunkKind, baseLength: number, mineLength: number, theirsLength: number) => {
    if (!baseLength && !mineLength && !theirsLength) return;
    chunks.push({
      kind,
      base: { start: at.base, length: baseLength },
      mine: { start: at.mine, length: mineLength },
      theirs: { start: at.theirs, length: theirsLength },
    });
    at.base += baseLength;
    at.mine += mineLength;
    at.theirs += theirsLength;
  };

  for (let i = 0; i < all.length;) {
    const start = all[i].base.start;
    let end = start + all[i].base.length;
    // Lines each side adds (or, negative, removes) inside this chunk.
    const grow = { mine: 0, theirs: 0 };
    const sides = new Set<Hunk['side']>();
    while (i < all.length && all[i].base.start <= end) {
      const h = all[i++];
      end = Math.max(end, h.base.start + h.base.length);
      grow[h.side] += h.length - h.base.length;
      sides.add(h.side);
    }
    push('unchanged', start - at.base, start - at.base, start - at.base);
    const length = end - start;
    const mineLength = length + grow.mine;
    const theirsLength = length + grow.theirs;
    const kind: ChunkKind = sides.size === 1
      ? [...sides][0]
      : sameLines(mine.slice(at.mine, at.mine + mineLength), theirs.slice(at.theirs, at.theirs + theirsLength)) ? 'same' : 'conflict';
    push(kind, length, mineLength, theirsLength);
  }
  const rest = base.length - at.base;
  push('unchanged', rest, rest, rest);
  return chunks;
}

export const slice = (lines: readonly string[], range: Range) => lines.slice(range.start, range.start + range.length);
