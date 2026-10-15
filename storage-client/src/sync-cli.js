import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { syncPipeName } from './peerSync.js';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
const action = process.argv[2] || 'plan';
const socket = net.connect(syncPipeName(process.env.STORAGE_ROOT), () => socket.write(JSON.stringify({ action }) + '\n'));
let input = '';
socket.on('data', chunk => { input += chunk; });
socket.on('end', () => {
  const response = JSON.parse(input);
  console.log(JSON.stringify(response, null, 2));
  process.exitCode = response.ok ? 0 : 1;
});
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
