import { buildAvailableModelChoices, buildAvailableModelsText, buildModelUsageText, buildUseListedModelText, filterModelsByCapability, getModelFilterLabel, sortModelsForDisplay } from "../../plugins/ai-chat/formatters/models.js";
import { normalizeModelFilter } from "../../plugins/ai-chat/parsers/modelDirectives.js";
import { withSessionSubtitle } from "../../plugins/ai-chat/parsers/sessionDirectives.js";
import { createAiSession, deleteAiSession, formatAiSessionLabel, listAiSessions, renameAiSession } from "../../plugins/ai-chat/services/aiSessions.js";
import { compressAiSessionContext } from "../../plugins/ai-chat/services/compressAiSession.js";
import { getEffectiveMultimodalModel, getEffectiveTextModel, migrateStoredModelRef, writeAiModelSettings } from "../../plugins/ai-chat/services/modelSettings.js";
import { isDirectRetryTextToolName } from "../../plugins/ai-chat/recovery.js";
import { buildCapabilityArtifactSummary, buildCapabilityDescriptors, formatCapabilityReport } from "../../capabilities/registry.js";
import { collectAiAgentHealth, formatHealthReport } from "../../capabilities/health.js";
import { buildAgentTraceResult, buildBotJobLogBundle, buildBotJobStatusResult } from "../../tools/botJobStatus.js";
import { getDefaultTextModelName, listAvailableModels, resolveModelReference } from "../../tools/llmClient.js";

const MODEL_PROVIDER_SEPARATOR = "::";
const PROVIDER_BADGE_META = {
  copilot: { label: "GitHub Copilot", color: "informative" },
  xunfei: { label: "讯飞Maas", color: "warning" },
  ark: { label: "Ark", color: "success" },
  openai: { label: "OpenAI Compatible", color: "subtle" }
};

function getProviderFromModelRef(value = "") {
  const trimmed = String(value || "").trim();
  if (!trimmed.includes(MODEL_PROVIDER_SEPARATOR)) {
    return "";
  }
  return String(trimmed.split(MODEL_PROVIDER_SEPARATOR)[0] || "").trim().toLowerCase();
}

function getProviderLabel(provider = "") {
  const normalized = String(provider || "").trim().toLowerCase();
  return PROVIDER_BADGE_META[normalized]?.label || normalized || "未标记 provider";
}

function getProviderBadgeColor(provider = "") {
  const normalized = String(provider || "").trim().toLowerCase();
  return PROVIDER_BADGE_META[normalized]?.color || "informative";
}

function createProviderBadge(provider = "", prefix = "") {
  const normalized = String(provider || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return {
    label: prefix ? `${prefix} · ${getProviderLabel(normalized)}` : getProviderLabel(normalized),
    color: getProviderBadgeColor(normalized),
    appearance: "tint"
  };
}

function buildProviderSummaryBadges(models = []) {
  const counts = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const provider = String(model?.provider || "").trim().toLowerCase();
    if (!provider) {
      continue;
    }
    counts.set(provider, (counts.get(provider) || 0) + 1);
  }
  return [...counts.entries()].map(([provider, count]) => ({
    label: `${getProviderLabel(provider)} ${count}`,
    color: getProviderBadgeColor(provider),
    appearance: "tint"
  }));
}

function buildEffectiveProviderBadges(settings = {}) {
  const textProvider = getProviderFromModelRef(getEffectiveTextModel(settings));
  const visionProvider = getProviderFromModelRef(getEffectiveMultimodalModel(settings));
  if (textProvider && visionProvider && textProvider === visionProvider) {
    return [createProviderBadge(textProvider, "文本/看图")].filter(Boolean);
  }
  return [
    createProviderBadge(textProvider, "文本"),
    createProviderBadge(visionProvider, "看图")
  ].filter(Boolean);
}

const STATUS_BADGE_META = {
  blocked: { label: "阻断", color: "danger" },
  error: { label: "错误", color: "danger" },
  warn: { label: "警告", color: "warning" },
  ok: { label: "可用", color: "success" },
  unknown: { label: "未知", color: "informative" }
};

function createStatusBadge(status = "", count = null) {
  const normalized = String(status || "unknown").trim().toLowerCase() || "unknown";
  const meta = STATUS_BADGE_META[normalized] || STATUS_BADGE_META.unknown;
  const suffix = Number.isFinite(Number(count)) ? ` ${Number(count)}` : "";
  return {
    label: `${meta.label}${suffix}`,
    color: meta.color,
    appearance: "tint"
  };
}

