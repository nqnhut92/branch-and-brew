import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { isStaged, isUnstaged } from '../../core/git/changeState';
import { onlyCurrent, toggleScope } from '../../core/git/scope';
import type {
  BranchInfo, Commit, CommitAction, CommitDetail, FileAction, LaneRow, LogInit, LogMethods, LogRendered, WorkingChange,
} from '../../shared/protocol';
import { ContextMenu, type MenuItem, type MenuRequest } from '../ui/ContextMenu';
import { createClient, onHostEvent, pageErrors, vscodeApi } from '../ui/rpc';
import { BranchList } from './BranchList';
import { CommitTable, UNCOMMITTED } from './CommitTable';
import { CommitDetailView, WorkingTreeView, type FileRow } from './Detail';
import '../ui/base.css';
import './log.css';

const request = createClient<LogMethods>();

interface Loaded {
  commits: Commit[];
  /** Null while the list is filtered: a filtered list has no graph. */
  rows: LaneRow[] | null;
  done: boolean;
  /** Where the graph came from; `none` means it could not be laid out. */
  graph: 'first' | 'carried' | 'none';
}

/** What survives the panel being hidden and shown again. */
interface Saved { scope?: string[]; search?: string; scroll?: number }

function App() {
  const saved = useRef((vscodeApi.getState() as Saved | undefined) ?? {});
  /** Where the table was left when the panel was last shown. */
  const restoreScroll = saved.current.scroll ?? 0;
  const [init, setInit] = useState<LogInit | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [scope, setScope] = useState<string[]>([]);
  const [searchText, setSearchText] = useState(saved.current.search ?? '');
  const [search, setSearch] = useState(saved.current.search ?? '');
  const [loaded, setLoaded] = useState<Loaded>({ commits: [], rows: null, done: true, graph: 'none' });
  const [loading, setLoading] = useState(true);
  const [changes, setChanges] = useState<WorkingChange[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [menu, setMenu] = useState<MenuRequest | null>(null);

  /** Bumped on every reload so answers to older requests are dropped. */
  const generation = useRef(0);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const loadingMore = useRef(false);
  const scrollRef = useRef(restoreScroll);
  const scopeRef = useRef(scope);
  const searchRef = useRef(search);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const persist = useCallback(() => {
    vscodeApi.setState({ scope: scopeRef.current, search: searchRef.current, scroll: scrollRef.current } satisfies Saved);
  }, []);

  /** Scrolling fires many times a second; the panel state is written once it settles. */
  const rememberScroll = useCallback((top: number) => {
    scrollRef.current = top;
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(persist, 150);
  }, [persist]);

  useEffect(() => {
    void request('init', null).then((i) => {
      const known = new Set(i.branches.map((b) => b.name));
      const restored = saved.current.scope?.filter((s) => known.has(s) || s === 'HEAD') ?? [];
      setBranches(i.branches);
      setScope(restored.length ? restored : i.scope);
      setInit(i);
    });
  }, []);

  useEffect(() => {
    scopeRef.current = scope;
    searchRef.current = search;
    persist();
  }, [scope, search, persist]);
  useEffect(() => () => clearTimeout(persistTimer.current), []);

  // The search runs once typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchText.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  const reload = useCallback(async () => {
    if (!scope.length) return;
    const mine = ++generation.current;
    setLoading(true);
    try {
      const page = await request('page', { scope, skip: 0, search: search || undefined });
      if (mine !== generation.current) return;
      setLoaded({ commits: page.commits, rows: page.rows, done: page.done, graph: page.graph });
      setChanges(page.changes ?? []);
    } catch {
      // The host has already shown the error.
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [scope, search]);

  useEffect(() => { void reload(); }, [reload]);

  const loadMore = useCallback(async () => {
    const current = loadedRef.current;
    if (current.done || loadingMore.current || !scope.length) return;
    loadingMore.current = true;
    const mine = generation.current;
    try {
      const page = await request('page', { scope, skip: current.commits.length, search: search || undefined });
      if (mine !== generation.current) return;
      // A page whose graph could not continue leaves the rows alone rather than dropping the column.
      const rows = current.rows && page.rows ? [...current.rows, ...page.rows] : current.rows;
      setLoaded({
        commits: [...current.commits, ...page.commits],
        rows,
        done: page.done,
        graph: rows ? page.graph : 'none',
      });
    } catch {
      // Shown by the host; scrolling again retries.
    } finally {
      loadingMore.current = false;
    }
  }, [scope, search]);

  /** After anything that may have changed the repository: branches, history and working tree. */
  const refresh = useCallback(() => {
    void request('branches', null).then((list) => {
      setBranches(list);
      // A branch deleted meanwhile leaves the log; git would refuse the whole list otherwise.
      const known = new Set(list.map((b) => b.name));
      setScope((s) => {
        const kept = s.filter((name) => known.has(name) || name === 'HEAD');
        return kept.length === s.length ? s : kept.length ? kept : ['HEAD'];
      });
    }).catch(() => undefined);
    void reload();
  }, [reload]);

  useEffect(() => onHostEvent((e) => { if (e.event === 'changed') refresh(); }), [refresh]);

  // Detail of the selected commit.
  useEffect(() => {
    if (!selected || selected === UNCOMMITTED) return setDetail(null);
    let current = true;
    void request('detail', { hash: selected }).then((d) => { if (current) setDetail(d); }).catch(() => undefined);
    return () => { current = false; };
  }, [selected]);

  // A selection that no longer exists (reset, discarded changes) is dropped.
  useEffect(() => {
    if (selected === UNCOMMITTED && !changes.length && !loading) setSelected(null);
  }, [selected, changes, loading]);

  // Tell the host what is on screen; the integration tests wait for this.
  useEffect(() => {
    if (!init || loading) return;
    // A timer, not requestAnimationFrame: frames stop while the window is behind another one.
    const timer = setTimeout(() => vscodeApi.postMessage({
      kind: 'event', event: 'rendered',
      commits: loaded.commits.length,
      domRows: document.querySelectorAll('.rows .row').length,
      lanes: (loaded.rows ?? []).slice(0, 50).map((r) => r.lane),
      uncommitted: changes.length,
      graph: document.getElementById('log-graph')?.textContent ?? '',
      errors: pageErrors,
    } satisfies LogRendered));
    return () => clearTimeout(timer);
  }, [init, loading, loaded, changes]);

  const commitAction = useCallback(async (action: CommitAction, hash: string) => {
    if (await request('commitAction', { action, hash }).catch(() => false)) refresh();
  }, [refresh]);

  const fileAction = useCallback(async (action: FileAction, file: FileRow) => {
    const hash = selected === UNCOMMITTED ? null : selected;
    const changed = await request('fileAction', { action, hash, path: file.path, oldPath: file.oldPath, change: file.change }).catch(() => false);
    if (changed) refresh();
  }, [selected, refresh]);

  const openCommitMenu = useCallback((hash: string, x: number, y: number, returnFocus: HTMLElement) => {
    const item = (label: string, action: CommitAction): MenuItem => ({ label, run: () => void commitAction(action, hash) });
    setMenu({
      x, y, returnFocus,
      items: [
        item('Checkout This Commit', 'checkout'),
        item('Create Branch Here…', 'branch'),
        item('Create Tag Here…', 'tag'),
        'separator',
        item('Cherry-Pick', 'cherryPick'),
        item('Revert', 'revert'),
        'separator',
        item('Compare with Working Tree', 'compareWorkingTree'),
        item('Compare with Previous', 'comparePrevious'),
        item('Copy Hash', 'copyHash'),
        item('Copy Message', 'copyMessage'),
        'separator',
        item('Rebase Current Branch onto This', 'rebaseOnto'),
        item('Interactive Rebase from Here…', 'rebaseInteractive'),
        'separator',
        item('Reset Current Branch to Here…', 'reset'),
      ],
    });
  }, [commitAction]);

  const openFileMenu = useCallback((file: FileRow, x: number, y: number, returnFocus: HTMLElement) => {
    const item = (label: string, action: FileAction): MenuItem => ({ label, run: () => void fileAction(action, file) });
    const change = file.change;
    const items: MenuItem[] = [];
    if (change?.conflicted) {
      items.push(item('Resolve in Three-Pane Merge', 'resolve'), item('Take Mine', 'takeMine'), item('Take Theirs', 'takeTheirs'), 'separator');
    }
    items.push(item('Show Diff', 'diff'), item('Open File', 'open'));
    if (change && !change.conflicted && isUnstaged(change)) items.push(item('Stage', 'stage'));
    if (change && isStaged(change)) items.push(item('Unstage', 'unstage'));
    if (change?.worktree !== '?') items.push('separator', item('Show History of This File', 'history'), item('Blame', 'blame'));
    if (change) items.push('separator', item('Discard Changes…', 'discard'));
    setMenu({ x, y, returnFocus, items });
  }, [fileAction]);

  const closeMenu = useCallback(() => setMenu(null), []);

  /** Reloads with a fresh graph when the carried lane state could not be continued. */
  const restoreGraph = useCallback(async () => {
    await request('resetGraph', null).catch(() => null);
    refresh();
  }, [refresh]);

  if (!init) return <p className="muted pad">Loading…</p>;
  const filtered = !!search || !!init.path;
  const lost = !filtered && loaded.commits.length > 0 && !loaded.rows;
  return (
    <div className={`log${init.path ? ' no-branches' : ''}`}>
      {!init.path && (
        <BranchList
          branches={branches} scope={scope} maxScope={init.maxScope}
          onToggle={(name) => setScope((s) => toggleScope(s, name))}
          onOnlyCurrent={() => setScope(onlyCurrent(branches))}
        />
      )}
      <main>
        <div className="toolbar">
          <input
            type="search" placeholder="Search message, author or hash" aria-label="Search commits"
            value={searchText} onChange={(e) => setSearchText(e.target.value)}
          />
          {filtered
            ? <span className="graph-state off" id="log-graph">Graph off: {init.path ? 'file history' : 'search filter'}</span>
            : lost
              ? (
                <span className="graph-state off" id="log-graph">
                  Graph off: <button onClick={() => void restoreGraph()}>restore</button>
                </span>
              )
              : <span className="graph-state" id="log-graph">Graph on</span>}
          <span className="muted count" role="status">
            {loading ? 'Loading…' : `${loaded.commits.length}${loaded.done ? '' : '+'} ${filtered ? 'matching ' : ''}commits`}
          </span>
          <button onClick={refresh} title="Read the history and branches again">Refresh</button>
        </div>
        {init.path && <div className="muted pad">History of {init.path}</div>}
        <CommitTable
          commits={loaded.commits} rows={loaded.rows} uncommitted={filtered ? 0 : changes.length}
          selected={selected} onSelect={setSelected} onMenu={openCommitMenu} onNearEnd={loadMore}
          restoreScroll={restoreScroll} hasMore={!loaded.done} onScrollTop={rememberScroll}
          empty={search
            ? `No commit matches “${search}”.`
            : init.path ? 'No commit touches this file.' : 'No commits in the selected branches.'}
        />
        {selected === UNCOMMITTED
          ? <WorkingTreeView changes={changes} onFile={fileAction} onMenu={openFileMenu} />
          : detail && selected === detail.hash
            ? <CommitDetailView detail={detail} onFile={fileAction} onMenu={openFileMenu} />
            : <section className="detail single"><p className="muted pad">Select a commit to see its message and files.</p></section>}
      </main>
      {menu && <ContextMenu request={menu} onClose={closeMenu} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
