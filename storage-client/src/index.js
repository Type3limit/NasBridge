import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import mime from "mime-types";
import WebSocket from "ws";
import wrtcPkg from "@roamhq/wrtc";
import { scanFiles, safeJoin } from "./fsIndex.js";

const wrtc = wrtcPkg?.default ?? wrtcPkg;
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc;

const serverBaseUrl = process.env.SERVER_BASE_URL;
const registrationKey = process.env.REGISTRATION_KEY;
const clientName = process.env.CLIENT_NAME ?? `Storage-${Math.random().toString(16).slice(2, 8)}`;
const storageRoot = process.env.STORAGE_ROOT;
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH || (() => {
  const normalized = String(ffmpegPath || "ffmpeg");
  if (!/[\\/]/.test(normalized)) {
    return "ffprobe";
  }
  const dir = path.dirname(normalized);
  const ext = path.extname(normalized);
  const base = path.basename(normalized, ext).toLowerCase();
  if (base === "ffmpeg") {
    return path.join(dir, `ffprobe${ext}`);
  }
  return "ffprobe";
})();
const enableTranscode = process.env.ENABLE_TRANSCODE !== "0";
const previewCacheDirName = process.env.PREVIEW_CACHE_DIR_NAME || ".nas-preview-cache";
const hlsCacheDirName = process.env.HLS_CACHE_DIR_NAME || ".nas-hls-cache";
const transcodeVideoCodec = process.env.TRANSCODE_VIDEO_CODEC || "auto";
const hlsVideoCodec = process.env.HLS_VIDEO_CODEC || "auto";
const transcodePreferGpu = process.env.TRANSCODE_PREFER_GPU !== "0";
const hlsNvencPreset = process.env.HLS_NVENC_PRESET || "p2";
const hlsNvencUseCudaPipeline = process.env.HLS_NVENC_USE_CUDA_PIPELINE === "1";
const wsReconnectDelayMs = Number(process.env.WS_RECONNECT_DELAY_MS || 3000);
const wsIdleTimeoutMs = Number(process.env.WS_IDLE_TIMEOUT_MS || 90_000);
const wsWatchdogIntervalMs = Number(process.env.WS_WATCHDOG_INTERVAL_MS || 10_000);
const uploadStaleTimeoutMs = Number(process.env.UPLOAD_STALE_TIMEOUT_MS || 300_000);
const peerCleanupDelayMs = Number(process.env.PEER_CLEANUP_DELAY_MS || 30_000);
const previewCacheMaxAgeMs = Number(process.env.PREVIEW_CACHE_MAX_AGE_MS || 86_400_000);
const hlsCacheMaxAgeMs = Number(process.env.HLS_CACHE_MAX_AGE_MS || 86_400_000);
const cacheCleanupIntervalMs = Number(process.env.CACHE_CLEANUP_INTERVAL_MS || 3_600_000);
const previewObservabilityEnabled = process.env.PREVIEW_OBSERVABILITY === "1";
const previewObservabilityIntervalMs = Number(process.env.PREVIEW_OBSERVABILITY_INTERVAL_MS || 15_000);
const previewObservabilitySampleCache = process.env.PREVIEW_OBSERVABILITY_SAMPLE_CACHE !== "0";
const assetFingerprintSampleBytes = Number(process.env.ASSET_FINGERPRINT_SAMPLE_BYTES || 262_144);
const assetFingerprintWholeFileThresholdBytes = Number(process.env.ASSET_FINGERPRINT_WHOLE_FILE_THRESHOLD_BYTES || 1_048_576);
const assetFingerprintCacheLimit = Number(process.env.ASSET_FINGERPRINT_CACHE_LIMIT || 512);
const allowGpuHlsEncoding = process.env.ALLOW_GPU_HLS_ENCODING !== "0";
const disabledEncoderCooldownMs = Number(process.env.DISABLED_ENCODER_COOLDOWN_MS || 900_000);

function buildIceServers() {
  const servers = [];

  // Normalise URLs: auto-prepend scheme if the user omitted it in .env
  const normaliseStun = (u) => (u && !u.includes(":") ? `stun:${u}` : u);
  const normaliseTurn = (u) => (u && !/^turns?:/.test(u) ? `turn:${u}` : u);

  if (process.env.STUN_URL) {
    servers.push({ urls: [normaliseStun(process.env.STUN_URL)] });
  }
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({
      urls: [normaliseTurn(process.env.TURN_URL)],
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  if (!servers.length) {
    servers.push({ urls: ["stun:stun.l.google.com:19302"] });
  }
  return servers;
}

const iceServers = buildIceServers();
logInfo("[rtc] iceServers configured:", JSON.stringify(iceServers.map((s) => s.urls)));

if (!serverBaseUrl || !registrationKey || !storageRoot) {
  throw new Error("SERVER_BASE_URL, REGISTRATION_KEY and STORAGE_ROOT are required");
}

const state = {
  token: process.env.CLIENT_TOKEN || "",
  clientId: "",
  ws: null,
  wsReconnectTimer: null,
  wsLastMessageAt: 0,
  wsReady: false,
  wsConnecting: false,
  peers: new Map(),
  uploads: new Map(),
  previewJobs: new Map(),
  hlsJobs: new Map(),
  hlsIndex: new Map(),
  activeMediaProcesses: new Map(),
  assetFingerprints: new Map(),
  ffmpegEncoderSupport: null,
  disabledEncoders: new Map()
};

const debug = process.env.P2P_DEBUG === "1";

function log(...args) {
  if (debug) {
    console.log("[storage-client]", ...args);
  }
}

function logInfo(...args) {
  console.log("[storage-client]", ...args);
}

function logWarn(...args) {
  console.warn("[storage-client]", ...args);
}

function logError(...args) {
  console.error("[storage-client]", ...args);
}

async function getAvailableFfmpegEncoders() {
  if (state.ffmpegEncoderSupport) {
    return state.ffmpegEncoderSupport;
  }

  const encoders = await new Promise((resolve) => {
    const proc = spawnObservedProcess(ffmpegPath, ["-hide_banner", "-encoders"], { stdio: ["ignore", "pipe", "pipe"] }, { kind: "ffmpeg", context: "list-encoders" });
    let output = "";
    proc.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.on("error", () => resolve(new Set(["libx264"])));
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(new Set(["libx264"]));
        return;
      }
      const found = new Set();
      for (const line of output.split(/\r?\n/)) {
        const match = /^\s*[A-Z\.]{6}\s+([A-Za-z0-9_]+)/.exec(line);
        if (match?.[1]) {
          found.add(match[1]);
        }
      }
      found.add("libx264");
      resolve(found);
    });
  });

  state.ffmpegEncoderSupport = encoders;
  logInfo("[ffmpeg] encoders", JSON.stringify({
    allowGpuHlsEncoding,
    hlsVideoCodec,
    transcodeVideoCodec,
    hlsNvencPreset,
    ffmpegPath,
    ffprobePath,
    hlsNvencUseCudaPipeline,
    available: [...encoders].filter((name) => ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"].includes(name))
  }));
  return encoders;
}

function shouldDisableCodecForRuntime(error) {
  const text = String(error?.message || error || "");
  return /No device|Device creation failed|Error while opening encoder|init_hw_device|open encode device|No NVENC capable devices found|Cannot load nvcuda|MFX_ERR_UNSUPPORTED|unsupported device|device type cuda needed for codec|Failed to initialise hardware|Failed to create.*device/i.test(text);
}

function disableCodec(codec, context, reason) {
  if (!codec || codec === "libx264") {
    return;
  }
  const key = `${context}:${codec}`;
  state.disabledEncoders.set(key, {
    codec,
    context,
    reason: String(reason || "runtime-failure"),
    disabledAt: Date.now(),
    expiresAt: Date.now() + Math.max(60_000, disabledEncoderCooldownMs)
  });
  logWarn("ffmpeg-codec-disabled", context, codec, JSON.stringify({ reason, cooldownMs: Math.max(60_000, disabledEncoderCooldownMs) }));
}

function getCodecDisableRecord(codec, context) {
  const key = `${context}:${codec}`;
  const record = state.disabledEncoders.get(key);
  if (!record) {
    return null;
  }
  if (record.expiresAt && record.expiresAt <= Date.now()) {
    state.disabledEncoders.delete(key);
    logInfo("ffmpeg-codec-reenabled", context, codec);
    return null;
  }
  return record;
}

function getCodecCooldownSnapshot(context) {
  return ["h264_nvenc", "h264_qsv", "h264_amf"]
    .map((codec) => {
      const record = getCodecDisableRecord(codec, context);
      if (!record) {
        return null;
      }
      return {
        codec,
        reason: record.reason,
        remainingMs: Math.max(0, Number(record.expiresAt || 0) - Date.now())
      };
    })
    .filter(Boolean);
}

function toMiB(bytes) {
  return Number((Number(bytes || 0) / (1024 * 1024)).toFixed(1));
}

function summarizePathForLog(targetPath) {
  if (!targetPath) {
    return "";
  }
  try {
    const relative = path.relative(storageRoot, targetPath);
    if (relative && !relative.startsWith("..")) {
      return relative.replace(/\\/g, "/");
    }
  } catch {
  }
  return path.basename(targetPath);
}

function classifyResourcePressure(snapshot) {
  const candidates = [
    { source: "node", bytes: Number(snapshot?.node?.rssBytes || 0) },
    { source: "ffmpeg", bytes: Number(snapshot?.children?.totalRssBytes || 0) },
    { source: "disk-cache", bytes: Number(snapshot?.caches?.totalBytes || 0) }
  ].sort((left, right) => right.bytes - left.bytes);
  return candidates[0]?.source || "unknown";
}

