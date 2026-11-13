import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { startCallbackServer } from './callbackServer';

/**
 * git runs GIT_ASKPASS as a program (not a shell command line), so it must be one executable
 * path. This POSIX sh wrapper starts the Node script; Git for Windows runs it through its own sh,
 * the same way VS Code's built-in Git extension does.
 */
const WRAPPER = '#!/bin/sh\nexec "$BAB_ASKPASS_NODE" "$BAB_ASKPASS_MAIN" "$@"\n';

/** Writes the wrapper into `dir` with the executable bit (a .vsix does not keep file modes). */
export function ensureAskpassWrapper(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'askpass.sh');
  if (!existsSync(file) || readFileSync(file, 'utf8') !== WRAPPER) writeFileSync(file, WRAPPER);
  chmodSync(file, 0o755);
  return file;
}

export interface AskpassOptions {
  /** From ensureAskpassWrapper. */
  wrapperPath: string;
  /** scripts/askpass.js inside the extension. */
  mainScript: string;
  /** Node to run it with; in VS Code process.execPath plus ELECTRON_RUN_AS_NODE. */
  nodePath: string;
  /** Returns the answer, or undefined when the user cancels. */
  onPrompt: (prompt: string) => Promise<string | undefined>;
}

export interface Askpass {
  /** Add to the environment of network git commands. */
  env: Record<string, string>;
  close(): Promise<void>;
}

/** Answers git's credential and ssh passphrase prompts through the extension. */
export async function startAskpass(options: AskpassOptions): Promise<Askpass> {
  const server = await startCallbackServer(async (req) => {
    if (req.kind !== 'askpass') return { abort: true };
    const answer = await options.onPrompt(String(req.prompt ?? ''));
    return answer === undefined ? { abort: true } : { answer };
  });
  return {
    env: {
      GIT_ASKPASS: options.wrapperPath,
      SSH_ASKPASS: options.wrapperPath,
      // ssh only uses SSH_ASKPASS without a terminal when DISPLAY is set, unless this is "force" (ssh(1)).
      SSH_ASKPASS_REQUIRE: 'force',
      BAB_ASKPASS_NODE: options.nodePath,
      BAB_ASKPASS_MAIN: options.mainScript,
      ELECTRON_RUN_AS_NODE: '1',
      BAB_BRIDGE: server.address,
      BAB_BRIDGE_TOKEN: server.token,
    },
    close: server.close,
  };
}
