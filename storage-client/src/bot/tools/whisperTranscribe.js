import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const WHISPER_CPP_DEFAULT = "whisper";
const WHISPER_DEFAULT_LANGUAGE = "auto";

function getWhisperCppPath() {
  return String(process.env.WHISPER_CPP_PATH || "").trim() || WHISPER_CPP_DEFAULT;
}

function getWhisperModelPath() {
  return String(process.env.WHISPER_MODEL_PATH || "").trim();
}

function getWhisperLanguage() {
  return String(process.env.WHISPER_LANGUAGE || "").trim() || WHISPER_DEFAULT_LANGUAGE;
}

function spawnWithAbort(command, args, spawnOptions, signal) {
  const proc = spawn(command, args, spawnOptions);
  if (signal) {
    const onAbort = () => {
      try {
        proc.kill("SIGTERM");
      } catch {}
    };
    signal.addEventListener("abort", onAbort, { once: true });
    proc.on("close", () => {
      signal.removeEventListener("abort", onAbort);
    });
  }
  return proc;
}

/**
 * Extract audio from a video file using ffmpeg, producing a 16kHz mono WAV
 * suitable for whisper.cpp transcription.
 * @param {string} videoPath  Absolute path to the input video file
 * @param {string} outputDir  Directory to write the extracted WAV file to
 * @param {{ ffmpegPath?: string, signal?: AbortSignal }} options
 * @returns {Promise<string>} Absolute path to the produced .wav file
 */
export async function extractAudioWithFfmpeg(videoPath, outputDir, options = {}) {
  const ffmpegPath = String(options.ffmpegPath || process.env.FFMPEG_PATH || "").trim() || "ffmpeg";
  const signal = options.signal || null;

  await fs.promises.mkdir(outputDir, { recursive: true });
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const outputPath = path.join(outputDir, `${baseName}.wav`);

  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(Object.assign(new Error("job cancelled"), { name: "AbortError" }));
    }
    const proc = spawnWithAbort(ffmpegPath, [
      "-y",
      "-i", videoPath,
      "-vn",
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "pcm_s16le",
      outputPath
    ], { stdio: ["ignore", "ignore", "pipe"] }, signal);

    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => {
      reject(new Error(`ffmpeg launch failed: ${error.message}`));
    });
    proc.on("close", async (code) => {
      if (signal?.aborted) {
        return;
      }
      if (code !== 0) {
        return reject(new Error(`ffmpeg audio extraction failed (code ${code}): ${stderr.slice(-400)}`));
      }
      try {
        const stat = await fs.promises.stat(outputPath);
        if (Number(stat.size || 0) <= 0) {
          return reject(new Error("ffmpeg produced empty audio output"));
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });

  return outputPath;
}

/**
 * Transcribe an audio file using whisper.cpp and produce an SRT file.
 * @param {string} audioPath   Absolute path to the WAV audio file
 * @param {string} outputDir   Directory to write the .srt file to
 * @param {{ whisperCppPath?: string, modelPath?: string, language?: string, signal?: AbortSignal }} options
 * @returns {Promise<string>} Absolute path to the produced .srt file
 */
export async function transcribeWithWhisperCpp(audioPath, outputDir, options = {}) {
  const whisperCppPath = String(options.whisperCppPath || "").trim() || getWhisperCppPath();
  const modelPath = String(options.modelPath || "").trim() || getWhisperModelPath();
  const language = String(options.language || "").trim() || getWhisperLanguage();
  const signal = options.signal || null;

  if (!modelPath) {
    throw new Error(
      "WHISPER_MODEL_PATH environment variable is required for whisper.cpp transcription. " +
      "Set it to the path of your ggml model file, e.g. /path/to/ggml-medium.bin"
    );
  }

  await fs.promises.mkdir(outputDir, { recursive: true });
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const outputBase = path.join(outputDir, baseName);

  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(Object.assign(new Error("job cancelled"), { name: "AbortError" }));
    }
    const proc = spawnWithAbort(whisperCppPath, [
      "-m", modelPath,
      "-f", audioPath,
      "-l", language,
      "--output-srt",
      "-of", outputBase
    ], { stdio: ["ignore", "pipe", "pipe"] }, signal);

    let output = "";
    proc.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.on("error", (error) => {
      reject(new Error(`whisper.cpp launch failed: ${error.message}`));
    });
    proc.on("close", async (code) => {
      if (signal?.aborted) {
        return;
      }
      if (code !== 0) {
        return reject(new Error(`whisper.cpp transcription failed (code ${code}): ${output.slice(-600)}`));
      }
      const srtPath = `${outputBase}.srt`;
      try {
        const stat = await fs.promises.stat(srtPath);
        if (Number(stat.size || 0) <= 0) {
          return reject(new Error("whisper.cpp produced empty SRT output"));
        }
        resolve();
      } catch {
        reject(new Error(`whisper.cpp did not produce expected .srt file at ${srtPath}`));
      }
    });
  });

  return `${outputBase}.srt`;
}

/**
 * Read an SRT subtitle file and return plain transcript text with timing markers stripped.
 * @param {string} srtPath    Absolute path to the .srt file
 * @param {{ maxChars?: number }} options
 * @returns {Promise<string>} Plain text transcript
 */
export async function readTranscriptAsPlainText(srtPath, options = {}) {
  const maxChars = Number(options.maxChars || 0) || 120_000;
  const raw = await fs.promises.readFile(srtPath, "utf-8");
  const textLines = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (/^\d+$/.test(trimmed)) {
      continue;
    }
    if (/^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(trimmed)) {
      continue;
    }
    textLines.push(trimmed);
  }
  const text = textLines.join(" ").replace(/\s+/g, " ").trim();
  return maxChars > 0 && text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