async function getProcessRssBytes(pid) {
  if (!pid || pid <= 0) {
    return 0;
  }
  try {
    if (process.platform === "win32") {
      return await new Promise((resolve) => {
        const proc = spawn("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        proc.stdout.on("data", (chunk) => {
          out += chunk.toString();
        });
        proc.on("error", () => resolve(0));
        proc.on("close", () => {
          const line = out.trim().split(/\r?\n/).find(Boolean);
          if (!line || /No tasks are running/i.test(line)) {
            resolve(0);
            return;
          }
          const cells = line.replace(/^"|"$/g, "").split('","');
          const memoryText = cells[4] || "0 K";
          const parsed = Number.parseInt(memoryText.replace(/[^\d]/g, ""), 10);
          resolve(Number.isFinite(parsed) ? parsed * 1024 : 0);
        });
      });
    }

    return await new Promise((resolve) => {
      const proc = spawn("ps", ["-o", "rss=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      proc.stdout.on("data", (chunk) => {
        out += chunk.toString();
      });
      proc.on("error", () => resolve(0));
      proc.on("close", () => {
        const parsed = Number.parseInt((out || "").trim(), 10);
        resolve(Number.isFinite(parsed) ? parsed * 1024 : 0);
      });
    });
  } catch {
    return 0;
  }
}

async function getDirectoryStats(rootDir) {
  const stats = { exists: false, files: 0, directories: 0, bytes: 0 };
  try {
    const rootStat = await fs.promises.stat(rootDir);
    if (!rootStat.isDirectory()) {
      return stats;
    }
    stats.exists = true;
  } catch {
    return stats;
  }

  const stack = [rootDir];
  while (stack.length) {
    const currentDir = stack.pop();
    let entries = [];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stats.directories += 1;
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      stats.files += 1;
      try {
        const entryStat = await fs.promises.stat(entryPath);
        stats.bytes += Number(entryStat.size || 0);
      } catch {
      }
    }
  }

  return stats;
}

function trimFingerprintCache() {
  while (state.assetFingerprints.size > assetFingerprintCacheLimit) {
    const oldestKey = state.assetFingerprints.keys().next().value;
    if (!oldestKey) {
      break;
    }
    state.assetFingerprints.delete(oldestKey);
  }
}

async function readFileSample(fileHandle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fileHandle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function buildStableAssetCacheKey(inputFile, stat, suffix = "") {
  const cacheEntryKey = `${inputFile}|${stat.size}|${stat.mtimeMs}|${suffix}`;
  const cached = state.assetFingerprints.get(cacheEntryKey);
  if (cached) {
    return cached;
  }

  const hash = crypto.createHash("sha1");
  hash.update(`size:${stat.size}|suffix:${suffix}|`);

  if (stat.size <= assetFingerprintWholeFileThresholdBytes) {
    const content = await fs.promises.readFile(inputFile);
    hash.update(content);
  } else {
    const sampleSize = Math.max(4_096, Math.min(assetFingerprintSampleBytes, stat.size));
    const midpoint = Math.max(0, Math.floor((stat.size - sampleSize) / 2));
    const tail = Math.max(0, stat.size - sampleSize);
    const positions = [...new Set([0, midpoint, tail])];
    const fileHandle = await fs.promises.open(inputFile, "r");
    try {
      for (const position of positions) {
        const sample = await readFileSample(fileHandle, position, sampleSize);
        hash.update(`@${position}:`);
        hash.update(sample);
      }
    } finally {
      await fileHandle.close();
    }
  }

  const digest = hash.digest("hex");
  state.assetFingerprints.set(cacheEntryKey, digest);
  trimFingerprintCache();
  return digest;
}

function trackMediaProcess(proc, meta = {}) {
  if (!previewObservabilityEnabled || !proc?.pid) {
    return proc;
  }
  const startedAt = Date.now();
  const record = {
    pid: proc.pid,
    kind: meta.kind || "child",
    context: meta.context || "",
    requestId: meta.requestId || "",
    path: meta.path ? summarizePathForLog(meta.path) : "",
    channel: meta.channel || "",
    startedAt
  };
  state.activeMediaProcesses.set(proc.pid, record);
  logInfo("[observe]", JSON.stringify({
    event: "child-start",
    pid: proc.pid,
    kind: record.kind,
    context: record.context,
    requestId: record.requestId,
    path: record.path,
    activeChildren: state.activeMediaProcesses.size
  }));

  const finish = (status, detail = "") => {
    if (!state.activeMediaProcesses.has(proc.pid)) {
      return;
    }
    state.activeMediaProcesses.delete(proc.pid);
    logInfo("[observe]", JSON.stringify({
      event: "child-end",
      pid: proc.pid,
      kind: record.kind,
      context: record.context,
      requestId: record.requestId,
      status,
      detail,
      runtimeMs: Date.now() - startedAt,
      activeChildren: state.activeMediaProcesses.size
    }));
  };

  proc.once("error", (error) => finish("error", error?.message || String(error)));
  proc.once("close", (code, signal) => finish(code === 0 ? "ok" : "exit", signal || String(code ?? "")));
  return proc;
}

function spawnObservedProcess(command, args, options, meta = {}) {
  const proc = spawn(command, args, options);
  return trackMediaProcess(proc, { ...meta, command });
}

async function collectObservabilitySnapshot() {
  const nodeMemory = process.memoryUsage();
  const childEntries = await Promise.all(
    [...state.activeMediaProcesses.values()].map(async (entry) => ({
      ...entry,
      rssBytes: await getProcessRssBytes(entry.pid),
      runtimeMs: Date.now() - entry.startedAt
    }))
  );

  const childrenByKind = childEntries.reduce((acc, entry) => {
    const key = entry.kind || "child";
    const existing = acc[key] || { count: 0, rssBytes: 0 };
    existing.count += 1;
    existing.rssBytes += Number(entry.rssBytes || 0);
    acc[key] = existing;
    return acc;
  }, {});

  const caches = previewObservabilitySampleCache
    ? await Promise.all([
      getDirectoryStats(path.join(storageRoot, previewCacheDirName)),
      getDirectoryStats(path.join(storageRoot, hlsCacheDirName))
    ])
    : [{ exists: false, files: 0, directories: 0, bytes: 0 }, { exists: false, files: 0, directories: 0, bytes: 0 }];

  const snapshot = {
    node: {
      pid: process.pid,
      rssBytes: Number(nodeMemory.rss || 0),
      heapUsedBytes: Number(nodeMemory.heapUsed || 0),
      heapTotalBytes: Number(nodeMemory.heapTotal || 0),
      externalBytes: Number(nodeMemory.external || 0),
      arrayBuffersBytes: Number(nodeMemory.arrayBuffers || 0),
      rssMiB: toMiB(nodeMemory.rss),
      heapUsedMiB: toMiB(nodeMemory.heapUsed),
      externalMiB: toMiB(nodeMemory.external),
      arrayBuffersMiB: toMiB(nodeMemory.arrayBuffers)
    },
    children: {
      count: childEntries.length,
      totalRssBytes: childEntries.reduce((sum, entry) => sum + Number(entry.rssBytes || 0), 0),
      totalRssMiB: toMiB(childEntries.reduce((sum, entry) => sum + Number(entry.rssBytes || 0), 0)),
      byKind: Object.fromEntries(Object.entries(childrenByKind).map(([key, value]) => [key, { ...value, rssMiB: toMiB(value.rssBytes) }])),
      active: childEntries.map((entry) => ({
        pid: entry.pid,
        kind: entry.kind,
        context: entry.context,
        requestId: entry.requestId,
        path: entry.path,
        runtimeMs: entry.runtimeMs,
        rssMiB: toMiB(entry.rssBytes)
      }))
    },
    caches: {
      preview: { ...caches[0], sizeMiB: toMiB(caches[0].bytes) },
      hls: { ...caches[1], sizeMiB: toMiB(caches[1].bytes) },
      totalBytes: Number(caches[0].bytes || 0) + Number(caches[1].bytes || 0),
      totalMiB: toMiB(Number(caches[0].bytes || 0) + Number(caches[1].bytes || 0))
    },
    runtime: {
      peers: state.peers.size,
      uploads: state.uploads.size,
      previewJobs: state.previewJobs.size,
      hlsJobs: state.hlsJobs.size,
      hlsIndex: state.hlsIndex.size
    }
  };

  snapshot.suspect = classifyResourcePressure(snapshot);
  return snapshot;
}

async function emitObservabilitySnapshot(event, context = {}) {
  if (!previewObservabilityEnabled) {
    return;
  }
  try {
    const snapshot = await collectObservabilitySnapshot();
    logInfo("[observe]", JSON.stringify({
      event,
      ts: new Date().toISOString(),
      suspect: snapshot.suspect,
      context,
      node: snapshot.node,
      children: snapshot.children,
      caches: snapshot.caches,
      runtime: snapshot.runtime
    }));
  } catch (error) {
    logWarn("observability-snapshot-failed", event, error?.message || error);
  }
}

async function cleanupExpiredCacheEntries() {
  const now = Date.now();

  async function removeExpiredChildren(rootDir, maxAgeMs, recursive = false) {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      return;
    }

    let entries = [];
    try {
      entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        logWarn("cache-read-failed", rootDir, error.message || error);
      }
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(rootDir, entry.name);
      try {
        const stat = await fs.promises.stat(entryPath);
        const lastTouchedAt = Math.max(stat.mtimeMs || 0, stat.atimeMs || 0, stat.ctimeMs || 0);
        if (now - lastTouchedAt <= maxAgeMs) {
          continue;
        }
        await fs.promises.rm(entryPath, { recursive: recursive || entry.isDirectory(), force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          logWarn("cache-cleanup-failed", entryPath, error.message || error);
        }
      }
    }
  }

  await removeExpiredChildren(path.join(storageRoot, previewCacheDirName), previewCacheMaxAgeMs, false);
  await removeExpiredChildren(path.join(storageRoot, hlsCacheDirName), hlsCacheMaxAgeMs, true);

  for (const [hlsId, entry] of state.hlsIndex.entries()) {
    if (!entry?.updatedAt || now - entry.updatedAt > hlsCacheMaxAgeMs) {
      state.hlsIndex.delete(hlsId);
    }
  }
}

