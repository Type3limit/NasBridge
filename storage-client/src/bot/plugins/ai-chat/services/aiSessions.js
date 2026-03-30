import fs from "node:fs";
import path from "node:path";
import { AI_SESSION_DIR_NAME, AI_SESSION_INDEX_FILE_NAME, MAX_SESSION_CONTEXT_MESSAGES } from "../constants.js";
import { parseJsonLines } from "../utils/json.js";

function getAiSessionRoot(appDataRoot = "") {
  return path.join(String(appDataRoot || ""), AI_SESSION_DIR_NAME);
}

function getAiSessionIndexPath(appDataRoot = "") {
  return path.join(getAiSessionRoot(appDataRoot), AI_SESSION_INDEX_FILE_NAME);
}

function getAiSessionHistoryPath(appDataRoot = "", sessionId = 0) {
  return path.join(getAiSessionRoot(appDataRoot), "history", `${Number(sessionId) || 0}.jsonl`);
}

function normalizeAiSessionRecord(input = {}) {
  const id = Number.parseInt(String(input?.id || input?.sessionId || 0), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  const createdAt = String(input?.createdAt || new Date().toISOString());
  const updatedAt = String(input?.updatedAt || createdAt);
  return {
    id,
    name: String(input?.name || "").trim(),
    createdAt,
    updatedAt
  };
}

async function readAiSessionIndex(appDataRoot = "") {
  try {
    const raw = await fs.promises.readFile(getAiSessionIndexPath(appDataRoot), "utf8");
    const parsed = JSON.parse(raw);
    const sessions = Array.isArray(parsed?.sessions)
      ? parsed.sessions.map((item) => normalizeAiSessionRecord(item)).filter(Boolean)
      : [];
    const nextId = Math.max(
      1,
      Number.parseInt(String(parsed?.nextId || 1), 10) || 1,
      sessions.reduce((maxId, item) => Math.max(maxId, item.id + 1), 1)
    );
    return { nextId, sessions };
  } catch {
    return { nextId: 1, sessions: [] };
  }
}

async function writeAiSessionIndex(appDataRoot = "", payload = {}) {
  const sessions = Array.isArray(payload?.sessions)
    ? payload.sessions.map((item) => normalizeAiSessionRecord(item)).filter(Boolean)
    : [];
  const nextId = Math.max(
    1,
    Number.parseInt(String(payload?.nextId || 1), 10) || 1,
    sessions.reduce((maxId, item) => Math.max(maxId, item.id + 1), 1)
  );
  await fs.promises.mkdir(getAiSessionRoot(appDataRoot), { recursive: true });
  await fs.promises.writeFile(getAiSessionIndexPath(appDataRoot), `${JSON.stringify({ nextId, sessions }, null, 2)}\n`, "utf8");
}

export async function createAiSession(appDataRoot = "", name = "") {
  const index = await readAiSessionIndex(appDataRoot);
  const now = new Date().toISOString();
  const id = index.nextId;
  const session = {
    id,
    name: String(name || "").trim() || `会话 ${id}`,
    createdAt: now,
    updatedAt: now
  };
  await writeAiSessionIndex(appDataRoot, {
    nextId: id + 1,
    sessions: [...index.sessions, session]
  });
  return session;
}

export async function getAiSession(appDataRoot = "", sessionId = 0) {
  const index = await readAiSessionIndex(appDataRoot);
  return index.sessions.find((item) => item.id === Number(sessionId)) || null;
}

export async function listAiSessions(appDataRoot = "") {
  const index = await readAiSessionIndex(appDataRoot);
  return [...index.sessions].sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0));
}

export async function renameAiSession(appDataRoot = "", sessionId = 0, name = "") {
  const nextName = String(name || "").trim();
  if (!nextName) {
    throw new Error("会话名称不能为空");
  }
  const index = await readAiSessionIndex(appDataRoot);
  const targetId = Number(sessionId);
  let found = null;
  const sessions = index.sessions.map((item) => {
    if (item.id !== targetId) {
      return item;
    }
    found = { ...item, name: nextName, updatedAt: new Date().toISOString() };
    return found;
  });
  if (!found) {
    return null;
  }
  await writeAiSessionIndex(appDataRoot, { nextId: index.nextId, sessions });
  return found;
}

export async function deleteAiSession(appDataRoot = "", sessionId = 0) {
  const index = await readAiSessionIndex(appDataRoot);
  const targetId = Number(sessionId);
  const existing = index.sessions.find((item) => item.id === targetId) || null;
  if (!existing) {
    return null;
  }
  const sessions = index.sessions.filter((item) => item.id !== targetId);
  await writeAiSessionIndex(appDataRoot, { nextId: index.nextId, sessions });
  try {
    await fs.promises.rm(getAiSessionHistoryPath(appDataRoot, targetId), { force: true });
  } catch {
  }
  return existing;
}

export async function touchAiSession(appDataRoot = "", sessionId = 0) {
  const index = await readAiSessionIndex(appDataRoot);
  const targetId = Number(sessionId);
  const sessions = index.sessions.map((item) => item.id === targetId ? { ...item, updatedAt: new Date().toISOString() } : item);
  await writeAiSessionIndex(appDataRoot, { nextId: index.nextId, sessions });
  return sessions.find((item) => item.id === targetId) || null;
}

export async function readAiSessionMessages(appDataRoot = "", sessionId = 0, limit = MAX_SESSION_CONTEXT_MESSAGES) {
  try {
    const raw = await fs.promises.readFile(getAiSessionHistoryPath(appDataRoot, sessionId), "utf8");
    return parseJsonLines(raw)
      .map((item) => ({
        role: String(item?.role || "").trim(),
        content: String(item?.content || "").trim(),
        createdAt: String(item?.createdAt || "").trim()
      }))
      .filter((item) => ["user", "assistant"].includes(item.role) && item.content)
      .slice(-Math.max(1, Math.min(64, Number(limit) || MAX_SESSION_CONTEXT_MESSAGES)));
  } catch {
    return [];
  }
}

export async function appendAiSessionMessage(appDataRoot = "", sessionId = 0, role = "user", content = "") {
  const normalizedRole = String(role || "").trim();
  const normalizedContent = String(content || "").trim();
  if (!normalizedContent || !["user", "assistant"].includes(normalizedRole)) {
    return;
  }
  const historyPath = getAiSessionHistoryPath(appDataRoot, sessionId);
  await fs.promises.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.promises.appendFile(historyPath, `${JSON.stringify({ role: normalizedRole, content: normalizedContent, createdAt: new Date().toISOString() })}\n`, "utf8");
}

export async function appendAiSessionTurn(appDataRoot = "", session = null, userPrompt = "", answer = "") {
  if (!session?.id) {
    return session;
  }
  await appendAiSessionMessage(appDataRoot, session.id, "user", userPrompt);
  await appendAiSessionMessage(appDataRoot, session.id, "assistant", answer);
  return touchAiSession(appDataRoot, session.id);
}

export function formatAiSessionLabel(session = null) {
  if (!session?.id) {
    return "";
  }
  return `#${session.id}${session.name ? ` · ${session.name}` : ""}`;
}

export function buildSessionHistoryMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((item) => ({
    role: item.role,
    content: item.content
  }));
}