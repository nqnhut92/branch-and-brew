import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { discard, stage, unstage } from '../../core/git/changes';
import * as commitOps from '../../core/git/commitOps';
import * as ops from '../../core/git/ops';
import { changedFiles, getCommitDetail, type FileChange } from '../../core/git/show';
import { getStatus } from '../../core/git/status';
import { listConflicts } from '../../core/merge/stages';
import type { CommitAction, FileActionParams } from '../../shared/protocol';
import { blameUri, emptyUri, revisionUri } from '../gitContent';
import { identityOk } from '../identityWarning';
import { resolveFile, takeWhole } from '../merge/commands';
import { interactiveRebaseFrom, rebaseOnto } from '../rebase/commands';
import { act, repoName, type Deps } from '../repos/commands';

const short = (hash: string) => hash.slice(0, 8);

/** The working tree file, or an empty document when it does not exist (deleted). */
function workingUri(repo: string, file: string): vscode.Uri {
  const full = path.join(repo, file);
  return existsSync(full) ? vscode.Uri.file(full) : emptyUri(repo, file);
}

/**
 * Opens a set of changed files: one file in the diff editor, several in the multi-file changes
 * editor. `vscode.changes` takes [label, original, modified] per file; its argument shape is not
 * in the commands reference, so a failure falls back to a pick list and the single diff editor.
 */
async function showChanges(
  repo: string, title: string, files: FileChange[], left: (f: FileChange) => vscode.Uri, right: (f: FileChange) => vscode.Uri,
): Promise<void> {
  if (!files.length) return void vscode.window.showInformationMessage(`${title}: no differences.`);
  const one = (f: FileChange) =>
    vscode.commands.executeCommand('vscode.diff', left(f), right(f), `${path.basename(f.path)} (${title})`, { preview: true });
  if (files.length === 1) return void await one(files[0]);
  try {
    await vscode.commands.executeCommand('vscode.changes', title,
      files.map((f) => [vscode.Uri.file(path.join(repo, f.path)), left(f), right(f)]));
  } catch {
    const pick = await vscode.window.showQuickPick(
      files.map((f) => ({ label: f.path, description: f.status, file: f })), { title, matchOnDescription: true });
    if (pick) await one(pick.file);
  }
}

/** Runs an action that may stop on conflicts and says so instead of showing git's raw output. */
async function orConflict(repo: string, verb: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (e) {
    const s = await getStatus(repo).catch(() => undefined);
    if (s?.conflicted) throw new Error(`${verb} stopped with ${s.conflicted} conflicted file(s); resolve them, then continue.`);
    throw e;
  }
}

/** Runs one item of the commit menu. True when the repository may have changed. */
export async function runCommitAction(deps: Deps, repo: string, action: CommitAction, hash: string): Promise<boolean> {
  switch (action) {
    case 'copyHash':
      await vscode.env.clipboard.writeText(hash);
      return false;
    case 'copyMessage':
      await vscode.env.clipboard.writeText((await getCommitDetail(repo, hash)).message);
      return false;
    case 'compareWorkingTree':
      await showChanges(repo, `${short(hash)} ↔ working tree`, await changedFiles(repo, hash),
        (f) => revisionUri(repo, hash, f.oldPath ?? f.path), (f) => workingUri(repo, f.path));
      return false;
    case 'comparePrevious': {
      const detail = await getCommitDetail(repo, hash);
      // A root commit has no parent; `<hash>^` then reads as empty, which is the right left side.
      await showChanges(repo, `${short(hash)} ↔ previous`, detail.files,
        (f) => revisionUri(repo, `${hash}^`, f.oldPath ?? f.path), (f) => revisionUri(repo, hash, f.path));
      return false;
    }
    case 'checkout':
      await act(deps, repo, 'checking out', () => commitOps.checkoutCommit(repo, hash));
      return true;
    case 'branch': {
      const name = (await vscode.window.showInputBox({
        title: `Create branch at ${short(hash)}`,
        prompt: 'The branch is created here; the current branch stays checked out',
        validateInput: async (v) => (!v.trim() || await ops.isValidBranchName(repo, v.trim()) ? undefined : 'Not a valid branch name'),
      }))?.trim();
      if (!name) return false;
      const created = await act(deps, repo, 'creating branch', () => commitOps.createBranchAt(repo, name, hash));
      if (created === undefined) return false;
      void vscode.window.showInformationMessage(`Created branch ${name} at ${short(hash)}.`, 'Switch to it').then((choice) => {
        if (choice) void act(deps, repo, 'switching', () => ops.switchBranch(repo, { name, remote: false, current: false }));
      });
      return true;
    }
    case 'tag': {
      const name = (await vscode.window.showInputBox({
        title: `Create tag at ${short(hash)}`,
        validateInput: async (v) => (!v.trim() || await commitOps.isValidTagName(repo, v.trim()) ? undefined : 'Not a valid tag name'),
      }))?.trim();
      if (!name) return false;
      await act(deps, repo, 'creating tag', () => commitOps.createTag(repo, name, hash));
      return true;
    }
    case 'cherryPick':
    case 'revert': {
      if (!await identityOk(deps, repo)) return false;
      const isMerge = (await getCommitDetail(repo, hash)).parents.length > 1;
      const [label, verb, run] = action === 'cherryPick'
        ? ['cherry-picking', 'cherry-pick', commitOps.cherryPick] as const
        : ['reverting', 'revert', commitOps.revert] as const;
      await act(deps, repo, label, () => orConflict(repo, verb, () => run(repo, hash, isMerge)));
      return true;
    }
    case 'rebaseOnto':
      return rebaseOnto(deps, repo, hash);
    case 'rebaseInteractive':
      await interactiveRebaseFrom(deps, repo, hash);
      return false;
    case 'reset': {
      const pick = await vscode.window.showQuickPick([
        { label: 'Soft', description: 'Move the branch; keep changes staged', mode: 'soft' as const },
        { label: 'Mixed', description: 'Move the branch; keep changes unstaged', mode: 'mixed' as const },
        { label: 'Hard', description: 'Move the branch and throw away all local changes', mode: 'hard' as const },
      ], { title: `Reset current branch to ${short(hash)}` });
      if (!pick) return false;
      if (pick.mode === 'hard') {
        const ok = await vscode.window.showWarningMessage(
          `Hard reset ${repoName(repo)} to ${short(hash)}? Uncommitted changes are lost and cannot be recovered.`,
          { modal: true }, 'Reset hard');
        if (!ok) return false;
      }
      await act(deps, repo, 'resetting', () => commitOps.reset(repo, pick.mode, hash));
      return true;
    }
  }
}

