import { run, type RunOptions } from './runner';

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  /** Author date, Unix seconds. */
  date: number;
  /** Decorations as git prints them with %D, e.g. "HEAD -> main", "origin/main", "tag: v1". */
  refs: string[];
  subject: string;
}

/** Fields separated by US (0x1f); commits separated by NUL via -z. */
const FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s'].join('%x1f');
export const PAGE_SIZE = 500;

export function parseLog(output: string): Commit[] {
  return output.split('\0').filter((r) => r.trim()).map((record) => {
    const [hash, parents, author, email, date, refs, subject] = record.replace(/^\n/, '').split('\x1f');
    return {
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date: Number(date),
      refs: refs ? refs.split(', ') : [],
      subject: subject ?? '',
    };
  });
}

export interface LogQuery {
  /** Revisions to include, e.g. ["HEAD", "origin/main"]. Defaults to HEAD. */
  revs?: string[];
  skip?: number;
  limit?: number;
  /** Keep only commits whose subject, author, email or hash contains this text (any case). */
  search?: string;
  /** Keep only commits that touch this path. */
  path?: string;
}

/** True when the commit's subject, author, email or hash contains `text`, ignoring case. */
export function matchesSearch(commit: Commit, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  return [commit.subject, commit.author, commit.email].some((s) => s.toLowerCase().includes(needle))
    || commit.hash.startsWith(needle);
}

/**
 * One page of history in topological order (children before parents), as the graph needs.
 * A search reads the whole history of the revisions and filters it here, because git cannot
 * match "message or author or hash" in one pass.
 */
export async function getLog(repo: string, query: LogQuery = {}, options?: RunOptions): Promise<Commit[]> {
  const limit = query.limit ?? PAGE_SIZE;
  const skip = query.skip ?? 0;
  const search = query.search?.trim();
  const args = [
    'log', '-z', `--format=${FORMAT}`, '--topo-order', '--decorate=short',
    ...(search ? [] : [`--max-count=${limit}`, `--skip=${skip}`]),
    ...(query.revs?.length ? query.revs : ['HEAD']), '--', ...(query.path ? [query.path] : []),
  ];
  const r = await run(repo, args, { noQueue: true, ...options });
  if (r.exitCode !== 0) {
    // An unborn branch has no history yet.
    if (/does not have any commits yet|bad (default )?revision 'HEAD'/.test(r.stderr)) return [];
    throw new Error(r.stderr.trim() || 'git log failed');
  }
  const commits = parseLog(r.stdout);
  return search ? commits.filter((c) => matchesSearch(c, search)).slice(skip, skip + limit) : commits;
}
