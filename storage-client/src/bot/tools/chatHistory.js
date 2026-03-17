import fs from "node:fs";
import path from "node:path";
import { safeJoin } from "../../fsIndex.js";

const chatRoomDirName = process.env.CHAT_ROOM_DIR_NAME || ".nas-chat-room";
const chatHistoryPrefix = `${chatRoomDirName}/history/`;

function normalizeHistoryPath(historyPath = "") {
  const normalized = String(historyPath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.startsWith(chatHistoryPrefix)) {
    throw new Error("invalid chat history path");
  }
  return normalized;
}

function normalizeAttachment(item = {}, hostClientId = "") {
  return {
    id: String(item?.id || `${item?.clientId || hostClientId}:${item?.path || ""}`),
    name: String(item?.name || "附件"),
    mimeType: String(item?.mimeType || "application/octet-stream"),
    size: Math.max(0, Number(item?.size || 0)),
    path: String(item?.path || ""),
    clientId: String(item?.clientId || hostClientId || ""),
    kind: String(item?.kind || "file")
  };
}

function normalizeChatMessage(message = {}) {
  const hostClientId = String(message?.hostClientId || "");
  return {
    id: String(message?.id || ""),
    text: String(message?.text || "").trim(),
    createdAt: String(message?.createdAt || ""),
    dayKey: String(message?.dayKey || ""),
    historyPath: String(message?.historyPath || ""),
    hostClientId,
    attachments: Array.isArray(message?.attachments)
      ? message.attachments.map((item) => normalizeAttachment(item, hostClientId)).filter((item) => item.path)
      : [],
    card: message?.card && typeof message.card === "object" ? message.card : null,
    bot: message?.bot && typeof message.bot === "object" ? message.bot : null,
    author: {
      id: String(message?.author?.id || ""),
      displayName: String(message?.author?.displayName || "匿名用户")
    }
  };
}

function parseDayKeyFromHistoryPath(historyPath = "") {
  const matched = /history\/(\d{4}-\d{2}-\d{2})\.jsonl$/i.exec(String(historyPath || ""));
  return matched?.[1] || "";
}

function shiftDayKey(dayKey, offsetDays) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ""));
  if (!matched) {
    return "";
  }
  const date = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function readHistoryFile(absolutePath) {
  try {
    const raw = await fs.promises.readFile(absolutePath, "utf-8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return normalizeChatMessage(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function readChatHistoryDay(options = {}) {
  const storageRoot = path.resolve(options.storageRoot || process.cwd());
  const historyPath = normalizeHistoryPath(options.historyPath || "");
  const absolutePath = safeJoin(storageRoot, historyPath);
  const messages = await readHistoryFile(absolutePath);
  return {
    historyPath,
    messages: typeof options.limit === "number" && options.limit > 0
      ? messages.slice(-Math.max(1, Math.min(500, Math.floor(options.limit))))
      : messages
  };
}

export async function readRecentChatHistory(options = {}) {
  const storageRoot = path.resolve(options.storageRoot || process.cwd());
  const historyPath = normalizeHistoryPath(options.historyPath || "");
  const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit || 24) || 24)));
  const lookbackDays = Math.max(0, Math.min(30, Math.floor(Number(options.lookbackDays || 2) || 0)));
  const includeBots = options.includeBots !== false;
  const dayKey = parseDayKeyFromHistoryPath(historyPath);
  const result = [];

  for (let offset = lookbackDays; offset >= 0; offset -= 1) {
    const currentDayKey = dayKey ? shiftDayKey(dayKey, -offset) : "";
    const currentHistoryPath = currentDayKey ? `${chatHistoryPrefix}${currentDayKey}.jsonl` : historyPath;
    const absolutePath = safeJoin(storageRoot, currentHistoryPath);
    const messages = await readHistoryFile(absolutePath);
    result.push(...messages.filter((message) => includeBots || !message.bot?.botId));
  }

  result.sort((left, right) => Date.parse(left.createdAt || 0) - Date.parse(right.createdAt || 0));
  return result.slice(-limit);
}
