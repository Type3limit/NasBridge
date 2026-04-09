import fs from "node:fs";
import path from "node:path";
import { invokeTextModel } from "../tools/llmClient.js";
import { triggerLibraryRescan } from "../tools/libraryImport.js";
import { extractAudioWithFfmpeg, readTranscriptAsPlainText, transcribeWithWhisperCpp } from "../tools/whisperTranscribe.js";
import { createBotPlugin } from "./base.js";

const BILIBILI_SOURCE_PATTERN = /https?:\/\/(?:www\.)?bilibili\.com\/video\/[A-Za-z0-9]+|https?:\/\/b23\.tv\/[A-Za-z0-9]+|\bBV[0-9A-Za-z]{10}\b/i;

function extractBilibiliSourceFromText(text = "") {
  const match = BILIBILI_SOURCE_PATTERN.exec(String(text || ""));
  return match ? match[0] : null;
}

function isBilibiliSource(value = "") {
  return BILIBILI_SOURCE_PATTERN.test(String(value || ""));
}

async function waitForBotJobCompletion(api, jobId, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0) || 60 * 60 * 1000;
  const pollIntervalMs = Number(options.pollIntervalMs || 0) || 5000;
  const signal = options.signal || null;
  const deadline = Date.now() + timeoutMs;
  const queueWarnAfterMs = 30 * 1000;
  const startedAt = Date.now();
  let lastStatus = "";

  while (true) {
    api.throwIfCancelled();
    if (Date.now() > deadline) {
      throw new Error(`Timeout waiting for job ${jobId} to complete`);
    }

    const job = await api.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (job.status !== lastStatus) {
      lastStatus = job.status;
      await api.appendLog(`waiting for sub-job ${jobId.slice(0, 12)}: status=${job.status}`);
    }
    if (job.status === "succeeded") {
      return job;
    }
    if (job.status === "failed") {
      throw new Error(`Bilibili 下载任务失败: ${job.error?.message || "unknown error"}`);
    }
    if (job.status === "cancelled") {
      throw new Error("Bilibili 下载任务已取消");
    }
    if (job.status === "queued" && Date.now() - startedAt > queueWarnAfterMs) {
      await api.appendLog(`sub-job ${jobId.slice(0, 12)} still queued after ${Math.round((Date.now() - startedAt) / 1000)}s — queue may be congested`);
    }

    await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        return reject(Object.assign(new Error("job cancelled"), { name: "AbortError" }));
      }
      const timer = setTimeout(resolve, pollIntervalMs);
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("job cancelled"), { name: "AbortError" }));
        }, { once: true });
      }
    });
  }
}

async function resolveVideoInput(context, api) {
  const parsedArgs = context?.trigger?.parsedArgs || {};
  const rawText = String(context?.trigger?.rawText || "").trim();

  const fileId = String(parsedArgs.fileId || "").trim();
  if (fileId) {
    const resolved = typeof api.dependencies.resolveFileById === "function"
      ? api.dependencies.resolveFileById(fileId)
      : null;
    if (!resolved?.absolutePath) {
      throw new Error(`文件未找到，fileId: ${fileId}`);
    }
    return { absolutePath: resolved.absolutePath, relativePath: resolved.relativePath, fileId };
  }

  const filePath = String(parsedArgs.filePath || "").trim();
  if (filePath) {
    const absolutePath = path.join(api.storageRoot, filePath.split("/").join(path.sep));
    try {
      await fs.promises.access(absolutePath);
    } catch {
      throw new Error(`文件不存在: ${filePath}`);
    }
    const relativePath = filePath.replace(/\\/g, "/");
    return { absolutePath, relativePath, fileId: api.clientId ? `${api.clientId}:${relativePath}` : "" };
  }

  const refAttachment = (context.attachments || []).find((a) => a.id && String(a.id).includes(":"));
  if (refAttachment?.id) {
    const resolved = typeof api.dependencies.resolveFileById === "function"
      ? api.dependencies.resolveFileById(refAttachment.id)
      : null;
    if (resolved?.absolutePath) {
      return { absolutePath: resolved.absolutePath, relativePath: resolved.relativePath, fileId: refAttachment.id };
    }
  }

  const source = String(parsedArgs.source || parsedArgs.url || "").trim() || extractBilibiliSourceFromText(rawText);
  if (source && isBilibiliSource(source)) {
    return { bilibiliSource: source };
  }

  throw new Error("video.analyze 需要提供 fileId、filePath 或 Bilibili 链接/BV号");
}

