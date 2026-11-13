import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/integration/**/*.test.js',
  // Point at an unpacked .vsix to test the packaged build instead of this folder.
  extensionDevelopmentPath: process.env.VSCODE_TEST_EXTENSION_PATH,
  version: process.env.VSCODE_TEST_VERSION ?? 'stable',
  launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  mocha: { timeout: 120000, ui: 'tdd' },
});
