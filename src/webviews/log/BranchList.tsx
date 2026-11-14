import { useMemo, useState } from 'react';
import type { BranchInfo } from '../../shared/protocol';
import { formatDate } from './format';

export interface BranchLeaf {
  kind: 'leaf';
  id: string;
  name: string;
  fullName: string;
  info: BranchInfo;
}

export interface BranchFolder {
  kind: 'folder';
  id: string;
  name: string;
  children: (BranchFolder | BranchLeaf)[];
}

export type BranchNode = BranchFolder | BranchLeaf;

function insertBranch(
  nodes: BranchNode[],
  segments: string[],
  fullBranch: BranchInfo,
  pathPrefix: string,
) {
  if (segments.length === 1) {
    nodes.push({
      kind: 'leaf',
      id: `leaf:${fullBranch.name}`,
      name: segments[0],
      fullName: fullBranch.name,
      info: fullBranch,
    });
    return;
  }

  const folderName = segments[0];
  const folderPath = `${pathPrefix}/${folderName}`;
  let folder = nodes.find((n): n is BranchFolder => n.kind === 'folder' && n.name === folderName);
  if (!folder) {
    folder = {
      kind: 'folder',
      id: `folder:${folderPath}`,
      name: folderName,
      children: [],
    };
    nodes.push(folder);
  }

  insertBranch(folder.children, segments.slice(1), fullBranch, folderPath);
}

function sortTree(nodes: BranchNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const n of nodes) {
    if (n.kind === 'folder') sortTree(n.children);
  }
}

function filterTree(nodes: BranchNode[], needle: string): BranchNode[] {
  const result: BranchNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'leaf') {
      if (n.fullName.toLowerCase().includes(needle) || n.name.toLowerCase().includes(needle)) {
        result.push(n);
      }
    } else {
      const filteredChildren = filterTree(n.children, needle);
      if (filteredChildren.length > 0 || n.name.toLowerCase().includes(needle)) {
        result.push({ ...n, children: filteredChildren });
      }
    }
  }
  return result;
}

function BranchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" clipRule="evenodd" d="M11.75 2a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM9 3.75a2.75 2.75 0 1 1 4.54 2.096c-.378.892-1.127 1.62-2.04 1.944v2.46a2.75 2.75 0 1 1-1.5 0v-6.5zm-4.75 7a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM2.5 12.5a2.75 2.75 0 1 1 3.5-2.616v-3.768a2.75 2.75 0 1 1 1.5 0v3.768A2.75 2.75 0 0 1 2.5 12.5zm1.75-9a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5z" />
    </svg>
  );
}

function CloudIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" clipRule="evenodd" d="M11.5 4.5a3.5 3.5 0 0 0-3.414 2.723A4.5 4.5 0 0 0 1 11.5 4.5 4.5 0 0 0 5.5 16h6a4.5 4.5 0 0 0 4.5-4.5 4.5 4.5 0 0 0-4.5-4.5h-.086A3.49 3.49 0 0 0 11.5 4.5zm-6 10.5a3.5 3.5 0 0 1-3.5-3.5 3.5 3.5 0 0 1 3.256-3.49.5.5 0 0 0 .473-.393 2.5 2.5 0 0 1 4.882.684.5.5 0 0 0 .445.498A3.5 3.5 0 0 1 11.5 15h-6z" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" clipRule="evenodd" d="M3.22 6.22a.75.75 0 0 1 1.06 0L8 9.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 7.28a.75.75 0 0 1 0-1.06z" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" clipRule="evenodd" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" clipRule="evenodd" d="M1.5 2.5h4.293l1.5 1.5H14.5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zm0 1a.5.5 0 0 0-.5.5V5h14V5a.5.5 0 0 0-.5-.5H7l-1.5-1.5H1.5zm-.5 2.5v7a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V6H1z" />
    </svg>
  );
}

function BranchTreeNodes({
  nodes,
  depth,
  scope,
  full,
  collapsed,
  isSearching,
  onToggleCollapse,
  onToggleScope,
  onSwitch,
  onMenu,
}: {
  nodes: BranchNode[];
  depth: number;
  scope: string[];
  full: boolean;
  collapsed: Set<string>;
  isSearching: boolean;
  onToggleCollapse(id: string): void;
  onToggleScope(name: string): void;
  onSwitch?(name: string): void;
  onMenu?(branch: BranchInfo, x: number, y: number, returnFocus: HTMLElement): void;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'folder') {
          const isCollapsed = !isSearching && collapsed.has(node.id);
          return (
            <div key={node.id} className="branch-folder-item">
              <div
                className="branch-tree-row folder-row"
                style={{ paddingLeft: `${depth * 14 + 6}px` }}
                onClick={() => onToggleCollapse(node.id)}
              >
                <span className="folder-chevron">{isCollapsed ? <ChevronRight /> : <ChevronDown />}</span>
                <span className="folder-icon"><FolderIcon /></span>
                <span className="name">{node.name}</span>
              </div>
              {!isCollapsed && (
                <BranchTreeNodes
                  nodes={node.children}
                  depth={depth + 1}
                  scope={scope}
                  full={full}
                  collapsed={collapsed}
                  isSearching={isSearching}
                  onToggleCollapse={onToggleCollapse}
                  onToggleScope={onToggleScope}
                  onSwitch={onSwitch}
                  onMenu={onMenu}
                />
              )}
            </div>
          );
        }

        const b = node.info;
        const checked = scope.includes(b.name) || (b.current && scope.includes('HEAD'));
        const locked = (!checked && full) || (checked && scope.length === 1);
        return (
          <div
            key={node.id}
            className={`branch-tree-row branch-leaf-row ${b.current ? 'current' : ''} ${b.merged ? 'merged' : ''}`}
            style={{ paddingLeft: `${depth * 14 + 6}px` }}
            title={`${b.name}\nLast commit ${formatDate(b.date)}${b.merged ? '\nMerged into the main branch' : ''}\nDouble-click to switch`}
            onDoubleClick={(e) => {
              e.preventDefault();
              onSwitch?.(b.name);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu?.(b, e.clientX, e.clientY, e.currentTarget);
            }}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={locked}
              onChange={() => onToggleScope(b.name)}
              aria-label={b.name}
              title={locked
                ? checked ? 'The log needs at least one branch' : 'Max branches in log reached'
                : undefined}
              onClick={(e) => e.stopPropagation()}
            />
            {b.current && <span className="current-check" title="Current checked out branch">✓</span>}
            <span className="name">{node.name}</span>
          </div>
        );
      })}
    </>
  );
}

