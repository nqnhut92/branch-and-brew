import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { git } from '../git/ops';
import type { RunOptions } from '../git/runner';
import { folderNameOf } from './model';

/** Cloning can wait on a slow network or a credential prompt. */
const CLONE_TIMEOUT = 60 * 60_000;

/** Where a clone of `url` under `parent` goes; throws when a non-empty folder is in the way. */
export function cloneTarget(url: string, parent: string): string {
  const target = path.join(parent, folderNameOf(url));
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} already exists and is not empty.`);
  return target;
}

/** `git clone <url> <parent>/<name>`; resolves with the new repository's folder. */
export async function cloneRepo(url: string, parent: string, options?: RunOptions): Promise<string> {
  const target = cloneTarget(url, parent);
  await git(parent, ['clone', '--', url, target], { timeoutMs: CLONE_TIMEOUT, ...options });
  return target;
}
