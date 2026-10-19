import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { GlobalMusicPlayer } from '../src/musicPlayer.js';

const track = (id, by, minute, extra = {}) => ({ id, title: id, providerTrackId: 'p-' + id, submittedById: by, submittedBy: by, submittedAt: `2026-10-16T10:${String(minute).padStart(2, '0')}:00.000Z`, status: 'ready', votes: [], ...extra });
const player = (queue, currentIndex) => {
  const p = new GlobalMusicPlayer({ storageRoot: os.tmpdir() });
  p.state = { ...p.state, queue, currentIndex, isPlaying: true };
  p.persist = async () => {};
  p.ensurePreparation = () => {};
  return p;
};
const ids = p => p.state.queue.map(t => t.id);

test('finished queue loops: oldest played song plays again, requests still go first', async () => {
  const p = player([track('h1', 'A', 0), track('h2', 'B', 1), track('now', 'A', 2)], 2);
  await p.control('complete');
  assert.deepEqual(ids(p), ['h2', 'now', 'h1']);
  assert.equal(p.getCurrentTrack().id, 'h1');
  p.state.queue.push(track('req', 'C', 9));
  await p.control('complete');
  assert.equal(p.getCurrentTrack().id, 'req');
});

test('a single song repeats; next on the last song also loops', async () => {
  const solo = player([track('only', 'A', 0)], 0);
  await solo.control('complete');
  assert.equal(solo.getCurrentTrack().id, 'only');
  assert.equal(solo.state.isPlaying, true);
  const p = player([track('h1', 'A', 0), track('now', 'B', 1)], 1);
  await p.control('next');
  assert.equal(p.getCurrentTrack().id, 'h1');
});

test('a looped song can be moved up as your own request', async () => {
  const p = player([track('h1', 'A', 0), track('h2', 'B', 1), track('now', 'B', 2)], 2);
  await p.control('requeue-track', { trackId: 'h1', actor: { id: 'C', name: 'Carol' } });
  assert.deepEqual(ids(p), ['h2', 'now', 'h1']);
  assert.equal(p.getCurrentTrack().id, 'now');
  assert.equal(p.state.queue[2].submittedById, 'C');
  await assert.rejects(p.control('requeue-track', { trackId: 'h2', actor: { id: 'C', name: 'Carol' } }), /秒后再试/);
});

test('search rechecks a bridge that came up after the node started', async () => {
  const p = player([], -1);
  let sources = [];
  p.bridge = {
    canHandleSource: (s) => sources.includes(s),
    ensureReady: async () => { sources = ['qq']; return { ok: true, sources }; },
    search: async () => ({ candidates: [{ providerTrackId: 'x1', title: 'Song' }] })
  };
  const results = await p.searchCandidates({ keyword: 'song', source: 'qq' });
  assert.equal(results[0].title, 'Song');
});

test('skip needs half the listeners; the requester and admins skip at once', async () => {
  const p = player([track('now', 'A', 0), track('next', 'B', 1)], 0);
  for (const id of ['A', 'B', 'C', 'D']) p.listeners.set(id, Date.now());
  await p.control('skip-vote', { actor: { id: 'C', name: 'Carol' } });
  assert.equal(p.getCurrentTrack().id, 'now');
  assert.deepEqual(p.snapshot().skip, { votes: 1, votedBy: ['C'], needed: 2, listeners: 4 });
  await p.control('next', { actor: { id: 'D', name: 'Dan' } });
  assert.equal(p.getCurrentTrack().id, 'next');
  assert.equal(p.snapshot().lastSkip.reason, 'vote');
  assert.equal(p.snapshot().skip.votes, 0);
  await p.control('next', { actor: { id: 'B', name: 'Bob' } });
  assert.equal(p.snapshot().lastSkip.reason, 'requester');
});

test('alone, one press skips', async () => {
  const p = player([track('now', 'A', 0), track('next', 'B', 1)], 0);
  await p.control('skip-vote', { actor: { id: 'C', name: 'Carol' } });
  assert.equal(p.getCurrentTrack().id, 'next');
});
