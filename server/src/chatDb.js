import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const dataDir = path.resolve(process.cwd(), "server/data");
const chatDbPath = path.join(dataDir, "chat.sqlite");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(chatDbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    day_key TEXT NOT NULL,
    history_path TEXT NOT NULL,
    host_client_id TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    author_id TEXT NOT NULL,
    author_display_name TEXT NOT NULL,
    author_avatar_url TEXT NOT NULL DEFAULT '',
    author_avatar_client_id TEXT NOT NULL DEFAULT '',
    author_avatar_path TEXT NOT NULL DEFAULT '',
    author_avatar_file_id TEXT NOT NULL DEFAULT '',
    attachments_json TEXT NOT NULL DEFAULT '[]',
    card_json TEXT,
    bot_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_chat_messages_day_created ON chat_messages(day_key, created_at, id);
`);

function safeParseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function serializeChatMessage(row) {
  return {
    id: String(row?.id || ""),
    text: String(row?.text || ""),
    createdAt: String(row?.created_at || ""),
    dayKey: String(row?.day_key || ""),
    historyPath: String(row?.history_path || ""),
    hostClientId: String(row?.host_client_id || ""),
    attachments: safeParseJson(row?.attachments_json, []),
    author: {
      id: String(row?.author_id || ""),
      displayName: String(row?.author_display_name || "匿名用户"),
      avatarUrl: String(row?.author_avatar_url || ""),
      avatarClientId: String(row?.author_avatar_client_id || ""),
      avatarPath: String(row?.author_avatar_path || ""),
      avatarFileId: String(row?.author_avatar_file_id || "")
    },
    card: safeParseJson(row?.card_json, null),
    bot: safeParseJson(row?.bot_json, null)
  };
}

const insertChatMessageStatement = db.prepare(`
  INSERT INTO chat_messages (
    id,
    created_at,
    day_key,
    history_path,
    host_client_id,
    text,
    author_id,
    author_display_name,
    author_avatar_url,
    author_avatar_client_id,
    author_avatar_path,
    author_avatar_file_id,
    attachments_json,
    card_json,
    bot_json
  ) VALUES (
    @id,
    @created_at,
    @day_key,
    @history_path,
    @host_client_id,
    @text,
    @author_id,
    @author_display_name,
    @author_avatar_url,
    @author_avatar_client_id,
    @author_avatar_path,
    @author_avatar_file_id,
    @attachments_json,
    @card_json,
    @bot_json
  )
  ON CONFLICT(id) DO UPDATE SET
    text = excluded.text,
    host_client_id = excluded.host_client_id,
    attachments_json = excluded.attachments_json,
    card_json = excluded.card_json,
    bot_json = excluded.bot_json,
    author_display_name = excluded.author_display_name,
    author_avatar_url = excluded.author_avatar_url,
    author_avatar_client_id = excluded.author_avatar_client_id,
    author_avatar_path = excluded.author_avatar_path,
    author_avatar_file_id = excluded.author_avatar_file_id
`);

const selectChatMessageByIdStatement = db.prepare("SELECT * FROM chat_messages WHERE id = ? LIMIT 1");
const selectChatMessagesByDayStatement = db.prepare("SELECT * FROM chat_messages WHERE day_key = ? ORDER BY created_at ASC, id ASC");

export function persistChatMessage(message = {}) {
  const payload = {
    id: String(message?.id || "").trim(),
    created_at: String(message?.createdAt || "").trim(),
    day_key: String(message?.dayKey || "").trim(),
    history_path: String(message?.historyPath || "").trim(),
    host_client_id: String(message?.hostClientId || "").trim(),
    text: String(message?.text || ""),
    author_id: String(message?.author?.id || "").trim(),
    author_display_name: String(message?.author?.displayName || "匿名用户"),
    author_avatar_url: String(message?.author?.avatarUrl || ""),
    author_avatar_client_id: String(message?.author?.avatarClientId || ""),
    author_avatar_path: String(message?.author?.avatarPath || ""),
    author_avatar_file_id: String(message?.author?.avatarFileId || ""),
    attachments_json: JSON.stringify(Array.isArray(message?.attachments) ? message.attachments : []),
    card_json: message?.card ? JSON.stringify(message.card) : null,
    bot_json: message?.bot ? JSON.stringify(message.bot) : null
  };
  insertChatMessageStatement.run(payload);
  const stored = selectChatMessageByIdStatement.get(payload.id);
  return serializeChatMessage(stored);
}

export function listChatMessagesByDay(dayKey = "") {
  const normalizedDayKey = String(dayKey || "").trim();
  if (!normalizedDayKey) {
    return [];
  }
  return selectChatMessagesByDayStatement.all(normalizedDayKey).map((row) => serializeChatMessage(row));
}