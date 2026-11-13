import { rmSync } from 'node:fs';

/**
 * Deletes a test's temp folder without ever failing the test. On Windows a folder can stay locked
 * for seconds after git exits (antivirus scans of new files, handles not yet released), so
 * rmSync throws EPERM; a leftover folder in the temp directory is harmless.
 */
export function removeTempDir(dir: string): void {
  try {
    // Node waits retryDelay longer on each retry (100, 200, 300 ms): under a second per folder, so
    // a suite with a dozen locked folders stays well inside the hook timeout.
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (e) {
    console.warn(`left temp folder behind: ${dir} (${(e as NodeJS.ErrnoException).code ?? e})`);
  }
}