function countByStatus(items = [], getStatus = (item) => item?.status) {
  const counts = {};
  for (const item of Array.isArray(items) ? items : []) {
    const status = String(getStatus(item) || "unknown").trim().toLowerCase() || "unknown";
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function buildHealthStatusBadges(health = {}) {
  const counts = countByStatus(health.checks);
  return [
    createStatusBadge(health.overall || "unknown"),
    counts.error ? createStatusBadge("error", counts.error) : null,
    counts.warn ? createStatusBadge("warn", counts.warn) : null,
    counts.ok ? createStatusBadge("ok", counts.ok) : null,
    counts.unknown ? createStatusBadge("unknown", counts.unknown) : null
  ].filter(Boolean);
}

function buildCapabilityStatusBadges(artifact = {}) {
  const counts = countByStatus(artifact.capabilities);
  return [
    Number.isFinite(Number(artifact.count))
      ? { label: `能力 ${Number(artifact.count)}`, color: "informative", appearance: "tint" }
      : null,
    counts.blocked ? createStatusBadge("blocked", counts.blocked) : null,
    counts.error ? createStatusBadge("error", counts.error) : null,
    counts.warn ? createStatusBadge("warn", counts.warn) : null,
    counts.ok ? createStatusBadge("ok", counts.ok) : null,
    counts.unknown ? createStatusBadge("unknown", counts.unknown) : null
  ].filter(Boolean);
}

function formatDurationMs(value) {
  const durationMs = Number(value);
  if (!Number.isFinite(durationMs)) {
    return "";
  }
  if (durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs))}ms`;
  }
  return `${(Math.max(0, durationMs) / 1000).toFixed(1)}s`;
}

function formatStatusCounts(counts = {}) {
  const entries = Object.entries(counts || {}).filter(([, count]) => Number(count) > 0);
  return entries.length ? entries.map(([status, count]) => `${status} ${count}`).join(" / ") : "";
}

function compactJsonInline(value = null, maxLength = 180) {
  if (value == null) {
    return "";
  }
  try {
    const text = JSON.stringify(value);
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  } catch {
    const text = String(value || "");
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  }
}

function summarizeTraceResultAccess(fileAccess = null) {
  if (!fileAccess || typeof fileAccess !== "object") {
    return "";
  }
  const parts = [];
  if (typeof fileAccess.found === "boolean") {
    parts.push(`found=${fileAccess.found}`);
  }
  if (fileAccess.contentAccess?.analyzeMode) {
    parts.push(`mode=${fileAccess.contentAccess.analyzeMode}`);
  }
  const availableLayers = Array.isArray(fileAccess.layers)
    ? fileAccess.layers.filter((layer) => layer?.available === true).map((layer) => layer.id || layer.label).filter(Boolean)
    : [];
  if (availableLayers.length) {
    parts.push(`layers=${availableLayers.slice(0, 5).join(",")}`);
  }
  const blockers = Array.isArray(fileAccess.blockers)
    ? fileAccess.blockers.map((blocker) => blocker?.id || blocker?.message).filter(Boolean)
    : [];
  if (blockers.length) {
    parts.push(`blockers=${blockers.slice(0, 4).join(",")}`);
  }
  const actionTools = Array.isArray(fileAccess.actionPlan)
    ? fileAccess.actionPlan.map((action) => action?.tool || action?.id).filter(Boolean)
    : [];
  if (actionTools.length) {
    parts.push(`actions=${actionTools.slice(0, 5).join(",")}`);
  }
  const nextActions = Array.isArray(fileAccess.nextActions) ? fileAccess.nextActions.filter(Boolean) : [];
  if (nextActions.length) {
    parts.push(`next=${nextActions[0]}`);
  }
  return parts.join(" · ");
}

function summarizeTraceCapability(capability = null) {
  if (!capability || typeof capability !== "object") {
    return "";
  }
  const output = capability.output && typeof capability.output === "object" ? capability.output : {};
  const returns = Array.isArray(output.required) && output.required.length
    ? output.required
    : (Array.isArray(output.fields) ? output.fields : []);
  const permissions = Array.isArray(capability.permissions) ? capability.permissions.filter(Boolean) : [];
  const caps = Array.isArray(capability.capabilities) ? capability.capabilities.filter(Boolean) : [];
  return [
    capability.id ? `id=${capability.id}` : "",
    capability.riskLevel ? `risk=${capability.riskLevel}` : "",
    capability.executionMode ? `mode=${capability.executionMode}` : "",
    capability.requiresConfirmation === true ? "requires-confirmation" : "",
    permissions.length ? `perms=${permissions.slice(0, 6).join(",")}` : "",
    caps.length ? `caps=${caps.slice(0, 5).join(",")}` : "",
    returns.length ? `returns=${returns.slice(0, 8).join(",")}` : ""
  ].filter(Boolean).join(" · ");
}

function summarizeTraceResultLog(log = null) {
  if (!log || typeof log !== "object") {
    return "";
  }
  const length = Number.isFinite(Number(log.length)) ? Number(log.length) : null;
  return [
    log.jobId ? `job=${log.jobId}` : "",
    length != null ? `chars=${length}` : "",
    log.truncated === true ? "truncated" : ""
  ].filter(Boolean).join(" · ");
}

function summarizeTraceResultAgentTrace(agentTrace = null) {
  if (!agentTrace || typeof agentTrace !== "object") {
    return "";
  }
  return [
    Number.isFinite(Number(agentTrace.eventCount)) ? `events=${Number(agentTrace.eventCount)}` : "",
    Number.isFinite(Number(agentTrace.childJobCount)) ? `childJobs=${Number(agentTrace.childJobCount)}` : ""
  ].filter(Boolean).join(" · ");
}

function formatTraceTimelineItem(item = {}) {
  const label = String(item.label || item.tool || item.phase || item.node || "event").trim();
  const resultSummary = item.resultSummary && typeof item.resultSummary === "object" ? item.resultSummary : {};
  const suffixes = [
    item.agentPhase ? `phase=${item.agentPhase}` : "",
    item.durationMs != null ? formatDurationMs(item.durationMs) : "",
    item.detailSummary?.pendingTools?.length
      ? `tools=${item.detailSummary.pendingTools.map((tool) => tool.name).filter(Boolean).join(",")}`
      : "",
    resultSummary.jobRefs?.length
      ? `job=${resultSummary.jobRefs.map((ref) => `${ref.botId || "bot"}:${ref.jobId}`).join(",")}`
      : "",
    item.errorSummary?.message ? `error=${item.errorSummary.message}` : ""
  ].filter(Boolean);
  const input = compactJsonInline(item.inputSummary, 140);
  const capability = summarizeTraceCapability(resultSummary.capability || item.errorSummary?.capability);
  const access = summarizeTraceResultAccess(resultSummary.fileAccess);
  const log = summarizeTraceResultLog(resultSummary.log);
  const agentTrace = summarizeTraceResultAgentTrace(resultSummary.agentTrace);
  const nextAction = String(resultSummary.nextAction || "").trim();
  const blockedReason = String(resultSummary.blockedReason || "").trim();
  return [
    `- ${item.index || "?"}. ${label}${suffixes.length ? ` · ${suffixes.join(" · ")}` : ""}`,
    input ? `  input: ${input}` : "",
    capability ? `  capability: ${capability}` : "",
    access ? `  access: ${access}` : "",
    log ? `  log: ${log}` : "",
    agentTrace ? `  trace: ${agentTrace}` : "",
    blockedReason ? `  blocked: ${blockedReason}` : "",
    nextAction ? `  next: ${nextAction}` : ""
  ].filter(Boolean).join("\n");
}

function formatAgentPlanSummary(planSummary = {}) {
  const rounds = Array.isArray(planSummary.rounds) ? planSummary.rounds.slice(-5) : [];
  if (!rounds.length) {
    return "";
  }
  const lines = ["Agent 计划:"];
  for (const round of rounds) {
    const prefix = `- round ${Number.isFinite(Number(round.round)) ? Number(round.round) : "?"}`;
    if (Array.isArray(round.plans) && round.plans.length) {
      for (const plan of round.plans.slice(-2)) {
        const tools = Array.isArray(plan.pendingTools) && plan.pendingTools.length
          ? `tools=${plan.pendingTools.map((tool) => `${tool.name}${tool.reason ? `(${tool.reason})` : ""}`).join(", ")}`
          : "final-answer";
        const details = [
          plan.status || "",
          plan.fallback ? `fallback=${plan.fallback}` : "",
          plan.model ? `model=${plan.model}` : "",
          plan.maxToolRounds != null ? `limit=${plan.maxToolRounds}` : "",
          typeof plan.allowMoreToolCalls === "boolean" ? `toolsAllowed=${plan.allowMoreToolCalls ? "yes" : "no"}` : "",
          plan.retryReason ? `retry=${plan.retryReason}` : "",
          plan.parseError ? `parseError=${plan.parseError}` : "",
          tools
        ].filter(Boolean).join(" · ");
        lines.push(`${prefix} plan: ${details}`);
      }
    }
    if (Array.isArray(round.observations) && round.observations.length) {
      for (const observation of round.observations.slice(-2)) {
        const details = [
          observation.status || "",
          observation.tool ? `tool=${observation.tool}` : "",
          observation.fallback ? `fallback=${observation.fallback}` : "",
          observation.observationLength != null ? `chars=${observation.observationLength}` : ""
        ].filter(Boolean).join(" · ");
        lines.push(`${prefix} observe: ${details}`);
      }
    }
    if (Array.isArray(round.decisions) && round.decisions.length) {
      for (const decision of round.decisions.slice(-2)) {
        const tools = Array.isArray(decision.pendingTools) && decision.pendingTools.length
          ? `tools=${decision.pendingTools.map((tool) => tool.name).filter(Boolean).join(", ")}`
          : "";
        const details = [
          decision.status || "",
          decision.decision ? `decision=${decision.decision}` : "",
          decision.planStatus ? `plan=${decision.planStatus}` : "",
          Number.isFinite(Number(decision.pendingToolCount)) ? `pending=${Number(decision.pendingToolCount)}` : "",
          Number.isFinite(Number(decision.finalAnswerLength)) ? `answerChars=${Number(decision.finalAnswerLength)}` : "",
          tools
        ].filter(Boolean).join(" · ");
        lines.push(`${prefix} decide: ${details}`);
      }
    }
  }
  return lines.join("\n");
}

function formatChildJobSummary(trace = {}) {
  const childJobs = Array.isArray(trace.childJobs) ? trace.childJobs : [];
  if (!childJobs.length) {
    return "";
  }
  const counts = formatStatusCounts(trace.childJobStatusCounts || {});
  const lines = [`子任务:${counts ? ` ${counts}` : ""}`];
  for (const job of childJobs.slice(0, 8)) {
    const progress = job.progress?.label
      ? `${job.progress.label}${job.progress.percent != null ? ` ${job.progress.percent}%` : ""}`
      : "";
    const error = job.error?.message ? `error=${job.error.message}` : "";
    const parts = [
      job.botId || "bot",
      job.jobId || "",
      job.status || "",
      job.phase || "",
      progress,
      error
    ].filter(Boolean);
    lines.push(`- ${parts.join(" · ")}`);
    const commands = formatJobTrackingLine(job, "  ");
    if (commands) {
      lines.push(commands);
    }
  }
  return lines.join("\n");
}

function getJobTrackingCommands(job = {}) {
  const jobId = String(job.jobId || "").trim();
  if (!jobId) {
    return null;
  }
  const tracking = job.tracking && typeof job.tracking === "object" ? job.tracking : {};
  return {
    statusCommand: String(tracking.statusCommand || `@ai /job ${jobId}`).trim(),
    logCommand: String(tracking.logCommand || `@ai /log ${jobId}`).trim(),
    traceCommand: String(tracking.traceCommand || `@ai /trace ${jobId}`).trim()
  };
}

function formatJobTrackingLine(job = {}, prefix = "  ") {
  const commands = getJobTrackingCommands(job);
  if (!commands) {
    return "";
  }
  return `${prefix}命令：${commands.statusCommand} · ${commands.logCommand} · ${commands.traceCommand}`;
}

function buildBotJobTraceAction(job = {}, jobId = "") {
  if (String(job?.botId || "").trim() !== "ai.chat") {
    return null;
  }
  return {
    type: "invoke-bot",
    label: "查看 Trace",
    botId: "ai.chat",
    rawText: `/trace ${jobId}`
  };
}

function getTraceRecoverySessionId(trace = {}, activeSession = null) {
  const activeId = activeSession?.id;
  if (activeId != null && String(activeId).trim() !== "") {
    return activeId;
  }
  const snapshotId = trace?.snapshot?.sessionId;
  return snapshotId != null && String(snapshotId).trim() !== "" ? snapshotId : null;
}

function hasSafeSuggestedTraceRecoveryAction(hint = {}) {
  return (Array.isArray(hint.suggestedActions) ? hint.suggestedActions : []).some((action) => {
    const tool = String(action?.tool || "").trim();
    const input = action?.input && typeof action.input === "object" && !Array.isArray(action.input) ? action.input : {};
    const riskLevel = String(action?.riskLevel || "low").trim().toLowerCase() || "low";
    const hasTarget = Boolean(
      String(input.fileId || input.path || input.filePath || input.query || "").trim()
      || (Array.isArray(input.fileIds) && input.fileIds.length > 0)
      || (Array.isArray(input.paths) && input.paths.length > 0)
    );
    return tool
      && isDirectRetryTextToolName(tool)
      && action?.requiresConfirmation !== true
      && riskLevel === "low"
      && hasTarget;
  });
}

function buildAgentTraceRecoveryAction(trace = {}, activeSession = null) {
  const hint = trace?.recoveryHint && typeof trace.recoveryHint === "object" ? trace.recoveryHint : null;
  if (!hint || hint.requiresUserConfirmation === true || hint.requiresAttachment === true) {
    return null;
  }
  const mode = String(hint.mode || "").trim();
  if (mode === "awaiting-confirmation" || mode === "vision-require-attachment" || mode === "resume-default") {
    return null;
  }
  const sessionId = getTraceRecoverySessionId(trace, activeSession);
  if (sessionId == null || String(sessionId).trim() === "") {
    return null;
  }
  const directModes = new Set(["text-retry-tools", "file-access-retry-tools", "file-access-suggested-actions"]);
  const replanModes = new Set(["text-replan", "cancelled-replan", "failed-replan", "answer-rebuild"]);
  const isDirectRetry = hint.canContinueDirectly === true || directModes.has(mode) || hasSafeSuggestedTraceRecoveryAction(hint);
  const isReplan = replanModes.has(mode);
  if (!isDirectRetry && !isReplan) {
    return null;
  }
  return {
    type: "invoke-bot",
    label: isDirectRetry ? "重试失败步骤" : "重新规划",
    botId: "ai.chat",
    rawText: `#${sessionId} 继续`,
    parsedArgs: {
      __chatReplyMode: "replace-chat-message"
    }
  };
}

