import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge, Button, Caption1, Spinner, Subtitle1, Text } from "@fluentui/react-components";
import { ArrowClockwiseRegular, ArrowUploadRegular, CopyRegular, DismissRegular, ImageRegular, SendRegular, VideoRegular } from "@fluentui/react-icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import AvatarFace from "./AvatarFace";
import { useResolvedP2PAssetUrl } from "./p2pAsset";
import { InlineVideoPlayer } from "./VideoViewportSurface";
import { apiRequest, toWsUrl } from "../api";

const CHAT_ROOM_DIR_NAME = ".nas-chat-room";
const CHAT_HISTORY_PREFIX = `${CHAT_ROOM_DIR_NAME}/history`;
const CHAT_ASSET_PREFIX = `${CHAT_ROOM_DIR_NAME}/attachments`;
const CHAT_REALTIME_LIMIT_BYTES = 100 * 1024;
const CHAT_HISTORY_LOOKBACK_DAYS = 365;
const CHAT_MAX_QUEUED_ATTACHMENTS = 6;
const CHAT_COMPACT_WINDOW_MS = 5 * 60 * 1000;
const CHAT_LARGE_MEDIA_THRESHOLD_BYTES = 10 * 1024 * 1024;
const CHAT_CUSTOM_EMOJI_STORAGE_KEY = "nas-chat-custom-emojis";
const CHAT_RECENT_EMOJI_STORAGE_KEY = "nas-chat-recent-emojis";
const CHAT_CUSTOM_EMOJI_MAX_ITEMS = 24;
const CHAT_CUSTOM_EMOJI_MAX_BYTES = 350 * 1024;
const EMOJI_CATEGORIES = {
  recent: { label: "最近", emojis: [] },
  smileys: { label: "表情", emojis: ["😀", "😁", "😂", "🤣", "🙂", "😉", "😊", "🥹", "😍", "😘", "😎", "🤔", "😮", "😴", "😭", "😡", "🥳", "🤯", "😇", "🤡", "😬", "🙃", "😋", "🤤"] },
  gestures: { label: "手势", emojis: ["👍", "👎", "👏", "🙏", "💪", "👀", "🙌", "👌", "✌️", "🤝", "👋", "☝️", "🤟", "🫶", "✊", "🤞", "🫡", "🖐️"] },
  hearts: { label: "氛围", emojis: ["🎉", "🔥", "❤️", "💯", "✨", "🌟", "🎵", "🎯", "✅", "❌", "⚡", "💡", "🎁", "🚀", "☕", "🌈", "💤", "📌"] }
};
const DEFAULT_EMOJI_CATEGORY = "smileys";
const EMOJI_CATEGORY_ORDER = ["recent", "smileys", "gestures", "hearts"];

function parseChatBotInvocation(text = "") {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }
  const mentionMatch = raw.match(/(?:^|\s)@\s*(?<alias>ai|assistant|bili|bilibili)(?=\s|$)/i);
  if (!mentionMatch?.groups?.alias) {
    return null;
  }
  const alias = String(mentionMatch.groups.alias || "").toLowerCase();
  const afterMention = raw.slice(mentionMatch.index + mentionMatch[0].length).trim();
  if (alias === "ai" || alias === "assistant") {
    return {
      botId: "ai.chat",
      mention: mentionMatch[0].trim(),
      rawText: raw,
      supported: true,
      parsedArgs: {
        prompt: afterMention
      }
    };
  }
  const commandToken = String(afterMention.split(/\s+/)[0] || "").trim().toLowerCase();
  const action = new Map([
    ["login", "login"],
    ["登录", "login"],
    ["status", "status"],
    ["状态", "status"],
    ["logout", "logout"],
    ["退出", "logout"],
    ["relogin", "relogin"],
    ["重新登录", "relogin"]
  ]).get(commandToken);
  if (action) {
    return {
      botId: "bilibili.downloader",
      mention: mentionMatch[0].trim(),
      source: "",
      supported: true,
      rawText: raw,
      parsedArgs: {
        action
      }
    };
  }
  const sourceMatch = afterMention.match(/https?:\/\/\S+|\bBV[0-9A-Za-z]+\b/i);
  const source = String(sourceMatch?.[0] || "").trim();
  const supported = !source
    ? false
    : /^BV[0-9A-Za-z]+$/i.test(source)
      ? true
      : (() => {
          try {
            const url = new URL(source);
            const hostname = String(url.hostname || "").toLowerCase();
            return hostname === "b23.tv" || hostname === "www.bilibili.com" || hostname === "bilibili.com" || hostname.endsWith(".bilibili.com");
          } catch {
            return false;
          }
        })();
  return {
    botId: "bilibili.downloader",
    mention: mentionMatch[0].trim(),
    source,
    supported,
    rawText: raw,
    parsedArgs: {
      source
    }
  };
}

function getBotExampleCommands(bot) {
  const botId = String(bot?.botId || "").trim();
  if (botId === "ai.chat") {
    return [
      "@ai /new 工作会话",
      "@ai /sessions",
      "@ai /rename #123 新名字",
      "@ai /delete #123",
      "@ai #123 继续刚才的话题",
      "@ai /search 今天的 AI 新闻",
      "@ai /search --site=github react compiler",
      "@ai /models",
      "@ai /models tool-calls",
      "@ai /models vision",
      "@ai /model use 3",
      "@ai 总结最近聊天",
      "@ai 看图",
      "@ai /model set gpt-4.1",
      "@ai /model gpt-4.1 解释这段聊天",
      "@ai @bili BV1xx...",
      "@ai @music 点歌 晴天"
    ];
  }
  if (botId === "music.control") {
    return [
      "@music 状态",
      "@music 搜歌 夜曲",
      "@music 选第 2 首",
      "@music 点歌 晴天",
      "@music 暂停",
      "@music 下一曲",
      "@music /source qq"
    ];
  }
  if (botId === "bilibili.downloader") {
    return [
      "@bili login",
      "@bili status",
      "@bili logout",
      "@bili BV1xx...",
      "@bili https://www.bilibili.com/video/BV1xx...",
      "@bili https://www.bilibili.com/video/BV1xx... p=2",
      "@bili https://www.bilibili.com/video/BV1xx... p=2 quality=720p"
    ];
  }
  const alias = Array.isArray(bot?.aliases) && bot.aliases.length ? bot.aliases[0] : botId;
  return [`@${alias} `];
}

function getLocalizedBotMeta(bot = {}) {
  const botId = String(bot?.botId || "").trim();
  if (botId === "ai.chat") {
    return {
      displayName: "AI 助手",
      description: "结合聊天上下文回答问题、总结内容、看图分析，并可委派给其他助手。"
    };
  }
  if (botId === "music.control") {
    return {
      displayName: "音乐助手",
      description: "控制网页上的全局音乐播放器，支持搜歌、点歌、切歌、暂停和查看队列。"
    };
  }
  if (botId === "bilibili.downloader") {
    return {
      displayName: "Bilibili 下载助手",
      description: "根据 BV 号或视频链接下载 Bilibili 视频，并导入本地资源库。"
    };
  }
  return {
    displayName: String(bot?.displayName || bot?.botId || "助手").trim(),
    description: String(bot?.description || bot?.botId || "").trim()
  };
}

function buildBotMentionCandidates(botCatalog = []) {
  return (botCatalog || []).map((bot) => {
    const localized = getLocalizedBotMeta(bot);
    const aliases = (Array.isArray(bot?.aliases) && bot.aliases.length
      ? bot.aliases
      : [String(bot?.botId || "").split(".")[0] || String(bot?.botId || "")])
      .map((item) => String(item || "").trim().replace(/^@+/, "").toLowerCase())
      .filter(Boolean);
    const primaryAlias = aliases[0] || String(bot?.botId || "").trim().toLowerCase();
    return {
      key: String(bot?.botId || primaryAlias),
      alias: primaryAlias,
      aliases,
      botId: String(bot?.botId || "").trim(),
      displayName: localized.displayName,
      description: localized.description,
      kind: String(bot?.kind || "task").trim()
    };
  }).sort((left, right) => left.alias.localeCompare(right.alias, "zh-CN"));
}

function getBotMentionContext(text = "", cursor = 0) {
  const source = String(text || "");
  const safeCursor = Math.max(0, Math.min(Number(cursor || 0), source.length));
  const prefix = source.slice(0, safeCursor);
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) {
    return null;
  }
  return {
    query: String(match[1] || "").toLowerCase(),
    start: match.index + match[0].lastIndexOf("@"),
    end: safeCursor
  };
}

function MarkdownBlock({ text, className = "" }) {
  const value = String(text || "").trim();
  if (!value) {
    return null;
  }
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
    </div>
  );
}

function sanitizePathSegment(value = "") {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "asset";
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

function formatRelativeTime(value) {
  if (!value) return "刚刚";
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return "刚刚";
  const diff = Date.now() - ts;
  if (diff < 10_000) return "刚刚";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  return `${Math.floor(diff / 86_400_000)}天前`;
}

function formatElapsedTime(value, now = Date.now()) {
  if (!value) return "刚刚";
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return "刚刚";
  const diff = Math.max(0, now - ts);
  if (diff < 10_000) return "刚刚";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒`;
  if (diff < 3_600_000) {
    const minutes = Math.floor(diff / 60_000);
    const seconds = Math.floor((diff % 60_000) / 1000);
    return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分钟`;
  }
  if (diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`;
  }
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  return hours > 0 ? `${days}天${hours}小时` : `${days}天`;
}

function formatClockTime(value) {
  if (!value) return "--:--";
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return "--:--";
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDayKey(dayKey) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ""));
  if (!matched) {
    return null;
  }
  return new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
}

function shiftDayKey(dayKey, offsetDays) {
  const date = parseDayKey(dayKey);
  if (!date) {
    return "";
  }
  date.setDate(date.getDate() + offsetDays);
  return getDayKey(date);
}

function getHistoryPath(dayKey) {
  return `${CHAT_HISTORY_PREFIX}/${dayKey}.jsonl`;
}

function buildAttachmentPath(dayKey, userId, fileName, index) {
  return `${CHAT_ASSET_PREFIX}/${dayKey}/${sanitizePathSegment(userId)}/${Date.now()}-${index}-${sanitizePathSegment(fileName)}`;
}

function sanitizeUploadFileName(value, fallbackName = "") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[\\/]+/g, "_")
    .replace(/^\.+$/, "");
  return cleaned || String(fallbackName || "upload.bin");
}

function normalizeFolderPath(value) {
  return (value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function buildUploadTargetPath(basePath, fileName) {
  const cleanName = sanitizeUploadFileName(fileName, "upload.bin");
  return basePath ? `${basePath}/${cleanName}` : cleanName;
}

function isImageAttachment(attachment) {
  return String(attachment?.mimeType || "").startsWith("image/");
}

function isVideoAttachment(attachment) {
  return String(attachment?.mimeType || "").startsWith("video/");
}

function isSupportedQueuedFile(file) {
  return /^(image|video)\//i.test(String(file?.type || ""));
}

function isLargeChatMediaAttachment(attachment) {
  return (isImageAttachment(attachment) || isVideoAttachment(attachment)) && Number(attachment?.size || 0) >= CHAT_LARGE_MEDIA_THRESHOLD_BYTES;
}

function loadStoredCustomEmojis() {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(CHAT_CUSTOM_EMOJI_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item) => item?.id && item?.dataUrl && item?.mimeType).slice(0, CHAT_CUSTOM_EMOJI_MAX_ITEMS);
  } catch {
    return [];
  }
}

function saveStoredCustomEmojis(items) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(CHAT_CUSTOM_EMOJI_STORAGE_KEY, JSON.stringify(items.slice(0, CHAT_CUSTOM_EMOJI_MAX_ITEMS)));
  } catch {
  }
}

function loadRecentEmojis() {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(CHAT_RECENT_EMOJI_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }
    const allowed = new Set(Object.values(EMOJI_CATEGORIES).flatMap((item) => item.emojis));
    return parsed.filter((item) => allowed.has(item)).slice(0, 18);
  } catch {
    return [];
  }
}

function saveRecentEmojis(items) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(CHAT_RECENT_EMOJI_STORAGE_KEY, JSON.stringify(items.slice(0, 18)));
  } catch {
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取表情失败"));
    reader.readAsDataURL(file);
  });
}

async function dataUrlToFile(dataUrl, fileName, mimeType = "image/png") {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new File([blob], fileName, { type: mimeType || blob.type || "image/png" });
}

function createQueuedAsset(file, seed = "") {
  return {
    id: `${seed || Date.now().toString(36)}-${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    previewUrl: URL.createObjectURL(file),
    kind: String(file.type || "").startsWith("video/") ? "video" : "image",
    status: "queued",
    progress: 0,
    error: "",
    uploadedAttachment: null
  };
}

function revokeQueuedAssets(items = []) {
  for (const item of items) {
    if (!item?.previewUrl) {
      continue;
    }
    try {
      URL.revokeObjectURL(item.previewUrl);
    } catch {
    }
  }
}

function normalizeMessage(message) {
  const attachments = Array.isArray(message?.attachments)
    ? message.attachments.map((item) => ({
        id: String(item?.id || `${item?.clientId || ""}:${item?.path || ""}`),
        name: String(item?.name || "附件"),
        mimeType: String(item?.mimeType || "application/octet-stream"),
        size: Math.max(0, Number(item?.size || 0)),
        path: String(item?.path || ""),
        clientId: String(item?.clientId || message?.hostClientId || ""),
        kind: String(item?.kind || "file")
      })).filter((item) => item.path && item.clientId)
    : [];
  return {
    id: String(message?.id || ""),
    text: String(message?.text || ""),
    createdAt: String(message?.createdAt || new Date().toISOString()),
    dayKey: String(message?.dayKey || getDayKey(new Date(message?.createdAt || Date.now()))),
    historyPath: String(message?.historyPath || getHistoryPath(getDayKey(new Date(message?.createdAt || Date.now())))),
    hostClientId: String(message?.hostClientId || ""),
    attachments,
    card: message?.card && typeof message.card === "object"
      ? {
          type: String(message.card.type || ""),
          status: String(message.card.status || ""),
          title: String(message.card.title || ""),
          subtitle: String(message.card.subtitle || ""),
          body: String(message.card.body || ""),
          progress: Number.isFinite(message.card.progress) ? Math.max(0, Math.min(100, Number(message.card.progress))) : null,
          imageUrl: String(message.card.imageUrl || ""),
          imageFit: String(message.card.imageFit || "cover"),
          imageAlt: String(message.card.imageAlt || ""),
          mediaAttachmentId: String(message.card.mediaAttachmentId || ""),
          sourceLabel: String(message.card.sourceLabel || ""),
          sourceUrl: String(message.card.sourceUrl || ""),
          actions: Array.isArray(message.card.actions)
            ? message.card.actions.map((action) => ({
                type: String(action?.type || ""),
                label: String(action?.label || ""),
                rawText: String(action?.rawText || ""),
                botId: String(action?.botId || ""),
                url: String(action?.url || ""),
                attachmentId: String(action?.attachmentId || ""),
                parsedArgs: action?.parsedArgs && typeof action.parsedArgs === "object"
                  ? action.parsedArgs
                  : null
              })).filter((action) => action.type && action.label)
            : []
        }
      : null,
    bot: message?.bot && typeof message.bot === "object"
      ? {
          botId: String(message.bot.botId || ""),
          jobId: String(message.bot.jobId || "")
        }
      : null,
    author: {
      id: String(message?.author?.id || ""),
      displayName: String(message?.author?.displayName || "匿名用户"),
      avatarUrl: String(message?.author?.avatarUrl || ""),
      avatarClientId: String(message?.author?.avatarClientId || ""),
      avatarPath: String(message?.author?.avatarPath || ""),
      avatarFileId: String(message?.author?.avatarFileId || "")
    }
  };
}

function mergeMessages(existing, incoming) {
  const map = new Map();
  for (const item of existing || []) {
    if (item?.id) {
      map.set(item.id, normalizeMessage(item));
    }
  }
  for (const item of incoming || []) {
    if (item?.id) {
      map.set(item.id, normalizeMessage(item));
    }
  }
  return [...map.values()].sort((left, right) => {
    const leftTs = Date.parse(left.createdAt) || 0;
    const rightTs = Date.parse(right.createdAt) || 0;
    return leftTs - rightTs;
  });
}

function parseHistoryText(text) {
  if (!text) {
    return [];
  }
  const items = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        items.push(normalizeMessage(parsed));
      }
    } catch {
    }
  }
  return items;
}

