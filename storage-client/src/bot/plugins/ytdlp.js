import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createBotJobMessageId } from "../context.js";
import { importFileIntoLibrary, triggerLibraryRescan } from "../tools/libraryImport.js";
import { createBotPlugin } from "./base.js";

const ytDlpPath = process.env.YT_DLP_PATH || "yt-dlp";
const ytDlpImportDir = process.env.YTDLP_IMPORT_DIR || "downloads/ytdlp";

// ──────────────────────────────────────────────
// yt-dlp process helpers
// ──────────────────────────────────────────────

async function runYtDlp(args, { cwd, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onOutput?.(text, "stdout");
    });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onOutput?.(text, "stderr");
    });
    proc.on("error", (error) => {
      reject(new Error(`failed to start yt-dlp (${ytDlpPath}): ${error.message || error}`));
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}: ${(stderr || stdout).trim() || "unknown error"}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function readYtDlpProgress(text = "") {
  const matches = [...String(text || "").matchAll(/\[download\]\s+(\d+(?:\.\d+)?)%/gi)];
  const rawValue = matches.length ? matches[matches.length - 1]?.[1] : "";
  const percent = Number(rawValue);
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;
}

function detectYtDlpPhase(text = "") {
  const value = String(text || "");
  if (/\[download\].*Destination:/i.test(value)) {
    return { phase: "download-remote", label: "下载视频中", percent: 12 };
  }
  if (/\[Merger\]|Merging formats/i.test(value)) {
    return { phase: "postprocess", label: "合并中", percent: 88 };
  }
  if (/\[ExtractAudio\]|Extracting audio/i.test(value)) {
    return { phase: "download-remote", label: "下载音频中", percent: 78 };
  }
  if (/\[Metadata\]|Adding metadata/i.test(value)) {
    return { phase: "postprocess", label: "整理元数据中", percent: 92 };
  }
  if (/\[MoveFiles\]|after_move:filepath/i.test(value)) {
    return { phase: "postprocess", label: "收尾处理中", percent: 94 };
  }
  return null;
}

async function findNewestDownloadedFile(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && !/\.part$|\.ytdl$/.test(e.name));
    if (!files.length) {
      return null;
    }
    const withStats = await Promise.all(
      files.map(async (e) => {
        const fullPath = path.join(dir, e.name);
        const stat = await fs.promises.stat(fullPath).catch(() => null);
        return { fullPath, mtime: stat?.mtimeMs || 0 };
      })
    );
    withStats.sort((a, b) => b.mtime - a.mtime);
    return withStats[0]?.fullPath || null;
  } catch {
    return null;
  }
}

// A multi-video post (e.g. an X post with three videos) prints one
// after_move:filepath line per entry, so collect all of them in order.
export function detectPrintedFilePaths(lines, tempDir, exists = fs.existsSync) {
  const found = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(tempDir) || path.isAbsolute(trimmed)) {
      try {
        if (exists(trimmed) && !found.includes(trimmed)) found.push(trimmed);
      } catch { /* ignore */ }
    }
  }
  return found;
}

export function isXPostUrl(url = "") {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^(www\.|mobile\.)/, "");
    return ["x.com", "twitter.com"].includes(host);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────
// Format selector
// ──────────────────────────────────────────────

function buildFormatSelector(quality = "") {
  const q = String(quality || "").trim().toLowerCase();
  if (!q || ["max", "best", "最高", "默认"].includes(q)) {
    return "bv*+ba/b";
  }
  const heightMap = new Map([
    ["8k", 4320],
    ["2160p", 2160],
    ["4k", 2160],
    ["1080p60", 1080],
    ["1080p+", 1080],
    ["1080p", 1080],
    ["720p60", 720],
    ["720p", 720],
    ["480p", 480],
    ["360p", 360]
  ]);
  const maxHeight = heightMap.get(q) || 0;
  if (!maxHeight) {
    return "bv*+ba/b";
  }
  return `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/b`;
}

// ──────────────────────────────────────────────
// Metadata probe (JSON dump)
// ──────────────────────────────────────────────

