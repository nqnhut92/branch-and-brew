import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ACTIONS, countResult, moveEntry, sameCommit, squashAll, validateTodo, type TodoAction, type TodoEntry,
} from '../../core/rebase/todo';
import type { CommitDetail, RebaseMethods, RebasePerform, RebaseState, RebaseView } from '../../shared/protocol';
import { createClient, onHostEvent, pageErrors, vscodeApi } from '../ui/rpc';
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
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [pendingText, setPendingText] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragged, setDragged] = useState<number | null>(null);

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
    if (focus) setSelected(focus);
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

  const phase = view?.phase ?? 'plan';
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
  const move = (from: number, to: number) => setRows((list) => moveEntry(list, from, to));

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
    void request('detail', { hash: selected }).then((d) => { if (current) setDetail(d); }).catch(() => undefined);
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

  if (!view) return <p className="muted pad">Loading…</p>;

  const selectedIndex = rows.findIndex((r) => r.action !== 'other' && selected !== null && sameCommit(r.hash, selected));
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex] : undefined;
  const writable = editable && selectedRow && (selectedRow.action === 'reword' || selectedRow.action === 'squash');
  const pendingRow = view.pendingMessage && [...view.done].reverse().find((d) => view.pendingMessage!.hash && sameCommit(d.hash, view.pendingMessage!.hash));

  return (
    <div className="rebase">
      <header className="toolbar">
        <strong>{view.branch ?? 'Detached HEAD'}</strong>
        <span className="muted">onto {view.onto || '…'}</span>
        {phase !== 'plan' && phase !== 'done' && <span className="step" role="status">Step {view.step} of {view.total}</span>}
        <span className="spacer" />
        {phase === 'plan' && <button className="primary" disabled={busy || !!problem || !rows.length} onClick={start}>Start Rebase</button>}
        {(phase === 'paused' || phase === 'message') && (
          <>
            <button className="primary" disabled={busy || !!problem} onClick={goOn}>Continue</button>
            <button disabled={busy || phase === 'message'} onClick={skip} title="Leave out the commit the rebase stopped at">Skip</button>
            <button disabled={busy} onClick={() => void call('abort', null)} title="Put the branch back where it was">Abort…</button>
          </>
        )}
      </header>

      {phase === 'done' && <p className="banner">No rebase is running in {view.name}. This tab can be closed.</p>}
      {view.notice && <p className="banner warn">{view.notice}</p>}
      {view.pause && (
        <p className="banner warn">
          {PAUSE_TEXT[view.pause.kind](view.pause.conflicts)}
          <span className="spacer" />
          {view.pause.kind === 'conflict' && <button onClick={() => void request('resolve', null)}>Resolve Conflicts…</button>}
          {/* Resolving the files is the work the banner asks for; Continue is right here, not only in the toolbar. */}
          {phase === 'paused' && (
            <button className="primary" disabled={busy || !!problem} onClick={goOn}>Continue</button>
          )}
        </p>
      )}
      {phase === 'message' && <p className="banner warn">Git is waiting for the message of {pendingRow?.subject ? `"${pendingRow.subject}"` : 'this commit'}. Edit it below, then Continue.</p>}
      {problem && <p className="banner error" role="alert">{problem}</p>}
      {phase === 'plan' && !rows.length && <p className="banner">There are no commits to rebase onto {view.onto}.</p>}

      {phase !== 'done' && (
        <>
          <div className="tools">
            <span className="muted" role="status">
              {counts.incoming} {counts.incoming === 1 ? 'commit' : 'commits'} in, {counts.outgoing} out
            </span>
            <span className="spacer" />
            <button disabled={!editable || rows.length < 2} onClick={() => setRows((l) => squashAll(l))}>Squash All</button>
            <button disabled={!editable} onClick={() => setRows(original)} title="Back to the list as it was loaded">Reset</button>
          </div>
          <div className="table" role="table" aria-label="Commits to rebase, oldest first">
            <div className="row head" role="row">
              <span>#</span><span>Action</span><span>Hash</span><span>Message</span><span>Move</span>
            </div>
            <div className="rows">
              {view.done.map((d, i) => (
                <div
                  key={`done-${i}`} role="row" className={`row done${selected && sameCommit(d.hash, selected) ? ' selected' : ''}`}
                  onClick={() => d.hash && setSelected(d.hash)}
                >
                  <span>{i + 1}</span><span>{d.action === 'other' ? '' : d.action}</span>
                  <span className="hash">{short(d.hash)}</span><span className="subject">{d.subject}</span><span>done</span>
                </div>
              ))}
              {rows.map((r, i) => (
                <div
                  key={r.hash || `other-${i}`} role="row" tabIndex={0}
                  className={`row a-${r.action}${i === selectedIndex ? ' selected' : ''}${dragged === i ? ' dragged' : ''}`}
                  draggable={editable}
                  onDragStart={(e) => { setDragged(i); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={(e) => { if (dragged !== null) e.preventDefault(); }}
                  onDrop={(e) => { e.preventDefault(); if (dragged !== null) move(dragged, i); setDragged(null); }}
                  onDragEnd={() => setDragged(null)}
                  onClick={() => r.hash && setSelected(r.hash)}
                  onFocus={() => r.hash && setSelected(r.hash)}
                  onKeyDown={(e) => {
                    if (!editable || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                    e.preventDefault();
                    move(i, i + (e.key === 'ArrowUp' ? -1 : 1));
                  }}
                >
                  <span>{view.done.length + i + 1}</span>
                  {r.action === 'other'
                    ? <span className="muted">(kept)</span>
                    : (
                      <select
                        value={r.action} disabled={!editable} aria-label={`Action for ${r.subject}`}
                        onChange={(e) => setAction(i, e.target.value as TodoAction)}
                      >
                        {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                      </select>
                    )}
                  <span className="hash">{short(r.hash)}</span>
                  <span className="subject">{r.subject}</span>
                  <span className="move">
                    <button disabled={!editable || i === 0} onClick={(e) => { e.stopPropagation(); move(i, i - 1); }} aria-label="Move up" title="Move up (Alt+Up)">↑</button>
                    <button disabled={!editable || i === rows.length - 1} onClick={(e) => { e.stopPropagation(); move(i, i + 1); }} aria-label="Move down" title="Move down (Alt+Down)">↓</button>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <section className="detail">
            <div className="message">
              {phase === 'message'
                ? <textarea aria-label="Commit message" value={pendingText} disabled={busy} onChange={(e) => setPendingText(e.target.value)} />
                : writable
                  ? (
                    <textarea
                      aria-label={`New message for ${selectedRow.subject}`}
                      placeholder={selectedRow.action === 'squash'
                        ? 'Message of the combined commit. Leave empty to write it when the rebase gets here.'
                        : 'New message. Leave empty to write it when the rebase gets here.'}
                      value={selectedRow.message ?? (selectedRow.action === 'reword' ? detail?.message ?? '' : '')}
                      onChange={(e) => setMessage(selectedIndex, e.target.value)}
                    />
                  )
                  : detail
                    ? <pre>{detail.message}</pre>
                    : <p className="muted">Select a commit to see its message and files. Choose reword or squash to edit the message.</p>}
            </div>
            <div className="files-pane">
              {detail && (detail.files.length
                ? (
                  <ul className="files">
                    {detail.files.map((f) => (
                      <li
                        key={f.path} tabIndex={0} title={`${f.oldPath ? `${f.oldPath} → ` : ''}${f.path} (Enter or double click shows the change)`}
                        onDoubleClick={() => void request('diff', { hash: detail.hash, path: f.path, oldPath: f.oldPath })}
                        onKeyDown={(e) => { if (e.key === 'Enter') void request('diff', { hash: detail.hash, path: f.path, oldPath: f.oldPath }); }}
                      >
                        <span className="status">{f.status}</span><span className="path">{f.path}</span>
                      </li>
                    ))}
                  </ul>
                )
                : <p className="muted">No files changed.</p>)}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
