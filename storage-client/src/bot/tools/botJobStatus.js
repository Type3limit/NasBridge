import fs from "node:fs";
import path from "node:path";
import { BotJobStore } from "../jobStore.js";
import { readExecutionPendingConfirmation, readExecutionSnapshot } from "../langgraph/checkpoints/aiSessionCheckpointer.js";

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
    events
  };
}
