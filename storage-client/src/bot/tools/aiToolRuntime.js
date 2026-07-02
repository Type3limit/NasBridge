import fs from "node:fs";
import path from "node:path";
import { safeJoin } from "../../fsIndex.js";
import { searchBilibiliVideoCandidates } from "./bilibiliApi.js";
import { readRecentChatHistory } from "./chatHistory.js";
import { listReferencedChatAttachments } from "./chatAssets.js";
import { invokeMultimodalModel, invokeTextModel } from "./llmClient.js";
import { fetchWebPageSummary, getSourcePreferenceLabel, normalizeSourcePreference, searchWeb } from "./httpFetch.js";
import { executeDelegatedBotToolCall, getDelegatedBotToolDefinitions, isDelegatedBotToolName } from "./botToolAdapter.js";
import { buildRealtimeContextText } from "./realtimeContext.js";
import { searchYYeTsShows, getYYeTsResource, extractEpisodeMagnets, sanitizeShowName } from "./yyetsApi.js";
import { MAX_AGENT_TRACE_EVENTS, MAX_CHILD_JOB_SUMMARY_LIMIT, MAX_JOB_LOG_BYTES, MAX_JOB_STATUS_LIMIT, buildAgentTraceResult, buildBotJobStatusResult } from "./botJobStatus.js";
import {
  MAX_FILE_ORGANIZE_ACTIONS,
  MAX_LIBRARY_DETAIL_FILES,
  MAX_LIBRARY_LIST_LIMIT,
  MAX_METADATA_UPDATE_FILES,
  MAX_TEXT_EXCERPT_CHARS,
  buildFileAccessExplanation,
  buildLibraryDetailsResult,
  buildLibraryListResult,
  buildLibraryMetadataResult,
  buildMediaSummaryResult,
  buildOrganizeFilesResult,
  buildTextExcerptResult,
  buildUpdateFileMetadataResult,
  isDocumentTextExtractable,
  loadLibrarySnapshot,
  readSubtitleForFile,
  resolveLibraryFile
} from "./libraryFiles.js";

const MAX_HISTORY_LIMIT = 60;
const MAX_IMAGE_TOOL_LIMIT = 3;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_WEB_SEARCH_RESULTS = 6;
const MAX_WEB_SEARCH_QUERIES = 3;
const MAX_WEB_PAGE_SUMMARIES = 3;
const MAX_BILIBILI_SEARCH_RESULTS = 5;

function formatStepLabel(prefix = "", current = 1, total = 1, suffix = "") {
  const safeCurrent = Math.max(1, Number(current) || 1);
  const safeTotal = Math.max(1, Number(total) || 1);
  return `${String(prefix || "处理中").trim()}第 ${safeCurrent}/${safeTotal} 个${String(suffix || "步骤").trim()}`;
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

async function waitForDelegatedBotJob(api, jobId, options = {}) {
  const timeoutMs = clamp(options.timeoutSeconds || 600, 5, 600) * 1000;
  const pollIntervalMs = clamp(options.pollIntervalMs || 3000, 500, 10_000);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    api.throwIfCancelled?.();
    if (Date.now() > deadline) {
      throw new Error(`等待任务 ${jobId} 完成超时`);
    }
    const job = await api.getJob(jobId);
    if (!job) {
      throw new Error(`任务不存在: ${jobId}`);
    }
    if (["succeeded", "failed", "cancelled", "expired"].includes(job.status)) {
      return job;
    }
    await new Promise((resolve, reject) => {
      let onAbort = null;
      const cleanup = () => {
        clearTimeout(timer);
        if (api.signal && onAbort) {
          api.signal.removeEventListener("abort", onAbort);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, pollIntervalMs);
      if (api.signal) {
        onAbort = () => {
          cleanup();
          reject(Object.assign(new Error("job cancelled"), { name: "AbortError" }));
        };
        api.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

function compactMessageText(message = {}) {
  const author = String(message?.author?.displayName || "用户").trim();
  const text = String(message?.text || "").trim();
  const cardText = [message?.card?.title, message?.card?.body].filter(Boolean).join(" · ");
  const attachmentText = Array.isArray(message?.attachments) && message.attachments.length
    ? `附件: ${message.attachments.map((item) => item.name).join(", ")}`
    : "";
  return [author, [text || cardText, attachmentText].filter(Boolean).join(" | ")].filter(Boolean).join(": ");
}

async function toDataUrl(attachment) {
  const stat = await fs.promises.stat(attachment.absolutePath);
  if (Number(stat.size || 0) > MAX_INLINE_IMAGE_BYTES) {
    throw new Error(`图片 ${attachment.name} 超过 ${(MAX_INLINE_IMAGE_BYTES / (1024 * 1024)).toFixed(0)}MB，暂不支持 describe_image`);
  }
  const content = await fs.promises.readFile(attachment.absolutePath);
  const mimeType = String(attachment?.mimeType || "image/jpeg").trim() || "image/jpeg";
  return `data:${mimeType};base64,${content.toString("base64")}`;
}

function safeJson(value) {
  return JSON.stringify(value, null, 2);
}

function extractDirectWebUrls(text = "") {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"]+/gi) || [];
  const normalized = matches
    .map((item) => String(item || "").trim().replace(/[),.;!?]+$/g, ""))
    .filter(Boolean);
  return [...new Set(normalized)].slice(0, MAX_WEB_PAGE_SUMMARIES);
}

function parseJsonBlock(text = "") {
  const source = String(text || "").trim();
  if (!source) {
    return null;
  }
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || source;
  try {
    return JSON.parse(candidate);
  } catch {
    const objectMatch = candidate.match(/\{[\s\S]*\}/);
    if (!objectMatch) {
      return null;
    }
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      return null;
    }
  }
}

function normalizeSearchTermList(value, fallback = "") {
  const terms = Array.isArray(value) ? value : [];
  const normalized = terms
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, MAX_WEB_SEARCH_QUERIES);
  if (normalized.length) {
    return normalized;
  }
  return fallback ? [String(fallback || "").trim()].filter(Boolean) : [];
}

function buildMusicControlPrompt(input = {}) {
  const explicitCommand = String(input.command || input.prompt || "").trim();
  if (explicitCommand) {
    return explicitCommand;
  }
  const action = String(input.action || "status").trim().toLowerCase();
  const keyword = String(input.keyword || input.query || input.song || "").trim();
  const source = String(input.source || "").trim();
  const sourceSuffix = source ? ` --source=${source}` : "";
  if (action === "search") {
    if (!keyword) {
      throw new Error("keyword is required for music search");
    }
    return `搜歌 ${keyword}${sourceSuffix}`;
  }
  if (action === "enqueue" || action === "play-song" || action === "add") {
    if (!keyword) {
      throw new Error("keyword is required for music enqueue");
    }
    return `点歌 ${keyword}${sourceSuffix}`;
  }
  if (action === "pick" || action === "select") {
    const index = Math.max(1, Number(input.index || 1) || 1);
    return `选 ${index}`;
  }
  if (action === "source" || action === "set-source") {
    if (!source) {
      throw new Error("source is required for music source switch");
    }
    return `音源 ${source}`;
  }
  const actionMap = {
    status: "状态",
    queue: "队列",
    play: "继续",
    resume: "继续",
    pause: "暂停",
    stop: "暂停",
    next: "下一首",
    skip: "下一首",
    previous: "上一首",
    prev: "上一首"
  };
  return actionMap[action] || action;
}

const ANALYZABLE_TEXT_EXTS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".log",
  ".xml",
  ".yaml",
  ".yml",
  ".ini",
  ".toml",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".html",
  ".htm",
  ".srt",
  ".ass",
  ".vtt",
  ".sub",
  ".ssa"
]);

function compactStorageFileForTool(file = {}) {
  return {
    fileId: String(file.id || "").trim(),
    path: String(file.relativePath || file.path || "").trim(),
    name: String(file.name || "").trim(),
    size: Number(file.size || 0),
    mimeType: String(file.mimeType || "application/octet-stream").trim(),
    tags: Array.isArray(file.tags) ? file.tags : [],
    aiSummaryAvailable: Boolean(file.aiSummaryAvailable),
    subtitleAvailable: Boolean(file.subtitleAvailable),
    subtitlePath: String(file.subtitlePath || "").trim()
  };
}

function isVideoOrAudioStorageFile(file = {}) {
  const mimeType = String(file.mimeType || "").toLowerCase();
  return mimeType.startsWith("video/") || mimeType.startsWith("audio/");
}

function buildBatchVideoTagConfirmation(files = [], input = {}) {
  const targetFiles = (Array.isArray(files) ? files : []).filter(isVideoOrAudioStorageFile);
  return {
    required: true,
    operation: "invoke_video_tag",
    riskLevel: "medium",
    reason: "批量视频打标签会为多个视频/音频文件生成并写入 metadata tags。",
    impact: {
      targetFileCount: targetFiles.length,
      changedFields: ["tags"],
      force: input.force === true,
      files: targetFiles.slice(0, 10).map(compactStorageFileForTool)
    },
    recoverability: "标签写入后可再次用 update_file_metadata 调整；force=true 可能覆盖已有标签，恢复成本更高。",
    estimatedDuration: targetFiles.length <= 5 ? "< 1 分钟" : (targetFiles.length <= 30 ? "1-5 分钟" : "数分钟到更久，取决于视频数量和模型速度"),
    confirmWith: {
      confirmed: true,
      batch: true
    }
  };
}

function isAnalyzableTextFile(file = {}) {
  const mimeType = String(file.mimeType || "").toLowerCase();
  const ext = path.extname(String(file.relativePath || file.path || "")).toLowerCase();
  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    mimeType.includes("javascript") ||
    mimeType.includes("typescript") ||
    mimeType.includes("yaml") ||
    mimeType.includes("csv") ||
    ANALYZABLE_TEXT_EXTS.has(ext)
  );
}

