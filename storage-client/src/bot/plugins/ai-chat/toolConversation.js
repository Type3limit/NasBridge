import { executeAiToolCall, getAiToolDefinitions } from "../../tools/aiToolRuntime.js";
import { buildCapabilityDescriptors, summarizeCapabilityExecutionReadiness } from "../../capabilities/registry.js";
import { invokeTextModel, parseModelRef } from "../../tools/llmClient.js";

const MAX_TOOL_ROUND_OFFSET = 8;
const JSON_FALLBACK_REPAIR_ATTEMPTS = 1;
const TRACE_INPUT_TEXT_LIMIT = 160;

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

function normalizeToolInput(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function compactToolDefinitionsForJsonFallback(tools = []) {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    name: String(tool?.name || "").trim(),
    description: String(tool?.description || "").trim(),
    inputSchema: tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} }
  })).filter((tool) => tool.name);
}

function findCachedModel(modelRef = "", modelSettings = {}) {
  const models = Array.isArray(modelSettings?.lastListedModels) ? modelSettings.lastListedModels : [];
  if (!models.length) {
    return null;
  }
  const parsed = parseModelRef(modelRef);
  const modelId = String(parsed.modelId || modelRef || "").trim().toLowerCase();
  const fullRef = String(modelRef || "").trim().toLowerCase();
  for (const model of models) {
    const candidateId = String(model?.id || "").trim();
    const candidateParsed = parseModelRef(candidateId);
    const candidateModelId = String(model?.modelId || candidateParsed.modelId || candidateId || "").trim().toLowerCase();
    const candidateRef = candidateId.toLowerCase();
    const candidateName = String(model?.name || "").trim().toLowerCase();
    const providerMatches = !parsed.provider || !model?.provider || String(model.provider || "").trim().toLowerCase() === parsed.provider;
    if (!providerMatches) {
      continue;
    }
    if (candidateRef === fullRef || candidateModelId === modelId || candidateName === modelId) {
      return model;
    }
  }
  return null;
}

export function shouldUseJsonToolFallback({ model = "", modelSettings = {} } = {}) {
  const cached = findCachedModel(model, modelSettings);
  return cached ? cached.toolCalls !== true : false;
}

function isNativeToolUnsupportedError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return /tool|function|tool_choice|tools/.test(message) && /support|unsupported|not supported|invalid|unknown|不支持|无效/.test(message);
}

function buildJsonFallbackSystemPrompt(tools = [], allowToolCalls = true) {
  const toolCatalog = compactToolDefinitionsForJsonFallback(tools);
  const examples = allowToolCalls
    ? [
        '{"action":"call_tool","tool":"search_library_files","arguments":{"kind":"video","limit":5},"reason":"需要先定位 NAS 文件"}',
        '{"action":"final_answer","answer":"这里写给用户的最终回答"}'
      ]
    : ['{"action":"final_answer","answer":"这里写给用户的最终回答"}'];
  return [
    "当前模型不使用原生 tool-call。你必须用严格 JSON 作为 agent plan 输出，不要输出 Markdown。",
    allowToolCalls
      ? "如果需要调用工具，输出 {\"action\":\"call_tool\",\"tool\":\"工具名\",\"arguments\":{...},\"reason\":\"为什么调用\"}。"
      : "当前已达到工具轮数上限，只能输出 final_answer。",
    "如果已经能回答用户，输出 {\"action\":\"final_answer\",\"answer\":\"...\"}。",
    "arguments 必须是 JSON object，字段必须符合工具 inputSchema。一次只调用一个工具。",
    "可用工具：",
    JSON.stringify(toolCatalog, null, 2),
    "示例：",
    examples.join("\n")
  ].join("\n");
}

function normalizeMessagesForJsonFallback(messages = [], fallbackSystemPrompt = "") {
  const normalized = [];
  let inserted = false;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message?.role) {
      continue;
    }
    if (message.role === "tool") {
      normalized.push({
        role: "user",
        content: `工具返回：\n${String(message.content || "").trim()}`
      });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const content = String(message.content || "").trim();
      normalized.push({
        role: "assistant",
        content: content || `已请求工具：${message.tool_calls.map((call) => call?.function?.name).filter(Boolean).join(", ")}`
      });
      continue;
    }
    normalized.push({
      role: message.role,
      content: String(message.content || "")
    });
    if (!inserted && message.role === "system") {
      normalized.push({ role: "system", content: fallbackSystemPrompt });
      inserted = true;
    }
  }
  if (!inserted) {
    normalized.unshift({ role: "system", content: fallbackSystemPrompt });
  }
  return normalized;
}

