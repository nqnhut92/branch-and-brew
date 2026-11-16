import * as vscode from 'vscode';
import type { Deps } from '../repos/commands';

const LAST_FOLDER_KEY = 'branchAndBrew.lastCloneFolder';

export interface Destination {
  folder: string;
  groupId?: string;
  /** Group name, or undefined for "Ungrouped". */
  groupName?: string;
}

/** Folder the last clone went into, offered as the start of the next folder question. */
export const lastCloneFolder = (memento: vscode.Memento): string | undefined => memento.get<string>(LAST_FOLDER_KEY);

/** Asks where to clone and into which group; undefined when the user dismisses either question. */
export async function askDestination(deps: Deps, memento: vscode.Memento, title: string): Promise<Destination | undefined> {
  const last = lastCloneFolder(memento);
  const folder = (await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, openLabel: 'Clone into this folder', title,
    defaultUri: last ? vscode.Uri.file(last) : undefined,
  }))?.[0];
  if (!folder) return undefined;
  await memento.update(LAST_FOLDER_KEY, folder.fsPath);
  const groups = deps.store.list.groups;
  if (!groups.length) return { folder: folder.fsPath };
  const pick = await vscode.window.showQuickPick(
    [{ label: 'Ungrouped', id: undefined as string | undefined }, ...groups.map((g) => ({
      label: g.name, id: g.id as string | undefined,
      description: deps.store.list.profiles.find((p) => p.id === g.profileId)?.label,
    }))],
    { title: 'Add to group', placeHolder: 'The group\'s identity profile is applied to the clone' });
  if (!pick) return undefined;
  return { folder: folder.fsPath, groupId: pick.id, groupName: pick.id ? pick.label : undefined };
}
