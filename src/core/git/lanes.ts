/**
 * Graph layout for the log. Commits arrive in topological order (children before parents); each
 * gets a lane, and each row gets the line segments that cross it. Lanes never shift sideways: a
 * lane freed by a merge is reused by the next branch that needs one.
 */
export interface LaneEdge {
  /** Lane at the start of the half-row. */
  from: number;
  /** Lane at the end of the half-row. */
  to: number;
  /** Index into the colour palette; a line keeps its colour for its whole length. */
  color: number;
}

export interface LaneRow {
  lane: number;
  color: number;
  /** Segments from the top of the row to its middle. */
  top: LaneEdge[];
  /** Segments from the middle of the row to its bottom. */
  bottom: LaneEdge[];
}

/** Carried from one page to the next; plain JSON. */
export interface LaneState {
  /** Per lane, the hash of the commit that line is waiting for, or null when the lane is free. */
  waiting: (string | null)[];
  colors: number[];
  nextColor: number;
}

export const emptyLaneState = (): LaneState => ({ waiting: [], colors: [], nextColor: 0 });

/** Resets the graph as if nothing had been laid out yet, so it can restart from the current page. */
export function resetLanes(s: LaneState): LaneState {
  return { waiting: [], colors: [], nextColor: s.nextColor };
}

export function layoutLanes(
  commits: readonly { hash: string; parents: readonly string[] }[],
  previous: LaneState = emptyLaneState(),
): { rows: LaneRow[]; state: LaneState } {
  const waiting = [...previous.waiting];
  const colors = [...previous.colors];
  let nextColor = previous.nextColor;

  const allocate = (hash: string): number => {
    let lane = waiting.indexOf(null);
    if (lane < 0) lane = waiting.length;
    waiting[lane] = hash;
    colors[lane] = nextColor++;
    return lane;
  };

  const rows = commits.map(({ hash, parents }) => {
    const before = [...waiting];
    let lane = before.indexOf(hash);
    const top: LaneEdge[] = [];
    if (lane < 0) lane = allocate(hash); // a branch tip: nothing above it
    const color = colors[lane];
    before.forEach((h, i) => {
      if (h !== null) top.push({ from: i, to: h === hash ? lane : i, color: colors[i] });
    });
    // Every line that was waiting for this commit ends here.
    waiting.forEach((h, i) => { if (h === hash) waiting[i] = null; });

    const bottom: LaneEdge[] = [];
    before.forEach((h, i) => {
      if (h !== null && h !== hash) bottom.push({ from: i, to: i, color: colors[i] });
    });
    parents.forEach((parent, n) => {
      let to: number;
      if (n === 0) {
        // The first parent continues in the commit's own lane and colour. Another lane may wait
        // for the same parent; the two lines join at that parent's row.
        to = lane;
        waiting[lane] = parent;
        colors[lane] = color;
      } else {
        to = waiting.indexOf(parent);
        if (to < 0) to = allocate(parent);
      }
      bottom.push({ from: lane, to, color: n === 0 ? color : colors[to] });
    });
    return { lane, color, top, bottom };
  });

  while (waiting.length && waiting[waiting.length - 1] === null) waiting.pop();
  return { rows, state: { waiting, colors: colors.slice(0, waiting.length), nextColor } };
}

/** Number of lanes a row touches, for sizing the graph column. */
export function rowWidth(row: LaneRow): number {
  let max = row.lane;
  for (const e of [...row.top, ...row.bottom]) max = Math.max(max, e.from, e.to);
  return max + 1;
}