/**
 * SourceTree-style branch tree: Local and Remote sections, folder grouping on slashes,
 * dot indicator for current branch, double-click to checkout/switch.
 */
export function BranchList({
  branches,
  scope,
  maxScope,
  onToggle,
  onOnlyCurrent,
  onMenu,
  onSwitch,
}: {
  branches: BranchInfo[];
  scope: string[];
  maxScope: number;
  onToggle(name: string): void;
  onOnlyCurrent(): void;
  onMenu?(branch: BranchInfo, x: number, y: number, returnFocus: HTMLElement): void;
  onSwitch?(name: string): void;
}) {
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const full = scope.length >= maxScope;
  const current = branches.find((b) => b.current);

  const { localTree, remoteTree } = useMemo(() => {
    const local: BranchNode[] = [];
    const remote: BranchNode[] = [];

    for (const b of branches) {
      if (!b.remote) {
        insertBranch(local, b.name.split('/'), b, 'local');
      } else {
        insertBranch(remote, b.name.split('/'), b, 'remote');
      }
    }

    sortTree(local);
    sortTree(remote);
    return { localTree: local, remoteTree: remote };
  }, [branches]);

  const needle = filter.trim().toLowerCase();
  const isSearching = !!needle;

  const filteredLocal = useMemo(() => (isSearching ? filterTree(localTree, needle) : localTree), [localTree, needle, isSearching]);
  const filteredRemote = useMemo(() => (isSearching ? filterTree(remoteTree, needle) : remoteTree), [remoteTree, needle, isSearching]);

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const hasRemote = branches.some((b) => b.remote);

  return (
    <aside className="branches" aria-label="Branches">
      <div className="branches-top">
        <input
          type="search"
          placeholder="Filter branches"
          aria-label="Filter branches"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="branches-actions">
          {scope.length > 1 && (
            <button
              type="button"
              className="only-current-pill"
              onClick={onOnlyCurrent}
              title={`Show only ${current?.name ?? 'the current branch'} in log`}
            >
              Only current
            </button>
          )}
          <span className="scope-badge" title={`The log shows at most ${maxScope} branches at once`}>
            {scope.length}/{maxScope} in log
          </span>
        </div>
      </div>

      <div className="branch-tree-container">
        {/* BRANCHES (Local) */}
        <div className="branch-section">
          <div
            className="branch-section-header"
            onClick={() => toggleCollapse('section:local')}
          >
            <BranchIcon />
            <span>Branches</span>
            <span className="section-chevron">
              {collapsed.has('section:local') && !isSearching ? <ChevronRight /> : <ChevronDown />}
            </span>
          </div>
          {(!collapsed.has('section:local') || isSearching) && (
            <div className="branch-section-body">
              {filteredLocal.length > 0 ? (
                <BranchTreeNodes
                  nodes={filteredLocal}
                  depth={0}
                  scope={scope}
                  full={full}
                  collapsed={collapsed}
                  isSearching={isSearching}
                  onToggleCollapse={toggleCollapse}
                  onToggleScope={onToggle}
                  onSwitch={onSwitch}
                  onMenu={onMenu}
                />
              ) : (
                <div className="muted empty" style={{ paddingLeft: '20px' }}>
                  {isSearching ? 'No matching branches' : 'No local branches'}
                </div>
              )}
            </div>
          )}
        </div>

        {/* REMOTES */}
        {hasRemote && (
          <div className="branch-section">
            <div
              className="branch-section-header"
              onClick={() => toggleCollapse('section:remote')}
            >
              <CloudIcon />
              <span>Remotes</span>
              <span className="section-chevron">
                {collapsed.has('section:remote') && !isSearching ? <ChevronRight /> : <ChevronDown />}
              </span>
            </div>
            {(!collapsed.has('section:remote') || isSearching) && (
              <div className="branch-section-body">
                {filteredRemote.length > 0 ? (
                  <BranchTreeNodes
                    nodes={filteredRemote}
                    depth={0}
                    scope={scope}
                    full={full}
                    collapsed={collapsed}
                    isSearching={isSearching}
                    onToggleCollapse={toggleCollapse}
                    onToggleScope={onToggle}
                    onSwitch={onSwitch}
                    onMenu={onMenu}
                  />
                ) : (
                  <div className="muted empty" style={{ paddingLeft: '20px' }}>
                    {isSearching ? 'No matching remotes' : 'No remote branches'}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