function buildAgentTraceCardActions(trace = {}, activeSession = null) {
  const jobId = String(trace?.jobId || "").trim();
  const baseActions = buildBotJobCardActions(trace?.snapshot || {}, jobId, { includeTrace: false });
  const recoveryAction = buildAgentTraceRecoveryAction(trace, activeSession);
  return recoveryAction ? [recoveryAction, ...baseActions] : baseActions;
}

function prependTraceRecoveryAction(actions = [], trace = null, activeSession = null) {
  const recoveryAction = buildAgentTraceRecoveryAction(trace, activeSession);
  if (!recoveryAction) {
    return actions;
  }
  const exists = (Array.isArray(actions) ? actions : []).some((action) => (
    String(action?.type || "") === recoveryAction.type
    && String(action?.botId || "") === recoveryAction.botId
    && String(action?.rawText || "") === recoveryAction.rawText
  ));
  return exists ? actions : [recoveryAction, ...actions];
}

function buildBotJobCardActionsWithRecovery(job = {}, fallbackJobId = "", activeSession = null, options = {}) {
  const actions = buildBotJobCardActions(job, fallbackJobId, options);
  const trace = options.agentTrace && typeof options.agentTrace === "object"
    ? options.agentTrace
    : (job?.agentTrace && typeof job.agentTrace === "object" ? job.agentTrace : null);
  return prependTraceRecoveryAction(actions, trace, activeSession);
}

