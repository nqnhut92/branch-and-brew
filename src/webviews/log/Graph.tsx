import type { LaneEdge } from '../../core/git/lanes';
import type { LaneRow } from '../../shared/protocol';

export const ROW_HEIGHT = 24;
const LANE_WIDTH = 12;
/** Lanes drawn before the graph column is cut off; wider graphs are clipped, not squeezed. */
export const MAX_LANES = 12;
const COLORS = 6;

const x = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;
export const graphWidth = (lanes: number) => Math.min(lanes, MAX_LANES) * LANE_WIDTH + 4;

function edgePath(edge: LaneEdge, y1: number, y2: number): string {
  if (edge.from === edge.to) return `M${x(edge.from)} ${y1}V${y2}`;
  // A line that changes lane bends through the half-row.
  const mid = (y1 + y2) / 2;
  return `M${x(edge.from)} ${y1}C${x(edge.from)} ${mid} ${x(edge.to)} ${mid} ${x(edge.to)} ${y2}`;
}

/** The graph cell of one row: the lines crossing it and the commit's dot. */
export function GraphCell({ row, width }: { row: LaneRow; width: number }) {
  const half = ROW_HEIGHT / 2;
  return (
    <svg className="graph" width={width} height={ROW_HEIGHT} aria-hidden="true">
      {row.top.map((e, i) => <path key={`t${i}`} className={`lane c${e.color % COLORS}`} d={edgePath(e, 0, half)} />)}
      {row.bottom.map((e, i) => <path key={`b${i}`} className={`lane c${e.color % COLORS}`} d={edgePath(e, half, ROW_HEIGHT)} />)}
      <circle className={`dot c${row.color % COLORS}`} cx={x(row.lane)} cy={half} r={3.5} />
    </svg>
  );
}

/** The dot of the uncommitted-changes row: hollow, above the first commit. */
export function UncommittedCell({ width }: { width: number }) {
  return (
    <svg className="graph" width={width} height={ROW_HEIGHT} aria-hidden="true">
      <circle className="dot hollow" cx={x(0)} cy={ROW_HEIGHT / 2} r={3.5} />
    </svg>
  );
}
