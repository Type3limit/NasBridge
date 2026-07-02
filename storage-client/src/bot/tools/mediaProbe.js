import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function clampInteger(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
}

function compactString(value = "") {
  return String(value || "").trim();
}

export function formatDurationLabel(durationSeconds = 0) {
  const seconds = Math.max(0, Math.round(Number(durationSeconds || 0)));
  if (!seconds) {
    return "";
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function parseFrameRate(value = "") {
  const text = compactString(value);
  if (!text || text === "0/0") {
    return 0;
  }
  const [left, right] = text.split("/").map(Number);
  if (Number.isFinite(left) && Number.isFinite(right) && right > 0) {
    return Math.round((left / right) * 1000) / 1000;
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeTags(tags = {}) {
  const result = {};
  for (const [key, value] of Object.entries(tags || {})) {
    const normalizedKey = compactString(key);
    const normalizedValue = compactString(value);
    if (normalizedKey && normalizedValue) {
      result[normalizedKey] = normalizedValue;
    }
  }
  return result;
}

function normalizeVideoStream(stream = {}) {
  const width = toInteger(stream.width);
  const height = toInteger(stream.height);
  return {
    index: toInteger(stream.index),
    codecName: compactString(stream.codec_name),
    codecLongName: compactString(stream.codec_long_name),
    profile: compactString(stream.profile),
    width,
    height,
    resolution: width && height ? `${width}x${height}` : "",
    displayAspectRatio: compactString(stream.display_aspect_ratio),
    pixelFormat: compactString(stream.pix_fmt),
    frameRate: parseFrameRate(stream.avg_frame_rate || stream.r_frame_rate),
    durationSeconds: toNumber(stream.duration),
    bitRate: toInteger(stream.bit_rate),
    tags: normalizeTags(stream.tags)
  };
}

function normalizeAudioStream(stream = {}) {
  return {
    index: toInteger(stream.index),
    codecName: compactString(stream.codec_name),
    codecLongName: compactString(stream.codec_long_name),
    profile: compactString(stream.profile),
    channels: toInteger(stream.channels),
    channelLayout: compactString(stream.channel_layout),
    sampleRate: toInteger(stream.sample_rate),
    durationSeconds: toNumber(stream.duration),
    bitRate: toInteger(stream.bit_rate),
    language: compactString(stream.tags?.language),
    title: compactString(stream.tags?.title),
    tags: normalizeTags(stream.tags)
  };
}

function normalizeSubtitleStream(stream = {}) {
  return {
    index: toInteger(stream.index),
    codecName: compactString(stream.codec_name),
    codecLongName: compactString(stream.codec_long_name),
    language: compactString(stream.tags?.language),
    title: compactString(stream.tags?.title),
    tags: normalizeTags(stream.tags)
  };
}

function normalizeProbeJson(payload = {}) {
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const format = payload.format && typeof payload.format === "object" ? payload.format : {};
  const videoStreams = streams.filter((stream) => stream.codec_type === "video").map(normalizeVideoStream);
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio").map(normalizeAudioStream);
  const subtitleStreams = streams.filter((stream) => stream.codec_type === "subtitle").map(normalizeSubtitleStream);
  const durationSeconds = toNumber(format.duration) || Math.max(
    0,
    ...videoStreams.map((stream) => stream.durationSeconds || 0),
    ...audioStreams.map((stream) => stream.durationSeconds || 0)
  );
  const primaryVideo = videoStreams.find((stream) => stream.width && stream.height) || videoStreams[0] || null;
  const primaryAudio = audioStreams[0] || null;
  return {
    durationSeconds,
    durationLabel: formatDurationLabel(durationSeconds),
    sizeBytes: toInteger(format.size),
    bitRate: toInteger(format.bit_rate),
    formatName: compactString(format.format_name),
    formatLongName: compactString(format.format_long_name),
    startTimeSeconds: toNumber(format.start_time),
    tags: normalizeTags(format.tags),
    videoTrackCount: videoStreams.length,
    audioTrackCount: audioStreams.length,
    subtitleTrackCount: subtitleStreams.length,
    resolution: primaryVideo?.resolution || "",
    width: primaryVideo?.width || 0,
    height: primaryVideo?.height || 0,
    primaryVideo,
    primaryAudio,
    videoStreams,
    audioStreams,
    subtitleStreams
  };
}

export async function probeMediaFile(options = {}) {
  const filePath = compactString(options.filePath || options.absolutePath || options.path);
  if (!filePath) {
    throw new Error("filePath is required");
  }
  const ffprobePath = compactString(options.ffprobePath || process.env.FFPROBE_PATH || "ffprobe") || "ffprobe";
  const args = [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath
  ];
  try {
    const { stdout } = await execFileAsync(ffprobePath, args, {
      timeout: clampInteger(options.timeoutMs || 15_000, 1000, 120_000),
      maxBuffer: clampInteger(options.maxBuffer || 2 * 1024 * 1024, 256 * 1024, 16 * 1024 * 1024),
      windowsHide: true,
      signal: options.signal
    });
    return normalizeProbeJson(JSON.parse(stdout || "{}"));
  } catch (error) {
    const message = String(error?.stderr || error?.message || error || "ffprobe failed").trim();
    throw new Error(`ffprobe failed: ${message.slice(-500)}`);
  }
}

export async function extractMediaThumbnail(options = {}) {
  const filePath = compactString(options.filePath || options.absolutePath || options.path);
  const outputPath = compactString(options.outputPath);
  if (!filePath || !outputPath) {
    throw new Error("filePath and outputPath are required");
  }
  const ffmpegPath = compactString(options.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg") || "ffmpeg";
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const timestamp = compactString(options.timestamp || "00:00:01") || "00:00:01";
  const args = [
    "-y",
    "-ss", timestamp,
    "-i", filePath,
    "-frames:v", "1",
    "-vf", compactString(options.videoFilter || "scale='min(640,iw)':-2"),
    outputPath
  ];
  try {
    await execFileAsync(ffmpegPath, args, {
      timeout: clampInteger(options.timeoutMs || 30_000, 1000, 120_000),
      maxBuffer: clampInteger(options.maxBuffer || 1024 * 1024, 64 * 1024, 8 * 1024 * 1024),
      windowsHide: true,
      signal: options.signal
    });
    const stat = await fs.promises.stat(outputPath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error("ffmpeg produced empty thumbnail");
    }
    return {
      path: outputPath,
      size: stat.size,
      generatedAt: new Date().toISOString()
    };
  } catch (error) {
    const message = String(error?.stderr || error?.message || error || "ffmpeg failed").trim();
    throw new Error(`ffmpeg thumbnail extraction failed: ${message.slice(-500)}`);
  }
}
