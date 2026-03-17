import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import mime from "mime-types";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import wrtcPkg from "@roamhq/wrtc";
import { createBotRuntime } from "./bot/index.js";
import { createBotJobMessageId } from "./bot/context.js";
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
const thumbnailCacheDirName = process.env.THUMBNAIL_CACHE_DIR_NAME || "thumbs";
const videoCoverCacheDirName = process.env.VIDEO_COVER_CACHE_DIR_NAME || "video-covers";
const hlsCacheDirName = process.env.HLS_CACHE_DIR_NAME || ".nas-hls-cache";
const hlsCacheIndexFileName = process.env.HLS_CACHE_INDEX_FILE_NAME || "index.json";
const chatRoomDirName = process.env.CHAT_ROOM_DIR_NAME || ".nas-chat-room";
const transcodeVideoCodec = process.env.TRANSCODE_VIDEO_CODEC || "auto";
const hlsVideoCodec = process.env.HLS_VIDEO_CODEC || "auto";
const transcodePreferGpu = process.env.TRANSCODE_PREFER_GPU !== "0";
const hlsNvencPreset = process.env.HLS_NVENC_PRESET || "p2";
const hlsNvencUseCudaPipeline = process.env.HLS_NVENC_USE_CUDA_PIPELINE === "1";
const wsReconnectDelayMs = Number(process.env.WS_RECONNECT_DELAY_MS || 3000);
const iceCandidatePoolSize = Math.max(0, Math.min(10, Math.floor(Number(process.env.ICE_CANDIDATE_POOL_SIZE || 2) || 0)));
function readCandidateDelayMs(value, fallback = 0) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, Math.min(10_000, Math.floor(raw)));
}

const legacyHostFirstCandidateDelayMs = readCandidateDelayMs(process.env.P2P_HOST_FIRST_DELAY_MS, 0);
const srflxCandidateDelayMs = readCandidateDelayMs(process.env.P2P_SRFLX_DELAY_MS, legacyHostFirstCandidateDelayMs);
const relayCandidateDelayMs = readCandidateDelayMs(process.env.P2P_RELAY_DELAY_MS, legacyHostFirstCandidateDelayMs);
const wsIdleTimeoutMs = Number(process.env.WS_IDLE_TIMEOUT_MS || 90_000);
const wsWatchdogIntervalMs = Number(process.env.WS_WATCHDOG_INTERVAL_MS || 10_000);
const uploadStaleTimeoutMs = Number(process.env.UPLOAD_STALE_TIMEOUT_MS || 300_000);
const peerCleanupDelayMs = Number(process.env.PEER_CLEANUP_DELAY_MS || 30_000);
const previewCacheMaxAgeMs = Number(process.env.PREVIEW_CACHE_MAX_AGE_MS || 86_400_000);
const hlsCacheMaxAgeMs = Number(process.env.HLS_CACHE_MAX_AGE_MS || 604_800_000);
const cacheCleanupIntervalMs = Number(process.env.CACHE_CLEANUP_INTERVAL_MS || 3_600_000);
const chatMediaWarmupThresholdBytes = Number(process.env.CHAT_MEDIA_WARMUP_THRESHOLD_BYTES || 10 * 1024 * 1024);
const previewObservabilityEnabled = process.env.PREVIEW_OBSERVABILITY === "1";
const previewObservabilityIntervalMs = Number(process.env.PREVIEW_OBSERVABILITY_INTERVAL_MS || 15_000);
const previewObservabilitySampleCache = process.env.PREVIEW_OBSERVABILITY_SAMPLE_CACHE !== "0";
const assetFingerprintSampleBytes = Number(process.env.ASSET_FINGERPRINT_SAMPLE_BYTES || 262_144);
const assetFingerprintWholeFileThresholdBytes = Number(process.env.ASSET_FINGERPRINT_WHOLE_FILE_THRESHOLD_BYTES || 1_048_576);
const assetFingerprintCacheLimit = Number(process.env.ASSET_FINGERPRINT_CACHE_LIMIT || 512);
const botJobStatusCacheTtlMs = Number(process.env.BOT_JOB_STATUS_CACHE_TTL_MS || 21_600_000);
const botJobStatusCacheMaxEntries = Number(process.env.BOT_JOB_STATUS_CACHE_MAX_ENTRIES || 2048);
const allowGpuHlsEncoding = process.env.ALLOW_GPU_HLS_ENCODING !== "0";
const disabledEncoderCooldownMs = Number(process.env.DISABLED_ENCODER_COOLDOWN_MS || 900_000);
const hlsIndexMaxEntries = Number(process.env.HLS_INDEX_MAX_ENTRIES || 512);
const thumbnailMinimumBytes = Number(process.env.THUMBNAIL_MINIMUM_BYTES || 512);
const shareJwtSecret = process.env.JWT_SECRET || "";

if (!shareJwtSecret) {
  console.warn("[share] JWT_SECRET is missing in storage-client env; public share preview/download will fail until it matches server JWT_SECRET");
}

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

function extractCandidateAddress(candidate) {
  const direct = String(candidate?.address || candidate?.ip || "").trim();
  if (direct) {
    return direct;
  }
  const parts = String(candidate?.candidate || "").trim().split(/\s+/);
  return String(parts[4] || "").trim();
}

function extractCandidateType(candidate) {
  const direct = String(candidate?.type || candidate?.candidateType || "").trim();
  if (direct) {
    return direct;
  }
  const parts = String(candidate?.candidate || "").trim().split(/\s+/);
  const typeIndex = parts.indexOf("typ");
  return typeIndex >= 0 ? String(parts[typeIndex + 1] || "").trim() : "";
}

