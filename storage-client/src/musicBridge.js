import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const DEFAULT_BRIDGE_URL = process.env.MUSIC_LIB_BRIDGE_URL || "http://127.0.0.1:46231";
const DEFAULT_HEALTH_TIMEOUT_MS = Number(process.env.MUSIC_LIB_BRIDGE_TIMEOUT_MS || 5000);
const LISTEN1_SUPPORTED_SOURCES = ["qq", "kugou", "kuwo"];

function guessExtensionFromUrl(url = "", fallback = ".mp3") {
  try {
    const parsed = new URL(String(url || "").trim());
    const ext = path.extname(parsed.pathname || "").toLowerCase();
    if (ext && ext.length <= 8) {
      return ext;
    }
  } catch {
  }
  return fallback;
}

function guessMimeTypeFromExtension(ext = "") {
  switch (String(ext || "").toLowerCase()) {
    case ".flac":
      return "audio/flac";
    case ".m4a":
    case ".mp4":
      return "audio/mp4";
    case ".ogg":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    case ".aac":
      return "audio/aac";
    case ".webm":
      return "audio/webm";
    default:
      return "audio/mpeg";
  }
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

function isUsableRemoteUrl(url = "") {
  const value = normalizeUrl(url);
  if (!value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) {
      return false;
    }
    if (!parsed.hostname) {
      return false;
    }
    if (!parsed.pathname || parsed.pathname === "/") {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function toListen1Candidate(track = {}, source = "") {
  const providerTrackId = String(track.id || track.url || "").trim();
  return {
    source: String(track.source || source || "").trim(),
    providerTrackId,
    title: String(track.title || "").trim(),
    artist: String(track.artist || "").trim(),
    album: String(track.album || "").trim(),
    duration: Number(track.duration || 0),
    coverUrl: normalizeUrl(track.img_url || ""),
    link: normalizeUrl(track.source_url || ""),
    ext: "",
    extra: {
      artistId: String(track.artist_id || "").trim(),
      albumId: String(track.album_id || "").trim(),
      url: String(track.url || "").trim(),
      disabled: Boolean(track.disabled)
    }
  };
}

function parseArgs(raw = "") {
  const value = String(raw || "").trim();
  if (!value) {
    return [];
  }
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item));
      }
    } catch {
    }
  }
  return value.split(/\s+/).filter(Boolean);
}

async function fetchJson(url, options = {}, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "content-type": "application/json",
        ...(options.headers || {})
      },
      body: options.body,
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

export class MusicLibBridgeClient {
  constructor(options = {}) {
    this.require = createRequire(import.meta.url);
    this.url = String(options.url || DEFAULT_BRIDGE_URL).replace(/\/+$/, "");
    this.spawnProcess = typeof options.spawnProcess === "function" ? options.spawnProcess : null;
    this.logger = typeof options.logger === "function" ? options.logger : () => {};
    this.bin = String(options.bin ?? process.env.MUSIC_LIB_BRIDGE_BIN ?? "").trim();
    this.args = Array.isArray(options.args)
      ? options.args.map((item) => String(item))
      : parseArgs(options.args ?? process.env.MUSIC_LIB_BRIDGE_ARGS ?? "");
    this.autoStart = options.autoStart ?? process.env.MUSIC_LIB_BRIDGE_AUTO_START !== "0";
    this.timeoutMs = Number(options.timeoutMs || DEFAULT_HEALTH_TIMEOUT_MS);
    this.process = null;
    this.availableSources = [];
    this.ready = false;
    this.listen1Enabled = options.listen1Enabled ?? process.env.MUSIC_LISTEN1_API_ENABLED === "1";
    this.listen1Api = null;
    this.listen1Ready = false;
    this.listen1Initialized = false;

    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    this.workDir = path.resolve(options.workDir || process.env.MUSIC_LIB_BRIDGE_WORKDIR || path.join(currentDir, "..", "..", "music-lib-bridge"));
    this.listen1WorkDir = path.resolve(options.listen1WorkDir || process.env.MUSIC_LISTEN1_API_WORKDIR || path.join(currentDir, "..", "..", "listen1-api"));
    this.listen1DistPath = path.resolve(options.listen1DistPath || process.env.MUSIC_LISTEN1_API_DIST || path.join(this.listen1WorkDir, "dist", "listen1-api.js"));
  }

