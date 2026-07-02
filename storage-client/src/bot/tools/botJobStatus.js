import fs from "node:fs";
import path from "node:path";
import { BotJobStore } from "../jobStore.js";
import { readExecutionPendingConfirmation, readExecutionSnapshot } from "../langgraph/checkpoints/aiSessionCheckpointer.js";
import { resolveTextToolsRecoveryPolicy } from "../plugins/ai-chat/recovery.js";

export const MAX_JOB_STATUS_LIMIT = 12;
export const MAX_AGENT_TRACE_EVENTS = 80;
export const MAX_JOB_LOG_BYTES = 32 * 1024;
export const MAX_CHILD_JOB_SUMMARY_LIMIT = 20;

const SENSITIVE_KEY_PATTERN = /(?:key|token|secret|cookie|authorization|password|credential)/i;

function clampInteger(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function getGraphRoot(appDataRoot = "") {
  return path.join(String(appDataRoot || ""), "ai-chat-graph");
}

function getTracePath(appDataRoot = "", jobId = "") {
  return path.join(getGraphRoot(appDataRoot), "traces", `${String(jobId || "unknown").trim()}.jsonl`);
}

function getExecutionsDir(appDataRoot = "") {
  return path.join(getGraphRoot(appDataRoot), "executions");
}

function redactSensitiveText(value = "") {
  return String(value || "")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/((?:api[-_ ]?key|token|secret|cookie|authorization|password)\s*[:=]\s*)[^\s,;]+/gi, "$1***");
}

function redactValue(value, depth = 0) {
  if (depth > 6) {
    return "[truncated]";
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => redactValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return value ?? null;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = "***";
      continue;
    }
    result[key] = redactValue(item, depth + 1);
  }
  return result;
}

function summarizeJobResult(result = null) {
  if (!result || typeof result !== "object") {
    return null;
  }
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  return {
    replyMessageId: String(result.replyMessageId || result.chatReply?.id || "").trim(),
    importedFileCount: Array.isArray(result.importedFiles) ? result.importedFiles.length : 0,
    artifactTypes: [...new Set(artifacts.map((item) => String(item?.type || "").trim()).filter(Boolean))],
    artifactCount: artifacts.length,
    hasTags: Array.isArray(result.tags) && result.tags.length > 0,
    processed: Number.isFinite(result.processed) ? Number(result.processed) : null,
    skipped: Number.isFinite(result.skipped) ? Number(result.skipped) : null,
    total: Number.isFinite(result.total) ? Number(result.total) : null
  };
}

function summarizeJob(job = {}) {
  return {
    jobId: String(job.jobId || "").trim(),
    botId: String(job.botId || "").trim(),
    status: String(job.status || "").trim(),
    phase: String(job.phase || "").trim(),
    progress: job.progress && typeof job.progress === "object"
      ? {
          label: String(job.progress.label || "").trim(),
          percent: Number.isFinite(job.progress.percent) ? Number(job.progress.percent) : null,
          details: redactValue(job.progress.details ?? null),
          graphState: redactValue(job.progress.graphState ?? null)
        }
      : null,
    requester: {
      displayName: String(job.requester?.displayName || "").trim(),
      role: String(job.requester?.role || "").trim()
    },
    input: {
      triggerType: String(job.input?.triggerType || "").trim(),
      rawText: redactSensitiveText(job.input?.rawText || ""),
      parsedArgs: redactValue(job.input?.parsedArgs || {})
    },
    options: redactValue(job.options || {}),
    error: job.error
      ? {
          message: redactSensitiveText(job.error.message || job.error || "")
        }
      : null,
    result: summarizeJobResult(job.result),
    audit: {
      permissionsUsed: Array.isArray(job.audit?.permissionsUsed)
        ? job.audit.permissionsUsed.map((item) => String(item || "").trim()).filter(Boolean)
        : [],
      toolCallCount: Array.isArray(job.audit?.toolCalls) ? job.audit.toolCalls.length : 0
    },
    createdAt: String(job.createdAt || "").trim(),
    startedAt: String(job.startedAt || "").trim(),
    finishedAt: String(job.finishedAt || "").trim(),
    updatedAt: String(job.updatedAt || "").trim()
  };
}

