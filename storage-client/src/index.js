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
const enableTranscode = process.env.ENABLE_TRANSCODE !== "0";
const previewCacheDirName = process.env.PREVIEW_CACHE_DIR_NAME || ".nas-preview-cache";
const hlsCacheDirName = process.env.HLS_CACHE_DIR_NAME || ".nas-hls-cache";
const transcodeVideoCodec = process.env.TRANSCODE_VIDEO_CODEC || "auto";
const transcodePreferGpu = process.env.TRANSCODE_PREFER_GPU !== "0";
const wsReconnectDelayMs = Number(process.env.WS_RECONNECT_DELAY_MS || 3000);
const wsIdleTimeoutMs = Number(process.env.WS_IDLE_TIMEOUT_MS || 90_000);
const wsWatchdogIntervalMs = Number(process.env.WS_WATCHDOG_INTERVAL_MS || 10_000);

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
  hlsIndex: new Map()
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

function getCodecCandidates() {
  const preferred = String(transcodeVideoCodec || "auto").trim().toLowerCase();
  if (preferred && preferred !== "auto") {
    return preferred === "libx264" ? ["libx264"] : [preferred, "libx264"];
  }
  if (!transcodePreferGpu) {
    return ["libx264"];
  }
  return ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"];
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
      "p4",
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
      const proc = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "ignore"] });
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

