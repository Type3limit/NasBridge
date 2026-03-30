import path from "node:path";
import { buildInvocationContext, createBotChatMessage } from "./context.js";
import { createBotEventBus } from "./events.js";
import { BotJobStore } from "./jobStore.js";
import { BotJobQueue } from "./queue.js";
import { BotRegistry } from "./registry.js";
import { validatePluginPermissions } from "./permissions.js";

function formatErrorForLog(error) {
  if (!error) {
    return "unknown error";
  }
  const lines = [];
  const name = String(error?.name || "Error").trim();
  const message = String(error?.message || error || "unknown error").trim();
  lines.push(`${name}: ${message}`.trim());
  if (error?.code) {
    lines.push(`code: ${String(error.code).trim()}`);
  }
  if (error?.cause) {
    const causeMessage = String(error.cause?.message || error.cause || "").trim();
    if (causeMessage) {
      lines.push(`cause: ${causeMessage}`);
    }
  }
  if (error?.stack) {
    lines.push("stack:");
    lines.push(String(error.stack).trim());
  }
  return lines.join("\n");
}

function createInitialJob(context) {
  return {
    jobId: context.jobId,
    botId: context.botId,
    status: "queued",
    phase: "parse-input",
    progress: {
      label: "Queued",
      percent: 0,
      details: null
    },
    requester: context.requester,
    chat: context.chat,
    input: {
      triggerType: context.trigger.type,
      rawText: context.trigger.rawText,
      parsedArgs: context.trigger.parsedArgs
    },
    attachments: Array.isArray(context.attachments) ? context.attachments : [],
    options: context.options && typeof context.options === "object" ? context.options : {},
    result: {
      replyMessageId: "",
      importedFiles: [],
      artifacts: []
    },
    error: null,
    audit: {
      permissionsUsed: [],
      toolCalls: []
    },
    createdAt: context.createdAt,
    startedAt: null,
    finishedAt: null,
    updatedAt: context.createdAt
  };
}

function shouldForceReplaceChatMessage(context, plugin) {
  return String(plugin?.botId || "").trim() === "bilibili.downloader"
    && String(context?.trigger?.type || "").trim() === "card-action"
    && String(context?.chat?.messageId || "").trim() !== "";
}

export class BotRuntime {
  constructor(options = {}) {
    this.clientId = options.clientId || "";
    this.storageRoot = path.resolve(options.storageRoot || process.cwd());
    this.appDataRoot = path.resolve(options.appDataRoot || path.join(this.storageRoot, process.env.BOT_APP_DATA_DIR_NAME || ".nas-bot"));
    this.registry = options.registry || new BotRegistry().registerDefaults();
    this.queue = options.queue || new BotJobQueue({ concurrency: options.concurrency || 2 });
    this.store = options.store || new BotJobStore({ rootDir: this.appDataRoot });
    this.events = options.events || createBotEventBus();
    this.dependencies = options.dependencies || {};
    this.activeJobs = new Map();
    this.abortControllers = new Map();
    this.started = false;
  }

  async init() {
    await this.store.init();
    this.started = true;
    return this;
  }

  async dispose() {
    this.started = false;
  }

  getCatalog() {
    return this.registry.toPublicCatalog();
  }

  async getJob(jobId) {
    return this.activeJobs.get(jobId) || this.store.get(jobId);
  }

  async getJobLog(jobId, options = {}) {
    return this.store.readLog(jobId, options);
  }

