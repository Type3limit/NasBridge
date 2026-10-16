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
