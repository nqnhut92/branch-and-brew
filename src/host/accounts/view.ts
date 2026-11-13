import * as vscode from 'vscode';
import { expiryNotice, type Account } from '../../core/accounts/model';
import type { Accounts } from './service';

export const ACCOUNTS_VIEW_ID = 'branchAndBrew.accounts';

const KIND_LABEL = { github: 'GitHub', azure: 'Azure DevOps', generic: 'HTTPS host' } as const;
const ICON = { github: 'github', azure: 'azure-devops', generic: 'key' } as const;

/** The Accounts view: one row per connected account. */
export class AccountsTreeProvider implements vscode.TreeDataProvider<Account>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly accounts: Accounts) {
    this.subscription = accounts.onDidChange(() => this.changed.fire());
  }

  getChildren(element?: Account): Account[] {
    return element ? [] : this.accounts.list().sort((a, b) => a.host.localeCompare(b.host) || a.label.localeCompare(b.label));
  }

  getTreeItem(account: Account): vscode.TreeItem {
    const item = new vscode.TreeItem(account.label, vscode.TreeItemCollapsibleState.None);
    const notice = expiryNotice(account.expiresAt);
    item.id = `account:${account.id}`;
    item.description = [account.kind === 'generic' ? account.host : KIND_LABEL[account.kind], notice].filter(Boolean).join(' · ');
    item.iconPath = notice
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon(ICON[account.kind]);
    item.contextValue = account.kind === 'generic' && account.host.toLowerCase() !== 'github.com' ? 'account' : 'account browsable';
    const lines = [`${KIND_LABEL[account.kind]}: ${account.host}`, `Git user name: ${account.username}`];
    if (account.expiresAt) lines.push(`Token valid until ${new Date(account.expiresAt).toLocaleDateString()}`);
    lines.push(account.kind === 'generic' ? 'Token kept in VS Code\'s secret storage' : 'Signed in through VS Code (see the Accounts menu)');
    item.tooltip = lines.join('\n');
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