  async cancelJob(jobId) {
    const job = this.activeJobs.get(jobId) || await this.store.get(jobId);
    if (!job) {
      return null;
    }
    if (["succeeded", "failed", "cancelled", "expired"].includes(job.status)) {
      return job;
    }
    const next = await this.store.save({
      ...job,
      status: "cancelled",
      phase: "cancelled",
      finishedAt: new Date().toISOString(),
      error: null
    });
    const controller = this.abortControllers.get(jobId);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error("job cancelled"));
    }
    this.activeJobs.set(jobId, next);
    this.events.emit("job", next);
    return next;
  }

  async invoke(rawPayload = {}) {
    if (!this.started) {
      await this.init();
    }
    const context = buildInvocationContext(rawPayload);
    if (!context.botId) {
      throw new Error("botId is required");
    }
    if (context.chat.hostClientId && this.clientId && context.chat.hostClientId !== this.clientId) {
      throw new Error("bot invocation hostClientId mismatch");
    }

    const plugin = this.registry.resolve(context.botId);
    if (!plugin) {
      throw new Error("bot not found");
    }
    context.botId = plugin.botId;
    if (shouldForceReplaceChatMessage(context, plugin)) {
      context.chat = {
        ...context.chat,
        replyMode: "replace-chat-message"
      };
    }

    const permissionCheck = validatePluginPermissions(plugin);
    const baseJob = await this.store.save(createInitialJob(context));
    this.activeJobs.set(baseJob.jobId, baseJob);
    // Fire the status event immediately so the WS broadcast goes out ASAP;
    // log append is non-critical and can happen in the background.
    this.events.emit("job", baseJob);
    this.store.appendLog(baseJob.jobId, `accepted by ${plugin.botId}`).catch(() => {});

    void this.queue.enqueue(async () => {
      await this.runJob(plugin, context, baseJob, permissionCheck);
    }, { jobId: baseJob.jobId, botId: plugin.botId }).catch(async (error) => {
      await this.failJob(baseJob.jobId, error);
    });

    return baseJob;
  }

  async runJob(plugin, context, job, permissionCheck) {
    const latest = this.activeJobs.get(job.jobId) || await this.store.get(job.jobId);
    if (latest?.status === "cancelled") {
      this.activeJobs.set(job.jobId, latest);
      this.events.emit("job", latest);
      return latest;
    }

    let current = await this.store.save({
      ...job,
      status: "running",
      phase: "running",
      progress: {
        label: "Running",
        percent: 5,
        details: job?.progress?.details ?? null
      },
      startedAt: new Date().toISOString(),
      audit: {
        ...job.audit,
        permissionsUsed: Object.entries(permissionCheck.permissions)
          .filter(([, value]) => value)
          .map(([name]) => name)
      }
    });
    this.activeJobs.set(current.jobId, current);
    this.events.emit("job", current);

    const abortController = new AbortController();
    this.abortControllers.set(current.jobId, abortController);
    const api = this.createPluginApi(plugin, context, current, abortController.signal);
    try {
      const result = await plugin.execute(context, api);
      current = await this.store.save({
        ...current,
        status: "succeeded",
        phase: "completed",
        progress: {
          label: "Completed",
          percent: 100,
          details: null
        },
        finishedAt: new Date().toISOString(),
        result: {
          replyMessageId: result?.chatReply?.id || "",
          importedFiles: Array.isArray(result?.importedFiles) ? result.importedFiles : [],
          artifacts: Array.isArray(result?.artifacts) ? result.artifacts : []
        }
      });
      this.activeJobs.set(current.jobId, current);
      this.events.emit("job", current);
      if (result?.chatReply) {
        this.events.emit("room-message", result.chatReply);
      }
      return current;
    } catch (error) {
      return this.failJob(current.jobId, error, current);
    } finally {
      this.abortControllers.delete(current.jobId);
    }
  }

  async failJob(jobId, error, currentJob = null) {
    const current = currentJob || this.activeJobs.get(jobId) || await this.store.get(jobId);
    if (!current) {
      return null;
    }
    if (current.status === "cancelled") {
      return current;
    }
    const next = await this.store.save({
      ...current,
      status: "failed",
      phase: "failed",
      finishedAt: new Date().toISOString(),
      error: {
        message: error?.message || String(error || "unknown error")
      }
    });
    this.activeJobs.set(jobId, next);
    this.events.emit("job", next);
    this.store.appendLog(jobId, `failed: ${next.error.message}`).catch(() => {});
    this.store.appendLog(jobId, `failure detail [phase=${String(current?.phase || "unknown")}]:\n${formatErrorForLog(error)}`).catch(() => {});
    return next;
  }

  createPluginApi(plugin, context, job, signal = null) {
    return {
      jobId: job.jobId,
      botId: plugin.botId,
      clientId: this.clientId,
      storageRoot: this.storageRoot,
      appDataRoot: this.appDataRoot,
      dependencies: this.dependencies,
      signal,
      isCancelled: () => Boolean(signal?.aborted),
      throwIfCancelled: () => {
        if (signal?.aborted) {
          throw Object.assign(new Error("job cancelled"), { name: "AbortError" });
        }
      },
      listBots: () => this.getCatalog(),
      getJob: (jobId) => this.getJob(jobId),
      invokeBot: async (payload = {}) => {
        const botId = String(payload.botId || "").trim();
        if (!botId) {
          throw new Error("botId is required");
        }
        if (botId === plugin.botId) {
          throw new Error("plugin cannot invoke itself");
        }
        return this.invoke({
          ...payload,
          requester: payload.requester || context.requester,
          chat: {
            ...context.chat,
            ...(payload.chat && typeof payload.chat === "object" ? payload.chat : {})
          },
          attachments: Array.isArray(payload.attachments) ? payload.attachments : context.attachments,
          createdAt: payload.createdAt || new Date().toISOString()
        });
      },
      emitProgress: async (patch = {}) => {
        const current = this.activeJobs.get(job.jobId) || await this.store.get(job.jobId);
        if (!current || current.status === "cancelled") {
          return current;
        }
        const next = await this.store.save({
          ...current,
          phase: String(patch.phase || current.phase || "running"),
          progress: {
            label: String(patch.label || current.progress?.label || "Running"),
            percent: Number.isFinite(patch.percent) ? Math.max(0, Math.min(100, Number(patch.percent))) : Number(current.progress?.percent || 0),
            details: Object.prototype.hasOwnProperty.call(patch, "details")
              ? (patch.details && typeof patch.details === "object" ? patch.details : null)
              : (current.progress?.details ?? null)
          }
        });
        this.activeJobs.set(job.jobId, next);
        this.events.emit("job", next);
        return next;
      },
      appendLog: (line) => this.store.appendLog(job.jobId, line),
      createChatReply: (payload = {}) => createBotChatMessage(plugin, {
        ...payload,
        jobId: job.jobId,
        dayKey: payload.dayKey || context.chat.dayKey,
        historyPath: payload.historyPath || context.chat.historyPath,
        hostClientId: payload.hostClientId || context.chat.hostClientId
      }),
      publishChatReply: async (payload = {}) => {
        const message = createBotChatMessage(plugin, {
          ...payload,
          jobId: job.jobId,
          dayKey: payload.dayKey || context.chat.dayKey,
          historyPath: payload.historyPath || context.chat.historyPath,
          hostClientId: payload.hostClientId || context.chat.hostClientId
        });
        // Broadcast via WS first so the browser sees the final reply immediately,
        // then write the JSONL history file in the background (fire-and-forget).
        if (typeof this.dependencies.publishChatMessage === "function") {
          await this.dependencies.publishChatMessage(message);
        }
        if (typeof this.dependencies.appendChatMessage === "function") {
          this.dependencies.appendChatMessage(message.historyPath, message).catch(() => {});
        }
        return message;
      },
      publishTransientChatReply: async (payload = {}) => {
        const message = createBotChatMessage(plugin, {
          ...payload,
          jobId: job.jobId,
          dayKey: payload.dayKey || context.chat.dayKey,
          historyPath: payload.historyPath || context.chat.historyPath,
          hostClientId: payload.hostClientId || context.chat.hostClientId
        });
        if (typeof this.dependencies.publishChatMessage === "function") {
          await this.dependencies.publishChatMessage(message);
        }
        return message;
      }
    };
  }

  async handleControlMessage(message = {}) {
    if (message.type === "get-bot-catalog") {
      return {
        type: "bot-catalog-result",
        requestId: message.requestId || "",
        bots: this.getCatalog()
      };
    }
    if (message.type === "invoke-bot") {
      const job = await this.invoke(message);
      return {
        type: "bot-job-accepted",
        requestId: message.requestId || "",
        job: {
          jobId: job.jobId,
          botId: job.botId,
          status: job.status
        }
      };
    }
    if (message.type === "get-bot-job") {
      const job = await this.getJob(message.jobId);
      return {
        type: "bot-job-result",
        requestId: message.requestId || "",
        job
      };
    }
    if (message.type === "get-bot-job-log") {
      const log = await this.getJobLog(message.jobId, { maxBytes: message.maxBytes });
      return {
        type: "bot-job-log-result",
        requestId: message.requestId || "",
        jobId: message.jobId || "",
        log
      };
    }
    if (message.type === "cancel-bot-job") {
      const job = await this.cancelJob(message.jobId);
      return {
        type: "bot-job-cancelled",
        requestId: message.requestId || "",
        jobId: message.jobId || "",
        status: job?.status || "missing"
      };
    }
    return null;
  }
}

export function createBotRuntime(options = {}) {
  return new BotRuntime(options);
}
