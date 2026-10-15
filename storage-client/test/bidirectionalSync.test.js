import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import wrtc from '@roamhq/wrtc';
import { SyncStore } from '../src/syncStore.js';
import { runBidirectional, planBidirectional, conflictPath } from '../src/bidirectionalSync.js';
import { createSyncReceiver } from '../src/syncReceiver.js';
import { OutgoingPeer } from '../src/peerSync.js';

const hash = data => crypto.createHash('sha256').update(data).digest('hex');
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nasbridge-bidi-'));
  const left = path.join(root, 'left'), right = path.join(root, 'right');
  await fs.mkdir(path.join(left, 'sync-test'), { recursive: true });
  await fs.mkdir(path.join(right, 'sync-test'), { recursive: true });
  const a = new SyncStore(left, 'sync-test'), b = new SyncStore(right, 'sync-test');
  const remote = {
    scan: () => b.scan(), stat: name => b.stat(name), remove: (name, expected) => b.remove(name, expected),
    download: async (record, output) => { const c = await b.capture(record.path, record.contentHash); try { await fs.copyFile(c.temp, output, 1); } finally { await fs.unlink(c.temp); } },
    upload: async (name, capture, expected) => { const temp = await b.staging(); try { await fs.copyFile(capture.temp, temp, 1); return await b.commit(name, temp, expected, capture.contentHash); } finally { await fs.unlink(temp).catch(() => {}); } }
  };
  const options = { store: a, remote, stateFile: path.join(left, '.nas-bot/state.json'), identity: 'test-pair' };
  return {
    root, left, right, a, b, remote, options,
    run: () => runBidirectional(options),
    write: async (side, name, data) => { const target = await (side === 'left' ? a : b).resolve(name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data); },
    read: async (side, name) => fs.readFile(await (side === 'left' ? a : b).resolve(name), 'utf8'),
    close: () => fs.rm(root, { recursive: true, force: true })
  };
}
test('bidirectional additions, changes, conflicts, mirrored deletion and repeat convergence', async () => {
  const f = await fixture();
  try {
    await f.write('left', 'local.txt', 'local'); await f.write('right', 'remote.txt', 'remote');
    const first = await f.run(); assert.equal(first.pushed, 1); assert.equal(first.pulled, 1);
    await f.write('left', 'local.txt', 'new-local'); await f.write('right', 'remote.txt', 'new-remote');
    const second = await f.run(); assert.equal(second.pushed, 1); assert.equal(second.pulled, 1);
    assert.equal(await f.read('right', 'local.txt'), 'new-local'); assert.equal(await f.read('left', 'remote.txt'), 'new-remote');
    await f.write('left', 'local.txt', 'left-conflict'); await f.write('right', 'local.txt', 'right-conflict');
    const conflict = await f.run(); assert.equal(conflict.conflicts.length, 1);
    const preserved = conflictPath('local.txt', hash('right-conflict'));
    for (const side of ['left', 'right']) { assert.equal(await f.read(side, 'local.txt'), 'left-conflict'); assert.equal(await f.read(side, preserved), 'right-conflict'); }
    await fs.unlink(await f.a.resolve('remote.txt'));
    assert.equal((await f.run()).deletedRemote, 1); assert.equal(await f.b.stat('remote.txt'), null);
    const again = await f.run(); assert.equal(again.pulled + again.pushed, 0); assert.equal(again.unchanged, 2);
    assert.ok((await fs.readdir(path.join(f.right, '.nas-bot/peer-sync-v2/versions'))).length);
    assert.ok((await fs.readdir(path.join(f.right, '.nas-bot/peer-sync-v2/trash'))).some(file => file.endsWith('.bin')));
  } finally { await f.close(); }
});
test('unrelated same-name files on first pairing preserve both versions', async () => {
  const f = await fixture();
  try {
    await f.write('left', 'same.txt', 'A'); await f.write('right', 'same.txt', 'B');
    assert.equal((await f.run()).conflicts.length, 1);
    assert.equal(await f.read('left', conflictPath('same.txt', hash('B'))), 'B');
    assert.equal((await f.run()).pushed, 0);
  } finally { await f.close(); }
});
test('remote edits during upload fail compare-and-swap and remain untouched', async () => {
  const f = await fixture();
  try {
    await f.write('left', 'a.txt', 'base'); await f.run(); await f.write('left', 'a.txt', 'local edit');
    const upload = f.remote.upload;
    f.remote.upload = async (...args) => { await f.write('right', 'a.txt', 'concurrent edit'); return upload(...args); };
    await assert.rejects(f.run(), /Destination changed/);
    assert.equal(await f.read('right', 'a.txt'), 'concurrent edit'); assert.equal(await f.read('left', 'a.txt'), 'local edit');
    f.remote.upload = upload; assert.equal((await f.run()).conflicts.length, 1);
  } finally { await f.close(); }
});
test('interrupted receive and lost commit acknowledgment recover without losing originals', async () => {
  const f = await fixture();
  try {
    await f.write('right', 'a.txt', 'base'); await f.run(); await f.write('right', 'a.txt', 'remote edit');
    const download = f.remote.download;
    f.remote.download = async (_, temp) => { await fs.writeFile(temp, 'partial'); throw new Error('disconnected'); };
    await assert.rejects(f.run(), /disconnected/); assert.equal(await f.read('left', 'a.txt'), 'base');
    f.remote.download = download; await f.run();
    await f.write('left', 'a.txt', 'local edit');
    const upload = f.remote.upload;
    f.remote.upload = async (...args) => { await upload(...args); throw new Error('lost acknowledgment'); };
    await assert.rejects(f.run(), /lost acknowledgment/);
    f.remote.upload = upload;
    const recovered = await f.run(); assert.equal(recovered.unchanged, 1); assert.equal(recovered.conflicts.length, 0);
  } finally { await f.close(); }
});
test('case collisions, missing hashes, traversal and changed state identity fail closed', async () => {
  const file = { path: 'Folder/a', size: 1, contentHash: hash('a') };
  assert.throws(() => planBidirectional([file], [{ ...file, path: 'folder/b' }]), /Case-conflicting/);
  assert.throws(() => planBidirectional([{ ...file, contentHash: '' }], []));
  assert.throws(() => planBidirectional([{ ...file, path: '../outside' }], []));
  const f = await fixture();
  try { await f.run(); await assert.rejects(runBidirectional({ ...f.options, identity: 'wrong' }), /another directory pair/); }
  finally { await f.close(); }
});
test('staged incoming content must match its SHA256; junctions cannot escape scope', async () => {
  const f = await fixture();
  try {
    const temp = await f.a.staging(); await fs.writeFile(temp, 'corrupt');
    await assert.rejects(f.a.commit('a.txt', temp, null, hash('expected')), /SHA256/);
    const elsewhere = path.join(f.root, 'outside'); await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, path.join(f.left, 'sync-test/escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.a.scan(), /symbolic links/); await assert.rejects(f.a.resolve('escape/a'), /symlinks/);
  } finally { await f.close(); }
});

for (const protocol of [2, 3]) test('real WebRTC v' + protocol + ' channel transfers both directions with staged SHA256 validation', { timeout: 60000 }, async () => {
  const f = await fixture();
  let outgoing, pc;
  try {
    await f.write('left', 'zero.bin', ''); await f.write('left', 'from-left.bin', crypto.randomBytes(2 * 1024 * 1024));
    await f.write('right', 'from-right.txt', 'remote data');
    const receiver = createSyncReceiver({ storageRoot: f.right, syncFiles: async () => {}, allowedPeer: 'local', directory: 'sync-test', ...(protocol === 3 ? { authorize: (id, ctx) => id === 'local' && ctx.groupId === 'test-group' && ctx.revision === 1 ? {directory:'sync-test'} : null } : {}) });
    pc = new wrtc.RTCPeerConnection({ iceServers: [] });
    pc.ondatachannel = e => receiver.attach(e.channel, 'local');
    pc.onicecandidate = e => { if (e.candidate) outgoing.signal({ kind: 'ice', candidate: e.candidate }); };
    let signaling = Promise.resolve(), ice = [];
    outgoing = new OutgoingPeer('remote', (_, message) => {
      signaling = signaling.then(async () => {
        if (message.kind === 'offer') {
          await pc.setRemoteDescription(message.sdp);
          for (const c of ice) await pc.addIceCandidate(c); ice = [];
          await pc.setLocalDescription(await pc.createAnswer()); outgoing.signal({ kind: 'answer', sdp: pc.localDescription });
        } else if (message.kind === 'ice') {
          if (pc.remoteDescription) await pc.addIceCandidate(message.candidate); else ice.push(message.candidate);
        }
      });
    }, [], 'nas-sync-v' + protocol, protocol === 3 ? {groupId:'test-group',revision:1} : {});
    await outgoing.open();
    assert.equal((await outgoing.ping()).route, 'direct');
    const remote = outgoing.remoteStore('sync-test');
    const result = await runBidirectional({ ...f.options, remote });
    assert.equal(result.pulled, 1); assert.equal(result.pushed, 2);
    assert.equal((await f.a.stat('from-left.bin')).contentHash, (await f.b.stat('from-left.bin')).contentHash);
    await fs.unlink(await f.a.resolve('zero.bin'));
    const deleted = await runBidirectional({ ...f.options, remote });
    assert.equal(deleted.deletedRemote, 1); assert.equal(await f.b.stat('zero.bin'), null);
    await assert.rejects(outgoing.remoteStore('outside').scan(), /authorized|closed/);
  } finally { outgoing?.close(); pc?.close(); await f.close(); }
});
test('deletion versus concurrent edit preserves edited data on both endpoints then deletes original', async () => {
  for (const changedSide of ['left', 'right']) {
    const f = await fixture();
    try {
      await f.write('left', 'a.txt', 'base'); await f.run();
      await f.write(changedSide, 'a.txt', 'valuable concurrent edit');
      const deletedStore = changedSide === 'left' ? f.b : f.a;
      await fs.unlink(await deletedStore.resolve('a.txt'));
      const result = await f.run(); assert.equal(result.conflicts[0].reason, 'delete-versus-edit');
      const preserved = conflictPath('a.txt', hash('valuable concurrent edit'), true);
      for (const side of ['left', 'right']) assert.equal(await f.read(side, preserved), 'valuable concurrent edit');
      assert.equal(await f.a.stat('a.txt'), null); assert.equal(await f.b.stat('a.txt'), null);
      assert.equal((await f.run()).conflicts.length, 0);
    } finally { await f.close(); }
  }
});
test('offline deletion, both-side deletion, explicit recreation and lost deletion acknowledgment converge', async () => {
  const f = await fixture();
  try {
    await f.write('left', 'a.txt', 'base'); await f.run();
    await fs.unlink(await f.a.resolve('a.txt'));
    const scan = f.remote.scan; f.remote.scan = async () => { throw new Error('offline'); };
    await assert.rejects(f.run(), /offline/); assert.equal(await f.read('right', 'a.txt'), 'base');
    f.remote.scan = scan;
    const remove = f.remote.remove; f.remote.remove = async (...args) => { await remove(...args); throw new Error('lost delete ack'); };
    await assert.rejects(f.run(), /lost delete ack/);
    f.remote.remove = remove; await f.run();
    assert.equal(await f.a.stat('a.txt'), null); assert.equal(await f.b.stat('a.txt'), null);
    await f.write('left', 'a.txt', 'recreated'); assert.equal((await f.run()).pushed, 1);
    await fs.unlink(await f.a.resolve('a.txt')); await fs.unlink(await f.b.resolve('a.txt'));
    await f.run();
    const state = JSON.parse(await fs.readFile(f.options.stateFile, 'utf8'));
    assert.ok(state.tombstones['a.txt']); assert.equal(state.bases['a.txt'], undefined);
  } finally { await f.close(); }
});
test('deletion precondition protects newly modified files and special property filenames are supported', async () => {
  const f = await fixture();
  try {
    await f.write('left', '__proto__', 'base'); await f.run();
    await f.write('right', '__proto__', 'changed');
    await assert.rejects(f.b.remove('__proto__', hash('base')), /changed/);
    assert.equal(await f.read('right', '__proto__'), 'changed');
    await f.run(); assert.equal(await f.read('left', '__proto__'), 'changed');
  } finally { await f.close(); }
});
test('receiver rejects an unauthorized signaling peer before filesystem access', async () => {
  const f = await fixture();
  try {
    const sent = [];
    const channel = { label: 'nas-sync-v2', readyState: 'open', send: s => sent.push(JSON.parse(s)), close() { this.readyState = 'closed'; this.onclose?.(); } };
    createSyncReceiver({ storageRoot: f.right, syncFiles: async () => {}, allowedPeer: 'allowed' }).attach(channel, 'other');
    channel.onmessage({ data: JSON.stringify({ type: 'sync2-list', directory: 'sync-test' }) });
    await new Promise(r => setTimeout(r, 20));
    assert.match(sent[0].message, /not authorized/); assert.equal(channel.readyState, 'closed');
  } finally { await f.close(); }
});
