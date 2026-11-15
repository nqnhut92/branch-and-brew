import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ACTIONS, countResult, moveEntry, sameCommit, squashAll, validateTodo, type TodoAction, type TodoEntry,
} from '../../core/rebase/todo';
import type { CommitDetail, RebaseMethods, RebasePerform, RebaseState, RebaseView } from '../../shared/protocol';
import { createClient, onHostEvent, pageErrors, vscodeApi } from '../ui/rpc';
import { formatFullDate, formatPerson } from '../log/format';
import { ContextMenu, type MenuItem, type MenuRequest } from '../ui/ContextMenu';
import { Sash, useDragResize } from '../ui/Sash';
import '../ui/base.css';
import './rebase.css';

const request = createClient<RebaseMethods>();
const short = (hash: string) => hash.slice(0, 8);

/** The same commits in any order: the list was edited here, not replaced by git. */
function sameCommits(a: TodoEntry[], b: TodoEntry[]): boolean {
  const key = (e: TodoEntry) => (e.action === 'other' ? e.raw ?? '' : e.hash);
  return a.length === b.length && a.every((x) => b.some((y) => (x.action === 'other' ? key(x) === key(y) : sameCommit(x.hash, y.hash))));
}

const PAUSE_TEXT = {
  conflict: (n: number) => `Stopped on ${n} conflicted ${n === 1 ? 'file' : 'files'}. Resolve ${n === 1 ? 'it' : 'them'}, then Continue.`,
  edit: () => 'Stopped to edit this commit. Change files and amend the commit, then Continue.',
  stopped: () => 'The rebase is paused. Continue when ready.',
};