export function parseJsonToolPlan(text = "", tools = [], options = {}) {
  const parsed = parseJsonBlock(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "model did not return a JSON object",
      finalAnswer: String(text || "").trim()
    };
  }
  const action = String(parsed.action || (parsed.tool ? "call_tool" : "final_answer")).trim().toLowerCase();
  if (action === "final_answer" || action === "answer" || action === "finish") {
    return {
      ok: true,
      action: "final_answer",
      finalAnswer: String(parsed.answer || parsed.final || parsed.message || "").trim()
    };
  }
  if (action !== "call_tool" && action !== "tool") {
    return {
      ok: false,
      error: `unsupported JSON plan action: ${action || "empty"}`,
      finalAnswer: String(parsed.answer || "").trim()
    };
  }
  const toolName = String(parsed.tool || parsed.name || parsed.toolName || "").trim();
  const tool = (Array.isArray(tools) ? tools : []).find((item) => item?.name === toolName);
  if (!tool) {
    return {
      ok: false,
      error: `unknown tool in JSON plan: ${toolName || "empty"}`,
      finalAnswer: ""
    };
  }
  if (options.allowToolCalls === false) {
    return {
      ok: false,
      error: "tool call requested after max tool rounds",
      finalAnswer: ""
    };
  }
  return {
    ok: true,
    action: "call_tool",
    toolCall: {
      id: `jsonplan_${Number(options.round || 0)}_${toolName.replace(/[^a-z0-9_:-]/gi, "_")}`,
      name: toolName,
      input: normalizeToolInput(parsed.arguments || parsed.args || parsed.input),
      fallbackJsonPlan: true,
      reason: String(parsed.reason || "").trim()
    }
  };
}

function createJsonFallbackAssistantMessage(result = {}, planText = "") {
  return {
    role: "assistant",
    content: String(planText || result.text || "").trim()
  };
}

function previewText(value = "", maxLength = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function summarizePendingToolCalls(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((call) => ({
    id: String(call?.id || "").trim(),
    name: String(call?.name || "").trim(),
    fallbackJsonPlan: call?.fallbackJsonPlan === true,
    reason: String(call?.reason || "").trim()
  })).filter((call) => call.name);
}

function truncateTraceText(value = "", limit = TRACE_INPUT_TEXT_LIMIT) {
  const text = String(value || "").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function summarizeStringList(value, limit = 5) {
  if (Array.isArray(value)) {
    return value.map((item) => truncateTraceText(item, 96)).filter(Boolean).slice(0, limit);
  }
  const single = truncateTraceText(value, 96);
  return single ? [single] : [];
}

function buildToolInputSummary(toolCall = {}) {
  const input = normalizeToolInput(toolCall.input);
  const keys = Object.keys(input).filter((key) => !String(key || "").startsWith("__")).sort();
  const identifiers = [
    ...summarizeStringList(input.fileId),
    ...summarizeStringList(input.fileIds),
    ...summarizeStringList(input.path),
    ...summarizeStringList(input.paths),
    ...summarizeStringList(input.filePath)
  ];
  const filters = {};
  for (const key of ["query", "kind", "pathPrefix", "mimePrefix", "extension", "updatedAfter", "updatedBefore", "preferredSource"]) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== "") {
      filters[key] = truncateTraceText(input[key], key === "query" ? 120 : 80);
    }
  }
  const options = {};
  for (const key of ["batch", "force", "forceAnalyze", "waitForCompletion", "dryRun", "confirmed", "includeSummary", "includeSubtitle", "includeTranscriptExcerpt"]) {
    if (typeof input[key] === "boolean") {
      options[key] = input[key];
    }
  }
  for (const key of ["limit", "maxResults", "timeoutSeconds", "maxChars"]) {
    if (Number.isFinite(Number(input[key]))) {
      options[key] = Number(input[key]);
    }
  }
  const counts = {};
  for (const key of ["fileIds", "paths", "sources", "actions", "tags", "addTags", "removeTags"]) {
    if (Array.isArray(input[key])) {
      counts[key] = input[key].length;
    }
  }
  return Object.fromEntries(Object.entries({
    tool: String(toolCall.name || "").trim(),
    keys,
    identifiers: identifiers.slice(0, 8),
    filters,
    options,
    counts,
    fallbackJsonPlan: toolCall.fallbackJsonPlan === true,
    reason: truncateTraceText(toolCall.reason || "", 180)
  }).filter(([, value]) => {
    if (value === false || value === null || value === undefined || value === "") {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (value && typeof value === "object") {
      return Object.keys(value).length > 0;
    }
    return true;
  }));
}

function buildTraceTiming(startedAt = "", startedMs = 0) {
  const finishedAt = new Date().toISOString();
  return {
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.now() - startedMs)
  };
}

