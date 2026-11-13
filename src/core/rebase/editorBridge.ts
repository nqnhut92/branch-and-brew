import * as path from 'node:path';
import { startCallbackServer } from '../bridge/callbackServer';

export type EditorKind = 'sequence' | 'message';

/** Returns the new file content, or null to abort the git operation. */
export type EditorHandler = (content: string, file: string, kind: EditorKind) => Promise<string | null>;

export interface BridgeOptions {
  /** Folder holding rebase-sequence-editor.js and rebase-message-editor.js. */
  scriptsDir: string;
  /** Node binary that runs the scripts. In VS Code this is process.execPath with ELECTRON_RUN_AS_NODE. */
  nodePath: string;
  onSequence: EditorHandler;
  onMessage: EditorHandler;
  platform?: NodeJS.Platform;
}

export interface EditorBridge {
  /** Environment for `git rebase -i`, `git rebase --continue` and `git rebase --edit-todo`. */
  env: Record<string, string>;
  close(): Promise<void>;
}

/** Quotes for the POSIX shell git uses to run editors (Git for Windows ships its own sh). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Path for git's sh: forward slashes on Windows so backslashes are never escape characters. */
export function shPath(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

export function editorCommand(nodePath: string, script: string, platform: NodeJS.Platform = process.platform): string {
  return `${shQuote(shPath(nodePath, platform))} ${shQuote(shPath(script, platform))}`;
}

/** Starts the callback server that git's editor scripts (GIT_SEQUENCE_EDITOR, GIT_EDITOR) talk to. */
export async function startEditorBridge(options: BridgeOptions): Promise<EditorBridge> {
  const platform = options.platform ?? process.platform;
  const server = await startCallbackServer(async (req) => {
    const kind = req.kind as EditorKind;
    const handler = kind === 'sequence' ? options.onSequence : kind === 'message' ? options.onMessage : undefined;
    if (!handler) return { abort: true };
    const content = await handler(String(req.content), String(req.file), kind);
    return content === null ? { abort: true } : { content };
  }, platform);
  const script = (name: string) => path.join(options.scriptsDir, name);
  return {
    env: {
      GIT_SEQUENCE_EDITOR: editorCommand(options.nodePath, script('rebase-sequence-editor.js'), platform),
      GIT_EDITOR: editorCommand(options.nodePath, script('rebase-message-editor.js'), platform),
      ELECTRON_RUN_AS_NODE: '1',
      BAB_BRIDGE: server.address,
      BAB_BRIDGE_TOKEN: server.token,
    },
    close: server.close,
  };
}