function summarizeStatusCounts(jobs = []) {
  const counts = {};
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const status = String(job?.status || "unknown").trim() || "unknown";
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

async function readJsonFile(filePath = "") {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function listRecentJobIds(appDataRoot = "", limit = 5) {
  const jobsDir = path.join(String(appDataRoot || ""), "jobs");
  try {
    const entries = await fs.promises.readdir(jobsDir, { withFileTypes: true });
    const stats = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const absolutePath = path.join(jobsDir, entry.name);
      try {
        const stat = await fs.promises.stat(absolutePath);
        stats.push({
          jobId: entry.name.replace(/\.json$/i, ""),
          mtimeMs: stat.mtimeMs
        });
      } catch {
      }
    }
    return stats
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, limit)
      .map((item) => item.jobId);
  } catch {
    return [];
  }
}

async function listRecentTraceJobIds(appDataRoot = "", limit = 5) {
  try {
    const entries = await fs.promises.readdir(getExecutionsDir(appDataRoot), { withFileTypes: true });
    const stats = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const absolutePath = path.join(getExecutionsDir(appDataRoot), entry.name);
      try {
        const stat = await fs.promises.stat(absolutePath);
        stats.push({
          jobId: entry.name.replace(/\.json$/i, ""),
          mtimeMs: stat.mtimeMs
        });
      } catch {
      }
    }
    return stats
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, limit)
      .map((item) => item.jobId);
  } catch {
    return [];
  }
}

async function listChildJobIds(appDataRoot = "", parentJobId = "", limit = MAX_CHILD_JOB_SUMMARY_LIMIT) {
  const normalizedParentJobId = String(parentJobId || "").trim();
  if (!normalizedParentJobId) {
    return [];
  }
  const jobsDir = path.join(String(appDataRoot || ""), "jobs");
  try {
    const entries = await fs.promises.readdir(jobsDir, { withFileTypes: true });
    const matches = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const absolutePath = path.join(jobsDir, entry.name);
      const parsed = await readJsonFile(absolutePath);
      if (String(parsed?.options?.parentJobId || "").trim() !== normalizedParentJobId) {
        continue;
      }
      const stat = await fs.promises.stat(absolutePath).catch(() => null);
      matches.push({
        jobId: String(parsed?.jobId || entry.name.replace(/\.json$/i, "")).trim(),
        mtimeMs: stat?.mtimeMs || 0
      });
    }
    return matches
      .filter((item) => item.jobId)
      .sort((left, right) => left.mtimeMs - right.mtimeMs)
      .slice(0, clampInteger(limit, 1, MAX_CHILD_JOB_SUMMARY_LIMIT))
      .map((item) => item.jobId);
  } catch {
    return [];
  }
}

async function readTraceEvents(appDataRoot = "", jobId = "", maxEvents = MAX_AGENT_TRACE_EVENTS) {
  try {
    const raw = await fs.promises.readFile(getTracePath(appDataRoot, jobId), "utf8");
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.slice(-maxEvents).map((line) => {
      try {
        return redactValue(JSON.parse(line));
      } catch {
        return { kind: "raw", line: redactSensitiveText(line).slice(0, 800) };
      }
    });
  } catch {
    return [];
  }
}