function resolveAnalyzeMode(file = {}, requestedMode = "auto") {
  const mode = String(requestedMode || "auto").trim().toLowerCase();
  if (["text", "image", "media"].includes(mode)) {
    return mode;
  }
  const mimeType = String(file.mimeType || "").toLowerCase();
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/") || mimeType.startsWith("audio/")) {
    return "media";
  }
  if (isAnalyzableTextFile(file) || isDocumentTextExtractable(file)) {
    return "text";
  }
  if (file.aiSummaryAvailable || file.subtitleAvailable) {
    return "media";
  }
  return "metadata";
}

async function storageFileToImageInput(api = {}, file = {}, detail = "auto") {
  const absolutePath = safeJoin(api.storageRoot, String(file.relativePath || file.path || ""));
  const imageData = await toDataUrl({
    absolutePath,
    name: file.name,
    mimeType: file.mimeType
  });
  return {
    name: file.name,
    mimeType: file.mimeType,
    dataUrl: imageData,
    detail: String(detail || "auto").trim() || "auto"
  };
}

async function buildAnalyzeFileContentResult(api = {}, input = {}) {
  const identifier = String(input.fileId || input.path || input.filePath || "").trim();
  if (!identifier) {
    throw new Error("fileId or path is required");
  }
  const snapshot = await loadLibrarySnapshot(api);
  const file = resolveLibraryFile(snapshot.files, identifier);
  if (!file) {
    throw new Error(`文件未找到: ${identifier}`);
  }

  const mode = resolveAnalyzeMode(file, input.mode || "auto");
  const task = String(input.task || input.prompt || "请分析这个 NAS 文件，给出结论和关键要点。").trim();
  const maxChars = clamp(input.maxChars || 8_000, 1, MAX_TEXT_EXCERPT_CHARS);
  const maxTokens = clamp(input.maxTokens || 900, 200, 2000);
  const fileInfo = compactStorageFileForTool(file);

  if (mode === "text") {
    const excerptResult = await buildTextExcerptResult(api, {
      fileId: file.id,
      source: input.source,
      subtitle: input.subtitle === true,
      allowSubtitleFallback: input.allowSubtitleFallback,
      startChar: input.startChar || input.offset || 0,
      maxChars
    });
    const text = String(excerptResult.excerpt?.text || "");
    const result = await invokeTextModel({
      systemPrompt: [
        "你在执行 analyze_file_content 工具。",
        buildRealtimeContextText(),
        "请基于提供的 NAS 文件片段输出简洁、结构化的中文分析。",
        "如果片段被截断，明确说明结论只基于当前片段。"
      ].join("\n"),
      userPrompt: [
        `用户任务：${task}`,
        "文件信息：",
        safeJson(fileInfo),
        "文件片段：",
        text
      ].join("\n\n"),
      signal: api.signal,
      maxTokens,
      temperature: 0.2
    });
    return {
      mode: "text",
      file: fileInfo,
      excerpt: {
        path: excerptResult.excerpt?.path || "",
        source: excerptResult.excerpt?.source || "",
        startChar: excerptResult.excerpt?.startChar ?? 0,
        nextStartChar: excerptResult.excerpt?.nextStartChar ?? null,
        length: excerptResult.excerpt?.length ?? null,
        truncated: excerptResult.excerpt?.truncated === true
      },
      model: result.model || "",
      analysis: String(result.text || "").trim()
    };
  }

  if (mode === "image") {
    const mimeType = String(file.mimeType || "").toLowerCase();
    if (!mimeType.startsWith("image/")) {
      throw new Error(`analyze_file_content image mode 仅支持图片文件，当前 MIME: ${file.mimeType}`);
    }
    const imageInput = await storageFileToImageInput(api, file, input.detail || "auto");
    const result = await invokeMultimodalModel({
      systemPrompt: [
        "你在执行 analyze_file_content 工具。",
        buildRealtimeContextText(),
        "请基于 NAS 图片内容输出精炼、结构化的中文分析，覆盖主体、场景、可见文字、风险点和不确定性。"
      ].join("\n"),
      userPrompt: task,
      imageInputs: [imageInput],
      signal: api.signal,
      maxTokens,
      temperature: 0.2
    });
    return {
      mode: "image",
      file: fileInfo,
      imageCount: 1,
      model: result.model || "",
      analysis: String(result.text || "").trim()
    };
  }

  if (mode === "media") {
    const mediaSummary = await buildMediaSummaryResult(api, {
      fileId: file.id,
      includeSummary: true,
      includeTranscriptExcerpt: input.includeTranscriptExcerpt === true || input.includeSubtitleExcerpt === true,
      startChar: input.startChar || 0,
      maxChars
    });
    if (String(mediaSummary.aiSummary || "").trim() && input.forceAnalyze !== true) {
      return {
        mode: "media-summary",
        file: fileInfo,
        media: mediaSummary.media,
        derived: mediaSummary.derived,
        aiSummary: mediaSummary.aiSummary,
        transcriptExcerpt: mediaSummary.transcriptExcerpt || null
      };
    }

    const mimeType = String(file.mimeType || "").toLowerCase();
    if (!mimeType.startsWith("video/") && !mimeType.startsWith("audio/")) {
      return {
        mode: "metadata",
        file: fileInfo,
        media: mediaSummary.media,
        derived: mediaSummary.derived,
        message: "该文件没有可直接分析的文本、图片或视频/音频内容；已返回可用 metadata。"
      };
    }

    if (input.startAnalysis === true || input.analyze === true || input.forceAnalyze === true) {
      const delegatedJob = await api.invokeBot({
        botId: "video.analyze",
        trigger: {
          type: "tool-call",
          rawText: file.relativePath,
          parsedArgs: {
            fileId: file.id,
            filePath: file.relativePath
          }
        },
        options: {
          delegatedBy: api.botId,
          parentJobId: api.jobId,
          toolName: "analyze_file_content"
        }
      });

      if (input.waitForCompletion === true) {
        const completedJob = await waitForDelegatedBotJob(api, delegatedJob.jobId, {
          timeoutSeconds: input.timeoutSeconds || 600
        });
        return {
          mode: "media-analysis-job",
          status: completedJob.status,
          jobId: completedJob.jobId,
          file: fileInfo,
          result: completedJob.result || {},
          error: completedJob.error || null
        };
      }

      return {
        mode: "media-analysis-job",
        delegated: true,
        botId: "video.analyze",
        jobId: delegatedJob.jobId || "",
        status: delegatedJob.status || "queued",
        file: fileInfo,
        message: "已提交视频/音频转录与 AI 总结任务，完成后会写入文件 metadata。"
      };
    }

    return {
      mode: "media-summary",
      file: fileInfo,
      media: mediaSummary.media,
      derived: mediaSummary.derived,
      aiSummary: mediaSummary.aiSummary || "",
      transcriptExcerpt: mediaSummary.transcriptExcerpt || null,
      nextAction: "该媒体文件还没有 AI 摘要；如需生成摘要，请再次调用 analyze_file_content 并设置 startAnalysis=true，或调用 analyze_storage_video。"
    };
  }

  return {
    mode: "metadata",
    file: fileInfo,
    message: "该文件类型暂不支持直接内容分析；已返回 metadata。"
  };
}

function buildSearchResultDigest(results = []) {
  return (Array.isArray(results) ? results : []).map((item, index) => ({
    index: index + 1,
    title: String(item?.title || "").trim(),
    url: String(item?.url || "").trim(),
    snippet: String(item?.snippet || "").trim(),
    matchedSource: String(item?.matchedSource || "generic").trim(),
    matchedQuery: String(item?.matchedQuery || item?.query || "").trim()
  }));
}

function createWebSearchProgressDetails({
  stage = "search",
  query = "",
  directUrls = [],
  preferredSource = "",
  plan = null,
  executedQueries = [],
  results = [],
  followUpDecision = null,
  fetchedPages = []
} = {}) {
  return {
    type: "web-search",
    stage: String(stage || "search").trim() || "search",
    query: String(query || "").trim(),
    preferredSource: String(preferredSource || "").trim(),
    preferredSourceLabel: getSourcePreferenceLabel(preferredSource),
    directUrls: (Array.isArray(directUrls) ? directUrls : []).map((item) => String(item || "").trim()).filter(Boolean).slice(0, MAX_WEB_PAGE_SUMMARIES),
    plan: plan && typeof plan === "object"
      ? {
          intent: String(plan.intent || "").trim(),
          rationale: String(plan.rationale || "").trim(),
          strategy: Array.isArray(plan.strategy) ? plan.strategy.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 5) : [],
          searchTerms: Array.isArray(plan.searchTerms) ? plan.searchTerms.map((item) => String(item || "").trim()).filter(Boolean).slice(0, MAX_WEB_SEARCH_QUERIES) : []
        }
      : null,
    executedQueries: (Array.isArray(executedQueries) ? executedQueries : []).map((item) => String(item || "").trim()).filter(Boolean).slice(0, MAX_WEB_SEARCH_QUERIES),
    results: buildSearchResultDigest(results).slice(0, 3),
    followUpDecision: followUpDecision && typeof followUpDecision === "object"
      ? {
          needsPageFetch: followUpDecision.needsPageFetch === true,
          answerableFromResults: followUpDecision.answerableFromResults === true,
          reason: String(followUpDecision.reason || "").trim(),
          selectedIndexes: Array.isArray(followUpDecision.selectedIndexes)
            ? followUpDecision.selectedIndexes.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0).slice(0, MAX_WEB_PAGE_SUMMARIES)
            : []
        }
      : null,
    fetchedPages: (Array.isArray(fetchedPages) ? fetchedPages : []).map((item) => ({
      title: String(item?.title || item?.url || "").trim(),
      url: String(item?.url || "").trim(),
      excerpt: String(item?.excerpt || item?.description || "").trim().slice(0, 220)
    })).filter((item) => item.title || item.url).slice(0, MAX_WEB_PAGE_SUMMARIES)
  };
}