/** Runs one item of the file menu. True when the repository may have changed. */
export async function runFileAction(
  deps: Deps, repo: string, p: FileActionParams, showHistory: (file: string) => void,
): Promise<boolean> {
  const file: FileChange = { status: '', path: p.path, oldPath: p.oldPath };
  switch (p.action) {
    case 'diff':
      if (p.hash) {
        const hash = p.hash;
        await showChanges(repo, short(hash), [file],
          (f) => revisionUri(repo, `${hash}^`, f.oldPath ?? f.path), (f) => revisionUri(repo, hash, f.path));
      } else {
        // Working tree: everything not committed yet, staged or not.
        await showChanges(repo, 'uncommitted', [file],
          (f) => revisionUri(repo, 'HEAD', f.oldPath ?? f.path), (f) => workingUri(repo, f.path));
      }
      return false;
    case 'open': {
      const full = path.join(repo, p.path);
      // The working file when there is one; otherwise the file as it was in that commit.
      const target = existsSync(full) ? vscode.Uri.file(full) : p.hash ? revisionUri(repo, p.hash, p.path) : undefined;
      if (target) await vscode.commands.executeCommand('vscode.open', target);
      else void vscode.window.showInformationMessage(`${p.path} no longer exists.`);
      return false;
    }
    case 'history':
      showHistory(p.path);
      return false;
    case 'blame': {
      const doc = await vscode.workspace.openTextDocument(blameUri(repo, p.path, p.hash ?? undefined));
      await vscode.window.showTextDocument(doc, { preview: true });
      return false;
    }
    case 'resolve':
      // The log reloads through the repo watcher once the file is saved and staged.
      await resolveFile(deps, repo, p.path);
      return false;
    case 'takeMine':
    case 'takeTheirs': {
      const file = (await listConflicts(repo)).find((f) => f.path === p.path);
      return file ? takeWhole(deps, repo, file, p.action === 'takeMine' ? 'mine' : 'theirs') : false;
    }
    case 'stage':
      await act(deps, repo, 'staging', () => stage(repo, [p.path]));
      return true;
    case 'unstage':
      await act(deps, repo, 'unstaging', () => unstage(repo, p.oldPath ? [p.path, p.oldPath] : [p.path]));
      return true;
    case 'discard': {
      const change = p.change;
      if (!change) return false;
      const ok = await vscode.window.showWarningMessage(
        change.worktree === '?'
          ? `Delete the untracked ${p.path}? This cannot be undone.`
          : `Discard all changes to ${p.path}? This cannot be undone.`,
        { modal: true }, 'Discard');
      if (!ok) return false;
      await act(deps, repo, 'discarding', () => discard(repo, change));
      return true;
    }
  }
}
