import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createMusicLibBridgeClient } from "./musicBridge.js";

const MUSIC_PLAYER_DIR = "music-player";
const MUSIC_PLAYER_STATE_FILE = "state.json";
const MUSIC_PLAYER_CACHE_DIR = "cache";
const DEFAULT_SOURCE = "bilibili";
const MUSIC_SOURCES = ["qq", "migu", "kuwo", "netease", "bilibili", "jamendo"];
const SOURCE_LABELS = {
  qq: "QQ 音乐",
  migu: "咪咕音乐",
  kuwo: "酷我音乐",
  netease: "网易云音乐",
  bilibili: "Bilibili",
  jamendo: "Jamendo"
};
const MUSIC_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const PREPARE_AHEAD_COUNT = 2;
const LYRICS_SEARCH_ENDPOINT = "https://lrclib.net/api/search";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const ENABLE_FLAC_CACHE_TRANSCODE = process.env.ENABLE_TRANSCODE !== "0" && process.env.MUSIC_PLAYER_TRANSCODE_FLAC !== "0";

function getNowIso() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeFileSegment(value = "", fallback = "track") {
  const normalized = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function stripHtml(value = "") {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCoverUrl(url = "") {
  const value = String(url || "").trim();
  if (!value) {
    return "";
  }
  if (value.startsWith("//")) {
    return `https:${value}`;
  }
  return value;
}

function normalizeUrl(url = "") {
  const value = String(url || "").trim();
  if (!value) {
    return "";
  }
  if (value.startsWith("//")) {
    return `https:${value}`;
  }
  return value;
}

function getSourceLabel(source = "") {
  return SOURCE_LABELS[String(source || "").trim()] || String(source || "未知来源");
}

function guessExtension(url = "", fallback = ".mp3") {
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname || "").toLowerCase();
    if (ext && ext.length <= 6) {
      return ext;
    }
  } catch {
  }
  return fallback;
}

function isFlacTrackLike(track = {}) {
  const ext = String(track?.ext || "").trim().toLowerCase();
  const mimeType = String(track?.mimeType || "").trim().toLowerCase();
  return ext === ".flac" || mimeType.includes("flac");
}

function replacePathExt(relativePath = "", nextExt = ".mp3") {
  const normalized = String(relativePath || "").trim();
  if (!normalized) {
    return normalized;
  }
  const parsed = path.posix.parse(normalized);
  return path.posix.join(parsed.dir, `${parsed.name}${nextExt.startsWith(".") ? nextExt : `.${nextExt}`}`);
}

function buildTempSiblingPath(filePath = "") {
  const parsed = path.parse(String(filePath || ""));
  return path.join(parsed.dir, `${parsed.name}.tmp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${parsed.ext}`);
}

async function transcodeAudioFileToMp3(inputPath, outputPath) {
  await new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      outputPath
    ];
    const proc = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => reject(new Error(`ffmpeg launch failed: ${error.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg transcode failed with code ${code}: ${stderr.slice(-400)}`));
    });
  });

  const stat = await fs.promises.stat(outputPath);
  if (!stat.isFile() || Number(stat.size || 0) <= 0) {
    throw new Error("ffmpeg transcode produced empty mp3 output");
  }
}

function pickJamendoStream(streams = {}) {
  if (!streams || typeof streams !== "object") {
    return { url: "", ext: ".mp3" };
  }
  for (const key of ["flac", "mp3", "ogg"]) {
    const url = normalizeUrl(streams[key]);
    if (url) {
      return { url, ext: key === "flac" ? ".flac" : key === "ogg" ? ".ogg" : ".mp3" };
    }
  }
  const first = Object.values(streams).find((value) => String(value || "").trim());
  const url = normalizeUrl(first || "");
  return { url, ext: guessExtension(url, ".mp3") };
}