function buildBotJobCardActions(job = {}, fallbackJobId = "", options = {}) {
  const jobId = String(job?.jobId || fallbackJobId || "").trim();
  if (!jobId) {
    return [];
  }
  const status = String(job?.status || "").trim().toLowerCase();
  const traceAction = options.includeTrace === false ? null : buildBotJobTraceAction(job, jobId);
  const withTraceAction = (actions) => traceAction
    ? [actions[0], traceAction, ...actions.slice(1)].filter(Boolean)
    : actions;
  if (["queued", "running"].includes(status)) {
    return withTraceAction([
      { type: "continue-bot-job", label: "继续等待", jobId },
      { type: "open-bot-log", label: "查看日志", jobId },
      { type: "cancel-bot-job", label: "停止生成", jobId }
    ]);
  }
  if (["failed", "cancelled"].includes(status)) {
    return withTraceAction([
      { type: "open-bot-log", label: "查看日志", jobId },
      { type: "retry-bot-job", label: "重新生成", jobId }
    ]);
  }
  return withTraceAction([{ type: "open-bot-log", label: "查看日志", jobId }]);
}

function formatBotJobLine(job = {}, prefix = "-") {
  const progress = job.progress?.label
    ? `${job.progress.label}${job.progress.percent != null ? ` ${job.progress.percent}%` : ""}`
    : "";
  const error = job.error?.message ? `error=${job.error.message}` : "";
  const parts = [
    job.botId || "bot",
    job.jobId || "",
    job.status || "",
    job.phase || "",
    progress,
    error
  ].filter(Boolean);
  return `${prefix} ${parts.join(" · ")}`;
}

function formatJobAuditLines(job = {}, indent = "  ") {
  const audit = job.audit && typeof job.audit === "object" ? job.audit : {};
  const permissions = Array.isArray(audit.permissionsUsed) ? audit.permissionsUsed.filter(Boolean) : [];
  const toolCallCount = Number.isFinite(Number(audit.toolCallCount)) ? Number(audit.toolCallCount) : 0;
  const recentToolCalls = Array.isArray(audit.recentToolCalls) ? audit.recentToolCalls.filter(Boolean) : [];
  if (!permissions.length && !toolCallCount && !recentToolCalls.length) {
    return [];
  }
  const lines = [];
  lines.push(`${indent}审计：工具调用 ${toolCallCount}${permissions.length ? ` · 权限 ${permissions.slice(0, 8).join("、")}${permissions.length > 8 ? "…" : ""}` : ""}`);
  for (const call of recentToolCalls.slice(-3)) {
    const parts = [
      call.name || "tool",
      call.status || "",
      call.riskLevel ? `risk=${call.riskLevel}` : "",
      Array.isArray(call.identifiers) && call.identifiers.length ? `ids=${call.identifiers.slice(0, 3).join(", ")}` : "",
      Array.isArray(call.permissions) && call.permissions.length ? `perm=${call.permissions.slice(0, 4).join(", ")}` : "",
      Array.isArray(call.jobRefs) && call.jobRefs.length ? `jobs=${call.jobRefs.map((ref) => `${ref.botId || "bot"}:${ref.jobId}`).join(", ")}` : ""
    ].filter(Boolean);
    lines.push(`${indent}- ${parts.join(" · ")}`);
  }
  return lines;
}

function formatRecoveryHintLines(trace = null, indent = "") {
  const hint = trace?.recoveryHint || null;
  if (!hint || typeof hint !== "object") {
    return [];
  }
  const lines = [];
  if (hint.nextAction) {
    lines.push(`${indent}恢复建议：${hint.nextAction}`);
  }
  const suggestedTools = Array.isArray(hint.suggestedActions)
    ? hint.suggestedActions.map((action) => action?.tool || action?.id).filter(Boolean)
    : [];
  if (suggestedTools.length) {
    lines.push(`${indent}建议工具：${suggestedTools.join("、")}`);
  }
  const sessionId = trace?.snapshot?.sessionId ?? null;
  if (hint.canContinueDirectly === true && hint.requiresUserConfirmation !== true && sessionId !== null && sessionId !== undefined && sessionId !== "") {
    lines.push(`${indent}可继续：@ai #${sessionId} 继续`);
  } else if (hint.requiresUserConfirmation === true) {
    lines.push(`${indent}需要确认：${hint.tool ? `${hint.tool} ` : ""}${hint.targetFileCount != null ? `影响文件数 ${hint.targetFileCount}` : "等待用户确认"}`);
  }
  return lines;
}

