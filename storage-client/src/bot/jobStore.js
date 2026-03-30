import fs from "node:fs";
import path from "node:path";

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