async function recordAgentPlanningEvent(api = {}, {
  round = 0,
  status = "completed",
  model = "",
  fallback = "",
  finishReason = "",
  pendingToolCalls = [],
  text = "",
  parseError = "",
  retryReason = ""
} = {}) {
  await api?.traceHooks?.recordAgentEvent?.({
    phase: "plan_next_step",
    round,
    status,
    detail: {
      model: String(model || "").trim(),
      fallback: String(fallback || "").trim(),
      finishReason: String(finishReason || "").trim(),
      pendingTools: summarizePendingToolCalls(pendingToolCalls),
      parseError: String(parseError || "").trim(),
      retryReason: String(retryReason || "").trim()
    },
    outputPreview: previewText(text)
  });
}

async function recordAgentObservationEvent(api = {}, { round = 0, toolName = "", fallback = "", status = "", observation = "" } = {}) {
  await api?.traceHooks?.recordAgentEvent?.({
    phase: "observe_result",
    round,
    status,
    detail: {
      tool: String(toolName || "").trim(),
      fallback: String(fallback || "").trim(),
      observationLength: String(observation || "").length
    },
    outputPreview: previewText(observation)
  });
}

function redactLocalPaths(value = "") {
  return String(value || "")
    .replace(/[A-Za-z]:[\\/][^\s；,，]+/g, "[local-path]")
    .replace(/\\\\[^\\/\s；,，]+[\\/][^\s；,，]+/g, "[network-path]");
}

function buildHealthRepairHint(checkId = "") {
  const normalized = String(checkId || "").trim();
  if (normalized === "whisper") {
    return "配置 WHISPER_CPP_PATH 和 WHISPER_MODEL_PATH 后再启动视频/音频转录分析。";
  }
  if (normalized === "ffmpeg" || normalized === "ffprobe") {
    return "配置 FFMPEG_PATH/FFPROBE_PATH，或确认 ffmpeg/ffprobe 在 PATH 中可执行。";
  }
  if (normalized === "music-bridge") {
    return "先启动 music-lib-bridge，再重试音乐控制工具。";
  }
  if (normalized === "storage-root") {
    return "检查 STORAGE_ROOT 是否存在且 storage-client 有读写权限。";
  }
  if (normalized === "ai-model") {
    return "运行 @ai /models 刷新模型列表，并用 @ai /model use 选择可用模型。";
  }
  if (normalized === "yt-dlp") {
    return "配置 YT_DLP_PATH，或确认 yt-dlp 在 PATH 中可执行。";
  }
  return "先运行 @ai /health 查看依赖状态，修复对应项后再重试。";
}

function buildToolExecutionPreflightResult(toolCall = {}, api = {}, healthSnapshot = null) {
  if (!healthSnapshot || !Array.isArray(healthSnapshot.checks) || !healthSnapshot.checks.length) {
    return null;
  }
  const toolName = String(toolCall?.name || "").trim();
  if (!toolName) {
    return null;
  }
  const descriptor = buildCapabilityDescriptors(api).find((item) => item.id === toolName);
  if (!descriptor) {
    return null;
  }
  const readiness = summarizeCapabilityExecutionReadiness(descriptor, healthSnapshot);
  if (readiness.ready !== false) {
    return null;
  }
  const blocker = readiness.blocker || {};
  return {
    status: "blocked",
    tool: toolName,
    reason: "required capability dependency is unavailable",
    healthOverall: String(healthSnapshot.overall || "unknown"),
    blocker: {
      id: String(blocker.id || "").trim(),
      label: String(blocker.label || blocker.id || "").trim(),
      status: String(blocker.status || readiness.status || "error").trim(),
      detail: redactLocalPaths(blocker.detail || readiness.detail || "")
    },
    nextAction: buildHealthRepairHint(blocker.id)
  };
}

