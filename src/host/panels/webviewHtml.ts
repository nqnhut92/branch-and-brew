import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export interface WebviewPage {
  title: string;
  /** Script and stylesheet paths relative to dist/webviews. */
  scripts: string[];
  styles: string[];
  /** Extra data for the page, available as JSON in #initial-state. */
  state?: unknown;
}

/**
 * HTML shell for every webview. Strict CSP: no remote origins, scripts only from the extension
 * with a nonce, workers only from blob: (the documented way to start a worker in a webview).
 * style-src needs 'unsafe-inline' because Monaco injects <style> elements and has no nonce support.
 */
export function renderWebview(webview: vscode.Webview, extensionUri: vscode.Uri, page: WebviewPage): string {
  const nonce = randomBytes(16).toString('base64');
  const uri = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webviews', p)).toString();
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `connect-src ${webview.cspSource}`,
    'worker-src blob:',
  ].join('; ');
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const state = JSON.stringify(page.state ?? null).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(page.title)}</title>
${page.styles.map((s) => `<link rel="stylesheet" href="${uri(s)}">`).join('\n')}
</head>
<body>
<script type="application/json" id="initial-state">${state}</script>
<div id="root"></div>
${page.scripts.map((s) => `<script nonce="${nonce}" src="${uri(s)}"></script>`).join('\n')}
</body>
</html>`;
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: false,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webviews')],
  };
}
