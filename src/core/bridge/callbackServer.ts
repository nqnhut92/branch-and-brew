import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export interface CallbackServer {
  /** Socket path or named pipe the helper scripts connect to. */
  address: string;
  /** Random secret every request must carry. */
  token: string;
  close(): Promise<void>;
}

/**
 * Local server for the helper scripts git runs (editors, askpass). Unix socket in a private temp
 * folder on macOS and Linux, a named pipe on Windows. One JSON request line per connection, one
 * JSON reply. Requests without the right token, or that make the handler throw, get `{ abort: true }`.
 */
export async function startCallbackServer(
  handler: (request: Record<string, unknown>) => Promise<object>,
  platform: NodeJS.Platform = process.platform,
): Promise<CallbackServer> {
  const token = randomBytes(24).toString('hex');
  let socketDir: string | undefined;
  let address: string;
  if (platform === 'win32') {
    address = `\\\\.\\pipe\\branch-and-brew-${randomBytes(12).toString('hex')}`;
  } else {
    socketDir = mkdtempSync(path.join(tmpdir(), 'bab-'));
    address = path.join(socketDir, 'bridge.sock');
  }

  async function answer(line: string): Promise<object> {
    try {
      const req = JSON.parse(line) as Record<string, unknown>;
      if (req.token !== token) return { abort: true };
      return await handler(req);
    } catch {
      return { abort: true };
    }
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      void answer(buffer.slice(0, newline)).then((reply) => socket.end(JSON.stringify(reply)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => resolve());
  });

  return {
    address,
    token,
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        if (socketDir) rmSync(socketDir, { recursive: true, force: true });
        resolve();
      });
    }),
  };
}
