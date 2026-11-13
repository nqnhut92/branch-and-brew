import * as vscode from 'vscode';
import { ensureAskpassWrapper, startAskpass, type Askpass } from '../core/bridge/askpass';

/**
 * One askpass bridge for the extension's lifetime. Network git commands get its env, so a
 * credential prompt becomes a VS Code input box instead of a hidden terminal prompt.
 * Git's own credential helpers are asked first; then a connected account for the host; then the user.
 */
export async function startAskpassHost(
  context: vscode.ExtensionContext, fromAccount?: (prompt: string) => Promise<string | undefined>,
): Promise<Askpass> {
  const askpass = await startAskpass({
    wrapperPath: ensureAskpassWrapper(context.globalStorageUri.fsPath),
    mainScript: vscode.Uri.joinPath(context.extensionUri, 'scripts', 'askpass.js').fsPath,
    nodePath: process.execPath,
    // A connected account for the host answers silently; only otherwise is the user asked.
    onPrompt: async (prompt) => await fromAccount?.(prompt) ?? vscode.window.showInputBox({
      title: 'Git',
      prompt: prompt.trim(),
      password: /password|passphrase|token/i.test(prompt),
      ignoreFocusOut: true,
    }),
  });
  context.subscriptions.push({ dispose: () => void askpass.close() });
  return askpass;
}