  async init() {
    this.initListen1();
    await this.ensureReady({ allowStart: true, throwOnFailure: false });
  }

  getSources() {
    return [...new Set([...LISTEN1_SUPPORTED_SOURCES.filter((source) => this.canUseListen1(source)), ...this.availableSources])];
  }

  canHandleSource(source = "") {
    const providerKey = String(source || "").trim();
    return this.canUseListen1(providerKey) || this.availableSources.includes(providerKey);
  }

  async health() {
    this.initListen1();
    let payload = null;
    try {
      payload = await fetchJson(`${this.url}/health`, {}, this.timeoutMs);
      this.availableSources = Array.isArray(payload?.sources)
        ? payload.sources.map((item) => String(item)).filter(Boolean)
        : [];
      this.ready = Boolean(payload?.ok);
    } catch (error) {
      this.availableSources = [];
      this.ready = false;
      if (!this.listen1Ready) {
        throw error;
      }
    }
    return {
      ok: this.ready || this.listen1Ready,
      sources: this.getSources(),
      version: String(payload?.version || (this.listen1Ready ? "listen1-api" : ""))
    };
  }

  initListen1() {
    if (this.listen1Initialized) {
      return;
    }
    this.listen1Initialized = true;
    if (!this.listen1Enabled) {
      return;
    }
    if (!fs.existsSync(this.listen1DistPath)) {
      this.logger("listen1-missing", this.listen1DistPath);
      return;
    }
    try {
      const loaded = this.require(this.listen1DistPath);
      const api = loaded?.default && typeof loaded.default.apiGet === "function"
        ? loaded.default
        : loaded;
      if (!api || typeof api.apiGet !== "function") {
        throw new Error("listen1-api 导出无效");
      }
      if (typeof api.loadNodejsDefaults === "function") {
        api.loadNodejsDefaults();
      }
      this.listen1Api = api;
      this.listen1Ready = true;
      this.logger("listen1-ready", this.listen1DistPath);
    } catch (error) {
      this.listen1Api = null;
      this.listen1Ready = false;
      this.logger("listen1-load-failed", error?.message || error);
    }
  }

  canUseListen1(source = "") {
    return this.listen1Ready && LISTEN1_SUPPORTED_SOURCES.includes(String(source || "").trim());
  }

  async searchWithListen1({ keyword = "", source = "", limit = 8 } = {}) {
    if (!this.canUseListen1(source)) {
      throw new Error(`listen1-api 不支持来源: ${source}`);
    }
    const query = new URLSearchParams({
      source: String(source || "").trim(),
      keywords: String(keyword || "").trim(),
      curpage: "1"
    });
    const payload = await this.listen1Api.apiGet(`/search?${query.toString()}`);
    const candidates = Array.isArray(payload?.result)
      ? payload.result
        .filter((item) => !item?.disabled)
        .map((item) => toListen1Candidate(item, source))
        .filter((item) => item.providerTrackId)
        .slice(0, Math.max(1, Number(limit || 8)))
      : [];
    if (!candidates.length) {
      throw new Error(`listen1-api 未返回可用搜索结果: ${source}`);
    }
    return {
      source: String(source || "").trim(),
      candidates
    };
  }