export function formatBotJobStatusReport(status = {}) {
  const jobs = Array.isArray(status.jobs) ? status.jobs : [];
  const missing = Array.isArray(status.missing) ? status.missing : [];
  if (!jobs.length && !missing.length) {
    return status.recent
      ? "最近没有可显示的 bot 任务。"
      : "没有找到指定的 bot 任务。";
  }
  const lines = [
    status.recent ? `最近 bot 任务：${jobs.length}` : `Bot 任务状态：${jobs.length}`
  ];
  if (missing.length) {
    lines.push(`未找到：${missing.join("、")}`);
  }
  for (const job of jobs) {
    lines.push(formatBotJobLine(job));
    lines.push(...formatJobAuditLines(job, "  "));
    const childCount = Number(job.childJobCount || 0);
    if (childCount > 0) {
      const counts = formatStatusCounts(job.childJobStatusCounts || {});
      lines.push(`  子任务：${childCount}${counts ? ` · ${counts}` : ""}`);
      for (const child of (Array.isArray(job.childJobs) ? job.childJobs : []).slice(0, 5)) {
        lines.push(formatBotJobLine(child, "  -"));
        const commands = formatJobTrackingLine(child, "    ");
        if (commands) {
          lines.push(commands);
        }
      }
    }
    const trace = job.agentTrace;
    lines.push(...formatRecoveryHintLines(trace, "  "));
  }
  lines.push("");
  lines.push("查看 agent 执行细节：@ai /trace <jobId>");
  return lines.join("\n");
}

export function formatBotJobLogReport(bundle = {}) {
  const jobId = String(bundle.jobId || bundle.log?.jobId || "").trim();
  if (!bundle.job && !bundle.log?.content) {
    return jobId ? `没有找到 ${jobId} 的任务或日志。` : "没有找到可显示的 bot 日志。";
  }
  const lines = [`Bot 日志：${jobId || "unknown"}`];
  if (bundle.job) {
    lines.push(formatBotJobLine(bundle.job));
    lines.push(...formatJobAuditLines(bundle.job));
  }
  const childJobs = Array.isArray(bundle.childJobs) ? bundle.childJobs : [];
  if (childJobs.length) {
    lines.push(`子任务：${childJobs.length}`);
    for (const child of childJobs.slice(0, 5)) {
      lines.push(formatBotJobLine(child, "  -"));
      const commands = formatJobTrackingLine(child, "    ");
      if (commands) {
        lines.push(commands);
      }
    }
  }
  const trace = bundle.agentTrace;
  lines.push(...formatRecoveryHintLines(trace));
  const content = String(bundle.log?.content || "").trim();
  lines.push("");
  lines.push(bundle.log?.truncated ? "日志尾部（已截断）:" : "日志:");
  lines.push(content ? "```text" : "（没有日志内容）");
  if (content) {
    lines.push(content.slice(-12_000));
    lines.push("```");
  }
  lines.push("");
  lines.push("查看任务状态：@ai /job " + (jobId || "<jobId>"));
  lines.push("查看 agent trace：@ai /trace " + (jobId || "<jobId>"));
  return lines.join("\n");
}

export function formatAgentTraceReport(trace = {}) {
  const jobId = String(trace.jobId || "").trim();
  if (!jobId) {
    return "还没有找到最近一次 ai.chat 执行 trace。可以先运行一个 @ai 任务，再用 @ai /trace 查看。";
  }

  if (trace.missing === true) {
    return [
      `没有找到 ${jobId} 的 agent trace。`,
      "可能原因：jobId 不是 ai.chat 执行、trace 已被清理，或这次任务还没写入 trace。"
    ].join("\n");
  }

  const snapshot = trace.snapshot || {};
  const traceSummary = snapshot.traceSummary || {};
  const header = [
    `Agent job: ${jobId}${trace.latest ? "（最近一次）" : ""}`,
    snapshot.status ? `状态: ${snapshot.status}` : "",
    snapshot.route ? `路线: ${snapshot.route}` : "",
    traceSummary.lastNode ? `最后节点: ${traceSummary.lastNode}` : "",
    traceSummary.lastAgentPhase ? `最后阶段: ${traceSummary.lastAgentPhase}` : "",
    snapshot.savedAt ? `保存时间: ${String(snapshot.savedAt).slice(0, 19).replace("T", " ")}` : ""
  ].filter(Boolean).join("\n");

  const pending = trace.pendingConfirmation?.tool
    ? [
        "等待确认:",
        `- tool: ${trace.pendingConfirmation.tool}`,
        trace.pendingConfirmation.confirmation?.riskLevel ? `- risk: ${trace.pendingConfirmation.confirmation.riskLevel}` : "",
        Number.isFinite(Number(trace.pendingConfirmation.confirmation?.impact?.targetFileCount))
          ? `- 影响文件数: ${trace.pendingConfirmation.confirmation.impact.targetFileCount}`
          : ""
      ].filter(Boolean).join("\n")
    : "";

  const recovery = trace.recoveryHint?.nextAction
    ? [
        "恢复建议:",
        `- mode: ${trace.recoveryHint.mode || "unknown"}`,
        `- next: ${trace.recoveryHint.nextAction}`,
        Array.isArray(trace.recoveryHint.suggestedActions) && trace.recoveryHint.suggestedActions.length
          ? `- suggested tools: ${trace.recoveryHint.suggestedActions.map((action) => action.tool || action.id).filter(Boolean).join(", ")}`
          : "",
        trace.recoveryHint.suggestedAction?.reason ? `- suggested reason: ${trace.recoveryHint.suggestedAction.reason}` : ""
      ].filter(Boolean).join("\n")
    : "";

  const suggestedOnly = !recovery && Array.isArray(trace.recoveryHint?.suggestedActions) && trace.recoveryHint.suggestedActions.length
    ? [
        "文件访问建议:",
        `- tools: ${trace.recoveryHint.suggestedActions.map((action) => action.tool || action.id).filter(Boolean).join(", ")}`,
        trace.recoveryHint.suggestedAction?.reason ? `- reason: ${trace.recoveryHint.suggestedAction.reason}` : ""
      ].join("\n")
    : "";

  const plan = formatAgentPlanSummary(trace.planSummary || {});
  const childJobs = formatChildJobSummary(trace);

  const toolStats = trace.toolStats || {};
  const toolRows = Array.isArray(toolStats.tools)
    ? toolStats.tools.slice(0, 6).map((tool) => {
        const stats = formatStatusCounts(tool.statusCounts);
        const avg = tool.averageDurationMs != null ? `avg ${formatDurationMs(tool.averageDurationMs)}` : "";
        const refs = Array.isArray(tool.jobRefs) && tool.jobRefs.length
          ? `jobs ${tool.jobRefs.map((ref) => `${ref.botId || "bot"}:${ref.jobId}`).join(", ")}`
          : "";
        return `- ${tool.tool}: ${tool.callCount} 次${stats ? ` · ${stats}` : ""}${avg ? ` · ${avg}` : ""}${refs ? ` · ${refs}` : ""}`;
      })
    : [];
  const tools = [
    "工具统计:",
    `- 总调用: ${Number(toolStats.count || 0)}${formatStatusCounts(toolStats.statusCounts) ? ` · ${formatStatusCounts(toolStats.statusCounts)}` : ""}`,
    ...toolRows
  ].join("\n");

  const timelineItems = Array.isArray(trace.timeline) ? trace.timeline.slice(-12) : [];
  const timeline = timelineItems.length
    ? ["最近步骤:", ...timelineItems.map(formatTraceTimelineItem)].join("\n")
    : "最近步骤: trace 里没有可展示的事件。";

  return [header, pending, recovery, suggestedOnly, plan, childJobs, tools, timeline].filter(Boolean).join("\n\n");
}

