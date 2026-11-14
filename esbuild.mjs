import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// A production build starts from an empty dist/ so no development source maps reach the .vsix.
if (production) (await import('node:fs')).rmSync('dist', { recursive: true, force: true });

const common = { bundle: true, minify: production, sourcemap: !production, logLevel: 'info' };

/** Extension host bundle. */
const host = {
  ...common,
  entryPoints: ['src/host/extension.ts'],
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
};

/** One browser bundle per webview, plus the Monaco editor worker. */
const webviews = {
  ...common,
  entryPoints: {
    'merge/main': 'src/webviews/merge/main.ts',
    'log/main': 'src/webviews/log/main.tsx',
    'rebase/main': 'src/webviews/rebase/main.tsx',
    'brewing/main': 'src/webviews/brewing/main.tsx',
    'monaco/editor.worker': 'monaco-editor/editor/editor.worker',
  },
  outdir: 'dist/webviews',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  loader: { '.ttf': 'file' },
  jsx: 'automatic',
  // React picks its production build from this at bundle time.
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
};

/** Integration tests, run inside VS Code by @vscode/test-cli. */
const integration = {
  ...common,
  minify: false,
  entryPoints: ['test/integration/*.test.ts'],
  outdir: 'out/integration',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode', 'mocha'],
};

const configs = process.argv.includes('--tests') ? [integration] : [host];
if (await hasWebviews()) configs.push(webviews);

async function hasWebviews() {
  const { existsSync } = await import('node:fs');
  return existsSync('src/webviews/merge/main.ts');
}

if (watch) {
  for (const c of configs) (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
