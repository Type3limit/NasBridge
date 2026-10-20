import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { detectPrintedFilePaths, isXPostUrl } from "../../src/bot/plugins/ytdlp.js";

test("detectPrintedFilePaths keeps every file of a multi-video post in order", () => {
  const tempDir = path.resolve("tmp-job");
  const files = ["post #1 [111].mp4", "post #2 [222].mp4", "post #3 [333].mp4"].map((name) => path.join(tempDir, name));
  const lines = [
    "[twitter] Extracting URL: https://x.com/user/status/1",
    "[download] Downloading playlist: post",
    files[0],
    "[download] 100% of 1.00MiB",
    files[1],
    files[2],
    files[2]
  ];
  const exists = (value) => files.includes(value);

  assert.deepEqual(detectPrintedFilePaths(lines, tempDir, exists), files);
});

test("detectPrintedFilePaths ignores paths that were not written", () => {
  const tempDir = path.resolve("tmp-job");
  const written = path.join(tempDir, "video [1].mp4");
  const lines = [path.join(tempDir, "missing.mp4"), written];

  assert.deepEqual(detectPrintedFilePaths(lines, tempDir, (value) => value === written), [written]);
});

test("isXPostUrl only matches X and Twitter links", () => {
  assert.equal(isXPostUrl("https://x.com/user/status/1"), true);
  assert.equal(isXPostUrl("https://twitter.com/user/status/1/video/1"), true);
  assert.equal(isXPostUrl("https://mobile.twitter.com/user/status/1"), true);
  assert.equal(isXPostUrl("https://www.youtube.com/watch?v=abc&list=PL123"), false);
  assert.equal(isXPostUrl("https://www.bilibili.com/video/BV1xx411c7mD"), false);
  assert.equal(isXPostUrl("https://notx.com/user/status/1"), false);
  assert.equal(isXPostUrl("not a url"), false);
});