function isLoopbackCandidateAddress(address = "") {
  const value = String(address || "").trim().toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

function isLinkLocalCandidateAddress(address = "") {
  const value = String(address || "").trim().toLowerCase();
  return value.startsWith("169.254.") || value.startsWith("fe80:");
}

function buildIgnoredHostCandidateAddresses() {
  const ignored = new Set();
  const interfaces = os.networkInterfaces?.() || {};
  const virtualNamePattern = /(docker|wsl|hyper-v|vethernet|vmware|virtualbox|vboxnet|virbr|br-)/i;
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!virtualNamePattern.test(name)) {
      continue;
    }
    for (const address of addresses || []) {
      const family = String(address?.family || "").toLowerCase();
      if (family && family !== "ipv4" && family !== "ipv6") {
        continue;
      }
      const value = String(address?.address || "").trim();
      if (value) {
        ignored.add(value);
      }
    }
  }
  return ignored;
}

function getCandidateSignalDelayMs(candidateType) {
  if (candidateType === "relay") {
    return relayCandidateDelayMs;
  }
  if (candidateType === "srflx") {
    return srflxCandidateDelayMs;
  }
  return 0;
}

const ignoredHostCandidateAddresses = buildIgnoredHostCandidateAddresses();

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
  chatAppendQueues: new Map(),
  previewJobs: new Map(),
  hlsJobs: new Map(),
  hlsIndex: new Map(),
  hlsPersistentIndex: null,
  hlsPersistentIndexLoaded: false,
  hlsPersistentIndexWrite: Promise.resolve(),
  activeMediaProcesses: new Map(),
  assetFingerprints: new Map(),
  ffmpegEncoderSupport: null,
  disabledEncoders: new Map(),
  thumbnailBackfillRunning: false
};

let botRuntime = null;
const botJobStatusCache = new Map();

function getPrunableLimit(value, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function pruneBotJobStatusCache(now = Date.now()) {
  const ttlMs = getPrunableLimit(botJobStatusCacheTtlMs, 21_600_000);
  if (ttlMs > 0) {
    for (const [jobId, entry] of botJobStatusCache.entries()) {
      const updatedAt = Number(entry?.updatedAt || 0);
      if (!updatedAt || now - updatedAt > ttlMs) {
        botJobStatusCache.delete(jobId);
      }
    }
  }

  const maxEntries = getPrunableLimit(botJobStatusCacheMaxEntries, 2048);
  if (maxEntries > 0 && botJobStatusCache.size > maxEntries) {
    const staleEntries = [...botJobStatusCache.entries()]
      .sort((left, right) => Number(left[1]?.updatedAt || 0) - Number(right[1]?.updatedAt || 0));
    for (const [jobId] of staleEntries.slice(0, botJobStatusCache.size - maxEntries)) {
      botJobStatusCache.delete(jobId);
    }
  }
}

async function pruneTransientHlsIndex(now = Date.now()) {
  const maxAgeMs = getPrunableLimit(hlsCacheMaxAgeMs, 604_800_000);
  for (const [hlsId, entry] of state.hlsIndex.entries()) {
    const dirPath = String(entry?.dir || "");
    if (!dirPath) {
      state.hlsIndex.delete(hlsId);
      continue;
    }
    try {
      const stat = await fs.promises.stat(dirPath);
      const lastTouchedAt = Math.max(stat.mtimeMs || 0, stat.atimeMs || 0, stat.ctimeMs || 0, Number(entry?.updatedAt || 0));
      if (maxAgeMs > 0 && now - lastTouchedAt > maxAgeMs) {
        state.hlsIndex.delete(hlsId);
      }
    } catch {
      state.hlsIndex.delete(hlsId);
    }
  }

  const maxEntries = getPrunableLimit(hlsIndexMaxEntries, 512);
  if (maxEntries > 0 && state.hlsIndex.size > maxEntries) {
    const oldestEntries = [...state.hlsIndex.entries()]
      .sort((left, right) => Number(left[1]?.updatedAt || 0) - Number(right[1]?.updatedAt || 0));
    for (const [hlsId] of oldestEntries.slice(0, state.hlsIndex.size - maxEntries)) {
      state.hlsIndex.delete(hlsId);
    }
  }
}

async function prunePersistentHlsIndex(now = Date.now()) {
  const maxAgeMs = getPrunableLimit(hlsCacheMaxAgeMs, 604_800_000);
  const maxEntries = getPrunableLimit(hlsIndexMaxEntries, 512);
  await updateHlsPersistentIndex(async (index) => {
    const entries = Object.entries(index.entries || {});
    let changed = false;
    const metadata = [];

    for (const [key, entry] of entries) {
      const hlsId = String(entry?.hlsId || "").trim();
      if (!hlsId) {
        delete index.entries[key];
        changed = true;
        continue;
      }

      const dirPath = getHlsCacheDirPath(hlsId);
      let lastTouchedAt = Number(new Date(entry?.updatedAt || 0).getTime() || 0);
      try {
        const stat = await fs.promises.stat(dirPath);
        lastTouchedAt = Math.max(lastTouchedAt, stat.mtimeMs || 0, stat.atimeMs || 0, stat.ctimeMs || 0);
      } catch {
        delete index.entries[key];
        changed = true;
        continue;
      }

      if (maxAgeMs > 0 && now - lastTouchedAt > maxAgeMs) {
        delete index.entries[key];
        changed = true;
        continue;
      }

      metadata.push({ key, lastTouchedAt });
    }

    if (maxEntries > 0 && metadata.length > maxEntries) {
      metadata.sort((left, right) => left.lastTouchedAt - right.lastTouchedAt);
      for (const { key } of metadata.slice(0, metadata.length - maxEntries)) {
        delete index.entries[key];
        changed = true;
      }
    }

    return changed;
  });
}

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

function queueChatAppend(relativePath, task) {
  const key = String(relativePath || "");
  const previous = state.chatAppendQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  const tracked = next.finally(() => {
    if (state.chatAppendQueues.get(key) === tracked) {
      state.chatAppendQueues.delete(key);
    }
  });
  state.chatAppendQueues.set(key, tracked);
  return next;
}

async function appendChatHistoryEntry(relativePath, entry) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.startsWith(`${chatRoomDirName}/history/`)) {
    throw new Error("invalid chat history path");
  }
  const payload = entry && typeof entry === "object" ? entry : null;
  if (!payload) {
    throw new Error("entry is required");
  }
  const serialized = JSON.stringify(payload);
  if (!serialized || serialized === "null") {
    throw new Error("entry serialization failed");
  }
  if (Buffer.byteLength(serialized, "utf8") > 96 * 1024) {
    throw new Error("chat entry too large");
  }
  const absolute = safeJoin(storageRoot, normalized);
  await queueChatAppend(normalized, async () => {
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
    await fs.promises.appendFile(absolute, `${serialized}\n`, "utf8");
  });
  return normalized;
}

