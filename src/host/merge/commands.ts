import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  deleteFile, describeConflict, listConflicts, loadMerge, takeSide, type ConflictFile, type Side, type WholeFileMerge,
} from '../../core/merge/stages';
import { MergePanel } from '../panels/mergePanel';
import { act, repoName, type Deps } from '../repos/commands';

const WHY: Record<WholeFileMerge['reason'], string> = {
  'missing-stage': 'one side added or deleted it, so there is nothing to compare line by line',
  binary: 'it is a binary file',
  'too-large': 'it is larger than 2 MB',
};

const sideLabel = (file: ConflictFile, side: Side) =>
  `Keep ${side === 'mine' ? 'Mine' : 'Theirs'}${file[side] ? '' : ' (deletes the file: that side removed it)'}`;

/** Takes one side's whole file (or its deletion) and reports failure on the repo row. */
export async function takeWhole(deps: Deps, repo: string, file: ConflictFile, side: Side): Promise<boolean> {
  return (await act(deps, repo, 'resolving', async () => { await takeSide(repo, file, side); return true; })) === true;
}

/** A conflict with no line-by-line editor: keep mine, keep theirs, or (for a missing side) delete. */
async function resolveWhole(deps: Deps, repo: string, file: ConflictFile, reason: WholeFileMerge['reason']): Promise<boolean> {
  type Item = vscode.QuickPickItem & { run(): Promise<unknown> };
  const items: Item[] = [
    { label: sideLabel(file, 'mine'), run: () => takeSide(repo, file, 'mine') },
    { label: sideLabel(file, 'theirs'), run: () => takeSide(repo, file, 'theirs') },
  ];
  if (reason === 'missing-stage' && file.mine && file.theirs) items.push({ label: 'Delete the File', run: () => deleteFile(repo, file.path) });
  const pick = await vscode.window.showQuickPick(items, {
    title: `${file.path}: ${describeConflict(file)}`,
    placeHolder: `No three-pane editor for this file: ${WHY[reason]}`,
  });
  if (!pick) return false;
  return (await act(deps, repo, 'resolving', async () => { await pick.run(); return true; })) === true;
}

/**
 * Opens a conflicted file in the three-pane editor, or asks which whole side to keep when it
 * cannot be edited there. Resolves with the panel when one was opened.
 */
export async function resolveFile(deps: Deps, repo: string, filePath: string, onResolved?: () => void): Promise<MergePanel | undefined> {
  const file = (await listConflicts(repo)).find((f) => f.path === filePath);
  if (!file) {
    void vscode.window.showInformationMessage(`${filePath} has no conflict.`);
    return undefined;
  }
  const merge = await loadMerge(repo, file);
  if (merge.kind === 'text') return MergePanel.open(deps, repo, file, merge, onResolved);
  if (await resolveWhole(deps, repo, file, merge.reason)) onResolved?.();
  return undefined;
}

/**
 * The list of conflicted files: pick one to resolve it, or use its buttons to take a whole side.
 * It comes back after each file until none is left.
 */
export async function resolveConflicts(deps: Deps, repo: string): Promise<void> {
  const files = await listConflicts(repo);
  if (!files.length) {
    void deps.states.refresh(repo);
    void vscode.window.showInformationMessage(`${repoName(repo)} has no conflicted files left.`);
    return;
  }
  type Item = vscode.QuickPickItem & { file: ConflictFile };
  const mine: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('arrow-left'), tooltip: 'Take Mine (whole file)' };
  const theirs: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('arrow-right'), tooltip: 'Take Theirs (whole file)' };
  const pick = vscode.window.createQuickPick<Item>();
  pick.title = `${repoName(repo)}: ${files.length} conflicted ${files.length === 1 ? 'file' : 'files'}`;
  pick.placeholder = 'Pick a file to resolve it in the three-pane editor';
  pick.items = files.map((file) => ({
    label: path.basename(file.path), description: path.dirname(file.path) === '.' ? '' : path.dirname(file.path),
    detail: describeConflict(file), file, buttons: [mine, theirs],
  }));
  const again = () => void resolveConflicts(deps, repo);
  pick.onDidTriggerItemButton(async (e) => {
    pick.hide();
    await takeWhole(deps, repo, e.item.file, e.button === mine ? 'mine' : 'theirs');
    again();
  });
  pick.onDidAccept(() => {
    const [chosen] = pick.selectedItems;
    pick.hide();
    if (chosen) void resolveFile(deps, repo, chosen.file.path, again);
  });
  pick.onDidHide(() => pick.dispose());
  pick.show();
}
