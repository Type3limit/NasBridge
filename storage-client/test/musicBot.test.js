import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMusicControlPlugin } from '../src/bot/plugins/music.js';
import { GlobalMusicPlayer } from '../src/musicPlayer.js';

function setup() {
  const player = new GlobalMusicPlayer({ storageRoot: os.tmpdir() });
  player.persist = async () => {};
  player.ensurePreparation = () => {};
  player.searchCandidates = async () => [
    { providerTrackId: 'q1', title: '晴天', artist: '周杰伦', source: 'qq' },
    { providerTrackId: 'q2', title: '晴天 Live', artist: '周杰伦', source: 'qq' }
  ];
  player.enqueueSelection = async ({ candidate, submittedBy, requester }) => {
    const track = { id: 't-' + candidate.providerTrackId, title: candidate.title, artist: candidate.artist, providerTrackId: candidate.providerTrackId, submittedBy, submittedById: requester?.id, submittedAt: new Date().toISOString(), status: 'ready', votes: [] };
    player.state.queue.push(track);
    if (player.state.currentIndex < 0) player.state.currentIndex = 0;
    return track;
  };
  const replies = [];
  const api = {
    dependencies: { getMusicPlayer: async () => player },
    appDataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'musicbot-')),
    appendLog: async () => {},
    emitProgress: async () => {},
    publishChatReply: async (reply) => { replies.push(reply.card); return reply; }
  };
  const plugin = createMusicControlPlugin();
  const run = (prompt, userId) => plugin.execute({ trigger: { parsedArgs: { prompt } }, requester: { userId, displayName: userId }, chat: {} }, api);
  return { player, replies, run };
}

test('@点歌 name shows candidates; a click requests it for whoever clicked', async () => {
  const { replies, run } = setup();
  await run('晴天', 'A');
  const card = replies.at(-1);
  assert.equal(card.actions.length, 2);
  assert.equal(card.actions[0].parsedArgs.__chatReplyMode, 'replace-chat-message');
  await run(card.actions[1].parsedArgs.prompt, 'B');
  assert.match(replies.at(-1).title, /^B 点了《晴天 Live》/);
});

test('likes and skip votes from cards', async () => {
  const { player, replies, run } = setup();
  await run('晴天', 'A');
  const pick = replies.at(-1).actions;
  await run(pick[0].parsedArgs.prompt, 'A');
  await run(pick[1].parsedArgs.prompt, 'B');
  const likeButton = replies.at(-1).actions[0];
  await run(likeButton.parsedArgs.prompt, 'C');
  assert.match(replies.at(-1).subtitle, /1 赞/);
  for (const id of ['A', 'B', 'C', 'D']) player.listeners.set(id, Date.now());
  await run('切歌', 'C');
  assert.match(replies.at(-1).title, /投票切歌 1\/2/);
  await run(replies.at(-1).actions[0].parsedArgs.prompt, 'D');
  assert.match(replies.at(-1).title, /已跳过《晴天》/);
  assert.equal(player.getCurrentTrack().title, '晴天 Live');
});
