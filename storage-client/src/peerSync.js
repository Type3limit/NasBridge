import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import wrtc from '@roamhq/wrtc';
import { SyncStore } from './syncStore.js';
import { runBidirectional } from './bidirectionalSync.js';

import { normalizeSyncPath, syncPipeName, hashFile, checkedDestination } from './syncPaths.js';
export { normalizeSyncPath, syncPipeName, hashFile, checkedDestination } from './syncPaths.js';

export class OutgoingPeer {
  constructor(remoteId, sendSignal, iceServers, channelLabel = 'nas-sync', context = {}) {
    this.remoteId = remoteId;
    this.context = context;
    this.sendSignal = payload => sendSignal(remoteId, payload);
    this.pc = new wrtc.RTCPeerConnection({ iceServers });
    this.channel = this.pc.createDataChannel(channelLabel, { ordered: true });
    this.channel.binaryType = 'arraybuffer';
    this.pendingIce = [];
    this.processing = Promise.resolve();
    this.pc.onicecandidate = ({ candidate }) => { if (candidate) this.sendSignal({ kind: 'ice', candidate }); };
    this.channel.onmessage = event => this.active?.message(event.data);
    this.channel.onclose = () => this.active?.fail(new Error('P2P channel closed'));
    this.channel.onerror = () => this.active?.fail(new Error('P2P channel error'));
  }
  async open() {
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('P2P connection timed out')), 30000);
      this.channel.onopen = () => { clearTimeout(timer); resolve(); };
    });
    // Attach the rejection handler before negotiation can fail.
    ready.catch(() => {});
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.sendSignal({ kind: 'offer', sdp: this.pc.localDescription });
    await ready;
    if (['nas-sync-v2', 'nas-sync-v3'].includes(this.channel.label)) {
      this.keepalive = setInterval(() => {
        if (this.channel.readyState === 'open') {
          try { this.channel.send(JSON.stringify({ ...this.context, type: 'ping', requestId: 'keepalive', ts: Date.now() })); } catch {}
        }
      }, 10000);
      this.keepalive.unref?.();
    }
  }
  signal(payload) {
    this.processing = this.processing.then(async () => {
      if (payload.kind === 'answer') {
        await this.pc.setRemoteDescription(payload.sdp);
        for (const c of this.pendingIce) await this.pc.addIceCandidate(c);
        this.pendingIce = [];
      } else if (payload.kind === 'ice' && payload.candidate) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(payload.candidate);
        else this.pendingIce.push(payload.candidate);
      }
    }).catch(error => this.active?.fail(error));
  }
  request(request, onMessage, onBinary = () => { throw new Error('Unexpected binary response'); }) {
    request = { ...this.context, ...request };
    if (this.active) return Promise.reject(new Error('Peer is busy'));
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, value) => {
        clearTimeout(timer); this.active = null;
        error ? reject(error) : resolve(value);
      };
      const touch = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('P2P transfer idle timeout')), 30000); };
      this.active = {
        fail: error => finish(error),
        message: data => {
          try {
            if (typeof data !== 'string') { touch(); return onBinary(Buffer.from(data)); }
            const message = JSON.parse(data);
            if (message.requestId && message.requestId !== request.requestId) return;
            touch();
            if (message.type === 'error') throw new Error(message.message);
            const result = onMessage(message);
            if (result !== undefined) finish(null, result);
          } catch (error) { finish(error); }
        }
      };
      touch();
      try { this.channel.send(JSON.stringify(request)); } catch (error) { finish(error); }
    });
  }
  async ping() {
    const start = Date.now();
    const pong = await this.request({ type: 'ping', ts: start }, m => m.type === 'pong' ? m : undefined);
    if (this.channel.label === 'nas-sync-v2' && pong.version !== 2) throw new Error('远端尚未启用双向同步协议，请安装最终升级包并重启远端；本次未改动文件');
    if (this.channel.label === 'nas-sync-v3' && pong.version !== 3) throw new Error('远端需要升级网页同步组协议');
    const stats = await this.pc.getStats();
    let pair;
    stats.forEach(s => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
    if (!pair) stats.forEach(s => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pair = s; });
    const local = stats.get(pair?.localCandidateId), remote = stats.get(pair?.remoteCandidateId);
    return { pingMs: Date.now() - start, route: local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : pair ? 'direct' : 'unknown', protocol: local?.protocol, localType: local?.candidateType, remoteType: remote?.candidateType };
  }
  async download(file, output) {
    const fd = fs.openSync(output, 'wx');
    let received = 0, meta;
    const hash = crypto.createHash('sha256');
    const started = Date.now();
    try {
      await this.request({ type: file.requestType || 'get-file', path: file.path, directory: file.directory, contentHash: file.contentHash, requestId: crypto.randomUUID() }, message => {
        if (message.type === 'file-meta') {
          meta = message;
          if (message.size !== file.size) throw new Error('Source size changed; retry synchronization');
        }
        if (message.type === 'file-end') {
          if (!meta || received !== file.size) throw new Error('Incomplete file');
          return true;
        }
      }, chunk => {
        if (!meta || received + chunk.length > file.size) throw new Error('Unexpected transfer size');
        let offset = 0;
        while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset);
        received += chunk.length; hash.update(chunk);
      });
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const sha256 = hash.digest('hex');
    if (file.contentHash && file.contentHash !== sha256) throw new Error('Source SHA256 mismatch');
    if (await hashFile(output) !== sha256) throw new Error('Local SHA256 readback mismatch');
    return { sha256, bytes: received, durationMs: Date.now() - started };
  }
  async uploadFixture(relative, bytes) {
    const requestId = crypto.randomUUID();
    await this.request({ type: 'put-file-start', path: relative, size: bytes.length, requestId }, m => m.type === 'put-file-ack' ? true : undefined);
    const completed = this.request({ type: 'ping', ts: Date.now(), requestId }, m => m.type === 'put-file-finish' ? m : undefined);
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      while (this.channel.bufferedAmount > 1024 * 1024) await new Promise(r => setTimeout(r, 10));
      this.channel.send(bytes.subarray(offset, offset + 32768));
    }
    this.channel.send(JSON.stringify({ type: 'put-file-end', requestId }));
    await completed;
  }
  remoteStore(directory) {
    const call = (type, body, receive) => this.request({ type, directory, requestId: crypto.randomUUID(), ...body }, receive);
    return {
      scan: async () => {
        const files = [];
        return call('sync2-list', {}, m => {
          if (m.type === 'sync2-list-item') { files.push(m.file); if (files.length > 10000) throw new Error('Remote inventory too large'); }
          if (m.type === 'sync2-list-end') { if (m.version !== 2) throw new Error('Upgrade the remote storage endpoint'); return files; }
        });
      },
      stat: name => call('sync2-stat', { path: name }, m => m.type === 'sync2-stat' ? { file: m.file } : undefined).then(result => result.file),
      remove: (name, expectedHash) => call('sync2-delete', { path: name, expectedHash }, m => m.type === 'sync2-deleted' ? true : undefined),
      download: (record, output) => this.download({ ...record, directory, requestType: 'sync2-get' }, output),
      upload: async (name, capture, expectedHash) => {
        const requestId = crypto.randomUUID();
        await call('sync2-put-start', { requestId, path: name, size: capture.size, contentHash: capture.contentHash, expectedHash }, m => m.type === 'sync2-put-ready' ? true : undefined);
        const started = Date.now();
        for await (const bytes of fs.createReadStream(capture.temp, { highWaterMark: 32768 })) {
          while (this.channel.bufferedAmount > 1024 * 1024) {
            if (this.channel.readyState !== 'open' || Date.now() - started > 30 * 60 * 1000) throw new Error('Upload interrupted');
            await new Promise(r => setTimeout(r, 10));
          }
          this.channel.send(bytes);
        }
        return call('sync2-put-end', { requestId, path: name }, m => m.type === 'sync2-put-done' ? true : undefined);
      }
    };
  }
  close() { clearInterval(this.keepalive); this.active?.fail(new Error('Peer closed')); this.pc.close(); }
}

