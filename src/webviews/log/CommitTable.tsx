import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { BranchInfo, Commit, LaneRow } from '../../shared/protocol';
import { isMenuKey } from '../ui/ContextMenu';
import { formatFullDate, formatPerson, formatSystemDate, refTags, visibleRange } from './format';
import { GraphCell, ROW_HEIGHT, UncommittedCell, graphWidth } from './Graph';

/** Selection id of the uncommitted-changes row. */
export const UNCOMMITTED = 'uncommitted';

export type ColumnKey = 'message' | 'commit' | 'author' | 'committer' | 'date';

const DEFAULT_WIDTHS: Record<ColumnKey, number> = {
  message: 350,
  commit: 75,
  author: 200,
  committer: 200,
  date: 160,
};

const MIN_WIDTHS: Record<ColumnKey, number> = {
  message: 120,
  commit: 50,
  author: 80,
  committer: 80,
  date: 100,
};

const DEFAULT_VISIBILITY: Record<ColumnKey, boolean> = {
  message: true,
  commit: true,
  author: true,
  committer: true,
  date: true,
};

function loadStored<T>(key: string, fallback: T): T {
  try {
    const val = localStorage.getItem(key);
    if (val) return { ...fallback, ...JSON.parse(val) };
  } catch (_e) {
    void _e;
  }
  return fallback;
}

/**
 * The flat, virtualised commit table: only the rows near the viewport are in the DOM, so a
 * history of any length scrolls the same. Arrow keys move the selection; the Menu key or
 * Shift+F10 opens the commit menu.
 */
