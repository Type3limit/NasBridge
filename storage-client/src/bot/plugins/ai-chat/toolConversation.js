import { executeAiToolCall, getAiToolDefinitions } from "../../tools/aiToolRuntime.js";
import { buildCapabilityDescriptors, summarizeCapabilityExecutionReadiness } from "../../capabilities/registry.js";
import { getHealthRepairHint } from "../../capabilities/health.js";
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

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function validateJsonSchemaValue(value, schema = {}, pathLabel = "arguments") {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    const variantErrors = schema.anyOf.map((variant) => validateJsonSchemaValue(value, variant, pathLabel));
    if (variantErrors.some((items) => items.length === 0)) {
      return [];
    }
    return [`${pathLabel} must match one of the allowed schemas`];
  }
  const errors = [];
  const type = Array.isArray(schema.type) ? schema.type[0] : String(schema.type || "").trim();
  if (schema.enum && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${pathLabel} must be one of: ${schema.enum.join(", ")}`);
    return errors;
  }
  if (type === "object") {
    if (!isPlainObject(value)) {
      errors.push(`${pathLabel} must be an object`);
      return errors;
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined || value[key] === null) {
        errors.push(`${pathLabel}.${key} is required`);
      }
    }
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined || value[key] === null) {
        continue;
      }
      errors.push(...validateJsonSchemaValue(value[key], childSchema, `${pathLabel}.${key}`));
    }
    return errors;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${pathLabel} must be an array`);
      return errors;
    }
    if (Number.isFinite(Number(schema.maxItems)) && value.length > Number(schema.maxItems)) {
      errors.push(`${pathLabel} must contain at most ${Number(schema.maxItems)} items`);
    }
    const itemSchema = schema.items && typeof schema.items === "object" ? schema.items : null;
    if (itemSchema) {
      value.forEach((item, index) => {
        errors.push(...validateJsonSchemaValue(item, itemSchema, `${pathLabel}[${index}]`));
      });
    }
    return errors;
  }
  if (type === "string" && typeof value !== "string") {
    errors.push(`${pathLabel} must be a string`);
    return errors;
  }
  if (type === "boolean" && typeof value !== "boolean") {
    errors.push(`${pathLabel} must be a boolean`);
    return errors;
  }
  if (type === "integer" || type === "number") {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || (type === "integer" && !Number.isInteger(numeric))) {
      errors.push(`${pathLabel} must be a ${type}`);
      return errors;
    }
    if (Number.isFinite(Number(schema.minimum)) && numeric < Number(schema.minimum)) {
      errors.push(`${pathLabel} must be >= ${Number(schema.minimum)}`);
    }
    if (Number.isFinite(Number(schema.maximum)) && numeric > Number(schema.maximum)) {
      errors.push(`${pathLabel} must be <= ${Number(schema.maximum)}`);
    }
  }
  return errors;
}