function parseToolResultJson(value = "") {
  const text = String(value || "").trim();
  if (!text || !text.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function summarizeToolFileRef(file = null) {
  if (!file || typeof file !== "object") {
    return null;
  }
  return {
    fileId: String(file.fileId || file.id || "").trim(),
    path: String(file.path || file.relativePath || "").trim(),
    name: String(file.name || "").trim(),
    mimeType: String(file.mimeType || "").trim()
  };
}

function summarizeConfirmationForTrace(confirmation = null) {
  if (!confirmation || typeof confirmation !== "object") {
    return null;
  }
  const impact = confirmation.impact && typeof confirmation.impact === "object" ? confirmation.impact : {};
  return {
    required: confirmation.required === true,
    operation: String(confirmation.operation || "").trim(),
    riskLevel: String(confirmation.riskLevel || "").trim(),
    reason: String(confirmation.reason || "").trim().slice(0, 240),
    impact: {
      targetFileCount: Number.isFinite(impact.targetFileCount) ? Number(impact.targetFileCount) : null,
      changedFields: Array.isArray(impact.changedFields) ? impact.changedFields.map((item) => String(item || "").trim()).filter(Boolean) : [],
      files: Array.isArray(impact.files) ? impact.files.map(summarizeToolFileRef).filter((item) => item?.fileId || item?.path).slice(0, 5) : []
    },
    recoverability: String(confirmation.recoverability || "").trim().slice(0, 240),
    estimatedDuration: String(confirmation.estimatedDuration || "").trim(),
    confirmWith: confirmation.confirmWith && typeof confirmation.confirmWith === "object"
      ? Object.fromEntries(Object.entries(confirmation.confirmWith).map(([key, value]) => [key, value]))
      : {}
  };
}

function summarizeToolResultForTrace(toolResult = "") {
  const parsed = parseToolResultJson(toolResult);
  if (!parsed) {
    return null;
  }
  const jobRefs = [];
  const status = String(parsed.status || "").trim();
  const botId = String(parsed.botId || "").trim();
  const jobId = String(parsed.jobId || "").trim();
  if (jobId) {
    jobRefs.push({
      jobId,
      botId,
      status,
      delegated: parsed.delegated === true
    });
  }
  const files = Array.isArray(parsed.files)
    ? parsed.files.map(summarizeToolFileRef).filter((item) => item?.fileId || item?.path).slice(0, 5)
    : [];
  const result = {
    status,
    delegated: parsed.delegated === true,
    botId,
    jobId,
    jobRefs,
    file: summarizeToolFileRef(parsed.file),
    files,
    counts: {
      count: Number.isFinite(parsed.count) ? Number(parsed.count) : null,
      total: Number.isFinite(parsed.total) ? Number(parsed.total) : null,
      missing: Array.isArray(parsed.missing) ? parsed.missing.length : null
    },
    requiresConfirmation: parsed.requiresConfirmation === true,
    blocked: parsed.blocked === true,
    blockedReason: String(parsed.blockedReason || "").trim(),
    confirmation: summarizeConfirmationForTrace(parsed.confirmation),
    blocker: parsed.blocker && typeof parsed.blocker === "object"
      ? {
          id: String(parsed.blocker.id || "").trim(),
          label: String(parsed.blocker.label || "").trim(),
          status: String(parsed.blocker.status || "").trim()
        }
      : null,
    nextAction: String(parsed.nextAction || "").trim(),
    logHint: String(parsed.logHint || "").trim()
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => {
    if (value === null || value === "") {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (value && typeof value === "object") {
      return Object.values(value).some((item) => item !== null && item !== "" && !(Array.isArray(item) && item.length === 0));
    }
    return true;
  }));
}

function summarizeToolErrorForTrace(error = null) {
  return {
    name: String(error?.name || "Error").trim(),
    message: String(error?.message || error || "unknown error").trim().slice(0, 500)
  };
}

export function getAiToolProgress(toolName = "", round = 0) {
  const safeRound = Math.max(0, Number(round) || 0);
  const offset = Math.min(MAX_TOOL_ROUND_OFFSET, safeRound * 5);
  const normalized = String(toolName || "").trim();
  if (normalized === "search_web") {
    return {
      phase: "tool-search-web",
      label: safeRound > 0 ? `继续联网搜索并整理资料（第 ${safeRound + 1} 轮）` : "联网搜索并整理资料",
      percent: 44 + offset
    };
  }
  if (normalized === "search_bilibili_video") {
    return {
      phase: "tool-search-bilibili-video",
      label: safeRound > 0 ? `继续搜索 B 站候选视频（第 ${safeRound + 1} 轮）` : "搜索 B 站候选视频",
      percent: 46 + offset
    };
  }
  if (normalized === "read_chat_history") {
    return {
      phase: "tool-read-chat-history",
      label: safeRound > 0 ? `继续补充聊天上下文（第 ${safeRound + 1} 轮）` : "补充聊天上下文",
      percent: 40 + offset
    };
  }
  if (normalized === "get_bot_job_status") {
    return {
      phase: "tool-get-bot-job-status",
      label: safeRound > 0 ? `继续读取任务状态（第 ${safeRound + 1} 轮）` : "读取 bot 任务状态",
      percent: 42 + offset
    };
  }
  if (normalized === "read_agent_trace") {
    return {
      phase: "tool-read-agent-trace",
      label: safeRound > 0 ? `继续读取 agent trace（第 ${safeRound + 1} 轮）` : "读取 AI agent trace",
      percent: 42 + offset
    };
  }
  if (normalized === "describe_image") {
    return {
      phase: "tool-describe-image",
      label: safeRound > 0 ? `继续分析图片内容（第 ${safeRound + 1} 轮）` : "分析图片内容",
      percent: 46 + offset
    };
  }
  if (normalized === "list_storage_files") {
    return {
      phase: "tool-list-storage-files",
      label: safeRound > 0 ? `继续检索存储文件（第 ${safeRound + 1} 轮）` : "检索存储文件列表",
      percent: 42 + offset
    };
  }
  if (normalized === "search_library_files") {
    return {
      phase: "tool-search-library-files",
      label: safeRound > 0 ? `继续搜索 NAS 文件（第 ${safeRound + 1} 轮）` : "搜索 NAS 文件库",
      percent: 42 + offset
    };
  }
  if (normalized === "read_file_metadata") {
    return {
      phase: "tool-read-file-metadata",
      label: safeRound > 0 ? `继续读取文件元数据（第 ${safeRound + 1} 轮）` : "读取 NAS 文件元数据",
      percent: 43 + offset
    };
  }
  if (normalized === "diagnose_file_access") {
    return {
      phase: "tool-diagnose-file-access",
      label: safeRound > 0 ? `继续诊断文件访问能力（第 ${safeRound + 1} 轮）` : "诊断 NAS 文件访问能力",
      percent: 43 + offset
    };
  }
  if (normalized === "read_text_excerpt") {
    return {
      phase: "tool-read-text-excerpt",
      label: safeRound > 0 ? `继续读取文本片段（第 ${safeRound + 1} 轮）` : "读取受控文本片段",
      percent: 45 + offset
    };
  }
  if (normalized === "read_media_summary") {
    return {
      phase: "tool-read-media-summary",
      label: safeRound > 0 ? `继续读取媒体摘要（第 ${safeRound + 1} 轮）` : "读取媒体派生摘要",
      percent: 45 + offset
    };
  }
  if (normalized === "analyze_file_content") {
    return {
      phase: "tool-analyze-file-content",
      label: safeRound > 0 ? `继续分析 NAS 文件内容（第 ${safeRound + 1} 轮）` : "分析 NAS 文件内容",
      percent: 48 + offset
    };
  }
  if (normalized === "update_file_metadata") {
    return {
      phase: "tool-update-file-metadata",
      label: safeRound > 0 ? `继续写入文件 metadata（第 ${safeRound + 1} 轮）` : "写入 NAS 文件 metadata",
      percent: 48 + offset
    };
  }
  if (normalized === "organize_files") {
    return {
      phase: "tool-organize-files",
      label: safeRound > 0 ? `继续预览 NAS 文件整理（第 ${safeRound + 1} 轮）` : "预览 NAS 文件整理",
      percent: 48 + offset
    };
  }
  if (normalized === "explain_file_access") {
    return {
      phase: "tool-explain-file-access",
      label: "说明 NAS 文件访问边界",
      percent: 42 + offset
    };
  }
  if (normalized === "get_storage_file_details") {
    return {
      phase: "tool-get-storage-file-details",
      label: safeRound > 0 ? `继续读取文件详情（第 ${safeRound + 1} 轮）` : "读取存储文件详情",
      percent: 44 + offset
    };
  }
  if (normalized === "analyze_storage_video") {
    return {
      phase: "tool-analyze-storage-video",
      label: safeRound > 0 ? `继续提交视频总结任务（第 ${safeRound + 1} 轮）` : "提交视频转录与总结任务",
      percent: 48 + offset
    };
  }
  if (normalized === "tag_storage_video") {
    return {
      phase: "tool-tag-storage-video",
      label: safeRound > 0 ? `继续提交视频打标签任务（第 ${safeRound + 1} 轮）` : "提交视频打标签任务",
      percent: 48 + offset
    };
  }
  if (normalized === "invoke_music_control") {
    return {
      phase: "tool-invoke-music-control",
      label: safeRound > 0 ? `继续委派音乐助手（第 ${safeRound + 1} 轮）` : "委派音乐助手",
      percent: 46 + offset
    };
  }
  if (normalized === "import_bilibili_video") {
    return {
      phase: "tool-import-bilibili-video",
      label: "委派 B 站下载任务",
      percent: 48 + offset
    };
  }
  return {
    phase: "tool-call",
    label: safeRound > 0 ? `继续调用工具（第 ${safeRound + 1} 轮）` : "调用辅助工具",
    percent: 42 + offset
  };
}

export function createToolAwarePlanningMessages({ systemPrompt, effectivePrompt, historyMessages }) {
  return [
    { role: "system", content: systemPrompt },
    ...(Array.isArray(historyMessages) ? historyMessages : []),
    { role: "user", content: effectivePrompt }
  ];
}

export function createToolCallAssistantMessage(result = {}) {
  return {
    role: "assistant",
    content: result.message?.content || "",
    tool_calls: result.message?.tool_calls || (Array.isArray(result.toolCalls) ? result.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.input || {})
      }
    })) : [])
  };
}

