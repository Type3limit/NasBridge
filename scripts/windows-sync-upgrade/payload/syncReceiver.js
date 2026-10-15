import fs from 'node:fs';
import { SyncStore, validHash } from './syncStore.js';
import { hashFile, normalizeSyncPath } from './syncPaths.js';

// Dedicated authenticated-peer channel. It never accepts legacy generic uploads.
export function createSyncReceiver({ storageRoot, syncFiles, allowedPeer = process.env.SYNC_ALLOWED_PEER_ID, directory = process.env.SYNC_ALLOWED_DIR || 'sync-test', authorize }) {
  const channels = new Set();
  return { revoke() { for (const channel of channels) channel.close(); }, attach(channel, peerId) {
    if (!['nas-sync-v2', 'nas-sync-v3'].includes(channel.label)) return false;
    channels.add(channel);
    let store = authorize ? null : new SyncStore(storageRoot, directory), context;
    channel.binaryType = 'arraybuffer';
    let queue = Promise.resolve(), upload, closed = false, timer;
    const send = message => { if (channel.readyState === 'open') channel.send(JSON.stringify(message)); };
    const cleanup = async () => {
      clearTimeout(timer);
      if (upload) { const old = upload; upload = null; try { fs.closeSync(old.fd); } catch {} await fs.promises.unlink(old.temp).catch(() => {}); }
    };
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => { channel.close(); }, 60000); timer.unref?.(); };
    const drain = async () => {
      const start = Date.now();
      while (channel.bufferedAmount > 1024 * 1024) {
        if (closed || Date.now() - start > 30000) throw new Error('Channel drain failed');
        await new Promise(r => setTimeout(r, 10));
      }
      if (closed || channel.readyState !== 'open') throw new Error('Channel closed');
    };
    const process = async data => {
      if (closed) return;
      if (authorize) {
        if (channel.label !== 'nas-sync-v3') throw new Error('网页同步组要求新版协议');
        if (typeof data === 'string') {
          if (data.length > 65536) throw new Error('Control message too large');
          const message = JSON.parse(data);
          if (context && (context.groupId !== message.groupId || context.revision !== message.revision)) throw new Error('Channel scope changed');
          context = { groupId: message.groupId, revision: message.revision };
        }
        const policy = context && authorize(peerId, context);
        if (!policy) throw new Error('同步关联已取消或授权已过期');
        if (!store) store = new SyncStore(storageRoot, policy.directory, { guard: () => Boolean(authorize(peerId, context)) });
        if (store.directory !== policy.directory) throw new Error('Directory scope changed');
      } else if (!allowedPeer || peerId !== allowedPeer) throw new Error('Peer is not authorized for bidirectional sync');
      touch();
      if (typeof data !== 'string') {
        if (!upload) throw new Error('No active staged upload');
        const bytes = Buffer.from(data);
        if (upload.received + bytes.length > upload.size) throw new Error('Upload exceeds declared size');
        let offset = 0;
        while (offset < bytes.length) offset += fs.writeSync(upload.fd, bytes, offset);
        upload.received += bytes.length;
        return;
      }
      if (data.length > 65536) throw new Error('Control message too large');
      const m = JSON.parse(data), reply = value => send({ requestId: m.requestId, ...value });
      if (m.type === 'ping') { reply({ type: 'pong', ts: m.ts, version: authorize ? 3 : 2 }); return; }
      if (upload && m.type !== 'sync2-put-end') throw new Error('Upload already in progress');
      if (m.directory !== store.directory) throw new Error('Directory is not authorized');
      if (m.type === 'sync2-list') {
        const progress = setInterval(() => { touch(); reply({ type: 'sync2-progress' }); }, 5000);
        try {
          const files = await store.scan();
          reply({ type: 'sync2-list-start', version: 2 });
          for (const file of files) { await drain(); reply({ type: 'sync2-list-item', file }); }
          reply({ type: 'sync2-list-end', version: 2 });
        } finally { clearInterval(progress); }
        return;
      }
      normalizeSyncPath(m.path);
      if (m.type === 'sync2-stat') { reply({ type: 'sync2-stat', file: await store.stat(m.path) }); return; }
      if (m.type === 'sync2-delete') {
        await store.remove(m.path, m.expectedHash);
        reply({ type: 'sync2-deleted' });
        Promise.resolve().then(syncFiles).catch(() => {}); return;
      }
      if (m.type === 'sync2-get') {
        const captured = await store.capture(m.path, m.contentHash);
        try {
          reply({ type: 'file-meta', size: captured.size });
          for await (const bytes of fs.createReadStream(captured.temp, { highWaterMark: 32768 })) { await drain(); channel.send(bytes); touch(); }
          reply({ type: 'file-end' });
        } finally { await fs.promises.unlink(captured.temp).catch(() => {}); }
        return;
      }
      if (m.type === 'sync2-put-start') {
        if (!validHash(m.contentHash) || (m.expectedHash !== null && !validHash(m.expectedHash)) || !Number.isSafeInteger(m.size) || m.size < 0) throw new Error('Invalid upload metadata');
        const current = await store.stat(m.path);
        if ((current?.contentHash ?? null) !== m.expectedHash) throw new Error('Destination changed before upload');
        const space = await fs.promises.statfs(storageRoot);
        if (space.bavail * space.bsize < m.size + 64 * 1024 * 1024) throw new Error('Insufficient free space');
        const temp = await store.staging();
        upload = { ...m, temp, fd: fs.openSync(temp, 'wx'), received: 0 };
        reply({ type: 'sync2-put-ready' }); return;
      }
      if (m.type === 'sync2-put-end') {
        if (!upload || upload.path !== m.path || upload.requestId !== m.requestId || upload.received !== upload.size) throw new Error('Incomplete upload');
        fs.fsyncSync(upload.fd); fs.closeSync(upload.fd); upload.fd = -1;
        if (await hashFile(upload.temp) !== upload.contentHash) throw new Error('Upload SHA256 mismatch');
        await store.commit(upload.path, upload.temp, upload.expectedHash, upload.contentHash);
        await cleanup(); reply({ type: 'sync2-put-done' });
        Promise.resolve().then(syncFiles).catch(() => {}); return;
      }
      throw new Error('Unsupported sync protocol; upgrade both endpoints');
    };
    channel.onmessage = event => {
      queue = queue.then(async () => {
        const progress = typeof event.data === 'string' ? setInterval(() => { touch(); send({ type: 'sync2-progress' }); }, 5000) : null;
        try { await process(event.data); } finally { clearInterval(progress); }
      }).catch(async error => {
        send({ type: 'error', message: error.message }); await cleanup(); channel.close();
      });
    };
    channel.onclose = () => { closed = true; channels.delete(channel); queue.finally(cleanup).catch(() => {}); };
    channel.onerror = () => channel.close();
    channel.onopen = touch;
    return true;
  } };
}
