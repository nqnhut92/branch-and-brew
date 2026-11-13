// GIT_ASKPASS / SSH_ASKPASS main: git passes the prompt as the first argument and reads the answer
// from stdout. The prompt goes to the extension, which asks the user in VS Code.
'use strict';
const net = require('net');

const prompt = process.argv[2] || '';
const address = process.env.BAB_BRIDGE;
const token = process.env.BAB_BRIDGE_TOKEN;
if (!address || !token) process.exit(1);

const socket = net.createConnection(address);
let reply = '';
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(JSON.stringify({ token, kind: 'askpass', prompt }) + '\n'));
socket.on('data', (chunk) => { reply += chunk; });
socket.on('error', () => process.exit(1));
socket.on('end', () => {
  let answer;
  try { answer = JSON.parse(reply); } catch { process.exit(1); }
  if (answer.abort || typeof answer.answer !== 'string') process.exit(1);
  process.stdout.write(answer.answer + '\n');
  process.exit(0);
});