export function CommitTable({ commits, rows, uncommitted, selected, onSelect, onMenu, onNearEnd, empty, restoreScroll = 0, hasMore = false, onScrollTop, scope, branches }: {
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
  scope?: string[];
  branches?: BranchInfo[];
}) {
  const headerRef = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);

  const [colWidths, setColWidths] = useState<Record<ColumnKey, number>>(() =>
    loadStored('bnb.log.colWidths', DEFAULT_WIDTHS)
  );
  const [colVisible, setColVisible] = useState<Record<ColumnKey, boolean>>(() =>
    loadStored('bnb.log.colVisible', DEFAULT_VISIBILITY)
  );
  const [pickerPos, setPickerPos] = useState<{ top: number; right: number } | null>(null);
  const pickerBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!pickerPos) return;
    const onClick = (e: globalThis.MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        pickerBtnRef.current && !pickerBtnRef.current.contains(e.target as Node)
      ) {
        setPickerPos(null);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [pickerPos]);

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

  const toggleCol = (key: ColumnKey) => {
    setColVisible((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem('bnb.log.colVisible', JSON.stringify(next)); } catch (_e) { void _e; }
      return next;
    });
  };

  const onStartResize = (key: ColumnKey, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = colWidths[key];
    const minW = MIN_WIDTHS[key];
    const onMouseMove = (ev: globalThis.MouseEvent) => {
      const delta = ev.clientX - startX;
      const newWidth = Math.max(minW, startWidth + delta);
      setColWidths((prev) => {
        const next = { ...prev, [key]: newWidth };
        try { localStorage.setItem('bnb.log.colWidths', JSON.stringify(next)); } catch (_e) { void _e; }
        return next;
      });
    };
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const lanes = rows ? rows.reduce((max, r) => Math.max(max, r.lane + 1, ...r.bottom.map((e) => e.to + 1)), 1) : 0;
  const width = rows ? graphWidth(lanes) : 0;
  const columns = [
    `${width}px`,
    `${colWidths.message}px`,
    colVisible.commit ? `${colWidths.commit}px` : null,
    colVisible.author ? `${colWidths.author}px` : null,
    colVisible.committer ? `${colWidths.committer}px` : null,
    colVisible.date ? `${colWidths.date}px` : null,
    '24px',
    '1fr',
  ].filter(Boolean).join(' ');

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
          {colVisible.commit && <span />}
          {colVisible.author && <span />}
          {colVisible.committer && <span />}
          {colVisible.date && <span />}
          <span />
          <span />
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
          {refTags(commit.refs, scope, branches).map((t) => <span key={t.kind + t.label} className={`ref ${t.kind}`}>{t.label}</span>)}
          {commit.subject}
        </span>
        {colVisible.commit && (
          <span className="hash" title={commit.hash}>{commit.hash.slice(0, 7)}</span>
        )}
        {colVisible.author && (
          <span className="author" title={formatPerson(commit.author, commit.email)}>
            {formatPerson(commit.author, commit.email)}
          </span>
        )}
        {colVisible.committer && (
          <span className="committer" title={formatPerson(commit.committer || commit.author, commit.committerEmail || commit.email)}>
            {formatPerson(commit.committer || commit.author, commit.committerEmail || commit.email)}
          </span>
        )}
        {colVisible.date && (
          <span className="date" title={formatFullDate(commit.date)}>
            {formatSystemDate(commit.date)}
          </span>
        )}
        <span />
        <span />
      </div>,
    );
  }

  return (
    <div className="table">
      <div className="table-head-wrapper" ref={headerRef}>
        <div
          className="row head"
          style={{ gridTemplateColumns: columns }}
          aria-hidden="true"
          onContextMenu={(e) => {
            e.preventDefault();
            setPickerPos({
              top: e.clientY + 4,
              right: Math.max(8, window.innerWidth - e.clientX),
            });
          }}
        >
          <span />
          <span className="col-header resizable">
            Message
            <span className="col-resizer" onMouseDown={(e) => onStartResize('message', e)} />
          </span>
          {colVisible.commit && (
            <span className="col-header resizable">
              Commit
              <span className="col-resizer" onMouseDown={(e) => onStartResize('commit', e)} />
            </span>
          )}
          {colVisible.author && (
            <span className="col-header resizable">
              Author
              <span className="col-resizer" onMouseDown={(e) => onStartResize('author', e)} />
            </span>
          )}
          {colVisible.committer && (
            <span className="col-header resizable">
              Committer
              <span className="col-resizer" onMouseDown={(e) => onStartResize('committer', e)} />
            </span>
          )}
          {colVisible.date && (
            <span className="col-header resizable">
              Date
              <span className="col-resizer" onMouseDown={(e) => onStartResize('date', e)} />
            </span>
          )}
          <span className="col-header picker-header">
            <button
              ref={pickerBtnRef}
              type="button"
              className="col-picker-btn"
              title="Configure columns"
              onClick={(e) => {
                e.stopPropagation();
                if (pickerPos) {
                  setPickerPos(null);
                } else {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setPickerPos({
                    top: rect.bottom + 4,
                    right: Math.max(8, window.innerWidth - rect.right),
                  });
                }
              }}
            >
              ⋮
            </button>
          </span>
          <span />
        </div>
      </div>
      {pickerPos && (
        <div
          ref={menuRef}
          className="col-picker-menu"
          style={{
            position: 'fixed',
            top: `${pickerPos.top}px`,
            right: `${pickerPos.right}px`,
          }}
        >
          <label><input type="checkbox" checked={colVisible.commit} onChange={() => toggleCol('commit')} /> Commit</label>
          <label><input type="checkbox" checked={colVisible.author} onChange={() => toggleCol('author')} /> Author</label>
          <label><input type="checkbox" checked={colVisible.committer} onChange={() => toggleCol('committer')} /> Committer</label>
          <label><input type="checkbox" checked={colVisible.date} onChange={() => toggleCol('date')} /> Date</label>
        </div>
      )}
      <div
        className="rows" ref={scroller} tabIndex={0} role="listbox" aria-label="Commits"
        aria-activedescendant={selected ? `row-${selected}` : undefined}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          if (headerRef.current) {
            headerRef.current.scrollLeft = e.currentTarget.scrollLeft;
          }
          onScrollTop?.(e.currentTarget.scrollTop);
        }}
        onKeyDown={onKeyDown}
      >
        <div style={{ height: count * ROW_HEIGHT, position: 'relative', width: 'max-content', minWidth: '100%' }}>
          <div style={{ position: 'absolute', top: start * ROW_HEIGHT, left: 0, right: 0 }}>{visible}</div>
        </div>
      </div>
      {count === 0 && <p className="muted empty" role="status">{empty}</p>}
    </div>
  );
}
