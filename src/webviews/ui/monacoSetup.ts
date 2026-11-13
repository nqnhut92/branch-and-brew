import * as monaco from 'monaco-editor/editor/editor.api';

/**
 * Starts Monaco's editor worker from a blob: URL, the only way a webview can start a worker.
 * The worker bundle is fetched from the extension (connect-src cspSource) and wrapped in a blob.
 */
export function installMonacoEnvironment(workerUrl: string): void {
  let source: Promise<string> | undefined;
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker: async () => {
      source ??= fetch(workerUrl).then((r) => r.text());
      const blob = new Blob([await source], { type: 'text/javascript' });
      return new Worker(URL.createObjectURL(blob));
    },
  };
}

export interface AppliedTheme {
  base: monaco.editor.BuiltinTheme;
  background: string;
}

/** Monaco theme built from the VS Code theme variables of the hosting window. */
export function applyVsCodeTheme(): AppliedTheme {
  const css = getComputedStyle(document.body);
  const v = (name: string, fallback: string) => css.getPropertyValue(`--vscode-${name}`).trim() || fallback;
  const cls = document.body.classList;
  // The webview guide documents vscode-light, vscode-dark and vscode-high-contrast on <body>; a
  // light high-contrast theme carries vscode-high-contrast-light as well.
  const base: monaco.editor.BuiltinTheme = cls.contains('vscode-high-contrast-light')
    ? 'hc-light'
    : cls.contains('vscode-high-contrast') ? 'hc-black' : cls.contains('vscode-light') ? 'vs' : 'vs-dark';
  const background = toHex(v('editor-background', base === 'vs' || base === 'hc-light' ? '#ffffff' : '#1e1e1e'));
  monaco.editor.defineTheme('vscode-host', {
    base,
    inherit: true,
    rules: [],
    colors: {
      'editor.background': background,
      'editor.foreground': toHex(v('editor-foreground', '#cccccc')),
      'editorLineNumber.foreground': toHex(v('editorLineNumber-foreground', '#858585')),
      'editor.selectionBackground': toHex(v('editor-selectionBackground', '#264f78')),
      'editorCursor.foreground': toHex(v('editorCursor-foreground', '#aeafad')),
    },
  });
  monaco.editor.setTheme('vscode-host');
  return { base, background };
}

/**
 * Applies the VS Code theme now and again whenever the user switches theme. VS Code announces a
 * switch by changing the theme class and data-vscode-theme-id on <body> and the --vscode-*
 * variables on <html>, so both are observed; `onApplied` runs after every application.
 */
export function followVsCodeTheme(onApplied?: (theme: AppliedTheme) => void): () => void {
  let scheduled = false;
  const apply = () => {
    scheduled = false;
    onApplied?.(applyVsCodeTheme());
  };
  const observer = new MutationObserver(() => {
    // One theme switch changes several attributes; apply once, after all of them. A timer, not
    // requestAnimationFrame: frames stop while the panel or the window is not being drawn, and
    // the editors must already have the new theme when they come back into view.
    if (!scheduled) { scheduled = true; setTimeout(apply, 0); }
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-id'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  apply();
  return () => observer.disconnect();
}

/** Monaco wants #rrggbb(aa); VS Code variables may be rgba(). */
function toHex(color: string): string {
  if (color.startsWith('#')) return color;
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return color;
  const [r, g, b, a] = m[1].split(',').map((x) => parseFloat(x));
  const h = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}${a === undefined ? '' : h(a * 255)}`;
}

export { monaco };
