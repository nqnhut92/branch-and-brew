import { useEffect, useRef, useState } from 'react';
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
      return localStorage.getItem('branchAndBrew.brewing.autoClose') !== 'false';
    } catch {
      return true;
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

  return (
    <div className="brewing-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="brewing-window">
        {/* Header */}
        <div className="brewing-header">
          <div className="brewing-cup-container">
            <svg
              className={`brewing-cup ${status === 'brewing' ? 'active' : ''}`}
              viewBox="0 0 48 48"
              width="44"
              height="44"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* Animated Steam */}
              <g className="steam-group">
                <path
                  className="steam steam-1"
                  d="M17 19 C15 14, 19 11, 16 6"
                  stroke="var(--vscode-charts-orange, #e08b38)"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <path
                  className="steam steam-2"
                  d="M23 18 C21 13, 26 10, 23 5"
                  stroke="var(--vscode-charts-orange, #e08b38)"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
                <path
                  className="steam steam-3"
                  d="M29 19 C27 14, 31 11, 28 6"
                  stroke="var(--vscode-charts-orange, #e08b38)"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </g>

              {/* Coffee Mug */}
              <path
                d="M12 20 H34 V32 C34 37 30 40 23 40 C16 40 12 37 12 32 Z"
                fill="var(--vscode-button-secondaryBackground, #383838)"
                stroke="var(--vscode-foreground, #cccccc)"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              {/* Coffee surface */}
              <ellipse
                cx="23"
                cy="22"
                rx="9.5"
                ry="2.5"
                fill="var(--vscode-charts-yellow, #d9822b)"
              />
              {/* Handle */}
              <path
                d="M34 23 C39 23 41 26 41 29 C41 33 38 35 34 35"
                stroke="var(--vscode-foreground, #cccccc)"
                strokeWidth="2.5"
                strokeLinecap="round"
                fill="none"
              />
              {/* Saucer */}
              <path
                d="M8 42 C14 44 32 44 38 42"
                stroke="var(--vscode-foreground, #cccccc)"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
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
            <div className="brewing-cmd" title={command}>
              <span className="brewing-repo-badge">{repoName}</span>
              <code>{command}</code>
            </div>
          </div>
        </div>

        {/* Live Terminal Log */}
        <div className="brewing-console-wrapper">
          <pre ref={consoleRef} className="brewing-console">
            {output ? (
              output.split('\n').map((line, idx) => {
                let lineClass = 'line';
                if (/^(fatal|error):/i.test(line)) lineClass += ' line-error';
                else if (/^(warning):/i.test(line)) lineClass += ' line-warning';
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
            {hasConflicts && onResolveConflicts && (
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
