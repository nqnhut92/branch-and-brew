// Runs as git's editor. Sends the file git wants edited to the extension over a local socket or
// named pipe, waits for the answer, writes it back, and exits. Exit code 1 makes git abort.
// Plain Node, no dependencies: it runs from the installed extension folder.
'use strict';
const fs = require('fs');
const net = require('net');

module.exports = function runClient(kind) {
  const file = process.argv[2];
  const address = process.env.BAB_BRIDGE;
  const token = process.env.BAB_BRIDGE_TOKEN;
  if (!file || !address || !token) {
    process.stderr.write('branch-and-brew: editor bridge is not configured\n');
    process.exit(1);
  }
  const request = JSON.stringify({ token, kind, file, content: fs.readFileSync(file, 'utf8') }) + '\n';
  const socket = net.createConnection(address);
  let reply = '';
  socket.setEncoding('utf8');
  socket.on('connect', () => socket.write(request));
  socket.on('data', (chunk) => { reply += chunk; });
  socket.on('error', (err) => {
    process.stderr.write(`branch-and-brew: editor bridge failed: ${err.message}\n`);
    process.exit(1);
  });
  socket.on('end', () => {
    let answer;
    try { answer = JSON.parse(reply); } catch {
      process.stderr.write('branch-and-brew: bad answer from editor bridge\n');
      process.exit(1);
    }
    if (answer.abort || typeof answer.content !== 'string') process.exit(1);
    fs.writeFileSync(file, answer.content);
    process.exit(0);
  });
};
