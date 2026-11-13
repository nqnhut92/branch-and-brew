import { run, type RunOptions } from './runner';
import { mainBranch } from './scope';

export interface BranchInfo {
  /** Short name: "main", "origin/main". */
  name: string;
  remote: boolean;
  current: boolean;
  hash: string;
  /** Committer date of the tip, Unix seconds. */
  date: number;
  /** Short name of the upstream, local branches only. */
  upstream?: string;
  /** Fully merged into the main branch (never set for the main branch itself). */
  merged: boolean;
}

const FORMAT = ['%(HEAD)', '%(refname)', '%(objectname)', '%(committerdate:unix)', '%(upstream:short)'].join('%00');

/** Parses `for-each-ref` output in FORMAT; `mergedRefs` holds full ref names merged into main. */
export function parseBranches(output: string, mergedRefs: ReadonlySet<string> = new Set()): BranchInfo[] {
  return output.split('\n').filter(Boolean).flatMap((line) => {
    const [head, ref, hash, date, upstream] = line.split('\0');
    const remote = ref.startsWith('refs/remotes/');
    // origin/HEAD is a pointer to another branch, not a branch.
    if (remote && ref.endsWith('/HEAD')) return [];
    return [{
      name: ref.replace(/^refs\/(heads|remotes)\//, ''),
      remote,
      current: head === '*',
      hash,
      date: Number(date),
      ...(upstream ? { upstream } : {}),
      merged: mergedRefs.has(ref),
    }];
  });
}

/** Local and remote-tracking branches, most recently committed first. */
export async function listBranches(repo: string, options?: RunOptions): Promise<BranchInfo[]> {
  const list = async (...extra: string[]) => {
    const r = await run(repo, ['for-each-ref', '--sort=-committerdate', ...extra, 'refs/heads', 'refs/remotes'], { noQueue: true, ...options });
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'git for-each-ref failed');
    return r.stdout;
  };
  const branches = parseBranches(await list(`--format=${FORMAT}`));
  const main = mainBranch(branches);
  if (!main) return branches;
  const merged = new Set((await list('--format=%(refname)', `--merged=${main.hash}`)).split('\n').filter(Boolean));
  return branches.map((b) => ({ ...b, merged: merged.has(`refs/${b.remote ? 'remotes' : 'heads'}/${b.name}`) && b.hash !== main.hash }));
}