async function invokeJsonFallbackPlanningRound({
  planningMessages,
  tools,
  allowMoreToolCalls,
  api,
  model,
  round = 0,
  modelInvoker = invokeTextModel,
  retryReason = ""
}) {
  await api.appendLog(`json-tool-fallback round=${round}${retryReason ? ` reason=${retryReason}` : ""}`);
  await api.emitProgress({
    phase: "plan-json-tool",
    label: round > 0 ? `使用 JSON 工具计划继续推理（第 ${round + 1} 轮）` : "使用 JSON 工具计划分析任务",
    percent: Math.min(52, 35 + round * 6)
  });
  const fallbackSystemPrompt = buildJsonFallbackSystemPrompt(tools, allowMoreToolCalls);
  let fallbackMessages = normalizeMessagesForJsonFallback(planningMessages, fallbackSystemPrompt);
  let result = await modelInvoker({
    model: model || undefined,
    messages: fallbackMessages,
    toolChoice: "none",
    signal: api.signal,
    maxTokens: 1200,
    temperature: 0.15
  });
  let parsed = parseJsonToolPlan(result.text || "", tools, { allowToolCalls: allowMoreToolCalls, round });
  for (let attempt = 0; !parsed.ok && attempt < JSON_FALLBACK_REPAIR_ATTEMPTS; attempt += 1) {
    fallbackMessages = fallbackMessages.concat([
      createJsonFallbackAssistantMessage(result),
      {
        role: "user",
        content: `上一条输出无法作为工具计划解析：${parsed.error}。请只输出一个严格 JSON object，不要输出 Markdown 或解释。`
      }
    ]);
    result = await modelInvoker({
      model: model || undefined,
      messages: fallbackMessages,
      toolChoice: "none",
      signal: api.signal,
      maxTokens: 1000,
      temperature: 0.05
    });
    parsed = parseJsonToolPlan(result.text || "", tools, { allowToolCalls: allowMoreToolCalls, round });
  }

  const nextPlanningMessages = [...planningMessages, createJsonFallbackAssistantMessage(result)];
  if (parsed.ok && parsed.action === "call_tool" && parsed.toolCall) {
    await recordAgentPlanningEvent(api, {
      round,
      status: "tool-requested",
      model: result.model || model,
      fallback: "json-plan",
      finishReason: result.finishReason || "",
      pendingToolCalls: [parsed.toolCall],
      text: result.text || "",
      retryReason
    });
    return {
      planningMessages: nextPlanningMessages,
      pendingToolCalls: [parsed.toolCall],
      result: {
        ...result,
        fallback: "json-plan",
        jsonPlan: parsed
      }
    };
  }

  await recordAgentPlanningEvent(api, {
    round,
    status: parsed.ok ? "final-answer" : "parse-failed",
    model: result.model || model,
    fallback: "json-plan",
    finishReason: result.finishReason || "",
    pendingToolCalls: [],
    text: parsed.finalAnswer || result.text || "",
    parseError: parsed.ok ? "" : parsed.error,
    retryReason
  });

  return {
    planningMessages: parsed.ok && parsed.action === "final_answer" && parsed.finalAnswer
      ? [...planningMessages, { role: "assistant", content: parsed.finalAnswer }]
      : nextPlanningMessages,
    pendingToolCalls: [],
    result: {
      ...result,
      text: parsed.finalAnswer || result.text || "",
      fallback: "json-plan",
      jsonPlan: parsed
    }
  };
}