function isMissingHistoryError(error) {
  const text = String(error?.message || error || "");
  return /enoent|not found|no such file/i.test(text);
}

function describeDay(dayKey) {
  const today = getDayKey();
  if (dayKey === today) {
    return "今天";
  }
  const yesterday = shiftDayKey(today, -1);
  if (dayKey === yesterday) {
    return "昨天";
  }
  return dayKey;
}

function canLoadOlder(dayKey) {
  const date = parseDayKey(dayKey);
  if (!date) {
    return false;
  }
  const diffDays = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  return diffDays < CHAT_HISTORY_LOOKBACK_DAYS;
}

function shouldCompactMessage(previous, current) {
  if (!previous || !current) {
    return false;
  }
  if (String(previous.dayKey || "") !== String(current.dayKey || "")) {
    return false;
  }
  if (String(previous.author?.id || "") !== String(current.author?.id || "")) {
    return false;
  }
  const previousTs = Date.parse(previous.createdAt || 0);
  const currentTs = Date.parse(current.createdAt || 0);
  if (!Number.isFinite(previousTs) || !Number.isFinite(currentTs)) {
    return false;
  }
  return currentTs >= previousTs && currentTs - previousTs <= CHAT_COMPACT_WINDOW_MS;
}

function summarizeMessage(message) {
  const text = String(message?.text || "").trim();
  const cardText = [message?.card?.title, message?.card?.body].filter(Boolean).join(" · ");
  const attachmentText = Array.isArray(message?.attachments) && message.attachments.length
    ? `附件: ${message.attachments.map((item) => item.name).join(", ")}`
    : "";
  if (text && attachmentText) {
    return `${text}\n${attachmentText}`;
  }
  return text || cardText || attachmentText || "[空消息]";
}

function buildQuoteBlock(messages = []) {
  return messages.map((message) => {
    const summary = summarizeMessage(message)
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n");
    return `> [${formatClockTime(message.createdAt)}] ${message.author.displayName}\n${summary}`;
  }).join("\n\n");
}

function buildForwardBlock(messages = []) {
  return [
    "转发消息",
    ...messages.map((message) => `- [${formatClockTime(message.createdAt)}] ${message.author.displayName}: ${summarizeMessage(message).replace(/\r?\n/g, " / ")}`)
  ].join("\n");
}

function useAttachmentThumbnail({ attachment, p2p, enabled = true }) {
  const [thumbnailUrl, setThumbnailUrl] = useState("");

  useEffect(() => {
    if (!enabled || !p2p || !attachment?.clientId || !attachment?.path) {
      setThumbnailUrl("");
      return undefined;
    }
    let cancelled = false;
    let objectUrl = "";
    p2p.thumbnailFile(attachment.clientId, attachment.path)
      .then((result) => {
        if (cancelled) {
          return;
        }
        objectUrl = URL.createObjectURL(result.blob);
        setThumbnailUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setThumbnailUrl("");
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
        }
      }
    };
  }, [attachment?.clientId, attachment?.id, attachment?.path, enabled, p2p]);

  return thumbnailUrl;
}

function ChatImageAttachmentPreview({ attachment, p2p, onOpenImage, onResolvedPreview }) {
  const largeAsset = isLargeChatMediaAttachment(attachment);
  const resolvedUrl = useResolvedP2PAssetUrl({
    clientId: largeAsset ? "" : attachment.clientId,
    path: largeAsset ? "" : attachment.path,
    fileId: largeAsset ? "" : attachment.id,
    p2p
  });
  const thumbnailUrl = useAttachmentThumbnail({ attachment, p2p, enabled: largeAsset });
  const displayUrl = largeAsset ? thumbnailUrl : resolvedUrl;

  useEffect(() => {
    if (!onResolvedPreview || !attachment?.id || !displayUrl) {
      return;
    }
    onResolvedPreview(attachment.id, displayUrl);
  }, [attachment?.id, displayUrl, onResolvedPreview]);

  return (
    <button
      type="button"
      className={`chatAttachmentTile image${largeAsset ? " deferred" : ""}`}
      onClick={() => {
        if (displayUrl) {
          onOpenImage?.(attachment.id);
        }
      }}
      disabled={!displayUrl}
    >
      {displayUrl ? <img src={displayUrl} alt={attachment.name} /> : <div className="chatAttachmentPlaceholder">载入图片中</div>}
      {largeAsset ? <span className="chatAttachmentHint">缩略图预览，点击查看原图</span> : null}
    </button>
  );
}

function ChatVideoAttachmentPreview({ attachment, p2p, onOpenVideo, onResolvedPreview }) {
  const largeAsset = isLargeChatMediaAttachment(attachment);
  const thumbnailUrl = useAttachmentThumbnail({ attachment, p2p, enabled: true });
  const resolvedUrl = useResolvedP2PAssetUrl({
    clientId: largeAsset ? "" : attachment?.clientId || "",
    path: largeAsset ? "" : attachment?.path || "",
    fileId: largeAsset ? "" : attachment?.id || "",
    p2p
  });

  useEffect(() => {
    if (!onResolvedPreview || !attachment?.id || !thumbnailUrl) {
      return;
    }
    onResolvedPreview(attachment.id, thumbnailUrl);
  }, [attachment?.id, onResolvedPreview, thumbnailUrl]);

  if (!largeAsset && resolvedUrl) {
    return (
      <InlineVideoPlayer
        src={resolvedUrl}
        poster={thumbnailUrl}
        name={attachment?.name || "视频附件"}
        className="chatMessageInlineVideo"
        hint="双击或点完整预览可进入完整播放器"
        onOpenExternal={() => onOpenVideo?.(attachment)}
      />
    );
  }

  return (
    <button type="button" className={`chatAttachmentTile video poster${isLargeChatMediaAttachment(attachment) ? " deferred" : ""}`} onClick={() => onOpenVideo?.(attachment)}>
      {thumbnailUrl ? <img src={thumbnailUrl} alt={attachment.name} /> : <div className="chatAttachmentPlaceholder">生成封面中</div>}
      <span className="chatAttachmentHint">{isLargeChatMediaAttachment(attachment) ? "封面图已缓存，点击加载 HLS" : "点击预览视频"}</span>
    </button>
  );
}

function ChatLightboxImageStage({ attachment, p2p }) {
  const resolvedUrl = useResolvedP2PAssetUrl({
    clientId: attachment?.clientId || "",
    path: attachment?.path || "",
    fileId: attachment?.id || "",
    p2p
  });

  if (!resolvedUrl) {
    return <div className="chatLightboxLoading">正在加载原图...</div>;
  }
  return <img src={resolvedUrl} alt={attachment?.name || "图片预览"} />;
}

function ChatQueuedPreview({ asset }) {
  if (asset.kind === "video") {
    return (
      <InlineVideoPlayer
        src={asset.previewUrl}
        name={asset.file.name}
        className="chatQueuedInlineVideo"
        hint="发送前可直接预览这个视频"
        preload="metadata"
      />
    );
  }
  return <img src={asset.previewUrl} alt={asset.file.name} />;
}

