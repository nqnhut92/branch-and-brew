import { useEffect, useState } from 'react';
import type { CloneStatus } from '../../shared/protocol';
import { BrewingCup } from '../ui/BrewingCup';
import '../ui/brewing.css';

export interface CloneItem {
  url: string;
  name: string;
  status: CloneStatus;
  percent: number;
  phase?: string;
  error?: string;
}

const ICON: Record<CloneStatus, string> = { queued: '○', cloning: '◐', done: '✓', error: '✗', cancelled: '–' };
const LABEL: Record<CloneStatus, string> = { queued: 'Waiting', cloning: 'Cloning', done: 'Done', error: 'Failed', cancelled: 'Cancelled' };

const formatTime = (total: number) => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

interface Props {
  items: CloneItem[];
  destination?: string;
  group?: string;
  onCancel: (url?: string) => void;
  onRetry: (urls: string[]) => void;
  onClose: () => void;
}

/** One row per repository with its own bar; the same look as the brewing dialog of a git action. */
export function CloneProgressDialog({ items, destination, group, onCancel, onRetry, onClose }: Props) {
  const working = items.some((i) => i.status === 'queued' || i.status === 'cloning');
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!working) return undefined;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [working]);

  const count = (s: CloneStatus) => items.filter((i) => i.status === s).length;
  const failed = items.filter((i) => i.status === 'error' || i.status === 'cancelled').map((i) => i.url);
  const overall = items.length ? Math.round(items.reduce((sum, i) => sum + (i.status === 'done' ? 100 : i.percent), 0) / items.length) : 0;
  const title = working ? 'Brewing…' : count('error') ? 'Brew Finished with Failures' : count('done') === items.length ? 'Brew Complete' : 'Brew Stopped';
  const summary = [`${count('done')} of ${items.length} done`, count('error') ? `${count('error')} failed` : '', count('cancelled') ? `${count('cancelled')} cancelled` : '']
    .filter(Boolean).join(' · ');

  return (
    <div className="brewing-overlay" role="dialog" aria-modal="true" aria-label="Cloning">
      <div className="brewing-window clone-window">
        <div className="brewing-header">
          <div className="brewing-cup-container"><BrewingCup active={working} /></div>
          <div className="brewing-title-block">
            <div className="brewing-title-row">
              <span className="brewing-main-title">{title}</span>
              <span className="brewing-timer" title="Elapsed time">{formatTime(seconds)}</span>
            </div>
            <div className="brewing-repo-row">
              <span className="brewing-repo-badge">{summary}</span>
              {destination && <span className="clone-dest" title={destination}>{destination}{group ? ` · ${group}` : ''}</span>}
            </div>
          </div>
        </div>

        <div className="clone-overall" aria-hidden="true"><div style={{ width: `${overall}%` }} /></div>

        <ul className="clone-rows">
          {items.map((i) => (
            <li key={i.url} className={`clone-row clone-${i.status}`}>
              <span className="clone-icon" aria-hidden="true">{ICON[i.status]}</span>
              <span className="clone-name" title={i.name}>{i.name}</span>
              <span className="clone-state">
                {i.status === 'cloning' ? `${i.phase ?? 'Cloning'} · ${i.percent}%` : LABEL[i.status]}
              </span>
              {(i.status === 'queued' || i.status === 'cloning') && (
                <button type="button" className="clone-x" title="Cancel this clone" aria-label={`Cancel ${i.name}`} onClick={() => onCancel(i.url)}>×</button>
              )}
              {i.status === 'cloning' && <div className="clone-bar"><div style={{ width: `${i.percent}%` }} /></div>}
              {i.error && <div className="clone-msg">{i.error}</div>}
            </li>
          ))}
        </ul>

        <div className="brewing-footer">
          <span className="clone-note">{working ? 'Three at a time.' : ''}</span>
          <div className="brewing-actions">
            {working && <button type="button" className="brewing-btn" onClick={() => onCancel()}>Cancel All</button>}
            {!working && failed.length > 0 && (
              <button type="button" className="brewing-btn brewing-btn-primary" onClick={() => onRetry(failed)}>Retry {failed.length}</button>
            )}
            <button type="button" className="brewing-btn" onClick={onClose} disabled={working}>{working ? 'Working…' : 'Close'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