function isBilibiliVideoUrl(rawUrl = "") {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    const hostname = String(parsed.hostname || "").toLowerCase();
    if (!(hostname === "www.bilibili.com" || hostname === "bilibili.com" || hostname.endsWith(".bilibili.com") || hostname === "b23.tv")) {
      return false;
    }
    if (hostname === "b23.tv") {
      return true;
    }
    const fullPath = `${parsed.pathname || ""}${parsed.search || ""}${parsed.hash || ""}`;
    return /\/video\//i.test(fullPath) || /BV[0-9A-Za-z]+/i.test(fullPath);
  } catch {
    return false;
  }
}

async function searchBilibiliVideos(query = "", signal, maxResults = MAX_BILIBILI_SEARCH_RESULTS) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    throw new Error("query is required");
  }

  const limit = clamp(maxResults, 1, MAX_BILIBILI_SEARCH_RESULTS);
  try {
    const apiResult = await searchBilibiliVideoCandidates(normalizedQuery, {
      signal,
      maxResults: limit
    });
    if (Array.isArray(apiResult?.results) && apiResult.results.length) {
      return {
        ...apiResult,
        backend: "bilibili-api"
      };
    }
  } catch {
  }

  const searchTerms = [
    `site:bilibili.com/video ${normalizedQuery}`,
    `${normalizedQuery} site:bilibili.com/video 教程`,
    `${normalizedQuery} 哔哩哔哩 教程`
  ];
  const mergedResults = [];
  const seenUrls = new Set();

  for (const term of searchTerms) {
    const batch = await searchWeb(term, {
      signal,
      limit: Math.max(limit * 2, 6),
      preferredSource: ""
    });
    for (const result of batch.results || []) {
      const normalizedUrl = String(result?.url || "").trim();
      if (!normalizedUrl || seenUrls.has(normalizedUrl) || !isBilibiliVideoUrl(normalizedUrl)) {
        continue;
      }
      seenUrls.add(normalizedUrl);
      mergedResults.push({
        title: String(result?.title || "").trim(),
        url: normalizedUrl,
        snippet: String(result?.snippet || "").trim(),
        matchedQuery: String(result?.matchedQuery || batch.query || term).trim()
      });
      if (mergedResults.length >= limit) {
        break;
      }
    }
    if (mergedResults.length >= limit) {
      break;
    }
  }

  return {
    query: normalizedQuery,
    searchedAt: new Date().toISOString(),
    resultCount: mergedResults.length,
    results: mergedResults,
    recommendedSource: mergedResults[0]?.url || "",
    backend: "web-search-fallback"
  };
}

async function decideWebSearchFollowUp({ query = "", preferredSource = "", plan = {}, results = [], signal, fetchPages = 0 }) {
  const cappedFetchPages = clamp(fetchPages, 0, MAX_WEB_PAGE_SUMMARIES);
  const digest = buildSearchResultDigest(results);
  if (!cappedFetchPages || !digest.length) {
    return {
      needsPageFetch: false,
      answerableFromResults: digest.length > 0,
      reason: digest.length ? "当前未要求继续抓取页面。" : "当前没有可用搜索结果。",
      selectedIndexes: []
    };
  }

  const fallbackIndexes = digest.slice(0, cappedFetchPages).map((item) => item.index);
  const fallback = {
    needsPageFetch: true,
    answerableFromResults: false,
    reason: "默认抓取前几条结果页面，补足搜索摘要里缺失的细节。",
    selectedIndexes: fallbackIndexes
  };

  try {
    const result = await invokeTextModel({
      systemPrompt: [
        "你是网页检索二次决策器。",
        buildRealtimeContextText(),
        "你会看到用户问题、初步搜索计划，以及搜索结果列表。",
        "你的任务是判断：仅靠搜索结果摘要是否已经足够回答；如果不够，是否需要继续进入具体网页。",
        "优先选择最可能包含一手信息、正文详情、今日榜单或完整说明的页面。",
        "如果用户问的是今天、今日、最新、热榜、榜单、公告、价格、更新日志等，且搜索摘要本身不包含完整答案，通常应该继续进页。",
        `最多只能选择 ${cappedFetchPages} 个结果进入页面。`,
        "请严格输出 JSON，不要输出 Markdown。",
        "JSON 结构必须是 {\"needsPageFetch\":boolean,\"answerableFromResults\":boolean,\"reason\":string,\"selectedIndexes\":number[]}。",
        "selectedIndexes 使用 1-based 序号，只能从给定结果列表中选择。"
      ].join("\n"),
      userPrompt: [
        `用户问题：${String(query || "").trim()}`,
        `站点偏好：${getSourcePreferenceLabel(preferredSource)}`,
        "检索计划：",
        safeJson(plan || {}),
        "搜索结果：",
        safeJson(digest)
      ].join("\n\n"),
      signal,
      temperature: 0.1,
      maxTokens: 420
    });
    const parsed = parseJsonBlock(result.text || "") || {};
    const selectedIndexes = Array.isArray(parsed.selectedIndexes)
      ? [...new Set(parsed.selectedIndexes.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 1 && item <= digest.length))].slice(0, cappedFetchPages)
      : [];
    const needsPageFetch = parsed.needsPageFetch === true && selectedIndexes.length > 0;
    return {
      needsPageFetch,
      answerableFromResults: parsed.answerableFromResults === true,
      reason: String(parsed.reason || (needsPageFetch ? fallback.reason : "搜索结果摘要已足够回答。")).trim(),
      selectedIndexes: needsPageFetch ? selectedIndexes : []
    };
  } catch {
    return fallback;
  }
}

async function buildWebSearchPlan(userQuery = "", signal, preferredSource = "") {
  const normalizedPreference = normalizeSourcePreference(preferredSource);
  const fallback = {
    intent: String(userQuery || "").trim(),
    rationale: normalizedPreference ? `默认直接用用户问题作为检索词，并优先查看${getSourcePreferenceLabel(normalizedPreference)}。` : "默认直接用用户问题作为检索词，并优先查看权威站点。",
    strategy: ["先检索原始问题", normalizedPreference ? `优先保留${getSourcePreferenceLabel(normalizedPreference)}的结果` : "优先保留权威来源和直达信息", "抓取前几条结果的页面摘要供回答使用"],
    searchTerms: normalizeSearchTermList([userQuery], userQuery),
    preferredSource: normalizedPreference
  };
  try {
    const result = await invokeTextModel({
      systemPrompt: [
        "你是网页检索规划器。",
        buildRealtimeContextText(),
        "用户会给出一个想联网搜索的问题。",
        "请产出严格 JSON，不要输出 Markdown。",
        "JSON 结构必须是 {\"intent\":string,\"rationale\":string,\"strategy\":string[],\"searchTerms\":string[],\"preferredSource\":string}。",
        `searchTerms 最多 ${MAX_WEB_SEARCH_QUERIES} 条，必须是适合中文网页搜索引擎的具体检索词。`,
        "preferredSource 只能是 official、github、docs、news 或空字符串。",
        "strategy 需要简洁说明检索顺序和筛选标准。"
      ].join("\n"),
      userPrompt: `用户问题：${String(userQuery || "").trim()}\n站点偏好：${normalizedPreference || "无"}`,
      signal,
      temperature: 0.1,
      maxTokens: 320
    });
    const parsed = parseJsonBlock(result.text || "") || {};
    return {
      intent: String(parsed.intent || fallback.intent).trim(),
      rationale: String(parsed.rationale || fallback.rationale).trim(),
      strategy: Array.isArray(parsed.strategy)
        ? parsed.strategy.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 5)
        : fallback.strategy,
      searchTerms: normalizeSearchTermList(parsed.searchTerms, userQuery),
      preferredSource: normalizeSourcePreference(parsed.preferredSource || normalizedPreference)
    };
  } catch {
    return fallback;
  }
}

