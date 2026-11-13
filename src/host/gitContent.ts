import * as vscode from 'vscode';
import { blame, showFile } from '../core/git/show';

/** Scheme of the read-only documents this extension serves: file content at a revision, blame. */
export const GIT_SCHEME = 'branch-and-brew';

interface Query {
  repo: string;
  kind: 'show' | 'blame' | 'empty';
  /** Revision; "" reads the index, undefined blames the working tree. */
  rev?: string;
  file: string;
}

function uri(query: Query): vscode.Uri {
  // The path keeps the file name so VS Code picks the right language and tab title.
  return vscode.Uri.from({ scheme: GIT_SCHEME, path: '/' + query.file, query: JSON.stringify(query) });
}

/** `git show <rev>:<file>`; a file missing at that revision reads as empty. */
export const revisionUri = (repo: string, rev: string, file: string) => uri({ repo, kind: 'show', rev, file });
export const blameUri = (repo: string, file: string, rev?: string) => uri({ repo, kind: 'blame', rev, file });
/** An empty document, the other side of an added or deleted file. */
export const emptyUri = (repo: string, file: string) => uri({ repo, kind: 'empty', file });

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(target: vscode.Uri): Promise<string> {
    const q = JSON.parse(target.query) as Query;
    if (q.kind === 'empty') return '';
    if (q.kind === 'blame') return blame(q.repo, q.file, q.rev);
    return showFile(q.repo, q.rev ?? '', q.file);
  }
}
