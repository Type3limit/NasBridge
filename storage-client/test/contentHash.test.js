import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getContentHash } from '../src/contentHash.js';
test('content identity changes for different same-length data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nasbridge-hash-'));
  try {
    const file = path.join(root, 'file');
    await fs.writeFile(file, 'abc'); const original = await getContentHash(file);
    assert.equal(await getContentHash(file), original);
    await fs.writeFile(file, 'xyz');
    await fs.utimes(file, new Date('2026-10-14'), new Date('2026-10-14'));
    assert.notEqual(await getContentHash(file), original);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
