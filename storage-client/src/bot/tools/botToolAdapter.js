const DEFAULT_WAIT_TIMEOUT_SECONDS = 120;
const DEFAULT_POLL_INTERVAL_MS = 3000;

function getHiddenDirectoryNames() {
  return [
    process.env.PREVIEW_CACHE_DIR_NAME || ".nas-preview-cache",
    process.env.HLS_CACHE_DIR_NAME || ".nas-hls-cache",
    process.env.AUDIO_STREAM_CACHE_DIR_NAME || ".nas-audio-stream-cache",
    process.env.PROFILE_AVATAR_DIR_NAME || ".nas-user-avatars",
    process.env.CHAT_ROOM_DIR_NAME || ".nas-chat-room",
    process.env.BOT_APP_DATA_DIR_NAME || ".nas-bot"
  ];
}

const DOWNLOAD_BOT_TOOL_CONFIGS = {
  invoke_bilibili_downloader: {
    name: "invoke_bilibili_downloader",
    botId: "bilibili.downloader",
    description: "委派 bilibili.downloader 下载 B 站视频或执行 Bilibili 登录/状态动作。下载前通常先用 search_bilibili_video 找到具体 source。",
    sourceKeys: ["source", "sourceUrl", "url", "bv"],
    sourceRequiredUnlessAction: true,
    sourcePattern: /^(?:https?:\/\/|BV[0-9A-Za-z]+)/i,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["download", "login", "relogin", "logout", "status"] },
        source: { type: "string", description: "Bilibili URL 或 BV 号" },
        url: { type: "string", description: "source 的别名" },
        targetFolder: { type: "string", description: "目标目录，相对于 storage root" },
        page: { type: "integer", minimum: 1 },
        quality: { type: "string", description: "例如 1080p、720p、4k、80、64" },
        waitForCompletion: { type: "boolean", description: "是否等待子任务完成，默认 false" },
        waitUntilPhase: { type: "string", description: "等待子任务 status/phase 到达指定值后返回，例如 running、download；不要求任务完成" },
        timeoutSeconds: { type: "integer", minimum: 5, maximum: 600 }
      }
    }
  },
  invoke_ytdlp_downloader: {
    name: "invoke_ytdlp_downloader",
    botId: "ytdlp.downloader",
    description: "委派 ytdlp.downloader 下载 YouTube、X/Twitter 等 yt-dlp 支持的视频页面，并自动入库。",
    sourceKeys: ["url", "source", "sourceUrl"],
    sourcePattern: /^https?:\/\//i,
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "视频页面 URL" },
        source: { type: "string", description: "url 的别名" },
        targetFolder: { type: "string", description: "目标目录，相对于 storage root" },
        quality: { type: "string", description: "例如 1080p、720p、最高" },
        waitForCompletion: { type: "boolean", description: "是否等待子任务完成，默认 false" },
        waitUntilPhase: { type: "string", description: "等待子任务 status/phase 到达指定值后返回，例如 running、download；不要求任务完成" },
        timeoutSeconds: { type: "integer", minimum: 5, maximum: 600 }
      }
    }
  },
  invoke_torrent_downloader: {
    name: "invoke_torrent_downloader",
    botId: "torrent.downloader",
    description: "委派 torrent.downloader 通过 webtorrent 下载 magnet:? 或 .torrent URL，并自动入库。",
    sourceKeys: ["source", "magnet", "url", "sourceUrl"],
    sourcePattern: /^(?:magnet:\?|https?:\/\/)/i,
    inputSchema: {
      type: "object",
      required: ["source"],
      properties: {
        source: { type: "string", description: "magnet:? 链接或 .torrent HTTP(S) URL" },
        magnet: { type: "string", description: "source 的别名" },
        url: { type: "string", description: "source 的别名" },
        targetFolder: { type: "string", description: "目标目录，相对于 storage root" },
        waitForCompletion: { type: "boolean", description: "是否等待子任务完成，默认 false" },
        waitUntilPhase: { type: "string", description: "等待子任务 status/phase 到达指定值后返回，例如 running、download；不要求任务完成" },
        timeoutSeconds: { type: "integer", minimum: 5, maximum: 600 }
      }
    }
  },
  invoke_aria2_downloader: {
    name: "invoke_aria2_downloader",
    botId: "aria2.downloader",
    description: "委派 aria2.downloader 下载 HTTP(S)、magnet:?、ed2k:// 或 .torrent URL，并自动入库。",
    sourceKeys: ["source", "url", "sourceUrl", "magnet", "ed2k"],
    sourcePattern: /^(?:https?:\/\/|magnet:\?|ed2k:\/\/)/i,
    inputSchema: {
      type: "object",
      required: ["source"],
      properties: {
        source: { type: "string", description: "HTTP(S)、magnet:?、ed2k:// 或 .torrent URL" },
        url: { type: "string", description: "source 的别名" },
        magnet: { type: "string", description: "source 的别名" },
        ed2k: { type: "string", description: "source 的别名" },
        targetFolder: { type: "string", description: "目标目录，相对于 storage root" },
        waitForCompletion: { type: "boolean", description: "是否等待子任务完成，默认 false" },
        waitUntilPhase: { type: "string", description: "等待子任务 status/phase 到达指定值后返回，例如 running、download；不要求任务完成" },
        timeoutSeconds: { type: "integer", minimum: 5, maximum: 600 }
      }
    }
  }
};