async function getCodecCandidates(context = "") {
  const preferred = String((context === "hls-720p" ? hlsVideoCodec : transcodeVideoCodec) || "auto").trim().toLowerCase();
  const availableEncoders = await getAvailableFfmpegEncoders();
  const preferredGpuAllowed = context === "hls-720p" ? allowGpuHlsEncoding : transcodePreferGpu;
  const isCodecUsable = (codec) => availableEncoders.has(codec) && !getCodecDisableRecord(codec, context);

  if (preferred && preferred !== "auto") {
    const requested = preferred === "libx264" ? ["libx264"] : [preferred, "libx264"];
    return requested.filter((codec, index, list) => isCodecUsable(codec) && list.indexOf(codec) === index);
  }

  if (!preferredGpuAllowed) {
    return ["libx264"];
  }

  return ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"].filter((codec) => isCodecUsable(codec));
}

function buildCodecArgs(codec, quality = "preview") {
  const isFull = quality === "full";
  const isHls = quality === "hls";
  if (codec === "h264_nvenc") {
    const targetBitrate = isHls ? "2200k" : "1800k";
    const maxrate = isHls ? "3000k" : "2200k";
    const bufsize = isHls ? "6000k" : "4400k";
    return [
      "-c:v",
      "h264_nvenc",
      "-preset",
      isHls ? hlsNvencPreset : "p4",
      "-rc",
      "vbr",
      "-b:v",
      targetBitrate,
      "-maxrate",
      maxrate,
      "-bufsize",
      bufsize
    ];
  }
  if (codec === "h264_qsv") {
    return [
      "-c:v",
      "h264_qsv",
      "-global_quality",
      isFull ? "23" : "28",
      "-look_ahead",
      "0",
      "-b:v",
      isHls ? "2200k" : "1800k"
    ];
  }
  if (codec === "h264_amf") {
    return [
      "-c:v",
      "h264_amf",
      "-quality",
      "quality",
      "-rc",
      "cqp",
      "-qp_i",
      isFull ? "23" : "28",
      "-qp_p",
      isFull ? "25" : "30"
    ];
  }
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-threads",
    "4",
    "-crf",
    isFull ? "23" : "28"
  ];
}

// Returns { codec, width, height, level } for the first video stream, or null on error.
async function probeVideoStream(inputFile) {
  try {
    const args = [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,level",
      "-of", "json",
      inputFile
    ];
    return await new Promise((resolve) => {
      const proc = spawnObservedProcess(ffprobePath, args, { stdio: ["ignore", "pipe", "ignore"] }, { kind: "ffprobe", context: "probe-video-stream", path: inputFile });
      let out = "";
      proc.stdout.on("data", (chunk) => { out += chunk.toString(); });
      proc.on("error", () => resolve(null));
      proc.on("close", (code) => {
        if (code !== 0) { resolve(null); return; }
        try {
          const stream = JSON.parse(out)?.streams?.[0];
          if (!stream) { resolve(null); return; }
          resolve({
            codec: stream.codec_name || "",
            width: Number(stream.width) || 0,
            height: Number(stream.height) || 0,
            level: Number(stream.level) || 0
          });
        } catch { resolve(null); }
      });
    });
  } catch {
    return null;
  }
}

async function runFfmpegWithCodecFallback(makeArgs, { context = "transcode", onProgress, onCodecSelected, sourcePath = "", requestId = "", channel = "" } = {}) {
  const candidates = await getCodecCandidates(context);
  logInfo("[ffmpeg] codec-candidates", JSON.stringify({ context, candidates }));
  let lastError = null;
  for (const codec of candidates) {
    const args = makeArgs(codec);
    try {
      await new Promise((resolve, reject) => {
        const proc = spawnObservedProcess(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] }, { kind: "ffmpeg", context, path: sourcePath, requestId, channel });
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          const text = chunk.toString();
          stderr += text;
          onProgress?.(text);
        });
        proc.on("error", (error) => reject(new Error(`ffmpeg launch failed: ${error.message}`)));
        proc.on("close", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`ffmpeg ${context} failed with code ${code}: ${stderr.slice(-400)}`));
          }
        });
      });
      log("ffmpeg-codec", context, codec);
      onCodecSelected?.(codec);
      return codec;
    } catch (error) {
      lastError = error;
      if (shouldDisableCodecForRuntime(error)) {
        disableCodec(codec, context, error?.message || error);
      }
      logWarn("ffmpeg-codec-failed", context, codec, error?.message || error);
    }
  }
  throw lastError || new Error(`ffmpeg ${context} failed`);
}

async function getMediaDurationSeconds(inputFile, context = "probe-duration") {
  try {
    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputFile
    ];
    return await new Promise((resolve) => {
      const proc = spawnObservedProcess(ffprobePath, args, { stdio: ["ignore", "pipe", "ignore"] }, { kind: "ffprobe", context, path: inputFile });
      let out = "";
      proc.stdout.on("data", (chunk) => {
        out += chunk.toString();
      });
      proc.on("error", () => resolve(0));
      proc.on("close", () => {
        const parsed = Number.parseFloat((out || "").trim());
        resolve(Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
      });
    });
  } catch {
    return 0;
  }
}

function extractProgressFromFfmpegLog(text, durationSeconds) {
  if (!(durationSeconds > 0)) {
    return null;
  }
  const match = /time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text || "");
  if (!match) {
    return null;
  }
  const currentSeconds = Number.parseInt(match[1], 10) * 3600 + Number.parseInt(match[2], 10) * 60 + Number.parseFloat(match[3]);
  if (!Number.isFinite(currentSeconds)) {
    return null;
  }
  return Math.max(1, Math.min(99, Math.round((currentSeconds / durationSeconds) * 100)));
}

