/**
 * 媒体能力公共判断层
 * 从 App.jsx / SharePage.jsx 抽出，供大屏纯享页及后续新入口复用。
 */

export function isImageMime(mimeType = "") {
  return String(mimeType || "").startsWith("image/");
}

export function isVideoMime(mimeType = "") {
  return String(mimeType || "").startsWith("video/");
}

export function isAudioMime(mimeType = "") {
  return String(mimeType || "").startsWith("audio/");
}

const PLAYABLE_EXTENSIONS = new Set([
  "mp4", "webm", "mov", "m4v", "mkv", "avi",
  "mp3", "flac", "wav", "m4a", "aac", "ogg", "opus"
]);

export function isPlayableByExtension(fileName = "") {
  const ext = String(fileName || "").split(".").pop().toLowerCase();
  return PLAYABLE_EXTENSIONS.has(ext);
}

export function isPlayableFile(file = {}) {
  if (isVideoMime(file.mimeType) || isAudioMime(file.mimeType)) return true;
  if (!file.mimeType && file.name) return isPlayableByExtension(file.name);
  return false;
}

export function canBrowserPlayVideoMime(mimeType = "") {
  if (!isVideoMime(mimeType)) return false;
  const video = document.createElement("video");
  const result = video.canPlayType(mimeType);
  return result === "probably" || result === "maybe";
}

/** 从文件列表过滤出可播放媒体，按上传时间降序排列 */
export function filterPlayableFiles(files = []) {
  return files
    .filter(isPlayableFile)
    .sort((a, b) => {
      const ta = Date.parse(a.createdAt || a.updatedAt || a.syncedAt || "") || 0;
      const tb = Date.parse(b.createdAt || b.updatedAt || b.syncedAt || "") || 0;
      return tb - ta;
    });
}

let _hlsModulePromise = null;

export async function getHlsPlaybackSupport() {
  try {
    _hlsModulePromise ??= import("hls.js");
    const mod = await _hlsModulePromise;
    const Hls = mod?.default;
    if (!Hls) return { supported: false, reason: "hls.js 未加载" };
    if (typeof Hls.isSupported === "function" && Hls.isSupported()) return { supported: true };
    const hasMSE = !!(window.MediaSource || window.ManagedMediaSource || window.WebKitMediaSource);
    return hasMSE ? { supported: true } : { supported: false, reason: "浏览器缺少 MediaSource" };
  } catch (e) {
    return { supported: false, reason: e?.message || "hls.js 加载失败" };
  }
}
