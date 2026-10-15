import fs from 'node:fs';
import crypto from 'node:crypto';
const cache = new Map();
export async function getContentHash(filename, expectedStat = null) {
  const before = await fs.promises.stat(filename);
  const stamp = `${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
  if (expectedStat && `${expectedStat.size}:${expectedStat.mtimeMs}:${expectedStat.ctimeMs}` !== stamp) return '';
  if (cache.get(filename)?.stamp === stamp) return cache.get(filename).hash;
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  const after = await fs.promises.stat(filename);
  if (`${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== stamp) return '';
  const value = hash.digest('hex');
  if (cache.size > 100000) cache.clear();
  cache.set(filename, { stamp, hash: value });
  return value;
}
