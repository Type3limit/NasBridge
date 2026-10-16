import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttachmentFileIndex, resolveAttachmentNode } from '../src/components/chatAttachments.js';

const hash = 'c'.repeat(64);
const moved = { id: 'a:videos/clip.mp4', clientId: 'a', name: 'clip.mp4', path: 'videos/clip.mp4', size: 500, contentHash: hash };
const copyOnB = { ...moved, id: 'b:backup/clip.mp4', clientId: 'b', path: 'backup/clip.mp4' };
const ctx = (online, files, preferredId = 'a') => {
  const index = buildAttachmentFileIndex(files);
  return { onlineIds: new Set(online), preferredId, chatAssetPrefix: '.nas-chat-room/attachments', fileIndex: () => index };
};

test('attachment still at its path on an online node is left alone', () => {
  const att = { id: 'bot-asset:1', clientId: 'a', path: 'videos/clip.mp4', name: 'clip.mp4', size: 500 };
  assert.equal(resolveAttachmentNode(att, ctx(['a'], [moved])), att);
});

test('moved file is followed by content hash, preferring its own node', () => {
  const att = { id: 'bot-asset:1', clientId: 'a', path: 'downloads/ytdlp/clip.mp4', name: 'clip.mp4', size: 500, contentHash: hash };
  const r = resolveAttachmentNode(att, ctx(['a', 'b'], [copyOnB, moved]));
  assert.deepEqual([r.clientId, r.path], ['a', 'videos/clip.mp4']);
});

test('older card without a hash is followed by name and size', () => {
  const att = { id: 'bot-asset:1', clientId: 'a', path: 'downloads/ytdlp/clip.mp4', name: 'clip.mp4', size: 500 };
  const r = resolveAttachmentNode(att, ctx(['a'], [moved]));
  assert.equal(r.path, 'videos/clip.mp4');
  assert.equal(r.contentHash, hash);
});

test('offline node falls back to an online copy; nothing found keeps the original', () => {
  const att = { id: 'bot-asset:1', clientId: 'a', path: 'videos/clip.mp4', name: 'clip.mp4', size: 500, contentHash: hash };
  assert.equal(resolveAttachmentNode(att, ctx(['b'], [moved, copyOnB])).clientId, 'b');
  const lonely = { ...att, contentHash: 'd'.repeat(64) };
  assert.equal(resolveAttachmentNode(lonely, ctx(['b'], [moved, copyOnB])), lonely);
});

test('chat attachments switch to an online node at the same path', () => {
  const att = { id: 'x', clientId: 'a', path: '.nas-chat-room/attachments/2026/u/1.png', name: '1.png', size: 9 };
  assert.deepEqual(resolveAttachmentNode(att, ctx(['b'], [], 'b')).clientId, 'b');
  assert.equal(resolveAttachmentNode(att, ctx(['a'], [])), att);
});