function sha1Hex(value = "") {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

function makeJamendoCall(pathname = "/api/search") {
  const nonce = String(Math.random());
  return `$${sha1Hex(`${pathname}${nonce}`)}*${nonce}~`;
}

function chooseBestBilibiliAudio(items = []) {
  return [...(items || [])]
    .filter((item) => normalizeUrl(item?.baseUrl || item?.base_url || item?.backupUrl || item?.backup_url))
    .sort((left, right) => Number(right?.bandwidth || right?.id || 0) - Number(left?.bandwidth || left?.id || 0))[0] || null;
}

function createDefaultState() {
  const now = getNowIso();
  return {
    version: 1,
    source: DEFAULT_SOURCE,
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    positionSeconds: 0,
    positionUpdatedAt: now,
    updatedAt: now,
    lastError: ""
  };
}

function computeEffectivePosition(state, track = null, now = Date.now()) {
  const base = Number(state?.positionSeconds || 0);
  if (!state?.isPlaying) {
    return base;
  }
  const updatedAt = Date.parse(String(state?.positionUpdatedAt || "")) || now;
  const elapsed = Math.max(0, (now - updatedAt) / 1000);
  const duration = Number(track?.duration || 0);
  if (duration > 0) {
    return clamp(base + elapsed, 0, duration);
  }
  return Math.max(0, base + elapsed);
}

function buildPublicTrack(track = {}, index = 0) {
  const progress = track?.progress && typeof track.progress === "object"
    ? {
        percent: Number.isFinite(track.progress.percent) ? clamp(Number(track.progress.percent), 0, 100) : null,
        label: String(track.progress.label || "").trim(),
        receivedBytes: Number(track.progress.receivedBytes || 0),
        totalBytes: Number(track.progress.totalBytes || 0)
      }
    : null;
  return {
    id: String(track.id || ""),
    index,
    source: String(track.source || DEFAULT_SOURCE),
    sourceLabel: getSourceLabel(track.source || DEFAULT_SOURCE),
    providerTrackId: String(track.providerTrackId || ""),
    title: String(track.title || "未命名曲目"),
    artist: String(track.artist || "未知艺术家"),
    album: String(track.album || ""),
    duration: Number(track.duration || 0),
    coverUrl: normalizeCoverUrl(track.coverUrl || ""),
    status: String(track.status || "queued"),
    relativePath: String(track.relativePath || ""),
    mimeType: String(track.mimeType || "audio/mpeg"),
    ext: String(track.ext || ".mp3"),
    requestedKeyword: String(track.requestedKeyword || ""),
    submittedAt: String(track.submittedAt || ""),
    submittedBy: String(track.submittedBy || ""),
    readyAt: String(track.readyAt || ""),
    lyrics: String(track.lyrics || ""),
    progress,
    error: String(track.error || "")
  };
}

function buildPublicCandidate(candidate = {}, index = 0) {
  return {
    index,
    source: String(candidate.source || DEFAULT_SOURCE),
    sourceLabel: getSourceLabel(candidate.source || DEFAULT_SOURCE),
    providerTrackId: String(candidate.providerTrackId || ""),
    title: String(candidate.title || "未命名曲目"),
    artist: String(candidate.artist || "未知艺术家"),
    album: String(candidate.album || ""),
    duration: Number(candidate.duration || 0),
    coverUrl: normalizeCoverUrl(candidate.coverUrl || ""),
    link: String(candidate.link || ""),
    ext: String(candidate.ext || ""),
    extra: candidate?.extra && typeof candidate.extra === "object" ? candidate.extra : {}
  };
}

function normalizeCandidate(candidate = {}, fallbackSource = DEFAULT_SOURCE) {
  const source = String(candidate.source || fallbackSource || DEFAULT_SOURCE).trim() || DEFAULT_SOURCE;
  const extra = candidate?.extra && typeof candidate.extra === "object" ? candidate.extra : {};
  return {
    source,
    providerTrackId: String(candidate.providerTrackId || candidate.id || extra.track_id || extra.songmid || extra.rid || extra.content_id || "").trim(),
    title: String(candidate.title || candidate.name || "").trim(),
    artist: String(candidate.artist || "").trim(),
    album: String(candidate.album || "").trim(),
    duration: Number(candidate.duration || 0),
    coverUrl: normalizeCoverUrl(candidate.coverUrl || candidate.cover || ""),
    link: String(candidate.link || "").trim(),
    ext: String(candidate.ext || "").trim(),
    extra
  };
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 20_000));
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "user-agent": MUSIC_USER_AGENT,
        ...options.headers
      },
      body: options.body,
      redirect: options.redirect || "follow",
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 20_000));
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "user-agent": MUSIC_USER_AGENT,
        ...options.headers
      },
      body: options.body,
      redirect: options.redirect || "follow",
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupLyrics(track = {}) {
  const title = String(track.title || "").trim();
  const artist = String(track.artist || "").trim();
  if (!title) {
    return "";
  }
  try {
    const params = new URLSearchParams({ track_name: title });
    if (artist) {
      params.set("artist_name", artist);
    }
    const results = await fetchJson(`${LYRICS_SEARCH_ENDPOINT}?${params.toString()}`, { timeoutMs: 10_000 });
    if (!Array.isArray(results) || !results.length) {
      return "";
    }
    const best = results.find((item) => item?.syncedLyrics || item?.plainLyrics) || results[0];
    return String(best?.syncedLyrics || best?.plainLyrics || "").trim();
  } catch {
    return "";
  }
}

async function searchJamendoCandidates(keyword = "", limit = 8) {
  const params = new URLSearchParams({
    query: String(keyword || "").trim(),
    type: "track",
    limit: String(Math.max(1, Math.min(12, Number(limit || 8)))),
    identities: "www"
  });
  const tracks = await fetchJson(`https://www.jamendo.com/api/search?${params.toString()}`, {
    headers: {
      referer: "https://www.jamendo.com/search?q=music",
      "x-jam-call": makeJamendoCall("/api/search"),
      "x-jam-version": "4gvfvv",
      "x-requested-with": "XMLHttpRequest"
    }
  });
  if (!Array.isArray(tracks) || !tracks.length) {
    throw new Error("未找到可播放的 Jamendo 结果");
  }
  return tracks.map((item) => normalizeCandidate({
    source: "jamendo",
    providerTrackId: String(item?.id || ""),
    title: String(item?.name || "").trim(),
    artist: String(item?.artist?.name || "").trim(),
    album: String(item?.album?.name || "").trim(),
    duration: Number(item?.duration || 0),
    coverUrl: normalizeCoverUrl(item?.cover?.big?.size300 || ""),
    link: item?.link || item?.shareurl || "",
    extra: {
      track_id: String(item?.id || "")
    }
  }, "jamendo"));
}

