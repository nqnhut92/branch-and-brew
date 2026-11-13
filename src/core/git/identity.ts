import { run, type RunOptions } from './runner';

export type ConfigScope = 'global' | 'local' | 'system' | 'worktree' | 'command';

export interface Identity {
  name?: string;
  email?: string;
  /** Where each effective value comes from. */
  nameScope?: ConfigScope;
  emailScope?: ConfigScope;
}

export interface IdentityProfile {
  id: string;
  label: string;
  name: string;
  email: string;
}

async function readKey(repo: string, key: string, options?: RunOptions): Promise<{ value?: string; scope?: ConfigScope }> {
  const r = await run(repo, ['config', '--show-scope', '--get', key], { noQueue: true, ...options });
  if (r.exitCode !== 0) return {}; // 1 = not set
  const line = r.stdout.replace(/\r?\n$/, '');
  const tab = line.indexOf('\t');
  return { scope: line.slice(0, tab) as ConfigScope, value: line.slice(tab + 1) };
}

/** Effective user.name and user.email for a repository, with the scope each comes from. */
export async function getIdentity(repo: string, options?: RunOptions): Promise<Identity> {
  const [name, email] = await Promise.all([readKey(repo, 'user.name', options), readKey(repo, 'user.email', options)]);
  return { name: name.value, email: email.value, nameScope: name.scope, emailScope: email.scope };
}

/** Writes user.name and user.email with `git config --global` or `--local`. */
export async function setIdentity(
  repo: string, scope: 'global' | 'local', identity: { name: string; email: string }, options?: RunOptions,
): Promise<void> {
  for (const [key, value] of [['user.name', identity.name], ['user.email', identity.email]] as const) {
    const r = await run(repo, ['config', `--${scope}`, key, value], options);
    if (r.exitCode !== 0) throw new Error(`git config ${key} failed: ${r.stderr.trim()}`);
  }
}

export type IdentityProblem =
  | { kind: 'missing'; keys: ('user.name' | 'user.email')[] }
  | { kind: 'differs'; profile: IdentityProfile };

/** What is wrong with a repo's identity, if anything, given the profile of its group. */
export function checkIdentity(identity: Identity, profile?: IdentityProfile): IdentityProblem | undefined {
  const missing = [
    ...(identity.name ? [] : ['user.name' as const]),
    ...(identity.email ? [] : ['user.email' as const]),
  ];
  if (missing.length) return { kind: 'missing', keys: missing };
  if (profile && (identity.name !== profile.name || identity.email?.toLowerCase() !== profile.email.toLowerCase())) {
    return { kind: 'differs', profile };
  }
  return undefined;
}