export async function buildBotJobLogBundle(api = {}, input = {}) {
  const appDataRoot = String(api.appDataRoot || "").trim();
  if (!appDataRoot) {
    throw new Error("appDataRoot is required");
  }
  const jobId = String(input.jobId || "").trim();
  if (!jobId) {
    throw new Error("jobId is required");
  }
  const store = input.store instanceof BotJobStore ? input.store : new BotJobStore({ rootDir: appDataRoot });
  const logMaxBytes = clampInteger(input.maxBytes || input.logMaxBytes || 64 * 1024, 1024, 512 * 1024);
  const job = await readJob(api, store, jobId);
  const log = await store.readLog(jobId, { maxBytes: logMaxBytes });
  const childJobIds = input.includeChildJobs === true
    ? await listChildJobIds(appDataRoot, jobId, input.childJobLimit || MAX_CHILD_JOB_SUMMARY_LIMIT)
    : [];
  const childJobs = [];
  for (const childJobId of childJobIds) {
    const childJob = await readJob(api, store, childJobId);
    if (childJob) {
      childJobs.push(summarizeJob(childJob));
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    jobId,
    job: job ? summarizeJob(job) : null,
    log: {
      jobId,
      content: redactSensitiveText(log.content || ""),
      truncated: log.truncated === true
    },
    agentTrace: input.includeTrace === true
      ? await buildAgentTraceResult(api, { jobId, maxEvents: input.maxTraceEvents || 40 })
      : null,
    childJobs
  };
}

function summarizeTraceSnapshot(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  return {
    jobId: String(snapshot.jobId || "").trim(),
    botId: String(snapshot.botId || "").trim(),
    sessionId: snapshot.sessionId ?? null,
    status: String(snapshot.status || "").trim(),
    route: String(snapshot.route || "").trim(),
    savedAt: String(snapshot.savedAt || "").trim(),
    traceSummary: snapshot.traceSummary || null,
    result: {
      reply: snapshot.result?.reply || null,
      artifactSummary: snapshot.result?.artifactSummary || null
    },
    error: snapshot.error ? redactValue(snapshot.error) : null,
    recovery: {
      toolRound: Number.isInteger(snapshot.recoveryState?.toolRound) ? snapshot.recoveryState.toolRound : 0,
      pendingToolNames: Array.isArray(snapshot.recoveryState?.pendingToolNames) ? snapshot.recoveryState.pendingToolNames : [],
      pendingToolCalls: Array.isArray(snapshot.recoveryState?.pendingToolCalls) ? redactValue(snapshot.recoveryState.pendingToolCalls) : []
    }
  };
}

function compactTraceResultSummary(summary = null) {
  if (!summary || typeof summary !== "object") {
    return null;
  }
  return {
    status: String(summary.status || "").trim(),
    delegated: summary.delegated === true,
    botId: String(summary.botId || "").trim(),
    jobId: String(summary.jobId || "").trim(),
    jobRefs: Array.isArray(summary.jobRefs)
      ? summary.jobRefs.map((item) => ({
          jobId: String(item?.jobId || "").trim(),
          botId: String(item?.botId || "").trim(),
          status: String(item?.status || "").trim(),
          delegated: item?.delegated === true
        })).filter((item) => item.jobId).slice(0, 5)
      : [],
    requiresConfirmation: summary.requiresConfirmation === true,
    blocked: summary.blocked === true,
    blocker: summary.blocker && typeof summary.blocker === "object"
      ? {
          id: String(summary.blocker.id || "").trim(),
          status: String(summary.blocker.status || "").trim()
        }
      : null,
    nextAction: String(summary.nextAction || "").trim()
  };
}

function compactTraceAgentDetail(detail = null) {
  if (!detail || typeof detail !== "object") {
    return null;
  }
  const pendingTools = Array.isArray(detail.pendingTools)
    ? detail.pendingTools.map((item) => ({
        id: String(item?.id || "").trim(),
        name: String(item?.name || "").trim(),
        fallbackJsonPlan: item?.fallbackJsonPlan === true,
        reason: redactSensitiveText(String(item?.reason || "").trim()).slice(0, 180)
      })).filter((item) => item.name).slice(0, 8)
    : [];
  const summary = {
    model: String(detail.model || "").trim(),
    fallback: String(detail.fallback || "").trim(),
    finishReason: String(detail.finishReason || "").trim(),
    pendingTools,
    parseError: redactSensitiveText(String(detail.parseError || "").trim()).slice(0, 240),
    retryReason: redactSensitiveText(String(detail.retryReason || "").trim()).slice(0, 240),
    tool: String(detail.tool || "").trim(),
    observationLength: Number.isFinite(Number(detail.observationLength)) ? Number(detail.observationLength) : null
  };
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => {
    if (value === null || value === "") {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return true;
  }));
}

function buildTimelineLabel(event = {}) {
  const kind = String(event.kind || "").trim();
  if (kind === "tool") {
    const tool = String(event.tool || "").trim() || "tool";
    const status = String(event.status || "").trim();
    return status ? `${tool} (${status})` : tool;
  }
  if (kind === "agent") {
    const phase = String(event.phase || "").trim() || "agent";
    const status = String(event.status || "").trim();
    return status ? `${phase} (${status})` : phase;
  }
  if (kind === "node") {
    const node = String(event.node || "").trim() || "node";
    const action = String(event.event || "").trim();
    return action ? `${node}:${action}` : node;
  }
  return kind || "event";
}