async function transcodeToMp4(inputFile, onProgress) {
  const getDurationSeconds = async () => {
    try {
      const args = [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        inputFile
      ];
      return await new Promise((resolve) => {
        const proc = spawnObservedProcess(ffprobePath, args, { stdio: ["ignore", "pipe", "ignore"] }, { kind: "ffprobe", context: "probe-duration", path: inputFile });
        let out = "";
        proc.stdout.on("data", (chunk) => {
          out += chunk.toString();
        });
        proc.on("error", () => resolve(0));
        proc.on("close", () => {
          const parsed = Number.parseFloat((out || "").trim());
          if (Number.isFinite(parsed) && parsed > 0) {
            resolve(parsed);
          } else {
            resolve(0);
          }
        });
      });
    } catch {
      return 0;
    }
  };

  const durationSeconds = await getDurationSeconds();
  onProgress?.({ stage: "preparing", progress: 0, message: "正在分析视频" });

  const tempDir = path.join(os.tmpdir(), "nas-bridge-transcode");
  await fs.promises.mkdir(tempDir, { recursive: true });
  const outputFile = path.join(tempDir, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.mp4`);

  let selectedCodec = "";
  await runFfmpegWithCodecFallback(
    (codec) => {
      const codecArgs = buildCodecArgs(codec, "full");
      return [
        "-y",
        "-i",
        inputFile,
        "-movflags",
        "+faststart",
        "-pix_fmt",
        "yuv420p",
        ...codecArgs,
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        outputFile
      ];
    },
    {
      context: "preview-transcode",
      sourcePath: inputFile,
      onCodecSelected: (codec) => {
        selectedCodec = codec;
      },
      onProgress: (text) => {
        onProgress?.({ stage: "transcoding", progress: durationSeconds ? 5 : null, message: "正在转码" });
        if (durationSeconds > 0) {
          const match = /time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
          if (match) {
            const hours = Number.parseInt(match[1], 10);
            const minutes = Number.parseInt(match[2], 10);
            const seconds = Number.parseFloat(match[3]);
            const currentSeconds = hours * 3600 + minutes * 60 + seconds;
            const progress = Math.max(0, Math.min(99, Math.round((currentSeconds / durationSeconds) * 100)));
            onProgress?.({ stage: "transcoding", progress, message: `正在转码 ${progress}%` });
          }
        }
      }
    }
  );

  onProgress?.({ stage: "done", progress: 100, message: "转码完成", codec: selectedCodec || "libx264" });

  return outputFile;
}

async function remuxToFaststartMp4(inputFile, outputFile) {
  const args = [
    "-y",
    "-i",
    inputFile,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputFile
  ];

  await new Promise((resolve, reject) => {
    const proc = spawnObservedProcess(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] }, { kind: "ffmpeg", context: "remux-faststart", path: inputFile });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => reject(new Error(`ffmpeg launch failed: ${error.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg remux failed with code ${code}: ${stderr.slice(-300)}`));
      }
    });
  });
}

async function transcodeToPreviewMp4(inputFile, outputFile, onProgress) {
  const durationSeconds = await (async () => {
    try {
      const args = [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        inputFile
      ];
      return await new Promise((resolve) => {
        const proc = spawnObservedProcess(ffprobePath, args, { stdio: ["ignore", "pipe", "ignore"] }, { kind: "ffprobe", context: "preview-duration", path: inputFile });
        let out = "";
        proc.stdout.on("data", (chunk) => {
          out += chunk.toString();
        });
        proc.on("error", () => resolve(0));
        proc.on("close", () => {
          const parsed = Number.parseFloat((out || "").trim());
          resolve(Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
        });
      });
    } catch {
      return 0;
    }
  })();

  onProgress?.({ stage: "preparing", progress: 0, message: "正在准备预览档" });

  let selectedCodec = "";
  await runFfmpegWithCodecFallback(
    (codec) => {
      const codecArgs = buildCodecArgs(codec, "preview");
      return [
        "-y",
        "-i",
        inputFile,
        "-movflags",
        "+faststart",
        "-pix_fmt",
        "yuv420p",
        ...codecArgs,
        "-maxrate",
        "1600k",
        "-bufsize",
        "3200k",
        "-g",
        "48",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        outputFile
      ];
    },
    {
      context: "preview-cache-transcode",
      sourcePath: inputFile,
      onCodecSelected: (codec) => {
        selectedCodec = codec;
      },
      onProgress: (text) => {
        if (durationSeconds > 0) {
          const match = /time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
          if (match) {
            const currentSeconds = Number.parseInt(match[1], 10) * 3600 + Number.parseInt(match[2], 10) * 60 + Number.parseFloat(match[3]);
            const progress = Math.max(1, Math.min(99, Math.round((currentSeconds / durationSeconds) * 100)));
            onProgress?.({ stage: "transcoding", progress, message: `正在生成预览档 ${progress}%` });
          }
        } else {
          onProgress?.({ stage: "transcoding", progress: null, message: "正在生成预览档" });
        }
      }
    }
  );

  onProgress?.({ stage: "done", progress: 100, message: "预览档已就绪", codec: selectedCodec || "libx264" });
}

async function ensurePreviewVariant(inputFile, onProgress) {
  const stat = await fs.promises.stat(inputFile);
  const cacheDir = path.join(storageRoot, previewCacheDirName);
  await fs.promises.mkdir(cacheDir, { recursive: true });

  const key = await buildStableAssetCacheKey(inputFile, stat, "preview");
  const outputFile = path.join(cacheDir, `${key}.preview.mp4`);

  try {
    await fs.promises.access(outputFile, fs.constants.R_OK);
    log("preview-cache-hit", path.basename(outputFile));
    await emitObservabilitySnapshot("preview-cache-hit", {
      path: summarizePathForLog(inputFile),
      cacheFile: path.basename(outputFile)
    });
    return outputFile;
  } catch {
  }

  const existingJob = state.previewJobs.get(outputFile);
  if (existingJob) {
    return existingJob;
  }

  const job = (async () => {
    const tempFile = `${outputFile}.tmp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.mp4`;
    await emitObservabilitySnapshot("preview-cache-build-start", {
      path: summarizePathForLog(inputFile),
      cacheFile: path.basename(outputFile)
    });
    try {
      try {
        onProgress?.({ stage: "preparing", progress: 0, message: "正在快速重封装" });
        await remuxToFaststartMp4(inputFile, tempFile);
      } catch {
        await transcodeToPreviewMp4(inputFile, tempFile, onProgress);
      }
      await fs.promises.rename(tempFile, outputFile);
      await emitObservabilitySnapshot("preview-cache-build-done", {
        path: summarizePathForLog(inputFile),
        cacheFile: path.basename(outputFile)
      });
      return outputFile;
    } finally {
      fs.promises.rm(tempFile, { force: true }).catch(() => {});
      state.previewJobs.delete(outputFile);
    }
  })();

  state.previewJobs.set(outputFile, job);
  return job;
}

function schedulePreviewWarmup(absolutePath) {
  if (!enableTranscode) {
    return;
  }
  const sourceMime = mime.lookup(absolutePath) || "application/octet-stream";
  if (!String(sourceMime).startsWith("video/")) {
    return;
  }
  ensurePreviewVariant(absolutePath)
    .then((output) => log("preview-warmup-done", path.basename(output)))
    .catch((error) => logWarn("preview-warmup-failed", error.message || error));
}

async function generateSingleBitrateHls(inputFile, outputDir, onProgress) {
  await fs.promises.mkdir(outputDir, { recursive: true });
  const playlistPath = path.join(outputDir, "index.m3u8");
  const segmentPattern = path.join(outputDir, "seg-%05d.ts");
  const startedAt = Date.now();
  const durationSeconds = await getMediaDurationSeconds(inputFile, "hls-duration");
  onProgress?.({ stage: "preparing", progress: 0, message: "正在生成 HLS 预览" });

  // Optimisation: if the source is already H.264 at ≤ 720p we can mux directly
  // into HLS segments without re-encoding.  GPU/CPU usage drops to near zero.
  const videoInfo = await probeVideoStream(inputFile);
  const canCopy =
    videoInfo?.codec === "h264" &&
    videoInfo.height > 0 &&
    videoInfo.height <= 720;

  const initialGpuCooldownHits = getCodecCooldownSnapshot("hls-720p");
  const initialCandidates = canCopy ? ["copy"] : await getCodecCandidates("hls-720p");
  logInfo("[hls-plan]", JSON.stringify({
    path: summarizePathForLog(inputFile),
    durationSeconds: durationSeconds || 0,
    inputVideo: videoInfo || null,
    canCopy,
    allowGpuHlsEncoding,
    preferredCodec: String(hlsVideoCodec || "auto"),
    gpuCooldownHit: initialGpuCooldownHits.length > 0,
    gpuCooldown: initialGpuCooldownHits,
    candidates: initialCandidates
  }));

  if (canCopy) {
    log("hls-copy-path", path.basename(inputFile), `${videoInfo.width}x${videoInfo.height}`);
    try {
      await new Promise((resolve, reject) => {
        const args = [
          "-y",
          "-i", inputFile,
          "-c:v", "copy",
          "-bsf:v", "h264_mp4toannexb",
          "-c:a", "aac",
          "-b:a", "128k",
          "-f", "hls",
          "-hls_time", "4",
          "-hls_playlist_type", "vod",
          "-hls_flags", "independent_segments",
          "-hls_segment_filename", segmentPattern,
          playlistPath
        ];
        onProgress?.({ stage: "transcoding", progress: null, message: "正在封装 HLS（直接复制流）" });
        const proc = spawnObservedProcess(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] }, { kind: "ffmpeg", context: "hls-copy", path: inputFile });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        proc.on("error", (err) => reject(new Error(`ffmpeg launch failed: ${err.message}`)));
        proc.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg hls-copy failed: ${stderr.slice(-300)}`));
        });
      });
      onProgress?.({ stage: "done", progress: 100, message: "HLS 预览已就绪（直接复制）", codec: "copy" });
      const elapsedMs = Date.now() - startedAt;
      logInfo("[hls-result]", JSON.stringify({
        path: summarizePathForLog(inputFile),
        codec: "copy",
        mode: "copy",
        gpuCooldownHit: initialGpuCooldownHits.length > 0,
        gpuCooldown: initialGpuCooldownHits,
        elapsedMs,
        elapsedSec: Number((elapsedMs / 1000).toFixed(1))
      }));
      return { playlistPath, codec: "copy", mode: "copy", elapsedMs, gpuCooldown: initialGpuCooldownHits };
    } catch (err) {
      logWarn("hls-copy-fallback", err.message || err);
      // Clean up partial output before falling through to re-encode path
      await fs.promises.rm(outputDir, { recursive: true, force: true });
      await fs.promises.mkdir(outputDir, { recursive: true });
    }
  }

  let selectedCodec = "";
  await runFfmpegWithCodecFallback(
    (codec) => {
      const codecArgs = buildCodecArgs(codec, "hls");
      const hwaccelArgs =
        codec === "h264_nvenc" && hlsNvencUseCudaPipeline
          ? ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
          : [];
      const videoFilter = codec === "h264_nvenc"
        ? (hlsNvencUseCudaPipeline ? "scale_cuda=-2:720" : "scale=-2:720,format=nv12")
        : "scale=-2:720";
      const pixelFormatArgs = codec === "h264_nvenc"
        ? []
        : ["-pix_fmt", "yuv420p"];
      return [
        "-y",
        ...hwaccelArgs,
        "-i",
        inputFile,
        "-vf",
        videoFilter,
        ...pixelFormatArgs,
        "-force_key_frames",
        "expr:gte(t,n_forced*2)",
        ...codecArgs,
        "-g",
        "48",
        "-keyint_min",
        "48",
        "-sc_threshold",
        "0",
        "-bsf:v",
        "h264_mp4toannexb",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-f",
        "hls",
        "-hls_time",
        "4",
        "-hls_playlist_type",
        "vod",
        "-hls_flags",
        "independent_segments",
        "-hls_segment_filename",
        segmentPattern,
        playlistPath
      ];
    },
    {
      context: "hls-720p",
      sourcePath: inputFile,
      onCodecSelected: (codec) => {
        selectedCodec = codec;
      },
      onProgress: (text) => {
        const progress = extractProgressFromFfmpegLog(text, durationSeconds);
        onProgress?.({
          stage: "transcoding",
          progress,
          message: progress != null
            ? `正在切分视频片段 ${progress}%`
            : "正在切分视频片段"
        });
      }
    }
  );

  onProgress?.({ stage: "done", progress: 100, message: "HLS 预览已就绪", codec: selectedCodec || "libx264" });
  const elapsedMs = Date.now() - startedAt;
  const finalGpuCooldownHits = getCodecCooldownSnapshot("hls-720p");
  logInfo("[hls-result]", JSON.stringify({
    path: summarizePathForLog(inputFile),
    codec: selectedCodec || "libx264",
    mode: "transcode",
    gpuCooldownHit: initialGpuCooldownHits.length > 0,
    gpuCooldown: initialGpuCooldownHits,
    gpuCooldownAfterRun: finalGpuCooldownHits,
    elapsedMs,
    elapsedSec: Number((elapsedMs / 1000).toFixed(1))
  }));
  return {
    playlistPath,
    codec: selectedCodec || "libx264",
    mode: "transcode",
    elapsedMs,
    gpuCooldown: initialGpuCooldownHits,
    gpuCooldownAfterRun: finalGpuCooldownHits
  };
}

