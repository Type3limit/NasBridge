import test from 'node:test';
import assert from 'node:assert/strict';
import { orderUpcoming, checkRequestAllowed, normalizeActor, MAX_PENDING_PER_USER } from '../src/musicQueue.js';

const t = (id, by, minute, extra = {}) => ({ id, submittedById: by, submittedAt: `2026-10-16T10:${String(minute).padStart(2, '0')}:00.000Z`, ...extra });
const ids = tracks => tracks.map(track => track.id);

test('songs play in rounds: everyone first, then everyone second', () => {
  const queue = [t('a1', 'A', 0), t('a2', 'A', 1), t('a3', 'A', 2), t('b1', 'B', 3), t('c1', 'C', 4), t('b2', 'B', 5)];
  assert.deepEqual(ids(orderUpcoming(queue)), ['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
});

test('likes reorder only within a round; ties keep request order', () => {
  const queue = [t('a1', 'A', 0), t('b1', 'B', 1, { votes: ['x', 'y'] }), t('c1', 'C', 2, { votes: ['x'] }), t('a2', 'A', 3, { votes: ['x', 'y', 'z'] })];
  assert.deepEqual(ids(orderUpcoming(queue)), ['b1', 'c1', 'a1', 'a2']);
});

test('the requester of the playing song waits a round; pins go first', () => {
  const queue = [t('a2', 'A', 0), t('c1', 'C', 1)];
  assert.deepEqual(ids(orderUpcoming(queue, { playing: t('a1', 'A', 0) })), ['c1', 'a2']);
  const pinned = [...queue, t('z1', 'Z', 9, { pinnedAt: '2026-10-16T11:00:00Z' })];
  assert.equal(orderUpcoming(pinned)[0].id, 'z1');
});

test('request limits: duplicates, per-person cap, cooldown; admins exempt from cap', () => {
  const actor = normalizeActor({ id: 'A', name: 'Alice', role: 'user' });
  const upcoming = [t('a1', 'A', 0, { providerTrackId: 'song-1' }), t('a2', 'A', 1, { providerTrackId: 'song-2' })];
  assert.match(checkRequestAllowed({ upcoming, actor: normalizeActor({ id: 'B' }), candidate: { providerTrackId: 'song-1' } }), /已经在队列里/);
  assert.match(checkRequestAllowed({ upcoming, actor, candidate: { providerTrackId: 'song-3' } }), new RegExp(`最多同时排 ${MAX_PENDING_PER_USER} 首`));
  const now = Date.now();
  assert.match(checkRequestAllowed({ upcoming: [], actor, candidate: { providerTrackId: 'x' }, now, lastRequestAt: now - 5000 }), /25 秒后再试/);
  assert.equal(checkRequestAllowed({ upcoming, actor: normalizeActor({ id: 'A', role: 'admin' }), candidate: { providerTrackId: 'song-3' } }), '');
  assert.equal(normalizeActor({ name: 'no id' }), null);
});