async function publishRealtimeChatMessage(entry) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    throw new Error("websocket is not connected");
  }
  state.ws.send(JSON.stringify({ type: "chat-room-message", payload: entry }));
}

function buildBotJobStatusText(job, botDisplayName) {
  const phaseText = String(job?.progress?.label || job?.phase || "处理中").trim();
  const percent = Number.isFinite(job?.progress?.percent) ? Math.max(0, Math.min(100, Number(job.progress.percent))) : null;
  if (job?.status === "queued") {
    return `${botDisplayName}：排队中`;
  }
  if (job?.status === "running") {
    return percent !== null
      ? `${botDisplayName}：${phaseText} (${percent}%)`
      : `${botDisplayName}：${phaseText}`;
  }
  if (job?.status === "succeeded") {
    return `${botDisplayName}：已完成`;
  }
  if (job?.status === "failed") {
    const errorText = String(job?.error?.message || "任务失败").trim();
    return `${botDisplayName}：失败${errorText ? `，${errorText}` : ""}`;
  }
  if (job?.status === "cancelled") {
    return `${botDisplayName}：已取消`;
  }
  return `${botDisplayName}：${phaseText || job?.status || "处理中"}`;
}

function buildBotJobCard(job, botDisplayName) {
  const percent = Number.isFinite(job?.progress?.percent) ? Math.max(0, Math.min(100, Number(job.progress.percent))) : null;
  if (job?.status === "failed") {
    return {
      type: "bot-status",
      status: "failed",
      title: botDisplayName,
      body: String(job?.error?.message || "任务失败").trim(),
      progress: null,
      actions: [{ type: "retry-bot-job", label: "重新生成" }]
    };
  }
  if (job?.status === "cancelled") {
    return {
      type: "bot-status",
      status: "cancelled",
      title: botDisplayName,
      body: "任务已取消",
      progress: null,
      actions: [{ type: "retry-bot-job", label: "重新生成" }]
    };
  }
  if (job?.status === "succeeded") {
    return {
      type: "bot-status",
      status: "succeeded",
      title: botDisplayName,
      body: "任务已完成",
      progress: null
    };
  }
  return {
    type: "bot-status",
    status: String(job?.status || "running"),
    title: botDisplayName,
    body: String(job?.progress?.label || job?.phase || "处理中").trim(),
    progress: percent,
    actions: ["queued", "running"].includes(String(job?.status || ""))
      ? [{ type: "cancel-bot-job", label: "停止生成" }]
      : []
  };
}

function getBotJobStatusSignature(job) {
  const percentBucket = Number.isFinite(job?.progress?.percent)
    ? Math.floor(Math.max(0, Math.min(100, Number(job.progress.percent))) / 10) * 10
    : "na";
  return [
    String(job?.status || "queued"),
    String(job?.phase || "parse-input"),
    String(percentBucket),
    String(job?.error?.message || "")
  ].join("|");
}

async function publishBotJobStatusMessage(job) {
  if (!job?.jobId) {
    return;
  }
  pruneBotJobStatusCache();
  const signature = getBotJobStatusSignature(job);
  const cached = botJobStatusCache.get(job.jobId);
  if (cached?.signature === signature) {
    return;
  }
  const plugin = botRuntime?.registry?.getById?.(job.botId) || null;
  const botDisplayName = String(plugin?.displayName || job.botId || "Bot").trim();
  const createdAt = cached?.createdAt || String(job.startedAt || job.createdAt || new Date().toISOString());
  const dayKey = String(job.chat?.dayKey || createdAt.slice(0, 10));
  botJobStatusCache.set(job.jobId, { signature, createdAt, updatedAt: Date.now() });
  const message = {
    id: createBotJobMessageId(job.jobId),
    text: "",
    createdAt,
    dayKey,
    historyPath: String(job.chat?.historyPath || ""),
    hostClientId: String(job.chat?.hostClientId || ""),
    attachments: [],
    card: buildBotJobCard(job, botDisplayName),
    bot: {
      botId: String(job.botId || ""),
      jobId: String(job.jobId || "")
    },
    author: {
      id: `bot:${job.botId || "unknown"}`,
      displayName: botDisplayName,
      avatarUrl: "",
      avatarClientId: "",
      avatarPath: "",
      avatarFileId: ""
    }
  };
  if (job?.status === "succeeded" && String(job?.result?.replyMessageId || "") === message.id) {
    return;
  }
  if (message.historyPath) {
    await appendChatHistoryEntry(message.historyPath, message);
  }
  if (state.ws && state.ws.readyState === WebSocket.OPEN && message.hostClientId) {
    await publishRealtimeChatMessage(message);
  }
}

