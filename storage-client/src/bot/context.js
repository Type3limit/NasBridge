import crypto from "node:crypto";

export function createJobId(prefix = "botjob") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

export function createBotJobMessageId(jobId = "") {
  return `bot-status:${String(jobId || "unknown")}`;
}

export function createBotAuthor(plugin) {
  return {
    id: `bot:${plugin?.botId || "unknown"}`,
    displayName: plugin?.displayName || plugin?.botId || "Bot",
    avatarUrl: "",
    avatarClientId: "",
    avatarPath: "",
    avatarFileId: ""
  };
}

export function createBotChatMessage(plugin, input = {}) {
  const createdAt = input.createdAt || new Date().toISOString();
  return {
    id: input.id || createBotJobMessageId(input.jobId) || `botmsg_${Date.now().toString(36)}`,
    text: String(input.text || "").trim(),
    createdAt,
    dayKey: String(input.dayKey || ""),
    historyPath: String(input.historyPath || ""),
    hostClientId: String(input.hostClientId || ""),
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    author: createBotAuthor(plugin),
    card: input.card && typeof input.card === "object" ? input.card : null,
    bot: {
      botId: plugin?.botId || "",
      jobId: String(input.jobId || "")
    }
  };
}

export function buildInvocationContext(payload = {}) {
  return {
    jobId: payload.jobId || createJobId(),
    botId: String(payload.botId || "").trim(),
    trigger: {
      type: String(payload.trigger?.type || "manual"),
      rawText: String(payload.trigger?.rawText || ""),
      parsedArgs: payload.trigger?.parsedArgs && typeof payload.trigger.parsedArgs === "object"
        ? payload.trigger.parsedArgs
        : {}
    },
    requester: {
      userId: String(payload.requester?.userId || ""),
      displayName: String(payload.requester?.displayName || ""),
      role: String(payload.requester?.role || "user")
    },
    chat: {
      hostClientId: String(payload.chat?.hostClientId || ""),
      dayKey: String(payload.chat?.dayKey || ""),
      historyPath: String(payload.chat?.historyPath || ""),
      messageId: String(payload.chat?.messageId || ""),
      replyMode: String(payload.chat?.replyMode || "append-chat-history")
    },
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
    options: payload.options && typeof payload.options === "object" ? payload.options : {},
    createdAt: payload.createdAt || new Date().toISOString()
  };
}