function App() {
  const [view, setView] = useState<RebaseView | null>(null);
  const [rows, setRows] = useState<TodoEntry[]>([]);
  /** The rows as the host last sent them, for Reset. */
  const [original, setOriginal] = useState<TodoEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedHashes, setSelectedHashes] = useState<string[]>([]);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [pendingText, setPendingText] = useState('');
  const [editMessageText, setEditMessageText] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragged, setDragged] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuRequest | null>(null);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const pendingRef = useRef(pendingText);
  pendingRef.current = pendingText;
  const viewRef = useRef(view);
  viewRef.current = view;

  const apply = useCallback((next: RebaseView) => {
    const previous = viewRef.current;
    setView(next);
    // Edits made here survive a refresh as long as git still has the same commits left.
    if (!previous || previous.phase !== next.phase || !sameCommits(rowsRef.current, next.rows)) setRows(next.rows);
    setOriginal(next.rows);
    if (next.pendingMessage && next.pendingMessage.text !== previous?.pendingMessage?.text) setPendingText(next.pendingMessage.text);
    const focus = next.pendingMessage?.hash ?? next.pause?.hash;
    if (focus) {
      setSelected(focus);
      setSelectedHashes([focus]);
    }
  }, []);

  const call = useCallback(async <M extends 'init' | 'state' | 'start' | 'continue' | 'skip' | 'abort'>(method: M, params: RebaseMethods[M]['params']) => {
    setBusy(true);
    try {
      apply(await request(method, params));
    } catch {
      // The host has already shown the error; show where things stand now.
      await request('state', null).then(apply).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [apply]);

  useEffect(() => { void call('init', null); }, [call]);
  useEffect(() => onHostEvent((e) => {
    if (e.event === 'changed') void request('state', null).then(apply).catch(() => undefined);
  }), [apply]);

  // Suppress browser default context menu (Cut/Copy/Paste) across the panel, allowing it only on inputs.
  useEffect(() => {
    const suppress = (e: MouseEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
    };
    window.addEventListener('contextmenu', suppress);
    return () => window.removeEventListener('contextmenu', suppress);
  }, []);

  const [rebaseDetailHeight, onResizeRebaseDetail] = useDragResize(240, 'bnb.rebase.detailHeight', 120, 700, true);
  const [rebaseInfoWidth, onResizeRebaseInfo] = useDragResize(480, 'bnb.rebase.infoWidth', 200, 1200, false);

  const phase = view?.phase ?? 'plan';

  // Automatically close tab when rebase finishes.
  useEffect(() => {
    if (phase !== 'done') return undefined;
    const timer = setTimeout(() => {
      void request('close', null).catch(() => undefined);
    }, 350);
    return () => clearTimeout(timer);
  }, [phase]);
  const editable = (phase === 'plan' || phase === 'paused') && !busy;
  const problem = view && phase !== 'done' ? validateTodo(rows, phase !== 'plan' && view.done.length > 0) : undefined;
  const counts = countResult(rows);

  const start = useCallback(() => void call('start', { rows: rowsRef.current }), [call]);
  const goOn = useCallback(() => void call('continue', {
    rows: rowsRef.current, message: viewRef.current?.phase === 'message' ? pendingRef.current : undefined,
  }), [call]);
  const skip = useCallback(() => void call('skip', { rows: rowsRef.current }), [call]);

  const setAction = (index: number, action: TodoAction) =>
    setRows((list) => list.map((r, i) => (i === index && r.action !== 'other' ? { ...r, action } : r)));
  const setMessage = (index: number, message: string) =>
    setRows((list) => list.map((r, i) => (i === index ? { ...r, message } : r)));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rowsRef.current.length) return;
    setRows((list) => moveEntry(list, from, to));
  };

  // The host can press every control; the integration tests drive the view this way.
  useEffect(() => onHostEvent((e) => {
    if (e.event !== 'perform') return;
    const p = e as RebasePerform;
    const index = p.index ?? -1;
    if (p.action === 'setAction') setAction(index, p.value as TodoAction);
    else if (p.action === 'move') move(index, p.to ?? index);
    else if (p.action === 'setMessage' && p.index === undefined) setPendingText(p.value ?? '');
    else if (p.action === 'setMessage') setMessage(index, p.value ?? '');
    else if (p.action === 'squashAll') setRows((list) => squashAll(list));
    else if (p.action === 'reset') setRows(original);
    // State set by an earlier perform message is committed before these read it.
    else if (p.action === 'start') setTimeout(start);
    else if (p.action === 'continue') setTimeout(goOn);
    else if (p.action === 'skip') setTimeout(skip);
  }), [original, start, goOn, skip]);

  // Message and files of the selected commit.
  useEffect(() => {
    if (!selected) return setDetail(null);
    let current = true;
    void request('detail', { hash: selected }).then((d) => {
      if (current) {
        setDetail(d);
        setEditMessageText(d.message);
      }
    }).catch(() => undefined);
    return () => { current = false; };
  }, [selected]);

  // Tell the host what is on screen.
  useEffect(() => {
    if (!view) return;
    vscodeApi.postMessage({
      kind: 'event', event: 'state', phase: view.phase, busy,
      rows: rows.map((r) => ({ action: r.action, subject: r.subject })),
      done: view.done.length, incoming: counts.incoming, outgoing: counts.outgoing, problem,
      pause: view.pause?.kind, pendingMessage: view.phase === 'message' ? pendingText : undefined,
      errors: pageErrors,
    } satisfies RebaseState);
  }, [view, rows, busy, pendingText, problem, counts.incoming, counts.outgoing]);

  const handleAmendAndContinue = async () => {
    const customMessage = editMessageText.trim() && editMessageText.trim() !== detail?.message.trim()
      ? editMessageText.trim()
      : undefined;
    setBusy(true);
    try {
      apply(await request('amend', { message: customMessage }));
    } catch {
      await request('state', null).then(apply).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  if (!view) return <p className="muted pad">Loading…</p>;

  const selectedIndices = rows
    .map((r, i) => (r.hash && selectedHashes.includes(r.hash) ? i : -1))
    .filter((idx) => idx >= 0);

  const selectedIndex = rows.findIndex((r) => r.action !== 'other' && selected !== null && sameCommit(r.hash, selected));
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex] : undefined;
  const writable = editable && selectedRow && (selectedRow.action === 'reword' || selectedRow.action === 'squash');
  const pendingRow = view.pendingMessage && [...view.done].reverse().find((d) => view.pendingMessage!.hash && sameCommit(d.hash, view.pendingMessage!.hash));

  const setActionForSelected = (action: TodoAction) => {
    if (!selectedIndices.length) return;
    setRows((list) =>
      list.map((r, i) => (selectedIndices.includes(i) && r.action !== 'other' ? { ...r, action } : r))
    );
  };

  const combineSelected = (action: 'squash' | 'fixup') => {
    if (selectedIndices.length < 2) {
      if (selectedIndices.length === 1 && selectedIndices[0] > 0) {
        setAction(selectedIndices[0], action);
      }
      return;
    }
    const sorted = [...selectedIndices].sort((a, b) => a - b);
    const baseIndex = sorted[0];
    const squashed = sorted.slice(1);

    setRows((list) =>
      list.map((r, i) => {
        if (r.action === 'other') return r;
        if (squashed.includes(i)) return { ...r, action };
        if (i === baseIndex && (r.action === 'squash' || r.action === 'fixup')) return { ...r, action: 'pick' };
        return r;
      })
    );
  };

  const handleRowClick = (hash: string, index: number, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      setSelectedHashes((prev) => {
        const exists = prev.includes(hash);
        const next = exists ? prev.filter((h) => h !== hash) : [...prev, hash];
        return next.length > 0 ? next : [hash];
      });
      setSelected(hash);
    } else if (e.shiftKey && selectedIndex >= 0) {
      const min = Math.min(selectedIndex, index);
      const max = Math.max(selectedIndex, index);
      const range: string[] = [];
      for (let r = min; r <= max; r++) {
        const h = rows[r]?.hash;
        if (h) range.push(h);
      }
      setSelectedHashes(range);
      setSelected(hash);
    } else {
      setSelected(hash);
      setSelectedHashes([hash]);
    }
  };

  return (
    <div className="rebase">
      <header className="rebase-header">
        <div className="rebase-targets">
          <span className="rebase-icon" aria-hidden="true">☕</span>
          <span className="rebase-title">Rebase</span>
          <span className="rebase-badge branch" title={`Current branch: ${view.branch ?? 'Detached HEAD'}`}>
            {view.branch ?? 'Detached HEAD'}
          </span>
          <span className="rebase-onto-label">onto</span>
          <span className="rebase-badge onto" title={`Target: ${view.onto || '…'}`}>
            {view.onto || '…'}
          </span>
          {phase !== 'plan' && phase !== 'done' && (
            <span className="rebase-step-badge" role="status">
              Step {view.step} of {view.total}
            </span>
          )}
        </div>
        <div className="rebase-header-actions">
          {phase === 'plan' && (
            <button
              className="primary rebase-btn rebase-btn-start"
              disabled={busy || !!problem || !rows.length}
              onClick={start}
            >
              Start Rebase
            </button>
          )}
          {(phase === 'paused' || phase === 'message') && (
            <>
              <button
                className="primary rebase-btn"
                disabled={busy || !!problem}
                onClick={goOn}
              >
                Continue
              </button>
              <button
                className="rebase-btn"
                disabled={busy || phase === 'message'}
                onClick={skip}
                title="Leave out the commit the rebase stopped at"
              >
                Skip
              </button>
              <button
                className="rebase-btn rebase-btn-danger"
                disabled={busy}
                onClick={() => void call('abort', null)}
                title="Put the branch back where it was"
              >
                Abort…
              </button>
            </>
          )}
        </div>
      </header>

      {phase === 'done' && (
        <div className="rebase-banner banner-info">
          <span>✓ No rebase is running in <strong>{view.name}</strong>. Closing tab…</span>
          <span className="spacer" />
          <button className="rebase-btn" onClick={() => void request('close', null)}>Close</button>
        </div>
      )}
      {view.notice && <div className="rebase-banner banner-warn">{view.notice}</div>}
      {view.pause && (
        <div className="rebase-banner banner-warn">
          <span>{PAUSE_TEXT[view.pause.kind](view.pause.conflicts)}</span>
          <span className="spacer" />
          {view.pause.kind === 'conflict' && (
            <button className="rebase-btn rebase-btn-primary" onClick={() => void request('resolve', null)}>
              Resolve Conflicts…
            </button>
          )}
          {view.pause.kind === 'edit' && (
            <button
              className="primary rebase-btn"
              disabled={busy || !!problem}
              onClick={() => void handleAmendAndContinue()}
              title="Stage modified files, amend this commit, and continue rebase"
            >
              Amend & Continue
            </button>
          )}
          {phase === 'paused' && (
            <button className="rebase-btn" disabled={busy || !!problem} onClick={goOn} title="Continue without amending">
              Continue
            </button>
          )}
        </div>
      )}
      {phase === 'message' && (
        <div className="rebase-banner banner-warn">
          Git is waiting for the message of {pendingRow?.subject ? `"${pendingRow.subject}"` : 'this commit'}. Edit it below, then Continue.
        </div>
      )}
      {problem && <div className="rebase-banner banner-error" role="alert">{problem}</div>}
      {phase === 'plan' && !rows.length && (
        <div className="rebase-banner banner-info">
          There are no commits to rebase onto {view.onto}.
        </div>
      )}

      {phase !== 'done' && (
        <>
          <div className="rebase-tools-bar">
            <div className="tools-stats">
              <span className="stats-pill" role="status">
                {counts.incoming} {counts.incoming === 1 ? 'commit' : 'commits'} in → {counts.outgoing} out
              </span>
            </div>

            {editable && selectedIndices.length > 0 && (
              <div className="tools-quick-actions" role="group" aria-label="Selected commit actions">
                {selectedIndices.length === 1 ? (
                  <>
                    <span className="tools-quick-label">Action:</span>
                    {(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'] as const).map((act) => (
                      <button
                        key={act}
                        type="button"
                        className={`tool-action-btn action-${act}${selectedRow?.action === act ? ' active' : ''}`}
                        onClick={() => setAction(selectedIndex, act)}
                        title={`Set commit to ${act}`}
                      >
                        {act}
                      </button>
                    ))}
                    <span className="tools-divider" />
                    <button
                      type="button"
                      className="tool-btn"
                      disabled={selectedIndex === rows.length - 1}
                      onClick={() => move(selectedIndex, selectedIndex + 1)}
                      title="Move Up (Alt+↑)"
                    >
                      ↑ Up
                    </button>
                    <button
                      type="button"
                      className="tool-btn"
                      disabled={selectedIndex === 0}
                      onClick={() => move(selectedIndex, selectedIndex - 1)}
                      title="Move Down (Alt+↓)"
                    >
                      ↓ Down
                    </button>
                  </>
                ) : (
                  <>
                    <span className="tools-quick-label">{selectedIndices.length} commits selected:</span>
                    <button
                      type="button"
                      className="tool-action-btn action-pick"
                      onClick={() => setActionForSelected('pick')}
                      title="Set all selected commits to pick"
                    >
                      Pick All
                    </button>
                    <button
                      type="button"
                      className="tool-action-btn action-edit"
                      onClick={() => setActionForSelected('edit')}
                      title="Set all selected commits to edit"
                    >
                      Edit All
                    </button>
                    <button
                      type="button"
                      className="tool-action-btn action-squash"
                      onClick={() => combineSelected('squash')}
                      title="Combine selected commits into one (Squash)"
                    >
                      Squash (Combine)
                    </button>
                    <button
                      type="button"
                      className="tool-action-btn action-fixup"
                      onClick={() => combineSelected('fixup')}
                      title="Combine selected commits into one without keeping messages (Fixup)"
                    >
                      Fixup
                    </button>
                    <button
                      type="button"
                      className="tool-action-btn action-drop"
                      onClick={() => setActionForSelected('drop')}
                      title="Drop all selected commits"
                    >
                      Drop All
                    </button>
                  </>
                )}
              </div>
            )}

            <span className="spacer" />

            <div className="tools-batch-actions">
              <button
                type="button"
                className="tool-btn"
                disabled={!editable || rows.length < 2}
                onClick={() => setRows((l) => squashAll(l))}
                title="Squash all commits into the base commit"
              >
                Squash All
              </button>
              <button
                type="button"
                className="tool-btn"
                disabled={!editable}
                onClick={() => setRows(original)}
                title="Back to the list as it was loaded"
              >
                Reset
              </button>
            </div>
          </div>

          <div className="rebase-table" role="table" aria-label="Commits to rebase, newest first">
            <div className="row head" role="row">
              <span className="col-num">#</span>
              <span className="col-action">Action</span>
              <span className="col-hash">Hash</span>
              <span className="col-subject">Commit Message</span>
            </div>
            <div className="rows">
              {[...rows].map((r, i) => ({ r, i })).reverse().map(({ r, i }, visualIndex) => {
                const isSelected = r.hash ? selectedHashes.includes(r.hash) : (i === selectedIndex);
                const isSquashOrFixup = r.action === 'squash' || r.action === 'fixup';
                return (
                  <div
                    key={r.hash || `other-${i}`}
                    role="row"
                    tabIndex={0}
                    className={`row a-${r.action}${isSelected ? ' selected' : ''}${dragged === i ? ' dragged' : ''}`}
                    draggable={editable}
                    onDragStart={(e) => { setDragged(i); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragOver={(e) => { if (dragged !== null) e.preventDefault(); }}
                    onDrop={(e) => { e.preventDefault(); if (dragged !== null) move(dragged, i); setDragged(null); }}
                    onDragEnd={() => setDragged(null)}
                    onClick={(e) => r.hash && handleRowClick(r.hash, i, e)}
                    onFocus={() => {
                      if (r.hash && selected !== r.hash) {
                        setSelected(r.hash);
                        if (!selectedHashes.includes(r.hash)) setSelectedHashes([r.hash]);
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const hash = r.hash;
                      const isMulti = selectedHashes.length > 1 && hash && selectedHashes.includes(hash);
                      if (!isMulti && hash) {
                        setSelected(hash);
                        setSelectedHashes([hash]);
                      }
                      const items: MenuItem[] = [];
                      if (isMulti) {
                        const count = selectedHashes.length;
                        if (editable) {
                          items.push(
                            { label: `Combine into one (Squash ${count} commits)`, run: () => combineSelected('squash') },
                            { label: `Combine into one (Fixup - discard messages)`, run: () => combineSelected('fixup') },
                            'separator',
                            { label: `Pick selected commits (${count})`, run: () => setActionForSelected('pick') },
                            { label: `Edit selected commits (${count})`, run: () => setActionForSelected('edit') },
                            { label: `Drop selected commits (${count})`, run: () => setActionForSelected('drop') },
                            'separator',
                          );
                        }
                        items.push(
                          {
                            label: `Copy Hashes (${count})`,
                            run: () => void navigator.clipboard?.writeText(selectedHashes.join('\n')),
                          },
                          {
                            label: `Copy Messages (${count})`,
                            run: () => {
                              const msgs = rows
                                .filter((row) => row.hash && selectedHashes.includes(row.hash))
                                .map((row) => row.subject);
                              void navigator.clipboard?.writeText(msgs.join('\n'));
                            },
                          },
                        );
                      } else {
                        if (editable && r.action !== 'other') {
                          items.push(
                            { label: 'Pick', run: () => setAction(i, 'pick') },
                            { label: 'Reword', run: () => setAction(i, 'reword') },
                            { label: 'Edit', run: () => setAction(i, 'edit') },
                            { label: 'Squash (into commit below)', run: () => setAction(i, 'squash') },
                            { label: 'Fixup (into commit below)', run: () => setAction(i, 'fixup') },
                            { label: 'Drop', run: () => setAction(i, 'drop') },
                            'separator',
                            { label: 'Move Up (Alt+↑)', run: () => move(i, i + 1) },
                            { label: 'Move Down (Alt+↓)', run: () => move(i, i - 1) },
                            'separator',
                          );
                        }
                        if (r.hash) {
                          items.push(
                            { label: 'Copy Hash', run: () => void navigator.clipboard?.writeText(r.hash) },
                            { label: 'Copy Message', run: () => void navigator.clipboard?.writeText(r.subject) },
                          );
                        }
                      }
                      setMenu({ x: e.clientX, y: e.clientY, returnFocus: e.currentTarget, items });
                    }}
                    onKeyDown={(e) => {
                      if (!editable) return;
                      if (e.altKey && e.key === 'ArrowUp') {
                        e.preventDefault();
                        move(i, i + 1);
                      } else if (e.altKey && e.key === 'ArrowDown') {
                        e.preventDefault();
                        move(i, i - 1);
                      } else if (!e.altKey && !e.ctrlKey && !e.metaKey) {
                        const k = e.key.toLowerCase();
                        if (selectedIndices.length > 1) {
                          if (k === 'p') setActionForSelected('pick');
                          else if (k === 's') combineSelected('squash');
                          else if (k === 'f') combineSelected('fixup');
                          else if (k === 'd') setActionForSelected('drop');
                          else if (k === 'e') setActionForSelected('edit');
                        } else {
                          if (k === 'p') setAction(i, 'pick');
                          else if (k === 'r') setAction(i, 'reword');
                          else if (k === 's') setAction(i, 'squash');
                          else if (k === 'f') setAction(i, 'fixup');
                          else if (k === 'd') setAction(i, 'drop');
                          else if (k === 'e') setAction(i, 'edit');
                        }
                      }
                    }}
                  >
                    <span className="col-num">
                      <span className="drag-handle" title="Drag to reorder">⋮⋮</span>
                      <span className="num-text">{visualIndex + 1}</span>
                    </span>
                    <span className="col-action">
                      {r.action === 'other' ? (
                        <span className="action-pill action-other">(kept)</span>
                      ) : (
                        <div className={`action-badge-wrapper action-${r.action}`}>
                          <select
                            value={r.action}
                            disabled={!editable}
                            aria-label={`Action for ${r.subject}`}
                            onChange={(e) => setAction(i, e.target.value as TodoAction)}
                            className="action-select"
                          >
                            {ACTIONS.map((a) => (
                              <option key={a} value={a}>
                                {a}
                              </option>
                            ))}
                          </select>
                          <span className="action-pill-text">{r.action}</span>
                          <span className="action-caret">▾</span>
                        </div>
                      )}
                    </span>
                    <span className="col-hash">
                      <code className="hash-pill">{short(r.hash)}</code>
                    </span>
                    <span className="col-subject">
                      {isSquashOrFixup && (
                        <span className="squash-arrow" title={`Merged into commit below (${r.action})`}>↴</span>
                      )}
                      <span className="subject-text">{r.subject}</span>
                      {r.message && r.message !== r.subject && (
                        <span className="edited-badge" title="Commit message modified">edited</span>
                      )}
                    </span>
                  </div>
                );
              })}
              {[...view.done].reverse().map((d, doneIdx) => (
                <div
                  key={`done-${doneIdx}`}
                  role="row"
                  className={`row done${selected && sameCommit(d.hash, selected) ? ' selected' : ''}`}
                  onClick={() => d.hash && setSelected(d.hash)}
                >
                  <span className="col-num">{rows.length + doneIdx + 1}</span>
                  <span className="col-action">
                    <span className="action-pill action-done">✓ done</span>
                  </span>
                  <span className="col-hash">
                    <code className="hash-pill">{short(d.hash)}</code>
                  </span>
                  <span className="col-subject">{d.subject}</span>
                </div>
              ))}
            </div>
          </div>

          <Sash orientation="horizontal" onMouseDown={(e) => onResizeRebaseDetail(e, 'horizontal')} title="Drag to resize table and detail" />
          <section className="detail" style={{ height: `${rebaseDetailHeight}px`, minHeight: '120px', flexShrink: 0 }}>
            <div className="info" style={{ width: `${rebaseInfoWidth}px` }}>
              {detail ? (
                <>
                  <div className="commit-header">
                    <div className="commit-avatar" title={detail.author}>
                      {(detail.author || '?').trim()[0].toUpperCase()}
                    </div>
                    <div className="commit-subject">
                      {detail.message.split('\n')[0] ?? ''}
                    </div>
                  </div>
                  <dl className="commit-meta">
                    <dt>Commit:</dt>
                    <dd className="hash">
                      {detail.hash} <span className="short-hash">[{detail.hash.slice(0, 7)}]</span>
                    </dd>
                    {detail.parents.length > 0 && (
                      <>
                        <dt>Parents:</dt>
                        <dd className="parents">
                          {detail.parents.map((p, idx) => (
                            <span key={p} className="parent-link" title={p}>
                              {idx > 0 && ' '}
                              {p.slice(0, 10)}
                            </span>
                          ))}
                        </dd>
                      </>
                    )}
                    <dt>Author:</dt>
                    <dd>{formatPerson(detail.author, detail.email)}</dd>
                    {(detail.committer && (detail.committer !== detail.author || detail.committerEmail !== detail.email)) ? (
                      <>
                        <dt>Committer:</dt>
                        <dd>{formatPerson(detail.committer, detail.committerEmail)}</dd>
                      </>
                    ) : null}
                    <dt>Date:</dt>
                    <dd>{formatFullDate(detail.date)}</dd>
                  </dl>

                  {phase === 'message' ? (
                    <div className="editor-container">
                      <div className="editor-label">Edit Commit Message (git is waiting for this message):</div>
                      <textarea
                        aria-label="Commit message"
                        value={pendingText}
                        disabled={busy}
                        onChange={(e) => setPendingText(e.target.value)}
                        rows={6}
                      />
                    </div>
                  ) : (view.pause?.kind === 'edit' && selected === view.pause.hash) ? (
                    <div className="editor-container">
                      <div className="editor-label">Edit Commit Message (optional, will be used when clicking Amend & Continue):</div>
                      <textarea
                        aria-label="Commit message for amend"
                        value={editMessageText}
                        disabled={busy}
                        onChange={(e) => setEditMessageText(e.target.value)}
                        rows={6}
                      />
                    </div>
                  ) : writable ? (
                    <div className="editor-container">
                      <div className="editor-label">
                        {selectedRow?.action === 'squash' ? 'Combined Commit Message:' : 'New Commit Message:'}
                      </div>
                      <textarea
                        aria-label={`New message for ${selectedRow?.subject}`}
                        placeholder={
                          selectedRow?.action === 'squash'
                            ? 'Message of the combined commit. Leave empty to write it when the rebase gets here.'
                            : 'New message. Leave empty to write it when the rebase gets here.'
                        }
                        value={selectedRow?.message ?? (selectedRow?.action === 'reword' ? detail.message : '')}
                        onChange={(e) => setMessage(selectedIndex, e.target.value)}
                        rows={6}
                      />
                    </div>
                  ) : (
                    detail.message.split('\n').slice(1).join('\n').trim() ? (
                      <pre className="body">{detail.message.split('\n').slice(1).join('\n').trim()}</pre>
                    ) : null
                  )}
                </>
              ) : (
                <p className="muted pad">Select a commit to see its message and files. Choose <strong>reword</strong> or <strong>squash</strong> to edit the message.</p>
              )}
            </div>

            <Sash orientation="vertical" onMouseDown={(e) => onResizeRebaseInfo(e, 'vertical')} title="Drag to resize commit info and files" />

            <div className="changed">
              {detail ? (
                (() => {
                  const isEditing = view.pause?.kind === 'edit' && selected !== null && !!view.pause.hash && sameCommit(selected, view.pause.hash);
                  return (
                    <>
                      <h2>
                        {detail.files.length} changed {detail.files.length === 1 ? 'file' : 'files'}
                        <span className="files-hint">{isEditing ? '(click to edit, double-click to diff)' : '(double-click to diff)'}</span>
                      </h2>
                      {detail.files.length ? (
                        <ul className={`files${isEditing ? ' editable' : ''}`}>
                          {detail.files.map((f) => {
                            const statusLetter = f.status.replace(/[^A-Z]/g, '')[0] ?? 'M';
                            return (
                              <li
                                key={f.path}
                                tabIndex={0}
                                title={isEditing
                                  ? `${f.oldPath ? `${f.oldPath} → ` : ''}${f.path} (Click to open file in editor, double-click to diff)`
                                  : `${f.oldPath ? `${f.oldPath} → ` : ''}${f.path} (Double-click to diff)`}
                                onClick={() => {
                                  if (isEditing) void request('open', { path: f.path });
                                }}
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  void request('diff', { hash: detail.hash, path: f.path, oldPath: f.oldPath });
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    if (isEditing) void request('open', { path: f.path });
                                    else void request('diff', { hash: detail.hash, path: f.path, oldPath: f.oldPath });
                                  }
                                }}
                              >
                                <span className={`status s-${statusLetter}`}>{f.status}</span>
                                <span className="path">{f.path}</span>
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <p className="muted">No files changed.</p>
                      )}
                    </>
                  );
                })()
              ) : (
                <p className="muted pad">Select a commit to inspect changed files.</p>
              )}
            </div>
          </section>
        </>
      )}
      {menu && <ContextMenu request={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