export function createPeerSync(options) {
  if (process.env.SYNC_MODE === 'web-groups') return null;
  const { storageRoot, api, sendSignal, iceServers, syncFiles } = options;
  const sourceId = process.env.SYNC_SOURCE_CLIENT_ID || '';
  if (!sourceId) return null;
  const sourceDir = normalizeSyncPath(process.env.SYNC_SOURCE_DIR || 'sync-test');
  const targetDir = normalizeSyncPath(process.env.SYNC_TARGET_DIR || 'sync-test');
  const mode = process.env.SYNC_MODE === 'bidirectional' ? 'bidirectional' : 'backup';
  const intervalSeconds = mode === 'bidirectional' ? Math.max(0, Number(process.env.SYNC_INTERVAL_SECONDS || 0)) : 0;
  const appRoot = path.join(storageRoot, process.env.BOT_APP_DATA_DIR_NAME || '.nas-bot', 'peer-sync');
  const stateFile = path.join(appRoot, 'state.json');
  let peer, busy = false, lastResult = null, legacyManifest = false;
  let autoPaused = false, nextAutoAttempt = 0;
  const loadState = async () => {
    try { return JSON.parse(await fs.promises.readFile(stateFile, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return { files: {} }; throw e; }
  };
  async function snapshot() {
    const { clients } = await api('/api/clients');
    const source = clients.find(c => c.id === sourceId);
    if (source?.status !== 'online') throw new Error('Source node is offline');
    let index;
    if (!legacyManifest) {
      try { index = await api('/api/client/sync-manifest?clientId=' + encodeURIComponent(sourceId), { maxAttempts: 1 }); }
      catch (error) { if (!/HTTP 404/.test(error.message)) throw error; legacyManifest = true; }
    }
    if (!index) index = await api('/api/files');
    const { files } = index;
    const candidates = files.filter(f => f.clientId === sourceId && f.path.startsWith(sourceDir + '/'));
    const seen = new Set();
    for (const file of candidates) {
      normalizeSyncPath(file.path);
      if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Invalid source file size');
      const localPath = targetDir + '/' + file.path.slice(sourceDir.length + 1);
      const key = process.platform === 'win32' ? localPath.toLowerCase() : localPath;
      if (seen.has(key)) throw new Error('Source has case-conflicting file names');
      seen.add(key);
      await checkedDestination(storageRoot, localPath);
    }
    return candidates;
  }
  async function connected(task) {
    peer = options.peerFactory ? options.peerFactory(sourceId) : new OutgoingPeer(sourceId, sendSignal, iceServers, mode === 'bidirectional' ? 'nas-sync-v2' : 'nas-sync');
    try { await peer.open(); return await task(peer); }
    finally { peer.close(); peer = null; }
  }
  async function execute(action) {
    if (action === 'status') return { busy, mode, intervalSeconds, autoPaused, sourceId, sourceDir, targetDir, lastResult };
    if (['pause', 'resume'].includes(action)) {
      await checkedDestination(storageRoot, (process.env.BOT_APP_DATA_DIR_NAME || '.nas-bot') + '/peer-sync');
      await fs.promises.mkdir(appRoot, { recursive: true });
      autoPaused = action === 'pause';
      const next = path.join(appRoot, 'automation.json.tmp');
      await fs.promises.writeFile(next, JSON.stringify({ paused: autoPaused }));
      await fs.promises.rename(next, path.join(appRoot, 'automation.json'));
      nextAutoAttempt = 0;
      return { autoPaused, currentRunContinues: busy };
    }
    if (busy) throw new Error('A synchronization task is already running');
    busy = true;
    try {
      await checkedDestination(storageRoot, (process.env.BOT_APP_DATA_DIR_NAME || '.nas-bot') + '/peer-sync');
      await fs.promises.mkdir(appRoot, { recursive: true });
      if (action === 'probe') return await connected(p => p.ping());
      if (action === 'seed-test') {
        if (process.env.SYNC_ALLOW_TEST_SEED !== '1' || sourceDir !== 'sync-test') throw new Error('Test seeding is disabled');
        const testPath = sourceDir + '/nasbridge-' + crypto.randomUUID() + '.bin';
        const bytes = crypto.randomBytes(2 * 1024 * 1024);
        const result = await connected(async p => {
          const route = await p.ping();
          await p.uploadFixture(testPath, bytes);
          return { testPath, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...route };
        });
        await fs.promises.writeFile(path.join(appRoot, 'test-fixture.json'), JSON.stringify(result, null, 2));
        return result;
      }
      if (!['plan', 'run'].includes(action)) throw new Error('Unknown action');
      if (mode === 'bidirectional') {
        const result = await connected(async p => {
          const route = await p.ping();
          const result = await runBidirectional({
            store: new SyncStore(storageRoot, targetDir), remote: p.remoteStore(sourceDir),
            stateFile: path.join(appRoot, 'bidirectional-state.json'),
            identity: JSON.stringify([sourceId, sourceDir, targetDir]), planOnly: action === 'plan'
          });
          return { ...result, connection: route };
        });
        if (action === 'run') {
          await syncFiles(); lastResult = result;
          await fs.promises.writeFile(path.join(appRoot, 'last-result.json'), JSON.stringify(result, null, 2));
        }
        return result;
      }
      const files = await snapshot();
      const manifest = await loadState();
      const plan = [];
      for (const file of files) {
        const localPath = targetDir + '/' + file.path.slice(sourceDir.length + 1);
        const absolute = await checkedDestination(storageRoot, localPath);
        const key = sourceId + ':' + file.path;
        const previous = manifest.files[key];
        const exists = fs.existsSync(absolute);
        const localHash = exists ? await hashFile(absolute) : '';
        const unchanged = exists && previous && previous.targetPath === localPath && previous.sha256 === localHash && previous.size === file.size && previous.updatedAt === file.updatedAt && (!file.contentHash || file.contentHash === localHash);
        const conflict = exists && (!previous || previous.sha256 !== localHash || previous.targetPath !== localPath);
        plan.push({ file, key, localPath, absolute, localHash, action: unchanged ? 'skip' : conflict ? 'conflict' : exists ? 'update' : 'copy' });
      }
      const warnings = legacyManifest ? ['服务器尚未升级同步清单 API；旧索引不含 SRT/ASS/VTT/SUB/SSA 字幕。'] : [];
      if (files.some(file => !file.contentHash)) warnings.push('源节点尚未发布 SHA256；增量判断使用大小和修改时间，接收后验证字节数与本机 SHA256 回读。');
      if (action === 'plan') return { sourceId, sourceDir, targetDir, warnings, files: plan.map(({ file, localPath, action }) => ({ sourcePath: file.path, targetPath: localPath, size: file.size, action })) };
      const result = { startedAt: new Date().toISOString(), sourceId, sourceDir, targetDir, warnings, copied: 0, updated: 0, skipped: 0, conflicts: [], bytes: 0, files: [] };
      const needed = plan.filter(p => ['copy', 'update'].includes(p.action));
      await fs.promises.mkdir(path.join(appRoot, 'staging'), { recursive: true });
      if (needed.length) await connected(async p => {
        result.connection = await p.ping();
        for (const entry of needed) {
          const { file, absolute, localPath, key } = entry;
          const temp = path.join(appRoot, 'staging', crypto.randomUUID() + '.part');
          try {
            const space = await fs.promises.statfs(storageRoot);
            if (space.bavail * space.bsize < file.size + 64 * 1024 * 1024) throw new Error('Insufficient free space');
            const transfer = await p.download(file, temp);
            const currentSource = (await snapshot()).find(f => f.path === file.path);
            if (!currentSource || currentSource.size !== file.size || currentSource.updatedAt !== file.updatedAt) throw new Error('Source changed during transfer');
            // Check local content again immediately before replacing it.
            await checkedDestination(storageRoot, localPath);
            const currentHash = fs.existsSync(absolute) ? await hashFile(absolute) : '';
            if (currentHash !== entry.localHash) throw new Error('Local file changed during transfer');
            await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
            if (entry.action === 'update') {
              const versions = path.join(appRoot, 'versions');
              await fs.promises.mkdir(versions, { recursive: true });
              await fs.promises.copyFile(absolute, path.join(versions, Date.now() + '-' + crypto.randomUUID() + '-' + path.basename(absolute)), fs.constants.COPYFILE_EXCL);
              await fs.promises.rename(temp, absolute);
            } else {
              // Atomic no-clobber publication; another creator cannot be overwritten.
              await fs.promises.link(temp, absolute);
              await fs.promises.unlink(temp);
            }
            const sourceTime = new Date(file.updatedAt);
            if (Number.isFinite(sourceTime.getTime())) await fs.promises.utimes(absolute, sourceTime, sourceTime);
            manifest.files[key] = { targetPath: localPath, sourceId, sourcePath: file.path, size: file.size, updatedAt: file.updatedAt, sha256: transfer.sha256, sourceHashVerified: Boolean(file.contentHash), syncedAt: new Date().toISOString() };
            const next = stateFile + '.tmp';
            await fs.promises.writeFile(next, JSON.stringify(manifest, null, 2));
            await fs.promises.rename(next, stateFile);
            result[entry.action === 'copy' ? 'copied' : 'updated']++;
            result.bytes += transfer.bytes;
            result.files.push({ path: localPath, ...transfer });
          } finally { await fs.promises.unlink(temp).catch(() => {}); }
        }
      });
      for (const entry of plan) {
        if (entry.action === 'skip') result.skipped++;
        if (entry.action === 'conflict') result.conflicts.push(entry.localPath);
      }
      result.finishedAt = new Date().toISOString();
      await syncFiles();
      lastResult = result;
      await fs.promises.writeFile(path.join(appRoot, 'last-result.json'), JSON.stringify(result, null, 2));
      return result;
    } catch (error) {
      if (action === 'run') lastResult = { mode, failedAt: new Date().toISOString(), error: error.message };
      throw error;
    } finally { busy = false; }
  }
  let control;
  return {
    execute,
    handleSignal(fromId, payload) {
      if (!peer || fromId !== sourceId || !['answer', 'ice'].includes(payload.kind)) return false;
      peer.signal(payload); return true;
    },
    async start() {
      await fs.promises.mkdir(appRoot, { recursive: true });
      try { autoPaused = JSON.parse(await fs.promises.readFile(path.join(appRoot, 'automation.json'), 'utf8')).paused === true; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      control = net.createServer(socket => {
        let input = '';
        socket.on('error', () => {});
        socket.on('data', async chunk => {
          input += chunk;
          if (input.length > 2048) return socket.destroy();
          if (!input.includes('\n')) return;
          socket.removeAllListeners('data');
          try { const request = JSON.parse(input); socket.end(JSON.stringify({ ok: true, result: await execute(request.action) }) + '\n'); }
          catch (error) { socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n'); }
        });
      });
      await new Promise((resolve, reject) => { control.once('error', reject); control.listen(syncPipeName(storageRoot), resolve); });
      if (Number.isFinite(intervalSeconds) && intervalSeconds >= 30) {
        const timer = setInterval(() => {
          if (!busy && !autoPaused && Date.now() >= nextAutoAttempt) execute('run').catch(error => {
            nextAutoAttempt = Date.now() + 300000;
            lastResult = { mode, failedAt: new Date().toISOString(), error: error.message, retryAfter: new Date(nextAutoAttempt).toISOString() };
          });
        }, intervalSeconds * 1000);
        timer.unref?.();
      }
    }
  };
}
