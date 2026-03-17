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

export async function scanFiles(rootDir) {
  const files = [];
  const directories = [];
  const previewCacheDirName = process.env.PREVIEW_CACHE_DIR_NAME || ".nas-preview-cache";
  const hlsCacheDirName = process.env.HLS_CACHE_DIR_NAME || ".nas-hls-cache";
  const avatarDirName = process.env.PROFILE_AVATAR_DIR_NAME || ".nas-user-avatars";
  const chatRoomDirName = process.env.CHAT_ROOM_DIR_NAME || ".nas-chat-room";
  const botAppDataDirName = process.env.BOT_APP_DATA_DIR_NAME || ".nas-bot";

  function shouldSkipDirectory(name = "") {
    return (
      name === previewCacheDirName ||
      name === hlsCacheDirName ||
      name === avatarDirName ||
      name === chatRoomDirName ||
      name === botAppDataDirName
    );
  }

  async function walk(currentDir) {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name)) {
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
  return { files, directories };
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