export function getAiToolDefinitions() {
  return [
    {
      name: "read_chat_history",
      description: "读取当前聊天室最近消息，用于问答、总结和补足上下文。",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: MAX_HISTORY_LIMIT },
          includeBots: { type: "boolean" },
          lookbackDays: { type: "integer", minimum: 0, maximum: 7 }
        }
      }
    },
    {
      name: "get_bot_job_status",
      description: "读取 bot job 的真实状态、进度、错误、最近日志和可选 agent trace。用户问“刚才任务怎么样/为什么失败/jobId 状态”时调用；未传 jobId 会返回最近任务。",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "单个 bot job id" },
          jobIds: { type: "array", items: { type: "string" }, maxItems: MAX_JOB_STATUS_LIMIT },
          limit: { type: "integer", minimum: 1, maximum: MAX_JOB_STATUS_LIMIT, description: "未指定 jobId 时返回最近几个任务" },
          includeLog: { type: "boolean", description: "是否返回尾部日志，默认 false" },
          logMaxBytes: { type: "integer", minimum: 1024, maximum: MAX_JOB_LOG_BYTES },
          includeTrace: { type: "boolean", description: "是否同时读取 ai.chat trace，默认 false" },
          maxTraceEvents: { type: "integer", minimum: 1, maximum: MAX_AGENT_TRACE_EVENTS },
          includeChildJobs: { type: "boolean", description: "是否返回委派子任务；明确 jobId 时默认 true，最近任务列表默认 false" },
          childJobLimit: { type: "integer", minimum: 1, maximum: MAX_CHILD_JOB_SUMMARY_LIMIT }
        }
      }
    },
    {
      name: "read_agent_trace",
      description: "读取 ai.chat LangGraph 执行 trace，包括 node/tool 事件和执行摘要。用户问 AI 中途失败在哪一步、调用了哪些工具、上次执行路径时调用。",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "ai.chat job id；不传则读取最近一次 ai.chat trace" },
          maxEvents: { type: "integer", minimum: 1, maximum: MAX_AGENT_TRACE_EVENTS }
        }
      }
    },
    {
      name: "describe_image",
      description: "读取当前消息附件或最近聊天中的图片，并调用多模态模型分析。",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: MAX_IMAGE_TOOL_LIMIT }
        }
      }
    },
    {
      name: "list_storage_files",
      description: "读取当前 storage-client 本地文件库列表。可按关键词、目录、类型、MIME、是否已有 AI 总结或字幕筛选。需要知道库里有哪些文件时先调用它，再用返回的 fileId 调详情工具。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "按文件名、路径、标签或总结内容模糊搜索" },
          kind: { type: "string", enum: ["all", "video", "audio", "image", "document", "subtitle"] },
          pathPrefix: { type: "string", description: "目录前缀，例如 Movies/ 或 Bilibili/教程" },
          mimePrefix: { type: "string", description: "MIME 前缀，例如 video/、audio/、image/" },
          extension: { type: "string", description: "文件扩展名过滤，例如 .mp4、srt、pdf" },
          extensions: { type: "array", items: { type: "string" }, description: "多个扩展名过滤" },
          tags: { type: "array", items: { type: "string" }, description: "按标签过滤，默认任一命中" },
          anyTags: { type: "array", items: { type: "string" }, description: "任一标签命中" },
          allTags: { type: "array", items: { type: "string" }, description: "必须全部标签命中" },
          updatedAfter: { type: "string", description: "mtime 起始时间，ISO 或可解析日期" },
          updatedBefore: { type: "string", description: "mtime 结束时间，ISO 或可解析日期" },
          createdAfter: { type: "string", description: "创建时间起始" },
          createdBefore: { type: "string", description: "创建时间结束" },
          minSize: { type: "number", minimum: 0, description: "最小文件大小，字节" },
          maxSize: { type: "number", minimum: 0, description: "最大文件大小，字节" },
          hasAiSummary: { type: "boolean", description: "只看已有/没有 AI 总结的文件" },
          hasSubtitle: { type: "boolean", description: "只看已有/没有字幕 sidecar 的文件" },
          includeSubtitles: { type: "boolean", description: "是否把 .srt/.vtt 等字幕文件本身也列出来，默认 false" },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIBRARY_LIST_LIMIT },
          offset: { type: "integer", minimum: 0 },
          sortBy: { type: "string", enum: ["updatedAt", "createdAt", "name", "path", "size", "mimeType"] },
          sortDirection: { type: "string", enum: ["asc", "desc"] }
        }
      }
    },
    {
      name: "search_library_files",
      description: "按关键词、目录、类型、标签、摘要状态搜索 NAS 文件库。它是 list_storage_files 的语义化别名，适合用户说“找文件/查目录/最近下载”时调用。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "按文件名、路径、标签或总结内容模糊搜索" },
          kind: { type: "string", enum: ["all", "video", "audio", "image", "document", "subtitle"] },
          pathPrefix: { type: "string", description: "目录前缀，例如 Movies/ 或 Bilibili/教程" },
          mimePrefix: { type: "string", description: "MIME 前缀，例如 video/、audio/、image/" },
          extension: { type: "string", description: "文件扩展名过滤，例如 .mp4、srt、pdf" },
          extensions: { type: "array", items: { type: "string" }, description: "多个扩展名过滤" },
          tags: { type: "array", items: { type: "string" }, description: "按标签过滤，默认任一命中" },
          anyTags: { type: "array", items: { type: "string" }, description: "任一标签命中" },
          allTags: { type: "array", items: { type: "string" }, description: "必须全部标签命中" },
          updatedAfter: { type: "string", description: "mtime 起始时间，ISO 或可解析日期" },
          updatedBefore: { type: "string", description: "mtime 结束时间，ISO 或可解析日期" },
          createdAfter: { type: "string", description: "创建时间起始" },
          createdBefore: { type: "string", description: "创建时间结束" },
          minSize: { type: "number", minimum: 0, description: "最小文件大小，字节" },
          maxSize: { type: "number", minimum: 0, description: "最大文件大小，字节" },
          hasAiSummary: { type: "boolean" },
          hasSubtitle: { type: "boolean" },
          includeSubtitles: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIBRARY_LIST_LIMIT },
          offset: { type: "integer", minimum: 0 },
          sortBy: { type: "string", enum: ["updatedAt", "createdAt", "name", "path", "size", "mimeType"] },
          sortDirection: { type: "string", enum: ["asc", "desc"] }
        }
      }
    },
    {
      name: "read_file_metadata",
      description: "读取一个或多个 NAS 文件的元数据和可访问层级，不返回正文内容。用于决定下一步该读文本片段、读取媒体摘要，还是启动分析任务。",
      inputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "单个文件 ID" },
          fileIds: { type: "array", items: { type: "string" }, maxItems: MAX_LIBRARY_DETAIL_FILES },
          path: { type: "string", description: "单个相对路径" },
          paths: { type: "array", items: { type: "string" }, maxItems: MAX_LIBRARY_DETAIL_FILES }
        }
      }
    },
    {
      name: "read_text_excerpt",
      description: "受控读取文本类文件、PDF/Office 文档抽取文本或字幕 sidecar 的片段。只接受 fileId/相对路径，不暴露绝对路径；视频/音频默认读取字幕片段而不是二进制内容。",
      inputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "文件 ID，优先使用 list_storage_files/search_library_files 返回的 fileId" },
          path: { type: "string", description: "相对路径（与 fileId 二选一）" },
          source: { type: "string", enum: ["file", "subtitle", "document"], description: "读取原文本文件、文档抽取文本还是字幕 sidecar" },
          subtitle: { type: "boolean", description: "source=subtitle 的别名" },
          allowSubtitleFallback: { type: "boolean", description: "非文本媒体有字幕时是否自动读字幕，默认 true" },
          startChar: { type: "integer", minimum: 0 },
          offset: { type: "integer", minimum: 0, description: "startChar 的别名" },
          maxChars: { type: "integer", minimum: 1, maximum: MAX_TEXT_EXCERPT_CHARS }
        }
      }
    },
    {
      name: "read_media_summary",
      description: "读取视频/音频/图片等媒体文件的派生信息：已有 AI 总结、字幕 sidecar 状态、ffprobe 时长/分辨率/音轨、标签和可选字幕片段。不会读取二进制原文。",
      inputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "文件 ID" },
          path: { type: "string", description: "相对路径（与 fileId 二选一）" },
          includeSummary: { type: "boolean", description: "是否返回已有 aiSummary，默认 true" },
          includeProbe: { type: "boolean", description: "是否用 ffprobe 返回时长、分辨率、音轨等技术信息，默认 true" },
          includeTranscriptExcerpt: { type: "boolean", description: "是否返回字幕片段，默认 false" },
          includeSubtitleExcerpt: { type: "boolean", description: "includeTranscriptExcerpt 的别名" },
          startChar: { type: "integer", minimum: 0 },
          maxChars: { type: "integer", minimum: 1, maximum: MAX_TEXT_EXCERPT_CHARS }
        }
      }
    },
    {
      name: "analyze_file_content",
      description: "统一分析 NAS 文件内容：文本/PDF/Office 文档读取受控片段并总结，图片调用多模态模型，视频/音频优先复用已有摘要/字幕或按需委派 video.analyze。",
      inputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "文件 ID，优先使用 list_storage_files/search_library_files 返回的 fileId" },
          path: { type: "string", description: "相对路径（与 fileId 二选一）" },
          filePath: { type: "string", description: "相对路径别名" },
          mode: { type: "string", enum: ["auto", "text", "image", "media"], description: "分析模式；默认 auto，会按 MIME 和派生信息自动选择" },
          task: { type: "string", description: "用户希望完成的分析任务" },
          prompt: { type: "string", description: "task 的别名" },
          source: { type: "string", enum: ["file", "subtitle", "document"], description: "文本模式下读取原文件、文档抽取文本还是字幕 sidecar" },
          subtitle: { type: "boolean", description: "文本模式下读取字幕 sidecar" },
          allowSubtitleFallback: { type: "boolean", description: "非文本媒体有字幕时是否自动读字幕，默认 true" },
          startChar: { type: "integer", minimum: 0 },
          offset: { type: "integer", minimum: 0, description: "startChar 的别名" },
          maxChars: { type: "integer", minimum: 1, maximum: MAX_TEXT_EXCERPT_CHARS },
          includeTranscriptExcerpt: { type: "boolean", description: "媒体模式下是否返回字幕片段" },
          includeSubtitleExcerpt: { type: "boolean", description: "includeTranscriptExcerpt 的别名" },
          startAnalysis: { type: "boolean", description: "媒体没有摘要时是否启动 video.analyze" },
          analyze: { type: "boolean", description: "startAnalysis 的别名" },
          forceAnalyze: { type: "boolean", description: "即使已有摘要也重新委派 video.analyze" },
          waitForCompletion: { type: "boolean", description: "是否等待委派任务完成。长视频建议 false，默认 false" },
          timeoutSeconds: { type: "integer", minimum: 5, maximum: 600 },
          detail: { type: "string", enum: ["auto", "low", "high"], description: "图片分析细节等级" },
          maxTokens: { type: "integer", minimum: 200, maximum: 2000 }
        }
      }
    },
    {
      name: "update_file_metadata",
      description: "受控写入 NAS 文件 metadata，仅支持 tags 和 aiSummary。单文件可直接执行并返回审计；批量写入必须先向用户确认并传 confirmed=true。设置 dryRun=true 可预览变更。",
      inputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "单个文件 ID" },
          fileIds: { type: "array", items: { type: "string" }, maxItems: MAX_METADATA_UPDATE_FILES },
          path: { type: "string", description: "单个相对路径" },
          paths: { type: "array", items: { type: "string" }, maxItems: MAX_METADATA_UPDATE_FILES },
          tags: { type: "array", items: { type: "string" }, description: "替换为这组标签" },
          addTags: { type: "array", items: { type: "string" }, description: "追加标签，不会重复" },
          removeTags: { type: "array", items: { type: "string" }, description: "移除标签，大小写不敏感" },
          aiSummary: { type: "string", description: "写入/覆盖 AI 摘要" },
          clearAiSummary: { type: "boolean", description: "清空 AI 摘要" },
          dryRun: { type: "boolean", description: "只预览不写入，默认 false" },
          confirmed: { type: "boolean", description: "批量写入前必须由用户确认" }
        }
      }
    },
    {
      name: "organize_files",
      description: "高风险 NAS 文件整理工具：在 storage root 内移动或重命名文件。默认只 dry-run 预览；实际执行必须 confirmed=true 且 dryRun=false。",
      inputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "单个文件 ID" },
          fileIds: { type: "array", items: { type: "string" }, maxItems: MAX_FILE_ORGANIZE_ACTIONS },
          path: { type: "string", description: "单个相对路径" },
          paths: { type: "array", items: { type: "string" }, maxItems: MAX_FILE_ORGANIZE_ACTIONS },
          targetFolder: { type: "string", description: "目标目录，相对于 storage root；批量移动时使用" },
          targetName: { type: "string", description: "目标文件名；仅适合单文件重命名" },
          targetPath: { type: "string", description: "完整目标相对路径；仅适合单文件" },
          actions: {
            type: "array",
            maxItems: MAX_FILE_ORGANIZE_ACTIONS,
            items: {
              type: "object",
              properties: {
                fileId: { type: "string" },
                path: { type: "string" },
                targetFolder: { type: "string" },
                targetName: { type: "string" },
                targetPath: { type: "string" },
                overwrite: { type: "boolean" }
              }
            },
            description: "批量整理时为每个文件单独指定目标"
          },
          overwrite: { type: "boolean", description: "是否允许覆盖已有目标文件；仍需用户明确确认" },
          dryRun: { type: "boolean", description: "是否只预览，默认 true" },
          confirmed: { type: "boolean", description: "高风险实际执行必须为 true" }
        }
      }
    },
    {
      name: "explain_file_access",
      description: "说明 AI 当前对 NAS 文件库能访问什么、不能访问什么、读写风险边界和可用工具。用户询问权限/可访问性时调用。",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["summary", "tools"], description: "summary 返回边界摘要；tools 额外返回工具列表" }
        }
      }
    },
    {
      name: "get_storage_file_details",
      description: "批量读取 storage-client 文件详情。可直接返回已有 AI 总结，也可读取对应字幕 sidecar（.srt/.vtt/.ass 等）的文本内容。",
      inputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "单个文件 ID" },
          fileIds: { type: "array", items: { type: "string" }, maxItems: MAX_LIBRARY_DETAIL_FILES, description: "多个文件 ID" },
          path: { type: "string", description: "单个相对路径" },
          paths: { type: "array", items: { type: "string" }, maxItems: MAX_LIBRARY_DETAIL_FILES, description: "多个相对路径" },
          includeSummary: { type: "boolean", description: "是否包含 aiSummary，默认 true" },
          includeSubtitle: { type: "boolean", description: "是否内联读取字幕文本，默认 false" },
          includeSrt: { type: "boolean", description: "includeSubtitle 的别名" },
          subtitleMaxChars: { type: "integer", minimum: 1, maximum: 50000, description: "字幕内联最大字符数" }
        }
      }
    },
    {
      name: "invoke_video_analyze",
      description: "委派 video.analyze 对 NAS 中的视频/音频提取音频、Whisper 转字幕、生成 AI 总结并保存到文件元数据。已有总结时默认直接返回总结；设置 force=true 可重新总结。",
      inputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "文件 ID，优先使用 search_library_files 返回的 fileId" },
          path: { type: "string", description: "相对路径（与 fileId 二选一）" },
          filePath: { type: "string", description: "相对路径别名" },
          force: { type: "boolean", description: "已有总结时是否重新跑总结，默认 false" },
          includeSubtitle: { type: "boolean", description: "已有总结时是否同时返回字幕文本，默认 false" },
          waitForCompletion: { type: "boolean", description: "是否等待任务完成再返回。长视频建议 false，默认 false" },
          timeoutSeconds: { type: "integer", minimum: 5, maximum: 600 }
        }
      }
    },
    {
      name: "analyze_storage_video",
      description: "对 storage-client 中没有总结的视频/音频文件启动 video.analyze：提取音频、Whisper 转字幕、生成 AI 总结并保存到文件元数据。已有总结时默认直接返回总结；设置 force=true 可重新总结。",
      inputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "文件 ID，优先使用 list_storage_files 返回的 fileId" },
          path: { type: "string", description: "相对路径（与 fileId 二选一）" },
          filePath: { type: "string", description: "相对路径别名" },
          force: { type: "boolean", description: "已有总结时是否重新跑总结，默认 false" },
          includeSubtitle: { type: "boolean", description: "已有总结时是否同时返回字幕文本，默认 false" },
          waitForCompletion: { type: "boolean", description: "是否等待任务完成再返回。长视频建议 false，默认 false" },
          timeoutSeconds: { type: "integer", minimum: 5, maximum: 600 }
        }
      }
    },
    {
      name: "invoke_video_tag",
      description: "委派 video.tag 为 NAS 中的视频/音频生成并写入 AI 标签。单文件可直接执行；批量打标签必须先向用户确认，再传 confirmed=true。",
      inputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "文件 ID，优先使用 search_library_files 返回的 fileId" },
          path: { type: "string", description: "相对路径（与 fileId 二选一）" },
          batch: { type: "boolean", description: "是否批量处理所有视频文件" },
          confirmed: { type: "boolean", description: "批量写标签前必须由用户确认" },
          force: { type: "boolean", description: "是否覆盖已有标签" },
          aiSummary: { type: "string", description: "已有摘要，可作为打标签输入" },
          waitForCompletion: { type: "boolean", description: "是否等待任务完成，默认 false" },
          timeoutSeconds: { type: "integer", minimum: 5, maximum: 600 }
        }
      }
    },
    {
      name: "tag_storage_video",
      description: "委派 video.tag 为 NAS 中的视频生成并写入 AI 标签。单文件可直接执行；批量打标签必须先向用户确认，再传 confirmed=true。",
      inputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "文件 ID，优先使用 search_library_files 返回的 fileId" },
          path: { type: "string", description: "相对路径（与 fileId 二选一）" },
          batch: { type: "boolean", description: "是否批量处理所有视频文件" },
          confirmed: { type: "boolean", description: "批量写标签前必须由用户确认" },
          force: { type: "boolean", description: "是否覆盖已有标签" },
          aiSummary: { type: "string", description: "已有摘要，可作为打标签输入" },
          waitForCompletion: { type: "boolean", description: "是否等待任务完成，默认 false" },
          timeoutSeconds: { type: "integer", minimum: 5, maximum: 600 }
        }
      }
    },
    {
      name: "invoke_music_control",
      description: "委派 music.control 控制共享音乐播放器，支持状态、队列、搜歌、点歌、选择候选、暂停、继续、切歌和切换音源。默认等待短任务完成。",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "queue", "search", "enqueue", "pick", "play", "pause", "next", "previous", "source"] },
          command: { type: "string", description: "直接传给音乐助手的自然语言指令，例如 点歌 晴天" },
          keyword: { type: "string", description: "搜歌/点歌关键词" },
          query: { type: "string", description: "keyword 的别名" },
          song: { type: "string", description: "keyword 的别名" },
          source: { type: "string", description: "音源，例如 qq、netease、bilibili" },
          index: { type: "integer", minimum: 1, description: "选择最近搜索结果中的第几首" },
          waitForCompletion: { type: "boolean", description: "是否等待完成，默认 true" },
          timeoutSeconds: { type: "integer", minimum: 5, maximum: 120 }
        }
      }
    },
    ...getDelegatedBotToolDefinitions(),
    {
      name: "import_bilibili_video",
      description: "把一个或多个 bilibili 链接/BV 号交给 bilibili.downloader 批量下载并入库。需要同时下载多个视频时，把所有 source 放入 sources 数组一次调用，不要多次单独调用。通常应先用 search_bilibili_video 找到具体视频链接，再调用这个工具。",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "单个 bilibili 链接或 BV 号（与 sources 二选一）" },
          sources: { type: "array", items: { type: "string" }, description: "多个 bilibili 链接或 BV 号列表（批量下载时使用，与 source 二选一）" },
          targetFolder: { type: "string", description: "保存目录（相对于存储根目录）。不传则保存到根目录。示例：'movies'、'bilibili/教程'。" },
          page: { type: "integer", minimum: 1 },
          quality: { type: "string" }
        }
      }
    },
    {
      name: "search_bilibili_video",
      description: "在 B 站公开视频结果里搜索候选视频，返回可直接交给 import_bilibili_video 的视频链接。当用户要求去 B 站找教程、视频并下载入库时，优先先调用这个工具。",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          maxResults: { type: "integer", minimum: 1, maximum: MAX_BILIBILI_SEARCH_RESULTS }
        }
      }
    },
    {
      name: "search_web",
      description: "当用户明确要求联网搜索、查询最新信息、或问题需要外部网页信息时，先生成检索词和检索方案，再执行网页搜索并返回结果摘要。",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          preferredSource: { type: "string", enum: ["", "official", "github", "docs", "news"] },
          maxResults: { type: "integer", minimum: 1, maximum: MAX_WEB_SEARCH_RESULTS },
          fetchPages: { type: "integer", minimum: 0, maximum: MAX_WEB_PAGE_SUMMARIES }
        }
      }
    },
    {
      name: "search_yyets_show",
      description: "在 YYeTs（人人影视）资源站搜索剧集、电影，返回资源 ID 和名称列表。找到后再调用 download_yyets_episodes 按剧集下载磁力。",
      inputSchema: {
        type: "object",
        required: ["keyword"],
        properties: {
          keyword: { type: "string", description: "搜索关键词，如剧集中文名或英文名" }
        }
      }
    },
    {
      name: "download_yyets_episodes",
      description: "根据 YYeTs 资源 ID 批量提取磁力链接并交给 torrent.downloader 下载，下载内容保存在以剧集名命名的专属文件夹。通常先调用 search_yyets_show 获得 resource_id 再调用本工具。",
      inputSchema: {
        type: "object",
        required: ["resource_id"],
        properties: {
          resource_id: { type: "string", description: "YYeTs 资源 ID（从 search_yyets_show 返回）" },
          season_num: { type: "string", description: "季号，如 \"1\"、\"2\"；单剧/电影填 \"101\"；不填则所有季" },
          episodes: {
            type: "array",
            items: { type: ["string", "integer"] },
            description: "集号列表，如 [1, 2, 3]；不填则全季"
          },
          max_episodes: { type: "integer", minimum: 1, maximum: 50, description: "最多下载集数，默认 10" }
        }
      }
    }
  ];
}