export default function ChatRoom({
  authToken,
  currentUser,
  clients,
  p2p,
  setMessage,
  getClientDisplayName,
  openMediaPreview,
  saveChatAttachmentToLibrary
}) {
  const onlineClients = useMemo(
    () => [...(clients || [])].filter((item) => item.status === "online").sort((left, right) => {
      const leftTs = Date.parse(left.createdAt || left.lastHeartbeatAt || 0) || 0;
      const rightTs = Date.parse(right.createdAt || right.lastHeartbeatAt || 0) || 0;
      return leftTs - rightTs || String(left.id || "").localeCompare(String(right.id || ""));
    }),
    [clients]
  );
  const hostClient = onlineClients[0] || null;
  const hostClientId = hostClient?.id || "";
  const todayKey = useMemo(() => getDayKey(), []);
  const [messages, setMessages] = useState([]);
  const [chatConnectionState, setChatConnectionState] = useState(() => (authToken ? "connecting" : "offline"));
  const [loadedDays, setLoadedDays] = useState([]);
  const [nextOlderDayKey, setNextOlderDayKey] = useState(shiftDayKey(todayKey, -1));
  const [hasOlderHistory, setHasOlderHistory] = useState(true);
  const [loadingToday, setLoadingToday] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [queuedFiles, setQueuedFiles] = useState([]);
  const [composerError, setComposerError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [resolvedImageUrls, setResolvedImageUrls] = useState({});
  const [activeLightboxImageId, setActiveLightboxImageId] = useState("");
  const [contextMenuState, setContextMenuState] = useState(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState([]);
  const [emojiPanelOpen, setEmojiPanelOpen] = useState(false);
  const [activeEmojiCategory, setActiveEmojiCategory] = useState(DEFAULT_EMOJI_CATEGORY);
  const [customEmojis, setCustomEmojis] = useState(() => loadStoredCustomEmojis());
  const [recentEmojis, setRecentEmojis] = useState(() => loadRecentEmojis());
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [saveToLibraryDraft, setSaveToLibraryDraft] = useState(null);
  const [savingToLibrary, setSavingToLibrary] = useState(false);
  const [botLogDialog, setBotLogDialog] = useState({
    open: false,
    title: "",
    content: "",
    loading: false,
    truncated: false,
    error: ""
  });
  const [emojiPopupStyle, setEmojiPopupStyle] = useState({});
  const [contextMenuStyle, setContextMenuStyle] = useState({});
  const [botTooltipOpen, setBotTooltipOpen] = useState(false);
  const [botTooltipStyle, setBotTooltipStyle] = useState({});
  const [botCatalog, setBotCatalog] = useState([]);
  const [loadingBotCatalog, setLoadingBotCatalog] = useState(false);
  const [composerCursor, setComposerCursor] = useState(0);
  const [botMentionStyle, setBotMentionStyle] = useState({});
  const [activeBotMentionIndex, setActiveBotMentionIndex] = useState(0);
  const [dismissedBotMentionKey, setDismissedBotMentionKey] = useState("");
  const [statusClock, setStatusClock] = useState(() => Date.now());
  const fileInputRef = useRef(null);
  const customEmojiInputRef = useRef(null);
  const composerInputRef = useRef(null);
  const composerInputWrapRef = useRef(null);
  const emojiTriggerRef = useRef(null);
  const emojiPopupRef = useRef(null);
  const botTriggerRef = useRef(null);
  const botTooltipRef = useRef(null);
  const botMentionRef = useRef(null);
  const botTooltipCloseTimerRef = useRef(null);
  const contextMenuRef = useRef(null);
  const listRef = useRef(null);
  const botLogCacheRef = useRef(new Map());
  const queuedFilesRef = useRef([]);
  const scrollRestoreRef = useRef(null);
  const pendingScrollModeRef = useRef("");
  const loadedDaySetRef = useRef(new Set());
  const chatSocketRef = useRef(null);

  const todayMessageCount = useMemo(
    () => messages.filter((item) => item.dayKey === todayKey).length,
    [messages, todayKey]
  );
  const botMentionCandidates = useMemo(() => buildBotMentionCandidates(botCatalog), [botCatalog]);
  const botMentionContext = useMemo(() => getBotMentionContext(draft, composerCursor), [draft, composerCursor]);
  const botMentionSuggestions = useMemo(() => {
    if (!botMentionContext || !hostClientId) {
      return [];
    }
    const query = botMentionContext.query;
    return botMentionCandidates
      .filter((item) => !query
        || item.alias.includes(query)
        || item.aliases.some((alias) => alias.includes(query))
        || item.displayName.toLowerCase().includes(query)
        || item.botId.toLowerCase().includes(query)
        || item.description.toLowerCase().includes(query))
      .slice(0, 6);
  }, [botMentionCandidates, botMentionContext, hostClientId]);
  const botMentionSessionKey = botMentionContext ? `${botMentionContext.start}:${botMentionContext.query}` : "";
  const botMentionOpen = Boolean(botMentionContext && botMentionSuggestions.length && !sending && dismissedBotMentionKey !== botMentionSessionKey);
  const selectedMessageIdSet = useMemo(() => new Set(selectedMessageIds), [selectedMessageIds]);
  const selectedMessages = useMemo(
    () => messages.filter((message) => selectedMessageIdSet.has(message.id)),
    [messages, selectedMessageIdSet]
  );
  const hasActiveBotStatusCard = useMemo(
    () => messages.some((message) => message?.card?.type === "bot-status" && ["queued", "running", "info"].includes(String(message?.card?.status || ""))),
    [messages]
  );

  useEffect(() => {
    queuedFilesRef.current = queuedFiles;
  }, [queuedFiles]);

  useEffect(() => {
    if (!hasActiveBotStatusCard) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setStatusClock(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasActiveBotStatusCard]);

  useEffect(() => {
    return () => revokeQueuedAssets(queuedFilesRef.current);
  }, []);

  useEffect(() => {
    return () => {
      const socket = chatSocketRef.current;
      chatSocketRef.current = null;
      try {
        socket?.close();
      } catch {
      }
    };
  }, []);

  useEffect(() => {
    saveStoredCustomEmojis(customEmojis);
  }, [customEmojis]);

  useEffect(() => {
    saveRecentEmojis(recentEmojis);
  }, [recentEmojis]);

  useEffect(() => {
    if (!queuedFiles.length) {
      setQueueExpanded(false);
    }
  }, [queuedFiles.length]);

  useLayoutEffect(() => {
    if (!emojiPanelOpen || !emojiTriggerRef.current || !emojiPopupRef.current || typeof window === "undefined") {
      return;
    }
    const updatePosition = () => {
      const rect = emojiTriggerRef.current?.getBoundingClientRect();
      const popupRect = emojiPopupRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const popupWidth = Math.min(Math.round(popupRect?.width || 388), window.innerWidth - 24);
      const popupHeight = Math.min(Math.round(popupRect?.height || 320), Math.min(Math.round(window.innerHeight * 0.52), 420));
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - popupWidth - 12));
      const preferredTop = rect.bottom + 8;
      const fallbackTop = rect.top - popupHeight - 8;
      const top = preferredTop + popupHeight <= window.innerHeight - 12
        ? preferredTop
        : Math.max(12, fallbackTop);
      setEmojiPopupStyle({
        position: "fixed",
        left: `${left}px`,
        top: `${top}px`,
        width: `${popupWidth}px`,
        maxHeight: `${popupHeight}px`
      });
    };
    requestAnimationFrame(updatePosition);
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [emojiPanelOpen, activeEmojiCategory, customEmojis.length, recentEmojis.length]);

  useLayoutEffect(() => {
    if (!botTooltipOpen || !botTriggerRef.current || !botTooltipRef.current || typeof window === "undefined") {
      return;
    }
    const updatePosition = () => {
      const rect = botTriggerRef.current?.getBoundingClientRect();
      const popupRect = botTooltipRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const popupWidth = Math.min(Math.round(popupRect?.width || 348), window.innerWidth - 24);
      const popupHeight = Math.min(Math.round(popupRect?.height || 292), Math.min(Math.round(window.innerHeight * 0.46), 360));
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - popupWidth - 12));
      const preferredTop = rect.bottom + 8;
      const fallbackTop = rect.top - popupHeight - 8;
      const top = preferredTop + popupHeight <= window.innerHeight - 12
        ? preferredTop
        : Math.max(12, fallbackTop);
      setBotTooltipStyle({
        position: "fixed",
        left: `${left}px`,
        top: `${top}px`,
        width: `${popupWidth}px`,
        maxHeight: `${popupHeight}px`
      });
    };
    requestAnimationFrame(updatePosition);
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [botTooltipOpen, botCatalog.length, loadingBotCatalog]);

  useLayoutEffect(() => {
    if (!botMentionOpen || !composerInputWrapRef.current || !botMentionRef.current || typeof window === "undefined") {
      return;
    }
    const updatePosition = () => {
      const rect = composerInputWrapRef.current?.getBoundingClientRect();
      const popupRect = botMentionRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const popupWidth = Math.min(Math.max(260, Math.round(popupRect?.width || 320)), window.innerWidth - 24);
      const popupHeight = Math.min(Math.round(popupRect?.height || 220), Math.min(Math.round(window.innerHeight * 0.34), 260));
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - popupWidth - 12));
      const preferredTop = rect.top - popupHeight - 8;
      const fallbackTop = rect.bottom + 8;
      const top = preferredTop >= 12
        ? preferredTop
        : Math.min(window.innerHeight - popupHeight - 12, fallbackTop);
      setBotMentionStyle({
        position: "fixed",
        left: `${left}px`,
        top: `${top}px`,
        width: `${popupWidth}px`,
        maxHeight: `${popupHeight}px`
      });
    };
    requestAnimationFrame(updatePosition);
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [botMentionOpen, botMentionSuggestions.length, queuedFiles.length]);

  useEffect(() => {
    if (!botMentionOpen) {
      setActiveBotMentionIndex(0);
      return;
    }
    setActiveBotMentionIndex((prev) => Math.max(0, Math.min(prev, botMentionSuggestions.length - 1)));
  }, [botMentionOpen, botMentionSuggestions.length]);

  useEffect(() => {
    if (!botMentionOpen || !botMentionRef.current || !botMentionSuggestions.length) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      const activeOption = botMentionRef.current?.querySelector(".chatBotMentionOption.active");
      activeOption?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [botMentionOpen, activeBotMentionIndex, botMentionSuggestions.length]);

  useEffect(() => {
    if (!botMentionSessionKey) {
      setDismissedBotMentionKey("");
      return;
    }
    if (dismissedBotMentionKey && dismissedBotMentionKey !== botMentionSessionKey) {
      setDismissedBotMentionKey("");
    }
  }, [botMentionSessionKey, dismissedBotMentionKey]);

  useLayoutEffect(() => {
    if (!contextMenuState || !contextMenuRef.current || typeof window === "undefined") {
      return;
    }
    const updatePosition = () => {
      const menuRect = contextMenuRef.current?.getBoundingClientRect();
      if (!menuRect) {
        return;
      }
      const preferredLeft = contextMenuState.x + 8;
      const fallbackLeft = contextMenuState.x - menuRect.width - 8;
      const preferredTop = contextMenuState.y + 8;
      const fallbackTop = contextMenuState.y - menuRect.height - 8;
      const left = preferredLeft + menuRect.width <= window.innerWidth - 12
        ? preferredLeft
        : Math.max(12, fallbackLeft);
      const top = preferredTop + menuRect.height <= window.innerHeight - 12
        ? preferredTop
        : Math.max(12, fallbackTop);
      setContextMenuStyle({ left: `${left}px`, top: `${top}px` });
    };
    requestAnimationFrame(updatePosition);
    updatePosition();
  }, [contextMenuState]);

  useEffect(() => {
    if (!contextMenuState && !activeLightboxImageId) {
      return undefined;
    }
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setContextMenuState(null);
        setActiveLightboxImageId("");
        return;
      }
      if (!activeLightboxImageId) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigateLightbox(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        navigateLightbox(1);
      }
    };
    const onPointerDown = () => setContextMenuState(null);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onPointerDown, true);
    };
  }, [activeLightboxImageId, contextMenuState]);

  useEffect(() => () => {
    if (botTooltipCloseTimerRef.current) {
      clearTimeout(botTooltipCloseTimerRef.current);
    }
  }, []);

  async function loadHistoryDay(dayKey) {
    if (!authToken || !dayKey) {
      return [];
    }
    const response = await apiRequest(`/api/chat/messages?dayKey=${encodeURIComponent(dayKey)}`, {
      token: authToken
    });
    const serverMessages = Array.isArray(response?.messages) ? response.messages.map((item) => normalizeMessage(item)) : [];
    if (serverMessages.length || !p2p || !hostClientId) {
      return serverMessages;
    }
    try {
      const legacyResult = await p2p.downloadFile(hostClientId, getHistoryPath(dayKey));
      const legacyText = await legacyResult.blob.text();
      const legacyMessages = parseHistoryText(legacyText);
      return legacyMessages.length ? legacyMessages : serverMessages;
    } catch (error) {
      if (!isMissingHistoryError(error)) {
        throw error;
      }
      return serverMessages;
    }
  }

  async function loadInitialHistory() {
    if (!authToken) {
      setMessages([]);
      setLoadedDays([]);
      loadedDaySetRef.current = new Set();
      setChatConnectionState("offline");
      return;
    }
    setLoadingToday(true);
    setComposerError("");
    try {
      let todayMessages = [];
      try {
        todayMessages = await loadHistoryDay(todayKey);
      } catch (error) {
        if (!isMissingHistoryError(error)) {
          throw error;
        }
      }
      loadedDaySetRef.current = new Set([todayKey]);
      setLoadedDays([todayKey]);
      setNextOlderDayKey(shiftDayKey(todayKey, -1));
      setHasOlderHistory(true);
      setMessages(mergeMessages([], todayMessages));
      pendingScrollModeRef.current = "bottom";
    } catch (error) {
      setComposerError(error?.message || "聊天室历史加载失败");
    } finally {
      setLoadingToday(false);
    }
  }

  useEffect(() => {
    loadInitialHistory();
  }, [authToken, todayKey]);

  useEffect(() => {
    if (!p2p || !hostClientId) {
      setBotCatalog([]);
      setLoadingBotCatalog(false);
      return;
    }
    let cancelled = false;
    setLoadingBotCatalog(true);
    p2p.getBotCatalog(hostClientId)
      .then((result) => {
        if (!cancelled) {
          setBotCatalog(Array.isArray(result?.bots) ? result.bots : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBotCatalog([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingBotCatalog(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hostClientId, p2p]);

  useEffect(() => {
    if (!authToken) {
      setChatConnectionState("offline");
      return undefined;
    }
    let active = true;
    let reconnectTimer = 0;
    let reconnectAttempts = 0;

    const connectChatSocket = () => {
      if (!active) {
        return;
      }
      setChatConnectionState("connecting");
      const socket = new WebSocket(toWsUrl(authToken, { channel: "chat" }));
      chatSocketRef.current = socket;

      socket.addEventListener("open", () => {
        reconnectAttempts = 0;
        if (active && chatSocketRef.current === socket) {
          setChatConnectionState("connected");
        }
      });

      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data || "{}"));
          if (message?.type === "chat-room-error") {
            setMessage?.(message.message || "聊天室消息发送失败", "error");
            return;
          }
          if (message?.type !== "chat-room-message" || !message.payload) {
            return;
          }
          const nextMessage = normalizeMessage(message.payload);
          const container = listRef.current;
          const nearBottom = !container || container.scrollHeight - container.scrollTop - container.clientHeight < 120;
          if (nearBottom || nextMessage.author.id === currentUser?.id) {
            pendingScrollModeRef.current = "bottom";
          }
          setMessages((prev) => mergeMessages(prev, [nextMessage]));
          if (nextMessage.dayKey && !loadedDaySetRef.current.has(nextMessage.dayKey)) {
            loadedDaySetRef.current.add(nextMessage.dayKey);
            setLoadedDays((prev) => [...prev, nextMessage.dayKey]);
          }
        } catch {
        }
      });

      socket.addEventListener("close", () => {
        if (!active || chatSocketRef.current !== socket) {
          return;
        }
        setChatConnectionState("connecting");
        reconnectAttempts += 1;
        const delay = Math.min(5000, 800 * reconnectAttempts);
        reconnectTimer = window.setTimeout(connectChatSocket, delay);
      });

      socket.addEventListener("error", () => {
        try {
          socket.close();
        } catch {
        }
      });
    };

    connectChatSocket();
    return () => {
      active = false;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      if (chatSocketRef.current) {
        try {
          chatSocketRef.current.close();
        } catch {
        }
        chatSocketRef.current = null;
      }
    };
  }, [authToken, currentUser?.id, setMessage]);

  useLayoutEffect(() => {
    const container = listRef.current;
    if (!container) {
      return;
    }
    if (scrollRestoreRef.current) {
      const snapshot = scrollRestoreRef.current;
      container.scrollTop = Math.max(0, container.scrollHeight - snapshot.height + snapshot.top);
      scrollRestoreRef.current = null;
      return;
    }
    if (pendingScrollModeRef.current === "bottom") {
      container.scrollTop = container.scrollHeight;
      pendingScrollModeRef.current = "";
    }
  }, [messages]);

  async function loadOlderHistory() {
    if (!authToken || loadingOlder || !hasOlderHistory || !nextOlderDayKey) {
      return;
    }
    setLoadingOlder(true);
    const container = listRef.current;
    if (container) {
      scrollRestoreRef.current = { height: container.scrollHeight, top: container.scrollTop };
    }
    try {
      let cursor = nextOlderDayKey;
      let foundAny = false;
      let attempts = 0;
      while (cursor && attempts < 7 && canLoadOlder(cursor)) {
        attempts += 1;
        let dayMessages = [];
        try {
          dayMessages = await loadHistoryDay(cursor);
        } catch (error) {
          if (!isMissingHistoryError(error)) {
            throw error;
          }
        }
        loadedDaySetRef.current.add(cursor);
        setLoadedDays((prev) => (prev.includes(cursor) ? prev : [...prev, cursor]));
        const nextCursor = shiftDayKey(cursor, -1);
        setNextOlderDayKey(nextCursor);
        cursor = nextCursor;
        if (dayMessages.length) {
          foundAny = true;
          setMessages((prev) => mergeMessages(dayMessages, prev));
          break;
        }
      }
      if (!cursor || !canLoadOlder(cursor)) {
        setHasOlderHistory(false);
      } else if (!foundAny && attempts >= 7) {
        setHasOlderHistory(true);
      }
    } catch (error) {
      setMessage?.(error?.message || "加载更早聊天记录失败", "error");
    } finally {
      setLoadingOlder(false);
    }
  }

  function handleScroll() {
    const container = listRef.current;
    if (!container || loadingOlder || !hasOlderHistory) {
      return;
    }
    if (container.scrollTop <= 72) {
      loadOlderHistory().catch(() => {});
    }
  }

  function enqueueFiles(fileList, source = "picker") {
    if (!hostClientId) {
      setComposerError("当前没有在线的存储终端，暂时无法发送图片或视频");
      return;
    }
    const selected = [...(fileList || [])].filter((file) => isSupportedQueuedFile(file));
    if (!selected.length) {
      if (source !== "silent") {
        setComposerError("仅支持图片或视频文件");
      }
      return;
    }
    setComposerError("");
    setQueuedFiles((prev) => {
      const remainingSlots = Math.max(0, CHAT_MAX_QUEUED_ATTACHMENTS - prev.length);
      const accepted = selected.slice(0, remainingSlots).map((file, index) => createQueuedAsset(file, `${source}-${index}`));
      if (!accepted.length) {
        revokeQueuedAssets(accepted);
        setComposerError(`最多只能暂存 ${CHAT_MAX_QUEUED_ATTACHMENTS} 个图片或视频附件`);
        return prev;
      }
      if (selected.length > remainingSlots) {
        setComposerError(`最多只能暂存 ${CHAT_MAX_QUEUED_ATTACHMENTS} 个图片或视频附件`);
      }
      return [...prev, ...accepted];
    });
  }

  function patchQueuedFile(assetId, updater) {
    setQueuedFiles((prev) => prev.map((item) => {
      if (item.id !== assetId) {
        return item;
      }
      const patch = typeof updater === "function" ? updater(item) : updater;
      return patch ? { ...item, ...patch } : item;
    }));
  }

  function handlePickFiles(event) {
    enqueueFiles(event.target.files || [], "picker");
    event.target.value = "";
  }

  function handlePaste(event) {
    const items = [...(event.clipboardData?.items || [])];
    const files = items
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean)
      .filter((file) => isSupportedQueuedFile(file));
    if (!files.length) {
      return;
    }
    event.preventDefault();
    enqueueFiles(files, "paste");
  }

  function handleComposerKeyDown(event) {
    if (botMentionOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveBotMentionIndex((prev) => (prev + 1) % botMentionSuggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveBotMentionIndex((prev) => (prev - 1 + botMentionSuggestions.length) % botMentionSuggestions.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedBotMentionKey(botMentionSessionKey);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        applyBotMentionSuggestion(botMentionSuggestions[activeBotMentionIndex]);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent?.isComposing) {
      return;
    }
    event.preventDefault();
    if (!sending) {
      handleSend();
    }
  }

  function handleDragEnter(event) {
    if ([...(event.dataTransfer?.items || [])].some((item) => item.kind === "file")) {
      event.preventDefault();
      setDragActive(true);
    }
  }

  function handleDragOver(event) {
    if ([...(event.dataTransfer?.items || [])].some((item) => item.kind === "file")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragActive(true);
    }
  }

  function handleDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setDragActive(false);
    }
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragActive(false);
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) {
      return;
    }
    enqueueFiles(files, "drop");
  }

  function removeQueuedFile(assetId) {
    setQueuedFiles((prev) => {
      const target = prev.find((item) => item.id === assetId);
      if (target) {
        revokeQueuedAssets([target]);
      }
      return prev.filter((item) => item.id !== assetId);
    });
  }

  function clearQueuedFiles() {
    setQueuedFiles((prev) => {
      revokeQueuedAssets(prev);
      return [];
    });
  }

  function retryQueuedFile(assetId) {
    patchQueuedFile(assetId, {
      status: "queued",
      progress: 0,
      error: ""
    });
    setComposerError("");
  }

  function retryFailedQueuedFiles() {
    setQueuedFiles((prev) => prev.map((item) => (
      item.status === "failed"
        ? { ...item, status: "queued", progress: 0, error: "" }
        : item
    )));
    setComposerError("");
  }

  function enterSelectionMode(messageId = "") {
    setSelectionMode(true);
    if (!messageId) {
      return;
    }
    setSelectedMessageIds((prev) => (prev.includes(messageId) ? prev : [...prev, messageId]));
  }

  function clearMessageSelection() {
    setSelectionMode(false);
    setSelectedMessageIds([]);
  }

  function toggleMessageSelection(messageId) {
    setSelectionMode(true);
    setSelectedMessageIds((prev) => (
      prev.includes(messageId)
        ? prev.filter((item) => item !== messageId)
        : [...prev, messageId]
    ));
  }

  function registerResolvedImage(attachmentId, resolvedUrl) {
    setResolvedImageUrls((prev) => (prev[attachmentId] === resolvedUrl ? prev : { ...prev, [attachmentId]: resolvedUrl }));
  }

  function openVideoAttachment(attachment) {
    if (!attachment?.clientId || !attachment?.path) {
      return;
    }
    setContextMenuState(null);
    setEmojiPanelOpen(false);
    openMediaPreview?.({
      name: attachment.name,
      path: attachment.path,
      clientId: attachment.clientId,
      mimeType: attachment.mimeType,
      size: attachment.size
    });
  }

  function getDisplayAttachments(message) {
    const hiddenIds = new Set();
    if (message?.card?.mediaAttachmentId) {
      hiddenIds.add(message.card.mediaAttachmentId);
    }
    return (message?.attachments || []).filter((attachment) => !hiddenIds.has(attachment.id));
  }

  function handleCardAction(message, action) {
    if (!action?.type) {
      return;
    }
    if (action.type === "invoke-bot") {
      const botId = String(action.botId || message?.bot?.botId || "").trim();
      const rawText = String(action.rawText || "").trim();
      const baseArgs = action?.parsedArgs && typeof action.parsedArgs === "object"
        ? action.parsedArgs
        : (rawText ? { prompt: rawText } : {});
      const parsedArgs = {
        ...(baseArgs && typeof baseArgs === "object" ? baseArgs : {}),
        __actionLabel: String(action.label || "").trim()
      };
      const replyMode = String(parsedArgs.__chatReplyMode || "append-chat-history").trim() || "append-chat-history";
      if (!botId || !message?.hostClientId || !p2p) {
        setMessage?.("当前动作无法执行", "warning");
        return;
      }
      p2p.invokeBot(message.hostClientId, {
        botId,
        trigger: {
          type: "card-action",
          rawText,
          parsedArgs
        },
        requester: {
          userId: String(currentUser?.id || ""),
          displayName: String(currentUser?.displayName || ""),
          role: String(currentUser?.role || "user")
        },
        chat: {
          hostClientId: message.hostClientId,
          dayKey: message.dayKey,
          historyPath: message.historyPath,
          messageId: message.id,
          replyMode
        }
      })
        .then((invoked) => {
          if (invoked?.job?.jobId) {
            setMessage?.(`已执行 ${action.label}，任务 ${invoked.job.jobId.slice(0, 12)} 已创建`, "success");
          }
        })
        .catch((error) => {
          setMessage?.(error?.message || "动作执行失败", "error");
        });
      return;
    }
    if (action.type === "retry-bot-job") {
      const jobId = String(message?.bot?.jobId || "").trim();
      if (!jobId || !message?.hostClientId || !p2p) {
        setMessage?.("当前任务无法重新生成", "warning");
        return;
      }
      p2p.getBotJob(message.hostClientId, jobId)
        .then((result) => {
          const job = result?.job;
          if (!job?.botId) {
            throw new Error("找不到原始任务上下文");
          }
          return p2p.invokeBot(message.hostClientId, {
            botId: job.botId,
            trigger: {
              type: String(job?.input?.triggerType || "manual"),
              rawText: String(job?.input?.rawText || ""),
              parsedArgs: job?.input?.parsedArgs && typeof job.input.parsedArgs === "object" ? job.input.parsedArgs : {}
            },
            requester: {
              userId: String(job?.requester?.userId || ""),
              displayName: String(job?.requester?.displayName || ""),
              role: String(job?.requester?.role || "user")
            },
            chat: job?.chat && typeof job.chat === "object"
              ? job.chat
              : {
                hostClientId: message.hostClientId,
                dayKey: message.dayKey,
                historyPath: message.historyPath,
                messageId: "",
                replyMode: "append-chat-history"
              },
            attachments: Array.isArray(job?.attachments) ? job.attachments : [],
            options: job?.options && typeof job.options === "object" ? job.options : {}
          });
        })
        .then((invoked) => {
          if (invoked?.job?.jobId) {
            setMessage?.(`已重新提交任务 ${invoked.job.jobId.slice(0, 12)}`, "success");
          }
        })
        .catch((error) => {
          setMessage?.(error?.message || "重新生成失败", "error");
        });
      return;
    }
    if (action.type === "cancel-bot-job") {
      const jobId = String(message?.bot?.jobId || "").trim();
      if (!jobId || !message?.hostClientId || !p2p) {
        setMessage?.("当前任务无法取消", "warning");
        return;
      }
      p2p.cancelBotJob(message.hostClientId, jobId)
        .then(() => {
          setMessage?.("已请求停止生成", "success");
        })
        .catch((error) => {
          setMessage?.(error?.message || "停止生成失败", "error");
        });
      return;
    }
    if (action.type === "open-bot-log") {
      openBotLogDialog(message).catch((error) => {
        setMessage?.(error?.message || "读取日志失败", "error");
      });
      return;
    }
    if (action.type === "open-url" && action.url) {
      window.open(action.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (action.type === "open-attachment" && action.attachmentId) {
      const attachment = (message?.attachments || []).find((item) => item.id === action.attachmentId);
      if (!attachment) {
        setMessage?.("资源尚未准备好", "warning");
        return;
      }
      if (isVideoAttachment(attachment)) {
        openVideoAttachment(attachment);
        return;
      }
      if (isImageAttachment(attachment)) {
        openLightbox(attachment.id);
        return;
      }
      setMessage?.("当前资源暂不支持直接预览", "warning");
    }
  }

  function shouldRenderStandaloneMessageText(message) {
    const text = String(message?.text || "").trim();
    if (!text) {
      return false;
    }
    const cardBody = String(message?.card?.body || "").trim();
    return !cardBody || cardBody !== text;
  }

  function getAiChatStatusBody(message, cardStatus) {
    const rawBody = String(message?.card?.body || "").trim();
    const normalized = rawBody.toLowerCase();
    if (rawBody && normalized !== "running" && normalized !== "queued" && normalized !== "processing") {
      return rawBody;
    }
    if (cardStatus === "queued") {
      return "AI 已收到请求，正在排队。";
    }
    return "AI 正在处理这条消息。可以点“查看日志”了解当前步骤。";
  }

  function renderMessageCardBody(message) {
    if (!message?.card) {
      return null;
    }
    const mediaAttachment = message.card.mediaAttachmentId
      ? message.attachments.find((attachment) => attachment.id === message.card.mediaAttachmentId)
      : null;
    const cardStatus = String(message.card.status || "");
    const isAiChatStatusCard = message.card.type === "bot-status"
      && String(message?.bot?.botId || "").trim() === "ai.chat";
    const isActiveBotStatusCard = message.card.type === "bot-status"
      && ["queued", "running", "info"].includes(cardStatus);
    const elapsedText = isActiveBotStatusCard
      ? `${cardStatus === "queued" ? "已等待" : "已耗时"} ${formatElapsedTime(message.createdAt, statusClock)}`
      : "";
    const showProgress = typeof message.card.progress === "number"
      && !isAiChatStatusCard
      && !["succeeded", "failed", "cancelled"].includes(cardStatus);
    const cardBody = isAiChatStatusCard ? getAiChatStatusBody(message, cardStatus) : String(message.card.body || "").trim();
    const cardActions = Array.isArray(message.card.actions) ? [...message.card.actions] : [];
    if (isAiChatStatusCard && String(message?.bot?.jobId || "").trim() && !cardActions.some((action) => action?.type === "open-bot-log")) {
      cardActions.push({ type: "open-bot-log", label: "查看日志" });
    }
    return (
      <div className={`chatDynamicCard status-${cardStatus || "info"}`}>
        {message.card.imageUrl ? <img className={`chatDynamicCardCover fit-${String(message.card.imageFit || "cover")}`} src={message.card.imageUrl} alt={message.card.imageAlt || message.card.title || "封面"} referrerPolicy="no-referrer" /> : null}
        <div className="chatDynamicCardHeader">
          <div className="chatDynamicCardTitleBlock">
            <div className="chatDynamicCardTitleRow">
              <span className={`chatDynamicStatusDot status-${cardStatus || "info"}`} aria-hidden="true" />
              <Text>{message.card.title || message.author.displayName}</Text>
            </div>
            {message.card.subtitle ? <Caption1>{message.card.subtitle}</Caption1> : null}
            {cardBody ? <MarkdownBlock className="chatMarkdownBlock chatDynamicMarkdown" text={cardBody} /> : null}
          </div>
        </div>
        {isActiveBotStatusCard ? (
          <div className="chatDynamicMetaRow">
            <Caption1>{elapsedText}</Caption1>
            {typeof message.card.progress === "number" && !isAiChatStatusCard ? <Caption1>{Math.round(message.card.progress)}%</Caption1> : null}
          </div>
        ) : null}
        {showProgress ? (
          <div className="chatDynamicProgress">
            <div className="chatDynamicProgressBar">
              <div className="chatDynamicProgressValue" style={{ width: `${Math.max(0, Math.min(100, message.card.progress))}%` }} />
            </div>
            {!isActiveBotStatusCard ? <Caption1>{Math.round(message.card.progress)}%</Caption1> : null}
          </div>
        ) : null}
        {mediaAttachment && isVideoAttachment(mediaAttachment) ? (
          <div className="chatDynamicMediaStage">
            <ChatVideoAttachmentPreview
              attachment={mediaAttachment}
              p2p={p2p}
              onOpenVideo={openVideoAttachment}
              onResolvedPreview={registerResolvedImage}
            />
          </div>
        ) : null}
        {cardActions.length ? (
          <div className="chatDynamicActionRow">
            {cardActions.map((action) => (
              <button key={`${message.id}:${action.type}:${action.label}`} type="button" className="chatDynamicActionButton" onClick={() => handleCardAction(message, action)}>
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function isCompletedAiChatBotMessage(message) {
    if (String(message?.bot?.botId || "").trim() !== "ai.chat") {
      return false;
    }
    if (!String(message?.bot?.jobId || "").trim()) {
      return false;
    }
    const status = String(message?.card?.status || "succeeded").trim().toLowerCase();
    return !["queued", "running", "info"].includes(status);
  }

  async function openBotLogDialog(message) {
    const jobId = String(message?.bot?.jobId || "").trim();
    const clientId = String(message?.hostClientId || "").trim();
    if (!jobId || !clientId || !p2p) {
      setMessage?.("当前消息没有可读取的日志", "warning");
      return;
    }
    const cacheKey = `${clientId}:${jobId}`;
    const cached = botLogCacheRef.current.get(cacheKey);
    setBotLogDialog({
      open: true,
      title: `AI Chat 日志 · ${jobId.slice(0, 12)}`,
      content: cached?.content || "",
      loading: !cached,
      truncated: Boolean(cached?.truncated),
      error: ""
    });
    if (cached) {
      return;
    }
    try {
      const result = await p2p.getBotJobLog(clientId, jobId, { maxBytes: 96 * 1024 });
      const next = {
        content: String(result?.log?.content || "").trim() || "暂无日志内容",
        truncated: result?.log?.truncated === true
      };
      botLogCacheRef.current.set(cacheKey, next);
      setBotLogDialog({
        open: true,
        title: `AI Chat 日志 · ${jobId.slice(0, 12)}`,
        content: next.content,
        loading: false,
        truncated: next.truncated,
        error: ""
      });
    } catch (error) {
      setBotLogDialog({
        open: true,
        title: `AI Chat 日志 · ${jobId.slice(0, 12)}`,
        content: "",
        loading: false,
        truncated: false,
        error: String(error?.message || "读取日志失败").trim()
      });
    }
  }

  function closeBotLogDialog() {
    setBotLogDialog((prev) => ({ ...prev, open: false }));
  }

  async function copyTextToClipboard(value, successMessage) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage?.(successMessage || "已复制", "success");
    } catch (error) {
      setMessage?.(error?.message || "复制失败", "error");
    }
  }

  function buildMessageClipboardText(message) {
    const lines = [];
    if (message?.author?.displayName) {
      lines.push(message.author.displayName);
    }
    if (message?.createdAt) {
      lines.push(message.createdAt);
    }
    if (message?.text) {
      lines.push(message.text);
    }
    if (Array.isArray(message?.attachments) && message.attachments.length) {
      lines.push(`附件: ${message.attachments.map((item) => item.name).join(", ")}`);
    }
    return lines.join("\n");
  }

  function insertQuoteIntoDraft(messagesToQuote) {
    if (!messagesToQuote?.length) {
      return;
    }
    const quoteBlock = buildQuoteBlock(messagesToQuote);
    setDraft((prev) => (prev.trim() ? `${quoteBlock}\n\n${prev}` : `${quoteBlock}\n`));
    setSelectionMode(false);
    setSelectedMessageIds([]);
    setContextMenuState(null);
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }

  async function handleCustomEmojiUpload(event) {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (!files.length) {
      return;
    }
    const nextItems = [];
    for (const file of files) {
      if (!/^image\//i.test(String(file.type || ""))) {
        setMessage?.("自定义表情仅支持图片文件", "error");
        continue;
      }
      if (file.size > CHAT_CUSTOM_EMOJI_MAX_BYTES) {
        setMessage?.(`表情 ${file.name} 超过 ${formatBytes(CHAT_CUSTOM_EMOJI_MAX_BYTES)}，请压缩后再上传`, "error");
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        nextItems.push({
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          dataUrl,
          mimeType: file.type || "image/png"
        });
      } catch (error) {
        setMessage?.(error?.message || `读取表情 ${file.name} 失败`, "error");
      }
    }
    if (!nextItems.length) {
      return;
    }
    setCustomEmojis((prev) => [...nextItems, ...prev].slice(0, CHAT_CUSTOM_EMOJI_MAX_ITEMS));
    setMessage?.(`已添加 ${nextItems.length} 个自定义表情`, "success");
  }

  async function addImageAttachmentToCustomEmoji(attachment) {
    if (!p2p || !attachment?.clientId || !attachment?.path || !isImageAttachment(attachment)) {
      setMessage?.("当前图片无法加入自定义表情", "error");
      return;
    }
    try {
      let result;
      if (Number(attachment.size || 0) > CHAT_CUSTOM_EMOJI_MAX_BYTES) {
        result = await p2p.previewImageCompressed(attachment.clientId, attachment.path);
      } else {
        result = await p2p.downloadFile(attachment.clientId, attachment.path);
      }
      let blob = result?.blob;
      let mimeType = result?.meta?.mimeType || blob?.type || attachment.mimeType || "image/png";
      if (!blob) {
        throw new Error("读取图片失败");
      }
      if (blob.size > CHAT_CUSTOM_EMOJI_MAX_BYTES) {
        const thumb = await p2p.thumbnailFile(attachment.clientId, attachment.path);
        blob = thumb?.blob || blob;
        mimeType = thumb?.meta?.mimeType || mimeType;
      }
      if (blob.size > CHAT_CUSTOM_EMOJI_MAX_BYTES) {
        throw new Error(`图片仍超过 ${formatBytes(CHAT_CUSTOM_EMOJI_MAX_BYTES)}，无法作为表情保存`);
      }
      const dataUrl = await readFileAsDataUrl(new File([blob], attachment.name || "emoji.png", { type: mimeType }));
      setCustomEmojis((prev) => [
        {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name: attachment.name || "聊天图片表情",
          dataUrl,
          mimeType
        },
        ...prev
      ].slice(0, CHAT_CUSTOM_EMOJI_MAX_ITEMS));
      setMessage?.("已加入自定义表情", "success");
    } catch (error) {
      setMessage?.(error?.message || "加入自定义表情失败", "error");
    }
  }

  function removeCustomEmoji(emojiId) {
    setCustomEmojis((prev) => prev.filter((item) => item.id !== emojiId));
  }

  function insertTextAtComposerCursor(value) {
    const input = composerInputRef.current;
    const nextValue = String(value || "");
    if (!input) {
      setDraft((prev) => `${prev}${nextValue}`);
      return;
    }
    const start = Number.isFinite(input.selectionStart) ? input.selectionStart : draft.length;
    const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : draft.length;
    const updated = `${draft.slice(0, start)}${nextValue}${draft.slice(end)}`;
    setDraft(updated);
    requestAnimationFrame(() => {
      input.focus();
      const caret = start + nextValue.length;
      input.setSelectionRange(caret, caret);
    });
  }

  function handleEmojiPick(emojiChar) {
    setEmojiPanelOpen(false);
    setRecentEmojis((prev) => [emojiChar, ...prev.filter((item) => item !== emojiChar)].slice(0, 18));
    insertTextAtComposerCursor(emojiChar);
  }

  async function sendCustomEmoji(emojiItem) {
    try {
      const file = await dataUrlToFile(emojiItem.dataUrl, emojiItem.name, emojiItem.mimeType);
      if (draft.trim() || queuedFiles.length) {
        enqueueFiles([file], "emoji");
        setEmojiPanelOpen(false);
        requestAnimationFrame(() => composerInputRef.current?.focus());
        return;
      }
      const queuedAsset = createQueuedAsset(file, "emoji-send");
      try {
        await sendChatMessage({
          textOverride: "",
          queuedAssets: [queuedAsset],
          clearDraftOnSuccess: false,
          clearQueueOnSuccess: false,
          successMessage: "已发送自定义表情"
        });
      } finally {
        revokeQueuedAssets([queuedAsset]);
      }
      setEmojiPanelOpen(false);
    } catch (error) {
      setMessage?.(error?.message || "发送表情失败", "error");
    }
  }

  async function copySelectedMessages() {
    if (!selectedMessages.length) {
      return;
    }
    await copyTextToClipboard(selectedMessages.map((message) => buildMessageClipboardText(message)).join("\n\n"), `已复制 ${selectedMessages.length} 条消息`);
  }

  async function sendChatMessage(options = {}) {
    const {
      textOverride,
      queuedAssets = queuedFilesRef.current,
      clearDraftOnSuccess = true,
      clearQueueOnSuccess = true,
      successMessage
    } = options;

    if (!authToken) {
      setComposerError("当前登录状态失效，请重新登录");
      return false;
    }
    const text = String(textOverride ?? draft).trim();
    const currentQueue = queuedAssets;
    if (!text && !currentQueue.length) {
      setComposerError("请输入消息或选择图片/视频");
      return false;
    }
    if (currentQueue.length && (!p2p || !hostClientId)) {
      setComposerError("当前没有在线的存储终端，无法发送附件");
      return false;
    }
    if (!currentUser?.id) {
      setComposerError("当前用户信息无效，请重新登录");
      return false;
    }

    setSending(true);
    setComposerError("");
    const createdAt = new Date().toISOString();
    const dayKey = getDayKey(new Date(createdAt));
    const historyPath = getHistoryPath(dayKey);
    try {
      const attachments = [];
      let failedUploads = 0;
      for (const [index, asset] of currentQueue.entries()) {
        const file = asset.file;
        if (asset.uploadedAttachment?.path && asset.uploadedAttachment.clientId === hostClientId) {
          attachments.push(asset.uploadedAttachment);
          patchQueuedFile(asset.id, { status: "uploaded", progress: 100, error: "" });
          continue;
        }
        const relativePath = buildAttachmentPath(dayKey, currentUser.id, file.name, index);
        patchQueuedFile(asset.id, { status: "uploading", progress: 0, error: "" });
        try {
          await p2p.uploadFile(hostClientId, relativePath, file, {
            uploadName: file.name,
            onProgress: ({ progress }) => {
              patchQueuedFile(asset.id, {
                status: "uploading",
                progress: Math.max(0, Math.min(100, Number(progress) || 0)),
                error: ""
              });
            }
          });
          const uploadedAttachment = {
            id: `${hostClientId}:${relativePath}`,
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            path: relativePath,
            clientId: hostClientId,
            kind: String(file.type || "").startsWith("video/") ? "video" : "image"
          };
          attachments.push(uploadedAttachment);
          patchQueuedFile(asset.id, {
            status: "uploaded",
            progress: 100,
            error: "",
            uploadedAttachment
          });
        } catch (error) {
          failedUploads += 1;
          patchQueuedFile(asset.id, {
            status: "failed",
            progress: 0,
            error: error?.message || "上传失败"
          });
        }
      }
      if (failedUploads) {
        throw new Error(`有 ${failedUploads} 个附件上传失败，请重试失败项后再发送`);
      }
      const message = normalizeMessage({
        id: `${currentUser.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        text,
        createdAt,
        dayKey,
        historyPath,
        hostClientId,
        attachments,
        author: {
          id: currentUser.id,
          displayName: currentUser.displayName,
          avatarUrl: currentUser.avatarUrl || "",
          avatarClientId: currentUser.avatarClientId || "",
          avatarPath: currentUser.avatarPath || "",
          avatarFileId: currentUser.avatarFileId || ""
        }
      });
      const result = await apiRequest("/api/chat/messages", {
        method: "POST",
        token: authToken,
        body: message
      });
      const storedMessage = normalizeMessage(result?.message || message);
      setMessages((prev) => mergeMessages(prev, [storedMessage]));

      const botInvocation = resolveBotInvocation(text);
      if (botInvocation) {
        if (!botInvocation.supported) {
          setMessage?.("@bili 目前支持 login/status/logout，或 bilibili 链接 / BV 号", "warning");
        } else {
        if (!hostClientId || !p2p) {
          setMessage?.("当前没有在线的存储终端，暂时无法调用 bot", "warning");
        } else {
        try {
          const invoked = await p2p.invokeBot(hostClientId, {
            botId: botInvocation.botId,
            trigger: {
              type: "chat-mention",
              rawText: botInvocation.rawText,
              parsedArgs: botInvocation.parsedArgs || {}
            },
            requester: {
              userId: currentUser.id,
              displayName: currentUser.displayName,
              role: currentUser.role || "user"
            },
            chat: {
              hostClientId,
              dayKey,
              historyPath,
              messageId: message.id,
              replyMode: "append-chat-history"
            },
            attachments
          });
          if (invoked?.job?.jobId) {
            setMessage?.(`已交给 ${botInvocation.mention} 处理，任务 ${invoked.job.jobId.slice(0, 12)} 已创建`, "success");
          }
        } catch (botError) {
          setMessage?.(botError?.message || `${botInvocation.mention} 任务创建失败`, "error");
        }
        }
        }
      }

      pendingScrollModeRef.current = "bottom";
      if (clearDraftOnSuccess) {
        setDraft("");
      }
      if (clearQueueOnSuccess) {
        clearQueuedFiles();
      }
      setLoadedDays((prev) => (prev.includes(dayKey) ? prev : [dayKey, ...prev]));
      loadedDaySetRef.current.add(dayKey);
      composerInputRef.current?.focus();
      if (successMessage) {
        setMessage?.(successMessage, "success");
      }
      return true;
    } catch (error) {
      setComposerError(error?.message || "消息发送失败");
      setMessage?.(error?.message || "消息发送失败", "error");
      return false;
    } finally {
      setSending(false);
    }
  }

  async function forwardSelectedMessages() {
    if (!selectedMessages.length) {
      return;
    }
    const forwarded = await sendChatMessage({
      textOverride: buildForwardBlock(selectedMessages),
      queuedAssets: [],
      clearDraftOnSuccess: false,
      clearQueueOnSuccess: false,
      successMessage: `已转发 ${selectedMessages.length} 条消息`
    });
    if (forwarded) {
      clearMessageSelection();
    }
  }

  async function handleSend() {
    await sendChatMessage();
  }

  function applyBotMentionSuggestion(suggestion) {
    if (!suggestion?.alias || !botMentionContext) {
      return;
    }
    const before = draft.slice(0, botMentionContext.start);
    const after = draft.slice(botMentionContext.end);
    const inserted = `@${suggestion.alias} `;
    const updated = `${before}${inserted}${after}`;
    const nextCursor = before.length + inserted.length;
    setDraft(updated);
    setComposerCursor(nextCursor);
    setDismissedBotMentionKey("");
    requestAnimationFrame(() => {
      const input = composerInputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      input.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function resolveBotInvocation(text = "") {
    const raw = String(text || "").trim();
    if (!raw) {
      return null;
    }
    const mentionMatch = raw.match(/(?:^|\s)@(?<alias>[a-z0-9._-]+)(?=\s|$)/i);
    const alias = String(mentionMatch?.groups?.alias || "").trim().toLowerCase();
    if (!alias) {
      return null;
    }
    const target = botCatalog.find((item) => [item.botId, ...(item.aliases || [])]
      .map((value) => String(value || "").toLowerCase())
      .includes(alias));
    if (!target) {
      return parseChatBotInvocation(raw);
    }
    const afterMention = raw.slice(mentionMatch.index + mentionMatch[0].length).trim();
    if (target.botId === "ai.chat") {
      return {
        botId: target.botId,
        mention: mentionMatch[0].trim(),
        rawText: raw,
        supported: true,
        parsedArgs: { prompt: afterMention }
      };
    }
    if (target.botId === "bilibili.downloader") {
      const sourceMatch = afterMention.match(/https?:\/\/\S+|\bBV[0-9A-Za-z]+\b/i);
      const source = String(sourceMatch?.[0] || "").trim();
      const supported = !source
        ? false
        : /^BV[0-9A-Za-z]+$/i.test(source)
          ? true
          : (() => {
              try {
                const url = new URL(source);
                const hostname = String(url.hostname || "").toLowerCase();
                return hostname === "b23.tv" || hostname === "www.bilibili.com" || hostname === "bilibili.com" || hostname.endsWith(".bilibili.com");
              } catch {
                return false;
              }
            })();
      return {
        botId: target.botId,
        mention: mentionMatch[0].trim(),
        rawText: raw,
        supported,
        parsedArgs: { source }
      };
    }
    return {
      botId: target.botId,
      mention: mentionMatch[0].trim(),
      rawText: raw,
      supported: true,
      parsedArgs: afterMention ? { prompt: afterMention } : {}
    };
  }

  function applyBotDraft(command) {
    const prefix = String(command || "").trim();
    if (!prefix) {
      return;
    }
    setDraft((prev) => {
      const previous = String(prev || "").trim();
      return previous ? `${previous}\n${prefix}` : `${prefix} `;
    });
    setDismissedBotMentionKey("");
    requestAnimationFrame(() => {
      composerInputRef.current?.focus();
    });
  }

  function openBotTooltip() {
    if (botTooltipCloseTimerRef.current) {
      clearTimeout(botTooltipCloseTimerRef.current);
      botTooltipCloseTimerRef.current = null;
    }
    setEmojiPanelOpen(false);
    setBotTooltipOpen(true);
  }

  function scheduleCloseBotTooltip() {
    if (botTooltipCloseTimerRef.current) {
      clearTimeout(botTooltipCloseTimerRef.current);
    }
    botTooltipCloseTimerRef.current = setTimeout(() => {
      setBotTooltipOpen(false);
      botTooltipCloseTimerRef.current = null;
    }, 120);
  }

  const visibleEmojiOptions = activeEmojiCategory === "recent"
    ? recentEmojis
    : EMOJI_CATEGORIES[activeEmojiCategory]?.emojis || EMOJI_CATEGORIES[DEFAULT_EMOJI_CATEGORY].emojis;

  const renderedItems = useMemo(() => {
    const items = [];
    let lastDayKey = "";
    let previousMessage = null;
    for (const message of messages) {
      if (message.dayKey !== lastDayKey) {
        lastDayKey = message.dayKey;
        items.push({ type: "day", id: `day-${message.dayKey}`, dayKey: message.dayKey });
        previousMessage = null;
      }
      const compact = shouldCompactMessage(previousMessage, message);
      items.push({ type: "message", id: message.id, message, compact });
      previousMessage = message;
    }
    return items;
  }, [messages]);

  const failedQueuedCount = queuedFiles.filter((item) => item.status === "failed").length;
  const uploadingQueuedCount = queuedFiles.filter((item) => item.status === "uploading").length;
  const completedQueuedCount = queuedFiles.filter((item) => item.status === "uploaded").length;
  const lightboxImages = useMemo(
    () => messages.flatMap((message) => message.attachments
      .filter((attachment) => isImageAttachment(attachment) && resolvedImageUrls[attachment.id])
      .map((attachment) => ({
        id: attachment.id,
        previewSrc: resolvedImageUrls[attachment.id],
        name: attachment.name,
        createdAt: message.createdAt,
        authorName: message.author.displayName,
        attachment
      }))),
    [messages, resolvedImageUrls]
  );
  const activeLightboxIndex = lightboxImages.findIndex((item) => item.id === activeLightboxImageId);
  const activeLightboxImage = activeLightboxIndex >= 0 ? lightboxImages[activeLightboxIndex] : null;

  function openLightbox(imageId) {
    if (!imageId) {
      return;
    }
    setActiveLightboxImageId(imageId);
  }

  function navigateLightbox(offset) {
    if (!lightboxImages.length) {
      return;
    }
    const currentIndex = activeLightboxIndex >= 0 ? activeLightboxIndex : 0;
    const nextIndex = (currentIndex + offset + lightboxImages.length) % lightboxImages.length;
    setActiveLightboxImageId(lightboxImages[nextIndex]?.id || "");
  }

  function openMessageContextMenu(event, message) {
    event.preventDefault();
    setContextMenuState({
      x: event.clientX,
      y: event.clientY,
      message
    });
  }

  function renderMessageActions(message, variant = "toolbar") {
    const imageAttachment = message.attachments.find((attachment) => isImageAttachment(attachment) && resolvedImageUrls[attachment.id]);
    const videoAttachment = message.attachments.find((attachment) => isVideoAttachment(attachment));
    const hasCopyable = Boolean(message.text || message.attachments.length);
    const iconOnly = variant === "toolbar";
    const canViewLog = isCompletedAiChatBotMessage(message);
    return (
      <>
        {hasCopyable ? (
          <button
            type="button"
            className={`chatMessageActionButton${variant === "menu" ? " menu" : ""}`}
            onClick={() => {
              copyTextToClipboard(buildMessageClipboardText(message), "已复制消息内容");
              setContextMenuState(null);
            }}
            aria-label="复制消息"
            title="复制消息"
          >
            <CopyRegular />
            {iconOnly ? null : <span>复制消息</span>}
          </button>
        ) : null}
        {imageAttachment ? (
          <button
            type="button"
            className={`chatMessageActionButton${variant === "menu" ? " menu" : ""}`}
            onClick={() => {
              openLightbox(imageAttachment.id);
              setContextMenuState(null);
            }}
            aria-label="查看图片"
            title="查看图片"
          >
            <ImageRegular />
            {iconOnly ? null : <span>{variant === "menu" ? "查看图片" : "查看"}</span>}
          </button>
        ) : null}
        {imageAttachment && variant === "menu" ? (
          <button
            type="button"
            className="chatMessageActionButton menu"
            onClick={() => {
              addImageAttachmentToCustomEmoji(imageAttachment);
              setContextMenuState(null);
            }}
          >
            <ArrowUploadRegular />
            <span>加入表情</span>
          </button>
        ) : null}
        {variant === "menu" && message.attachments.length ? (
          <button
            type="button"
            className="chatMessageActionButton menu"
            onClick={() => {
              const attachment = message.attachments[0];
              setContextMenuState(null);
              setSaveToLibraryDraft({
                attachment,
                folderPath: normalizeFolderPath("chat-saved")
              });
            }}
          >
            <ArrowUploadRegular />
            <span>转存到资源列表</span>
          </button>
        ) : null}
        {videoAttachment ? (
          <button
            type="button"
            className={`chatMessageActionButton${variant === "menu" ? " menu" : ""}`}
            onClick={() => {
              openVideoAttachment(videoAttachment);
              setContextMenuState(null);
            }}
            aria-label="预览视频"
            title="预览视频"
          >
            <VideoRegular />
            {iconOnly ? null : <span>{variant === "menu" ? "预览视频" : "视频"}</span>}
          </button>
        ) : null}
        {canViewLog ? (
          <button
            type="button"
            className={`chatMessageActionButton${variant === "menu" ? " menu" : ""}`}
            onClick={() => {
              openBotLogDialog(message).catch(() => {});
              setContextMenuState(null);
            }}
            aria-label="查看日志"
            title="查看日志"
          >
            {iconOnly ? <span className="chatMessageActionGlyph">志</span> : <><span className="chatMessageActionGlyph">志</span><span>查看日志</span></>}
          </button>
        ) : null}
        <button
          type="button"
          className={`chatMessageActionButton${variant === "menu" ? " menu" : ""}`}
          onClick={() => {
            insertQuoteIntoDraft([message]);
          }}
          aria-label="回复这条"
          title="回复这条"
        >
          <SendRegular />
          {iconOnly ? null : <span>{variant === "menu" ? "回复这条" : "回复"}</span>}
        </button>
        {variant === "menu" ? (
          <>
            <button
              type="button"
              className="chatMessageActionButton menu"
              onClick={() => {
                copyTextToClipboard(message.createdAt || "", "已复制时间戳");
                setContextMenuState(null);
              }}
            >
              <CopyRegular />
              <span>复制时间戳</span>
            </button>
            <button
              type="button"
              className="chatMessageActionButton menu"
              onClick={() => {
                if (selectionMode && selectedMessageIdSet.has(message.id)) {
                  toggleMessageSelection(message.id);
                } else {
                  enterSelectionMode(message.id);
                }
                setContextMenuState(null);
              }}
            >
              <CopyRegular />
              <span>{selectionMode ? (selectedMessageIdSet.has(message.id) ? "取消选择" : "加入多选") : "开始多选"}</span>
            </button>
          </>
        ) : null}
      </>
    );
  }

  return (
    <section className="workspacePage chatWorkspacePage" onClick={() => {
      setContextMenuState(null);
      setEmojiPanelOpen(false);
    }}>
      <div className="chatRoomShell">
        <div className="chatRoomHeader compact">
          <Subtitle1>聊天室</Subtitle1>
          <div className="chatRoomMinimalMeta rightAligned">
            <Badge appearance="outline" color={chatConnectionState === "connected" ? "success" : authToken ? "warning" : "danger"}>
              {chatConnectionState === "connected" ? "聊天已连接" : authToken ? "聊天重连中" : "未登录"}
            </Badge>
            <Badge appearance="outline" color={hostClientId ? "success" : "warning"}>{hostClientId ? "存储在线" : "存储离线"}</Badge>
            <Caption1>今日 {todayMessageCount} 条</Caption1>
            <Caption1>{hostClientId ? getClientDisplayName(hostClientId) : "文字聊天可用，附件和 Bot 需等待存储终端"}</Caption1>
          </div>
        </div>

        <div className="chatRoomBody">
          <div className="chatTimelinePanel">
            {selectionMode ? (
              <div className="chatSelectionBar">
                <div>
                  <Caption1>已选择 {selectedMessages.length} 条消息</Caption1>
                  <Text>{selectedMessages.length ? "可批量复制、引用或转发。" : "点左侧圆点开始多选。"}</Text>
                </div>
                <div className="chatSelectionActions">
                  <Button appearance="secondary" onClick={copySelectedMessages} disabled={!selectedMessages.length}>复制所选</Button>
                  <Button appearance="secondary" onClick={() => insertQuoteIntoDraft(selectedMessages)} disabled={!selectedMessages.length}>引用到输入框</Button>
                  <Button appearance="primary" onClick={forwardSelectedMessages} disabled={!selectedMessages.length || sending}>转发到当前会话</Button>
                  <Button appearance="subtle" onClick={clearMessageSelection}>取消</Button>
                </div>
              </div>
            ) : null}
            <div className="chatTimeline" ref={listRef} onScroll={handleScroll}>
              {loadingOlder ? <div className="chatLoadMarker"><Spinner size="tiny" label="正在加载更早记录" /></div> : null}
              {!loadingOlder && hasOlderHistory ? (
                <div className="chatLoadMarker">
                  <Button appearance="subtle" size="small" onClick={() => loadOlderHistory().catch(() => {})}>加载更早消息</Button>
                </div>
              ) : null}
              {!hasOlderHistory && messages.length ? <div className="chatLoadHint">已到更早历史边界</div> : null}
              {loadingToday ? <div className="chatEmptyState"><Spinner label="正在加载今天的聊天记录" /></div> : null}
              {!loadingToday && !messages.length ? (
                <div className="chatEmptyState">
                  <Subtitle1>今天还没有聊天记录</Subtitle1>
                  <Text>文本聊天历史现在由服务器保存；图片、视频和 Bot 仍依赖在线存储终端。</Text>
                  {hasOlderHistory ? <Button appearance="secondary" size="small" onClick={() => loadOlderHistory().catch(() => {})}>尝试加载更早消息</Button> : null}
                </div>
              ) : null}
              {renderedItems.map((item) => {
                if (item.type === "day") {
                  return <div key={item.id} className="chatDayDivider"><span>{describeDay(item.dayKey)}</span></div>;
                }
                const message = item.message;
                const mine = message.author.id === currentUser?.id;
                const selected = selectedMessageIdSet.has(message.id);
                return (
                  <div key={item.id} className={`chatMessageRow${mine ? " mine" : ""}${item.compact ? " compact" : ""}${message.bot?.botId ? " bot" : ""}`} onContextMenu={(event) => openMessageContextMenu(event, message)}>
                    {selectionMode ? (
                      <div className="chatMessageSelectLane">
                        <button type="button" className={`chatMessageSelectToggle${selected ? " selected" : ""}`} aria-pressed={selected} onClick={() => toggleMessageSelection(message.id)}>
                          {selected ? "✓" : ""}
                        </button>
                      </div>
                    ) : null}
                    <div className="chatMessageRail">
                      {item.compact ? <div className="chatMessageAvatarSpacer" /> : (
                        <AvatarFace
                          className="chatMessageAvatar"
                          displayName={message.author.displayName}
                          avatarUrl={message.author.avatarUrl}
                          avatarClientId={message.author.avatarClientId}
                          avatarPath={message.author.avatarPath}
                          avatarFileId={message.author.avatarFileId}
                          p2p={p2p}
                        />
                      )}
                    </div>
                    <div className={`chatMessageCard${selected ? " selected" : ""}${message.card ? " dynamic" : ""}`}>
                      <div className={`chatMessageActions ${mine ? "side-left" : "side-right"}`} onClick={(event) => event.stopPropagation()}>
                        {renderMessageActions(message)}
                      </div>
                      <div className={`chatMessageMeta${item.compact ? " compact" : ""}`}>
                        <div className="chatMessageMetaMain">
                          {!item.compact ? <Text>{message.author.displayName}</Text> : null}
                          <Caption1>{formatClockTime(message.createdAt)}</Caption1>
                          {!item.compact ? <Caption1>{formatRelativeTime(message.createdAt)}</Caption1> : null}
                        </div>
                        {message.attachments.length ? <Badge appearance="outline" color="informative">{message.attachments.length} 个附件</Badge> : null}
                      </div>
                      {renderMessageCardBody(message)}
                      {shouldRenderStandaloneMessageText(message) ? <MarkdownBlock className="chatMarkdownBlock chatMessageText" text={message.text} /> : null}
                      {getDisplayAttachments(message).length ? (
                        <div className="chatAttachmentGrid">
                          {getDisplayAttachments(message).map((attachment) => (
                            <div key={attachment.id} className={`chatAttachmentBlock${isImageAttachment(attachment) ? " imageLike" : ""}`}>
                              {isImageAttachment(attachment) ? (
                                <ChatImageAttachmentPreview
                                  attachment={attachment}
                                  p2p={p2p}
                                  onOpenImage={openLightbox}
                                  onResolvedPreview={registerResolvedImage}
                                />
                              ) : isVideoAttachment(attachment) ? (
                                <ChatVideoAttachmentPreview
                                  attachment={attachment}
                                  p2p={p2p}
                                  onOpenVideo={openVideoAttachment}
                                  onResolvedPreview={registerResolvedImage}
                                />
                              ) : (
                                <div className="chatAttachmentTile">
                                  <div className="chatAttachmentPlaceholder">暂不支持预览</div>
                                </div>
                              )}
                              <div className="chatAttachmentMeta">
                                <Text>{attachment.name}</Text>
                                <Caption1>{formatBytes(attachment.size)}{isLargeChatMediaAttachment(attachment) ? " · 延迟加载" : ""}</Caption1>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div
          className={`chatComposerBar${dragActive ? " dragActive" : ""}`}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="chatComposerMain">
            <div className="chatComposerPanel">
              <div className="chatComposerPanelActions">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  hidden
                  onChange={handlePickFiles}
                />
                <input
                  ref={customEmojiInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={handleCustomEmojiUpload}
                />
                <div className="chatEmojiTriggerWrap" ref={emojiTriggerRef}>
                  <Button
                    className="chatComposerIconButton"
                    appearance={emojiPanelOpen ? "primary" : "secondary"}
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation();
                      setEmojiPanelOpen((prev) => !prev);
                    }}
                    aria-label="表情"
                    title="表情"
                    disabled={!authToken || sending}
                  >
                    😀
                  </Button>
                </div>
                <div className="chatBotTriggerWrap" ref={botTriggerRef}>
                  <Button
                    className={`chatComposerBotButton${botTooltipOpen ? " active" : ""}`}
                    appearance="secondary"
                    size="small"
                    onMouseEnter={openBotTooltip}
                    onMouseLeave={scheduleCloseBotTooltip}
                    onFocus={openBotTooltip}
                    onBlur={scheduleCloseBotTooltip}
                    disabled={!hostClientId || sending}
                    title="查看当前存储终端支持的 bot"
                  >
                    <span className="chatComposerBotButtonLabel">Bots</span>
                    <span className="chatComposerBotButtonCount">{loadingBotCatalog ? "..." : botCatalog.length || 0}</span>
                  </Button>
                </div>
                <Button className="chatComposerIconButton" appearance="secondary" size="small" icon={<ArrowUploadRegular />} aria-label="添加媒体" title="添加媒体" onClick={() => fileInputRef.current?.click()} disabled={!hostClientId || sending} />
                <Button className="chatComposerIconButton send" appearance="primary" size="small" icon={<SendRegular />} aria-label={sending ? "发送中" : "发送消息"} title={sending ? "发送中" : "发送消息"} onClick={handleSend} disabled={!authToken || sending} />
              </div>

              <div className="chatComposerInputWrap" ref={composerInputWrapRef}>
                {dragActive ? <div className="chatDropOverlay">释放鼠标即可加入图片 / 视频</div> : null}
                <textarea
                  ref={composerInputRef}
                  className="chatComposerInput"
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setComposerCursor(Number.isFinite(event.target.selectionStart) ? event.target.selectionStart : event.target.value.length);
                  }}
                  onKeyDown={handleComposerKeyDown}
                  onSelect={(event) => setComposerCursor(Number.isFinite(event.target.selectionStart) ? event.target.selectionStart : draft.length)}
                  onClick={(event) => setComposerCursor(Number.isFinite(event.target.selectionStart) ? event.target.selectionStart : draft.length)}
                  onPaste={handlePaste}
                  placeholder="Enter 发送，Shift+Enter 换行，也可直接粘贴截图或把图片视频拖到这里"
                  rows={3}
                  disabled={!authToken || sending}
                />
                {queuedFiles.length ? (
                  <div className="chatComposerQueueDock">
                    <div className="chatComposerQueueDockHeader">
                      <div>
                        <Caption1>附件 {queuedFiles.length}</Caption1>
                      </div>
                      <div className="chatComposerSideActions">
                        <Badge appearance="outline" color="informative">Ready</Badge>
                        <Button appearance="subtle" size="small" onClick={() => setQueueExpanded((prev) => !prev)}>
                          {queueExpanded ? "收起" : "展开"}
                        </Button>
                      </div>
                    </div>
                    {queueExpanded ? (
                      <div className="chatQueuedFilesGrid docked">
                        {queuedFiles.map((asset) => (
                          <div key={asset.id} className={`chatQueuedCard ${asset.status}`}>
                            <div className="chatQueuedVisual">
                              <ChatQueuedPreview asset={asset} />
                              <button type="button" className="iconActionButton chatQueuedRemove" aria-label="移除附件" onClick={() => removeQueuedFile(asset.id)} disabled={asset.status === "uploading" || sending}>
                                <DismissRegular />
                              </button>
                              <div className={`chatQueuedStatusPill ${asset.status}`}>
                                {asset.status === "uploading" ? `上传中 ${asset.progress}%` : null}
                                {asset.status === "uploaded" ? "已上传" : null}
                                {asset.status === "failed" ? "上传失败" : null}
                                {asset.status === "queued" ? "待发送" : null}
                              </div>
                            </div>
                            <div className="chatQueuedMeta">
                              <div className="chatQueuedMetaMain">
                                <Text>{asset.file.name}</Text>
                                <Caption1>{formatBytes(asset.file.size)}</Caption1>
                              </div>
                              <div className="chatQueuedMetaActions">
                                {asset.status === "failed" ? <Button appearance="subtle" size="small" icon={<ArrowClockwiseRegular />} onClick={() => retryQueuedFile(asset.id)} disabled={sending}>重试</Button> : null}
                                <Badge appearance="outline" color={asset.kind === "video" ? "informative" : "success"}>{asset.kind === "video" ? "视频" : "图片"}</Badge>
                              </div>
                            </div>
                            <div className="chatQueuedProgressTrack" aria-hidden="true">
                              <span className={`chatQueuedProgressBar ${asset.status}`} style={{ width: `${asset.status === "uploaded" ? 100 : asset.status === "uploading" ? asset.progress : asset.status === "failed" ? 100 : 0}%` }} />
                            </div>
                            {asset.error ? <Caption1 className="chatQueuedErrorText">{asset.error}</Caption1> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="chatComposerToolbar compact">
                <div className="chatComposerActions">
                  {uploadingQueuedCount ? <Badge appearance="outline" color="informative">上传中 {uploadingQueuedCount}</Badge> : null}
                  {completedQueuedCount ? <Badge appearance="outline" color="success">已完成 {completedQueuedCount}</Badge> : null}
                  {failedQueuedCount ? <Badge appearance="outline" color="danger">失败 {failedQueuedCount}</Badge> : null}
                  {failedQueuedCount ? <Button appearance="subtle" icon={<ArrowClockwiseRegular />} onClick={retryFailedQueuedFiles} disabled={sending}>重试失败项</Button> : null}
                  {queuedFiles.length ? <Button appearance="subtle" onClick={clearQueuedFiles} disabled={sending}>清空附件</Button> : null}
                </div>
              </div>
              {composerError ? <div className="chatComposerError">{composerError}</div> : null}
            </div>
          </div>
        </div>
        {contextMenuState && typeof document !== "undefined" ? createPortal(
          <div
            ref={contextMenuRef}
            className="chatContextMenu"
            style={contextMenuStyle}
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            {renderMessageActions(contextMenuState.message, "menu")}
          </div>,
          document.body
        ) : null}
        {emojiPanelOpen && typeof document !== "undefined" ? createPortal(
          <div ref={emojiPopupRef} className="chatEmojiPopup" style={emojiPopupStyle} onClick={(event) => event.stopPropagation()}>
            <div className="chatEmojiSection">
              <div className="chatEmojiSectionHeader compact tabs">
                <div className="chatEmojiCategoryTabs">
                  {EMOJI_CATEGORY_ORDER.map((categoryKey) => (
                    <button
                      key={categoryKey}
                      type="button"
                      className={`chatEmojiCategoryTab${activeEmojiCategory === categoryKey ? " active" : ""}`}
                      onClick={() => setActiveEmojiCategory(categoryKey)}
                    >
                      {EMOJI_CATEGORIES[categoryKey].label}
                    </button>
                  ))}
                </div>
                <Text>点击插入到输入框</Text>
              </div>
              {visibleEmojiOptions.length ? (
                <div className="chatEmojiGrid compact">
                  {visibleEmojiOptions.map((emojiChar) => (
                    <button key={`${activeEmojiCategory}-${emojiChar}`} type="button" className="chatEmojiButton compact" onClick={() => handleEmojiPick(emojiChar)}>
                      {emojiChar}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="chatEmojiEmptyState">最近使用为空，先插入几个表情后这里会出现。</div>
              )}
            </div>
            <div className="chatEmojiSection">
              <div className="chatEmojiSectionHeader compact">
                <div>
                  <Caption1>自定义表情</Caption1>
                  <Text>{customEmojis.length ? `已保存 ${customEmojis.length} 个` : "支持上传静态图片"}</Text>
                </div>
                <Button appearance="subtle" size="small" onClick={() => customEmojiInputRef.current?.click()} disabled={sending || customEmojis.length >= CHAT_CUSTOM_EMOJI_MAX_ITEMS}>上传</Button>
              </div>
              {customEmojis.length ? (
                <div className="chatCustomEmojiGrid compact">
                  {customEmojis.map((emojiItem) => (
                    <div key={emojiItem.id} className="chatCustomEmojiCard compact">
                      <button type="button" className="chatCustomEmojiButton compact" onClick={() => sendCustomEmoji(emojiItem)} title={emojiItem.name}>
                        <img src={emojiItem.dataUrl} alt={emojiItem.name} />
                      </button>
                      <button type="button" className="chatCustomEmojiRemove" aria-label={`移除 ${emojiItem.name}`} onClick={() => removeCustomEmoji(emojiItem.id)}>
                        <DismissRegular />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="chatEmojiEmptyState">上传后可像贴纸一样快速发送。</div>
              )}
            </div>
          </div>,
          document.body
        ) : null}
        {botTooltipOpen && typeof document !== "undefined" ? createPortal(
          <div
            ref={botTooltipRef}
            className="chatBotTooltipPopup"
            style={botTooltipStyle}
            onClick={(event) => event.stopPropagation()}
            onMouseEnter={openBotTooltip}
            onMouseLeave={scheduleCloseBotTooltip}
          >
            <div className="chatBotTooltipHeader">
              <div className="chatBotTooltipHeaderMain">
                <div className="chatBotTooltipHeaderTopline">
                  <Text>可用助手</Text>
                </div>
                <Caption1>{loadingBotCatalog ? "正在读取当前存储终端的助手目录" : hostClientId ? `来自 ${getClientDisplayName(hostClientId)}，点击命令可直接填入输入框` : "Bot 功能依赖在线存储终端"}</Caption1>
              </div>
            </div>
            {botCatalog.length ? (
              <div className="chatBotTooltipList">
                {botCatalog.map((bot) => {
                  const localized = getLocalizedBotMeta(bot);
                  const exampleCommands = getBotExampleCommands(bot);
                  const aliases = (Array.isArray(bot.aliases) ? bot.aliases : [])
                    .map((item) => String(item || "").trim().replace(/^@+/, ""))
                    .filter(Boolean);
                  const primaryAlias = aliases[0] || String(bot.botId || "").split(".")[0] || String(bot.botId || "");
                  const secondaryAliases = aliases.slice(1);
                  return (
                    <div key={bot.botId} className="chatBotTooltipCard">
                      <div className="chatBotTooltipCardHeader">
                        <div className="chatBotTooltipCardIdentity">
                          <div className="chatBotTooltipAliasPill">@{primaryAlias}</div>
                          <div className="chatBotTooltipCardTitleBlock">
                            <Text>{localized.displayName}</Text>
                            <Caption1>{localized.description || bot.botId}</Caption1>
                          </div>
                        </div>
                      </div>
                      {secondaryAliases.length ? (
                        <div className="chatBotTooltipAliasRow">
                          <Caption1>别名</Caption1>
                          <div className="chatBotTooltipAliasList">
                            {secondaryAliases.map((alias) => <span key={`${bot.botId}:${alias}`}>@{alias}</span>)}
                          </div>
                        </div>
                      ) : null}
                      <div className="chatBotTooltipExamples">
                        {exampleCommands.map((command) => (
                          <button
                            key={`${bot.botId}:${command}`}
                            type="button"
                            className="chatBotExampleChip"
                            onClick={() => {
                              applyBotDraft(command);
                              setBotTooltipOpen(false);
                            }}
                            disabled={!hostClientId || sending}
                          >
                            {command}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="chatBotEmptyHint">
                <Caption1>{hostClientId ? "当前终端尚未返回 bot catalog，或 bot 运行时尚未初始化。" : "文字聊天已可用；待存储终端上线后再读取 bot catalog。"}</Caption1>
              </div>
            )}
          </div>,
          document.body
        ) : null}
        {botMentionOpen && typeof document !== "undefined" ? createPortal(
          <div
            ref={botMentionRef}
            className="chatBotMentionPopup"
            style={botMentionStyle}
            onMouseDown={(event) => event.preventDefault()}
          >
            <div className="chatBotMentionList" role="listbox" aria-label="Bot 候选">
              {botMentionSuggestions.map((item, index) => (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={index === activeBotMentionIndex}
                  className={`chatBotMentionOption${index === activeBotMentionIndex ? " active" : ""}`}
                  onMouseEnter={() => setActiveBotMentionIndex(index)}
                  onClick={() => applyBotMentionSuggestion(item)}
                >
                  <div className="chatBotMentionMeta">
                    <div className="chatBotMentionAliasRow">
                      <Text>@{item.alias}</Text>
                      <Caption1>{item.displayName}</Caption1>
                    </div>
                    <Caption1>{item.aliases.length > 1 ? `别名: ${item.aliases.slice(1).map((alias) => `@${alias}`).join(" ")}` : (item.description || item.botId)}</Caption1>
                  </div>
                </button>
              ))}
            </div>
          </div>,
          document.body
        ) : null}
        {activeLightboxImage ? (
          <div className="overlay chatLightboxOverlay" onClick={() => setActiveLightboxImageId("") }>
            <div className="modalWindow chatLightboxModal" onClick={(event) => event.stopPropagation()}>
              <div className="chatLightboxTopBar">
                <div>
                  <Subtitle1>{activeLightboxImage.name}</Subtitle1>
                  <Caption1>{activeLightboxImage.authorName} · {formatRelativeTime(activeLightboxImage.createdAt)}</Caption1>
                </div>
                <div className="chatLightboxActions">
                  <Button appearance="secondary" onClick={() => navigateLightbox(-1)} disabled={lightboxImages.length <= 1}>上一张</Button>
                  <Button appearance="secondary" onClick={() => navigateLightbox(1)} disabled={lightboxImages.length <= 1}>下一张</Button>
                  <Button appearance="primary" onClick={() => setActiveLightboxImageId("")}>关闭</Button>
                </div>
              </div>
              <div className="chatLightboxBody">
                <button type="button" className="chatLightboxNav prev" onClick={() => navigateLightbox(-1)} disabled={lightboxImages.length <= 1}>上一张</button>
                <div className="chatLightboxStage">
                  <ChatLightboxImageStage attachment={activeLightboxImage.attachment} p2p={p2p} />
                </div>
                <button type="button" className="chatLightboxNav next" onClick={() => navigateLightbox(1)} disabled={lightboxImages.length <= 1}>下一张</button>
              </div>
              <div className="chatLightboxThumbStrip">
                {lightboxImages.map((image) => (
                  <button key={image.id} type="button" className={`chatLightboxThumb${image.id === activeLightboxImageId ? " active" : ""}`} onClick={() => setActiveLightboxImageId(image.id)}>
                    <img src={image.previewSrc} alt={image.name} />
                  </button>
                ))}
              </div>
              <div className="chatLightboxFooter">
                <Caption1>{activeLightboxIndex + 1} / {lightboxImages.length}</Caption1>
                <Caption1>支持键盘左右切换、Esc 关闭，也可点缩略图切图</Caption1>
              </div>
            </div>
          </div>
        ) : null}
        {saveToLibraryDraft ? (
          <div className="overlay drawerOverlay" onClick={() => !savingToLibrary && setSaveToLibraryDraft(null)}>
            <div className="modalWindow chatSaveDialog" onClick={(event) => event.stopPropagation()}>
              <div className="chatSaveDialogHeader">
                <div>
                  <Subtitle1>转存到资源列表</Subtitle1>
                  <Caption1>{saveToLibraryDraft.attachment?.name || "附件"}</Caption1>
                </div>
                <Button size="small" onClick={() => setSaveToLibraryDraft(null)} disabled={savingToLibrary}>关闭</Button>
              </div>
              <div className="chatSaveDialogBody">
                <label className="chatSaveField">
                  <Caption1>目录</Caption1>
                  <input
                    className="chatSaveInput"
                    value={saveToLibraryDraft.folderPath || ""}
                    onChange={(event) => setSaveToLibraryDraft((prev) => ({ ...prev, folderPath: normalizeFolderPath(event.target.value) }))}
                    placeholder="例如 media/chat 或 stickers"
                    disabled={savingToLibrary}
                  />
                </label>
              </div>
              <div className="chatSaveDialogActions">
                <Button appearance="secondary" onClick={() => setSaveToLibraryDraft(null)} disabled={savingToLibrary}>取消</Button>
                <Button
                  appearance="primary"
                  disabled={savingToLibrary}
                  onClick={async () => {
                    if (!saveToLibraryDraft?.attachment) {
                      return;
                    }
                    setSavingToLibrary(true);
                    try {
                      await saveChatAttachmentToLibrary?.(saveToLibraryDraft.attachment, {
                        preferredName: saveToLibraryDraft.preferredName || saveToLibraryDraft.attachment.name,
                        preferredFolderPath: normalizeFolderPath(saveToLibraryDraft.folderPath || "chat-saved")
                      });
                      setSaveToLibraryDraft(null);
                    } finally {
                      setSavingToLibrary(false);
                    }
                  }}
                >
                  {savingToLibrary ? "转存中" : "确认转存"}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        {botLogDialog.open ? (
          <div className="overlay drawerOverlay" onClick={closeBotLogDialog}>
            <div className="modalWindow chatBotLogDialog" onClick={(event) => event.stopPropagation()}>
              <div className="chatSaveDialogHeader chatBotLogDialogHeader">
                <div>
                  <Subtitle1>{botLogDialog.title || "AI Chat 日志"}</Subtitle1>
                  <Caption1>{botLogDialog.loading ? "正在读取日志" : botLogDialog.truncated ? "日志内容过长，当前仅展示尾部片段" : "按时间顺序展示本次 bot 执行日志"}</Caption1>
                </div>
                <Button size="small" onClick={closeBotLogDialog}>关闭</Button>
              </div>
              <div className="chatBotLogDialogBody">
                {botLogDialog.loading ? <Spinner label="正在读取日志..." /> : null}
                {!botLogDialog.loading && botLogDialog.error ? <div className="chatComposerError">{botLogDialog.error}</div> : null}
                {!botLogDialog.loading && !botLogDialog.error ? <pre className="chatBotLogPre">{botLogDialog.content || "暂无日志内容"}</pre> : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}