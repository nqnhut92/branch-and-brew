import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { isStaged, isUnstaged } from '../../core/git/changeState';
import { onlyCurrent, toggleScope } from '../../core/git/scope';
import type {
  BranchAction, BranchInfo, Commit, CommitAction, CommitDetail, FileAction, LaneRow, LogBrewingEvent, LogInit, LogMethods, LogRendered, WorkingChange,
} from '../../shared/protocol';
import { ContextMenu, type MenuItem, type MenuRequest } from '../ui/ContextMenu';
import { BrewingDialog } from '../ui/BrewingDialog';
import { createClient, onHostEvent, pageErrors, vscodeApi } from '../ui/rpc';
import { BranchList } from './BranchList';
import { CommitTable, UNCOMMITTED } from './CommitTable';
import { CommitDetailView, WorkingTreeView, type FileRow } from './Detail';
import { Sash, useDragResize } from '../ui/Sash';
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
interface Saved { scope?: string[]; search?: string; scroll?: number; branch?: string }

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
  const [brewing, setBrewing] = useState<{
    title: string;
    command: string;
    status: 'brewing' | 'success' | 'error';
    output: string;
    error?: string;
  } | null>(null);

  /** Bumped on every reload so answers to older requests are dropped. */
  const generation = useRef(0);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const loadingMore = useRef(false);
  const scrollRef = useRef(restoreScroll);
  const scopeRef = useRef(scope);
  const searchRef = useRef(search);
  const currentBranchRef = useRef<string | undefined>(undefined);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const persist = useCallback(() => {
    vscodeApi.setState({
      scope: scopeRef.current,
      search: searchRef.current,
      scroll: scrollRef.current,
      branch: currentBranchRef.current,
    } satisfies Saved);
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
      const cur = i.branches.find((b) => b.current)?.name;
      currentBranchRef.current = cur;
      setBranches(i.branches);
      const branchChanged = saved.current.branch && cur && saved.current.branch !== cur;
      const restored = !branchChanged && saved.current.scope
        ? saved.current.scope.filter((s) => known.has(s) || s === 'HEAD')
        : [];
      const nextScope = restored.length ? restored : (cur ? [cur] : i.scope);
      setScope(nextScope);
      scopeRef.current = nextScope;
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
      const cur = list.find((b) => b.current)?.name;
      setScope((s) => {
        const prevCur = currentBranchRef.current;
        currentBranchRef.current = cur;
        if (prevCur && cur && prevCur !== cur) {
          scopeRef.current = [cur];
          persist();
          return [cur];
        }
        const kept = s.filter((name) => known.has(name) || (name === 'HEAD' && !cur));
        if (kept.length !== s.length) {
          const next = kept.length ? kept : (cur ? [cur] : ['HEAD']);
          scopeRef.current = next;
          persist();
          return next;
        }
        return s;
      });
    }).catch(() => undefined);
    void reload();
  }, [reload, persist]);

  useEffect(() => {
    return onHostEvent((raw) => {
      const e = raw as unknown as { event: string; [key: string]: unknown };
      if (e.event === 'changed') {
        refresh();
      } else if (e.event === 'brewing') {
        const b = e as unknown as LogBrewingEvent;
        if (b.action === 'start') {
          setBrewing({
            title: b.title ?? 'Brewing',
            command: b.command ?? '',
            status: 'brewing',
            output: '',
          });
        } else if (b.action === 'output') {
          setBrewing((prev) => (prev ? { ...prev, output: prev.output + (b.chunk ?? '') } : null));
        } else if (b.action === 'finish') {
          setBrewing((prev) => (prev ? {
            ...prev,
            status: b.status ?? 'success',
            error: b.error,
          } : null));
        }
      }
    });
  }, [refresh]);

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

  const branchAction = useCallback(async (action: BranchAction, branch: string) => {
    const localName = branch.startsWith('origin/') ? branch.slice('origin/'.length) : branch;
    if (action === 'switch') {
      currentBranchRef.current = localName;
      setScope([localName]);
      scopeRef.current = [localName];
      scrollRef.current = 0;
      persist();
    }
    const ok = await request('branchAction', { action, branch }).catch(() => false);
    if (ok) {
      if (action === 'switch') {
        currentBranchRef.current = localName;
        setScope([localName]);
        scopeRef.current = [localName];
        persist();
      }
      refresh();
    } else if (action === 'switch') {
      refresh();
    }
  }, [refresh, persist]);

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
        'separator',
        item('Reset Current Branch to Here…', 'reset'),
      ],
    });
  }, [commitAction]);

  const openBranchMenu = useCallback((branch: BranchInfo, x: number, y: number, returnFocus: HTMLElement) => {
    const current = branches.find((b) => b.current);
    const items: MenuItem[] = [];
    if (!branch.current && current) {
      items.push({
        label: `Checkout ${branch.name}`,
        run: () => void branchAction('switch', branch.name),
      });
      items.push({
        label: `Merge '${branch.name}' into '${current.name}'`,
        run: () => void branchAction('merge', branch.name),
      });
      items.push({
        label: `Rebase current branch onto '${branch.name}'`,
        run: () => void branchAction('rebase', branch.name),
      });
      items.push('separator');
    }
    items.push({
      label: 'Copy Branch Name',
      run: () => {
        void navigator.clipboard?.writeText(branch.name);
      },
    });
    if (!branch.current && !branch.remote) {
      items.push('separator');
      items.push({
        label: `Delete ${branch.name}…`,
        run: () => void branchAction('delete', branch.name),
      });
    }
    setMenu({ x, y, returnFocus, items });
  }, [branches, branchAction]);

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

  const [sidebarWidth, onResizeSidebar] = useDragResize(230, 'bnb.log.sidebarWidth', 160, 600, false);
  const [detailHeight, onResizeDetail] = useDragResize(240, 'bnb.log.detailHeight', 120, 700, true);

  if (!init) return <p className="muted pad">Loading…</p>;
  const filtered = !!search || !!init.path;
  const lost = !filtered && loaded.commits.length > 0 && !loaded.rows;
  return (
    <div
      className={`log${init.path ? ' no-branches' : ''}`}
      style={{
        gridTemplateColumns: init.path ? 'minmax(0, 1fr)' : `${sidebarWidth}px auto minmax(0, 1fr)`,
      }}
    >
      {!init.path && (
        <>
          <BranchList
            branches={branches} scope={scope} maxScope={init.maxScope}
            onToggle={(name) => setScope((s) => {
              const cur = branches.find((b) => b.current)?.name;
              const resolved = s.map((b) => (b === 'HEAD' && cur ? cur : b));
              return toggleScope(resolved, name);
            })}
            onOnlyCurrent={() => setScope(onlyCurrent(branches))}
            onMenu={openBranchMenu}
            onSwitch={(name) => {
              const localName = name.startsWith('origin/') ? name.slice('origin/'.length) : name;
              const cur = branches.find((b) => b.current)?.name;
              if (cur === name || cur === localName) {
                currentBranchRef.current = localName;
                setScope([localName]);
                scopeRef.current = [localName];
                scrollRef.current = 0;
                persist();
                refresh();
                return;
              }
              void branchAction('switch', name);
            }}
          />
          <Sash orientation="vertical" onMouseDown={(e) => onResizeSidebar(e, 'vertical')} title="Drag to resize branch sidebar" />
        </>
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
              : <span className="graph-state on" id="log-graph" aria-hidden="true">Graph on</span>}
          <span className="muted count" role="status">
            {loading ? 'Loading…' : `${loaded.commits.length}${loaded.done ? '' : '+'} ${filtered ? 'matching ' : ''}commits`}
          </span>
          <button
            type="button"
            className="toolbar-btn"
            onClick={refresh}
            title="Refresh"
            aria-label="Refresh"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" clipRule="evenodd" d="M4.681 3H2V2h3.5l.5.5V6H5V4a5 5 0 1 0 4.53-.761l.302-.954A6 6 0 1 1 4.681 3z" />
            </svg>
          </button>
        </div>
        {init.path && <div className="muted pad">History of {init.path}</div>}
        <div className="table-pane">
          <CommitTable
            commits={loaded.commits} rows={loaded.rows} uncommitted={filtered ? 0 : changes.length}
            selected={selected} onSelect={setSelected} onMenu={openCommitMenu} onNearEnd={loadMore}
            restoreScroll={restoreScroll} hasMore={!loaded.done} onScrollTop={rememberScroll}
            scope={scope} branches={branches}
            empty={search
              ? `No commit matches “${search}”.`
              : init.path ? 'No commit touches this file.' : 'No commits in the selected branches.'}
          />
        </div>
        <Sash orientation="horizontal" onMouseDown={(e) => onResizeDetail(e, 'horizontal')} title="Drag to resize detail pane" />
        <div className="detail-pane" style={{ height: `${detailHeight}px`, minHeight: '120px', flexShrink: 0 }}>
          {selected === UNCOMMITTED
            ? <WorkingTreeView changes={changes} onFile={fileAction} onMenu={openFileMenu} />
            : detail && selected === detail.hash
              ? <CommitDetailView detail={detail} labels={loaded.commits.find((c) => c.hash === selected)?.refs} onFile={fileAction} onMenu={openFileMenu} />
              : <section className="detail single"><p className="muted pad">Select a commit to see its message and files.</p></section>}
        </div>
      </main>
      {menu && <ContextMenu request={menu} onClose={closeMenu} />}
      {brewing && (
        <BrewingDialog
          title={brewing.title}
          repoName={init.name}
          command={brewing.command}
          status={brewing.status}
          output={brewing.output}
          error={brewing.error}
          hasConflicts={
            brewing.status === 'error' &&
            (/^CONFLICT \(/m.test(brewing.output) ||
              /Automatic merge failed/i.test(brewing.output) ||
              /conflict/i.test(brewing.error ?? ''))
          }
          onClose={() => setBrewing(null)}
          onResolveConflicts={async () => {
            setBrewing(null);
            await request('resolveConflicts', null).catch(() => undefined);
          }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