function clampInteger(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function normalizeString(value = "") {
  return String(value || "").trim();
}

function basenameFromRelativePath(value = "") {
  const parts = normalizeString(value).replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function compactImportedFile(file = {}, api = {}) {
  if (!file || typeof file !== "object") {
    return null;
  }
  const relativePath = normalizeString(file.relativePath || file.path).replace(/\\/g, "/").replace(/^\/+/, "");
  const fileName = normalizeString(file.fileName || file.name || basenameFromRelativePath(relativePath));
  if (!relativePath && !fileName) {
    return null;
  }
  const clientId = normalizeString(file.clientId || api.clientId);
  const fileId = normalizeString(file.fileId || file.id || (clientId && relativePath ? `${clientId}:${relativePath}` : ""));
  return {
    fileId,
    path: relativePath,
    name: fileName,
    size: Number.isFinite(Number(file.size)) ? Number(file.size) : 0,
    mimeType: normalizeString(file.mimeType)
  };
}

function compactImportedFiles(files = [], api = {}) {
  return (Array.isArray(files) ? files : [])
    .map((file) => compactImportedFile(file, api))
    .filter(Boolean)
    .slice(0, 20);
}

function sanitizeDelegatedResult(result = {}, api = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {};
  }
  const sanitized = { ...result };
  if (Array.isArray(result.importedFiles)) {
    sanitized.importedFiles = compactImportedFiles(result.importedFiles, api);
  }
  return sanitized;
}

function normalizeWaitUntilPhase(value = "") {
  return normalizeString(value).slice(0, 80);
}

export function normalizeTargetFolder(value = "") {
  const normalized = normalizeString(value).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  if (!normalized) {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  for (const segment of segments) {
    if (segment === "." || segment === ".." || /[<>:"|?*\x00-\x1f]/.test(segment)) {
      throw new Error("targetFolder contains an invalid path segment");
    }
  }
  if (getHiddenDirectoryNames().includes(segments[0])) {
    throw new Error("targetFolder points to a hidden/system NAS directory");
  }
  return segments.join("/");
}

function pickSource(input = {}, sourceKeys = []) {
  for (const key of sourceKeys) {
    const value = normalizeString(input[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function isActionWithoutSourceAllowed(config = {}, input = {}) {
  if (!config.sourceRequiredUnlessAction) {
    return false;
  }
  return ["login", "relogin", "logout", "status"].includes(normalizeString(input.action).toLowerCase());
}

function buildParsedArgs(config = {}, input = {}, source = "") {
  const parsedArgs = { ...input };
  delete parsedArgs.waitForCompletion;
  delete parsedArgs.waitUntilPhase;
  delete parsedArgs.timeoutSeconds;
  if (source) {
    parsedArgs.source = source;
    parsedArgs.sourceUrl = source;
    if (config.botId === "ytdlp.downloader") {
      parsedArgs.url = source;
    }
  }
  if (parsedArgs.targetFolder) {
    parsedArgs.targetFolder = normalizeTargetFolder(parsedArgs.targetFolder);
  }
  return parsedArgs;
}

async function waitForDelegatedJob(api = {}, jobId = "", options = {}) {
  if (!jobId) {
    throw new Error("delegated bot did not return a jobId");
  }
  if (typeof api.getJob !== "function") {
    throw new Error("api.getJob is unavailable; cannot wait for delegated job completion");
  }
  const timeoutMs = clampInteger(options.timeoutSeconds || DEFAULT_WAIT_TIMEOUT_SECONDS, 5, 600) * 1000;
  const pollIntervalMs = clampInteger(options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS, 500, 10_000);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    api.throwIfCancelled?.();
    const job = await api.getJob(jobId);
    if (!job) {
      throw new Error(`delegated job not found: ${jobId}`);
    }
    if (["succeeded", "failed", "cancelled", "expired"].includes(job.status)) {
      return job;
    }
    if (Date.now() > deadline) {
      throw new Error(`waiting for delegated job ${jobId} timed out`);
    }
    await new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        api.signal?.removeEventListener?.("abort", onAbort);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(Object.assign(new Error("job cancelled"), { name: "AbortError" }));
      };
      timer = setTimeout(finish, pollIntervalMs);
      if (api.signal?.aborted) {
        onAbort();
        return;
      }
      api.signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }
}

function buildDelegatedJobSnapshot(job = {}) {
  return {
    jobId: normalizeString(job?.jobId),
    botId: normalizeString(job?.botId),
    status: normalizeString(job?.status),
    phase: normalizeString(job?.phase),
    progress: job?.progress && typeof job.progress === "object"
      ? {
        label: normalizeString(job.progress.label),
        percent: Number.isFinite(Number(job.progress.percent)) ? Number(job.progress.percent) : null
      }
      : null,
    error: job?.error || null
  };
}

function jobMatchesWaitUntilPhase(job = {}, waitUntilPhase = "") {
  const target = normalizeWaitUntilPhase(waitUntilPhase).toLowerCase();
  if (!target) {
    return false;
  }
  return [
    job?.status,
    job?.phase,
    job?.progress?.phase,
    job?.progress?.label
  ].some((value) => normalizeString(value).toLowerCase() === target);
}

async function waitForDelegatedJobPhase(api = {}, jobId = "", options = {}) {
  const waitUntilPhase = normalizeWaitUntilPhase(options.waitUntilPhase);
  if (!waitUntilPhase) {
    return null;
  }
  if (!jobId) {
    throw new Error("delegated bot did not return a jobId");
  }
  if (typeof api.getJob !== "function") {
    throw new Error("api.getJob is unavailable; cannot wait for delegated job phase");
  }
  const timeoutMs = clampInteger(options.timeoutSeconds || DEFAULT_WAIT_TIMEOUT_SECONDS, 5, 600) * 1000;
  const pollIntervalMs = clampInteger(options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS, 500, 10_000);
  const deadline = Date.now() + timeoutMs;
  let lastJob = null;
  while (true) {
    api.throwIfCancelled?.();
    const job = await api.getJob(jobId);
    if (!job) {
      throw new Error(`delegated job not found: ${jobId}`);
    }
    lastJob = job;
    const reached = jobMatchesWaitUntilPhase(job, waitUntilPhase);
    const terminal = ["succeeded", "failed", "cancelled", "expired"].includes(normalizeString(job.status));
    if (reached || terminal) {
      return {
        targetPhase: waitUntilPhase,
        reached,
        timedOut: false,
        terminal,
        job
      };
    }
    if (Date.now() > deadline) {
      return {
        targetPhase: waitUntilPhase,
        reached: false,
        timedOut: true,
        terminal: false,
        job: lastJob
      };
    }
    await new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        api.signal?.removeEventListener?.("abort", onAbort);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(Object.assign(new Error("job cancelled"), { name: "AbortError" }));
      };
      timer = setTimeout(finish, pollIntervalMs);
      if (api.signal?.aborted) {
        onAbort();
        return;
      }
      api.signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }
}

function buildWaitUntilPhaseFields(waitResult = null) {
  if (!waitResult) {
    return {};
  }
  return {
    waitUntilPhase: waitResult.targetPhase,
    phaseReached: waitResult.reached === true,
    waitTimedOut: waitResult.timedOut === true,
    terminalBeforePhase: waitResult.terminal === true && waitResult.reached !== true,
    job: buildDelegatedJobSnapshot(waitResult.job || {})
  };
}

export function getDelegatedBotToolDefinitions() {
  return Object.values(DOWNLOAD_BOT_TOOL_CONFIGS).map((config) => ({
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema
  }));
}

export function isDelegatedBotToolName(name = "") {
  return Boolean(DOWNLOAD_BOT_TOOL_CONFIGS[normalizeString(name)]);
}

export function buildDelegatedJobFollowup({ jobId = "", botId = "", waitForCompletion = false, waitUntilPhase = "" } = {}) {
  const normalizedJobId = normalizeString(jobId);
  const normalizedBotId = normalizeString(botId);
  const normalizedWaitUntilPhase = normalizeWaitUntilPhase(waitUntilPhase);
  if (!normalizedJobId) {
    return {
      logHint: "delegated job did not return a jobId",
      nextAction: "委派任务没有返回 jobId；请检查 bot runtime 日志确认任务是否创建成功。",
      tracking: {
        available: false,
        botId: normalizedBotId
      }
    };
  }
  const statusCommand = `@ai /job ${normalizedJobId}`;
  const logCommand = `@ai /log ${normalizedJobId}`;
  const traceCommand = `@ai /trace ${normalizedJobId}`;
  return {
    logHint: `get_bot_job_status jobId=${normalizedJobId}；用户命令：${statusCommand} / ${logCommand} / ${traceCommand}`,
    nextAction: waitForCompletion
      ? "waited-for-completion"
      : (normalizedWaitUntilPhase
        ? `waited-until-phase:${normalizedWaitUntilPhase}`
        : `把 jobId=${normalizedJobId} 告诉用户；用户追问进度时调用 get_bot_job_status，或让用户运行 ${statusCommand}。`),
    tracking: {
      available: true,
      botId: normalizedBotId,
      jobId: normalizedJobId,
      statusCommand,
      logCommand,
      traceCommand,
      statusTool: "get_bot_job_status"
    }
  };
}

export async function executeDelegatedBotToolCall(toolName = "", api = {}, input = {}) {
  const config = DOWNLOAD_BOT_TOOL_CONFIGS[normalizeString(toolName)];
  if (!config) {
    throw new Error(`unknown delegated bot tool: ${toolName}`);
  }
  if (typeof api.invokeBot !== "function") {
    throw new Error("api.invokeBot is unavailable");
  }

  const source = pickSource(input, config.sourceKeys);
  if (!source && !isActionWithoutSourceAllowed(config, input)) {
    throw new Error(`${config.name} requires source/url`);
  }
  if (source && config.sourcePattern && !config.sourcePattern.test(source)) {
    throw new Error(`${config.name} received an unsupported source: ${source.slice(0, 80)}`);
  }

  const parsedArgs = buildParsedArgs(config, input, source);
  const rawText = source || normalizeString(input.action) || config.name;
  const delegatedJob = await api.invokeBot({
    botId: config.botId,
    trigger: {
      type: "tool-call",
      rawText,
      parsedArgs
    },
    options: {
      delegatedBy: api.botId || "ai.chat",
      parentJobId: api.jobId || "",
      toolName: config.name
    }
  });
  const jobId = normalizeString(delegatedJob?.jobId);
  const waitUntilPhase = normalizeWaitUntilPhase(input.waitUntilPhase);
  const base = {
    status: normalizeString(delegatedJob?.status) || "queued",
    phase: normalizeString(delegatedJob?.phase),
    delegated: true,
    botId: config.botId,
    jobId,
    input: {
      source: source || "",
      targetFolder: parsedArgs.targetFolder || "",
      quality: normalizeString(parsedArgs.quality),
      action: normalizeString(parsedArgs.action)
    },
    ...buildDelegatedJobFollowup({
      jobId,
      botId: config.botId,
      waitForCompletion: input.waitForCompletion === true,
      waitUntilPhase
    })
  };

  if (input.waitForCompletion === true) {
    const completedJob = await waitForDelegatedJob(api, jobId, {
      timeoutSeconds: input.timeoutSeconds
    });
    const sanitizedResult = sanitizeDelegatedResult(completedJob.result || {}, api);
    const importedFiles = compactImportedFiles(completedJob.result?.importedFiles, api);
    return {
      ...base,
      status: completedJob.status || base.status,
      result: sanitizedResult,
      importedFiles,
      files: importedFiles,
      importedFileCount: importedFiles.length,
      error: completedJob.error || null
    };
  }

  if (waitUntilPhase) {
    const waitResult = await waitForDelegatedJobPhase(api, jobId, {
      waitUntilPhase,
      timeoutSeconds: input.timeoutSeconds
    });
    return {
      ...base,
      status: normalizeString(waitResult?.job?.status) || base.status,
      phase: normalizeString(waitResult?.job?.phase) || base.phase,
      ...buildWaitUntilPhaseFields(waitResult)
    };
  }

  return base;
}
