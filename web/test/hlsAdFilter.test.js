import test from 'node:test';
import assert from 'node:assert/strict';
import { stripAdSegments } from '../src/media/hlsAdFilter.js';

const segs = (dir, n, dur = 4) => Array.from({ length: n }, (_, i) => `#EXTINF:${dur},\n${dir}${i}.ts`).join('\n');
const playlist = (...parts) => ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', parts.join('\n#EXT-X-DISCONTINUITY\n'), '#EXT-X-ENDLIST'].join('\n');
const main = '/20231028/3BMRArnT/1051kb/hls/';
const ad = '/20261009/l7aBZIKL/10152kb/hls/';

test('drops short runs from a foreign directory between discontinuities', () => {
  const { text, removed } = stripAdSegments(playlist(segs(main, 20), segs(ad, 4), segs(main, 20), segs(ad, 4)));
  assert.equal(removed, 8);
  assert.ok(!text.includes(ad));
  assert.equal(text.match(/\.ts/g).length, 40);
  assert.ok(text.startsWith('#EXTM3U') && text.trimEnd().endsWith('#EXT-X-ENDLIST'));
});

test('keeps playlists whose discontinuities stay in one directory', () => {
  const input = playlist(segs(main, 15), segs(main, 3), segs(main, 11));
  assert.deepEqual(stripAdSegments(input), { text: input, removed: 0 });
});

test('keeps long foreign runs and wraps proxied URIs correctly', () => {
  const proxied = (dir, n) => segs(`/api/anime/proxy-stream?ref=&url=${encodeURIComponent('https://cdn.example' + dir)}`, n);
  const longOther = playlist(segs(main, 30), segs(ad, 40));
  assert.equal(stripAdSegments(longOther).removed, 0);
  assert.equal(stripAdSegments(playlist(proxied(main, 20), proxied(ad, 3))).removed, 3);
});