function buildTraceTimeline(events = []) {
  return (Array.isArray(events) ? events : []).map((event, index) => ({
    index: index + 1,
    sequence: Number.isFinite(Number(event.sequence)) ? Number(event.sequence) : null,
    at: String(event.at || "").trim(),
    kind: String(event.kind || "").trim(),
    label: buildTimelineLabel(event),
    status: String(event.status || "").trim(),
    round: Number.isFinite(Number(event.round)) ? Number(event.round) : null,
    node: String(event.node || "").trim(),
    phase: String(event.phase || "").trim(),
    tool: String(event.tool || "").trim(),
    durationMs: Number.isFinite(Number(event.durationMs)) ? Number(event.durationMs) : null,
    detailSummary: String(event.kind || "").trim() === "agent" ? compactTraceAgentDetail(event.detail) : null,
    outputPreview: String(event.outputPreview || "").trim().slice(0, 300),
    inputSummary: event.inputSummary && typeof event.inputSummary === "object" ? redactValue(event.inputSummary) : null,
    resultSummary: compactTraceResultSummary(event.resultSummary),
    errorSummary: event.errorSummary && typeof event.errorSummary === "object"
      ? {
          name: String(event.errorSummary.name || "Error").trim(),
          message: redactSensitiveText(String(event.errorSummary.message || "").trim()).slice(0, 300)
        }
      : null
  })).filter((item) => item.kind || item.label);
}

function buildTraceToolStats(events = []) {
  const toolEvents = (Array.isArray(events) ? events : []).filter((event) => String(event.kind || "").trim() === "tool");
  const byTool = new Map();
  const statusCounts = {};
  let totalDurationMs = 0;
  let timedCallCount = 0;
  for (const event of toolEvents) {
    const tool = String(event.tool || "unknown").trim() || "unknown";
    const status = String(event.status || "unknown").trim() || "unknown";
    const durationMs = Number(event.durationMs);
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    if (!byTool.has(tool)) {
      byTool.set(tool, {
        tool,
        callCount: 0,
        statusCounts: {},
        totalDurationMs: 0,
        timedCallCount: 0,
        lastStatus: "",
        lastAt: "",
        jobRefs: []
      });
    }
    const item = byTool.get(tool);
    item.callCount += 1;
    item.statusCounts[status] = (item.statusCounts[status] || 0) + 1;
    item.lastStatus = status;
    item.lastAt = String(event.at || "").trim();
    if (Number.isFinite(durationMs)) {
      item.totalDurationMs += Math.max(0, durationMs);
      item.timedCallCount += 1;
      totalDurationMs += Math.max(0, durationMs);
      timedCallCount += 1;
    }
    for (const ref of Array.isArray(event.resultSummary?.jobRefs) ? event.resultSummary.jobRefs : []) {
      const jobId = String(ref?.jobId || "").trim();
      if (jobId && !item.jobRefs.some((existing) => existing.jobId === jobId)) {
        item.jobRefs.push({
          jobId,
          botId: String(ref?.botId || "").trim(),
          status: String(ref?.status || "").trim()
        });
      }
    }
  }
  const tools = [...byTool.values()].map((item) => ({
    ...item,
    averageDurationMs: item.timedCallCount ? Math.round(item.totalDurationMs / item.timedCallCount) : null,
    jobRefs: item.jobRefs.slice(0, 8)
  })).sort((left, right) => right.totalDurationMs - left.totalDurationMs || right.callCount - left.callCount);
  return {
    count: toolEvents.length,
    statusCounts,
    totalDurationMs,
    timedCallCount,
    averageDurationMs: timedCallCount ? Math.round(totalDurationMs / timedCallCount) : null,
    tools,
    slowestTools: tools.filter((item) => item.timedCallCount > 0).slice(0, 3)
  };
}

function getTraceRoundKey(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.max(0, Math.floor(numeric))) : "0";
}

function ensurePlanRound(rounds, roundValue) {
  const key = getTraceRoundKey(roundValue);
  if (!rounds.has(key)) {
    rounds.set(key, {
      round: Number(key),
      plans: [],
      observations: []
    });
  }
  return rounds.get(key);
}

