import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { execFile } from 'node:child_process';

export type HashAlgorithm = 'sha256' | 'sha512';

export interface DownloadOptions {
  url: string;
  /** Final file path. The file only appears there after the checksum matched. */
  dest: string;
  checksum: { algorithm: HashAlgorithm; hex: string };
  /** http://host:port of an HTTP proxy (CONNECT tunnel). Credentials in the URL are supported. */
  proxy?: string;
  /** Hosts to reach without the proxy, as in NO_PROXY. */
  noProxy?: string;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number | undefined) => void;
  /** Only for tests: allow plain http to localhost. */
  allowHttpLocalhost?: boolean;
}

export class DownloadError extends Error {
  override name = 'DownloadError';
}
export class ChecksumError extends DownloadError {
  override name = 'ChecksumError';
}

const MAX_REDIRECTS = 10;

/** The proxy to use: an explicit setting wins over HTTPS_PROXY / https_proxy / HTTP_PROXY. */
export function resolveProxy(setting: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = setting?.trim() || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  return value?.trim() || undefined;
}

export function bypassesProxy(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const h = host.toLowerCase();
  return noProxy.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((entry) => {
    if (entry === '*') return true;
    const bare = entry.replace(/^\*?\./, '');
    return h === bare || h.endsWith(`.${bare}`);
  });
}

/**
 * Downloads to `<dest>.part`, hashing as it goes, and renames to `dest` only when the checksum
 * matches. HTTPS only (redirects included). Follows redirects; honours an HTTP proxy.
 */
export async function download(options: DownloadOptions): Promise<void> {
  mkdirSync(path.dirname(options.dest), { recursive: true });
  const part = `${options.dest}.part`;
  rmSync(part, { force: true });
  try {
    const res = await get(options.url, options);
    const total = Number(res.headers['content-length']) || undefined;
    const hash = createHash(options.checksum.algorithm);
    let received = 0;
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(part);
      res.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        received += chunk.length;
        options.onProgress?.(received, total);
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      options.signal?.addEventListener('abort', () => res.destroy(new DownloadError('download cancelled')), { once: true });
      res.pipe(out);
    });
    const actual = hash.digest('hex');
    if (actual.toLowerCase() !== options.checksum.hex.trim().toLowerCase()) {
      throw new ChecksumError(`checksum mismatch: expected ${options.checksum.hex}, got ${actual}`);
    }
    renameSync(part, options.dest);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
}

export type ConnectionOptions = Pick<DownloadOptions, 'proxy' | 'noProxy' | 'signal' | 'allowHttpLocalhost'> & {
  /** Extra request headers (Authorization for REST calls). Dropped when a redirect leaves the host. */
  headers?: Record<string, string>;
};

/** GET that follows redirects (HTTPS only) and resolves with a 200 response. */
async function get(href: string, options: ConnectionOptions): Promise<http.IncomingMessage> {
  let url = new URL(href);
  for (let i = 0; ; i++) {
    checkScheme(url, options);
    const res = await request(url, options);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (i >= MAX_REDIRECTS) throw new DownloadError('too many redirects');
      const next = new URL(res.headers.location, url);
      // Credentials are for the host they were given for, nobody else.
      if (next.host !== url.host && options.headers) options = { ...options, headers: undefined };
      url = next;
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new DownloadError(`HTTP ${status} from ${url.host}`);
    }
    return res;
  }
}

/** Fetches a small text document with the same proxy and HTTPS rules as downloads. */
export async function fetchText(href: string, options: ConnectionOptions = {}): Promise<string> {
  const res = await get(href, options);
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Like fetchText, with the response headers (lower-case names). */
export async function fetchWithHeaders(href: string, options: ConnectionOptions = {}): Promise<{ text: string; headers: http.IncomingHttpHeaders }> {
  const res = await get(href, options);
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return { text: Buffer.concat(chunks).toString('utf8'), headers: res.headers };
}

/** Fetches and parses a JSON document. */
export async function fetchJson(href: string, options: ConnectionOptions = {}): Promise<unknown> {
  return JSON.parse(await fetchText(href, options));
}

function checkScheme(url: URL, options: ConnectionOptions): void {
  if (url.protocol === 'https:') return;
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol === 'http:' && local && options.allowHttpLocalhost) return;
  throw new DownloadError(`refusing non-HTTPS download: ${url.protocol}//${url.host}`);
}

function request(url: URL, options: ConnectionOptions): Promise<http.IncomingMessage> {
  const secure = url.protocol === 'https:';
  const port = Number(url.port) || (secure ? 443 : 80);
  const useProxy = options.proxy && !bypassesProxy(url.hostname, options.noProxy);
  return new Promise((resolve, reject) => {
    const send = (socket?: net.Socket) => {
      const reqOptions: https.RequestOptions = {
        method: 'GET',
        host: url.hostname,
        port,
        path: url.pathname + url.search,
        headers: { 'User-Agent': 'branch-and-brew', Accept: '*/*', ...options.headers },
        signal: options.signal,
      };
      if (socket) {
        reqOptions.createConnection = () =>
          secure ? tls.connect({ socket, servername: url.hostname }) : socket;
      }
      const req = (secure ? https : http).request(reqOptions, resolve);
      req.on('error', reject);
      req.end();
    };
    if (!useProxy) return send();
    const proxy = new URL(options.proxy!);
    const headers: http.OutgoingHttpHeaders = { Host: `${url.hostname}:${port}` };
    if (proxy.username) {
      const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
    }
    const connect = http.request({
      host: proxy.hostname, port: Number(proxy.port) || 80, method: 'CONNECT', path: `${url.hostname}:${port}`, headers,
      signal: options.signal,
    });
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new DownloadError(`proxy refused CONNECT: HTTP ${res.statusCode}`));
      }
      send(socket);
    });
    connect.on('error', reject);
    connect.end();
  });
}

/**
 * Extracts a .zip or .tar.gz with the system tar (bsdtar on macOS and on Windows 10+, which also
 * reads zip). On Windows the System32 tar is used explicitly so Git's GNU tar is never picked up.
 */
export function extract(archive: string, destDir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const tar = platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', archive, '-C', destDir], { windowsHide: true }, (err, _out, stderr) =>
      err ? reject(new DownloadError(`extract failed: ${stderr || err.message}`)) : resolve());
  });
}

/** Finds the JDK home inside an extracted folder: the directory whose bin/ holds java. */
export function findJavaHome(dir: string, platform: NodeJS.Platform = process.platform, depth = 4): string | undefined {
  const exe = platform === 'win32' ? 'java.exe' : 'java';
  if (existsSync(path.join(dir, 'bin', exe))) return dir;
  if (depth === 0) return undefined;
  for (const name of readdirSync(dir)) {
    const child = path.join(dir, name);
    if (!statSync(child).isDirectory()) continue;
    const found = findJavaHome(child, platform, depth - 1);
    if (found) return found;
  }
  return undefined;
}
