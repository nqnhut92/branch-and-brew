import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeTempDir } from '../../../test/fixtures/cleanup';
import {
  ChecksumError, DownloadError, bypassesProxy, download, extract, fetchJson, fetchText, findJavaHome, resolveProxy,
} from './download';

const tmp = mkdtempSync(path.join(tmpdir(), 'bab-dl-'));
const body = Buffer.from('x'.repeat(100_000));
const sha256 = createHash('sha256').update(body).digest('hex');
let server: http.Server;
let proxy: http.Server;
let base = '';
let proxyUrl = '';
const proxied: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/file') res.writeHead(200, { 'Content-Length': body.length }).end(body);
    else if (req.url === '/redirect') res.writeHead(302, { Location: '/file' }).end();
    else if (req.url === '/json') res.writeHead(200).end('{"a":1}');
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;

  // Minimal CONNECT proxy that requires Basic auth.
  proxy = http.createServer((_req, res) => res.writeHead(405).end());
  proxy.on('connect', (req, client: net.Socket, head) => {
    if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('u:p w').toString('base64')}`) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    proxied.push(req.url!);
    const [host, port] = req.url!.split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyUrl = `http://u:p%20w@127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  proxy.close();
  removeTempDir(tmp);
});

const opts = { allowHttpLocalhost: true, checksum: { algorithm: 'sha256' as const, hex: sha256 } };

describe('download', () => {
  it('downloads, follows a redirect, verifies the checksum and reports progress', async () => {
    const dest = path.join(tmp, 'a', 'file.bin');
    let last = 0;
    await download({ ...opts, url: `${base}/redirect`, dest, onProgress: (n) => { last = n; } });
    expect(readFileSync(dest)).toEqual(body);
    expect(last).toBe(body.length);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('leaves nothing behind when the checksum does not match', async () => {
    const dest = path.join(tmp, 'bad.bin');
    await expect(download({ ...opts, url: `${base}/file`, dest, checksum: { algorithm: 'sha256', hex: '00' } }))
      .rejects.toBeInstanceOf(ChecksumError);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('refuses plain http unless it is a localhost test', async () => {
    await expect(download({ ...opts, allowHttpLocalhost: false, url: `${base}/file`, dest: path.join(tmp, 'x') }))
      .rejects.toThrow(/non-HTTPS/);
    await expect(download({ ...opts, url: 'http://example.com/file', dest: path.join(tmp, 'x') }))
      .rejects.toThrow(/non-HTTPS/);
  });

  it('reports HTTP errors', async () => {
    await expect(download({ ...opts, url: `${base}/missing`, dest: path.join(tmp, 'y') }))
      .rejects.toBeInstanceOf(DownloadError);
  });

  it('goes through an authenticating CONNECT proxy', async () => {
    const dest = path.join(tmp, 'via-proxy.bin');
    proxied.length = 0;
    await download({ ...opts, url: `${base}/file`, dest, proxy: proxyUrl });
    expect(readFileSync(dest)).toEqual(body);
    expect(proxied).toHaveLength(1);
    await expect(download({ ...opts, url: `${base}/file`, dest: path.join(tmp, 'z'), proxy: proxyUrl.replace('p%20w', 'bad') }))
      .rejects.toThrow(/407/);
  });

  it('skips the proxy for NO_PROXY hosts', async () => {
    proxied.length = 0;
    await download({ ...opts, url: `${base}/file`, dest: path.join(tmp, 'np.bin'), proxy: proxyUrl, noProxy: '127.0.0.1' });
    expect(proxied).toHaveLength(0);
  });

  it('fetches text and JSON', async () => {
    expect(await fetchText(`${base}/json`, { allowHttpLocalhost: true })).toBe('{"a":1}');
    expect(await fetchJson(`${base}/json`, { allowHttpLocalhost: true })).toEqual({ a: 1 });
  });
});

describe('proxy settings', () => {
  it('prefers the setting, then HTTPS_PROXY', () => {
    expect(resolveProxy('http://set:1', { HTTPS_PROXY: 'http://env:2' })).toBe('http://set:1');
    expect(resolveProxy('', { HTTPS_PROXY: 'http://env:2' })).toBe('http://env:2');
    expect(resolveProxy(undefined, {})).toBeUndefined();
  });
  it('matches NO_PROXY entries', () => {
    expect(bypassesProxy('api.adoptium.net', '.adoptium.net')).toBe(true);
    expect(bypassesProxy('adoptium.net', 'adoptium.net,localhost')).toBe(true);
    expect(bypassesProxy('github.com', 'adoptium.net')).toBe(false);
    expect(bypassesProxy('x', '*')).toBe(true);
  });
});

describe('extract and findJavaHome', () => {
  it('extracts a tar.gz and finds bin/java at any depth', async () => {
    const src = path.join(tmp, 'src');
    const home = path.join(src, 'jdk-17', 'Contents', 'Home', 'bin');
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, process.platform === 'win32' ? 'java.exe' : 'java'), '');
    const archive = path.join(tmp, 'jdk.tar.gz');
    // Same tar as extract(): on Windows Git's GNU tar would read "C:" as a remote host.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-czf', archive, '-C', src, 'jdk-17']);
    const out = path.join(tmp, 'out');
    await extract(archive, out);
    expect(findJavaHome(out)).toBe(path.join(out, 'jdk-17', 'Contents', 'Home'));
    expect(findJavaHome(path.join(tmp, 'a'))).toBeUndefined();
  });
});