async function runFfmpegWithCodecFallback(makeArgs, { context = "transcode", onProgress, onCodecSelected } = {}) {
  const candidates = getCodecCandidates();
  let lastError = null;
  for (const codec of candidates) {
    const args = makeArgs(codec);
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
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
      logWarn("ffmpeg-codec-failed", context, codec, error?.message || error);
    }
  }
  throw lastError || new Error(`ffmpeg ${context} failed`);
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
        const proc = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "ignore"] });
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
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
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
        const proc = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "ignore"] });
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

  const key = crypto
    .createHash("sha1")
    .update(`${inputFile}|${stat.size}|${stat.mtimeMs}`)
    .digest("hex");
  const outputFile = path.join(cacheDir, `${key}.preview.mp4`);

  try {
    await fs.promises.access(outputFile, fs.constants.R_OK);
    log("preview-cache-hit", path.basename(outputFile));
    return outputFile;
  } catch {
  }

  const existingJob = state.previewJobs.get(outputFile);
  if (existingJob) {
    return existingJob;
  }

  const job = (async () => {
    const tempFile = `${outputFile}.tmp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.mp4`;
    try {
      try {
        onProgress?.({ stage: "preparing", progress: 0, message: "正在快速重封装" });
        await remuxToFaststartMp4(inputFile, tempFile);
      } catch {
        await transcodeToPreviewMp4(inputFile, tempFile, onProgress);
      }
      await fs.promises.rename(tempFile, outputFile);
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

function buildAssetCacheKey(inputFile, stat, suffix = "") {
  return crypto
    .createHash("sha1")
    .update(`${inputFile}|${stat.size}|${stat.mtimeMs}|${suffix}`)
    .digest("hex");
}

async function generateSingleBitrateHls(inputFile, outputDir, onProgress) {
  await fs.promises.mkdir(outputDir, { recursive: true });
  const playlistPath = path.join(outputDir, "index.m3u8");
  const segmentPattern = path.join(outputDir, "seg-%05d.ts");
  onProgress?.({ stage: "preparing", progress: 0, message: "正在生成 HLS 预览" });

  // Optimisation: if the source is already H.264 at ≤ 720p we can mux directly
  // into HLS segments without re-encoding.  GPU/CPU usage drops to near zero.
  const videoInfo = await probeVideoStream(inputFile);
  const canCopy =
    videoInfo?.codec === "h264" &&
    videoInfo.height > 0 &&
    videoInfo.height <= 720;

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
        const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        proc.on("error", (err) => reject(new Error(`ffmpeg launch failed: ${err.message}`)));
        proc.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg hls-copy failed: ${stderr.slice(-300)}`));
        });
      });
      onProgress?.({ stage: "done", progress: 100, message: "HLS 预览已就绪（直接复制）", codec: "copy" });
      return { playlistPath, codec: "copy" };
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
      // For NVIDIA nvenc, pass hardware decode flags on the input side so the
      // entire decode→encode pipeline stays in GPU memory (no CPU↔VRAM copies).
      const hwaccelArgs =
        codec === "h264_nvenc"
          ? ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
          : [];
      return [
        "-y",
        ...hwaccelArgs,
        "-i",
        inputFile,
        "-vf",
        codec === "h264_nvenc" ? "scale_cuda=-2:720" : "scale=-2:720",
        "-pix_fmt",
        codec === "h264_nvenc" ? "yuv420p" : "yuv420p",
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
      onCodecSelected: (codec) => {
        selectedCodec = codec;
      },
      onProgress: () => {
        onProgress?.({ stage: "transcoding", progress: null, message: "正在切分视频片段" });
      }
    }
  );

  onProgress?.({ stage: "done", progress: 100, message: "HLS 预览已就绪", codec: selectedCodec || "libx264" });
  return { playlistPath, codec: selectedCodec || "libx264" };
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

  const hlsId = buildAssetCacheKey(inputFile, stat, `hls:${profile}`);
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
    return await ensureAndReadManifest();
  } catch {
  }

  const runningJob = state.hlsJobs.get(hlsId);
  if (runningJob) {
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
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    const hlsResult = await generateSingleBitrateHls(inputFile, tempDir, broadcastProgress);
    await fs.promises.writeFile(path.join(tempDir, "meta.json"), JSON.stringify({ codec: hlsResult.codec || "" }, null, 2));
    await fs.promises.rm(outputDir, { recursive: true, force: true });
    await fs.promises.rename(tempDir, outputDir);
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
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
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
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
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
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
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
      return await task();
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

  pc.oniceconnectionstatechange = () => {
    logInfo("[rtc] ice-state", remotePeerId, pc.iceConnectionState);
  };

  pc.onconnectionstatechange = () => {
    logInfo("[rtc] conn-state", remotePeerId, pc.connectionState);
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
    wireDataChannel(event.channel);
  };

  return pc;
}

function wireDataChannel(channel) {
  channel.binaryType = "arraybuffer";
  logInfo("[dc] wiring channel", channel.label, `readyState=${channel.readyState}`);

  channel.onopen = () => {
    logInfo("[dc] channel open", channel.label);
  };
  channel.onclose = () => {
    logInfo("[dc] channel close", channel.label);
  };
  channel.onerror = (ev) => {
    logWarn("[dc] channel error", channel.label, ev?.error?.message || "");
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
      const uploadCtx = state.uploads.get(channel.label);
      if (!uploadCtx) {
        return;
      }
      uploadCtx.stream.write(Buffer.from(event.data));
      uploadCtx.received += event.data.byteLength;
      return;
    }

    const message = JSON.parse(event.data);

    if (message.type === "ping") {
      safeSend(JSON.stringify({ type: "pong", ts: message.ts }), "pong");
      return;
    }

    if (message.type === "put-file-cancel") {
      const entry = findUploadCtxByRequestId(message.requestId) || (state.uploads.has(channel.label)
        ? { label: channel.label, ctx: state.uploads.get(channel.label) }
        : null);
      if (!entry?.ctx) {
        return;
      }
      try {
        entry.ctx.stream?.destroy();
      } catch {
      }
      state.uploads.delete(entry.label);
      if (entry.ctx.path) {
        fs.promises.rm(entry.ctx.path, { force: true }).catch(() => {});
      }
      safeSend(
        JSON.stringify({ type: "put-file-cancelled", requestId: entry.ctx.requestId, path: message.path || "" }),
        "put-file-cancelled"
      );
      return;
    }

    if (message.type === "get-hls-manifest") {
      logInfo("[dc] recv get-hls-manifest", channel.label, message.requestId, message.path);
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
      } catch (error) {
        log("error", message.type, message.requestId, error.message);
        safeSend(JSON.stringify({ type: "error", requestId: message.requestId, message: error.message }), "hls-manifest-error");
      }
      return;
    }

    if (message.type === "get-hls-segment") {
      logInfo("[dc] recv get-hls-segment", channel.label, message.requestId, `${message.hlsId}/${message.segment}`);
      try {
        if (!message.hlsId || !message.segment) {
          throw new Error("hlsId and segment are required");
        }
        const hlsEntry = state.hlsIndex.get(message.hlsId);
        if (!hlsEntry) {
          throw new Error("hls preview cache miss");
        }

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
          await waitForDrain("hls-segment");
          if (!safeSend(chunk, "hls-segment")) {
            throw new Error("datachannel closed while streaming hls segment");
          }
        }
        safeSend(JSON.stringify({ type: "file-end", requestId: message.requestId }), "hls-segment-end");
      } catch (error) {
        log("error", message.type, message.requestId, error.message);
        safeSend(JSON.stringify({ type: "error", requestId: message.requestId, message: error.message }), "hls-segment-error");
      }
      return;
    }

    if (message.type === "get-file" || message.type === "get-file-stream" || message.type === "get-thumbnail" || message.type === "get-image-preview") {
      logInfo("[dc] recv", message.type, channel.label, message.requestId, message.path);
      try {
        const absolute = safeJoin(storageRoot, message.path);
        let streamPath = absolute;
        let streamMime = mime.lookup(absolute) || "application/octet-stream";
        let cleanupPath = null;

        if (message.type === "get-thumbnail") {
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
            await waitForDrain("file-chunk");
            if (!safeSend(chunk, "file-chunk")) {
              throw new Error("datachannel closed while streaming");
            }
          }
          log("response", "file-end", message.requestId, message.path);
          safeSend(JSON.stringify({ type: "file-end", requestId: message.requestId }), "file-end");
        } catch (error) {
          log("error", "stream", message.requestId, error.message);
          safeSend(JSON.stringify({ type: "error", requestId: message.requestId, message: error.message }), "stream-error");
        } finally {
          if (cleanupPath) {
            fs.promises.rm(cleanupPath, { force: true }).catch(() => {});
          }
        }
      } catch (error) {
        log("error", message.type, message.requestId, error.message);
        safeSend(JSON.stringify({ type: "error", requestId: message.requestId, message: error.message }), "request-error");
      }
      return;
    }

    if (message.type === "put-file-start") {
      logInfo("[dc] recv put-file-start", channel.label, message.requestId, message.path, `size=${message.size}`);
      try {
        const absolute = safeJoin(storageRoot, message.path);
        await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
        const stream = fs.createWriteStream(absolute);
        const ctx = {
          requestId: message.requestId,
          path: absolute,
          stream,
          expected: Number(message.size || 0),
          received: 0
        };
        state.uploads.set(channel.label, ctx);
        stream.once("error", (error) => {
          logWarn("upload-stream-error", message.requestId, error.message || error);
          state.uploads.delete(channel.label);
          safeSend(
            JSON.stringify({ type: "error", requestId: message.requestId, message: error.message }),
            "put-file-stream-error"
          );
          fs.promises.rm(absolute, { force: true }).catch(() => {});
        });
        safeSend(JSON.stringify({ type: "put-file-ack", requestId: message.requestId, path: message.path }), "put-file-ack");
      } catch (error) {
        safeSend(JSON.stringify({ type: "error", requestId: message.requestId, message: error.message }), "put-file-start-error");
      }
      return;
    }

    if (message.type === "put-file-end") {
      const uploadCtx = state.uploads.get(channel.label);
      if (!uploadCtx) {
        return;
      }
      if (uploadCtx.requestId && message.requestId && uploadCtx.requestId !== message.requestId) {
        return;
      }
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
        state.uploads.delete(channel.label);
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
    wsReconnectDelayMs,
    wsIdleTimeoutMs
  });

  if (!fs.existsSync(storageRoot)) {
    logWarn(`[startup] storage root not found, creating: ${storageRoot}`);
    await fs.promises.mkdir(storageRoot, { recursive: true });
  }

  await checkServerHealth();
  await runWithStartupRetry(() => ensureRegistered(), "register");
  await runWithStartupRetry(() => heartbeat(), "heartbeat-init");
  await runWithStartupRetry(() => syncFiles(), "filesync-init");
  await runWithStartupRetry(() => connectWs(), "ws-connect");

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
}

main().catch((error) => {
  logError("fatal main error:", error.message || error);
});
