import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import express from 'express';
import { frontendMiddleware } from '../server/src/frontend.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nasbridge-static-'));
const payload = 'console.log("asset");\n'.repeat(1000);
await fs.mkdir(path.join(dir, 'assets'));
await fs.writeFile(path.join(dir, 'assets', 'main-AbCd1234.js'), payload);
await fs.writeFile(path.join(dir, 'index.html'), '<h1>NAS Bridge</h1>');
await fs.writeFile(path.join(dir, 'favicon.svg'), '<svg/>');
const app = express();
app.get('/api/test', (_req, res) => res.json({ ok: true }));
app.use(frontendMiddleware(dir));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(base + url, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
try {
  const asset = await get('/assets/main-AbCd1234.js', { 'accept-encoding': 'gzip' });
  assert.equal(asset.headers['content-encoding'], 'gzip');
  assert.match(asset.headers['cache-control'], /max-age=31536000, immutable/);
  assert.match(asset.headers.vary, /Accept-Encoding/i);
  assert.equal(gunzipSync(asset.body).toString(), payload);
  const plain = await get('/assets/main-AbCd1234.js');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), payload);
  for (const url of ['/', '/favicon.svg']) {
    assert.equal((await get(url)).headers['cache-control'], 'no-cache');
  }
  assert.equal((await get('/assets/main-AbCd1234.js', { 'if-none-match': plain.headers.etag })).status, 304);
  const api = await get('/api/test');
  assert.equal(api.headers['cache-control'], undefined);
  assert.deepEqual(JSON.parse(api.body), { ok: true });
  console.log('PASS: compression negotiation, immutable assets, HTML revalidation, ETag, API isolation');
} finally {
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert(path.basename(dir).startsWith('nasbridge-static-'));
  await fs.rm(dir, { recursive: true, force: true });
}
