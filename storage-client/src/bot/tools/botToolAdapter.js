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

function normalizeTargetFolder(value = "") {
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
  const base = {
    status: normalizeString(delegatedJob?.status) || "queued",
    delegated: true,
    botId: config.botId,
    jobId,
    input: {
      source: source || "",
      targetFolder: parsedArgs.targetFolder || "",
      quality: normalizeString(parsedArgs.quality),
      action: normalizeString(parsedArgs.action)
    },
    logHint: jobId ? `use get_bot_job_status with jobId=${jobId}` : "delegated job did not return a jobId",
    nextAction: input.waitForCompletion === true
      ? "waited-for-completion"
      : "return jobId to the user and call get_bot_job_status if they ask for progress"
  };

  if (input.waitForCompletion === true) {
    const completedJob = await waitForDelegatedJob(api, jobId, {
      timeoutSeconds: input.timeoutSeconds
    });
    return {
      ...base,
      status: completedJob.status || base.status,
      result: completedJob.result || {},
      error: completedJob.error || null
    };
  }

  return base;
}
