import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPeerSync, normalizeSyncPath, checkedDestination, hashFile } from '../src/peerSync.js';

test('sync paths reject traversal, alternate streams and Windows aliases', () => {
  for (const invalid of ['../x', '/tmp/a', 'C:/x', 'a/../b', 'a//b', 'a./b', 'a/CON.txt', 'a/b:stream', 'a/b?']) assert.throws(() => normalizeSyncPath(invalid));
  assert.equal(normalizeSyncPath('sync-test\\视频.mp4'), 'sync-test/视频.mp4');
});

test('one-way backup skips unchanged data, versions updates, preserves local conflicts and source deletions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nasbridge-sync-test-'));
  const oldEnv = { ...process.env };
  let content = Buffer.from('first version'), stamp = '2026-10-14T00:00:00.000Z', exists = true, failDownload = false, downloads = 0;
  try {
    process.env.SYNC_SOURCE_CLIENT_ID = 'source';
    process.env.SYNC_SOURCE_DIR = 'sync-test';
    process.env.SYNC_TARGET_DIR = 'sync-test';
    const sync = createPeerSync({
      storageRoot: root, syncFiles: async () => {},
      api: async endpoint => endpoint === '/api/clients' ? { clients: [{ id: 'source', status: 'online' }] } : { files: exists ? [{ clientId: 'source', path: 'sync-test/a.txt', size: content.length, updatedAt: stamp }] : [] },
      peerFactory: () => ({
        open: async () => {}, close() {}, ping: async () => ({ route: 'direct' }),
        download: async (file, output) => {
          downloads++;
          await fs.writeFile(output, content);
          if (failDownload) throw new Error('disconnected');
          return { sha256: await hashFile(output), bytes: content.length, durationMs: 1 };
        }
      })
    });
    assert.equal((await sync.execute('plan')).files[0].action, 'copy');
    assert.equal((await sync.execute('run')).copied, 1);
    assert.equal((await sync.execute('run')).skipped, 1);
    assert.equal(downloads, 1);
    content = Buffer.from('second version'); stamp = '2026-10-14T01:00:00.000Z';
    failDownload = true;
    await assert.rejects(sync.execute('run'), /disconnected/);
    assert.equal(await fs.readFile(path.join(root, 'sync-test/a.txt'), 'utf8'), 'first version');
    failDownload = false;
    assert.equal((await sync.execute('run')).updated, 1);
    const versions = await fs.readdir(path.join(root, '.nas-bot/peer-sync/versions'));
    assert.equal(versions.length, 1);
    assert.equal(await fs.readFile(path.join(root, '.nas-bot/peer-sync/versions', versions[0]), 'utf8'), 'first version');
    await fs.writeFile(path.join(root, 'sync-test/a.txt'), 'local edits');
    assert.deepEqual((await sync.execute('run')).conflicts, ['sync-test/a.txt']);
    assert.equal(await fs.readFile(path.join(root, 'sync-test/a.txt'), 'utf8'), 'local edits');
    exists = false;
    await sync.execute('run');
    assert.equal(await fs.readFile(path.join(root, 'sync-test/a.txt'), 'utf8'), 'local edits');
    assert.deepEqual(await fs.readdir(path.join(root, '.nas-bot/peer-sync/staging')), []);
  } finally {
    for (const key of ['SYNC_SOURCE_CLIENT_ID', 'SYNC_SOURCE_DIR', 'SYNC_TARGET_DIR']) oldEnv[key] === undefined ? delete process.env[key] : process.env[key] = oldEnv[key];
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('destination refuses a directory junction escaping storage root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nasbridge-sync-junction-'));
  try {
    await fs.mkdir(path.join(root, 'storage')); await fs.mkdir(path.join(root, 'outside'));
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'storage/link'), 'junction');
    await assert.rejects(checkedDestination(path.join(root, 'storage'), 'link/file.txt'), /symlinks|junctions/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