function parseManifestSegments(manifestText) {
  return manifestText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

async function ensureHlsVariant(inputFile, profile = "720p", onProgress) {
  const stat = await fs.promises.stat(inputFile);
  const cacheRoot = path.join(storageRoot, hlsCacheDirName);
  await fs.promises.mkdir(cacheRoot, { recursive: true });

  const hlsId = await buildStableAssetCacheKey(inputFile, stat, `hls:${profile}`);
  const outputDir = path.join(cacheRoot, hlsId);
  const playlistPath = path.join(outputDir, "index.m3u8");
  const metaPath = path.join(outputDir, "meta.json");

  const ensureAndReadManifest = async () => {
    const manifest = await fs.promises.readFile(playlistPath, "utf8");
    const segments = parseManifestSegments(manifest);
    let codec = "";
    try {
      const raw = await fs.promises.readFile(metaPath, "utf8");
      const parsed = JSON.parse(raw);
      codec = String(parsed?.codec || "");
    } catch {
    }
    state.hlsIndex.set(hlsId, { dir: outputDir, segments: new Set(segments), codec, updatedAt: Date.now() });
    return { hlsId, manifest, codec };
  };

  try {
    await fs.promises.access(playlistPath, fs.constants.R_OK);
    logInfo("[hls-cache] hit", JSON.stringify({
      path: summarizePathForLog(inputFile),
      profile,
      hlsId,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      playlist: path.relative(storageRoot, playlistPath).replace(/\\/g, "/")
    }));
    try {
      const cachedMetaRaw = await fs.promises.readFile(metaPath, "utf8");
      const cachedMeta = JSON.parse(cachedMetaRaw);
      logInfo("[hls-result]", JSON.stringify({
        path: summarizePathForLog(inputFile),
        codec: String(cachedMeta?.codec || ""),
        mode: "cache-hit",
        gpuCooldownHit: false,
        elapsedMs: 0,
        elapsedSec: 0
      }));
    } catch {
    }
    await emitObservabilitySnapshot("hls-cache-hit", {
      path: summarizePathForLog(inputFile),
      hlsId,
      profile
    });
    return await ensureAndReadManifest();
  } catch (error) {
    logInfo("[hls-cache] miss", JSON.stringify({
      path: summarizePathForLog(inputFile),
      profile,
      hlsId,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      playlist: path.relative(storageRoot, playlistPath).replace(/\\/g, "/"),
      reason: error?.code || error?.message || "not-readable"
    }));
  }

  const runningJob = state.hlsJobs.get(hlsId);
  if (runningJob) {
    logInfo("[hls-cache] join-running-job", JSON.stringify({
      path: summarizePathForLog(inputFile),
      profile,
      hlsId
    }));
    // Join the already-running job. Register our progress callback so warmup-started
    // jobs can still stream progress to the browser when the user clicks preview.
    if (onProgress) runningJob.listeners.add(onProgress);
    try {
      await runningJob.promise;
    } finally {
      if (onProgress) runningJob.listeners.delete(onProgress);
    }
    return ensureAndReadManifest();
  }

  // New job: collect all waiting callers' progress listeners into a shared Set.
  const listeners = new Set();
  if (onProgress) listeners.add(onProgress);
  const broadcastProgress = (status) => {
    for (const cb of listeners) cb(status);
  };

  const jobEntry = { listeners, promise: null };
  state.hlsJobs.set(hlsId, jobEntry);

  jobEntry.promise = (async () => {
    const tempDir = `${outputDir}.tmp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const buildStartedAt = Date.now();
    await emitObservabilitySnapshot("hls-build-start", {
      path: summarizePathForLog(inputFile),
      hlsId,
      profile
    });
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    const hlsResult = await generateSingleBitrateHls(inputFile, tempDir, broadcastProgress);
    await fs.promises.writeFile(path.join(tempDir, "meta.json"), JSON.stringify({ codec: hlsResult.codec || "" }, null, 2));
    await fs.promises.rm(outputDir, { recursive: true, force: true });
    await fs.promises.rename(tempDir, outputDir);
    logInfo("[hls-build-summary]", JSON.stringify({
      path: summarizePathForLog(inputFile),
      hlsId,
      profile,
      codec: hlsResult.codec || "",
      mode: hlsResult.mode || "transcode",
      gpuCooldownHit: Array.isArray(hlsResult.gpuCooldown) && hlsResult.gpuCooldown.length > 0,
      gpuCooldown: hlsResult.gpuCooldown || [],
      gpuCooldownAfterRun: hlsResult.gpuCooldownAfterRun || [],
      elapsedMs: Number(hlsResult.elapsedMs || (Date.now() - buildStartedAt)),
      elapsedSec: Number((Number(hlsResult.elapsedMs || (Date.now() - buildStartedAt)) / 1000).toFixed(1))
    }));
    await emitObservabilitySnapshot("hls-build-done", {
      path: summarizePathForLog(inputFile),
      hlsId,
      profile,
      codec: hlsResult.codec || ""
    });
  })();

  try {
    await jobEntry.promise;
  } finally {
    state.hlsJobs.delete(hlsId);
  }

  return ensureAndReadManifest();
}

function scheduleHlsWarmup(absolutePath) {
  if (!enableTranscode) {
    return;
  }
  const sourceMime = mime.lookup(absolutePath) || "application/octet-stream";
  if (!String(sourceMime).startsWith("video/")) {
    return;
  }
  ensureHlsVariant(absolutePath, "720p")
    .then(({ hlsId }) => log("hls-warmup-done", hlsId))
    .catch((error) => logWarn("hls-warmup-failed", error.message || error));
}

async function generateVideoThumbnail(inputFile) {
  const tempDir = path.join(os.tmpdir(), "nas-bridge-transcode");
  await fs.promises.mkdir(tempDir, { recursive: true });
  const outputFile = path.join(tempDir, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.jpg`);
  const args = [
    "-y",
    "-ss",
    "00:00:01",
    "-i",
    inputFile,
    "-frames:v",
    "1",
    "-vf",
    "scale=640:-1",
    "-q:v",
    "4",
    outputFile
  ];

  await new Promise((resolve, reject) => {
    const proc = spawnObservedProcess(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] }, { kind: "ffmpeg", context: "video-thumbnail", path: inputFile });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => reject(new Error(`ffmpeg launch failed: ${error.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg thumbnail failed with code ${code}: ${stderr.slice(-300)}`));
      }
    });
  });

  return outputFile;
}

async function generateImageThumbnail(inputFile) {
  const tempDir = path.join(os.tmpdir(), "nas-bridge-transcode");
  await fs.promises.mkdir(tempDir, { recursive: true });
  const outputFile = path.join(tempDir, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.jpg`);
  const args = [
    "-y",
    "-i",
    inputFile,
    "-frames:v",
    "1",
    "-vf",
    "scale='min(640,iw)':-1",
    "-q:v",
    "5",
    outputFile
  ];

  await new Promise((resolve, reject) => {
    const proc = spawnObservedProcess(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] }, { kind: "ffmpeg", context: "image-thumbnail", path: inputFile });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => reject(new Error(`ffmpeg launch failed: ${error.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg image thumbnail failed with code ${code}: ${stderr.slice(-300)}`));
      }
    });
  });

  return outputFile;
}

async function generateImagePreviewCompressed(inputFile) {
  const tempDir = path.join(os.tmpdir(), "nas-bridge-transcode");
  await fs.promises.mkdir(tempDir, { recursive: true });
  const outputFile = path.join(tempDir, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.jpg`);
  const args = [
    "-y",
    "-i",
    inputFile,
    "-frames:v",
    "1",
    "-vf",
    "scale='min(1920,iw)':-2",
    "-q:v",
    "4",
    outputFile
  ];

  await new Promise((resolve, reject) => {
    const proc = spawnObservedProcess(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] }, { kind: "ffmpeg", context: "image-preview", path: inputFile });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => reject(new Error(`ffmpeg launch failed: ${error.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg image preview failed with code ${code}: ${stderr.slice(-300)}`));
      }
    });
  });

  return outputFile;
}

const requestTimeoutMs = Number(process.env.CLIENT_REQUEST_TIMEOUT_MS || 10_000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(error) {
  const text = String(error?.message || error || "");
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|network|socket hang up|502|503|504/i.test(text);
}

function classifyError(error) {
  const text = String(error?.message || error || "");
  if (/ECONNREFUSED/i.test(text)) return "conn-refused";
  if (/ETIMEDOUT|timeout|aborted/i.test(text)) return "timeout";
  if (/ECONNRESET|socket hang up/i.test(text)) return "conn-reset";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return "dns";
  if (/401|403|invalid registration key/i.test(text)) return "auth";
  return "unknown";
}

async function checkServerHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`${serverBaseUrl}/api/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    log("health", data?.ok ? "ok" : "unexpected");
    return true;
  } catch (error) {
    clearTimeout(timeout);
    const kind = classifyError(error);
    console.warn(`[connectivity] /api/health failed (${kind}): ${error.message || error}`);
    return false;
  }
}

async function api(pathname, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  const maxAttempts = Number(options.maxAttempts ?? 3);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    log("api-request", reqId, pathname, `attempt=${attempt}/${maxAttempts}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(`${serverBaseUrl}${pathname}`, {
        ...options,
        headers,
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }
      const json = await response.json();
      log("api-response", reqId, pathname, `status=${response.status}`);
      return json;
    } catch (error) {
      clearTimeout(timeout);
      const canRetry = attempt < maxAttempts && shouldRetry(error);
      if (!canRetry) {
        throw new Error(`API ${pathname} failed (${classifyError(error)}): ${error.message || error}`);
      }
      const backoff = Math.min(1200 * 2 ** (attempt - 1), 6000);
      console.warn(`API retry ${attempt}/${maxAttempts} for ${pathname} in ${backoff}ms (${classifyError(error)}): ${error.message || error}`);
      await sleep(backoff);
    }
  }
}

