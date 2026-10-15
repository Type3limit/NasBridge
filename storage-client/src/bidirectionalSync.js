import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeSyncPath, hashFile } from './syncPaths.js';
import { validHash } from './syncStore.js';

export function planBidirectional(local, remote, bases = {}) {
  const casing = new Map();
  const validate = files => {
    const result = new Map();
    for (const file of files) {
      normalizeSyncPath(file.path);
      if (!validHash(file.contentHash) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Fresh SHA256 metadata is required');
      const parts = file.path.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/'), key = prefix.toLowerCase();
        if (casing.has(key) && casing.get(key) !== prefix) throw new Error('Case-conflicting paths across endpoints');
        casing.set(key, prefix);
      }
      if (result.has(file.path)) throw new Error('Duplicate inventory path');
      result.set(file.path, file);
    }
    return result;
  };
  const left = validate(local), right = validate(remote);
  return [...new Set([...left.keys(), ...right.keys(), ...Object.keys(bases)])].sort().map(name => {
    const l = left.get(name), r = right.get(name), base = Object.hasOwn(bases, name) ? bases[name] : undefined;
    if (base && !validHash(base)) throw new Error('Invalid synchronization baseline');
    normalizeSyncPath(name);
    const action = !l && !r ? 'deleted-both'
      : !l ? base ? r.contentHash === base ? 'delete-remote' : 'delete-conflict-remote' : 'pull'
      : !r ? base ? l.contentHash === base ? 'delete-local' : 'delete-conflict-local' : 'push'
      : l.contentHash === r.contentHash ? 'same'
      : l.contentHash === base ? 'pull' : r.contentHash === base ? 'push' : 'conflict';
    return { path: name, local: l || null, remote: r || null, action };
  });
}
export function conflictPath(relative, hash, deleted = false) {
  const ext = path.posix.extname(relative).slice(0, 20);
  const stem = path.posix.basename(relative, path.posix.extname(relative)).slice(0, 60);
  const dir = path.posix.dirname(relative);
  const name = `${stem}.sync-conflict-${deleted ? 'deleted-' : ''}${hash}${ext}`;
  return normalizeSyncPath(dir === '.' ? name : dir + '/' + name);
}

export async function runBidirectional({ store, remote, stateFile, identity, planOnly = false, check = () => {} }) {
  check();
  let state = { version: 2, identity, bases: {}, tombstones: {} };
  try {
    state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (state.version !== 2 || state.identity !== identity || !state.bases || typeof state.bases !== 'object' || Array.isArray(state.bases)) throw new Error('Synchronization state belongs to another directory pair');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // Prototype-free bases also support legitimate filenames such as __proto__.
  state.bases = Object.assign(Object.create(null), state.bases);
  state.tombstones = Object.assign(Object.create(null), state.tombstones || {});
  const plan = planBidirectional(await store.scan(), await remote.scan(), state.bases);
  if (planOnly) return { mode: 'bidirectional', deletes: 'both-with-trash', files: plan.map(({ path, action }) => ({ path, action })) };
  const result = { mode: 'bidirectional', startedAt: new Date().toISOString(), pulled: 0, pushed: 0, deletedLocal: 0, deletedRemote: 0, unchanged: 0, conflicts: [], downloadedBytes: 0, uploadedBytes: 0, deletes: 'both-with-trash' };
  const persist = async () => {
    check();
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const temp = stateFile + '.' + crypto.randomUUID() + '.tmp';
    await fs.writeFile(temp, JSON.stringify(state, null, 2));
    await fs.rename(temp, stateFile);
  };
  const checkpoint = async (name, expected) => {
    const l = await store.stat(name), r = await remote.stat(name);
    if (l?.contentHash !== expected || r?.contentHash !== expected) throw new Error('File changed before synchronization checkpoint: ' + name);
    state.bases[name] = expected;
    delete state.tombstones[name];
    await persist();
  };
  const pull = async (record, name, expected) => {
    const temp = await store.staging();
    try {
      await remote.download(record, temp);
      if (await hashFile(temp) !== record.contentHash) throw new Error('Source hash mismatch');
      await store.commit(name, temp, expected, record.contentHash);
      result.pulled++; result.downloadedBytes += record.size;
    } finally { await fs.unlink(temp).catch(() => {}); }
  };
  const push = async (name, sourceName, hash, expected) => {
    const capture = await store.capture(sourceName, hash);
    try {
      await remote.upload(name, capture, expected);
      result.pushed++; result.uploadedBytes += capture.size;
    } finally { await fs.unlink(capture.temp).catch(() => {}); }
  };
  for (const entry of plan) {
    check();
    const { path: name, local: l, remote: r, action } = entry;
    if (action.startsWith('delete')) {
      if (action.startsWith('delete-conflict-')) {
        const changed = l || r, copy = conflictPath(name, changed.contentHash, true);
        const lc = await store.stat(copy), rc = await remote.stat(copy);
        if ((lc && lc.contentHash !== changed.contentHash) || (rc && rc.contentHash !== changed.contentHash)) throw new Error('Deletion conflict-copy name is occupied');
        if (!lc) {
          if (r) await pull(r, copy, null);
          else {
            const captured = await store.capture(name, l.contentHash);
            try { await store.commit(copy, captured.temp, null, l.contentHash); }
            finally { await fs.unlink(captured.temp).catch(() => {}); }
          }
        }
        if (!rc) await push(copy, copy, changed.contentHash, null);
        await checkpoint(copy, changed.contentHash);
        result.conflicts.push({ path: name, preservedAs: copy, reason: 'delete-versus-edit' });
      }
      if (l) { await store.remove(name, l.contentHash); result.deletedLocal++; }
      if (r) { await remote.remove(name, r.contentHash); result.deletedRemote++; }
      if (await store.stat(name) || await remote.stat(name)) throw new Error('File recreated during deletion');
      state.tombstones[name] = { previousHash: state.bases[name], deletedAt: new Date().toISOString() };
      delete state.bases[name];
      await persist();
      continue;
    }
    if (action === 'same') {
      state.bases[name] = l.contentHash; delete state.tombstones[name]; result.unchanged++;
      continue;
    }
    if (action === 'pull') {
      await pull(r, name, l?.contentHash ?? null);
      await checkpoint(name, r.contentHash);
    } else if (action === 'push') {
      await push(name, name, l.contentHash, r?.contentHash ?? null);
      await checkpoint(name, l.contentHash);
    } else {
      // Preserve the remote version under a deterministic conflict name on BOTH nodes.
      // The coordinator's version remains at the original path; neither version is lost.
      const copy = conflictPath(name, r.contentHash);
      const lc = await store.stat(copy), rc = await remote.stat(copy);
      if ((lc && lc.contentHash !== r.contentHash) || (rc && rc.contentHash !== r.contentHash)) throw new Error('Conflict-copy filename already contains different data: ' + copy);
      if (!lc) await pull(r, copy, null);
      if (!rc) await push(copy, copy, r.contentHash, null);
      await checkpoint(copy, r.contentHash);
      await push(name, name, l.contentHash, r.contentHash);
      await checkpoint(name, l.contentHash);
      result.conflicts.push({ path: name, preservedAs: copy });
    }
  }
  await persist();
  result.finishedAt = new Date().toISOString();
  return result;
}