async function fetchMetadata(url, tempDir) {
  const args = ["--dump-json", "--no-playlist", "--skip-download", url];
  const { stdout } = await runYtDlp(args, { cwd: tempDir });
  try {
    const lines = stdout.trim().split(/\r?\n/);
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return {};
  }
}

// ──────────────────────────────────────────────
// Main download function
// ──────────────────────────────────────────────

async function downloadWithYtDlp(url, tempDir, api, { quality } = {}) {
  const outputTemplate = path.join(tempDir, "%(title).120B [%(id)s].%(ext)s");
  const args = ["--newline", "--print", "after_move:filepath", "-o", outputTemplate];
  // Keep every video of an X post, even for .../status/<id>/video/1 links;
  // other sites stay single-video so playlist URLs don't pull a whole playlist.
  if (!isXPostUrl(url)) {
    args.push("--no-playlist");
  }

  if (api.dependencies?.ffmpegPath && /[\\/]/.test(String(api.dependencies.ffmpegPath))) {
    args.push("--ffmpeg-location", path.dirname(String(api.dependencies.ffmpegPath)));
  }
  if (quality) {
    args.push("-f", buildFormatSelector(quality));
  }
  args.push(url);

  let currentPercent = 10;
  let currentPhasePercent = 10;
  const result = await runYtDlp(args, {
    cwd: tempDir,
    onOutput: async (text) => {
      const nextPercent = readYtDlpProgress(text);
      if (nextPercent !== null && nextPercent !== currentPercent) {
        currentPercent = nextPercent;
        await api.emitProgress({
          phase: "download-remote",
          label: "下载视频中",
          percent: Math.max(12, Math.min(86, 12 + Math.round(nextPercent * 0.74)))
        });
        return;
      }
      const phaseUpdate = detectYtDlpPhase(text);
      if (phaseUpdate && phaseUpdate.percent > currentPhasePercent) {
        currentPhasePercent = phaseUpdate.percent;
        await api.emitProgress(phaseUpdate);
      }
    }
  });

  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const printedPaths = detectPrintedFilePaths(lines, tempDir);
  const fallbackPath = printedPaths.length ? null : await findNewestDownloadedFile(tempDir);
  const downloadedPaths = printedPaths.length ? printedPaths : [fallbackPath].filter(Boolean);
  if (!downloadedPaths.length) {
    throw new Error("yt-dlp completed but downloaded file path was not detected");
  }
  for (const downloadedPath of downloadedPaths) {
    await api.appendLog(`downloaded file: ${downloadedPath}`);
  }
  return downloadedPaths.map((p) => path.resolve(p));
}

// ──────────────────────────────────────────────
// Plugin export
// ──────────────────────────────────────────────

function cleanUrlCandidate(value = "") {
  return String(value || "")
    .trim()
    .replace(/^[<([{]+/g, "")
    .replace(/[>\])}.,，。;；!?！？]+$/g, "");
}

