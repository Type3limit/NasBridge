import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { invokeTextModel } from "../tools/llmClient.js";
import { extractAudioWithFfmpeg, readTranscriptAsPlainText, transcribeWithWhisperCpp } from "../tools/whisperTranscribe.js";
import { createBotPlugin } from "./base.js";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".mov", ".flv", ".wmv", ".webm", ".m4v", ".3gp", ".ts", ".m2ts", ".rmvb", ".rm"]);

function getVideoDuration(ffprobePath, filePath) {
  return new Promise((resolve, reject) => {
    const args = ["-v", "quiet", "-print_format", "json", "-show_format", filePath];
    const proc = spawn(ffprobePath, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.on("close", () => {
      try {
        const info = JSON.parse(stdout);
        const duration = parseFloat(info?.format?.duration || "0");
        resolve(Number.isFinite(duration) ? duration : 0);
      } catch {
        resolve(0);
      }
    });
    proc.on("error", (err) => reject(err));
  });
}

async function walkVideoFiles(dir, relativeDirPath = "") {
  const results = [];
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = relativeDirPath ? `${relativeDirPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // skip hidden dirs and known cache dirs
      if (entry.name.startsWith(".")) continue;
      const sub = await walkVideoFiles(fullPath, relPath);
      results.push(...sub);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) {
        results.push({ absolutePath: fullPath, relativePath: relPath });
      }
    }
  }
  return results;
}

const TAG_SYSTEM_PROMPT = `你是一个视频内容标签助手。根据以下视频内容（字幕或总结），为这个视频生成分类标签。

标签规则：
1. 每个标签是简短的中文关键词（1-6个字）
2. 生成 3-8 个标签
3. 标签类别可以包括：
   - 内容类型（游戏/美食/旅行/科技/音乐/舞蹈/搞笑/教程/评测/攻略/Vlog/纪录片/动漫/电影...）
   - 具体游戏或IP名称（原神/我的世界/LOL/CS/绝地求生...）
   - 内容性质（二创/直播/速通/娱乐/学习/生活...）
   - 其他关键特征
4. 以 JSON 数组格式返回，例如：["游戏", "原神", "攻略", "二创"]
5. 只返回 JSON 数组，不要其他内容`;

async function generateTagsFromContent(content, filename, signal) {
  const filenameHint = filename ? `视频文件名：${filename}\n\n` : "";
  const result = await invokeTextModel({
    systemPrompt: TAG_SYSTEM_PROMPT,
    userPrompt: `${filenameHint}以下是视频内容：\n\n${content.slice(0, 6000)}`,
    maxTokens: 200,
    signal
  });
  const text = String(result.text || "").trim();
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        return parsed.map((t) => String(t || "").trim()).filter(Boolean).slice(0, 10);
      }
    }
  } catch {
    // fall through to fallback
  }
  const fallback = [...text.matchAll(/"([^"]{1,20})"/g)].map((m) => m[1].trim()).filter(Boolean);
  return fallback.slice(0, 10);
}

async function getFileTranscript(absolutePath) {
  const srtPath = absolutePath.replace(/\.[^.]+$/, "") + ".srt";
  const srtExists = await fs.promises.access(srtPath).then(() => true).catch(() => false);
  if (srtExists) {
    const text = await readTranscriptAsPlainText(srtPath);
    if (text.trim()) {
      return { content: text, source: "srt" };
    }
  }
  return null;
}

async function processFile({ absolutePath, relativePath, fileId, ffprobePath, api, upsertFileMeta, force, aiSummary }) {
  const filename = path.basename(absolutePath);
  const contentResult = await getFileTranscript(absolutePath);
  if (!contentResult) {
    const tmpDir = path.join(api.appDataRoot, "temp", `tag-${path.basename(absolutePath, path.extname(absolutePath)).slice(0, 16)}-${Date.now()}`);
    let transcript = "";
    try {
      const audioPath = await extractAudioWithFfmpeg(absolutePath, tmpDir, {
        ffmpegPath: api.dependencies.ffmpegPath,
        signal: api.signal
      });
      const tmpSrtPath = await transcribeWithWhisperCpp(audioPath, tmpDir, { signal: api.signal });
      transcript = await readTranscriptAsPlainText(tmpSrtPath);
      const sidecarSrtPath = absolutePath.replace(/\.[^.]+$/, "") + ".srt";
      await fs.promises.copyFile(tmpSrtPath, sidecarSrtPath);
    } catch (err) {
      if (String(aiSummary || "").trim()) {
        await api.appendLog(`transcription failed, falling back to aiSummary: ${err.message}`);
        const tags = await generateTagsFromContent(aiSummary, filename, api.signal);
        if (tags.length && typeof upsertFileMeta === "function") {
          await upsertFileMeta(fileId, { tags });
          await api.appendLog(`upserted tags (ai-summary-fallback): [${tags.join(", ")}]`);
        }
        return { tags, source: "ai-summary-fallback" };
      }
      return { skipped: true, reason: `transcription failed: ${err.message}` };
    }finally {
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    if (!transcript.trim()) {
      return { skipped: true, reason: "empty transcript" };
    }
    const tags = await generateTagsFromContent(transcript, filename, api.signal);
    if (tags.length && typeof upsertFileMeta === "function") {
      await upsertFileMeta(fileId, { tags });
      await api.appendLog(`upserted tags (transcribed): [${tags.join(", ")}]`);
    }
    return { tags, source: "transcribed" };
  }

  await api.appendLog(`srt found, content length: ${contentResult.content.length}`);
  const tags = await generateTagsFromContent(contentResult.content, filename, api.signal);
  await api.appendLog(`llm returned tags: [${tags.join(", ")}]`);
  if (tags.length && typeof upsertFileMeta === "function") {
    await upsertFileMeta(fileId, { tags });
    await api.appendLog(`upserted tags (${contentResult.source}): [${tags.join(", ")}]`);
  } else if (!tags.length) {
    await api.appendLog(`no tags extracted from llm response`);
  }
  return { tags, source: contentResult.source };
}

export function createVideoTagPlugin() {
  return createBotPlugin({
    botId: "video.tag",
    displayName: "视频标签",
    aliases: ["video-tag", "tag-video"],
    description: "为视频文件生成 AI 分类标签。支持单文件（fileId）和批量（batch: true）两种模式。",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "已入库视频的文件 ID（格式: clientId:relativePath）" },
        batch: { type: "boolean", description: "是否批量处理所有视频文件" },
        force: { type: "boolean", description: "是否强制覆盖已有标签" }
      }
    },
    capabilities: ["video.tag", "reply.chat"],
    permissions: {
      writeLibrary: true,
      readLibrary: true,
      spawnProcess: true,
      replyChat: true,
      publishJobEvents: true
    },
    limits: {
      maxConcurrentJobs: 1,
      timeoutMs: 4 * 60 * 60 * 1000
    },
    async execute(context, api) {
      const parsedArgs = context?.trigger?.parsedArgs || {};
      const ffprobePath = api.dependencies.ffprobePath || "ffprobe";
      const upsertFileMeta = api.dependencies.upsertFileMeta;

      // Single-file mode
      if (!parsedArgs.batch) {
        const fileId = String(parsedArgs.fileId || "").trim();
        if (!fileId) {
          throw new Error("video.tag 需要提供 fileId 或 batch: true");
        }
        const resolved = typeof api.dependencies.resolveFileById === "function"
          ? api.dependencies.resolveFileById(fileId)
          : null;
        if (!resolved?.absolutePath) {
          throw new Error(`文件未找到，fileId: ${fileId}`);
        }

        await api.appendLog(`resolving file: ${resolved.absolutePath}`);
        await api.emitProgress({ phase: "check", label: "检查视频时长", percent: 10 });

        let result;
        try {
          result = await processFile({
            absolutePath: resolved.absolutePath,
            relativePath: resolved.relativePath,
            fileId,
            ffprobePath,
            api,
            upsertFileMeta,
            force: Boolean(parsedArgs.force),
            aiSummary: String(parsedArgs.aiSummary || "")
          });
        } catch (err) {
          await api.appendLog(`processFile error: ${err.message}`);
          throw err;
        }

        if (result.skipped) {
          await api.appendLog(`skipped: ${result.reason}`);
          return { chatReply: null, artifacts: [{ type: "skip", reason: result.reason }] };
        }

        await api.appendLog(`tagged (${result.source}): [${(result.tags || []).join(", ")}]`);
        await api.emitProgress({ phase: "done", label: "标签已保存", percent: 100 });
        return {
          chatReply: null,
          tags: result.tags,
          artifacts: [{ type: "tags", tags: result.tags, fileId }]
        };
      }

      // Batch mode
      await api.emitProgress({ phase: "scan", label: "扫描视频文件...", percent: 2 });
      const videoFiles = await walkVideoFiles(api.storageRoot);
      await api.appendLog(`found ${videoFiles.length} video files`);

      let processed = 0;
      let skipped = 0;
      const results = [];

      for (let i = 0; i < videoFiles.length; i++) {
        api.throwIfCancelled();
        const { absolutePath, relativePath } = videoFiles[i];
        const fileId = api.clientId ? `${api.clientId}:${relativePath.replace(/\\/g, "/")}` : "";
        const percent = Math.round(5 + (i / videoFiles.length) * 90);
        await api.emitProgress({
          phase: "batch",
          label: `处理 ${i + 1}/${videoFiles.length}: ${path.basename(absolutePath)}`,
          percent
        });

        try {
          const result = await processFile({
            absolutePath,
            relativePath,
            fileId,
            ffprobePath,
            api,
            upsertFileMeta,
            force: Boolean(parsedArgs.force)
          });
          if (result.skipped) {
            skipped++;
            await api.appendLog(`skipped ${relativePath}: ${result.reason}`);
          } else {
            processed++;
            results.push({ fileId, tags: result.tags });
            await api.appendLog(`tagged ${relativePath}: [${result.tags.join(", ")}]`);
          }
        } catch (err) {
          skipped++;
          await api.appendLog(`error ${relativePath}: ${err.message}`);
        }
      }

      await api.emitProgress({ phase: "done", label: "批量打标签完成", percent: 100 });

      if (context.chat?.historyPath) {
        await api.publishChatReply({
          text: `## 批量打标签完成\n\n- ✅ 成功处理：${processed} 个视频\n- ⏭ 跳过：${skipped} 个（超时限制或无内容）\n- 📁 共扫描 ${videoFiles.length} 个视频文件`
        });
      }

      return {
        processed,
        skipped,
        total: videoFiles.length,
        results,
        artifacts: [{ type: "batch-tags", count: processed }]
      };
    }
  });
}
