import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { isStaged, isUnstaged } from '../../core/git/changeState';
import type { CommitDetail, FileAction, WorkingChange } from '../../shared/protocol';
import { isMenuKey } from '../ui/ContextMenu';
import { changeLetters, formatFullDate, formatPerson } from './format';

export interface FileRow {
  path: string;
  oldPath?: string;
  /** Status letters shown in front of the path. */
  letters: string;
  change?: WorkingChange;
}

type OnFile = (action: FileAction, file: FileRow) => void;
type OnFileMenu = (file: FileRow, x: number, y: number, returnFocus: HTMLElement) => void;

/** A file list where Enter or a double click shows the diff and the Menu key opens the file menu. */
function FileList({ files, onFile, onMenu, buttons }: {
  files: FileRow[]; onFile: OnFile; onMenu: OnFileMenu; buttons?: (file: FileRow) => ReactNode;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>, file: FileRow) => {
    const li = e.currentTarget;
    if (e.target !== li) return; // a key pressed on one of the row's buttons
    if (e.key === 'Enter') onFile('diff', file);
    else if (isMenuKey(e)) {
      const box = li.getBoundingClientRect();
      onMenu(file, box.left + 40, box.bottom, li);
    } else if (e.key === 'ArrowDown') (li.nextElementSibling as HTMLElement | null)?.focus();
    else if (e.key === 'ArrowUp') (li.previousElementSibling as HTMLElement | null)?.focus();
    else return;
    e.preventDefault();
  };
  const onContextMenu = (e: MouseEvent<HTMLLIElement>, file: FileRow) => {
    e.preventDefault();
    onMenu(file, e.clientX, e.clientY, e.currentTarget);
  };
  if (!files.length) return <p className="muted">No files changed.</p>;
  return (
    <ul className="files">
      {files.map((f) => (
        <li
          key={f.path} tabIndex={0} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
          onDoubleClick={() => onFile('diff', f)} onKeyDown={(e) => onKeyDown(e, f)} onContextMenu={(e) => onContextMenu(e, f)}
        >
          <span className={`status s-${f.letters.replace(/[^A-Z]/g, '')[0] ?? 'U'}`}>{f.letters}</span>
          <span className="path">{f.path}</span>
          {buttons?.(f)}
        </li>
      ))}
    </ul>
  );
}

/** Detail area for a commit: who, when, the full message, and its changed files, styled like SourceTree. */
export function CommitDetailView({
  detail, labels = [], onFile, onMenu,
}: {
  detail: CommitDetail;
  labels?: string[];
  onFile: OnFile;
  onMenu: OnFileMenu;
}) {
  const files = detail.files.map((f): FileRow => ({ path: f.path, oldPath: f.oldPath, letters: f.status }));
  const lines = detail.message.split('\n');
  const subject = lines[0] ?? '';
  const body = lines.slice(1).join('\n').trim();
  const initial = (detail.author || '?').trim()[0].toUpperCase();
  const cleanLabels = labels.map((l) => l.replace(/^HEAD -> /, '').replace(/^tag: /, ''));

  return (
    <section className="detail">
      <div className="info">
        <div className="commit-header">
          <div className="commit-avatar" title={detail.author}>{initial}</div>
          <div className="commit-subject">{subject}</div>
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
          {cleanLabels.length > 0 && (
            <>
              <dt>Labels:</dt>
              <dd className="labels">
                {cleanLabels.map((l) => (
                  <span key={l} className="label-badge">{l}</span>
                ))}
              </dd>
            </>
          )}
        </dl>
        {body && <pre className="body">{body}</pre>}
      </div>
      <div className="changed">
        <h2>{files.length} changed {files.length === 1 ? 'file' : 'files'}{detail.parents.length > 1 ? ' (against the first parent)' : ''}</h2>
        <FileList files={files} onFile={onFile} onMenu={onMenu} />
      </div>
    </section>
  );
}

/** Detail area for the uncommitted-changes row: working tree files with stage, unstage, discard. */
export function WorkingTreeView({ changes, onFile, onMenu }: { changes: WorkingChange[]; onFile: OnFile; onMenu: OnFileMenu }) {
  const files = changes.map((c): FileRow => ({ path: c.path, oldPath: c.oldPath, letters: changeLetters(c), change: c }));
  return (
    <section className="detail single">
      <div className="changed">
        <h2>
          {files.length} uncommitted {files.length === 1 ? 'file' : 'files'}
          <span className="muted"> — first letter staged, second not staged</span>
        </h2>
        <FileList
          files={files} onFile={onFile} onMenu={onMenu}
          buttons={(f) => (
            <span className="actions">
              {f.change!.conflicted
                ? <button onClick={() => onFile('resolve', f)}>Resolve</button>
                : isUnstaged(f.change!) && <button onClick={() => onFile('stage', f)}>Stage</button>}
              {isStaged(f.change!) && <button onClick={() => onFile('unstage', f)}>Unstage</button>}
              <button onClick={() => onFile('discard', f)}>Discard</button>
            </span>
          )}
        />
      </div>
    </section>
  );
}
