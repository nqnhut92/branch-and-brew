import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { filterRepos, groupByProject, shortNameOf } from '../../core/accounts/browse';
import { folderNameOf } from '../../core/accounts/model';
import type { CloneInit, CloneItemEvent, CloneMethods, CloneRegisteredEvent, RemoteRepo } from '../../shared/protocol';
import { createClient, onHostEvent, vscodeApi } from '../ui/rpc';
import { CloneProgressDialog, type CloneItem } from './ProgressDialog';
import '../ui/base.css';
import './clone.css';

const request = createClient<CloneMethods>();

const ROW = 26;
const OVERSCAN = 12;

type Row = { kind: 'project'; project: string; repos: RemoteRepo[] } | { kind: 'repo'; repo: RemoteRepo };

/** What survives the panel being hidden and shown again. */
interface Saved { query?: string }

function App() {
  const saved = useRef((vscodeApi.getState() as Saved | undefined) ?? {});
  const [init, setInit] = useState<CloneInit | null>(null);
  const [repos, setRepos] = useState<RemoteRepo[] | null>(null);
  const [registered, setRegistered] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string>();
  const [query, setQuery] = useState(saved.current.query ?? '');
  const deferred = useDeferredValue(query);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [items, setItems] = useState<Map<string, CloneItem>>(new Map());
  const [dialog, setDialog] = useState(false);
  const [target, setTarget] = useState<{ destination?: string; group?: string }>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const listRef = useRef<HTMLDivElement>(null);
  const lastClicked = useRef<string | undefined>(undefined);
  const names = useRef(new Map<string, string>());

  const load = useCallback((refresh: boolean) => {
    setRepos(null);
    setLoadError(undefined);
    request('load', { refresh }).then((list) => {
      names.current = new Map(list.repos.map((r) => [r.cloneUrl, r.name]));
      setRepos(list.repos);
      setRegistered(new Set(list.registered));
    }).catch((e: Error) => { setLoadError(e.message); setRepos([]); });
  }, []);

  useEffect(() => {
    request('init', null).then(setInit).catch(() => undefined);
    load(false);
  }, [load]);

  useEffect(() => onHostEvent((raw) => {
    if (raw.event === 'registered') return setRegistered(new Set((raw as unknown as CloneRegisteredEvent).registered));
    const e = raw as unknown as CloneItemEvent;
    if (e.event !== 'item') return;
    setItems((prev) => {
      const next = new Map(prev);
      const old = prev.get(e.url);
      next.set(e.url, {
        url: e.url, name: names.current.get(e.url) ?? e.url, status: e.status,
        percent: e.percent ?? (e.status === 'done' ? 100 : old?.percent ?? 0), phase: e.phase ?? old?.phase, error: e.error,
      });
      return next;
    });
    if (e.status === 'done') {
      setSelected((prev) => { const next = new Set(prev); next.delete(e.url); return next; });
    }
  }), []);

  useEffect(() => { try { vscodeApi.setState({ query } satisfies Saved); } catch { /* ignore */ } }, [query]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    setHeight(el.clientHeight);
    return () => observer.disconnect();
  }, [repos]);

  const shown = useMemo(() => (repos ? filterRepos(repos, deferred) : []), [repos, deferred]);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const g of groupByProject(shown)) {
      out.push({ kind: 'project', project: g.project, repos: g.repos });
      if (!collapsed.has(g.project)) for (const repo of g.repos) out.push({ kind: 'repo', repo });
    }
    return out;
  }, [shown, collapsed]);
  /** Repositories in the order they are listed, for shift-click ranges. */
  const order = useMemo(() => rows.flatMap((r) => (r.kind === 'repo' ? [r.repo.cloneUrl] : [])), [rows]);

  const toggle = (url: string, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const anchor = lastClicked.current;
      if (shift && anchor && order.includes(anchor)) {
        const [a, b] = [order.indexOf(anchor), order.indexOf(url)].sort((x, y) => x - y);
        const on = !prev.has(url);
        for (const u of order.slice(a, b + 1)) {
          if (on) next.add(u);
          else next.delete(u);
        }
      } else if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
    lastClicked.current = url;
  };
  const toggleMany = (list: RemoteRepo[]) => setSelected((prev) => {
    const next = new Set(prev);
    const all = list.every((r) => next.has(r.cloneUrl));
    for (const r of list) {
      if (all) next.delete(r.cloneUrl);
      else next.add(r.cloneUrl);
    }
    return next;
  });

  const start = () => {
    const urls = [...selected];
    if (!urls.length) return;
    request('start', { urls }).then((r) => {
      if (!r.started) return;
      setTarget({ destination: r.destination, group: r.group });
      setItems(new Map());
      setDialog(true);
    }).catch(() => undefined);
  };
  const retry = (urls: string[]) => void request('retry', { urls }).catch(() => undefined);

  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN);
  const running = [...items.values()].some((i) => i.status === 'queued' || i.status === 'cloning');

  return (
    <div className="clone">
      <div className="clone-bar-top">
        <input type="search" placeholder={`Filter ${init?.source ?? ''} (words in any order, e.g. "applause v2")`} value={query}
          onChange={(e) => setQuery(e.target.value)} autoFocus aria-label="Filter repositories" />
        <span className="clone-count">{repos ? `${shown.length} of ${repos.length}` : 'Loading…'}</span>
        <button type="button" onClick={() => load(true)} disabled={!repos} title="Fetch the list again">Refresh</button>
        <button type="button" onClick={() => setSelected(new Set())} disabled={!selected.size}>Clear</button>
        {items.size > 0 && !dialog && (
          <button type="button" onClick={() => setDialog(true)}>{running ? 'Show Progress' : 'Last Run'}</button>
        )}
        <button type="button" className="clone-go" onClick={start} disabled={!selected.size}>
          {selected.size ? `Clone ${selected.size}…` : 'Clone…'}
        </button>
      </div>

      {loadError && <div className="clone-empty clone-failed">{loadError}</div>}
      {!repos && <div className="clone-empty">Loading repositories… a large organization can take a while.</div>}
      {repos && !loadError && !rows.length && <div className="clone-empty">No repository matches.</div>}

      <div className="clone-list" ref={listRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} role="list">
        <div style={{ height: rows.length * ROW, position: 'relative' }}>
          {rows.slice(first, last).map((row, i) => {
            const top = (first + i) * ROW;
            if (row.kind === 'project') {
              const all = row.repos.every((r) => selected.has(r.cloneUrl));
              const some = row.repos.some((r) => selected.has(r.cloneUrl));
              const open = !collapsed.has(row.project);
              return (
                <div key={`p:${row.project}`} className="clone-project" style={{ top, height: ROW }} role="listitem">
                  <button type="button" className="clone-twist" aria-label={open ? 'Collapse' : 'Expand'}
                    onClick={() => setCollapsed((prev) => { const n = new Set(prev); if (open) n.add(row.project); else n.delete(row.project); return n; })}>
                    {open ? '▾' : '▸'}
                  </button>
                  <input type="checkbox" checked={all} ref={(el) => { if (el) el.indeterminate = some && !all; }}
                    onChange={() => toggleMany(row.repos)} aria-label={`Select all of ${row.project || 'no project'}`} />
                  <span className="clone-project-name">{row.project || '(no project)'}</span>
                  <span className="clone-project-count">{row.repos.length}</span>
                </div>
              );
            }
            const r = row.repo;
            const isRegistered = registered.has(folderNameOf(r.cloneUrl).toLowerCase());
            return (
              <label key={r.cloneUrl} className={`clone-repo${selected.has(r.cloneUrl) ? ' selected' : ''}`} style={{ top, height: ROW }} role="listitem"
                onClick={(e) => { if (e.shiftKey) { e.preventDefault(); toggle(r.cloneUrl, true); } }}>
                <input type="checkbox" checked={selected.has(r.cloneUrl)} onChange={(e) => toggle(r.cloneUrl, (e.nativeEvent as MouseEvent).shiftKey === true)} />
                <span className="clone-repo-name">{shortNameOf(r)}</span>
                {r.description && <span className="clone-desc">{r.description}</span>}
                {isRegistered && <span className="clone-badge" title="A repository with this folder name is already in your list">in list</span>}
                {r.private && <span className="clone-private">private</span>}
              </label>
            );
          })}
        </div>
      </div>

      {dialog && (
        <CloneProgressDialog items={[...items.values()]} destination={target.destination} group={target.group}
          onCancel={(url) => void request('cancel', { url }).catch(() => undefined)} onRetry={retry} onClose={() => setDialog(false)} />
      )}
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
