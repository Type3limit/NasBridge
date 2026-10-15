import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function normalizeSyncPath(value) {
  const text = String(value || '').replace(/\\/g, '/');
  if (!text || text.startsWith('/') || /[\x00-\x1f:]/.test(text)) throw new Error('Invalid sync path');
  const segments = text.split('/');
  if (segments.some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /[<>"|?*]/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) throw new Error('Invalid sync path');
  return segments.join('/');
}

export function syncPipeName(storageRoot) {
  const id = crypto.createHash('sha256').update(path.resolve(storageRoot)).digest('hex').slice(0, 16);
  return process.platform === 'win32' ? `\\\\.\\pipe\\NasBridgeSync-${id}` : path.join(storageRoot, '.nas-bot', `sync-${id}.sock`);
}

export async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function checkedDestination(root, relative) {
  const normalized = normalizeSyncPath(relative);
  const absoluteRoot = await fs.promises.realpath(root);
  let current = absoluteRoot;
  for (const segment of normalized.split('/')) {
    current = path.join(current, segment);
    try {
      if ((await fs.promises.lstat(current)).isSymbolicLink()) throw new Error('Sync refuses symlinks and junctions');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}

