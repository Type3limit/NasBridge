import fs from "node:fs";
import path from "node:path";

function compactString(value = "", maxLength = 160) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeProgressSnapshot(progress = null) {
  if (!progress || typeof progress !== "object") {
    return null;
  }
  const graphState = progress.graphState && typeof progress.graphState === "object"
    ? {
        activeNode: compactString(progress.graphState.activeNode, 80),
        agentPhase: compactString(progress.graphState.agentPhase, 80)
      }
    : null;
  return Object.fromEntries(Object.entries({
    label: compactString(progress.label, 120),
    percent: Number.isFinite(Number(progress.percent)) ? Math.max(0, Math.min(100, Number(progress.percent))) : null,
    graphState: graphState && (graphState.activeNode || graphState.agentPhase) ? graphState : null
  }).filter(([, value]) => {
    if (value === null || value === "" || value === undefined) {
      return false;
    }
    if (value && typeof value === "object") {
      return Object.values(value).some((item) => item !== null && item !== "" && item !== undefined);
    }
    return true;
  }));
}

function buildLifecycleSnapshot(job = {}) {
  return Object.fromEntries(Object.entries({
    botId: compactString(job.botId, 120),
    status: compactString(job.status, 80),
    phase: compactString(job.phase, 120),
    progress: normalizeProgressSnapshot(job.progress),
    startedAt: compactString(job.startedAt, 40),
    finishedAt: compactString(job.finishedAt, 40)
  }).filter(([, value]) => {
    if (value === null || value === "" || value === undefined) {
      return false;
    }
    if (value && typeof value === "object") {
      return Object.keys(value).length > 0;
    }
    return true;
  }));
}

function buildLifecycleLogLine(previous = null, next = {}) {
  const nextSnapshot = buildLifecycleSnapshot(next);
  if (!nextSnapshot.status && !nextSnapshot.phase) {
    return "";
  }
  if (previous) {
    const previousSnapshot = buildLifecycleSnapshot(previous);
    if (JSON.stringify(previousSnapshot) === JSON.stringify(nextSnapshot)) {
      return "";
    }
  }
  return `job-lifecycle ${JSON.stringify(nextSnapshot)}`;
}

export class BotJobStore {
  constructor(options = {}) {
    this.rootDir = path.resolve(options.rootDir || path.join(process.cwd(), ".nas-bot"));
    this.jobsDir = path.join(this.rootDir, "jobs");
    this.logsDir = path.join(this.rootDir, "logs");
    this.writeQueues = new Map();
    this.logQueues = new Map();
    this.jobCache = new Map();
  }

  async init() {
    await fs.promises.mkdir(this.jobsDir, { recursive: true });
    await fs.promises.mkdir(this.logsDir, { recursive: true });
  }

  getJobPath(jobId) {
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  getLogPath(jobId) {
    return path.join(this.logsDir, `${jobId}.log`);
  }

  async waitForPendingWrite(jobId) {
    const pending = this.writeQueues.get(jobId);
    if (!pending) {
      return;
    }
    try {
      await pending;
    } catch {
    }
  }

  async waitForPendingLog(jobId) {
    const pending = this.logQueues.get(jobId);
    if (!pending) {
      return;
    }
    try {
      await pending;
    } catch {
    }
  }

  async save(job) {
    if (!job?.jobId) {
      throw new Error("jobId is required");
    }
    await this.init();
    const previousJob = this.jobCache.get(job.jobId) || null;
    const next = {
      ...job,
      updatedAt: new Date().toISOString()
    };
    const jobPath = this.getJobPath(job.jobId);
    const tempPath = `${jobPath}.${process.pid}.${Date.now()}.tmp`;
    const previous = this.writeQueues.get(job.jobId) || Promise.resolve();
    const writeTask = previous.catch(() => {}).then(async () => {
      await fs.promises.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
      await fs.promises.rename(tempPath, jobPath);
    });
    const trackedTask = writeTask.finally(() => {
      if (this.writeQueues.get(job.jobId) === trackedTask) {
        this.writeQueues.delete(job.jobId);
      }
    });
    this.writeQueues.set(job.jobId, trackedTask);
    // Update in-memory cache immediately so callers (status events, WS broadcasts) are not
    // blocked by disk I/O — the write continues in the background via the serialized queue.
    this.jobCache.set(job.jobId, next);
    const lifecycleLine = buildLifecycleLogLine(previousJob, next);
    if (lifecycleLine) {
      this.appendLog(job.jobId, lifecycleLine).catch(() => {});
    }
    return next;
  }

  async get(jobId) {
    try {
      // Cache is always up-to-date after save() returns synchronously, so no need to wait
      // for pending disk writes before checking it.
      await this.waitForPendingWrite(jobId);
      const cached = this.jobCache.get(jobId);
      if (cached) {
        return cached;
      }
      const raw = await fs.promises.readFile(this.getJobPath(jobId), "utf-8");
      const parsed = JSON.parse(raw);
      this.jobCache.set(jobId, parsed);
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async appendLog(jobId, line) {
    await this.init();
    const text = `[${new Date().toISOString()}] ${String(line || "")}\n`;
    const previous = this.logQueues.get(jobId) || Promise.resolve();
    const appendTask = previous.catch(() => {}).then(() => fs.promises.appendFile(this.getLogPath(jobId), text, "utf-8"));
    const trackedTask = appendTask.finally(() => {
      if (this.logQueues.get(jobId) === trackedTask) {
        this.logQueues.delete(jobId);
      }
    });
    this.logQueues.set(jobId, trackedTask);
    await trackedTask;
  }

  async readLog(jobId, options = {}) {
    await this.init();
    await this.waitForPendingLog(jobId);
    const maxBytes = Math.max(1024, Math.min(Number(options.maxBytes || 64 * 1024), 512 * 1024));
    try {
      const content = await fs.promises.readFile(this.getLogPath(jobId), "utf-8");
      if (content.length <= maxBytes) {
        return {
          jobId,
          content,
          truncated: false
        };
      }
      return {
        jobId,
        content: content.slice(content.length - maxBytes),
        truncated: true
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          jobId,
          content: "",
          truncated: false
        };
      }
      throw error;
    }
  }
}