const SUMMARY_SYSTEM_PROMPT = `你是一个专业的视频内容分析助手。用户会提供一段视频的字幕文字。请根据字幕内容，提供一份结构清晰的中文内容总结，包含：
1. 视频主题和核心内容（2-3句话）
2. 主要知识点或亮点（用要点列举）
3. 结论或实用建议（如适用）

如果字幕内容较少或不完整，请根据现有内容尽力总结。总结请保持简洁，控制在500字以内。`;

function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 1) return "< 1s";
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function createVideoAnalyzePlugin() {
  return createBotPlugin({
    botId: "video.analyze",
    displayName: "视频分析",
    aliases: ["video-analyze", "analyze-video"],
    description: "提取视频字幕并生成 AI 总结。支持已入库视频（fileId）和 Bilibili 链接（自动下载后分析）。",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "已入库视频的文件 ID（格式: clientId:relativePath）" },
        filePath: { type: "string", description: "相对于存储根目录的视频路径" },
        source: { type: "string", description: "Bilibili 链接或 BV号" }
      }
    },
    capabilities: ["video.transcribe", "video.summarize", "reply.chat"],
    permissions: {
      writeLibrary: true,
      readLibrary: true,
      outboundHttp: true,
      spawnProcess: true,
      replyChat: true,
      publishJobEvents: true
    },
    limits: {
      maxConcurrentJobs: 2,
      timeoutMs: 90 * 60 * 1000
    },
    async execute(context, api) {
      const timings = [];
      const jobStart = Date.now();

      await api.emitProgress({ phase: "parse-input", label: "解析输入", percent: 5 });
      const input = await resolveVideoInput(context, api);

      let absolutePath = input.absolutePath;
      let relativePath = input.relativePath || "";
      let fileId = input.fileId || "";
      let videoTitle = "";

      // Download from Bilibili if source URL provided
      if (input.bilibiliSource) {
        await api.emitProgress({ phase: "download-video", label: "委派 Bilibili 下载", percent: 8 });
        await api.appendLog(`dispatching bilibili download: ${input.bilibiliSource}`);

        const tDownload = Date.now();
        // Invoke bilibili.downloader; polling is safe since this job occupies one queue slot
        // and bilibili takes a second slot (default concurrency=2).
        const bilibiliJob = await api.invokeBot({
          botId: "bilibili.downloader",
          trigger: {
            type: "bot-delegation",
            rawText: input.bilibiliSource,
            parsedArgs: {
              source: input.bilibiliSource,
              quality: "64",
              page: 1,
              nonInteractive: true
            }
          }
        });

        await api.emitProgress({ phase: "download-video", label: "Bilibili 视频下载中...", percent: 10 });
        const completedJob = await waitForBotJobCompletion(api, bilibiliJob.jobId, {
          signal: api.signal,
          timeoutMs: 60 * 60 * 1000,
          pollIntervalMs: 5000
        });
        timings.push({ label: "下载视频 (Bilibili)", ms: Date.now() - tDownload });

        const importedFiles = Array.isArray(completedJob.result?.importedFiles) ? completedJob.result.importedFiles : [];
        if (!importedFiles.length) {
          throw new Error(
            "Bilibili 下载完成，但未获取到视频文件。" +
            "可能原因：视频需要登录（请先通过 @bilibili login 登录），或者下载后端未配置。"
          );
        }

        const imported = importedFiles[0];
        relativePath = String(imported.relativePath || "").trim();
        fileId = api.clientId ? `${api.clientId}:${relativePath}` : "";
        absolutePath = path.join(api.storageRoot, relativePath.split("/").join(path.sep));
        videoTitle = String(imported.fileName || "").replace(/\.[^.]+$/, "").trim();
        await api.appendLog(`bilibili download done: ${absolutePath}`);
      }

      try {
        await fs.promises.access(absolutePath);
      } catch {
        throw new Error(`视频文件不存在: ${absolutePath}`);
      }

      // Check for existing .srt sidecar to skip re-transcription
      const ext = path.extname(absolutePath);
      const baseName = path.basename(absolutePath, ext);
      // Fall back to file basename as title for locally-resolved files
      if (!videoTitle) videoTitle = baseName;
      const sidecarSrtPath = path.join(path.dirname(absolutePath), `${baseName}.srt`);
      const relativeBase = relativePath ? relativePath.replace(/\.[^.]+$/, "") : "";
      const subtitleCachePath = relativeBase ? `${relativeBase}.srt` : "";

      let transcript = "";

      const srtExists = await fs.promises.access(sidecarSrtPath).then(() => true).catch(() => false);
      if (srtExists) {
        await api.appendLog(`reusing existing .srt: ${sidecarSrtPath}`);
        await api.emitProgress({ phase: "transcribe", label: "复用已有字幕文件", percent: 60 });
        transcript = await readTranscriptAsPlainText(sidecarSrtPath);
        timings.push({ label: "字幕加载（复用缓存）", ms: 0, note: "已有 .srt 文件" });
      } else {
        await api.emitProgress({ phase: "extract-audio", label: "提取音频", percent: 28 });
        const tmpDir = path.join(api.appDataRoot, "temp", context.jobId);
        await api.appendLog(`extracting audio from: ${absolutePath}`);
        const tFfmpeg = Date.now();
        const audioPath = await extractAudioWithFfmpeg(absolutePath, tmpDir, {
          ffmpegPath: api.dependencies.ffmpegPath,
          signal: api.signal
        });
        await api.appendLog(`audio extracted: ${audioPath}`);
        timings.push({ label: "音频提取 (ffmpeg)", ms: Date.now() - tFfmpeg });

        await api.emitProgress({ phase: "transcribe", label: "字幕转录中 (Whisper)", percent: 45 });
        await api.appendLog("starting whisper.cpp transcription...");
        const tWhisper = Date.now();
        const tmpSrtPath = await transcribeWithWhisperCpp(audioPath, tmpDir, {
          signal: api.signal
        });
        await api.appendLog(`transcription done: ${tmpSrtPath}`);
        timings.push({ label: "字幕生成 (Whisper)", ms: Date.now() - tWhisper });

        await fs.promises.copyFile(tmpSrtPath, sidecarSrtPath);
        await api.appendLog(`srt sidecar saved: ${sidecarSrtPath}`);

        transcript = await readTranscriptAsPlainText(sidecarSrtPath);

        fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }

      if (!transcript.trim()) {
        throw new Error("字幕提取完成，但未能获取到文字内容，请检查视频音频轨道是否正常");
      }
      await api.appendLog(`transcript: ${transcript.length} chars`);

      await api.emitProgress({ phase: "summarize", label: "AI 分析中", percent: 75 });
      const titleHint = videoTitle ? `视频标题：${videoTitle}\n\n` : "";
      const tSummary = Date.now();
      const result = await invokeTextModel({
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        userPrompt: `${titleHint}以下是视频字幕内容：\n\n${transcript}`,
        maxTokens: 1200,
        signal: api.signal
      });
      timings.push({ label: "AI 内容总结", ms: Date.now() - tSummary });

      const summary = String(result.text || "").trim();
      if (!summary) {
        throw new Error("AI 总结生成失败，请检查 AI 模型配置");
      }
      await api.appendLog(`summary: ${summary.length} chars`);

      if (fileId && typeof api.dependencies.upsertFileMeta === "function") {
        await api.emitProgress({ phase: "save-summary", label: "保存 AI 总结", percent: 90 });
        await api.dependencies.upsertFileMeta(fileId, {
          aiSummary: summary,
          subtitleCachePath: subtitleCachePath || ""
        });
        await api.appendLog(`fileMeta.aiSummary saved for: ${fileId}`);
      }

      if (typeof api.dependencies.syncFiles === "function") {
        triggerLibraryRescan({ syncFiles: api.dependencies.syncFiles }).catch(() => {});
      }

      const title = videoTitle || baseName;
      if (context.chat?.historyPath) {
        const totalMs = Date.now() - jobStart;
        const benchmarkRows = timings.map(({ label, ms, note }) => {
          const time = note ? `${note}` : formatDuration(ms);
          return `| ${label} | ${time} |`;
        }).join("\n");
        const benchmarkSection = timings.length > 0
          ? `\n\n---\n\n⏱ **各阶段用时**\n\n| 阶段 | 用时 |\n|------|------|\n${benchmarkRows}\n| **总计** | **${formatDuration(totalMs)}** |`
          : "";

        const chatReply = await api.publishChatReply({
          text: `## 视频总结：${title}\n\n${summary}${benchmarkSection}`,
          attachmentId: fileId || ""
        });
        return { chatReply, importedFiles: [], artifacts: [] };
      }

      return {
        chatReply: null,
        importedFiles: [],
        artifacts: [{ type: "ai-summary", content: summary, fileId }]
      };
    }
  });
}
