import { useEffect, useRef, useState } from 'react';
import { BrewingCup } from './BrewingCup';
import './brewing.css';

export interface BrewingDialogProps {
  title: string;
  repoName: string;
  command: string;
  status: 'brewing' | 'success' | 'error';
  output: string;
  error?: string;
  onClose: () => void;
  onResolveConflicts?: () => void;
  hasConflicts?: boolean;
}

export function BrewingDialog({
  title,
  repoName,
  command,
  status,
  output,
  error,
  onClose,
  onResolveConflicts,
  hasConflicts,
}: BrewingDialogProps) {
  const consoleRef = useRef<HTMLPreElement | null>(null);
  const [autoClose, setAutoClose] = useState(() => {
    try {
      return localStorage.getItem('branchAndBrew.brewing.autoClose') === 'true';
    } catch {
      return false;
    }
  });
  const [seconds, setSeconds] = useState(0);

  // Auto-scroll console to bottom as output streams in
  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [output]);

  // Elapsed timer
  useEffect(() => {
    if (status !== 'brewing') return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);

  // Auto-close on success if option is enabled
  useEffect(() => {
    if (status === 'success' && autoClose) {
      const timer = setTimeout(() => {
        onClose();
      }, 1500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [status, autoClose, onClose]);

  const toggleAutoClose = (checked: boolean) => {
    setAutoClose(checked);
    try {
      localStorage.setItem('branchAndBrew.brewing.autoClose', checked ? 'true' : 'false');
    } catch {
      // Ignore storage errors in sandboxed webviews
    }
  };

  const formatTime = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const isConflicted =
    status !== 'success' &&
    (hasConflicts ??
      (status === 'error' &&
        (/^CONFLICT \(/m.test(output) ||
          /Automatic merge failed/i.test(output) ||
          /conflict/i.test(error ?? '')))) &&
    !!onResolveConflicts;

  return (
    <div className="brewing-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="brewing-window">
        {/* Header */}
        <div className="brewing-header">
          <div className="brewing-cup-container">
            <BrewingCup active={status === 'brewing'} />
          </div>

          <div className="brewing-title-block">
            <div className="brewing-title-row">
              <span className="brewing-main-title">
                {status === 'brewing' ? 'Brewing…' : status === 'success' ? 'Brew Complete' : 'Brew Failed'}
              </span>
              <span className="brewing-timer" title="Elapsed time">
                {formatTime(seconds)}
              </span>
            </div>
            {repoName && (
              <div className="brewing-repo-row">
                <span className="brewing-repo-badge">{repoName}</span>
              </div>
            )}
          </div>
        </div>

        {/* Live Terminal Log */}
        <div className="brewing-console-wrapper">
          <pre ref={consoleRef} className="brewing-console">
            {command && <div className="line line-cmd">{command}</div>}
            {output ? (
              output.split('\n').map((line, idx) => {
                let lineClass = 'line';
                if (/^(remote:\s*)?(fatal|error):/i.test(line)) lineClass += ' line-error';
                else if (/^(remote:\s*)?(warning):/i.test(line) || /^\s*\*\*/i.test(line)) lineClass += ' line-warning';
                else if (/already up to date|fast-forward|switched to|merged/i.test(line)) lineClass += ' line-success';
                else if (/^(\s*[\d]+%|counting|compressing|writing|enumerating)/i.test(line)) lineClass += ' line-progress';
                return (
                  <div key={idx} className={lineClass}>
                    {line || ' '}
                  </div>
                );
              })
            ) : (
              <span className="brewing-placeholder">Pouring git output…</span>
            )}
            {error && <div className="line line-error">Error: {error}</div>}
          </pre>
        </div>

        {/* Footer */}
        <div className="brewing-footer">
          <label className="brewing-autoclose">
            <input
              type="checkbox"
              checked={autoClose}
              onChange={(e) => toggleAutoClose(e.target.checked)}
            />
            <span>Close when finished</span>
          </label>

          <div className="brewing-actions">
            {isConflicted && (
              <button
                type="button"
                className="brewing-btn brewing-btn-primary"
                onClick={onResolveConflicts}
              >
                Resolve Conflicts
              </button>
            )}
            <button
              type="button"
              className="brewing-btn"
              onClick={onClose}
              disabled={status === 'brewing'}
            >
              {status === 'brewing' ? 'Working…' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