export async function invokeToolAwarePlanningRound({ messages, recentMessages, context, api, modelOverride = "", defaultTextModel = "", modelSettings = {}, round = 0, maxToolRounds = 4, modelInvoker = invokeTextModel }) {
  if (round > maxToolRounds) {
    throw new Error("AI tool-call exceeded max rounds");
  }
  const allowMoreToolCalls = round < maxToolRounds;
  const tools = allowMoreToolCalls ? getAiToolDefinitions() : [];
  const planningMessages = Array.isArray(messages) ? [...messages] : [];
  const model = modelOverride || defaultTextModel || "";
  const useJsonFallback = allowMoreToolCalls && shouldUseJsonToolFallback({ model, modelSettings });
  if (useJsonFallback) {
    return invokeJsonFallbackPlanningRound({
      planningMessages,
      tools,
      allowMoreToolCalls,
      api,
      model,
      round,
      modelInvoker,
      retryReason: "cached-model-without-tool-calls"
    });
  }
  await api.emitProgress({
    phase: "plan-reply",
    label: allowMoreToolCalls
      ? (round > 0 ? `整理工具结果并继续推理（第 ${round + 1} 轮）` : "分析问题并判断是否需要工具")
      : "已达到工具上限，基于现有结果生成最终回答",
    percent: Math.min(52, 34 + round * 6)
  });

  let result;
  try {
    result = await modelInvoker({
      model: model || undefined,
      messages: planningMessages,
      tools,
      toolChoice: allowMoreToolCalls ? "auto" : "none",
      signal: api.signal,
      maxTokens: 1000,
      temperature: 0.25
    });
  } catch (error) {
    if (allowMoreToolCalls && tools.length && isNativeToolUnsupportedError(error)) {
      return invokeJsonFallbackPlanningRound({
        planningMessages,
        tools,
        allowMoreToolCalls,
        api,
        model,
        round,
        modelInvoker,
        retryReason: String(error?.message || error || "native tool call unsupported").slice(0, 180)
      });
    }
    throw error;
  }
  const pendingToolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  if (pendingToolCalls.length) {
    planningMessages.push(createToolCallAssistantMessage(result));
  }
  await recordAgentPlanningEvent(api, {
    round,
    status: pendingToolCalls.length ? "tool-requested" : "final-answer",
    model: result.model || model,
    fallback: "",
    finishReason: result.finishReason || "",
    pendingToolCalls,
    text: result.text || ""
  });
  return {
    planningMessages,
    pendingToolCalls,
    result,
    recentMessages,
    context
  };
}