async function resolveModelForSettings(rawModel = "", modelSettings = {}, api = {}, purpose = "text") {
  const result = await resolveModelReference(rawModel, {
    cachedModels: Array.isArray(modelSettings.lastListedModels) ? modelSettings.lastListedModels : [],
    signal: api.signal
  });
  const purposeLabel = purpose === "vision"
    ? "看图"
    : (purpose === "all" ? "文本和看图" : "文本");
  if (!result.ok) {
    throw new Error(`无法设置${purposeLabel}模型：${result.reason}`);
  }
  if ((purpose === "vision" || purpose === "all") && result.model?.vision !== true) {
    throw new Error(`无法设置${purposeLabel}模型：${result.modelRef} 未声明 vision 能力。请先执行 @ai /models vision 查看可用看图模型，或使用 @ai /model set <模型名> 仅更新文本模型。`);
  }
  return {
    ...result.model,
    id: result.modelRef
  };
}

export async function handleAiChatCommandRoute(state = {}) {
  const prepared = state.prepared || {};
  const api = prepared.api;
  const sessionDirective = prepared.sessionDirective || {};
  const modelDirective = prepared.modelDirective || {};
  const modelSettings = prepared.modelSettings || {};
  const activeSession = prepared.activeSession || null;
  const modelOverride = prepared.modelOverride || "";
  const defaultTextModel = prepared.defaultTextModel || "";
  const defaultMultimodalModel = prepared.defaultMultimodalModel || "";

  api.throwIfCancelled();

  if (sessionDirective.command?.type === "new-session") {
    const session = await createAiSession(api.appDataRoot, sessionDirective.command.name || "");
    const reply = [`已创建 AI 会话 ${formatAiSessionLabel(session)}`, `后续使用方式：@ai #${session.id} 你的问题`, `例如：@ai #${session.id} 继续刚才的话题`].join("\n");
    return {
      result: {
        chatReply: await api.publishChatReply({
          text: reply,
          card: { type: "ai-answer", status: "succeeded", title: "AI 会话已创建", subtitle: formatAiSessionLabel(session), body: reply }
        }),
        importedFiles: [],
        artifacts: [{ type: "ai-session-created", sessionId: session.id, name: session.name }]
      }
    };
  }

  if (sessionDirective.command?.type === "list-sessions") {
    const sessions = await listAiSessions(api.appDataRoot);
    const reply = sessions.length
      ? ["已有 AI 会话：", ...sessions.map((item) => `- ${formatAiSessionLabel(item)} · 最近更新 ${String(item.updatedAt || item.createdAt || "").slice(0, 16).replace("T", " ")}`), "", "使用方式：@ai #编号 你的问题"].join("\n")
      : "当前还没有 AI 会话，先执行 @ai /new 会话名字";
    return {
      result: {
        chatReply: await api.publishChatReply({
          text: reply,
          card: { type: "ai-answer", status: "succeeded", title: "AI 会话列表", subtitle: `共 ${sessions.length} 个会话`, body: reply }
        }),
        importedFiles: [],
        artifacts: [{ type: "ai-session-list", count: sessions.length }]
      }
    };
  }

  if (sessionDirective.command?.type === "rename-session") {
    const renamed = await renameAiSession(api.appDataRoot, sessionDirective.sessionId, sessionDirective.command.name || "");
    if (!renamed) {
      throw new Error(`AI 会话 #${sessionDirective.sessionId} 不存在，无法重命名`);
    }
    const reply = [`已重命名 AI 会话 ${formatAiSessionLabel(renamed)}`, `后续使用方式：@ai #${renamed.id} 你的问题`].join("\n");
    return {
      result: {
        chatReply: await api.publishChatReply({
          text: reply,
          card: { type: "ai-answer", status: "succeeded", title: "AI 会话已重命名", subtitle: formatAiSessionLabel(renamed), body: reply }
        }),
        importedFiles: [],
        artifacts: [{ type: "ai-session-renamed", sessionId: renamed.id, name: renamed.name }]
      }
    };
  }

  if (sessionDirective.command?.type === "delete-session") {
    const deleted = await deleteAiSession(api.appDataRoot, sessionDirective.sessionId);
    if (!deleted) {
      throw new Error(`AI 会话 #${sessionDirective.sessionId} 不存在，无法删除`);
    }
    const reply = [`已删除 AI 会话 ${formatAiSessionLabel(deleted)}`, "该会话的独立上下文已一并移除。"].join("\n");
    return {
      result: {
        chatReply: await api.publishChatReply({
          text: reply,
          card: { type: "ai-answer", status: "succeeded", title: "AI 会话已删除", subtitle: `#${deleted.id}`, body: reply }
        }),
        importedFiles: [],
        artifacts: [{ type: "ai-session-deleted", sessionId: deleted.id, name: deleted.name }]
      }
    };
  }

  if (modelDirective.inspectOnly) {
    const usageText = buildModelUsageText(modelSettings);
    const infoBadges = modelOverride
      ? [createProviderBadge(getProviderFromModelRef(modelOverride), "临时")].filter(Boolean)
      : buildEffectiveProviderBadges(modelSettings);
    return {
      result: {
        chatReply: await api.publishChatReply({
          text: usageText,
          card: { type: "ai-answer", status: "succeeded", title: "AI 模型信息", subtitle: withSessionSubtitle(modelOverride ? `临时模型: ${modelOverride}` : "可在消息内临时切换", activeSession), body: usageText, badges: infoBadges }
        }),
        importedFiles: [],
        artifacts: [{ type: "model-info", textModel: defaultTextModel, multimodalModel: defaultMultimodalModel }]
      }
    };
  }

  if (modelDirective.command && modelDirective.command.type !== "explicit-search") {
    if (modelDirective.command.type === "health") {
      const health = await collectAiAgentHealth(api, { modelSettings, signal: api.signal });
      const body = formatHealthReport(health);
      return {
        result: {
          chatReply: await api.publishChatReply({
            text: body,
            card: { type: "ai-answer", status: health.overall === "error" ? "failed" : "succeeded", title: "AI Agent 健康检查", subtitle: withSessionSubtitle(`overall: ${health.overall}`, activeSession), body, badges: buildHealthStatusBadges(health) }
          }),
          importedFiles: [],
          artifacts: [{ type: "agent-health", health }]
        }
      };
    }

    if (modelDirective.command.type === "list-tools") {
      const health = await collectAiAgentHealth(api, { modelSettings, signal: api.signal });
      const descriptors = buildCapabilityDescriptors(api);
      const body = formatCapabilityReport(descriptors, health);
      const artifact = buildCapabilityArtifactSummary(descriptors, health);
      return {
        result: {
          chatReply: await api.publishChatReply({
            text: body,
            card: { type: "ai-answer", status: health.overall === "error" ? "failed" : "succeeded", title: "AI Agent 工具列表", subtitle: withSessionSubtitle(`共 ${descriptors.length} 项能力`, activeSession), body, badges: buildCapabilityStatusBadges(artifact) }
          }),
          importedFiles: [],
          artifacts: [{ type: "agent-tools", ...artifact, health }]
        }
      };
    }

    if (modelDirective.command.type === "trace") {
      const trace = await buildAgentTraceResult(api, {
        jobId: modelDirective.command.jobId || "",
        maxEvents: 60
      });
      const body = formatAgentTraceReport(trace);
      return {
        result: {
          chatReply: await api.publishChatReply({
            text: body,
            card: {
              type: "ai-answer",
              status: trace.missing === true ? "failed" : "succeeded",
              title: "AI Agent Trace",
              subtitle: withSessionSubtitle(trace.jobId ? `job: ${trace.jobId}` : "没有可用 trace", activeSession),
              body,
              actions: trace.missing === true ? [] : buildAgentTraceCardActions(trace, activeSession)
            }
          }),
          importedFiles: [],
          artifacts: [{
            type: "agent-trace",
            jobId: trace.jobId || "",
            latest: trace.latest === true,
            missing: trace.missing === true,
            planSummary: trace.planSummary || null,
            recoveryHint: trace.recoveryHint || null,
            toolStats: trace.toolStats || null,
            childJobCount: trace.childJobCount || 0,
            childJobStatusCounts: trace.childJobStatusCounts || {},
            childJobs: Array.isArray(trace.childJobs) ? trace.childJobs : []
          }]
        }
      };
    }

    if (modelDirective.command.type === "jobs") {
      const jobId = String(modelDirective.command.jobId || "").trim();
      const status = await buildBotJobStatusResult(api, {
        jobId,
        limit: modelDirective.command.limit || 5,
        includeChildJobs: true,
        includeTrace: Boolean(jobId),
        maxTraceEvents: 24
      });
      const body = formatBotJobStatusReport(status);
      return {
        result: {
          chatReply: await api.publishChatReply({
            text: body,
            card: {
              type: "ai-answer",
              status: status.missing?.length && !status.jobs?.length ? "failed" : "succeeded",
              title: jobId ? "Bot 任务状态" : "最近 Bot 任务",
              subtitle: withSessionSubtitle(jobId || `共 ${status.count || 0} 个任务`, activeSession),
              body,
              actions: jobId ? buildBotJobCardActionsWithRecovery(status.jobs?.[0] || {}, jobId, activeSession) : []
            }
          }),
          importedFiles: [],
          artifacts: [{
            type: "bot-job-status",
            recent: status.recent === true,
            count: status.count || 0,
            missing: status.missing || [],
            jobs: status.jobs || []
          }]
        }
      };
    }

    if (modelDirective.command.type === "log") {
      const jobId = String(modelDirective.command.jobId || "").trim();
      const bundle = await buildBotJobLogBundle(api, {
        jobId,
        includeChildJobs: true,
        includeTrace: true,
        maxBytes: 16_000,
        maxTraceEvents: 24
      });
      const body = formatBotJobLogReport(bundle);
      return {
        result: {
          chatReply: await api.publishChatReply({
            text: body,
            card: {
              type: "ai-answer",
              status: bundle.job ? "succeeded" : "failed",
              title: "Bot 任务日志",
              subtitle: withSessionSubtitle(jobId || "unknown", activeSession),
              body,
              actions: buildBotJobCardActionsWithRecovery(bundle.job || {}, bundle.jobId || jobId, activeSession, {
                agentTrace: bundle.agentTrace || null
              })
            }
          }),
          importedFiles: [],
          artifacts: [{
            type: "bot-job-log",
            jobId: bundle.jobId || jobId,
            job: bundle.job || null,
            log: bundle.log || null,
            childJobs: Array.isArray(bundle.childJobs) ? bundle.childJobs : [],
            agentTrace: bundle.agentTrace || null
          }]
        }
      };
    }

    if (modelDirective.command.type === "compress") {
      if (!activeSession) {
        throw new Error("压缩上下文需要绑定 AI 会话，请使用格式：@ai #会话编号 /compress");
      }
      const summary = await compressAiSessionContext({
        appDataRoot: api.appDataRoot,
        session: activeSession,
        textModel: defaultTextModel,
        signal: api.signal
      });
      if (!summary) {
        const body = "当前会话消息数量不足（少于 4 条），无需压缩上下文。";
        return {
          result: {
            chatReply: await api.publishChatReply({
              text: body,
              card: { type: "ai-answer", status: "succeeded", title: "上下文压缩", subtitle: withSessionSubtitle("", activeSession), body }
            }),
            importedFiles: [],
            artifacts: [{ type: "compress-skipped", sessionId: activeSession.id }]
          }
        };
      }
      const body = `上下文已压缩，会话历史已替换为以下摘要：\n\n${summary}\n\n后续对话将基于此摘要继续。`;
      return {
        result: {
          chatReply: await api.publishChatReply({
            text: body,
            card: { type: "ai-answer", status: "succeeded", title: "上下文已压缩", subtitle: withSessionSubtitle("", activeSession), body }
          }),
          importedFiles: [],
          artifacts: [{ type: "compress-done", sessionId: activeSession.id }]
        }
      };
    }

    if (modelDirective.command.type === "list-models") {
      const filter = normalizeModelFilter(modelDirective.command.filter || "all");
      const refreshed = modelDirective.command.refresh === true;
      const result = await listAvailableModels({ signal: api.signal });
      const displayedModels = sortModelsForDisplay(filterModelsByCapability(result.models, filter));
      const nextSettings = {
        ...modelSettings,
        textModel: migrateStoredModelRef(modelSettings.textModel, result.models),
        multimodalModel: migrateStoredModelRef(modelSettings.multimodalModel, result.models),
        lastListedModels: displayedModels,
        lastListFilter: filter
      };
      await writeAiModelSettings(api.appDataRoot, nextSettings);
      const body = buildAvailableModelsText(displayedModels, nextSettings, filter);
      const providerBadges = buildProviderSummaryBadges(displayedModels);
      const modelChoices = buildAvailableModelChoices(displayedModels, nextSettings);
      return {
        result: {
          chatReply: await api.publishChatReply({
            text: refreshed ? `已刷新模型列表。\n\n${body}` : body,
            card: { type: "ai-answer", status: "succeeded", title: refreshed ? "AI 模型列表已刷新" : "AI 可用模型列表", subtitle: withSessionSubtitle(`${refreshed ? "刷新 · " : ""}${getModelFilterLabel(filter)} · 共 ${displayedModels.length} 个模型`, activeSession), body, badges: providerBadges, modelChoices }
          }),
          importedFiles: [],
          artifacts: [{ type: "model-list", count: displayedModels.length, filter, refreshed }]
        }
      };
    }

    if (modelDirective.command.type === "use-listed-model") {
      const listedModels = Array.isArray(modelSettings.lastListedModels) ? modelSettings.lastListedModels : [];
      const selectedIndex = Number(modelDirective.command.index || 0);
      if (!listedModels.length) {
        throw new Error("还没有可用的模型列表，请先执行 @ai /models、@ai /models tool-calls 或 @ai /models vision。");
      }
      if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > listedModels.length) {
        throw new Error(`列表序号超出范围，请输入 1 到 ${listedModels.length} 之间的数字。`);
      }
      const listedModel = listedModels[selectedIndex - 1];
      const selectedModel = await resolveModelForSettings(listedModel.id || listedModel.modelId || listedModel.name, modelSettings, api);
      const previousTextModel = String(modelSettings.textModel || "").trim() || getDefaultTextModelName() || "";
      const nextSettings = { ...modelSettings, textModel: selectedModel.id, multimodalModel: String(modelSettings.multimodalModel || "").trim() };
      const hasIndependentVisionModel = nextSettings.multimodalModel && nextSettings.multimodalModel !== previousTextModel;
      if (selectedModel.vision && !hasIndependentVisionModel) {
        nextSettings.multimodalModel = selectedModel.id;
      }
      await writeAiModelSettings(api.appDataRoot, nextSettings);
      const body = buildUseListedModelText(selectedModel, nextSettings, String(modelSettings.lastListFilter || "all").trim() || "all");
      return {
        result: {
          chatReply: await api.publishChatReply({
            text: body,
            card: { type: "ai-answer", status: "succeeded", title: "AI 默认模型已更新", subtitle: withSessionSubtitle(`${selectedIndex}. ${selectedModel.modelId || selectedModel.id}`, activeSession), body, badges: [createProviderBadge(selectedModel.provider, "当前")].filter(Boolean) }
          }),
          importedFiles: [],
          artifacts: [{ type: "model-settings-updated", textModel: nextSettings.textModel || "", multimodalModel: nextSettings.multimodalModel || "" }]
        }
      };
    }

    const nextSettings = {
      textModel: String(modelSettings.textModel || "").trim(),
      multimodalModel: String(modelSettings.multimodalModel || "").trim(),
      lastListedModels: Array.isArray(modelSettings.lastListedModels) ? modelSettings.lastListedModels : [],
      lastListFilter: String(modelSettings.lastListFilter || "all").trim() || "all"
    };
    if (modelDirective.command.type === "set") {
      const model = await resolveModelForSettings(modelDirective.command.model, modelSettings, api, "text");
      nextSettings.textModel = model.id;
    } else if (modelDirective.command.type === "set-vision") {
      const model = await resolveModelForSettings(modelDirective.command.model, modelSettings, api, "vision");
      nextSettings.multimodalModel = model.id;
    } else if (modelDirective.command.type === "set-all") {
      const model = await resolveModelForSettings(modelDirective.command.model, modelSettings, api, "all");
      nextSettings.textModel = model.id;
      nextSettings.multimodalModel = model.id;
    } else if (modelDirective.command.type === "reset") {
      nextSettings.textModel = "";
      nextSettings.multimodalModel = "";
    } else if (modelDirective.command.type === "reset-vision") {
      nextSettings.multimodalModel = "";
    }

    await writeAiModelSettings(api.appDataRoot, nextSettings);
    const usageText = buildModelUsageText(nextSettings);
    const badges = buildEffectiveProviderBadges(nextSettings);
    return {
      result: {
        chatReply: await api.publishChatReply({
          text: usageText,
          card: { type: "ai-answer", status: "succeeded", title: "AI 默认模型已更新", subtitle: withSessionSubtitle(`文本: ${getEffectiveTextModel(nextSettings) || "未配置"} · 看图: ${getEffectiveMultimodalModel(nextSettings) || "未配置"}`, activeSession), body: usageText, badges }
        }),
        importedFiles: [],
        artifacts: [{ type: "model-settings-updated", textModel: nextSettings.textModel || "", multimodalModel: nextSettings.multimodalModel || "" }]
      }
    };
  }

  throw new Error("AI chat graph reached command route without a command handler");
}
