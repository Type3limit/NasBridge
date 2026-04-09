import fs from "node:fs";
import { searchBilibiliVideoCandidates } from "./bilibiliApi.js";
import { readRecentChatHistory } from "./chatHistory.js";
import { listReferencedChatAttachments } from "./chatAssets.js";
import { invokeMultimodalModel, invokeTextModel } from "./llmClient.js";
import { fetchWebPageSummary, getSourcePreferenceLabel, normalizeSourcePreference, searchWeb } from "./httpFetch.js";
import { buildRealtimeContextText } from "./realtimeContext.js";
import { searchYYeTsShows, getYYeTsResource, extractEpisodeMagnets, sanitizeShowName } from "./yyetsApi.js";

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