export async function executePendingToolCallsRound({ pendingToolCalls, planningMessages, recentMessages, context, api, round = 0, healthSnapshot = null }) {
  const nextMessages = Array.isArray(planningMessages) ? [...planningMessages] : [];
  const traceHooks = api?.traceHooks;
  for (const toolCall of Array.isArray(pendingToolCalls) ? pendingToolCalls : []) {
    const fallbackMode = toolCall.fallbackJsonPlan === true ? "json-plan" : "";
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const inputSummary = buildToolInputSummary(toolCall);
    await api.appendLog(`${fallbackMode ? "json-tool-call" : "tool-call"} ${toolCall.name}: ${JSON.stringify(toolCall.input || {})}`);
    await api.emitProgress(getAiToolProgress(toolCall.name, round));
    let toolResult = "";
    const blockedResult = buildToolExecutionPreflightResult(toolCall, api, healthSnapshot);
    const toolStatus = blockedResult ? "blocked" : "completed";
    if (blockedResult) {
      toolResult = JSON.stringify(blockedResult, null, 2);
      await api.appendLog(`tool-call-blocked ${toolCall.name}: ${blockedResult.blocker.id || "health"} ${blockedResult.blocker.status || "unavailable"}`);
      await traceHooks?.recordToolEvent?.({
        name: toolCall.name,
        round,
        status: "blocked",
        input: fallbackMode ? { ...(toolCall.input || {}), __fallback: fallbackMode } : (toolCall.input || {}),
        inputSummary,
        ...buildTraceTiming(startedAt, startedMs),
        outputPreview: toolResult,
        resultSummary: summarizeToolResultForTrace(toolResult)
      });
    } else {
      try {
        toolResult = await executeAiToolCall(toolCall, context, api, { recentMessages });
        await traceHooks?.recordToolEvent?.({
          name: toolCall.name,
          round,
          status: "completed",
          input: fallbackMode ? { ...(toolCall.input || {}), __fallback: fallbackMode } : (toolCall.input || {}),
          inputSummary,
          ...buildTraceTiming(startedAt, startedMs),
          outputPreview: String(toolResult || ""),
          resultSummary: summarizeToolResultForTrace(toolResult)
        });
      } catch (error) {
        const cancelled = error?.name === "AbortError" || /job cancelled/i.test(String(error?.message || ""));
        await traceHooks?.recordToolEvent?.({
          name: toolCall.name,
          round,
          status: cancelled ? "cancelled" : "failed",
          input: fallbackMode ? { ...(toolCall.input || {}), __fallback: fallbackMode } : (toolCall.input || {}),
          inputSummary,
          ...buildTraceTiming(startedAt, startedMs),
          outputPreview: String(error?.message || error || ""),
          errorSummary: summarizeToolErrorForTrace(error)
        });
        throw error;
      }
    }
    if (fallbackMode) {
      const observationContent = [
        blockedResult ? `工具 ${toolCall.name} 因依赖不可用被阻止。` : `工具 ${toolCall.name} 已执行。`,
        toolCall.reason ? `调用原因：${toolCall.reason}` : "",
        "工具返回 JSON：",
        toolResult
      ].filter(Boolean).join("\n");
      nextMessages.push({
        role: "user",
        content: observationContent
      });
      await recordAgentObservationEvent(api, {
        round,
        toolName: toolCall.name,
        fallback: fallbackMode,
        status: toolStatus === "blocked" ? "blocked" : "observed",
        observation: observationContent
      });
    } else {
      nextMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult
      });
      await recordAgentObservationEvent(api, {
        round,
        toolName: toolCall.name,
        fallback: "",
        status: toolStatus === "blocked" ? "blocked" : "observed",
        observation: toolResult
      });
    }
  }
  return nextMessages;
}

export async function runToolAwareConversation({ systemPrompt, effectivePrompt, historyMessages, recentMessages, context, api, modelOverride = "", defaultTextModel = "", modelSettings = {}, maxToolRounds = 4 }) {
  const messages = createToolAwarePlanningMessages({
    systemPrompt,
    effectivePrompt,
    historyMessages
  });

  for (let round = 0; round <= maxToolRounds; round += 1) {
    const planned = await invokeToolAwarePlanningRound({
      messages,
      recentMessages,
      context,
      api,
      modelOverride,
      defaultTextModel,
      modelSettings,
      round,
      maxToolRounds
    });

    if (!planned.pendingToolCalls.length) {
      return {
        planningMessages: planned.planningMessages,
        result: planned.result
      };
    }

    const nextMessages = await executePendingToolCallsRound({
      pendingToolCalls: planned.pendingToolCalls,
      planningMessages: planned.planningMessages,
      recentMessages,
      context,
      api,
      round,
      healthSnapshot: api.healthSnapshot || null
    });
    messages.splice(0, messages.length, ...nextMessages);
  }

  throw new Error("AI tool-call exceeded max rounds");
}
