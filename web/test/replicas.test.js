import test from 'node:test';
import assert from 'node:assert/strict';
import { groupFileReplicas, findReplicas, rankReplicas, selectReplica } from '../src/replicas.js';
const a = { id: 'a:x', clientId: 'a', path: 'videos/x.mp4', name: 'x.mp4', size: 1000, contentHash: 'a'.repeat(64) };
const b = { ...a, id: 'b:x', clientId: 'b' };
test('only matching full hashes and sizes group within the same directory', () => {
  const other = { ...a, id: 'a:y', contentHash: 'b'.repeat(64) };
  const unverified = { ...a, id: 'c:x', clientId: 'c', contentHash: '' };
  const groups = groupFileReplicas([a, b, other, unverified]);
  assert.equal(groups.length, 3); assert.equal(groups[0].replicas.length, 2);
  assert.equal(groupFileReplicas([a, { ...b, size: 2 }]).length, 2);
  const differentFolder = { ...b, path: 'backup/x.mp4' };
  assert.equal(groupFileReplicas([a, differentFolder]).length, 2);
  assert.equal(findReplicas(a, [a, differentFolder]).length, 2);
});
test('throughput and latency select fast reachable node; offline source excluded', () => {
  const samples = { a: { bytesPerSecond: 10000, latencyMs: 10 }, b: { bytesPerSecond: 10000000, latencyMs: 50 } };
  assert.equal(rankReplicas([a, b], samples, 1000000)[0].clientId, 'b');
  samples.b.reachable = false;
  assert.equal(rankReplicas([a, b], samples)[0].clientId, 'a');
});
test('selection caches probes and honors failed preview exclusions', async () => {
  let calls = 0;
  const p2p = { sampleNode: async id => { calls++; return { reachable: true, latencyMs: id === 'b' ? 1 : 100, bytesPerSecond: 100000 }; } };
  assert.equal((await selectReplica(p2p, a, [a, b], 'preview')).clientId, 'b');
  await selectReplica(p2p, a, [a, b], 'preview'); assert.equal(calls, 2);
  assert.equal((await selectReplica(p2p, a, [a, b], 'preview', ['b'])).clientId, 'a');
});
test('node-and-path references resolve through the index to every online copy', async () => {
  // A bot attachment carries no index id and no content hash.
  const ref = { clientId: 'a', path: 'videos/x.mp4', name: 'x.mp4', size: 1000 };
  assert.deepEqual(findReplicas(ref, [a, b]).map(f => f.clientId), ['a', 'b']);
  // Its own node is offline: the same content on another node is still found.
  assert.deepEqual(findReplicas(ref, [b]).map(f => f.clientId), ['b']);
  // Not indexed yet: same path and size on an online node, otherwise read it from its own node.
  const fresh = { clientId: 'c', path: 'downloads/new.mp4', size: 5 };
  assert.deepEqual(findReplicas(fresh, [a, b]), []);
  assert.equal(await selectReplica({}, fresh, [a, b], 'preview'), fresh);
  await assert.rejects(selectReplica({}, fresh, [a, b], 'preview', ['c']), /没有可用的在线副本/);
});
