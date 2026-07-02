import fs from "node:fs";
import path from "node:path";
import mime from "mime-types";

function toIsoStringIfValid(value) {
  if (!value) {
    return "";
  }
  const ts = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ts) || ts <= 0) {
    return "";
  }
  return new Date(ts).toISOString();
}

function resolveCreatedAt(stat) {
  const birthtime = toIsoStringIfValid(stat?.birthtime);
  if (birthtime) {
    return birthtime;
  }
  const ctime = toIsoStringIfValid(stat?.ctime);
  if (ctime) {
    return ctime;
  }
  return toIsoStringIfValid(stat?.mtime) || new Date().toISOString();
}

export function getStorageHiddenDirectoryNames() {
  return [
    process.env.PREVIEW_CACHE_DIR_NAME || ".nas-preview-cache",
    process.env.HLS_CACHE_DIR_NAME || ".nas-hls-cache",
    process.env.AUDIO_STREAM_CACHE_DIR_NAME || ".nas-audio-stream-cache",
    process.env.PROFILE_AVATAR_DIR_NAME || ".nas-user-avatars",
    process.env.CHAT_ROOM_DIR_NAME || ".nas-chat-room",
    process.env.BOT_APP_DATA_DIR_NAME || ".nas-bot"
  ].filter(Boolean);
}

export async function scanFiles(rootDir) {
  const files = [];
  const directories = [];
  const hiddenDirectories = getStorageHiddenDirectoryNames();
  const hiddenDirectorySet = new Set(hiddenDirectories);
  const skippedDirectorySet = new Set();

  function shouldSkipDirectory(name = "") {
    return hiddenDirectorySet.has(name);
  }

  async function walk(currentDir) {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name)) {
          const relative = path.relative(rootDir, absolute).split(path.sep).join("/");
          skippedDirectorySet.add(relative || entry.name);
          continue;
        }
        try {
          const stat = await fs.promises.stat(absolute);
          const relative = path.relative(rootDir, absolute).split(path.sep).join("/");
          if (relative) {
            directories.push({
              path: relative,
              name: entry.name,
              createdAt: resolveCreatedAt(stat),
              updatedAt: stat.mtime.toISOString()
            });
          }
        } catch {
          continue;
        }
        await walk(absolute);
        continue;
      }
      try {
        const stat = await fs.promises.stat(absolute);
        const relative = path.relative(rootDir, absolute).split(path.sep).join("/");
        files.push({
          path: relative,
          name: entry.name,
          size: stat.size,
          createdAt: resolveCreatedAt(stat),
          updatedAt: stat.mtime.toISOString(),
          mimeType: mime.lookup(entry.name) || "application/octet-stream"
        });
      } catch {
        // Skip files that are temporarily locked or unreadable.
      }
    }
  }

  if (!fs.existsSync(rootDir)) {
    await fs.promises.mkdir(rootDir, { recursive: true });
  }

  await walk(rootDir);
  return {
    files,
    directories,
    generatedAt: new Date().toISOString(),
    hiddenDirectories,
    skippedDirectories: [...skippedDirectorySet].sort()
  };
}

export function safeJoin(rootDir, relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const target = path.resolve(rootDir, normalized);
  const rootResolved = path.resolve(rootDir);
  const relative = path.relative(rootResolved, target);
  if (relative && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
    throw new Error("invalid path");
  }
  return target;
}