  async resolveWithListen1({ source = "", candidate = null } = {}) {
    if (!this.canUseListen1(source)) {
      throw new Error(`listen1-api 不支持来源: ${source}`);
    }
    const providerTrackId = String(candidate?.providerTrackId || candidate?.id || "").trim();
    if (!providerTrackId) {
      throw new Error("缺少 providerTrackId，无法解析 listen1 曲目");
    }
    const payload = await this.listen1Api.apiGet(`/bootstrap_track?track_id=${encodeURIComponent(providerTrackId)}`);
    const remoteUrl = normalizeUrl(payload?.url || "");
    if (!isUsableRemoteUrl(remoteUrl)) {
      throw new Error("listen1-api 未返回可播放地址");
    }
    let lyrics = "";
    try {
      const lyricPayload = await this.listen1Api.apiGet(`/lyric?track_id=${encodeURIComponent(providerTrackId)}`);
      lyrics = String(lyricPayload?.lyric || "").trim();
    } catch {
      lyrics = "";
    }
    const ext = guessExtensionFromUrl(remoteUrl, String(candidate?.ext || "").trim() || ".mp3");
    return {
      source: String(source || "").trim(),
      providerTrackId,
      title: String(candidate?.title || "").trim(),
      artist: String(candidate?.artist || "").trim(),
      album: String(candidate?.album || "").trim(),
      duration: Number(candidate?.duration || 0),
      coverUrl: normalizeUrl(candidate?.coverUrl || ""),
      remoteUrl,
      mimeType: guessMimeTypeFromExtension(ext),
      ext,
      lyrics
    };
  }

  async ensureReady({ allowStart = true, throwOnFailure = true } = {}) {
    try {
      return await this.health();
    } catch (error) {
      this.ready = false;
      this.logger("bridge-health-failed", error?.message || error);
      if (allowStart && this.autoStart) {
        await this.startProcess();
        try {
          return await this.waitForReady();
        } catch (secondError) {
          this.ready = false;
          this.logger("bridge-start-failed", secondError?.message || secondError);
          if (throwOnFailure) {
            throw secondError;
          }
          return { ok: false, sources: [] };
        }
      }
      if (throwOnFailure) {
        throw error;
      }
      return { ok: false, sources: [] };
    }
  }

  async startProcess() {
    if (!this.spawnProcess || !this.bin || this.process) {
      return;
    }
    this.logger("bridge-start", `${this.bin} ${this.args.join(" ")}`.trim());
    this.process = this.spawnProcess(this.bin, this.args, {
      cwd: this.workDir,
      env: {
        ...process.env,
        MUSIC_LIB_BRIDGE_ADDR: this.url.replace(/^https?:\/\//, "")
      },
      stdio: ["ignore", "pipe", "pipe"]
    }, {
      kind: "music-bridge",
      context: "music-lib-bridge"
    });
    this.process.on("exit", () => {
      this.process = null;
      this.ready = false;
    });
  }

  async waitForReady() {
    const deadline = Date.now() + Math.max(6000, this.timeoutMs * 3);
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        return await this.health();
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
    }
    throw lastError || new Error("music-lib bridge 启动超时");
  }

  async search({ keyword = "", source = "", limit = 8 } = {}) {
    let listen1Error = null;
    if (this.canUseListen1(source)) {
      try {
        return await this.searchWithListen1({ keyword, source, limit });
      } catch (error) {
        listen1Error = error;
        this.logger("listen1-search-failed", error?.message || error);
      }
    }
    try {
      await this.ensureReady({ allowStart: true, throwOnFailure: true });
      return await fetchJson(`${this.url}/search`, {
        method: "POST",
        body: JSON.stringify({ keyword, source, limit })
      }, Math.max(12_000, this.timeoutMs));
    } catch (error) {
      if (listen1Error) {
        throw listen1Error;
      }
      throw error;
    }
  }

  async resolve({ source = "", candidate = null } = {}) {
    let listen1Error = null;
    if (this.canUseListen1(source)) {
      try {
        return await this.resolveWithListen1({ source, candidate });
      } catch (error) {
        listen1Error = error;
        this.logger("listen1-resolve-failed", error?.message || error);
      }
    }
    try {
      await this.ensureReady({ allowStart: true, throwOnFailure: true });
      return await fetchJson(`${this.url}/resolve`, {
        method: "POST",
        body: JSON.stringify({ source, candidate })
      }, Math.max(12_000, this.timeoutMs));
    } catch (error) {
      if (listen1Error) {
        throw listen1Error;
      }
      throw error;
    }
  }
}

export function createMusicLibBridgeClient(options = {}) {
  return new MusicLibBridgeClient(options);
}