async function runWithStartupRetry(task, label) {
  while (true) {
    try {
      logInfo("[startup] stage-begin", label);
      const result = await task();
      logInfo("[startup] stage-ready", label);
      return result;
    } catch (error) {
      const waitMs = 3000;
      console.error(`${label} failed: ${error.message}. retry in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
}

async function ensureRegistered() {
  if (state.token) {
    log("register-skip", "token-exists", state.clientId || "unknown-client");
    return;
  }
  const payload = await api("/api/admin/clients/register", {
    method: "POST",
    body: JSON.stringify({ registrationKey, name: clientName })
  });
  state.token = payload.token;
  state.clientId = payload.client.id;
  logInfo("Client registered:", payload.client.id, `name=${payload.client.name || clientName}`);
}

async function heartbeat() {
  log("heartbeat-send", state.clientId || "unknown-client");
  const result = await api("/api/client/heartbeat", { method: "POST", body: JSON.stringify({ name: clientName }) });
  state.clientId = result.client.id;
  log("heartbeat-ok", state.clientId, result.client.status);
}

async function syncFiles() {
  const files = await scanFiles(storageRoot);
  log("filesync-send", `count=${files.length}`);
  await api("/api/client/filesync", {
    method: "POST",
    body: JSON.stringify({ files })
  });
  logInfo(`File sync completed, count=${files.length}`);
}

function buildPc(remotePeerId) {
  const pc = new RTCPeerConnection({ iceServers });
  logInfo("[rtc] peer-create for", remotePeerId, "iceServers:", iceServers.map((s) => s.urls).flat().join(","));
  let cleanupTimer = null;

  function schedulePeerCleanup() {
    if (cleanupTimer) {
      return;
    }
    cleanupTimer = setTimeout(() => {
      cleanupTimer = null;
      if (state.peers.get(remotePeerId) === pc) {
        state.peers.delete(remotePeerId);
      }
      try {
        pc.close();
      } catch {
      }
      logInfo("[rtc] peer-cleanup", remotePeerId);
    }, peerCleanupDelayMs);
  }

  function cancelPeerCleanup() {
    if (!cleanupTimer) {
      return;
    }
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }

  pc.oniceconnectionstatechange = () => {
    logInfo("[rtc] ice-state", remotePeerId, pc.iceConnectionState);
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      cancelPeerCleanup();
      return;
    }
    if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed" || pc.iceConnectionState === "disconnected") {
      schedulePeerCleanup();
    }
  };

  pc.onconnectionstatechange = () => {
    logInfo("[rtc] conn-state", remotePeerId, pc.connectionState);
    if (pc.connectionState === "connected") {
      cancelPeerCleanup();
      return;
    }
    if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
      schedulePeerCleanup();
    }
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      logInfo("[rtc] ice-gathering-complete", remotePeerId);
      return;
    }
    const c = event.candidate;
    logInfo("[rtc] ice-candidate", remotePeerId, c.type, c.protocol, c.address || "?");
    if (!state.ws) {
      return;
    }
    if (state.ws.readyState === WebSocket.OPEN) {
      try {
        state.ws.send(
          JSON.stringify({
            type: "signal",
            targetId: remotePeerId,
            payload: { kind: "ice", candidate: event.candidate }
          })
        );
      } catch (error) {
        logWarn("ws send ice failed:", error.message || error);
      }
    }
  };

  pc.ondatachannel = (event) => {
    logInfo("[rtc] datachannel received", remotePeerId, event.channel?.label);
    wireDataChannel(event.channel, remotePeerId);
  };

  return pc;
}

function wireDataChannel(channel, remotePeerId = "unknown-peer") {
  channel.binaryType = "arraybuffer";
  logInfo("[dc] wiring channel", channel.label, `readyState=${channel.readyState}`);

  const uploadChannelKey = `${remotePeerId}::${channel.label}`;

  function clearUploadTimer(ctx) {
    if (ctx?.staleTimer) {
      clearTimeout(ctx.staleTimer);
      ctx.staleTimer = null;
    }
  }

  function scheduleUploadStaleTimeout(ctx, reason = "activity") {
    if (!ctx) {
      return;
    }
    clearUploadTimer(ctx);
    ctx.lastActivityAt = Date.now();
    ctx.staleTimer = setTimeout(() => {
      const active = state.uploads.get(uploadChannelKey);
      if (active !== ctx) {
        return;
      }
      logWarn("upload-stale-timeout", ctx.requestId || "-", ctx.path || "-", reason);
      cleanupUploadEntry({ key: uploadChannelKey, ctx, removePartial: true, resync: true, destroyStream: true });
    }, uploadStaleTimeoutMs);
  }

  function cleanupUploadEntry({ key, ctx, removePartial = true, resync = false, destroyStream = true }) {
    if (!ctx) {
      return;
    }
    clearUploadTimer(ctx);
    const active = state.uploads.get(key);
    if (active === ctx) {
      state.uploads.delete(key);
    }
    if (destroyStream) {
      try {
        ctx.stream?.destroy();
      } catch {
      }
    }
    if (removePartial && ctx.path) {
      fs.promises.rm(ctx.path, { force: true }).catch(() => {});
    }
    if (resync) {
      syncFiles().catch((error) => logWarn("upload-cleanup-filesync-failed", error?.message || error));
    }
  }

  channel.onopen = () => {
    logInfo("[dc] channel open", channel.label);
  };
  channel.onclose = () => {
    logInfo("[dc] channel close", channel.label);
    cleanupUploadEntry({
      key: uploadChannelKey,
      ctx: state.uploads.get(uploadChannelKey),
      removePartial: true,
      resync: true,
      destroyStream: true
    });
  };
  channel.onerror = (ev) => {
    logWarn("[dc] channel error", channel.label, ev?.error?.message || "");
    cleanupUploadEntry({
      key: uploadChannelKey,
      ctx: state.uploads.get(uploadChannelKey),
      removePartial: true,
      resync: true,
      destroyStream: true
    });
  };

  function safeSend(payload, context = "send") {
    if (channel.readyState !== "open") {
      logWarn(`[dc] skip ${context}: channel not open (${channel.readyState})`);
      return false;
    }
    try {
      channel.send(payload);
      return true;
    } catch (error) {
      logWarn(`[dc] send failed (${context}): ${error.message || error}`);
      return false;
    }
  }

  function findUploadCtxByRequestId(requestId) {
    if (!requestId) {
      return null;
    }
    for (const [label, ctx] of state.uploads.entries()) {
      if (ctx?.requestId === requestId) {
        return { label, ctx };
      }
    }
    return null;
  }

  async function waitForDrain(context = "drain") {
    const highWaterMark = 4 * 1024 * 1024;
    const lowWaterMark = 512 * 1024;
    channel.bufferedAmountLowThreshold = lowWaterMark;
    if (channel.bufferedAmount <= highWaterMark) {
      return;
    }
    const startedAt = Date.now();
    const maxWaitMs = 180_000;
    while (channel.bufferedAmount > highWaterMark) {
      if (channel.readyState !== "open") {
        throw new Error(`datachannel closed while draining (${context})`);
      }
      if (Date.now() - startedAt > maxWaitMs) {
        throw new Error(`datachannel drain timeout (${context})`);
      }

      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          channel.removeEventListener("bufferedamountlow", onLow);
          clearTimeout(pollTimer);
          resolve();
        };
        const onLow = () => finish();
        const pollTimer = setTimeout(() => finish(), 250);
        channel.addEventListener("bufferedamountlow", onLow, { once: true });
      });
    }
  }

  channel.onmessage = async (event) => {
    if (typeof event.data !== "string") {
      const uploadCtx = state.uploads.get(uploadChannelKey);
      if (!uploadCtx) {
        return;
      }
      uploadCtx.stream.write(Buffer.from(event.data));
      uploadCtx.received += event.data.byteLength;
      scheduleUploadStaleTimeout(uploadCtx, "binary-chunk");
      return;
    }

    const message = JSON.parse(event.data);

    if (message.type === "ping") {
      safeSend(JSON.stringify({ type: "pong", ts: message.ts }), "pong");
      return;
    }

    if (message.type === "put-file-cancel") {
      const entry = findUploadCtxByRequestId(message.requestId) || (state.uploads.has(uploadChannelKey)
        ? { label: uploadChannelKey, ctx: state.uploads.get(uploadChannelKey) }
        : null);
      if (!entry?.ctx) {
        return;
      }
      cleanupUploadEntry({ key: entry.label, ctx: entry.ctx, removePartial: true, resync: true, destroyStream: true });
      safeSend(
        JSON.stringify({ type: "put-file-cancelled", requestId: entry.ctx.requestId, path: message.path || "" }),
        "put-file-cancelled"
      );
      return;
    }

    if (message.type === "get-hls-manifest") {
      logInfo("[dc] recv get-hls-manifest", channel.label, message.requestId, message.path);
      const observeStartedAt = Date.now();
      await emitObservabilitySnapshot("request-start", {
        requestId: message.requestId,
        type: message.type,
        channel: channel.label,
        path: message.path
      });
      try {
        const absolute = safeJoin(storageRoot, message.path);
        const sourceMime = mime.lookup(absolute) || "application/octet-stream";
        if (!String(sourceMime).startsWith("video/")) {
          throw new Error("HLS preview only supports video files");
        }
        if (!enableTranscode) {
          throw new Error("HLS preview requires ENABLE_TRANSCODE");
        }

        const { hlsId, manifest } = await ensureHlsVariant(absolute, message.profile || "720p", (status) => {
          safeSend(
            JSON.stringify({
              type: "transcode-status",
              requestId: message.requestId,
              stage: status.stage,
              progress: status.progress ?? null,
              message: status.message || "",
              codec: status.codec || ""
            }),
            "hls-manifest-status"
          );
        });

        safeSend(
          JSON.stringify({
            type: "hls-manifest",
            requestId: message.requestId,
            hlsId,
            profile: message.profile || "720p",
            mimeType: "application/vnd.apple.mpegurl",
            manifest,
            codec: state.hlsIndex.get(hlsId)?.codec || ""
          }),
          "hls-manifest"
        );
        await emitObservabilitySnapshot("request-done", {
          requestId: message.requestId,
          type: message.type,
          channel: channel.label,
          path: summarizePathForLog(absolute),
          durationMs: Date.now() - observeStartedAt,
          hlsId
        });
      } catch (error) {
        log("error", message.type, message.requestId, error.message);
        await emitObservabilitySnapshot("request-failed", {
          requestId: message.requestId,
          type: message.type,
          channel: channel.label,
          path: message.path,
          durationMs: Date.now() - observeStartedAt,
          error: error.message
        });
        safeSend(JSON.stringify({ type: "error", requestId: message.requestId, message: error.message }), "hls-manifest-error");
      }
      return;
    }

    if (message.type === "get-hls-segment") {
      logInfo("[dc] recv get-hls-segment", channel.label, message.requestId, `${message.hlsId}/${message.segment}`);
      const observeStartedAt = Date.now();
      let streamedBytes = 0;
      await emitObservabilitySnapshot("request-start", {
        requestId: message.requestId,
        type: message.type,
        channel: channel.label,
        hlsId: message.hlsId,
        segment: message.segment
      });
      try {
        if (!message.hlsId || !message.segment) {
          throw new Error("hlsId and segment are required");
        }
        const hlsEntry = state.hlsIndex.get(message.hlsId);
        if (!hlsEntry) {
          throw new Error("hls preview cache miss");
        }
        hlsEntry.updatedAt = Date.now();

        const segmentName = String(message.segment || "").trim();
        if (!segmentName || segmentName.includes("/") || segmentName.includes("\\") || segmentName.includes("..")) {
          throw new Error("invalid segment name");
        }
        if (!hlsEntry.segments.has(segmentName)) {
          throw new Error("segment not found");
        }

        const segmentPath = path.join(hlsEntry.dir, segmentName);
        const stat = await fs.promises.stat(segmentPath);
        if (!safeSend(
          JSON.stringify({
            type: "file-meta",
            requestId: message.requestId,
            name: segmentName,
            size: stat.size,
            mimeType: "video/mp2t"
          }),
          "hls-segment-meta"
        )) {
          return;
        }

        const stream = fs.createReadStream(segmentPath, { highWaterMark: 64 * 1024 });
        for await (const chunk of stream) {
          streamedBytes += Number(chunk?.length || chunk?.byteLength || 0);
          await waitForDrain("hls-segment");
          if (!safeSend(chunk, "hls-segment")) {
            throw new Error("datachannel closed while streaming hls segment");
          }
        }
        safeSend(JSON.stringify({ type: "file-end", requestId: message.requestId }), "hls-segment-end");
        await emitObservabilitySnapshot("request-done", {
          requestId: message.requestId,
          type: message.type,
          channel: channel.label,
          hlsId: message.hlsId,
          segment: message.segment,
          durationMs: Date.now() - observeStartedAt,
          streamedMiB: toMiB(streamedBytes)
        });
      } catch (error) {
        log("error", message.type, message.requestId, error.message);
        await emitObservabilitySnapshot("request-failed", {
          requestId: message.requestId,
          type: message.type,
          channel: channel.label,
          hlsId: message.hlsId,
          segment: message.segment,
          durationMs: Date.now() - observeStartedAt,
          streamedMiB: toMiB(streamedBytes),
          error: error.message
        });
        safeSend(JSON.stringify({ type: "error", requestId: message.requestId, message: error.message }), "hls-segment-error");
      }
      return;
    }

    if (message.type === "get-file" || message.type === "get-file-stream" || message.type === "get-thumbnail" || message.type === "get-image-preview") {
      logInfo("[dc] recv", message.type, channel.label, message.requestId, message.path);
      const observeStartedAt = Date.now();
      let observeVariant = message.type;
      let streamedBytes = 0;
      await emitObservabilitySnapshot("request-start", {
        requestId: message.requestId,
        type: message.type,
        channel: channel.label,
        path: message.path,
        previewProfile: message.previewProfile || "",
        transcode: message.transcode || ""
      });
      try {
        const absolute = safeJoin(storageRoot, message.path);
        let streamPath = absolute;
        let streamMime = mime.lookup(absolute) || "application/octet-stream";
        let cleanupPath = null;

        if (message.type === "get-thumbnail") {
          observeVariant = "thumbnail";
          const sourceMime = mime.lookup(absolute) || "application/octet-stream";
          if (String(sourceMime).startsWith("video/")) {
            if (!enableTranscode) {
              throw new Error("thumbnail for video requires ffmpeg (ENABLE_TRANSCODE!=0)");
            }
            cleanupPath = await generateVideoThumbnail(absolute);
            streamPath = cleanupPath;
            streamMime = "image/jpeg";
          } else if (String(sourceMime).startsWith("image/")) {
            if (enableTranscode) {
              cleanupPath = await generateImageThumbnail(absolute);
              streamPath = cleanupPath;
              streamMime = "image/jpeg";
            } else {
              streamPath = absolute;
              streamMime = sourceMime;
            }
          } else {
            throw new Error("thumbnail unsupported for this file type");
          }
        }

        if (message.type === "get-image-preview") {
          observeVariant = "image-preview";
          const sourceMime = mime.lookup(absolute) || "application/octet-stream";
          if (!String(sourceMime).startsWith("image/")) {
            throw new Error("image preview only supports image files");
          }
          if (!enableTranscode) {
            throw new Error("compressed image preview requires ENABLE_TRANSCODE=1");
          }
          cleanupPath = await generateImagePreviewCompressed(absolute);
          streamPath = cleanupPath;
          streamMime = "image/jpeg";
        }

        if (message.type === "get-file-stream" && message.previewProfile === "fast") {
          const sourceMime = mime.lookup(absolute) || "application/octet-stream";
          if (enableTranscode && String(sourceMime).startsWith("video/")) {
            log("preview-profile-fast", message.requestId, message.path);
            observeVariant = "preview-fast";
            streamPath = await ensurePreviewVariant(absolute, (status) => {
              safeSend(
                JSON.stringify({
                  type: "transcode-status",
                  requestId: message.requestId,
                  stage: status.stage,
                  progress: status.progress ?? null,
                  message: status.message || "",
                  codec: status.codec || ""
                }),
                "preview-profile-status"
              );
            });
            streamMime = "video/mp4";
          }
        }

        if (message.type === "get-file-stream" && message.transcode === "mp4") {
          if (!enableTranscode) {
            throw new Error("transcode disabled by ENABLE_TRANSCODE=0");
          }
          log("transcode-start", message.requestId, message.path);
          observeVariant = "transcode-mp4";
          safeSend(
            JSON.stringify({
              type: "transcode-status",
              requestId: message.requestId,
              stage: "preparing",
              progress: 0,
              message: "开始转码"
            }),
            "transcode-status-start"
          );
          cleanupPath = await transcodeToMp4(absolute, (status) => {
            safeSend(
              JSON.stringify({
                type: "transcode-status",
                requestId: message.requestId,
                stage: status.stage,
                progress: status.progress ?? null,
                message: status.message || "",
                codec: status.codec || ""
              }),
              "transcode-status-progress"
            );
          });
          streamPath = cleanupPath;
          streamMime = "video/mp4";
          log("transcode-done", message.requestId, streamPath);
        }

        const stat = await fs.promises.stat(streamPath);
        if (!safeSend(
          JSON.stringify({
            type: "file-meta",
            requestId: message.requestId,
            name: path.basename(streamPath),
            size: stat.size,
            mimeType: streamMime
          }),
          "file-meta"
        )) {
          if (cleanupPath) {
            fs.promises.rm(cleanupPath, { force: true }).catch(() => {});
          }
          return;
        }

        const stream = fs.createReadStream(streamPath, { highWaterMark: 64 * 1024 });
        try {
          for await (const chunk of stream) {
            streamedBytes += Number(chunk?.length || chunk?.byteLength || 0);
            await waitForDrain("file-chunk");
            if (!safeSend(chunk, "file-chunk")) {
              throw new Error("datachannel closed while streaming");
            }
          }
          log("response", "file-end", message.requestId, message.path);
          safeSend(JSON.stringify({ type: "file-end", requestId: message.requestId }), "file-end");
          await emitObservabilitySnapshot("request-done", {
            requestId: message.requestId,
            type: message.type,
            variant: observeVariant,
            channel: channel.label,
            path: summarizePathForLog(absolute),
            streamPath: summarizePathForLog(streamPath),
            durationMs: Date.now() - observeStartedAt,
            streamedMiB: toMiB(streamedBytes),
            responseMime: streamMime
          });
        } catch (error) {
          log("error", "stream", message.requestId, error.message);
          await emitObservabilitySnapshot("request-failed", {
            requestId: message.requestId,
            type: message.type,
            variant: observeVariant,
            channel: channel.label,
            path: summarizePathForLog(absolute),
            durationMs: Date.now() - observeStartedAt,
            streamedMiB: toMiB(streamedBytes),
            error: error.message
          });
          safeSend(JSON.stringify({ type: "error", requestId: message.requestId, message: error.message }), "stream-error");
        } finally {
          if (cleanupPath) {
            fs.promises.rm(cleanupPath, { force: true }).catch(() => {});
          }
        }
      } catch (error) {
        log("error", message.type, message.requestId, error.message);
        await emitObservabilitySnapshot("request-failed", {
          requestId: message.requestId,
          type: message.type,
          variant: observeVariant,
          channel: channel.label,
          path: message.path,
          durationMs: Date.now() - observeStartedAt,
          error: error.message
        });
        safeSend(JSON.stringify({ type: "error", requestId: message.requestId, message: error.message }), "request-error");
      }
      return;
    }

    if (message.type === "put-file-start") {
      logInfo("[dc] recv put-file-start", channel.label, message.requestId, message.path, `size=${message.size}`);
      try {
        const absolute = safeJoin(storageRoot, message.path);
        await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
        const existingCtx = state.uploads.get(uploadChannelKey);
        if (existingCtx) {
          cleanupUploadEntry({ key: uploadChannelKey, ctx: existingCtx, removePartial: true, resync: false, destroyStream: true });
        }
        const stream = fs.createWriteStream(absolute);
        const ctx = {
          requestId: message.requestId,
          path: absolute,
          stream,
          expected: Number(message.size || 0),
          received: 0,
          staleTimer: null,
          lastActivityAt: Date.now()
        };
        state.uploads.set(uploadChannelKey, ctx);
        scheduleUploadStaleTimeout(ctx, "put-file-start");
        stream.once("error", (error) => {
          logWarn("upload-stream-error", message.requestId, error.message || error);
          cleanupUploadEntry({ key: uploadChannelKey, ctx, removePartial: true, resync: true, destroyStream: false });
          safeSend(
            JSON.stringify({ type: "error", requestId: message.requestId, message: error.message }),
            "put-file-stream-error"
          );
        });
        safeSend(JSON.stringify({ type: "put-file-ack", requestId: message.requestId, path: message.path }), "put-file-ack");
      } catch (error) {
        safeSend(JSON.stringify({ type: "error", requestId: message.requestId, message: error.message }), "put-file-start-error");
      }
      return;
    }

    if (message.type === "put-file-end") {
      const uploadCtx = state.uploads.get(uploadChannelKey);
      if (!uploadCtx) {
        return;
      }
      if (uploadCtx.requestId && message.requestId && uploadCtx.requestId !== message.requestId) {
        return;
      }
      clearUploadTimer(uploadCtx);
      await new Promise((resolve, reject) => {
        uploadCtx.stream.once("finish", resolve);
        uploadCtx.stream.once("error", reject);
        uploadCtx.stream.end();
      });

      try {
        await syncFiles();
        schedulePreviewWarmup(uploadCtx.path);
        scheduleHlsWarmup(uploadCtx.path);
        safeSend(
          JSON.stringify({
            type: "put-file-finish",
            requestId: uploadCtx.requestId,
            bytes: uploadCtx.received
          }),
          "put-file-finish"
        );
      } catch (error) {
        safeSend(JSON.stringify({ type: "error", requestId: uploadCtx.requestId, message: error.message }), "put-file-end-error");
      } finally {
        cleanupUploadEntry({ key: uploadChannelKey, ctx: uploadCtx, removePartial: false, resync: false, destroyStream: false });
      }
      return;
    }

    if (message.type === "delete-file") {
      logInfo("[dc] recv delete-file", channel.label, message.requestId, message.path);
      try {
        const absolute = safeJoin(storageRoot, message.path);
        const uploading = [...state.uploads.values()].some((ctx) => ctx?.path === absolute);
        if (uploading) {
          throw new Error("file is uploading");
        }
        await fs.promises.rm(absolute, { force: true });
        await syncFiles();
        safeSend(JSON.stringify({ type: "delete-file-result", requestId: message.requestId, ok: true }), "delete-file-ok");
      } catch (error) {
        safeSend(
          JSON.stringify({
            type: "delete-file-result",
            requestId: message.requestId,
            ok: false,
            message: error.message
          }),
          "delete-file-error"
        );
      }
    }
  };
}

async function handleSignal(fromId, payload) {
  let pc = state.peers.get(fromId);

  // On a new offer, always replace a stale/closed peer connection.
  // The browser may have refreshed the page, creating a fresh RTCPeerConnection
  // while we still hold a dead one. Reusing it would cause setRemoteDescription
  // to fail or silently break the connection.
  if (payload.kind === "offer") {
    logInfo("[signal] got offer from", fromId);
    // A new offer always means the browser has created a fresh RTCPeerConnection.
    // Reusing an existing PC (even if still "connected") causes SCTP/DataChannel
    // state corruption: ICE may reconnect but DataChannels stay stuck in "connecting"
    // forever because the SCTP association from the old session is still alive.
    // Always replace the PC on a new offer.
    if (pc) {
      logInfo("[signal] replacing previous pc", fromId, pc.connectionState);
      try { pc.close(); } catch {}
    }
    pc = buildPc(fromId);
    state.peers.set(fromId, pc);
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    logInfo("[signal] sending answer to", fromId);
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(
        JSON.stringify({
          type: "signal",
          targetId: fromId,
          payload: { kind: "answer", sdp: pc.localDescription }
        })
      );
    } else {
      logWarn("ws not open when sending answer", fromId);
    }
    return;
  }

  if (!pc) {
    pc = buildPc(fromId);
    state.peers.set(fromId, pc);
  }

  if (payload.kind === "answer") {
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    return;
  }

  if (payload.kind === "ice" && payload.candidate) {
    const cand = payload.candidate;
    // SDP candidate line looks like: "candidate:... typ host ..." → extract address
    const parts = (cand.candidate || "").split(" ");
    const addr = parts[4] || "?";
    const type = parts[7] || "?";
    logInfo("[signal] got ice-candidate from", fromId, type, addr);
    await pc.addIceCandidate(new RTCIceCandidate(cand));
  }
}

function scheduleReconnect(reason = "unknown") {
  if (state.wsReconnectTimer) {
    return;
  }
  state.wsReconnectTimer = setTimeout(async () => {
    state.wsReconnectTimer = null;
    logWarn(`[ws] reconnect triggered: ${reason}`);
    await runWithStartupRetry(async () => {
      await checkServerHealth();
      await ensureRegistered();
      await heartbeat();
      await connectWs();
    }, "ws-reconnect");
  }, wsReconnectDelayMs);
}

async function connectWs() {
  if (state.ws?.readyState === WebSocket.OPEN) {
    return;
  }
  if (state.wsConnecting) {
    return;
  }

  state.wsConnecting = true;
  const wsUrl = new URL("/ws", serverBaseUrl.replace(/^http/, "ws"));
  wsUrl.searchParams.set("token", state.token);

  const ws = new WebSocket(wsUrl);
  log("ws-connect-attempt", wsUrl.toString());
  state.ws = ws;
  state.wsReady = false;
  state.wsLastMessageAt = Date.now();

  await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    ws.once("open", () => {
      state.wsConnecting = false;
      state.wsReady = true;
      state.wsLastMessageAt = Date.now();
      logInfo("WS connected", wsUrl.toString());
      settle(resolve);
    });

    ws.once("error", (error) => {
      if (!state.wsReady) {
        state.wsConnecting = false;
        settle(reject, error);
      }
    });

    ws.once("close", () => {
      if (!state.wsReady) {
        state.wsConnecting = false;
        settle(reject, new Error("ws closed before open"));
      }
    });
  });

  ws.on("message", async (raw) => {
    state.wsLastMessageAt = Date.now();
    log("ws-message", `bytes=${raw.length || raw.toString().length}`);
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "signal") {
        await handleSignal(message.fromId, message.payload);
      }
    } catch (error) {
      logError("WS message handling error:", error.message);
    }
  });

  ws.on("pong", () => {
    state.wsLastMessageAt = Date.now();
  });

  ws.on("close", () => {
    state.wsReady = false;
    state.wsConnecting = false;
    logWarn(`WS closed, reconnecting in ${wsReconnectDelayMs}ms`);
    scheduleReconnect("ws-close");
  });

  ws.on("error", (error) => {
    logError("WS error:", error.message);
    if (!state.wsReady) {
      scheduleReconnect("ws-error-before-open");
    }
  });
}

async function main() {
  logInfo("[startup] storage-client config", {
    serverBaseUrl,
    clientName,
    storageRoot,
    hasToken: Boolean(state.token),
    enableTranscode,
    ffmpegPath,
    transcodeVideoCodec,
    transcodePreferGpu,
    previewObservabilityEnabled,
    previewObservabilityIntervalMs,
    wsReconnectDelayMs,
    wsIdleTimeoutMs,
    uploadStaleTimeoutMs
  });

  if (!fs.existsSync(storageRoot)) {
    logWarn(`[startup] storage root not found, creating: ${storageRoot}`);
    await fs.promises.mkdir(storageRoot, { recursive: true });
  }

  logInfo("[startup] stage-begin", "health-check");
  await checkServerHealth();
  logInfo("[startup] stage-ready", "health-check");
  await runWithStartupRetry(() => ensureRegistered(), "register");
  await runWithStartupRetry(() => heartbeat(), "heartbeat-init");
  await runWithStartupRetry(() => syncFiles(), "filesync-init");
  await runWithStartupRetry(() => connectWs(), "ws-connect");
  await cleanupExpiredCacheEntries();
  await emitObservabilitySnapshot("startup", { clientId: state.clientId || "" });
  logInfo("[startup] ready", JSON.stringify({ clientId: state.clientId || "", wsReady: state.wsReady, storageRoot }));

  setInterval(() => {
    heartbeat().catch((error) => logError("heartbeat failed:", error.message));
  }, 30_000);

  setInterval(() => {
    syncFiles().catch((error) => logError("filesync failed:", error.message));
  }, 60_000);

  setInterval(() => {
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      scheduleReconnect("watchdog-not-open");
      return;
    }
    const idleFor = Date.now() - (state.wsLastMessageAt || 0);
    if (idleFor > wsIdleTimeoutMs) {
      if (state.peers.size > 0) {
        logWarn(`[ws] idle timeout skipped during active peer session (${idleFor}ms, peers=${state.peers.size})`);
        try {
          ws.ping();
        } catch {
          scheduleReconnect("watchdog-ping-failed-during-peer-session");
        }
        return;
      }
      logWarn(`[ws] idle timeout (${idleFor}ms), forcing reconnect`);
      try {
        ws.terminate();
      } catch {
        scheduleReconnect("watchdog-idle-timeout");
      }
      return;
    }
    try {
      ws.ping();
    } catch {
      scheduleReconnect("watchdog-ping-failed");
    }
  }, wsWatchdogIntervalMs);

  setInterval(() => {
    cleanupExpiredCacheEntries().catch((error) => logWarn("cache-cleanup-interval-failed", error?.message || error));
  }, cacheCleanupIntervalMs);

  if (previewObservabilityEnabled) {
    setInterval(() => {
      emitObservabilitySnapshot("periodic", { clientId: state.clientId || "" }).catch((error) => {
        logWarn("observability-periodic-failed", error?.message || error);
      });
    }, previewObservabilityIntervalMs);
  }
}

main().catch((error) => {
  logError("fatal main error:", error.message || error);
});
