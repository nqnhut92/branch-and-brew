import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { Commit, LaneRow } from '../../shared/protocol';
import { isMenuKey } from '../ui/ContextMenu';
import { formatDate, refTags, visibleRange } from './format';
import { GraphCell, ROW_HEIGHT, UncommittedCell, graphWidth } from './Graph';

/** Selection id of the uncommitted-changes row. */
export const UNCOMMITTED = 'uncommitted';

/**
 * The flat, virtualised commit table: only the rows near the viewport are in the DOM, so a
 * history of any length scrolls the same. Arrow keys move the selection; the Menu key or
 * Shift+F10 opens the commit menu.
 */
export function CommitTable({ commits, rows, uncommitted, selected, onSelect, onMenu, onNearEnd, empty, restoreScroll = 0, hasMore = false, onScrollTop }: {
  commits: Commit[];
  rows: LaneRow[] | null;
  /** Number of working tree entries; above zero adds the uncommitted-changes row. */
  uncommitted: number;
  selected: string | null;
  onSelect(id: string): void;
  onMenu(hash: string, x: number, y: number, returnFocus: HTMLElement): void;
  onNearEnd(): void;
  /** Shown in place of the list when there is nothing to draw. */
  empty: string;
  /** Offset to go back to, kept from a previous showing of the panel. */
  restoreScroll?: number;
  /** More pages can follow, so a restored offset may be past what is loaded. */
  hasMore?: boolean;
  /** Called with the new offset whenever the user scrolls. */
  onScrollTop?(top: number): void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  /** A restored offset still to reach; loading pages in between moves the target closer. */
  const restoring = useRef(restoreScroll > 0 ? restoreScroll : null);
  const offset = uncommitted > 0 ? 1 : 0;
  const count = commits.length + offset;
  const idAt = (i: number) => (i < offset ? UNCOMMITTED : commits[i - offset].hash);
  const selectedIndex = selected === null ? -1 : selected === UNCOMMITTED ? (offset ? 0 : -1) : commits.findIndex((c) => c.hash === selected) + offset;

  useLayoutEffect(() => {
    const el = scroller.current!;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    setHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Back where the table was before the panel was hidden. A page only holds so many rows, so the
  // offset is applied again as more pages arrive until it is reached.
  useLayoutEffect(() => {
    const el = scroller.current;
    const target = restoring.current;
    if (!el || target === null || count === 0) return;
    const top = Math.min(target, Math.max(0, count * ROW_HEIGHT - el.clientHeight));
    if (Math.abs(el.scrollTop - top) >= 1) {
      el.scrollTop = top;
      setScrollTop(top);
    }
    if (top >= target || !hasMore) restoring.current = null;
  }, [count, hasMore]);

  const { start, end } = visibleRange(scrollTop, height, ROW_HEIGHT, count);
  useEffect(() => {
    if (end >= count - 100) onNearEnd();
  }, [end, count, onNearEnd]);

  const lanes = rows ? rows.reduce((max, r) => Math.max(max, r.lane + 1, ...r.bottom.map((e) => e.to + 1)), 1) : 0;
  const width = rows ? graphWidth(lanes) : 0;
  const columns = `${width}px minmax(200px, 1fr) 170px 130px`;

  const select = (index: number) => {
    if (index < 0 || index >= count) return;
    onSelect(idAt(index));
    const el = scroller.current!;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1);
    const moves: Record<string, number> = {
      ArrowDown: selectedIndex + 1, ArrowUp: Math.max(0, selectedIndex - 1),
      PageDown: Math.min(count - 1, selectedIndex + page), PageUp: Math.max(0, selectedIndex - page),
      Home: 0, End: count - 1,
    };
    if (e.key in moves) {
      e.preventDefault();
      select(moves[e.key]);
    } else if (isMenuKey(e) && selectedIndex >= offset) {
      e.preventDefault();
      const el = scroller.current!;
      const box = el.getBoundingClientRect();
      onMenu(idAt(selectedIndex), box.left + width + 24, box.top + (selectedIndex + 1) * ROW_HEIGHT - el.scrollTop, el);
    }
  };

  const onContextMenu = (e: MouseEvent, index: number) => {
    e.preventDefault();
    onSelect(idAt(index));
    if (index >= offset) onMenu(idAt(index), e.clientX, e.clientY, scroller.current!);
  };

  const visible = [];
  for (let i = start; i < end; i++) {
    const id = idAt(i);
    const className = `row${id === selected ? ' selected' : ''}`;
    const common = {
      id: `row-${id}`, role: 'option', 'aria-selected': id === selected, className,
      style: { gridTemplateColumns: columns },
      onMouseDown: () => onSelect(id),
      onContextMenu: (e: MouseEvent) => onContextMenu(e, i),
    };
    if (i < offset) {
      visible.push(
        <div key={id} {...common}>
          {rows ? <UncommittedCell width={width} /> : <span />}
          <span className="message uncommitted">Uncommitted changes ({uncommitted} {uncommitted === 1 ? 'file' : 'files'})</span>
          <span /><span />
        </div>,
      );
      continue;
    }
    const commit = commits[i - offset];
    const row = rows?.[i - offset];
    visible.push(
      <div key={id} {...common}>
        {row ? <GraphCell row={row} width={width} /> : <span />}
        <span className="message" title={commit.subject}>
          {refTags(commit.refs).map((t) => <span key={t.kind + t.label} className={`ref ${t.kind}`}>{t.label}</span>)}
          {commit.subject}
        </span>
        <span className="author" title={`${commit.author} <${commit.email}>`}>{commit.author}</span>
        <span className="date">{formatDate(commit.date)}</span>
      </div>,
    );
  }

  return (
    <div className="table">
      <div className="row head" style={{ gridTemplateColumns: columns }} aria-hidden="true">
        <span /><span>Message</span><span>Author</span><span>Date</span>
      </div>
      <div
        className="rows" ref={scroller} tabIndex={0} role="listbox" aria-label="Commits"
        aria-activedescendant={selected ? `row-${selected}` : undefined}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          onScrollTop?.(e.currentTarget.scrollTop);
        }}
        onKeyDown={onKeyDown}
      >
        <div style={{ height: count * ROW_HEIGHT, position: 'relative' }}>
          <div style={{ position: 'absolute', top: start * ROW_HEIGHT, left: 0, right: 0 }}>{visible}</div>
        </div>
      </div>
      {count === 0 && <p className="muted empty" role="status">{empty}</p>}
    </div>
  );
}
