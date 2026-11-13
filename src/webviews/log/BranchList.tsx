import { useMemo, useState } from 'react';
import type { BranchInfo } from '../../shared/protocol';
import { formatDate } from './format';

/**
 * Local and remote branches, newest first. The checkbox puts a branch in the log or takes it out;
 * branches already merged into the main branch are dimmed.
 */
export function BranchList({ branches, scope, maxScope, onToggle, onOnlyCurrent }: {
  branches: BranchInfo[]; scope: string[]; maxScope: number; onToggle(name: string): void;
  /** Puts the scope back to the current branch alone, without unticking the others. */
  onOnlyCurrent(): void;
}) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? branches.filter((b) => b.name.toLowerCase().includes(needle)) : branches;
  }, [branches, filter]);
  const full = scope.length >= maxScope;
  const current = branches.find((b) => b.current);

  return (
    <aside className="branches" aria-label="Branches">
      <header>
        <span>Branches</span>
        <span className="muted" title={`The log shows at most ${maxScope} branches at once`}>{scope.length}/{maxScope} in log</span>
      </header>
      <input type="search" placeholder="Filter branches" aria-label="Filter branches" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {scope.length > 1 && (
        <button
          className="only-current" onClick={onOnlyCurrent}
          title={`Show only ${current?.name ?? 'the current branch'} again`}
        >
          Only current
        </button>
      )}
      <ul>
        {shown.map((b) => {
          const checked = scope.includes(b.name);
          const locked = (!checked && full) || (checked && scope.length === 1);
          return (
            <li key={b.name} className={[b.merged ? 'merged' : '', b.current ? 'current' : ''].join(' ')}>
              <label title={`${b.name}\nLast commit ${formatDate(b.date)}${b.merged ? '\nMerged into the main branch' : ''}`}>
                <input
                  type="checkbox" checked={checked} disabled={locked} onChange={() => onToggle(b.name)}
                  aria-label={b.name}
                  // Say why a box cannot be clicked, instead of leaving a dead control.
                  title={locked
                    ? checked ? 'The log needs at least one branch' : `The log shows at most ${maxScope} branches at once; take one out first`
                    : undefined}
                />
                <span className="name">{b.name}</span>
                {b.remote && <span className="muted">remote</span>}
              </label>
            </li>
          );
        })}
        {!shown.length && <li className="muted empty">No branches</li>}
      </ul>
    </aside>
  );
}