async function resolveJamendoCandidate(candidate = {}) {
  const params = new URLSearchParams({ id: String(candidate.providerTrackId || candidate.extra?.track_id || "").trim() });
  const tracks = await fetchJson(`https://www.jamendo.com/api/tracks?${params.toString()}`, {
    headers: {
      referer: "https://www.jamendo.com/search?q=music",
      "x-jam-call": makeJamendoCall("/api/tracks"),
      "x-jam-version": "4gvfvv",
      "x-requested-with": "XMLHttpRequest"
    }
  });
  const item = Array.isArray(tracks) ? tracks[0] : null;
  if (!item) {
    throw new Error("Jamendo 曲目详情不存在");
  }
  const stream = pickJamendoStream(item?.download || item?.stream || {});
  if (!stream.url) {
    throw new Error("Jamendo 未返回可下载音频");
  }
  return {
    source: "jamendo",
    providerTrackId: String(candidate.providerTrackId || item?.id || ""),
    title: String(item?.name || candidate.title || "").trim(),
    artist: String(item?.artist?.name || candidate.artist || "").trim(),
    album: String(item?.album?.name || candidate.album || "").trim(),
    duration: Number(item?.duration || candidate.duration || 0),
    coverUrl: normalizeCoverUrl(item?.cover?.big?.size300 || candidate.coverUrl || ""),
    remoteUrl: stream.url,
    mimeType: stream.ext === ".ogg" ? "audio/ogg" : stream.ext === ".flac" ? "audio/flac" : "audio/mpeg",
    ext: stream.ext,
    requestHeaders: {}
  };
}

async function searchBilibiliCandidates(keyword = "", limit = 8) {
  const params = new URLSearchParams({
    search_type: "video",
    keyword: String(keyword || "").trim(),
    page: "1",
    page_size: String(Math.max(1, Math.min(12, Number(limit || 8))))
  });
  const result = await fetchJson(`https://api.bilibili.com/x/web-interface/search/type?${params.toString()}`, {
    headers: {
      referer: "https://www.bilibili.com/"
    }
  });
  const items = Array.isArray(result?.data?.result) ? result.data.result : [];
  if (!items.length) {
    throw new Error("未找到可播放的 Bilibili 结果");
  }
  return items
    .filter((item) => String(item?.bvid || "").trim())
    .map((item) => normalizeCandidate({
      source: "bilibili",
      providerTrackId: String(item?.bvid || "").trim(),
      title: stripHtml(item?.title || ""),
      artist: String(item?.author || item?.typename || "").trim(),
      album: "Bilibili",
      duration: Number(item?.duration || 0),
      coverUrl: normalizeCoverUrl(item?.pic || ""),
      link: `https://www.bilibili.com/video/${String(item?.bvid || "").trim()}`
    }, "bilibili"));
}

async function resolveBilibiliCandidate(candidate = {}) {
  const bvid = String(candidate.providerTrackId || "").trim();
  if (!bvid) {
    throw new Error("Bilibili 曲目标识缺失");
  }
  const html = await fetchText(`https://www.bilibili.com/video/${bvid}`, {
    headers: {
      referer: "https://www.bilibili.com/"
    },
    timeoutMs: 20_000
  });
  const playInfoMatch = html.match(/window\.__playinfo__=([\s\S]+?)<\/script>/);
  if (!playInfoMatch?.[1]) {
    throw new Error("Bilibili 页面未返回音频信息");
  }
  let playInfo = null;
  try {
    playInfo = JSON.parse(playInfoMatch[1]);
  } catch {
    throw new Error("Bilibili 音频信息解析失败");
  }
  const audio = chooseBestBilibiliAudio(playInfo?.data?.dash?.audio || []);
  const remoteUrl = normalizeUrl(audio?.baseUrl || audio?.base_url || "");
  if (!remoteUrl) {
    throw new Error("Bilibili 未返回可播放音频链路");
  }
  return {
    providerTrackId: bvid,
    source: "bilibili",
    title: candidate.title,
    artist: candidate.artist,
    album: candidate.album || "Bilibili",
    duration: Number(candidate.duration || 0),
    coverUrl: normalizeCoverUrl(candidate.coverUrl || ""),
    remoteUrl,
    mimeType: "audio/mp4",
    ext: guessExtension(remoteUrl, ".m4a"),
    requestHeaders: {
      referer: `https://www.bilibili.com/video/${bvid}`
    }
  };
}

const LEGACY_SEARCH_PROVIDERS = {
  bilibili: searchBilibiliCandidates,
  jamendo: searchJamendoCandidates
};

const LEGACY_RESOLVE_PROVIDERS = {
  bilibili: resolveBilibiliCandidate,
  jamendo: resolveJamendoCandidate
};

export class GlobalMusicPlayer {
  constructor(options = {}) {
    this.storageRoot = path.resolve(options.storageRoot || process.cwd());
    this.appDataRoot = path.resolve(options.appDataRoot || path.join(this.storageRoot, ".nas-bot"));
    this.playerRoot = path.join(this.appDataRoot, MUSIC_PLAYER_DIR);
    this.cacheRoot = path.join(this.playerRoot, MUSIC_PLAYER_CACHE_DIR);
    this.statePath = path.join(this.playerRoot, MUSIC_PLAYER_STATE_FILE);
    this.state = createDefaultState();
    this.persistWrite = Promise.resolve();
    this.prepareTasks = new Map();
    this.activeDownloads = new Map();
    this.cancelledTracks = new Set();
    this.logger = typeof options.logger === "function" ? options.logger : () => {};
    this.onTrackReady = typeof options.onTrackReady === "function" ? options.onTrackReady : null;
    this.bridge = createMusicLibBridgeClient({
      spawnProcess: options.spawnProcess,
      logger: options.logger || (() => {})
    });
  }

