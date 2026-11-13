import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

export interface GitHttpServer {
  /** "127.0.0.1:<port>". */
  host: string;
  /** Requests that carried the right credentials, and those turned away with 401. */
  authorized: number;
  unauthorized: number;
  close(): Promise<void>;
}

/** Path of `git http-backend`, the CGI program git ships for serving repositories over HTTP. */
export function gitHttpBackend(): string | undefined {
  const dir = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  const file = path.join(dir, process.platform === 'win32' ? 'git-http-backend.exe' : 'git-http-backend');
  return existsSync(file) ? file : undefined;
}

/**
 * Serves the bare repositories under `root` over HTTP like a private git host: every request
 * needs Basic credentials, anything else gets 401. Smart HTTP through `git http-backend`.
 */
export async function startGitHttpServer(root: string, user: string, password: string): Promise<GitHttpServer> {
  const backend = gitHttpBackend();
  if (!backend) throw new Error('git http-backend is not installed');
  const expected = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const state = { authorized: 0, unauthorized: 0 };

  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      state.unauthorized++;
      req.resume();
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="private git"' }).end();
      return;
    }
    state.authorized++;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const child = spawn(backend, [], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: user,
        REQUEST_METHOD: req.method ?? 'GET', PATH_INFO: decodeURIComponent(url.pathname), QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
        GIT_CONFIG_NOSYSTEM: '1',
      },
      windowsHide: true,
    });
    req.pipe(child.stdin);
    child.stdin.on('error', () => undefined);
    // CGI output: header lines, an empty line, then the body.
    let head: Buffer | null = Buffer.alloc(0);
    child.stdout.on('data', (chunk: Buffer) => {
      if (!head) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString('latin1').split('\r\n')) {
        const colon = line.indexOf(':');
        const [name, value] = [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]) || 500;
        else if (name) headers[name] = value;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
      head = null;
    });
    child.on('close', () => {
      if (head) res.writeHead(500);
      res.end();
    });
    child.on('error', () => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    get authorized() { return state.authorized; },
    get unauthorized() { return state.unauthorized; },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
