import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';

const SKIP = new Set(['node_modules', 'target', '.git', 'build', 'dist', 'out', '.idea', '.gradle']);

/**
 * Finds git repositories under `root`, `root` itself included, down to `maxDepth` folder levels.
 * A folder with a `.git` entry (folder or file) is a repository; its subfolders are not searched.
 */
export async function scanForRepos(root: string, maxDepth = 3): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (existsSync(path.join(dir, '.git'))) {
      found.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder
    }
    await Promise.all(entries
      .filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
      .map((e) => walk(path.join(dir, e.name), depth + 1)));
  }
  await walk(path.resolve(root), 0);
  return found.sort((a, b) => a.localeCompare(b));
}