function compactAgentPreview(value = "", limit = 280) {
  const text = redactSensitiveText(String(value || "").replace(/\s+/g, " ").trim());
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function buildTracePlanSummary(events = []) {
  const rounds = new Map();
  let count = 0;
  let latest = null;
  for (const event of Array.isArray(events) ? events : []) {
    if (String(event?.kind || "").trim() !== "agent") {
      continue;
    }
    const phase = String(event.phase || "").trim();
    if (phase !== "plan_next_step" && phase !== "observe_result") {
      continue;
    }
    count += 1;
    const round = ensurePlanRound(rounds, event.round);
    const detail = compactTraceAgentDetail(event.detail) || {};
    if (phase === "plan_next_step") {
      const plan = {
        status: String(event.status || "").trim(),
        model: detail.model || "",
        fallback: detail.fallback || "",
        finishReason: detail.finishReason || "",
        pendingTools: Array.isArray(detail.pendingTools) ? detail.pendingTools : [],
        parseError: detail.parseError || "",
        retryReason: detail.retryReason || "",
        outputPreview: compactAgentPreview(event.outputPreview || "")
      };
      round.plans.push(Object.fromEntries(Object.entries(plan).filter(([, value]) => {
        if (value === null || value === "") {
          return false;
        }
        if (Array.isArray(value)) {
          return value.length > 0;
        }
        return true;
      })));
      latest = { phase, round: round.round, status: plan.status, pendingTools: plan.pendingTools };
    } else {
      const observation = {
        status: String(event.status || "").trim(),
        tool: detail.tool || "",
        fallback: detail.fallback || "",
        observationLength: detail.observationLength ?? null,
        outputPreview: compactAgentPreview(event.outputPreview || "")
      };
      round.observations.push(Object.fromEntries(Object.entries(observation).filter(([, value]) => value !== null && value !== "")));
      latest = { phase, round: round.round, status: observation.status, tool: observation.tool };
    }
  }
  const normalizedRounds = [...rounds.values()].sort((left, right) => left.round - right.round);
  const lastPlan = [...normalizedRounds].reverse()
    .flatMap((round) => [...round.plans].reverse())
    .find(Boolean) || null;
  return {
    count,
    latest,
    pendingToolNames: Array.isArray(lastPlan?.pendingTools)
      ? lastPlan.pendingTools.map((item) => item.name).filter(Boolean)
      : [],
    rounds: normalizedRounds
  };
}

function buildTraceRecoveryHint(snapshot = null, pendingConfirmation = null) {
  if (pendingConfirmation?.tool) {
    const confirmation = pendingConfirmation.confirmation && typeof pendingConfirmation.confirmation === "object"
      ? pendingConfirmation.confirmation
      : {};
    const impact = confirmation.impact && typeof confirmation.impact === "object" ? confirmation.impact : {};
    return {
      mode: "awaiting-confirmation",
      route: "text",
      canContinueDirectly: false,
      requiresUserConfirmation: true,
      tool: String(pendingConfirmation.tool || "").trim(),
      riskLevel: String(confirmation.riskLevel || "unknown").trim(),
      targetFileCount: Number.isFinite(Number(impact.targetFileCount)) ? Number(impact.targetFileCount) : null,
      nextAction: `等待用户确认后继续执行 ${String(pendingConfirmation.tool || "工具").trim()}`
    };
  }

  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const status = String(snapshot.status || "unknown").trim() || "unknown";
  const route = String(snapshot.route || "unknown").trim() || "unknown";
  const lastNode = String(snapshot.traceSummary?.lastNode || "").trim();
  const base = {
    status,
    route,
    lastNode,
    canContinueDirectly: false,
    requiresUserConfirmation: false,
    nextAction: ""
  };

  if (lastNode === "textTools") {
    const retryPolicy = resolveTextToolsRecoveryPolicy(snapshot.recoveryState || null);
    if (retryPolicy.directRetryAllowed) {
      return {
        ...base,
        mode: "text-retry-tools",
        route: "textTools",
        canContinueDirectly: true,
        nextAction: `直接重试未完成的只读工具：${retryPolicy.retryableToolNames.join("、")}`,
        retryPolicy
      };
    }
    return {
      ...base,
      mode: "text-replan",
      route: "text",
      nextAction: retryPolicy.blockedRetryToolNames.length
        ? `重新规划，并避免直接重试这些工具：${retryPolicy.blockedRetryToolNames.join("、")}`
        : "重新规划文本链路。",
      retryPolicy
    };
  }

  if (lastNode === "visionBuild") {
    return {
      ...base,
      mode: "vision-require-attachment",
      route: "recovery",
      requiresAttachment: true,
      nextAction: "请用户重新上传图片后再继续。"
    };
  }

  if (lastNode === "textAnswer" || lastNode === "visionAnswer") {
    return {
      ...base,
      mode: "answer-rebuild",
      route: route === "vision" ? "vision" : "text",
      nextAction: "复用已有上下文并重建完整回答。"
    };
  }

  if (status === "cancelled") {
    return {
      ...base,
      mode: "cancelled-replan",
      nextAction: "按当前请求重新规划。"
    };
  }

  if (status === "failed") {
    return {
      ...base,
      mode: "failed-replan",
      nextAction: "结合失败节点重新规划。"
    };
  }

  return {
    ...base,
    mode: "resume-default",
    route: route === "vision" ? "vision" : "text",
    nextAction: "延续当前会话并重新组织上下文。"
  };
}

async function readJob(api = {}, store, jobId = "") {
  if (typeof api.getJob === "function") {
    const liveJob = await api.getJob(jobId);
    if (liveJob) {
      return liveJob;
    }
  }
  return store.get(jobId);
}

export async function buildBotJobStatusResult(api = {}, input = {}) {
  const appDataRoot = String(api.appDataRoot || "").trim();
  if (!appDataRoot) {
    throw new Error("appDataRoot is required");
  }
  const limit = clampInteger(input.limit || 5, 1, MAX_JOB_STATUS_LIMIT);
  const explicitJobIds = [
    ...(Array.isArray(input.jobIds) ? input.jobIds : []),
    input.jobId
  ].map((item) => String(item || "").trim()).filter(Boolean);
  const jobIds = explicitJobIds.length ? [...new Set(explicitJobIds)].slice(0, MAX_JOB_STATUS_LIMIT) : await listRecentJobIds(appDataRoot, limit);
  const store = input.store instanceof BotJobStore ? input.store : new BotJobStore({ rootDir: appDataRoot });
  const includeLog = input.includeLog === true;
  const includeTrace = input.includeTrace === true;
  const includeChildJobs = Object.prototype.hasOwnProperty.call(input, "includeChildJobs")
    ? input.includeChildJobs === true
    : explicitJobIds.length > 0;
  const childJobLimit = clampInteger(input.childJobLimit || MAX_CHILD_JOB_SUMMARY_LIMIT, 1, MAX_CHILD_JOB_SUMMARY_LIMIT);
  const logMaxBytes = clampInteger(input.logMaxBytes || 12_000, 1024, MAX_JOB_LOG_BYTES);
  const jobs = [];
  const missing = [];

  for (const jobId of jobIds) {
    const job = await readJob(api, store, jobId);
    if (!job) {
      missing.push(jobId);
      continue;
    }
    const summary = summarizeJob(job);
    if (includeLog) {
      const log = await store.readLog(jobId, { maxBytes: logMaxBytes });
      summary.logTail = {
        truncated: log.truncated === true,
        content: redactSensitiveText(log.content || "")
      };
    }
    if (includeTrace) {
      summary.agentTrace = await buildAgentTraceResult(api, { jobId, maxEvents: input.maxTraceEvents || 30 });
    }
    if (includeChildJobs) {
      const childJobIds = await listChildJobIds(appDataRoot, jobId, childJobLimit);
      const childJobs = [];
      for (const childJobId of childJobIds) {
        const childJob = await readJob(api, store, childJobId);
        if (childJob) {
          childJobs.push(summarizeJob(childJob));
        }
      }
      summary.childJobs = childJobs;
      summary.childJobCount = childJobs.length;
      summary.childJobStatusCounts = summarizeStatusCounts(childJobs);
    }
    jobs.push(summary);
  }

  return {
    generatedAt: new Date().toISOString(),
    recent: explicitJobIds.length === 0,
    count: jobs.length,
    missing,
    jobs
  };
}

export async function buildAgentTraceResult(api = {}, input = {}) {
  const appDataRoot = String(api.appDataRoot || "").trim();
  if (!appDataRoot) {
    throw new Error("appDataRoot is required");
  }
  const requestedJobId = String(input.jobId || "").trim();
  const jobId = requestedJobId || (await listRecentTraceJobIds(appDataRoot, 1))[0] || "";
  if (!jobId) {
    return {
      generatedAt: new Date().toISOString(),
      jobId: "",
      snapshot: null,
      events: [],
      timeline: [],
      planSummary: buildTracePlanSummary([]),
      toolStats: buildTraceToolStats([]),
      missing: true
    };
  }
  const snapshot = await readExecutionSnapshot(appDataRoot, jobId);
  const events = await readTraceEvents(appDataRoot, jobId, clampInteger(input.maxEvents || 40, 1, MAX_AGENT_TRACE_EVENTS));
  const pendingConfirmation = await readExecutionPendingConfirmation(appDataRoot, jobId);
  return {
    generatedAt: new Date().toISOString(),
    jobId,
    latest: !requestedJobId,
    missing: !snapshot && !events.length,
    snapshot: summarizeTraceSnapshot(snapshot),
    pendingConfirmation: pendingConfirmation ? redactValue(pendingConfirmation) : null,
    recoveryHint: buildTraceRecoveryHint(snapshot, pendingConfirmation),
    timeline: buildTraceTimeline(events),
    planSummary: buildTracePlanSummary(events),
    toolStats: buildTraceToolStats(events),
    events
  };
}