function validateToolInput(input = {}, tool = {}) {
  const schema = tool?.inputSchema && typeof tool.inputSchema === "object"
    ? tool.inputSchema
    : { type: "object", properties: {} };
  return validateJsonSchemaValue(input, schema, "arguments");
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
    "安全规则：不要在 JSON plan 中自行设置 confirmed=true 来执行写入、移动、重命名、覆盖或批量修改；必须先 dryRun/预览影响范围，或用 final_answer 请求用户明确确认。",
    "读取 NAS 文件时只使用 fileId 或相对路径；不要编造或输出本机绝对路径。遇到文件访问不确定，先调用 diagnose_file_access。",
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
  const input = normalizeToolInput(parsed.arguments || parsed.args || parsed.input);
  const inputErrors = validateToolInput(input, tool);
  if (inputErrors.length) {
    return {
      ok: false,
      error: `invalid arguments for ${toolName}: ${inputErrors.slice(0, 4).join("; ")}`,
      finalAnswer: ""
    };
  }
  return {
    ok: true,
    action: "call_tool",
    toolCall: {
      id: `jsonplan_${Number(options.round || 0)}_${toolName.replace(/[^a-z0-9_:-]/gi, "_")}`,
      name: toolName,
      input,
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

function uniqueTraceStrings(items = []) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function summarizeOutputSchemaForTrace(outputSchema = {}) {
  if (!outputSchema || typeof outputSchema !== "object") {
    return null;
  }
  const required = uniqueTraceStrings(outputSchema.required).slice(0, 8);
  const fields = outputSchema.properties && typeof outputSchema.properties === "object"
    ? uniqueTraceStrings(Object.keys(outputSchema.properties)).slice(0, 10)
    : [];
  if (!required.length && !fields.length) {
    return null;
  }
  return Object.fromEntries(Object.entries({
    required,
    fields
  }).filter(([, value]) => Array.isArray(value) ? value.length > 0 : value));
}

function summarizeCapabilityForTrace(toolName = "", api = {}) {
  const normalizedName = String(toolName || "").trim();
  if (!normalizedName) {
    return null;
  }
  const descriptor = buildCapabilityDescriptors(api).find((item) => item.id === normalizedName);
  if (!descriptor) {
    return null;
  }
  return Object.fromEntries(Object.entries({
    id: descriptor.id,
    kind: descriptor.kind,
    riskLevel: descriptor.riskLevel,
    executionMode: descriptor.executionMode,
    requiresConfirmation: descriptor.requiresConfirmation === true,
    capabilities: uniqueTraceStrings(descriptor.capabilities).slice(0, 8),
    permissions: uniqueTraceStrings(descriptor.permissions).slice(0, 8),
    output: summarizeOutputSchemaForTrace(descriptor.outputSchema)
  }).filter(([, value]) => {
    if (value === null || value === undefined || value === "") {
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

function buildToolInputSummary(toolCall = {}) {
  const input = normalizeToolInput(toolCall.input);
  const keys = Object.keys(input).filter((key) => !String(key || "").startsWith("__")).sort();
  const identifiers = [
    ...summarizeStringList(input.jobId),
    ...summarizeStringList(input.jobIds),
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
  for (const key of ["batch", "force", "forceAnalyze", "waitForCompletion", "dryRun", "confirmed", "includeSummary", "includeSubtitle", "includeTranscriptExcerpt", "includeTrace", "includeChildJobs"]) {
    if (typeof input[key] === "boolean") {
      options[key] = input[key];
    }
  }
  for (const key of ["limit", "maxResults", "timeoutSeconds", "maxChars", "logMaxBytes", "maxTraceEvents", "childJobLimit"]) {
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
  retryReason = "",
  maxToolRounds = null,
  allowMoreToolCalls = null
} = {}) {
  const safeMaxToolRounds = Number(maxToolRounds);
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
      retryReason: String(retryReason || "").trim(),
      maxToolRounds: Number.isFinite(safeMaxToolRounds) ? Math.max(0, Math.floor(safeMaxToolRounds)) : null,
      allowMoreToolCalls: typeof allowMoreToolCalls === "boolean" ? allowMoreToolCalls : null
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

async function recordAgentDecisionEvent(api = {}, {
  round = 0,
  planStatus = "",
  pendingToolCalls = [],
  finalAnswer = "",
  parseError = "",
  finishReason = "",
  maxToolRounds = null,
  allowMoreToolCalls = null
} = {}) {
  const pendingTools = summarizePendingToolCalls(pendingToolCalls);
  const decision = pendingTools.length ? "continue" : "finish";
  const status = decision === "continue"
    ? "continue"
    : (String(planStatus || "").trim() === "parse-failed" ? "finish-with-error" : "finish");
  const safeMaxToolRounds = Number(maxToolRounds);
  await api?.traceHooks?.recordAgentEvent?.({
    phase: "decide_continue_or_finish",
    round,
    status,
    detail: {
      decision,
      planStatus: String(planStatus || "").trim(),
      pendingToolCount: pendingTools.length,
      pendingTools,
      finalAnswerLength: String(finalAnswer || "").length,
      parseError: String(parseError || "").trim(),
      finishReason: String(finishReason || "").trim(),
      maxToolRounds: Number.isFinite(safeMaxToolRounds) ? Math.max(0, Math.floor(safeMaxToolRounds)) : null,
      allowMoreToolCalls: typeof allowMoreToolCalls === "boolean" ? allowMoreToolCalls : null
    },
    outputPreview: pendingTools.length
      ? pendingTools.map((tool) => tool.name).filter(Boolean).join(", ")
      : previewText(finalAnswer)
  });
}

function redactLocalPaths(value = "") {
  return String(value || "")
    .replace(/[A-Za-z]:[\\/][^\s；,，]+/g, "[local-path]")
    .replace(/\\\\[^\\/\s；,，]+[\\/][^\s；,，]+/g, "[network-path]");
}

function isAnalyzeFileContentMediaStart(toolName = "", input = {}) {
  return String(toolName || "").trim() === "analyze_file_content"
    && (input.startAnalysis === true || input.analyze === true || input.forceAnalyze === true);
}

function buildPreflightDescriptor(toolName = "", descriptor = {}, descriptors = [], input = {}) {
  if (!isAnalyzeFileContentMediaStart(toolName, input)) {
    return descriptor;
  }
  const mediaDescriptor = descriptors.find((item) => item.id === "invoke_video_analyze")
    || descriptors.find((item) => item.id === "video.analyze")
    || null;
  return {
    ...descriptor,
    id: "invoke_video_analyze",
    healthChecks: [...new Set([
      ...((Array.isArray(descriptor.healthChecks) ? descriptor.healthChecks : [])),
      ...((Array.isArray(mediaDescriptor?.healthChecks) ? mediaDescriptor.healthChecks : []))
    ])]
  };
}

const MEDIA_ANALYSIS_TOOL_NAMES = new Set([
  "invoke_video_analyze",
  "analyze_storage_video"
]);

const FILE_ANALYSIS_TOOL_NAMES = new Set([
  "analyze_file_content",
  "invoke_video_analyze",
  "analyze_storage_video",
  "read_text_excerpt",
  "read_media_summary"
]);

function pickSafeFileTargetInput(input = {}) {
  const fileId = String(input.fileId || "").trim();
  if (fileId && !isUnsafeLocalPath(fileId)) {
    return { fileId };
  }
  const filePath = String(input.path || input.filePath || "").trim();
  if (filePath && !isUnsafeLocalPath(filePath)) {
    return { path: filePath.replace(/\\/g, "/") };
  }
  return {};
}

function buildBlockedToolFallbackActions(toolName = "", input = {}, blocker = {}) {
  const normalizedTool = String(toolName || "").trim();
  const blockerId = String(blocker?.id || "").trim();
  const isMediaAnalysis = MEDIA_ANALYSIS_TOOL_NAMES.has(normalizedTool)
    || isAnalyzeFileContentMediaStart(normalizedTool, input);
  const isFileAnalysis = FILE_ANALYSIS_TOOL_NAMES.has(normalizedTool);
  const targetInput = pickSafeFileTargetInput(input);
  const hasTarget = Object.keys(targetInput).length > 0;
  const actions = [];

  if (isMediaAnalysis && hasTarget) {
    actions.push({
      tool: "read_media_summary",
      input: {
        ...targetInput,
        includeSummary: true,
        includeProbe: blockerId !== "ffprobe",
        includeTranscriptExcerpt: true,
        maxChars: 4000
      },
      contentLayer: "derived-media",
      riskLevel: "low",
      reason: "视频/音频分析依赖不可用时，先复用已有摘要、字幕和媒体派生信息。"
    });
  }

  if (isFileAnalysis && hasTarget) {
    actions.push({
      tool: "diagnose_file_access",
      input: targetInput,
      contentLayer: "metadata",
      riskLevel: "low",
      reason: "确认该 NAS 文件当前可读层级、缺失依赖和下一步工具。"
    });
  }

  if (isFileAnalysis && !hasTarget) {
    actions.push({
      tool: "search_library_files",
      input: {
        kind: isMediaAnalysis ? "video" : "all",
        limit: 5
      },
      contentLayer: "index",
      riskLevel: "low",
      reason: "先重新搜索文件库并取得 fileId，再诊断或读取可用内容。"
    });
  }

  if (blockerId === "storage-root") {
    actions.push({
      tool: "explain_file_access",
      input: { kind: "summary" },
      contentLayer: "policy",
      riskLevel: "low",
      reason: "说明当前 NAS 文件访问边界和 storage root 阻断原因。"
    });
  }

  return actions.slice(0, 4);
}

function buildBlockedToolRepairCommands(blocker = {}) {
  const blockerId = String(blocker?.id || "").trim();
  const commands = [];
  if (blockerId === "ai-model" || blockerId === "ai-tool-call") {
    commands.push("@ai /models");
  }
  if (blockerId === "bot-queue") {
    commands.push("@ai /jobs");
  }
  commands.push("@ai /health", "@ai /tools");
  return [...new Set(commands)];
}

function buildToolExecutionPreflightResult(toolCall = {}, api = {}, healthSnapshot = null) {
  if (!healthSnapshot || !Array.isArray(healthSnapshot.checks) || !healthSnapshot.checks.length) {
    return null;
  }
  const toolName = String(toolCall?.name || "").trim();
  if (!toolName) {
    return null;
  }
  const input = normalizeToolInput(toolCall.input);
  const descriptors = buildCapabilityDescriptors(api);
  const descriptor = descriptors.find((item) => item.id === toolName);
  if (!descriptor) {
    return null;
  }
  const readiness = summarizeCapabilityExecutionReadiness(buildPreflightDescriptor(toolName, descriptor, descriptors, input), healthSnapshot);
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
    nextAction: getHealthRepairHint(blocker) || "先运行 @ai /health 查看依赖状态，修复对应项后再重试。",
    fallbackActions: buildBlockedToolFallbackActions(toolName, input, blocker),
    repairCommands: buildBlockedToolRepairCommands(blocker)
  };
}

function countConfirmationTargets(input = {}) {
  for (const key of ["fileIds", "paths", "actions", "sources"]) {
    if (Array.isArray(input[key]) && input[key].length) {
      return input[key].length;
    }
  }
  if (input.batch === true) {
    return 1;
  }
  return input.fileId || input.path || input.filePath || input.source ? 1 : null;
}

function inferConfirmationChangedFields(toolName = "", input = {}) {
  if (toolName === "organize_files") {
    return ["path"];
  }
  if (toolName === "update_file_metadata") {
    return [
      Array.isArray(input.tags) || Array.isArray(input.addTags) || Array.isArray(input.removeTags) || input.replaceTags === true ? "tags" : "",
      (Object.prototype.hasOwnProperty.call(input, "aiSummary") || input.clearAiSummary === true) ? "aiSummary" : "",
      (Object.prototype.hasOwnProperty.call(input, "notes")
        || Object.prototype.hasOwnProperty.call(input, "note")
        || Object.prototype.hasOwnProperty.call(input, "remark")
        || input.clearNotes === true
        || input.clearNote === true
        || input.clearRemark === true) ? "notes" : ""
    ].filter(Boolean);
  }
  if (toolName === "invoke_video_tag" || toolName === "tag_storage_video") {
    return ["tags"];
  }
  return [];
}

function buildToolConfirmationGateResult(toolCall = {}, api = {}) {
  const input = normalizeToolInput(toolCall.input);
  if (input.confirmed !== true || toolCall.confirmationAuthorized === true) {
    return null;
  }
  const toolName = String(toolCall?.name || "").trim();
  const descriptor = buildCapabilityDescriptors(api).find((item) => item.id === toolName);
  const riskLevel = String(descriptor?.riskLevel || "medium").trim() || "medium";
  return {
    status: "confirmation_required",
    tool: toolName,
    blocked: true,
    requiresConfirmation: true,
    blockedReason: "工具请求包含 confirmed=true，但本轮没有检测到用户明确确认的恢复上下文，已阻止执行。",
    confirmation: {
      required: true,
      operation: toolName,
      riskLevel,
      reason: "模型不能自行确认会写入、移动、重命名或批量修改 NAS 文件的操作；必须先展示影响范围并等待用户明确确认。",
      impact: {
        targetFileCount: countConfirmationTargets(input),
        changedFields: inferConfirmationChangedFields(toolName, input)
      },
      recoverability: "本次没有执行任何变更。用户确认后会通过会话恢复链路重新执行同一个工具。",
      estimatedDuration: "取决于文件数量和子任务队列",
      confirmWith: {
        confirmed: true
      }
    },
    nextAction: "先把影响范围告知用户并等待明确确认；确认后再由会话恢复链路执行，不要由模型自行传 confirmed=true。"
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

function summarizeJobRefForTrace(job = null, fallback = {}) {
  if (!job || typeof job !== "object") {
    return null;
  }
  const jobId = String(job.jobId || job.id || fallback.jobId || "").trim();
  if (!jobId) {
    return null;
  }
  return {
    jobId,
    botId: String(job.botId || fallback.botId || "").trim(),
    status: String(job.status || fallback.status || "").trim(),
    delegated: job.delegated === true || fallback.delegated === true
  };
}

function summarizeLogForTrace(log = null) {
  if (!log || typeof log !== "object") {
    return null;
  }
  return {
    jobId: String(log.jobId || "").trim(),
    truncated: log.truncated === true,
    length: String(log.content || "").length
  };
}

function summarizeAccessLayerForTrace(layer = null) {
  if (!layer || typeof layer !== "object") {
    return null;
  }
  return Object.fromEntries(Object.entries({
    id: String(layer.id || "").trim(),
    label: String(layer.label || "").trim(),
    available: layer.available === true,
    riskLevel: String(layer.riskLevel || "").trim(),
    tools: Array.isArray(layer.tools) ? layer.tools.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6) : [],
    requires: Array.isArray(layer.requires) ? layer.requires.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6) : [],
    reason: String(layer.reason || "").trim().slice(0, 240)
  }).filter(([, value]) => {
    if (value === "" || value === null || value === undefined) {
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

function summarizeAccessBlockerForTrace(blocker = null) {
  if (!blocker || typeof blocker !== "object") {
    return null;
  }
  return Object.fromEntries(Object.entries({
    id: String(blocker.id || "").trim(),
    severity: String(blocker.severity || blocker.status || "").trim(),
    message: String(blocker.message || blocker.detail || "").trim().slice(0, 240),
    repairHint: String(blocker.repairHint || "").trim().slice(0, 240),
    requires: Array.isArray(blocker.requires) ? blocker.requires.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6) : []
  }).filter(([, value]) => {
    if (value === "" || value === null || value === undefined) {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return true;
  }));
}

const SAFE_ACTION_INPUT_KEYS = new Set([
  "fileId",
  "fileIds",
  "path",
  "paths",
  "filePath",
  "query",
  "kind",
  "limit",
  "offset",
  "source",
  "subtitle",
  "allowSubtitleFallback",
  "startChar",
  "maxChars",
  "includeSummary",
  "includeProbe",
  "includeTranscriptExcerpt",
  "includeSubtitleExcerpt",
  "mode",
  "task",
  "prompt"
]);

function isUnsafeLocalPath(value = "") {
  const text = String(value || "").trim();
  return /^[A-Za-z]:[\\/]/.test(text) || /^\\\\/.test(text);
}

function summarizeAccessActionInputForTrace(input = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_ACTION_INPUT_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "string") {
      const text = value.trim();
      if (!text || isUnsafeLocalPath(text)) {
        continue;
      }
      result[key] = truncateTraceText(text, 180);
    } else if (typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value
        .map((item) => String(item || "").trim())
        .filter((item) => item && !isUnsafeLocalPath(item))
        .slice(0, 10);
    }
  }
  return result;
}

function summarizeAccessActionForTrace(action = null) {
  if (!action || typeof action !== "object") {
    return null;
  }
  return Object.fromEntries(Object.entries({
    id: String(action.id || "").trim(),
    tool: String(action.tool || "").trim(),
    input: summarizeAccessActionInputForTrace(action.input),
    contentLayer: String(action.contentLayer || "").trim(),
    riskLevel: String(action.riskLevel || "").trim(),
    requiresConfirmation: action.requiresConfirmation === true,
    blocked: action.blocked === true,
    blockerIds: Array.isArray(action.blockerIds) ? action.blockerIds.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6) : [],
    reason: String(action.reason || "").trim().slice(0, 180)
  }).filter(([, value]) => {
    if (value === "" || value === null || value === undefined) {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return true;
  }));
}

function summarizeFileAccessForTrace(parsed = {}) {
  const hasFileAccessShape = Object.prototype.hasOwnProperty.call(parsed, "found")
    || parsed.policy
    || parsed.safety
    || parsed.contentAccess
    || Array.isArray(parsed.layers)
    || Array.isArray(parsed.blockers)
    || Array.isArray(parsed.readableLayers)
    || Array.isArray(parsed.blockedLayers);
  if (!hasFileAccessShape) {
    return null;
  }
  const policy = parsed.policy && typeof parsed.policy === "object" ? parsed.policy : {};
  const safety = parsed.safety && typeof parsed.safety === "object" ? parsed.safety : {};
  const contentAccess = parsed.contentAccess && typeof parsed.contentAccess === "object" ? parsed.contentAccess : {};
  const countsByKind = parsed.countsByKind && typeof parsed.countsByKind === "object" ? parsed.countsByKind : null;
  return Object.fromEntries(Object.entries({
    found: typeof parsed.found === "boolean" ? parsed.found : null,
    visibleFiles: Number.isFinite(Number(parsed.visibleFiles)) ? Number(parsed.visibleFiles) : null,
    visibleDirectories: Number.isFinite(Number(parsed.visibleDirectories)) ? Number(parsed.visibleDirectories) : null,
    countsByKind,
    policy: Object.fromEntries(Object.entries({
      storageRootOnly: policy.storageRootOnly === true,
      allowRawTextRead: policy.allowRawTextRead === true,
      allowBinaryRead: policy.allowBinaryRead === true,
      writeRequiresConfirmation: policy.writeRequiresConfirmation === true,
      maxInlineTextChars: Number.isFinite(Number(policy.maxInlineTextChars)) ? Number(policy.maxInlineTextChars) : null,
      maxBatchFiles: Number.isFinite(Number(policy.maxBatchFiles)) ? Number(policy.maxBatchFiles) : null
    }).filter(([, value]) => value !== null && value !== "")),
    safety: Object.fromEntries(Object.entries({
      storageRootOnly: safety.storageRootOnly === true,
      pathSafe: typeof safety.pathSafe === "boolean" ? safety.pathSafe : null,
      hiddenDirectory: safety.hiddenDirectory === true,
      absolutePathExposed: safety.absolutePathExposed === true,
      binaryRawContentAllowed: safety.binaryRawContentAllowed === true,
      writeRequiresConfirmation: safety.writeRequiresConfirmation === true
    }).filter(([, value]) => value !== null && value !== "")),
    contentAccess: Object.fromEntries(Object.entries({
      analyzeMode: String(contentAccess.analyzeMode || "").trim(),
      textReadable: contentAccess.textReadable === true,
      subtitleAvailable: contentAccess.subtitleAvailable === true,
      aiSummaryAvailable: contentAccess.aiSummaryAvailable === true,
      media: contentAccess.media === true,
      videoOrAudio: contentAccess.videoOrAudio === true,
      image: contentAccess.image === true,
      recommendedTools: Array.isArray(contentAccess.recommendedTools) ? contentAccess.recommendedTools.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8) : []
    }).filter(([, value]) => {
      if (value === "" || value === null) {
        return false;
      }
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      return true;
    })),
    layers: Array.isArray(parsed.layers) ? parsed.layers.map(summarizeAccessLayerForTrace).filter(Boolean).slice(0, 8) : [],
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers.map(summarizeAccessBlockerForTrace).filter(Boolean).slice(0, 8) : [],
    actionPlan: Array.isArray(parsed.actionPlan) ? parsed.actionPlan.map(summarizeAccessActionForTrace).filter(Boolean).slice(0, 8) : [],
    readableLayers: Array.isArray(parsed.readableLayers) ? parsed.readableLayers.map((item) => truncateTraceText(item, 160)).filter(Boolean).slice(0, 8) : [],
    blockedLayers: Array.isArray(parsed.blockedLayers) ? parsed.blockedLayers.map((item) => truncateTraceText(item, 160)).filter(Boolean).slice(0, 8) : [],
    recommendedTools: Array.isArray(parsed.recommendedTools) ? parsed.recommendedTools.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8) : [],
    nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions.map((item) => truncateTraceText(item, 180)).filter(Boolean).slice(0, 5) : []
  }).filter(([, value]) => {
    if (value === null || value === "" || value === undefined) {
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

function summarizeToolResultForTrace(toolResult = "", toolName = "", api = {}) {
  const parsed = parseToolResultJson(toolResult);
  if (!parsed) {
    const capability = summarizeCapabilityForTrace(toolName, api);
    return capability ? { capability } : null;
  }
  const jobRefs = [];
  const seenJobRefs = new Set();
  const pushJobRef = (job, fallback = {}) => {
    const ref = summarizeJobRefForTrace(job, fallback);
    if (!ref || seenJobRefs.has(ref.jobId)) {
      return;
    }
    seenJobRefs.add(ref.jobId);
    jobRefs.push(ref);
  };
  const primaryJob = parsed.job && typeof parsed.job === "object" ? parsed.job : null;
  const status = String(parsed.status || primaryJob?.status || "").trim();
  const botId = String(parsed.botId || primaryJob?.botId || "").trim();
  const jobId = String(parsed.jobId || primaryJob?.jobId || "").trim();
  if (jobId) {
    pushJobRef({ jobId, botId, status, delegated: parsed.delegated === true });
  }
  if (Array.isArray(parsed.jobs)) {
    for (const job of parsed.jobs.slice(0, 8)) {
      pushJobRef(job);
    }
  }
  if (Array.isArray(parsed.childJobs)) {
    for (const job of parsed.childJobs.slice(0, 8)) {
      pushJobRef(job, { delegated: true });
    }
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
    log: summarizeLogForTrace(parsed.log),
    childJobCount: Array.isArray(parsed.childJobs) ? parsed.childJobs.length : null,
    agentTrace: parsed.agentTrace && typeof parsed.agentTrace === "object"
      ? {
          eventCount: Number.isFinite(Number(parsed.agentTrace.eventCount ?? parsed.agentTrace.events?.length)) ? Number(parsed.agentTrace.eventCount ?? parsed.agentTrace.events?.length) : null,
          childJobCount: Number.isFinite(Number(parsed.agentTrace.childJobCount)) ? Number(parsed.agentTrace.childJobCount) : null
        }
      : null,
    fileAccess: summarizeFileAccessForTrace(parsed),
    fallbackActions: Array.isArray(parsed.fallbackActions) ? parsed.fallbackActions.map(summarizeAccessActionForTrace).filter(Boolean).slice(0, 5) : [],
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
    logHint: String(parsed.logHint || "").trim(),
    capability: summarizeCapabilityForTrace(toolName, api)
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

function summarizeToolErrorForTrace(error = null, toolName = "", api = {}) {
  return Object.fromEntries(Object.entries({
    name: String(error?.name || "Error").trim(),
    message: String(error?.message || error || "unknown error").trim().slice(0, 500),
    capability: summarizeCapabilityForTrace(toolName, api)
  }).filter(([, value]) => {
    if (value === null || value === undefined || value === "") {
      return false;
    }
    if (value && typeof value === "object") {
      return Object.keys(value).length > 0;
    }
    return true;
  }));
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
  if (normalized === "read_bot_job_log") {
    return {
      phase: "tool-read-bot-job-log",
      label: safeRound > 0 ? `继续读取 bot 任务日志（第 ${safeRound + 1} 轮）` : "读取 bot 任务日志",
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

async function recordToolExecutionEvent(traceHooks = null, api = {}, event = {}) {
  await traceHooks?.recordToolEvent?.(event);
  await api?.recordAuditEvent?.(event);
}

async function invokeJsonFallbackPlanningRound({
  planningMessages,
  tools,
  allowMoreToolCalls,
  api,
  model,
  round = 0,
  modelInvoker = invokeTextModel,
  retryReason = "",
  maxToolRounds = 4
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
    await api.appendLog(`json-tool-fallback repair round=${round} attempt=${attempt + 1} error=${String(parsed.error || "unknown").slice(0, 240)}`);
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
      retryReason,
      maxToolRounds,
      allowMoreToolCalls
    });
    await recordAgentDecisionEvent(api, {
      round,
      planStatus: "tool-requested",
      pendingToolCalls: [parsed.toolCall],
      finalAnswer: "",
      finishReason: result.finishReason || "",
      maxToolRounds,
      allowMoreToolCalls
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

  const finalPlanStatus = parsed.ok ? "final-answer" : "parse-failed";
  const finalAnswer = parsed.finalAnswer || result.text || "";
  await recordAgentPlanningEvent(api, {
    round,
    status: finalPlanStatus,
    model: result.model || model,
    fallback: "json-plan",
    finishReason: result.finishReason || "",
    pendingToolCalls: [],
    text: finalAnswer,
    parseError: parsed.ok ? "" : parsed.error,
    retryReason,
    maxToolRounds,
    allowMoreToolCalls
  });
  await recordAgentDecisionEvent(api, {
    round,
    planStatus: finalPlanStatus,
    pendingToolCalls: [],
    finalAnswer,
    parseError: parsed.ok ? "" : parsed.error,
    finishReason: result.finishReason || "",
    maxToolRounds,
    allowMoreToolCalls
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
      maxToolRounds,
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
        maxToolRounds,
        retryReason: String(error?.message || error || "native tool call unsupported").slice(0, 180)
      });
    }
    throw error;
  }
  const pendingToolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  if (pendingToolCalls.length) {
    planningMessages.push(createToolCallAssistantMessage(result));
  }
  const planStatus = pendingToolCalls.length ? "tool-requested" : "final-answer";
  await recordAgentPlanningEvent(api, {
    round,
    status: planStatus,
    model: result.model || model,
    fallback: "",
    finishReason: result.finishReason || "",
    pendingToolCalls,
    text: result.text || "",
    maxToolRounds,
    allowMoreToolCalls
  });
  await recordAgentDecisionEvent(api, {
    round,
    planStatus,
    pendingToolCalls,
    finalAnswer: result.text || "",
    finishReason: result.finishReason || "",
    maxToolRounds,
    allowMoreToolCalls
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
    const blockedResult = buildToolConfirmationGateResult(toolCall, api) || buildToolExecutionPreflightResult(toolCall, api, healthSnapshot);
    const toolStatus = blockedResult ? "blocked" : "completed";
    if (blockedResult) {
      toolResult = JSON.stringify(blockedResult, null, 2);
      await api.appendLog(`tool-call-blocked ${toolCall.name}: ${blockedResult.blocker?.id || blockedResult.status || "blocked"} ${blockedResult.blocker?.status || blockedResult.blockedReason || "unavailable"}`);
      await recordToolExecutionEvent(traceHooks, api, {
        name: toolCall.name,
        round,
        status: "blocked",
        input: fallbackMode ? { ...(toolCall.input || {}), __fallback: fallbackMode } : (toolCall.input || {}),
        inputSummary,
        ...buildTraceTiming(startedAt, startedMs),
        outputPreview: toolResult,
        resultSummary: summarizeToolResultForTrace(toolResult, toolCall.name, api)
      });
    } else {
      try {
        toolResult = await executeAiToolCall(toolCall, context, api, { recentMessages });
        await recordToolExecutionEvent(traceHooks, api, {
          name: toolCall.name,
          round,
          status: "completed",
          input: fallbackMode ? { ...(toolCall.input || {}), __fallback: fallbackMode } : (toolCall.input || {}),
          inputSummary,
          ...buildTraceTiming(startedAt, startedMs),
          outputPreview: String(toolResult || ""),
          resultSummary: summarizeToolResultForTrace(toolResult, toolCall.name, api)
        });
      } catch (error) {
        const cancelled = error?.name === "AbortError" || /job cancelled/i.test(String(error?.message || ""));
        await recordToolExecutionEvent(traceHooks, api, {
          name: toolCall.name,
          round,
          status: cancelled ? "cancelled" : "failed",
          input: fallbackMode ? { ...(toolCall.input || {}), __fallback: fallbackMode } : (toolCall.input || {}),
          inputSummary,
          ...buildTraceTiming(startedAt, startedMs),
          outputPreview: String(error?.message || error || ""),
          errorSummary: summarizeToolErrorForTrace(error, toolCall.name, api)
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