  async init() {
    await fs.promises.mkdir(this.cacheRoot, { recursive: true });
    await this.bridge.init();
    try {
      const raw = await fs.promises.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        this.state = {
          ...createDefaultState(),
          ...parsed,
          source: MUSIC_SOURCES.includes(String(parsed.source || "")) ? String(parsed.source) : DEFAULT_SOURCE,
          queue: Array.isArray(parsed.queue) ? parsed.queue : []
        };
      }
    } catch {
      this.state = createDefaultState();
    }
    this.normalizeState();
    await this.persist();
    this.ensurePreparation();
  }

  normalizeState() {
    if (!Array.isArray(this.state.queue)) {
      this.state.queue = [];
    }
    if (!MUSIC_SOURCES.includes(String(this.state.source || ""))) {
      this.state.source = DEFAULT_SOURCE;
    }
    if (!this.state.queue.length) {
      this.state.currentIndex = -1;
      this.state.isPlaying = false;
      this.state.positionSeconds = 0;
    } else {
      this.state.currentIndex = clamp(Number(this.state.currentIndex ?? 0), 0, this.state.queue.length - 1);
    }
    this.state.updatedAt = getNowIso();
    this.state.positionUpdatedAt = String(this.state.positionUpdatedAt || this.state.updatedAt || getNowIso());
  }

  getCurrentTrack() {
    const index = Number(this.state.currentIndex ?? -1);
    if (index < 0 || index >= this.state.queue.length) {
      return null;
    }
    return this.state.queue[index] || null;
  }

  snapshot() {
    const currentTrack = this.getCurrentTrack();
    const effectivePosition = computeEffectivePosition(this.state, currentTrack);
    return {
      source: this.state.source,
      queue: this.state.queue.map((track, index) => buildPublicTrack(track, index)),
      currentIndex: Number(this.state.currentIndex ?? -1),
      isPlaying: Boolean(this.state.isPlaying),
      positionSeconds: effectivePosition,
      positionUpdatedAt: this.state.positionUpdatedAt,
      updatedAt: this.state.updatedAt,
      lastError: String(this.state.lastError || ""),
      currentTrack: currentTrack ? buildPublicTrack(currentTrack, this.state.currentIndex) : null,
      supportedSources: this.getSupportedSources().map((value) => ({
        value,
        label: getSourceLabel(value)
      }))
    };
  }

  getSupportedSources() {
    const bridgeSources = this.bridge.getSources();
    return MUSIC_SOURCES.filter((value) => bridgeSources.includes(value) || Boolean(LEGACY_SEARCH_PROVIDERS[value]));
  }

  async handleControlMessage(message = {}) {
    if (message.type === "get-music-player-state") {
      return {
        type: "music-player-state-result",
        requestId: message.requestId || "",
        state: this.snapshot()
      };
    }
    if (message.type === "enqueue-music-track") {
      const track = await this.enqueueTrack({
        keyword: message.keyword,
        source: message.source,
        submittedBy: message.submittedBy
      });
      return {
        type: "music-track-enqueued",
        requestId: message.requestId || "",
        track: buildPublicTrack(track),
        state: this.snapshot()
      };
    }
    if (message.type === "search-music-candidates") {
      const candidates = await this.searchCandidates({
        keyword: message.keyword,
        source: message.source,
        limit: message.limit
      });
      return {
        type: "music-search-result",
        requestId: message.requestId || "",
        source: String(message.source || this.state.source || DEFAULT_SOURCE),
        candidates: candidates.map((item, index) => buildPublicCandidate(item, index))
      };
    }
    if (message.type === "enqueue-music-selection") {
      const track = await this.enqueueSelection({
        source: message.source,
        candidate: message.candidate,
        submittedBy: message.submittedBy
      });
      return {
        type: "music-track-enqueued",
        requestId: message.requestId || "",
        track: buildPublicTrack(track),
        state: this.snapshot()
      };
    }
    if (message.type === "control-music-player") {
      await this.control(message.action, message.payload || {});
      return {
        type: "music-player-control-result",
        requestId: message.requestId || "",
        state: this.snapshot()
      };
    }
    return null;
  }

  async control(action = "", payload = {}) {
    const nowIso = getNowIso();
    const currentTrack = this.getCurrentTrack();
    const currentId = String(currentTrack?.id || "");
    const requestedTrackId = String(payload.currentTrackId || currentId || "");
    if (requestedTrackId && currentId && requestedTrackId !== currentId && !["set-source", "remove-track", "play-track"].includes(action)) {
      return;
    }

    if (action === "set-source") {
      const nextSource = String(payload.source || "").trim();
      if (MUSIC_SOURCES.includes(nextSource)) {
        this.state.source = nextSource;
        this.state.updatedAt = nowIso;
        this.state.lastError = "";
        await this.persist();
      }
      return;
    }

    if (action === "remove-track") {
      await this.removeTrack(payload || {});
      return;
    }

    if (action === "play-track") {
      const nextIndex = this.resolvePlayableQueueIndex(payload || {});
      if (nextIndex >= 0) {
        this.state.currentIndex = nextIndex;
        this.state.positionSeconds = 0;
        this.state.positionUpdatedAt = nowIso;
        this.state.isPlaying = true;
      }
    }

    const effectivePosition = computeEffectivePosition(this.state, currentTrack);
    if (action === "play") {
      this.state.isPlaying = true;
      this.state.positionSeconds = effectivePosition;
      this.state.positionUpdatedAt = nowIso;
    }
    if (action === "pause") {
      this.state.isPlaying = false;
      this.state.positionSeconds = effectivePosition;
      this.state.positionUpdatedAt = nowIso;
    }
    if (action === "seek") {
      const nextPosition = Math.max(0, Number(payload.positionSeconds || 0));
      this.state.positionSeconds = currentTrack?.duration ? clamp(nextPosition, 0, Number(currentTrack.duration || 0)) : nextPosition;
      this.state.positionUpdatedAt = nowIso;
    }
    if (action === "next") {
      if (this.state.queue.length) {
        this.state.currentIndex = clamp(Number(this.state.currentIndex ?? 0) + 1, 0, this.state.queue.length - 1);
        this.state.positionSeconds = 0;
        this.state.positionUpdatedAt = nowIso;
        this.state.isPlaying = true;
      }
    }
    if (action === "previous") {
      if (this.state.queue.length) {
        const previousIndex = clamp(Number(this.state.currentIndex ?? 0) - 1, 0, this.state.queue.length - 1);
        this.state.currentIndex = previousIndex;
        this.state.positionSeconds = 0;
        this.state.positionUpdatedAt = nowIso;
        this.state.isPlaying = true;
      }
    }
    if (action === "complete") {
      if (this.state.queue.length && Number(this.state.currentIndex ?? 0) < this.state.queue.length - 1) {
        this.state.currentIndex += 1;
        this.state.positionSeconds = 0;
        this.state.positionUpdatedAt = nowIso;
        this.state.isPlaying = true;
      } else {
        this.state.isPlaying = false;
        this.state.positionSeconds = Number(currentTrack?.duration || effectivePosition || 0);
        this.state.positionUpdatedAt = nowIso;
      }
    }

    this.state.updatedAt = nowIso;
    this.state.lastError = "";
    await this.persist();
    this.ensurePreparation();
  }

  getAbsoluteTrackPath(track = {}) {
    return path.join(this.storageRoot, String(track.relativePath || "").split("/").join(path.sep));
  }

  notifyTrackReady(track = null) {
    if (!this.onTrackReady || !track?.relativePath) {
      return;
    }
    try {
      this.onTrackReady(this.getAbsoluteTrackPath(track), track);
    } catch (error) {
      this.logger("music-track-ready-hook-failed", error?.message || error);
    }
  }

  hasTrack(trackId = "") {
    return this.state.queue.some((item) => String(item?.id || "") === String(trackId || ""));
  }

  async deleteTrackArtifacts(track = {}) {
    const absolutePath = this.getAbsoluteTrackPath(track);
    if (!absolutePath) {
      return;
    }
    await fs.promises.rm(`${absolutePath}.part`, { force: true }).catch(() => {});
    await fs.promises.rm(absolutePath, { force: true }).catch(() => {});
  }

  async cancelTrackPreparation(track = {}) {
    const trackId = String(track?.id || "");
    if (!trackId) {
      return;
    }
    this.cancelledTracks.add(trackId);
    const activeDownload = this.activeDownloads.get(trackId);
    if (activeDownload?.controller) {
      activeDownload.controller.abort();
    }
    if (activeDownload?.fileStream) {
      activeDownload.fileStream.destroy();
    }
    await this.deleteTrackArtifacts(track);
  }

  resolveTrackRemovalIndex(payload = {}) {
    const normalizedTrackId = String(payload.trackId || "").trim();
    if (normalizedTrackId) {
      const indexById = this.state.queue.findIndex((item) => String(item?.id || "") === normalizedTrackId);
      if (indexById >= 0) {
        return indexById;
      }
    }

    const queueIndex = Number(payload.queueIndex);
    if (Number.isInteger(queueIndex) && queueIndex >= 0 && queueIndex < this.state.queue.length) {
      const candidate = this.state.queue[queueIndex];
      const providerTrackId = String(payload.providerTrackId || "").trim();
      const relativePath = String(payload.relativePath || "").trim();
      const title = String(payload.title || "").trim();
      const source = String(payload.source || "").trim();
      const matchesQueueEntry = (!providerTrackId || String(candidate?.providerTrackId || "") === providerTrackId)
        && (!relativePath || String(candidate?.relativePath || "") === relativePath)
        && (!title || String(candidate?.title || "") === title)
        && (!source || String(candidate?.source || "") === source);
      if (matchesQueueEntry) {
        return queueIndex;
      }
    }

    const providerTrackId = String(payload.providerTrackId || "").trim();
    if (providerTrackId) {
      const indexByProviderTrackId = this.state.queue.findIndex((item) => String(item?.providerTrackId || "") === providerTrackId);
      if (indexByProviderTrackId >= 0) {
        return indexByProviderTrackId;
      }
    }

    const relativePath = String(payload.relativePath || "").trim();
    if (relativePath) {
      const indexByRelativePath = this.state.queue.findIndex((item) => String(item?.relativePath || "") === relativePath);
      if (indexByRelativePath >= 0) {
        return indexByRelativePath;
      }
    }

    return -1;
  }

  resolvePlayableQueueIndex(payload = {}) {
    const queueIndex = Number(payload.queueIndex);
    if (Number.isInteger(queueIndex) && queueIndex >= 0 && queueIndex < this.state.queue.length) {
      return queueIndex;
    }

    const normalizedTrackId = String(payload.trackId || "").trim();
    if (normalizedTrackId) {
      const indexById = this.state.queue.findIndex((item) => String(item?.id || "") === normalizedTrackId);
      if (indexById >= 0) {
        return indexById;
      }
    }

    return -1;
  }

  async removeTrack(payload = {}) {
    const index = this.resolveTrackRemovalIndex(payload);
    if (index < 0) {
      throw new Error("未找到要移除的队列项");
    }
    const track = this.state.queue[index];
    const wasCurrent = index === Number(this.state.currentIndex ?? -1);
    const wasPlaying = Boolean(this.state.isPlaying);
    await this.cancelTrackPreparation(track);

    this.state.queue.splice(index, 1);
    if (!this.state.queue.length) {
      this.state.currentIndex = -1;
      this.state.isPlaying = false;
      this.state.positionSeconds = 0;
    } else if (wasCurrent) {
      this.state.currentIndex = clamp(index, 0, this.state.queue.length - 1);
      this.state.positionSeconds = 0;
      this.state.positionUpdatedAt = getNowIso();
      this.state.isPlaying = wasPlaying;
    } else if (index < Number(this.state.currentIndex ?? 0)) {
      this.state.currentIndex = Math.max(0, Number(this.state.currentIndex ?? 0) - 1);
    }

    this.state.updatedAt = getNowIso();
    this.state.lastError = "";
    await this.persist();
    this.ensurePreparation();
  }

  async enqueueTrack({ keyword = "", source = DEFAULT_SOURCE, submittedBy = "" } = {}) {
    const trimmedKeyword = String(keyword || "").trim();
    if (!trimmedKeyword) {
      throw new Error("请输入歌名后再提交");
    }
    const candidates = await this.searchCandidates({ keyword: trimmedKeyword, source, limit: 1 });
    const first = candidates[0];
    if (!first) {
      throw new Error("未找到可入队曲目");
    }
    return this.enqueueSelection({ source: first.source || source, candidate: first, submittedBy });
  }

  async searchCandidates({ keyword = "", source = DEFAULT_SOURCE, limit = 8 } = {}) {
    const trimmedKeyword = String(keyword || "").trim();
    const providerKey = MUSIC_SOURCES.includes(String(source || "")) ? String(source) : this.state.source;
    if (!trimmedKeyword) {
      throw new Error("请输入歌名后再搜索");
    }
    if (this.bridge.canHandleSource(providerKey)) {
      const result = await this.bridge.search({ keyword: trimmedKeyword, source: providerKey, limit });
      const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
      return candidates.map((item) => normalizeCandidate(item, providerKey)).filter((item) => item.providerTrackId && item.title);
    }
    const legacy = LEGACY_SEARCH_PROVIDERS[providerKey];
    if (typeof legacy !== "function") {
      throw new Error(`${getSourceLabel(providerKey)} 需要启用 music-lib bridge 后才可搜索`);
    }
    const candidates = await legacy(trimmedKeyword, limit);
    return candidates.map((item) => normalizeCandidate(item, providerKey)).filter((item) => item.providerTrackId && item.title);
  }

  async resolveCandidate({ source = DEFAULT_SOURCE, candidate = null } = {}) {
    const providerKey = MUSIC_SOURCES.includes(String(source || "")) ? String(source) : this.state.source;
    const normalizedCandidate = normalizeCandidate(candidate, providerKey);
    if (!normalizedCandidate.providerTrackId || !normalizedCandidate.title) {
      throw new Error("候选曲目信息不完整，无法入队");
    }
    if (this.bridge.canHandleSource(providerKey)) {
      const result = await this.bridge.resolve({ source: providerKey, candidate: normalizedCandidate });
      return {
        source: providerKey,
        providerTrackId: String(result?.providerTrackId || normalizedCandidate.providerTrackId),
        title: String(result?.title || normalizedCandidate.title),
        artist: String(result?.artist || normalizedCandidate.artist),
        album: String(result?.album || normalizedCandidate.album),
        duration: Number(result?.duration || normalizedCandidate.duration || 0),
        coverUrl: normalizeCoverUrl(result?.coverUrl || normalizedCandidate.coverUrl || ""),
        remoteUrl: normalizeUrl(result?.remoteUrl || ""),
        mimeType: String(result?.mimeType || "audio/mpeg"),
        ext: String(result?.ext || guessExtension(result?.remoteUrl || "", ".mp3") || ".mp3"),
        requestHeaders: {},
        lyrics: String(result?.lyrics || "")
      };
    }
    const legacy = LEGACY_RESOLVE_PROVIDERS[providerKey];
    if (typeof legacy !== "function") {
      throw new Error(`${getSourceLabel(providerKey)} 需要启用 music-lib bridge 后才可解析`);
    }
    return legacy(normalizedCandidate);
  }

  async enqueueSelection({ source = DEFAULT_SOURCE, candidate = null, submittedBy = "" } = {}) {
    const providerKey = MUSIC_SOURCES.includes(String(source || "")) ? String(source) : this.state.source;
    const normalizedCandidate = normalizeCandidate(candidate, providerKey);
    const resolved = await this.resolveCandidate({ source: providerKey, candidate: normalizedCandidate });
    const lyrics = String(resolved.lyrics || "").trim() || await lookupLyrics(resolved);
    const trackId = crypto.randomUUID();
    const ext = String(resolved.ext || guessExtension(resolved.remoteUrl, ".mp3") || ".mp3");
    const titleSegment = sanitizeFileSegment(resolved.title || normalizedCandidate.title || "track", "track");
    const relativePath = path.posix.join(
      ".nas-bot",
      MUSIC_PLAYER_DIR,
      MUSIC_PLAYER_CACHE_DIR,
      `${trackId}-${titleSegment}${ext.startsWith(".") ? ext : `.${ext}`}`
    );
    const track = {
      id: trackId,
      source: providerKey,
      providerTrackId: String(resolved.providerTrackId || ""),
      title: String(resolved.title || normalizedCandidate.title),
      artist: String(resolved.artist || ""),
      album: String(resolved.album || ""),
      duration: Number(resolved.duration || 0),
      coverUrl: normalizeCoverUrl(resolved.coverUrl || ""),
      remoteUrl: normalizeUrl(resolved.remoteUrl || ""),
      mimeType: String(resolved.mimeType || "audio/mpeg"),
      ext,
      requestHeaders: resolved.requestHeaders || {},
      relativePath,
      requestedKeyword: normalizedCandidate.title || "",
      submittedAt: getNowIso(),
      submittedBy: String(submittedBy || ""),
      readyAt: "",
      lyrics,
      status: "queued",
      progress: {
        percent: 0,
        label: "已加入全局播放队列",
        receivedBytes: 0,
        totalBytes: 0
      },
      error: ""
    };
    this.state.queue.push(track);
    if (this.state.currentIndex < 0) {
      this.state.currentIndex = 0;
      this.state.positionSeconds = 0;
      this.state.positionUpdatedAt = getNowIso();
      this.state.isPlaying = true;
    }
    this.state.updatedAt = getNowIso();
    this.state.lastError = "";
    await this.persist();
    this.ensurePreparation();
    return track;
  }

  ensurePreparation() {
    const startIndex = Number(this.state.currentIndex ?? 0);
    const candidates = [];
    for (let offset = 0; offset < PREPARE_AHEAD_COUNT; offset += 1) {
      const index = startIndex + offset;
      if (index < 0 || index >= this.state.queue.length) {
        continue;
      }
      candidates.push(this.state.queue[index]);
    }
    for (const track of candidates) {
      if (!track?.id || this.prepareTasks.has(track.id)) {
        continue;
      }
      if (track.status === "ready" && !(ENABLE_FLAC_CACHE_TRANSCODE && isFlacTrackLike(track))) {
        continue;
      }
      this.prepareTasks.set(track.id, this.prepareTrack(track.id).finally(() => {
        this.prepareTasks.delete(track.id);
      }));
    }
  }

  updateTrack(trackId, updater) {
    const index = this.state.queue.findIndex((item) => String(item?.id || "") === String(trackId || ""));
    if (index < 0) {
      return null;
    }
    const current = this.state.queue[index];
    const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
    this.state.queue[index] = next;
    this.state.updatedAt = getNowIso();
    return next;
  }

  async persist() {
    const payload = JSON.stringify(this.state, null, 2);
    this.persistWrite = this.persistWrite.then(() => fs.promises.writeFile(this.statePath, `${payload}\n`, "utf8"));
    await this.persistWrite;
  }

  async ensurePlayableTrackAsset(trackId = "") {
    const track = this.state.queue.find((item) => String(item?.id || "") === String(trackId || ""));
    if (!track || !ENABLE_FLAC_CACHE_TRANSCODE || !isFlacTrackLike(track)) {
      return track;
    }

    const sourcePath = this.getAbsoluteTrackPath(track);
    const targetRelativePath = replacePathExt(track.relativePath, ".mp3");
    const targetPath = path.join(this.storageRoot, targetRelativePath.split("/").join(path.sep));

    try {
      await fs.promises.access(targetPath, fs.constants.R_OK);
      const nextTrack = this.updateTrack(track.id, (current) => ({
        ...current,
        relativePath: targetRelativePath,
        mimeType: "audio/mpeg",
        ext: ".mp3",
        error: ""
      }));
      await this.persist();
      return nextTrack;
    } catch {
    }

    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    const tempTargetPath = buildTempSiblingPath(targetPath);
    this.updateTrack(track.id, (current) => ({
      ...current,
      status: "buffering",
      progress: {
        percent: null,
        label: "已缓存 FLAC，正在转换为 MP3 兼容文件",
        receivedBytes: Number(current.progress?.receivedBytes || 0),
        totalBytes: Number(current.progress?.totalBytes || 0)
      },
      error: ""
    }));
    await this.persist();

    try {
      await transcodeAudioFileToMp3(sourcePath, tempTargetPath);
      await fs.promises.rename(tempTargetPath, targetPath);
      await fs.promises.rm(sourcePath, { force: true }).catch(() => {});
      const nextTrack = this.updateTrack(track.id, (current) => ({
        ...current,
        relativePath: targetRelativePath,
        mimeType: "audio/mpeg",
        ext: ".mp3",
        status: "ready",
        readyAt: current.readyAt || getNowIso(),
        progress: {
          percent: 100,
          label: "已缓冲并转换为 MP3，可立即播放",
          receivedBytes: Number(current.progress?.receivedBytes || 0),
          totalBytes: Number(current.progress?.totalBytes || 0)
        },
        error: ""
      }));
      await this.persist();
      this.logger("music-cache-transcoded", track.id, sourcePath, targetPath);
      return nextTrack;
    } catch (error) {
      await fs.promises.rm(tempTargetPath, { force: true }).catch(() => {});
      this.updateTrack(track.id, (current) => ({
        ...current,
        status: "ready",
        progress: {
          percent: 100,
          label: "已缓冲完成，保留原始 FLAC",
          receivedBytes: Number(current.progress?.receivedBytes || 0),
          totalBytes: Number(current.progress?.totalBytes || 0)
        },
        error: ""
      }));
      await this.persist();
      this.logger("music-cache-transcode-failed", error?.message || error);
      return this.state.queue.find((item) => String(item?.id || "") === String(trackId || "")) || track;
    }
  }

  async prepareTrack(trackId = "") {
    const track = this.state.queue.find((item) => String(item?.id || "") === String(trackId || ""));
    if (!track) {
      return;
    }
    const absolutePath = this.getAbsoluteTrackPath(track);
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    try {
      await fs.promises.access(absolutePath, fs.constants.R_OK);
      const playableTrack = await this.ensurePlayableTrackAsset(track.id);
      this.updateTrack(track.id, (current) => ({
        ...current,
        status: "ready",
        readyAt: playableTrack?.readyAt || current.readyAt || getNowIso(),
        progress: {
          percent: 100,
          label: playableTrack?.progress?.label || "已缓冲完成，可立即播放",
          receivedBytes: Number(current.progress?.receivedBytes || 0),
          totalBytes: Number(current.progress?.totalBytes || 0)
        },
        error: ""
      }));
      await this.persist();
      this.notifyTrackReady(playableTrack || this.state.queue.find((item) => String(item?.id || "") === String(track.id || "")) || track);
      return;
    } catch {
    }

    this.updateTrack(track.id, (current) => ({
      ...current,
      status: "buffering",
      progress: {
        percent: 0,
        label: "正在下载并缓冲音频",
        receivedBytes: 0,
        totalBytes: 0
      },
      error: ""
    }));
    await this.persist();

    const tempPath = `${absolutePath}.part`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);
    let fileStream = null;
    this.activeDownloads.set(track.id, {
      controller,
      fileStream: null,
      tempPath,
      absolutePath
    });
    try {
      const response = await fetch(track.remoteUrl, {
        headers: {
          "user-agent": MUSIC_USER_AGENT,
          ...track.requestHeaders
        },
        redirect: "follow",
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`音频下载失败: ${response.status} ${response.statusText}`);
      }
      const totalBytes = Number(response.headers.get("content-length") || 0);
      fileStream = fs.createWriteStream(tempPath);
      this.activeDownloads.set(track.id, {
        controller,
        fileStream,
        tempPath,
        absolutePath
      });
      const reader = response.body.getReader();
      let receivedBytes = 0;
      let lastPersistAt = 0;

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (!value?.length) {
          continue;
        }
        receivedBytes += value.length;
        await new Promise((resolve, reject) => {
          fileStream.write(Buffer.from(value), (error) => (error ? reject(error) : resolve()));
        });

        const now = Date.now();
        if (now - lastPersistAt >= 350) {
          lastPersistAt = now;
          this.updateTrack(track.id, (current) => ({
            ...current,
            status: "buffering",
            progress: {
              percent: totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : null,
              label: totalBytes > 0
                ? `正在缓冲 ${Math.round((receivedBytes / totalBytes) * 100)}%`
                : "正在缓冲音频文件",
              receivedBytes,
              totalBytes
            },
            error: ""
          }));
          await this.persist();
        }
      }

      await new Promise((resolve, reject) => fileStream.end((error) => (error ? reject(error) : resolve())));
      await fs.promises.rename(tempPath, absolutePath);
      const playableTrack = await this.ensurePlayableTrackAsset(track.id);
      this.updateTrack(track.id, (current) => ({
        ...current,
        status: "ready",
        readyAt: getNowIso(),
        progress: {
          percent: 100,
          label: playableTrack?.progress?.label || "已缓冲完成，可立即播放",
          receivedBytes: receivedBytes || totalBytes,
          totalBytes: totalBytes || receivedBytes
        },
        error: ""
      }));
      await this.persist();
      this.notifyTrackReady(playableTrack || this.state.queue.find((item) => String(item?.id || "") === String(track.id || "")) || track);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      if (this.cancelledTracks.has(track.id) || !this.hasTrack(track.id)) {
        return;
      }
      this.updateTrack(track.id, (current) => ({
        ...current,
        status: "failed",
        progress: {
          percent: null,
          label: "缓冲失败",
          receivedBytes: Number(current.progress?.receivedBytes || 0),
          totalBytes: Number(current.progress?.totalBytes || 0)
        },
        error: error?.message || "未知错误"
      }));
      this.state.lastError = error?.message || "未知错误";
      await this.persist();
    } finally {
      clearTimeout(timeout);
      this.activeDownloads.delete(track.id);
      this.cancelledTracks.delete(track.id);
      if (fileStream) {
        fileStream.destroy();
      }
    }
  }
}

export function createGlobalMusicPlayer(options = {}) {
  return new GlobalMusicPlayer(options);
}