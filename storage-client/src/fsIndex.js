import fs from "node:fs";
import path from "node:path";
import mime from "mime-types";

export async function scanFiles(rootDir) {
  const output = [];
  const previewCacheDirName = process.env.PREVIEW_CACHE_DIR_NAME || ".nas-preview-cache";
  const hlsCacheDirName = process.env.HLS_CACHE_DIR_NAME || ".nas-hls-cache";

  async function walk(currentDir) {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === previewCacheDirName || entry.name === hlsCacheDirName) {
          continue;
        }
        await walk(absolute);
        continue;
      }
      const stat = await fs.promises.stat(absolute);
      const relative = path.relative(rootDir, absolute).split(path.sep).join("/");
      output.push({
        path: relative,
        name: entry.name,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        mimeType: mime.lookup(entry.name) || "application/octet-stream"
      });
    }
  }

  if (!fs.existsSync(rootDir)) {
    await fs.promises.mkdir(rootDir, { recursive: true });
  }

  await walk(rootDir);
  return output;
}

export function safeJoin(rootDir, relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const target = path.resolve(rootDir, normalized);
  const rootResolved = path.resolve(rootDir);
  if (!target.startsWith(rootResolved)) {
    throw new Error("invalid path");
  }
  return target;
}