export async function executeAiToolCall(toolCall, context, api, helpers = {}) {
  const name = String(toolCall?.name || "").trim();
  const input = toolCall?.input && typeof toolCall.input === "object" ? toolCall.input : {};
  const recentMessages = Array.isArray(helpers.recentMessages) ? helpers.recentMessages : [];

  if (name === "read_chat_history") {
    await api.emitProgress({ phase: "tool-read-chat-history", label: "读取更多聊天记录", percent: 40 });
    const messages = await readRecentChatHistory({
      storageRoot: api.storageRoot,
      historyPath: context.chat.historyPath,
      limit: clamp(input.limit || 20, 1, MAX_HISTORY_LIMIT),
      includeBots: input.includeBots !== false,
      lookbackDays: clamp(input.lookbackDays || 2, 0, 7)
    });
    return safeJson({
      count: messages.length,
      messages: messages.map((message) => ({
        id: message.id,
        createdAt: message.createdAt,
        author: message.author?.displayName || "用户",
        text: compactMessageText(message)
      }))
    });
  }

  if (name === "get_bot_job_status") {
    await api.emitProgress({ phase: "tool-get-bot-job-status", label: "读取 bot 任务状态", percent: 42 });
    return safeJson(await buildBotJobStatusResult(api, input));
  }

  if (name === "read_agent_trace") {
    await api.emitProgress({ phase: "tool-read-agent-trace", label: "读取 AI agent trace", percent: 42 });
    return safeJson(await buildAgentTraceResult(api, input));
  }

  if (name === "describe_image") {
    await api.emitProgress({ phase: "tool-describe-image", label: "准备图片分析输入", percent: 44 });
    const attachments = await listReferencedChatAttachments({
      storageRoot: api.storageRoot,
      hostClientId: context.chat.hostClientId,
      attachments: context.attachments,
      messages: recentMessages,
      limit: clamp(input.limit || 2, 1, MAX_IMAGE_TOOL_LIMIT),
      mimePrefix: "image/"
    });
    if (!attachments.length) {
      throw new Error("当前上下文里没有可分析的图片");
    }
    const imageInputs = [];
    for (const attachment of attachments) {
      imageInputs.push({
        name: attachment.name,
        mimeType: attachment.mimeType,
        dataUrl: await toDataUrl(attachment)
      });
    }
    await api.emitProgress({ phase: "tool-describe-image", label: "调用多模态模型分析图片", percent: 52 });
    const result = await invokeMultimodalModel({
      systemPrompt: [
        "你在执行 describe_image 工具。",
        buildRealtimeContextText(),
        "请输出精炼、结构化的中文图片分析结果。",
        "需要覆盖主体、场景、可见文字、潜在风险和不确定性。"
      ].join("\n"),
      userPrompt: String(input.prompt || "请描述图片内容并提炼关键信息。"),
      imageInputs,
      maxTokens: 900,
      temperature: 0.2
    });
    return safeJson({
      imageCount: imageInputs.length,
      model: result.model || "",
      analysis: String(result.text || "").trim()
    });
  }

  if (name === "list_storage_files") {
    await api.emitProgress({ phase: "tool-list-storage-files", label: "读取存储文件索引", percent: 42 });
    return safeJson(await buildLibraryListResult(api, input));
  }

  if (name === "search_library_files") {
    await api.emitProgress({ phase: "tool-search-library-files", label: "搜索 NAS 文件索引", percent: 42 });
    return safeJson(await buildLibraryListResult(api, input));
  }

  if (name === "read_file_metadata") {
    await api.emitProgress({ phase: "tool-read-file-metadata", label: "读取 NAS 文件元数据", percent: 43 });
    return safeJson(await buildLibraryMetadataResult(api, input));
  }

  if (name === "read_text_excerpt") {
    await api.emitProgress({ phase: "tool-read-text-excerpt", label: "读取受控文本片段", percent: 45 });
    return safeJson(await buildTextExcerptResult(api, input));
  }

  if (name === "read_media_summary") {
    await api.emitProgress({ phase: "tool-read-media-summary", label: "读取媒体派生摘要", percent: 45 });
    return safeJson(await buildMediaSummaryResult(api, input));
  }

  if (name === "analyze_file_content") {
    await api.emitProgress({ phase: "tool-analyze-file-content", label: "分析 NAS 文件内容", percent: 50 });
    return safeJson(await buildAnalyzeFileContentResult(api, input));
  }

  if (name === "update_file_metadata") {
    await api.emitProgress({ phase: "tool-update-file-metadata", label: "写入 NAS 文件 metadata", percent: 48 });
    return safeJson(await buildUpdateFileMetadataResult(api, input));
  }

  if (name === "organize_files") {
    await api.emitProgress({ phase: "tool-organize-files", label: "预览 NAS 文件整理操作", percent: 48 });
    return safeJson(await buildOrganizeFilesResult(api, input));
  }

  if (name === "explain_file_access") {
    await api.emitProgress({ phase: "tool-explain-file-access", label: "整理 NAS 文件访问边界", percent: 42 });
    return safeJson(await buildFileAccessExplanation(api, input));
  }

  if (name === "get_storage_file_details") {
    await api.emitProgress({ phase: "tool-get-storage-file-details", label: "读取文件详情与元数据", percent: 44 });
    return safeJson(await buildLibraryDetailsResult(api, input));
  }

  if (name === "analyze_storage_video" || name === "invoke_video_analyze") {
    await api.emitProgress({ phase: "tool-analyze-storage-video", label: "定位待分析文件", percent: 46 });
    const identifier = String(input.fileId || input.path || input.filePath || "").trim();
    if (!identifier) {
      throw new Error("fileId or path is required");
    }
    const snapshot = await loadLibrarySnapshot(api);
    const file = resolveLibraryFile(snapshot.files, identifier);
    if (!file) {
      throw new Error(`文件未找到: ${identifier}`);
    }

    if (file.aiSummary && input.force !== true) {
      const subtitle = input.includeSubtitle === true || input.includeSrt === true
        ? await readSubtitleForFile(api, file, input.subtitleMaxChars || 12_000)
        : null;
      return safeJson({
        status: "already_summarized",
        file: {
          fileId: file.id,
          path: file.relativePath,
          name: file.name,
          mimeType: file.mimeType,
          subtitleAvailable: Boolean(file.subtitleAvailable),
          subtitlePath: file.subtitlePath || ""
        },
        aiSummary: file.aiSummary,
        subtitle
      });
    }

    const mimeType = String(file.mimeType || "").toLowerCase();
    if (!mimeType.startsWith("video/") && !mimeType.startsWith("audio/")) {
      throw new Error(`video analyze 仅支持视频/音频文件，当前 MIME: ${file.mimeType}`);
    }

    await api.emitProgress({ phase: "tool-analyze-storage-video", label: "创建视频转录与总结任务", percent: 52 });
    const delegatedJob = await api.invokeBot({
      botId: "video.analyze",
      trigger: {
        type: "tool-call",
        rawText: file.relativePath,
        parsedArgs: {
          fileId: file.id,
          filePath: file.relativePath
        }
      },
      options: {
        delegatedBy: api.botId,
        parentJobId: api.jobId,
        toolName: name
      }
    });

    if (input.waitForCompletion === true) {
      await api.emitProgress({ phase: "tool-analyze-storage-video", label: "等待视频总结任务完成", percent: 58 });
      const completedJob = await waitForDelegatedBotJob(api, delegatedJob.jobId, {
        timeoutSeconds: input.timeoutSeconds || 600
      });
      return safeJson({
        status: completedJob.status,
        jobId: completedJob.jobId,
        file: {
          fileId: file.id,
          path: file.relativePath,
          name: file.name,
          mimeType: file.mimeType
        },
        result: completedJob.result || {},
        error: completedJob.error || null
      });
    }

    return safeJson({
      status: delegatedJob.status || "queued",
      delegated: true,
      botId: "video.analyze",
      jobId: delegatedJob.jobId || "",
      file: {
        fileId: file.id,
        path: file.relativePath,
        name: file.name,
        mimeType: file.mimeType,
        subtitleAvailable: Boolean(file.subtitleAvailable),
        subtitlePath: file.subtitlePath || ""
      },
      message: "已提交视频转录与 AI 总结任务，完成后会写入文件元数据。"
    });
  }

  if (name === "tag_storage_video" || name === "invoke_video_tag") {
    await api.emitProgress({ phase: "tool-tag-storage-video", label: "准备视频打标签任务", percent: 46 });
    if (input.batch === true) {
      if (input.confirmed !== true) {
        const snapshot = await loadLibrarySnapshot(api);
        const targetFiles = snapshot.files.filter(isVideoOrAudioStorageFile);
        return safeJson({
          status: targetFiles.length ? "confirmation_required" : "no_targets",
          delegated: false,
          botId: "video.tag",
          batch: true,
          confirmed: false,
          requiresConfirmation: targetFiles.length > 0,
          blocked: targetFiles.length > 0,
          blockedReason: targetFiles.length
            ? "批量视频打标签会写入多个文件的 metadata；本次只返回影响范围预览，未创建子任务。"
            : "当前 NAS 索引里没有可打标签的视频/音频文件。",
          confirmation: targetFiles.length
            ? buildBatchVideoTagConfirmation(targetFiles, input)
            : null,
          nextAction: targetFiles.length
            ? "向用户确认影响范围后，以 confirmed=true 再次调用。"
            : "先确认文件库里已有视频/音频文件，或刷新 storage-client 索引。"
        });
      }
      const delegatedJob = await api.invokeBot({
        botId: "video.tag",
        trigger: {
          type: "tool-call",
          rawText: "batch tag storage videos",
          parsedArgs: {
            batch: true,
            force: input.force === true
          }
        },
        options: {
          delegatedBy: api.botId,
          parentJobId: api.jobId,
          toolName: name
        }
      });
      return safeJson({
        delegated: true,
        botId: "video.tag",
        jobId: delegatedJob.jobId || "",
        status: delegatedJob.status || "queued",
        batch: true,
        message: "已提交批量视频打标签任务。"
      });
    }

    const identifier = String(input.fileId || input.path || input.filePath || "").trim();
    if (!identifier) {
      throw new Error("fileId or path is required");
    }
    const snapshot = await loadLibrarySnapshot(api);
    const file = resolveLibraryFile(snapshot.files, identifier);
    if (!file) {
      throw new Error(`文件未找到: ${identifier}`);
    }
    const mimeType = String(file.mimeType || "").toLowerCase();
    if (!mimeType.startsWith("video/") && !mimeType.startsWith("audio/")) {
      throw new Error(`video tag 仅支持视频/音频文件，当前 MIME: ${file.mimeType}`);
    }

    const delegatedJob = await api.invokeBot({
      botId: "video.tag",
      trigger: {
        type: "tool-call",
        rawText: file.relativePath,
        parsedArgs: {
          fileId: file.id,
          force: input.force === true,
          aiSummary: String(input.aiSummary || file.aiSummary || "")
        }
      },
      options: {
        delegatedBy: api.botId,
        parentJobId: api.jobId,
        toolName: name
      }
    });

    if (input.waitForCompletion === true) {
      await api.emitProgress({ phase: "tool-tag-storage-video", label: "等待视频打标签任务完成", percent: 58 });
      const completedJob = await waitForDelegatedBotJob(api, delegatedJob.jobId, {
        timeoutSeconds: input.timeoutSeconds || 600
      });
      return safeJson({
        status: completedJob.status,
        jobId: completedJob.jobId,
        file: {
          fileId: file.id,
          path: file.relativePath,
          name: file.name,
          mimeType: file.mimeType
        },
        result: completedJob.result || {},
        error: completedJob.error || null
      });
    }

    return safeJson({
      delegated: true,
      botId: "video.tag",
      jobId: delegatedJob.jobId || "",
      status: delegatedJob.status || "queued",
      file: {
        fileId: file.id,
        path: file.relativePath,
        name: file.name,
        mimeType: file.mimeType
      },
      message: "已提交视频打标签任务，完成后会写入文件 metadata。"
    });
  }

  if (name === "invoke_music_control") {
    await api.emitProgress({ phase: "tool-invoke-music-control", label: "委派音乐助手", percent: 46 });
    const prompt = buildMusicControlPrompt(input);
    if (!prompt) {
      throw new Error("music command is required");
    }
    const delegatedJob = await api.invokeBot({
      botId: "music.control",
      trigger: {
        type: "tool-call",
        rawText: prompt,
        parsedArgs: {
          prompt
        }
      },
      options: {
        delegatedBy: api.botId,
        parentJobId: api.jobId,
        toolName: name
      }
    });

    if (input.waitForCompletion !== false) {
      await api.emitProgress({ phase: "tool-invoke-music-control", label: "等待音乐助手返回", percent: 58 });
      const completedJob = await waitForDelegatedBotJob(api, delegatedJob.jobId, {
        timeoutSeconds: input.timeoutSeconds || 45,
        pollIntervalMs: 700
      });
      return safeJson({
        status: completedJob.status,
        jobId: completedJob.jobId,
        prompt,
        result: completedJob.result || {},
        error: completedJob.error || null
      });
    }

    return safeJson({
      delegated: true,
      botId: "music.control",
      jobId: delegatedJob.jobId || "",
      status: delegatedJob.status || "queued",
      prompt
    });
  }

  if (isDelegatedBotToolName(name)) {
    await api.emitProgress({
      phase: `tool-${name.replace(/^invoke_/, "").replace(/_/g, "-")}`,
      label: "委派下载类 bot",
      percent: 48
    });
    return safeJson(await executeDelegatedBotToolCall(name, api, input));
  }

  if (name === "import_bilibili_video") {
    await api.emitProgress({ phase: "tool-import-bilibili-video", label: "创建 B 站下载任务", percent: 46 });
    const sourcesInput = Array.isArray(input.sources) && input.sources.length
      ? input.sources.map((s) => String(s || "").trim()).filter(Boolean)
      : [String(input.source || "").trim()].filter(Boolean);
    if (!sourcesInput.length) {
      throw new Error("source or sources is required");
    }
    // Put all sources in rawText so bilibili.downloader batch-mode picks them all up.
    const rawText = sourcesInput.join(" ");
    const isBatch = sourcesInput.length > 1;
    const delegatedJob = await api.invokeBot({
      botId: "bilibili.downloader",
      trigger: {
        type: "tool-call",
        rawText,
        parsedArgs: isBatch
          ? { targetFolder: String(input.targetFolder || "").trim() }
          : {
            source: sourcesInput[0],
            targetFolder: String(input.targetFolder || "").trim(),
            page: Number.isInteger(input.page) ? input.page : undefined,
            quality: String(input.quality || "").trim()
          }
      },
      options: {
        delegatedBy: api.botId,
        parentJobId: api.jobId,
        toolName: name
      }
    });
    return safeJson({
      delegated: true,
      botId: "bilibili.downloader",
      jobId: delegatedJob.jobId || "",
      status: delegatedJob.status || "queued",
      sources: sourcesInput,
      batch: isBatch
    });
  }

  if (name === "search_bilibili_video") {
    const query = String(input.query || input.prompt || "").trim();
    if (!query) {
      throw new Error("query is required");
    }
    const result = await searchBilibiliVideos(query, api.signal, input.maxResults || 4);
    return safeJson(result);
  }

  if (name === "search_web") {
    const query = String(input.query || input.prompt || "").trim();
    if (!query) {
      throw new Error("query is required");
    }
    const preferredSource = normalizeSourcePreference(input.preferredSource || "");
    const maxResults = clamp(input.maxResults || 5, 1, MAX_WEB_SEARCH_RESULTS);
    const fetchPages = clamp(input.fetchPages ?? 3, 0, MAX_WEB_PAGE_SUMMARIES);
    const directUrls = extractDirectWebUrls(query);
    await api.emitProgress({
      phase: "search-plan",
      label: "生成检索方案",
      percent: 42,
      details: createWebSearchProgressDetails({ stage: "plan", query, directUrls, preferredSource })
    });
    const plan = await buildWebSearchPlan(query, api.signal, preferredSource);
    await api.appendLog(`web search plan: ${safeJson(plan)}`);

    if (directUrls.length) {
      const fetchedDirectPages = [];
      await api.emitProgress({
        phase: "fetch-web-pages",
        label: `优先打开用户给出的网页（${directUrls.length} 个）`,
        percent: 46,
        details: createWebSearchProgressDetails({ stage: "direct-fetch", query, directUrls, preferredSource: plan.preferredSource || preferredSource, plan })
      });
      for (const [urlIndex, directUrl] of directUrls.entries()) {
        const fetchPercent = 46 + Math.round(((urlIndex + 1) / directUrls.length) * 12);
        await api.emitProgress({
          phase: "fetch-web-pages",
          label: formatStepLabel("正在打开用户网页，", urlIndex + 1, directUrls.length, "网页"),
          percent: Math.max(47, Math.min(58, fetchPercent)),
          details: createWebSearchProgressDetails({
            stage: "direct-fetch",
            query,
            directUrls,
            preferredSource: plan.preferredSource || preferredSource,
            plan,
            fetchedPages: fetchedDirectPages
          })
        });
        try {
          const page = await fetchWebPageSummary(directUrl, {
            signal: api.signal,
            backend: "playwright"
          });
          fetchedDirectPages.push(page);
        } catch (error) {
          try {
            const page = await fetchWebPageSummary(directUrl, {
              signal: api.signal,
              backend: "fetch"
            });
            fetchedDirectPages.push(page);
          } catch (fallbackError) {
            fetchedDirectPages.push({
              url: directUrl,
              title: "",
              description: "",
              excerpt: `页面抓取失败：${String(fallbackError?.message || fallbackError || error || "未知错误").trim()}`,
              backend: "playwright"
            });
          }
        }
      }
      await api.appendLog(`web direct fetch: ${safeJson(fetchedDirectPages)}`);
      const directResults = fetchedDirectPages.map((page) => ({
        query,
        matchedQuery: String(page?.url || query).trim(),
        title: String(page?.title || page?.url || "").trim(),
        url: String(page?.url || "").trim(),
        snippet: String(page?.description || page?.excerpt || "").trim().slice(0, 280),
        matchedSource: "direct-url",
        page
      }));
      const hasUsefulDirectPage = directResults.some((item) => {
        const excerpt = String(item?.page?.excerpt || item?.page?.description || item?.title || "").trim();
        return excerpt && !excerpt.startsWith("页面抓取失败：");
      });
      if (hasUsefulDirectPage) {
        const followUpDecision = {
          needsPageFetch: false,
          answerableFromResults: true,
          reason: "检测到用户直接给出了网页链接，已优先抓取页面内容并交给模型综合判断。",
          selectedIndexes: []
        };
        await api.emitProgress({
          phase: "search-follow-up",
          label: "已获取用户网页内容，等待模型综合判断",
          percent: 62,
          details: createWebSearchProgressDetails({
            stage: "direct-fetch-complete",
            query,
            directUrls,
            preferredSource: plan.preferredSource || preferredSource,
            plan,
            followUpDecision,
            fetchedPages: fetchedDirectPages
          })
        });
        return safeJson({
          query,
          searchedAt: new Date().toISOString(),
          directFetchUsed: true,
          directUrls,
          plan,
          followUpDecision,
          preferredSource: plan.preferredSource || preferredSource,
          preferredSourceLabel: getSourcePreferenceLabel(plan.preferredSource || preferredSource),
          resultCount: directResults.length,
          results: directResults
        });
      }
      await api.emitProgress({
        phase: "web-search",
        label: "直链抓取不足，继续联网补充搜索",
        percent: 48,
        details: createWebSearchProgressDetails({
          stage: "direct-fetch-fallback",
          query,
          directUrls,
          preferredSource: plan.preferredSource || preferredSource,
          plan,
          fetchedPages: fetchedDirectPages
        })
      });
    }

    const mergedResults = [];
    const seenUrls = new Set();
    const searchTerms = normalizeSearchTermList(plan.searchTerms, query);
    const executedQueries = [];
    const totalSearchTerms = searchTerms.length || 1;
    for (const [termIndex, term] of searchTerms.entries()) {
      const searchPercent = 48 + Math.round(((termIndex + 1) / totalSearchTerms) * 6);
      executedQueries.push(term);
      await api.emitProgress({
        phase: "web-search",
        label: formatStepLabel("执行联网搜索，", termIndex + 1, totalSearchTerms, "检索词"),
        percent: Math.max(48, Math.min(54, searchPercent)),
        details: createWebSearchProgressDetails({
          stage: "search",
          query,
          directUrls,
          preferredSource: plan.preferredSource || preferredSource,
          plan,
          executedQueries,
          results: mergedResults
        })
      });
      const batch = await searchWeb(term, {
        signal: api.signal,
        limit: maxResults,
        preferredSource: plan.preferredSource || preferredSource
      });
      for (const result of batch.results) {
        const normalizedUrl = String(result.url || "").trim();
        if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
          continue;
        }
        seenUrls.add(normalizedUrl);
        mergedResults.push({
          query: batch.query,
          matchedQuery: String(result.matchedQuery || batch.query || "").trim(),
          title: String(result.title || "").trim(),
          url: normalizedUrl,
          snippet: String(result.snippet || "").trim(),
          matchedSource: String(result.matchedSource || "generic").trim()
        });
        if (mergedResults.length >= maxResults) {
          break;
        }
      }
      if (mergedResults.length >= maxResults) {
        break;
      }
    }

    await api.emitProgress({
      phase: "search-follow-up",
      label: "分析搜索摘要并决定是否进页",
      percent: 58,
      details: createWebSearchProgressDetails({
        stage: "follow-up",
        query,
        directUrls,
        preferredSource: plan.preferredSource || preferredSource,
        plan,
        executedQueries,
        results: mergedResults
      })
    });
    const followUpDecision = await decideWebSearchFollowUp({
      query,
      preferredSource: plan.preferredSource || preferredSource,
      plan,
      results: mergedResults,
      signal: api.signal,
      fetchPages
    });
    await api.appendLog(`web search follow-up: ${safeJson(followUpDecision)}`);

    const selectedResultIndexes = new Set(
      (Array.isArray(followUpDecision.selectedIndexes) ? followUpDecision.selectedIndexes : [])
        .map((item) => Number(item) - 1)
        .filter((item) => Number.isInteger(item) && item >= 0 && item < mergedResults.length)
    );

    const enrichedResults = [];
    const fetchedPages = [];
    if (selectedResultIndexes.size) {
      await api.emitProgress({
        phase: "fetch-web-pages",
        label: `准备抓取 ${selectedResultIndexes.size} 个网页详情`,
        percent: 64,
        details: createWebSearchProgressDetails({
          stage: "fetch-pages",
          query,
          directUrls,
          preferredSource: plan.preferredSource || preferredSource,
          plan,
          executedQueries,
          results: mergedResults,
          followUpDecision
        })
      });
    } else {
      await api.emitProgress({
        phase: "search-follow-up",
        label: "搜索摘要已足够回答",
        percent: 64,
        details: createWebSearchProgressDetails({
          stage: "follow-up-complete",
          query,
          directUrls,
          preferredSource: plan.preferredSource || preferredSource,
          plan,
          executedQueries,
          results: mergedResults,
          followUpDecision
        })
      });
    }
    const selectedIndexesOrdered = [...selectedResultIndexes].sort((left, right) => left - right);
    const selectedIndexOrderMap = new Map(selectedIndexesOrdered.map((item, idx) => [item, idx]));
    for (let index = 0; index < mergedResults.length; index += 1) {
      const result = mergedResults[index];
      let page = null;
      if (selectedResultIndexes.has(index)) {
        const fetchStep = (selectedIndexOrderMap.get(index) || 0) + 1;
        const fetchTotal = selectedIndexesOrdered.length || 1;
        const fetchPercent = 64 + Math.round((fetchStep / fetchTotal) * 8);
        await api.emitProgress({
          phase: "fetch-web-pages",
          label: formatStepLabel("正在抓取，", fetchStep, fetchTotal, "网页"),
          percent: Math.max(65, Math.min(72, fetchPercent)),
          details: createWebSearchProgressDetails({
            stage: "fetch-pages",
            query,
            directUrls,
            preferredSource: plan.preferredSource || preferredSource,
            plan,
            executedQueries,
            results: mergedResults,
            followUpDecision,
            fetchedPages
          })
        });
        try {
          page = await fetchWebPageSummary(result.url, { signal: api.signal });
        } catch (error) {
          page = {
            url: result.url,
            title: "",
            description: "",
            excerpt: `页面抓取失败：${String(error?.message || error || "未知错误").trim()}`
          };
        }
        fetchedPages.push(page);
      }
      enrichedResults.push({
        query: result.query,
        matchedQuery: result.matchedQuery,
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        matchedSource: result.matchedSource,
        page
      });
    }

    return safeJson({
      query,
      searchedAt: new Date().toISOString(),
      plan,
      followUpDecision,
      executedQueries,
      preferredSource: plan.preferredSource || preferredSource,
      preferredSourceLabel: getSourcePreferenceLabel(plan.preferredSource || preferredSource),
      resultCount: enrichedResults.length,
      results: enrichedResults
    });
  }

  if (name === "search_yyets_show") {
    const keyword = String(input.keyword || "").trim();
    if (!keyword) {
      throw new Error("keyword is required");
    }
    await api.emitProgress({ phase: "tool-search-yyets", label: `搜索 YYeTs：${keyword}`, percent: 42 });
    const results = await searchYYeTsShows(keyword, api.signal);
    return safeJson({
      keyword,
      count: results.length,
      results
    });
  }

  if (name === "download_yyets_episodes") {
    const resourceId = String(input.resource_id || "").trim();
    if (!resourceId) {
      throw new Error("resource_id is required");
    }
    const seasonNum = input.season_num ? String(input.season_num).trim() : undefined;
    const episodes = Array.isArray(input.episodes) && input.episodes.length
      ? input.episodes.map((ep) => String(ep))
      : undefined;
    const maxEpisodes = clamp(input.max_episodes ?? 10, 1, 50);

    await api.emitProgress({ phase: "tool-yyets-fetch", label: `获取 YYeTs 资源详情（id=${resourceId}）`, percent: 42 });
    const resourceData = await getYYeTsResource(resourceId, api.signal);
    const cnname = sanitizeShowName(resourceData?.info?.cnname || resourceId);

    await api.emitProgress({ phase: "tool-yyets-magnets", label: `提取磁力链接：${cnname}`, percent: 50 });
    const magnets = extractEpisodeMagnets(resourceData, { seasonNum, episodes, maxEpisodes });

    if (!magnets.length) {
      return safeJson({
        status: "no_magnets",
        cnname,
        message: `未能从 YYeTs 找到资源 ${cnname} 的磁力链接（季号=${seasonNum ?? "全部"}，集号=${episodes?.join(",") ?? "全部"}）。可能仅提供网盘或电驴资源。`
      });
    }

    const dispatched = [];
    const failed = [];

    await api.emitProgress({ phase: "tool-yyets-dispatch", label: `提交 ${magnets.length} 个磁力下载任务`, percent: 55 });

    await Promise.allSettled(
      magnets.map(async (item) => {
        const seasonFolder = item.season_cn ? sanitizeShowName(item.season_cn) : "";
        const targetFolder = ["TV shows", cnname, seasonFolder].filter(Boolean).join("/");
        try {
          const delegatedJob = await api.invokeBot({
            botId: "torrent.downloader",
            trigger: {
              type: "tool-call",
              rawText: item.magnet,
              parsedArgs: {
                source: item.magnet,
                targetFolder,
                __chatReplyMode: "new-chat-message"
              }
            },
            options: {
              delegatedBy: api.botId,
              parentJobId: api.jobId,
              toolName: name
            }
          });
          dispatched.push({
            episode: item.episode,
            season_cn: item.season_cn,
            name: item.name,
            size: item.size,
            format: item.format,
            jobId: delegatedJob.jobId || "",
            targetFolder
          });
        } catch (err) {
          failed.push({ episode: item.episode, name: item.name, error: err.message });
        }
      })
    );

    return safeJson({
      status: dispatched.length > 0 ? "dispatched" : "failed",
      cnname,
      season: seasonNum ?? "全部",
      totalMagnets: magnets.length,
      dispatched,
      failed
    });
  }

  throw new Error(`unsupported AI tool: ${name}`);
}
