import * as path from 'node:path';
import * as vscode from 'vscode';
import { checkIdentity } from '../../core/git/identity';
import { describeStatus, rowState } from '../../core/repos/describe';
import { pathKey, profileFor, reposInGroup, type Group, type RepoList } from '../../core/repos/model';
import type { RepoStates } from './state';
import type { RepoStore } from './store';

export type Node = GroupNode | RepoNode;
export interface GroupNode { kind: 'group'; group: Group }
export interface RepoNode { kind: 'repo'; path: string }

const UNGROUPED: Group = { id: '', name: 'Ungrouped' };

/**
 * Repositories by group. Nodes are cached per key so a refresh of one repo can fire just that
 * node. Without groups, repositories are listed at the top level.
 */
export class RepoTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly repoNodes = new Map<string, RepoNode>();
  private readonly subscriptions: vscode.Disposable[];

  /** Set by the extension: project kinds, the Maven mark and the Java line of the tooltip. */
  extras: { kinds?(repo: string): string[]; mark?(repo: string): string | undefined; java?(repo: string): string | undefined } = {};

  /** Redraws one repository row, or all of them. */
  redraw(repo?: string): void {
    this.changed.fire(repo ? this.repoNodes.get(pathKey(repo)) : undefined);
  }

  constructor(private readonly store: RepoStore, private readonly states: RepoStates) {
    this.subscriptions = [
      store.onDidChange(() => this.changed.fire(undefined)),
      states.onDidChange((repo) => {
        const node = this.repoNodes.get(pathKey(repo));
        if (node) this.changed.fire(node);
      }),
    ];
  }

  getChildren(element?: Node): Node[] {
    const list = this.store.list;
    if (!element) {
      if (!list.groups.length) return this.repos(list, undefined);
      const groups: Node[] = [...list.groups].sort((a, b) => a.name.localeCompare(b.name))
        .map((group) => ({ kind: 'group', group }));
      if (reposInGroup(list, undefined).length) groups.push({ kind: 'group', group: UNGROUPED });
      return groups;
    }
    return element.kind === 'group' ? this.repos(list, element.group.id || undefined) : [];
  }

  private repos(list: RepoList, groupId: string | undefined): RepoNode[] {
    return reposInGroup(list, groupId)
      .sort((a, b) => path.basename(a.path).localeCompare(path.basename(b.path)))
      .map((r) => {
        const key = pathKey(r.path);
        let node = this.repoNodes.get(key);
        if (!node) this.repoNodes.set(key, (node = { kind: 'repo', path: r.path }));
        return node;
      });
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const list = this.store.list;
      const item = new vscode.TreeItem(node.group.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${node.group.id}`;
      const profile = list.profiles.find((p) => p.id === node.group.profileId);
      item.description = profile ? profile.label : undefined;
      item.contextValue = node.group.id ? 'group' : 'ungrouped';
      item.iconPath = new vscode.ThemeIcon('folder-library');
      return item;
    }
    return this.repoItem(node.path);
  }

  private repoItem(repo: string): vscode.TreeItem {
    const state = this.states.get(repo);
    const item = new vscode.TreeItem(path.basename(repo), vscode.TreeItemCollapsibleState.None);
    item.id = `repo:${pathKey(repo)}`;
    item.resourceUri = vscode.Uri.file(repo);
    const kind = rowState(state.status, state.error);
    const mark = this.extras.mark?.(repo);
    item.description = (state.busy ? `${state.busy}…` : state.error ? 'not available' : state.status ? describeStatus(state.status) : 'loading…')
      + (mark ? ` · ${mark}` : '');
    item.iconPath = state.busy
      ? new vscode.ThemeIcon('sync~spin')
      : {
        clean: new vscode.ThemeIcon('repo'),
        changed: new vscode.ThemeIcon('repo', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')),
        conflict: new vscode.ThemeIcon('warning', new vscode.ThemeColor('gitDecoration.conflictingResourceForeground')),
        operation: new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')),
        error: new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')),
      }[kind];
    const kinds = this.extras.kinds?.(repo) ?? [];
    item.contextValue = ['repo', ...(kind === 'conflict' ? ['conflict'] : []), ...kinds].join(' ');
    item.tooltip = this.tooltip(repo);
    return item;
  }

  private tooltip(repo: string): vscode.MarkdownString {
    const { status, identity, error } = this.states.get(repo);
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${escape(path.basename(repo))}**  \n`);
    md.appendText(repo);
    md.appendMarkdown('\n\n');
    if (error) {
      md.appendMarkdown('$(error) ');
      md.appendText(error);
      return md;
    }
    if (status) {
      md.appendMarkdown(`Branch: \`${escape(status.branch ?? 'detached')}\``);
      if (status.upstream) md.appendMarkdown(` → \`${escape(status.upstream)}\``);
      md.appendMarkdown('  \n');
    }
    if (identity) {
      const who = identity.name || identity.email
        ? `${escape(identity.name ?? '(no name)')} <${escape(identity.email ?? 'no email')}>`
        : '(not set)';
      const scope = identity.emailScope ?? identity.nameScope;
      md.appendMarkdown(`Identity: ${who}${scope ? ` _(${scope})_` : ''}  \n`);
      const problem = checkIdentity(identity, profileFor(this.store.list, repo));
      if (problem?.kind === 'missing') md.appendMarkdown(`$(warning) Missing ${problem.keys.join(' and ')}  \n`);
      if (problem?.kind === 'differs') md.appendMarkdown(`$(warning) Differs from the group profile "${escape(problem.profile.label)}"  \n`);
    }
    const java = this.extras.java?.(repo);
    if (java) {
      md.appendText(java);
      md.appendMarkdown('  \n');
    }
    return md;
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}

function escape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