function extractFirstHttpUrl(value = "") {
  const match = String(value || "").match(/https?:\/\/[^\s<>"']+/i);
  return cleanUrlCandidate(match?.[0] || "");
}

export function resolveYtDlpSourceUrl(context = {}) {
  const parsedArgs = context?.trigger?.parsedArgs || {};
  const direct = cleanUrlCandidate(parsedArgs.url || parsedArgs.source || parsedArgs.sourceUrl || "");
  if (direct) {
    return direct;
  }
  return extractFirstHttpUrl(context?.trigger?.rawText || "");
}

export function createYtDlpDownloaderPlugin() {
  return createBotPlugin({
    botId: "ytdlp.downloader",
    displayName: "yt-dlp Downloader",
    aliases: ["ytdlp", "yt-dlp", "x", "twitter"],
    description: "Download videos from X (Twitter), YouTube, and 1000+ other sites using yt-dlp.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "视频页面 URL" },
        targetFolder: { type: "string", description: "目标文件夹（相对于存储根目录）" },
        quality: { type: "string", description: "画质，例如 1080p、720p、最高" }
      }
    },
    capabilities: ["download.remote-media", "import.library"],
    permissions: {
      writeLibrary: true,
      outboundHttp: true,
      spawnProcess: true,
      publishJobEvents: true
    },
    limits: {
      maxConcurrentJobs: 2,
      timeoutMs: 60 * 60 * 1000,
      maxDownloadBytes: 10 * 1024 * 1024 * 1024
    },
    async execute(context, api) {
      const url = resolveYtDlpSourceUrl(context);
      if (!url || !/^https?:\/\//i.test(url)) {
        throw new Error("请提供有效的视频 URL（以 http:// 或 https:// 开头）");
      }
      const quality = String(context?.trigger?.parsedArgs?.quality || "").trim();
      const targetFolder = String(
        context?.trigger?.parsedArgs?.targetFolder || ytDlpImportDir
      ).trim();

      const tempDir = path.join(api.appDataRoot, "temp", context.jobId);
      await fs.promises.mkdir(tempDir, { recursive: true });

      try {
        await api.emitProgress({ phase: "parse-input", label: "解析视频信息…", percent: 5 });
        await api.appendLog(`ytdlp source: ${url}`);

        // Probe metadata (best-effort, 15s timeout)
        let metadata = {};
        try {
          metadata = await Promise.race([
            fetchMetadata(url, tempDir),
            new Promise((resolve) => setTimeout(() => resolve({}), 15000))
          ]);
          if (metadata?.title) {
            await api.appendLog(`metadata title: ${metadata.title}`);
          }
        } catch (err) {
          await api.appendLog(`metadata probe failed: ${err.message || err}`);
        }

        await api.emitProgress({ phase: "download-remote", label: "开始下载…", percent: 10 });
        const downloadedPaths = await downloadWithYtDlp(url, tempDir, api, { quality });

        await api.emitProgress({ phase: "import", label: "入库中…", percent: 90 });
        const storageRoot = path.resolve(api.storageRoot || process.cwd());
        const importedFiles = [];
        for (const downloadedPath of downloadedPaths) {
          importedFiles.push(await importFileIntoLibrary({
            storageRoot,
            sourcePath: downloadedPath,
            targetFolder,
            fileName: path.basename(downloadedPath)
          }));
        }
        const imported = importedFiles[0];

        await triggerLibraryRescan({ syncFiles: api.dependencies?.syncFiles });
        await api.emitProgress({ phase: "done", label: "下载完成", percent: 100 });

        const title = String(metadata?.title || imported.fileName || "").slice(0, 80) || url;
        const uploader = String(metadata?.uploader || metadata?.channel || "").trim();
        const subtitle = [uploader, imported.relativePath].filter(Boolean).join(" · ");
        // The first file keeps the original id so single-video replies are unchanged.
        const attachmentIds = importedFiles.map((_, index) => (
          index === 0 ? `bot-asset:${context.jobId}` : `bot-asset:${context.jobId}:${index + 1}`
        ));
        const attachmentId = attachmentIds[0];
        const body = importedFiles.length > 1
          ? `已入库 ${importedFiles.length} 个文件到 ${path.posix.dirname(imported.relativePath || imported.fileName)}`
          : `已入库到 ${imported.relativePath || imported.fileName}`;
        const card = {
          type: "media-result",
          status: "succeeded",
          title,
          subtitle,
          body,
          progress: null,
          imageUrl: String(metadata?.thumbnail || ""),
          imageAlt: "",
          mediaAttachmentId: attachmentId,
          sourceLabel: url,
          sourceUrl: url,
          actions: [
            { type: "open-attachment", label: "打开资源", attachmentId },
            { type: "open-url", label: "打开来源", url }
          ]
        };
        await api.emitProgress({ phase: "append-chat-reply", label: "生成结果卡片", percent: 95 });
        const chatReply = await api.publishChatReply({
          id: createBotJobMessageId(context.jobId),
          createdAt: context.createdAt,
          text: "",
          attachments: importedFiles.map((file, index) => ({
            id: attachmentIds[index],
            name: file.fileName,
            mimeType: file.mimeType,
            size: file.size,
            path: file.relativePath,
            contentHash: file.contentHash || "",
            clientId: context?.chat?.hostClientId || "",
            kind: String(file.mimeType || "").startsWith("video/") ? "video" : "file"
          })),
          card
        });

        return {
          chatReply,
          importedFiles,
          artifacts: []
        };
      } finally {
        fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });
}
