import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeSyncPath, checkedDestination, hashFile } from './syncPaths.js';
import { getContentHash } from './contentHash.js';

export const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export class SyncStore {
  constructor(root, directory, { guard = () => true } = {}) {
    this.root = root;
    this.directory = normalizeSyncPath(directory);
    this.privateDir = '.nas-bot/peer-sync-v2';
    this.queue = Promise.resolve();
    this.guard = guard;
  }
  assertActive() { if (!this.guard()) throw new Error('同步关联已取消或授权已过期'); }
  async resolve(relative) {
    this.assertActive();
    return checkedDestination(this.root, this.directory + '/' + normalizeSyncPath(relative));
  }
  async staging() {
    this.assertActive();
    const dir = await checkedDestination(this.root, this.privateDir + '/staging');
    await fs.mkdir(dir, { recursive: true });
    return path.join(dir, crypto.randomUUID() + '.part');
  }
  async stat(relative) {
    const file = await this.resolve(relative);
    let stat;
    try { stat = await fs.stat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!stat.isFile()) throw new Error('Path is not a regular file: ' + relative);
    const contentHash = await getContentHash(file, stat);
    if (!validHash(contentHash)) throw new Error('File changed while hashing: ' + relative);
    return { path: relative, size: stat.size, contentHash, updatedAt: stat.mtime.toISOString() };
  }
  async scan() {
    this.assertActive();
    const entries = [], seen = new Set();
    const dir = await checkedDestination(this.root, this.directory);
    await fs.mkdir(dir, { recursive: true });
    const walk = async (prefix = '') => {
      const children = await fs.readdir(prefix ? await this.resolve(prefix) : dir, { withFileTypes: true });
      for (const entry of children) {
        if (entry.name.startsWith('.nas-')) continue;
        const relative = normalizeSyncPath(prefix ? prefix + '/' + entry.name : entry.name);
        if (entry.isSymbolicLink()) throw new Error('Sync refuses symbolic links: ' + relative);
        if (entry.isDirectory()) { await walk(relative); continue; }
        if (!entry.isFile()) throw new Error('Sync refuses special files');
        const key = relative.toLowerCase();
        if (seen.has(key)) throw new Error('Case-conflicting file paths');
        seen.add(key);
        const stat = await this.stat(relative);
        if (!stat) throw new Error('File disappeared while scanning');
        entries.push(stat);
        if (entries.length > 10000) throw new Error('Pilot supports at most 10000 files');
      }
    };
    await walk();
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  async capture(relative, expectedHash) {
    if (!validHash(expectedHash)) throw new Error('Expected content hash required');
    const record = await this.stat(relative);
    if (record?.contentHash !== expectedHash) throw new Error('Source changed: ' + relative);
    const temp = await this.staging();
    try {
      await fs.copyFile(await this.resolve(relative), temp, 1);
      if (await hashFile(temp) !== expectedHash) throw new Error('Source changed while capturing');
      return { ...record, temp };
    } catch (e) { await fs.unlink(temp).catch(() => {}); throw e; }
  }
  async commit(relative, temp, expectedHash, contentHash) {
    if (expectedHash !== null && !validHash(expectedHash)) throw new Error('Invalid destination precondition');
    if (!validHash(contentHash)) throw new Error('Invalid source hash');
    const task = this.queue.then(async () => {
      this.assertActive();
      const target = await this.resolve(relative);
      if (await hashFile(temp) !== contentHash) throw new Error('Incoming SHA256 mismatch');
      const current = await this.stat(relative);
      if ((current?.contentHash ?? null) !== expectedHash) throw new Error('Destination changed: ' + relative);
      const space = await fs.statfs(this.root);
      if (space.bavail * space.bsize < 32 * 1024 * 1024) throw new Error('Insufficient free space');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await this.resolve(relative);
      let version;
      if (current) {
        const versions = await checkedDestination(this.root, this.privateDir + '/versions');
        await fs.mkdir(versions, { recursive: true });
        version = path.join(versions, Date.now() + '-' + crypto.randomUUID() + '-' + path.basename(target).slice(-80));
        await fs.writeFile(version + '.json', JSON.stringify({ originalPath: this.directory + '/' + relative, previousHash: expectedHash, replacedByHash: contentHash, replacedAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
        // Move the old inode to versions: concurrent writers retain their data there.
        this.assertActive();
        await fs.rename(target, version);
      }
      try {
        if (version && await hashFile(version) !== expectedHash) throw new Error('Destination changed during commit');
        this.assertActive();
        // Publish without overwriting a file created after the final check.
        await fs.link(temp, target);
      } catch (e) {
        if (version) await fs.link(version, target).catch(() => {});
        throw e;
      }
      return { path: relative, contentHash };
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async remove(relative, expectedHash) {
    if (!validHash(expectedHash)) throw new Error('Deletion requires a content precondition');
    const task = this.queue.then(async () => {
      const target = await this.resolve(relative);
      const current = await this.stat(relative);
      if (current?.contentHash !== expectedHash) throw new Error('Destination changed before deletion: ' + relative);
      const trash = await checkedDestination(this.root, this.privateDir + '/trash');
      await fs.mkdir(trash, { recursive: true });
      const deletedAt = new Date().toISOString();
      const name = Date.now() + '-' + crypto.randomUUID();
      const saved = path.join(trash, name + '.bin');
      await fs.writeFile(path.join(trash, name + '.json'), JSON.stringify({ originalPath: this.directory + '/' + relative, contentHash: expectedHash, deletedAt }, null, 2), { flag: 'wx' });
      this.assertActive();
      await fs.rename(target, saved);
      if (!this.guard() || await hashFile(saved) !== expectedHash) {
        await fs.link(saved, target).catch(() => {});
        throw new Error('Destination changed during deletion');
      }
      return { path: relative, deletedAt };
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