async function ensureBotRuntime() {
  if (botRuntime) {
    botRuntime.clientId = state.clientId || botRuntime.clientId;
    return botRuntime;
  }
  botRuntime = createBotRuntime({
    clientId: state.clientId,
    storageRoot,
    dependencies: {
      syncFiles,
      ffmpegPath,
      appendChatMessage: appendChatHistoryEntry,
      publishChatMessage: publishRealtimeChatMessage
    }
  });
  await botRuntime.init();
  botRuntime.events.on("job", (job) => {
    publishBotJobStatusMessage(job).catch((error) => logWarn("bot-job-status-publish-failed", error?.message || error));
  });
  return botRuntime;
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
      hlsIndex: state.hlsIndex.size,
      botJobStatusCache: botJobStatusCache.size,
      assetFingerprints: state.assetFingerprints.size,
      disabledEncoders: state.disabledEncoders.size
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

  async function getEntryLastTouchedAt(entryPath, recursive = false) {
    let stat;
    try {
      stat = await fs.promises.stat(entryPath);
    } catch {
      return 0;
    }
    let latest = Math.max(stat.mtimeMs || 0, stat.atimeMs || 0, stat.ctimeMs || 0);
    if (!recursive || !stat.isDirectory()) {
      return latest;
    }
    let entries = [];
    try {
      entries = await fs.promises.readdir(entryPath, { withFileTypes: true });
    } catch {
      return latest;
    }
    for (const entry of entries) {
      const childLatest = await getEntryLastTouchedAt(path.join(entryPath, entry.name), true);
      latest = Math.max(latest, childLatest);
    }
    return latest;
  }

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
        const lastTouchedAt = entry.isDirectory() && recursive
          ? await getEntryLastTouchedAt(entryPath, true)
          : Math.max(stat.mtimeMs || 0, stat.atimeMs || 0, stat.ctimeMs || 0);
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
  await removeExpiredChildren(path.join(storageRoot, hlsCacheDirName), hlsCacheMaxAgeMs, false);
  pruneBotJobStatusCache(now);
  await pruneTransientHlsIndex(now);
  await prunePersistentHlsIndex(now);
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

async function readHlsMeta(metaPath) {
  try {
    const raw = await fs.promises.readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeHlsMeta(metaPath, patch = {}) {
  const current = await readHlsMeta(metaPath);
  const next = {
    ...current,
    ...patch,
    updatedAt: String(patch.updatedAt || new Date().toISOString())
  };
  await fs.promises.writeFile(metaPath, JSON.stringify(next, null, 2));
  return next;
}

async function touchHlsCacheEntry(outputDir, patch = {}) {
  const metaPath = path.join(outputDir, "meta.json");
  const next = await writeHlsMeta(metaPath, patch);
  const now = new Date();
  await Promise.allSettled([
    fs.promises.utimes(metaPath, now, now),
    fs.promises.utimes(outputDir, now, now)
  ]);
  return next;
}

function getHlsCacheRoot() {
  return path.join(storageRoot, hlsCacheDirName);
}

function getHlsCacheDirPath(hlsId) {
  return path.join(getHlsCacheRoot(), String(hlsId || "").trim());
}

function getHlsCacheIndexPath() {
  return path.join(getHlsCacheRoot(), hlsCacheIndexFileName);
}

function createHlsPersistentIndex() {
  return {
    version: 1,
    entries: {}
  };
}

function getHlsPersistentIndexKey(sourceRelativePath, profile) {
  return `${String(profile || "720p")}:${String(sourceRelativePath || "")}`;
}

async function ensureHlsPersistentIndexLoaded() {
  if (state.hlsPersistentIndexLoaded && state.hlsPersistentIndex) {
    return state.hlsPersistentIndex;
  }
  const indexPath = getHlsCacheIndexPath();
  try {
    const raw = await fs.promises.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
      state.hlsPersistentIndex = {
        version: Number(parsed.version || 1),
        entries: { ...parsed.entries }
      };
    } else {
      state.hlsPersistentIndex = createHlsPersistentIndex();
    }
  } catch {
    state.hlsPersistentIndex = createHlsPersistentIndex();
  }
  state.hlsPersistentIndexLoaded = true;
  return state.hlsPersistentIndex;
}

async function flushHlsPersistentIndex() {
  const index = await ensureHlsPersistentIndexLoaded();
  const indexPath = getHlsCacheIndexPath();
  const tempPath = `${indexPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  await fs.promises.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.promises.writeFile(tempPath, JSON.stringify(index, null, 2), "utf8");
  await fs.promises.copyFile(tempPath, indexPath);
  await fs.promises.rm(tempPath, { force: true });
}

async function updateHlsPersistentIndex(mutator) {
  await ensureHlsPersistentIndexLoaded();
  state.hlsPersistentIndexWrite = state.hlsPersistentIndexWrite
    .catch(() => {})
    .then(async () => {
      const index = await ensureHlsPersistentIndexLoaded();
      const shouldFlush = await mutator(index);
      if (shouldFlush === false) {
        return;
      }
      await flushHlsPersistentIndex();
    });
  await state.hlsPersistentIndexWrite;
}

async function setHlsPersistentIndexEntry(sourceRelativePath, profile, entry) {
  const key = getHlsPersistentIndexKey(sourceRelativePath, profile);
  await updateHlsPersistentIndex(async (index) => {
    index.entries[key] = entry;
  });
}

async function deleteHlsPersistentIndexEntry(sourceRelativePath, profile) {
  const key = getHlsPersistentIndexKey(sourceRelativePath, profile);
  await updateHlsPersistentIndex(async (index) => {
    delete index.entries[key];
  });
}

async function getHlsPersistentIndexEntry(sourceRelativePath, profile) {
  const index = await ensureHlsPersistentIndexLoaded();
  return index.entries[getHlsPersistentIndexKey(sourceRelativePath, profile)] || null;
}

async function ensureHlsVariant(inputFile, profile = "720p", onProgress) {
  const stat = await fs.promises.stat(inputFile);
  const cacheRoot = getHlsCacheRoot();
  await fs.promises.mkdir(cacheRoot, { recursive: true });
  const sourceRelativePath = normalizeRelativePath(path.relative(storageRoot, inputFile));

  const indexedEntry = await getHlsPersistentIndexEntry(sourceRelativePath, profile);
  let hlsId = String(indexedEntry?.hlsId || "").trim();
  if (indexedEntry && (
    indexedEntry.sourceRelativePath !== sourceRelativePath
    || Number(indexedEntry.fileSize || -1) !== Number(stat.size || 0)
    || Number(indexedEntry.fileMtimeMs || -1) !== Number(stat.mtimeMs || 0)
  )) {
    await deleteHlsPersistentIndexEntry(sourceRelativePath, profile);
    hlsId = "";
  }

  if (!hlsId) {
    hlsId = await buildStableAssetCacheKey(inputFile, stat, `hls:${profile}`);
  }
  const outputDir = path.join(cacheRoot, hlsId);
  const playlistPath = path.join(outputDir, "index.m3u8");
  const metaPath = path.join(outputDir, "meta.json");

  const ensureAndReadManifest = async () => {
    const manifest = await fs.promises.readFile(playlistPath, "utf8");
    const segments = parseManifestSegments(manifest);
    const meta = await touchHlsCacheEntry(outputDir);
    const codec = String(meta?.codec || "");
    state.hlsIndex.set(hlsId, {
      dir: outputDir,
      segments: new Set(segments),
      codec,
      updatedAt: Date.now(),
      sourceRelativePath: String(meta?.sourceRelativePath || sourceRelativePath || "")
    });
    await setHlsPersistentIndexEntry(sourceRelativePath, profile, {
      hlsId,
      profile,
      sourceRelativePath,
      fileSize: Number(stat.size || 0),
      fileMtimeMs: Number(stat.mtimeMs || 0),
      codec,
      updatedAt: new Date().toISOString()
    });
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
    if (indexedEntry) {
      await deleteHlsPersistentIndexEntry(sourceRelativePath, profile);
    }
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
    await writeHlsMeta(path.join(tempDir, "meta.json"), {
      codec: hlsResult.codec || "",
      sourceRelativePath
    });
    await fs.promises.rm(outputDir, { recursive: true, force: true });
    await fs.promises.rename(tempDir, outputDir);
    await touchHlsCacheEntry(outputDir, {
      codec: hlsResult.codec || "",
      sourceRelativePath
    });
    await setHlsPersistentIndexEntry(sourceRelativePath, profile, {
      hlsId,
      profile,
      sourceRelativePath,
      fileSize: Number(stat.size || 0),
      fileMtimeMs: Number(stat.mtimeMs || 0),
      codec: hlsResult.codec || "",
      updatedAt: new Date().toISOString()
    });
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

async function ensureThumbnailVariant(inputFile) {
  const stat = await fs.promises.stat(inputFile);
  const sourceMime = mime.lookup(inputFile) || "application/octet-stream";
  const isVideoSource = String(sourceMime).startsWith("video/");
  const key = await buildStableAssetCacheKey(inputFile, stat, "thumb");
  const preferredCacheDir = path.join(storageRoot, previewCacheDirName, isVideoSource ? videoCoverCacheDirName : thumbnailCacheDirName);
  const legacyCacheDir = path.join(storageRoot, previewCacheDirName, thumbnailCacheDirName);
  const outputFile = path.join(preferredCacheDir, `${key}.jpg`);
  const legacyOutputFile = path.join(legacyCacheDir, `${key}.jpg`);
  await fs.promises.mkdir(preferredCacheDir, { recursive: true });

  if (await isUsableThumbnailFile(outputFile)) {
    return outputFile;
  }
  if (legacyOutputFile !== outputFile && await isUsableThumbnailFile(legacyOutputFile)) {
    try {
      await fs.promises.copyFile(legacyOutputFile, outputFile);
      return outputFile;
    } catch {
      return legacyOutputFile;
    }
  }

  const tempFile = `${outputFile}.tmp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.jpg`;
  try {
    const generated = isVideoSource
      ? await generateVideoThumbnail(inputFile)
      : await generateImageThumbnail(inputFile);
    await fs.promises.copyFile(generated, tempFile);
    await fs.promises.rename(tempFile, outputFile);
    fs.promises.rm(generated, { force: true }).catch(() => {});
    return outputFile;
  } finally {
    fs.promises.rm(tempFile, { force: true }).catch(() => {});
  }
}

function shouldGenerateThumbnailForMime(sourceMime) {
  return /^image\//i.test(String(sourceMime || "")) || /^video\//i.test(String(sourceMime || ""));
}

async function isUsableThumbnailFile(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() && Number(stat.size || 0) >= thumbnailMinimumBytes;
  } catch {
    return false;
  }
}

function buildVideoThumbnailSeekCandidates(durationSeconds) {
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const cap = duration > 0 ? Math.max(0, duration - 0.05) : 3;
  const candidates = [0, 0.15, 0.35, 1, 2];
  if (duration > 0) {
    candidates.push(duration * 0.05, duration * 0.15, duration * 0.33, duration * 0.5, duration - 0.2);
  }
  return [...new Set(candidates
    .map((value) => Math.max(0, Math.min(cap, Number(value || 0))))
    .filter((value) => Number.isFinite(value))
    .map((value) => Number(value.toFixed(3))))];
}

async function runThumbnailGeneration(args, inputFile, outputFile, context) {
  await fs.promises.rm(outputFile, { force: true }).catch(() => {});
  await new Promise((resolve, reject) => {
    const proc = spawnObservedProcess(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] }, { kind: "ffmpeg", context, path: inputFile });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => reject(new Error(`ffmpeg launch failed: ${error.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg ${context} failed with code ${code}: ${stderr.slice(-300)}`));
      }
    });
  });
  if (!(await isUsableThumbnailFile(outputFile))) {
    throw new Error(`ffmpeg ${context} produced no usable thumbnail`);
  }
}

function shouldWarmChatMedia(relativePath, sizeBytes, sourceMime) {
  const normalized = normalizeRelativePath(relativePath || "");
  if (!normalized.startsWith(`${chatRoomDirName}/attachments/`)) {
    return false;
  }
  if (Number(sizeBytes || 0) < chatMediaWarmupThresholdBytes) {
    return false;
  }
  return /^image\//i.test(String(sourceMime || "")) || /^video\//i.test(String(sourceMime || ""));
}

function scheduleThumbnailWarmup(absolutePath) {
  if (!enableTranscode) {
    return;
  }
  const sourceMime = mime.lookup(absolutePath) || "application/octet-stream";
  if (!shouldGenerateThumbnailForMime(sourceMime)) {
    return;
  }
  ensureThumbnailVariant(absolutePath)
    .then((output) => log("thumbnail-warmup-done", path.basename(output)))
    .catch((error) => logWarn("thumbnail-warmup-failed", error.message || error));
}

async function backfillMissingThumbnails(reason = "startup") {
  if (!enableTranscode || state.thumbnailBackfillRunning) {
    return;
  }

  state.thumbnailBackfillRunning = true;
  let candidateCount = 0;
  let failedCount = 0;
  try {
    const files = await scanFiles(storageRoot);
    const candidates = files.filter((file) => shouldGenerateThumbnailForMime(file.mimeType));
    candidateCount = candidates.length;
    logInfo("[thumbnail-backfill] begin", JSON.stringify({ reason, candidates: candidateCount }));
    for (const file of candidates) {
      try {
        const absolutePath = safeJoin(storageRoot, file.path);
        await ensureThumbnailVariant(absolutePath);
      } catch (error) {
        failedCount += 1;
        logWarn("thumbnail-backfill-file-failed", file.path, error?.message || error);
      }
    }
    logInfo("[thumbnail-backfill] done", JSON.stringify({ reason, candidates: candidateCount, failed: failedCount }));
  } catch (error) {
    logWarn("thumbnail-backfill-failed", reason, error?.message || error, JSON.stringify({ candidates: candidateCount, failed: failedCount }));
  } finally {
    state.thumbnailBackfillRunning = false;
  }
}

function scheduleThumbnailBackfill(reason = "startup") {
  setTimeout(() => {
    backfillMissingThumbnails(reason).catch((error) => {
      logWarn("thumbnail-backfill-schedule-failed", reason, error?.message || error);
    });
  }, 0);
}

async function generateVideoThumbnail(inputFile) {
  const tempDir = path.join(os.tmpdir(), "nas-bridge-transcode");
  await fs.promises.mkdir(tempDir, { recursive: true });
  const outputFile = path.join(tempDir, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.jpg`);
  let lastError = null;
  const durationSeconds = await getMediaDurationSeconds(inputFile, "thumbnail-duration");
  for (const seekSeconds of buildVideoThumbnailSeekCandidates(durationSeconds)) {
    try {
      await runThumbnailGeneration([
        "-y",
        "-ss",
        String(seekSeconds),
        "-i",
        inputFile,
        "-frames:v",
        "1",
        "-vf",
        "scale=640:-1",
        "-q:v",
        "4",
        outputFile
      ], inputFile, outputFile, `video-thumbnail@${seekSeconds}`);
      return outputFile;
    } catch (error) {
      lastError = error;
    }
  }

  try {
    await runThumbnailGeneration([
      "-y",
      "-i",
      inputFile,
      "-vf",
      "thumbnail=120,scale=640:-1",
      "-frames:v",
      "1",
      "-q:v",
      "4",
      outputFile
    ], inputFile, outputFile, "video-thumbnail-representative");
    return outputFile;
  } catch (error) {
    lastError = error;
  }

  throw lastError || new Error("video thumbnail generation failed");
}

async function generateImageThumbnail(inputFile) {
  const tempDir = path.join(os.tmpdir(), "nas-bridge-transcode");
  await fs.promises.mkdir(tempDir, { recursive: true });
  const outputFile = path.join(tempDir, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.jpg`);
  await runThumbnailGeneration([
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
  ], inputFile, outputFile, "image-thumbnail");

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

function normalizeRelativePath(value = "") {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function isSharePeer(remotePeerId = "") {
  return String(remotePeerId || "").startsWith("share:");
}

function verifyShareAccessToken(accessToken, permission, relativePath) {
  if (!shareJwtSecret) {
    throw new Error("share access requires JWT_SECRET on storage-client, and it must match server JWT_SECRET");
  }
  if (!accessToken) {
    throw new Error("share access token required");
  }
  const payload = jwt.verify(accessToken, shareJwtSecret);
  if (payload?.role !== "share" || payload?.type !== "share") {
    throw new Error("invalid share token");
  }
  if (payload?.clientId && state.clientId && payload.clientId !== state.clientId) {
    throw new Error("share token client mismatch");
  }
  const permissions = Array.isArray(payload?.permissions) ? payload.permissions : [];
  if (permission && !permissions.includes(permission)) {
    throw new Error("share permission denied");
  }
  const expectedPath = normalizeRelativePath(payload?.path || "");
  const actualPath = normalizeRelativePath(relativePath || "");
  if (expectedPath && actualPath && expectedPath !== actualPath) {
    throw new Error("share path denied");
  }
  return payload;
}

function ensureReadPermission(remotePeerId, message, permission, relativePath) {
  if (!isSharePeer(remotePeerId)) {
    return null;
  }
  return verifyShareAccessToken(message?.accessToken, permission, relativePath);
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
  const { files, directories } = await scanFiles(storageRoot);
  log("filesync-send", `files=${files.length}`, `dirs=${directories.length}`);
  await api("/api/client/filesync", {
    method: "POST",
    body: JSON.stringify({ files, directories })
  });
  logInfo(`File sync completed, files=${files.length}, dirs=${directories.length}`);
}

function buildPc(remotePeerId) {
  const pc = new RTCPeerConnection({
    iceServers,
    iceCandidatePoolSize
  });
  logInfo("[rtc] peer-create for", remotePeerId, "iceServers:", iceServers.map((s) => s.urls).flat().join(","));
  let cleanupTimer = null;
  let delayedCandidates = [];
  let delayedCandidateTimer = null;

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

  function scheduleDelayedCandidateFlush() {
    if (delayedCandidateTimer) {
      clearTimeout(delayedCandidateTimer);
      delayedCandidateTimer = null;
    }
    if (!delayedCandidates.length) {
      return;
    }
    const nextReleaseAt = delayedCandidates.reduce((min, entry) => Math.min(min, entry.releaseAt), delayedCandidates[0].releaseAt);
    delayedCandidateTimer = setTimeout(() => {
      flushDelayedCandidates();
    }, Math.max(0, nextReleaseAt - Date.now()));
  }

  function flushDelayedCandidates(force = false) {
    if (delayedCandidateTimer) {
      clearTimeout(delayedCandidateTimer);
      delayedCandidateTimer = null;
    }
    const now = Date.now();
    const pending = force
      ? delayedCandidates
      : delayedCandidates.filter((entry) => entry.releaseAt <= now);
    delayedCandidates = force
      ? []
      : delayedCandidates.filter((entry) => entry.releaseAt > now);
    for (const entry of pending) {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      try {
        state.ws.send(
          JSON.stringify({
            type: "signal",
            targetId: remotePeerId,
            payload: { kind: "ice", candidate: entry.candidate }
          })
        );
      } catch (error) {
        logWarn("ws send delayed ice failed:", error.message || error);
      }
    }
    if (delayedCandidates.length) {
      scheduleDelayedCandidateFlush();
    }
  }

  function sendIceCandidate(candidate) {
    const candidateType = extractCandidateType(candidate);
    const candidateAddress = extractCandidateAddress(candidate);
    if (candidateType === "host" && (isLoopbackCandidateAddress(candidateAddress) || isLinkLocalCandidateAddress(candidateAddress) || ignoredHostCandidateAddresses.has(candidateAddress))) {
      logInfo("[rtc] ice-candidate-skip", remotePeerId, candidateType, candidateAddress || "?");
      return;
    }
    const candidateDelayMs = getCandidateSignalDelayMs(candidateType);
    if (candidateDelayMs > 0) {
      delayedCandidates.push({ candidate, releaseAt: Date.now() + candidateDelayMs });
      scheduleDelayedCandidateFlush();
      logInfo("[rtc] ice-candidate-delay", remotePeerId, candidateType, candidateAddress || "?", `${candidateDelayMs}ms`);
      return;
    }
    if (!state.ws) {
      return;
    }
    if (state.ws.readyState === WebSocket.OPEN) {
      try {
        state.ws.send(
          JSON.stringify({
            type: "signal",
            targetId: remotePeerId,
            payload: { kind: "ice", candidate }
          })
        );
      } catch (error) {
        logWarn("ws send ice failed:", error.message || error);
      }
    }
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
      flushDelayedCandidates(true);
      return;
    }
    const c = event.candidate;
    logInfo("[rtc] ice-candidate", remotePeerId, c.type, c.protocol, c.address || "?");
    sendIceCandidate(event.candidate);
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

    if (isSharePeer(remotePeerId) && ["put-file-cancel", "put-file-start", "put-file-end", "delete-file", "rename-file", "delete-folder", "rename-folder", "create-folder", "append-chat-message", "get-bot-catalog", "invoke-bot", "get-bot-job", "cancel-bot-job"].includes(message.type)) {
      safeSend(JSON.stringify({ type: "error", requestId: message.requestId, message: "share link is read-only" }), "share-read-only");
      return;
    }

    if (["get-bot-catalog", "invoke-bot", "get-bot-job", "cancel-bot-job"].includes(message.type)) {
      try {
        const runtime = await ensureBotRuntime();
        const response = await runtime.handleControlMessage(message);
        if (response) {
          safeSend(JSON.stringify(response), message.type);
        }
      } catch (error) {
        safeSend(JSON.stringify({ type: "error", requestId: message.requestId, message: error.message }), `${message.type}-error`);
      }
      return;
    }

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
        ensureReadPermission(remotePeerId, message, "preview", message.path);
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
        const hlsEntry = state.hlsIndex.get(hlsId);
        if (hlsEntry) {
          state.hlsIndex.set(hlsId, {
            ...hlsEntry,
            updatedAt: Date.now(),
            sourceRelativePath: normalizeRelativePath(message.path)
          });
          await touchHlsCacheEntry(hlsEntry.dir, {
            codec: hlsEntry.codec || "",
            sourceRelativePath: normalizeRelativePath(message.path)
          });
        }

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
        ensureReadPermission(remotePeerId, message, "preview", hlsEntry.sourceRelativePath || "");
        hlsEntry.updatedAt = Date.now();
        await touchHlsCacheEntry(hlsEntry.dir, {
          codec: hlsEntry.codec || "",
          sourceRelativePath: hlsEntry.sourceRelativePath || ""
        });

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
        const requiredPermission = message.type === "get-file" ? "download" : "preview";
        ensureReadPermission(remotePeerId, message, requiredPermission, message.path);
        const absolute = safeJoin(storageRoot, message.path);
        let streamPath = absolute;
        let streamMime = mime.lookup(absolute) || "application/octet-stream";
        let cleanupPath = null;
        let cleanupIsTemporary = false;

        if (message.type === "get-thumbnail") {
          observeVariant = "thumbnail";
          const sourceMime = mime.lookup(absolute) || "application/octet-stream";
          if (String(sourceMime).startsWith("video/")) {
            if (!enableTranscode) {
              throw new Error("thumbnail for video requires ffmpeg (ENABLE_TRANSCODE!=0)");
            }
            cleanupPath = await ensureThumbnailVariant(absolute);
            streamPath = cleanupPath;
            streamMime = "image/jpeg";
          } else if (String(sourceMime).startsWith("image/")) {
            if (enableTranscode) {
              cleanupPath = await ensureThumbnailVariant(absolute);
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
          cleanupIsTemporary = true;
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
          cleanupIsTemporary = true;
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
          if (cleanupPath && cleanupIsTemporary) {
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
          if (cleanupPath && cleanupIsTemporary) {
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
        const sourceMime = mime.lookup(uploadCtx.path) || "application/octet-stream";
        const relativeUploadPath = normalizeRelativePath(path.relative(storageRoot, uploadCtx.path));
        if (/^video\//i.test(String(sourceMime)) || /^image\//i.test(String(sourceMime)) || shouldWarmChatMedia(relativeUploadPath, uploadCtx.received, sourceMime)) {
          scheduleThumbnailWarmup(uploadCtx.path);
        }
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

    if (message.type === "rename-file") {
      logInfo("[dc] recv rename-file", channel.label, message.requestId, message.path, "->", message.nextPath);
      try {
        if (!message.path || !message.nextPath) {
          throw new Error("path and nextPath are required");
        }
        const absolute = safeJoin(storageRoot, message.path);
        const nextAbsolute = safeJoin(storageRoot, message.nextPath);
        const uploading = [...state.uploads.values()].some((ctx) => ctx?.path === absolute || ctx?.path === nextAbsolute);
        if (uploading) {
          throw new Error("file is uploading");
        }
        await fs.promises.mkdir(path.dirname(nextAbsolute), { recursive: true });
        await fs.promises.rename(absolute, nextAbsolute);
        await syncFiles();
        safeSend(JSON.stringify({ type: "rename-file-result", requestId: message.requestId, ok: true, path: message.nextPath }), "rename-file-ok");
      } catch (error) {
        safeSend(
          JSON.stringify({
            type: "rename-file-result",
            requestId: message.requestId,
            ok: false,
            message: error.message
          }),
          "rename-file-error"
        );
      }
    }

    if (message.type === "delete-folder") {
      logInfo("[dc] recv delete-folder", channel.label, message.requestId, message.path);
      try {
        if (!message.path) {
          throw new Error("path is required");
        }
        const absolute = safeJoin(storageRoot, message.path);
        const normalizedAbsolute = path.resolve(absolute);
        const uploading = [...state.uploads.values()].some((ctx) => {
          const uploadPath = ctx?.path ? path.resolve(ctx.path) : "";
          return uploadPath === normalizedAbsolute || uploadPath.startsWith(`${normalizedAbsolute}${path.sep}`);
        });
        if (uploading) {
          throw new Error("folder is uploading");
        }
        await fs.promises.rm(absolute, { recursive: true, force: true });
        await syncFiles();
        safeSend(JSON.stringify({ type: "delete-folder-result", requestId: message.requestId, ok: true, path: message.path }), "delete-folder-ok");
      } catch (error) {
        safeSend(
          JSON.stringify({
            type: "delete-folder-result",
            requestId: message.requestId,
            ok: false,
            message: error.message
          }),
          "delete-folder-error"
        );
      }
      return;
    }

    if (message.type === "rename-folder") {
      logInfo("[dc] recv rename-folder", channel.label, message.requestId, message.path, "->", message.nextPath);
      try {
        if (!message.path || !message.nextPath) {
          throw new Error("path and nextPath are required");
        }
        const absolute = safeJoin(storageRoot, message.path);
        const nextAbsolute = safeJoin(storageRoot, message.nextPath);
        const normalizedAbsolute = path.resolve(absolute);
        const normalizedNextAbsolute = path.resolve(nextAbsolute);
        const uploading = [...state.uploads.values()].some((ctx) => {
          const uploadPath = ctx?.path ? path.resolve(ctx.path) : "";
          return uploadPath === normalizedAbsolute
            || uploadPath.startsWith(`${normalizedAbsolute}${path.sep}`)
            || uploadPath === normalizedNextAbsolute
            || uploadPath.startsWith(`${normalizedNextAbsolute}${path.sep}`);
        });
        if (uploading) {
          throw new Error("folder is uploading");
        }
        await fs.promises.mkdir(path.dirname(nextAbsolute), { recursive: true });
        await fs.promises.rename(absolute, nextAbsolute);
        await syncFiles();
        safeSend(JSON.stringify({ type: "rename-folder-result", requestId: message.requestId, ok: true, path: message.nextPath }), "rename-folder-ok");
      } catch (error) {
        safeSend(
          JSON.stringify({
            type: "rename-folder-result",
            requestId: message.requestId,
            ok: false,
            message: error.message
          }),
          "rename-folder-error"
        );
      }
      return;
    }

    if (message.type === "append-chat-message") {
      logInfo("[dc] recv append-chat-message", channel.label, message.requestId, message.path);
      try {
        const relativePath = await appendChatHistoryEntry(message.path, message.entry);
        safeSend(JSON.stringify({ type: "chat-append-result", requestId: message.requestId, ok: true, path: relativePath }), "chat-append-result");
      } catch (error) {
        safeSend(
          JSON.stringify({
            type: "chat-append-result",
            requestId: message.requestId,
            ok: false,
            message: error.message
          }),
          "chat-append-error"
        );
      }
      return;
    }

    if (message.type === "create-folder") {
      logInfo("[dc] recv create-folder", channel.label, message.requestId, message.path);
      try {
        if (!String(message.path || "").trim()) {
          throw new Error("folder path is required");
        }
        const absolute = safeJoin(storageRoot, message.path);
        await fs.promises.mkdir(absolute, { recursive: true });
        await syncFiles();
        safeSend(JSON.stringify({ type: "create-folder-result", requestId: message.requestId, ok: true, path: message.path }), "create-folder-ok");
      } catch (error) {
        safeSend(
          JSON.stringify({
            type: "create-folder-result",
            requestId: message.requestId,
            ok: false,
            message: error.message || "create folder failed"
          }),
          "create-folder-error"
        );
      }
      return;
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
  await runWithStartupRetry(() => ensureBotRuntime(), "bot-runtime-init");
  await runWithStartupRetry(() => syncFiles(), "filesync-init");
  await runWithStartupRetry(() => connectWs(), "ws-connect");
  await cleanupExpiredCacheEntries();
  scheduleThumbnailBackfill("startup");
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
