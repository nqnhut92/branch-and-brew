// Downloads the VS Code builds the integration tests use, retrying when Microsoft's update
// service hiccups. Later steps then find them in .vscode-test; if the version lookup fails again
// there, @vscode/test-electron falls back to the cached build.
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const versions = process.argv.slice(2);
for (const version of versions) {
  for (let attempt = 1; ; attempt++) {
    try {
      const path = await downloadAndUnzipVSCode({ version });
      console.log(`VS Code ${version}: ${path}`);
      break;
    } catch (e) {
      if (attempt === 4) throw e;
      const wait = attempt * 15;
      console.warn(`VS Code ${version}: attempt ${attempt} failed (${e.message}); retrying in ${wait} s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}
