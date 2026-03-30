import { getUserById } from "./db.js";

const CHAT_HISTORY_PREFIX = ".nas-chat-room/history";

function getDayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeCreatedAt(value = "") {
  const raw = String(value || "").trim();
  const timestamp = Date.parse(raw);
  if (Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  return new Date().toISOString();
}

function buildHistoryPath(dayKey = "") {
  return `${CHAT_HISTORY_PREFIX}/${String(dayKey || getDayKey()).trim() || getDayKey()}.jsonl`;
}

function sanitizeChatAttachments(rawAttachments, fallbackHostClientId = "") {
  return Array.isArray(rawAttachments)
    ? rawAttachments.slice(0, 6).map((item) => ({
        id: String(item?.id || `${item?.clientId || fallbackHostClientId}:${item?.path || ""}`).slice(0, 160),
        name: String(item?.name || "附件").slice(0, 200),
        mimeType: String(item?.mimeType || "application/octet-stream").slice(0, 120),
        size: Math.max(0, Number(item?.size || 0)),
        path: String(item?.path || "").slice(0, 500),
        clientId: String(item?.clientId || fallbackHostClientId || "").slice(0, 120),
        kind: String(item?.kind || "file").slice(0, 24)
      })).filter((item) => item.path && item.clientId)
    : [];
}

export function sanitizeMessageCard(rawCard) {
  const card = rawCard && typeof rawCard === "object" ? rawCard : null;
  if (!card) {
    return null;
  }
  const progress = Number.isFinite(card.progress) ? Math.max(0, Math.min(100, Number(card.progress))) : null;
  const actions = Array.isArray(card.actions)
    ? card.actions.slice(0, 6).map((action) => ({
        type: String(action?.type || "").slice(0, 32),
        label: String(action?.label || "").slice(0, 80),
        rawText: String(action?.rawText || "").slice(0, 500),
        botId: String(action?.botId || "").slice(0, 120),
        url: String(action?.url || "").slice(0, 500),
        attachmentId: String(action?.attachmentId || "").slice(0, 160),
        parsedArgs: action?.parsedArgs && typeof action.parsedArgs === "object" ? action.parsedArgs : null
      })).filter((action) => action.type && action.label)
    : [];
  const next = {
    type: String(card.type || "bot-status").slice(0, 32),
    status: String(card.status || "info").slice(0, 24),
    title: String(card.title || "").slice(0, 160),
    subtitle: String(card.subtitle || "").slice(0, 240),
    body: String(card.body || "").slice(0, 4000),
    progress,
    imageUrl: String(card.imageUrl || "").slice(0, 500),
    imageFit: String(card.imageFit || "cover").slice(0, 24),
    imageAlt: String(card.imageAlt || "").slice(0, 160),
    mediaAttachmentId: String(card.mediaAttachmentId || "").slice(0, 160),
    sourceLabel: String(card.sourceLabel || "").slice(0, 300),
    sourceUrl: String(card.sourceUrl || "").slice(0, 500),
    actions
  };
  if (!next.title && !next.body && !next.mediaAttachmentId && !next.imageUrl) {
    return null;
  }
  return next;
}

function sanitizeBotMetadata(rawBot) {
  const bot = rawBot && typeof rawBot === "object" ? rawBot : null;
  if (!bot) {
    return null;
  }
  return {
    botId: String(bot.botId || "").slice(0, 120),
    jobId: String(bot.jobId || "").slice(0, 120)
  };
}

function sanitizeAvatarResponse(user) {
  const rawAvatarUrl = String(user?.avatarUrl || "");
  const isInlineAvatar = /^data:/i.test(rawAvatarUrl);
  return {
    avatarUrl: isInlineAvatar ? "" : rawAvatarUrl,
    avatarClientId: user?.avatarClientId || "",
    avatarPath: user?.avatarPath || "",
    avatarFileId: user?.avatarFileId || ""
  };
}

export function buildChatAuthor(user) {
  const avatar = sanitizeAvatarResponse(user);
  return {
    id: user?.id || "",
    displayName: user?.displayName || "匿名用户",
    avatarUrl: avatar.avatarUrl,
    avatarClientId: avatar.avatarClientId,
    avatarPath: avatar.avatarPath,
    avatarFileId: avatar.avatarFileId
  };
}

function sanitizeSuppliedBotAuthor(author) {
  const payload = author && typeof author === "object" ? author : {};
  const id = String(payload.id || "").slice(0, 120);
  if (!id.startsWith("bot:")) {
    return null;
  }
  return {
    id,
    displayName: String(payload.displayName || "Bot").slice(0, 80),
    avatarUrl: "",
    avatarClientId: "",
    avatarPath: "",
    avatarFileId: ""
  };
}

function normalizeCommonMessageFields(payload, defaults = {}) {
  const createdAt = normalizeCreatedAt(payload?.createdAt || defaults.createdAt);
  const dayKey = String(payload?.dayKey || defaults.dayKey || getDayKey(createdAt)).slice(0, 32);
  return {
    id: String(payload?.id || defaults.id || "").slice(0, 120),
    text: String(payload?.text || defaults.text || "").slice(0, 4000),
    createdAt,
    dayKey,
    historyPath: String(payload?.historyPath || defaults.historyPath || buildHistoryPath(dayKey)).slice(0, 500),
    hostClientId: String(payload?.hostClientId || defaults.hostClientId || "").slice(0, 120)
  };
}

export function sanitizeUserChatPayload(rawPayload, principalId) {
  const user = getUserById(principalId);
  if (!user) {
    return null;
  }
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const message = {
    ...normalizeCommonMessageFields(payload),
    attachments: sanitizeChatAttachments(payload.attachments, String(payload?.hostClientId || "")),
    author: buildChatAuthor(user),
    card: sanitizeMessageCard(payload.card),
    bot: sanitizeBotMetadata(payload.bot)
  };
  if (!message.id || !message.createdAt) {
    return null;
  }
  if (!message.text && !message.attachments.length && !message.card) {
    return null;
  }
  return message;
}

export function sanitizeBotChatPayload(rawPayload, principalId) {
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const author = sanitizeSuppliedBotAuthor(payload.author);
  if (!author) {
    return null;
  }
  const message = {
    ...normalizeCommonMessageFields(payload, { hostClientId: principalId }),
    attachments: sanitizeChatAttachments(payload.attachments, String(payload?.hostClientId || principalId || "")),
    author,
    card: sanitizeMessageCard(payload.card),
    bot: sanitizeBotMetadata(payload.bot)
  };
  if (!message.id || !message.createdAt) {
    return null;
  }
  if (message.hostClientId && message.hostClientId !== principalId) {
    return null;
  }
  if (!message.hostClientId) {
    message.hostClientId = principalId;
  }
  if (!message.text && !message.attachments.length && !message.card) {
    return null;
  }
  return message;
}