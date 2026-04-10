import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import multer from "multer";
import http from "node:http";
import {
  createUser,
  ensureAdmin,
  getUserByEmail,
  getUserById,
  listUsers,
  registerClient,
  listClients,
  touchClient,
  setClientStatus,
  replaceClientFiles,
  replaceClientDirectories,
  listFiles,
  listDirectories,
  listColumns,
  createColumn,
  upsertFileMeta,
  moveFileMeta,
  getFileMetaMap,
  listFavoritesByUser,
  toggleFavorite,
  listUploadJobs,
  createUploadJob,
  updateUploadJobProgress,
  finishUploadJob,
  failUploadJob,
  finalizeStaleUploadingJobs,
  createFileShare,
  getFileShareById,
  incrementShareAccessCount,
  listFileShares,
  revokeFileShare,
  deleteFileShare,
  getFileById,
  resolveShareAccess,
  updateUserProfile,
  listFileComments,
  getFileCommentById,
  createFileComment,
  setCommentReaction,
  listFileDanmaku,
  createFileDanmaku,
  listTvSources,
  saveTvSource,
  deleteTvSource
} from "./db.js";
import { signUserToken, signClientToken, signShareToken } from "./auth.js";
import { requireAuth, requireRole } from "./middleware.js";
import { initWsHub } from "./wsHub.js";
import { listChatMessagesByDay, persistChatMessage } from "./chatDb.js";
import { sanitizeUserChatPayload } from "./chatMessages.js";

const app = express();
const server = http.createServer(app);
const wsHub = initWsHub(server);
const serverDebug = process.env.SERVER_DEBUG === "1";

function trimTrailingSlash(value = "") {
  return String(value || "").replace(/\/+$/, "");
}

function isLoopbackHost(hostname = "") {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function resolveShareWebOrigin(req) {
  const configuredOrigins = String(process.env.SHARE_WEB_ORIGIN || process.env.PUBLIC_WEB_ORIGIN || process.env.WEB_ORIGIN || "")
    .split(",")
    .map((item) => trimTrailingSlash(item.trim()))
    .filter(Boolean);
  const preferredConfigured = configuredOrigins.find((item) => {
    try {
      return !isLoopbackHost(new URL(item).hostname);
    } catch {
      return false;
    }
  }) || configuredOrigins[0];
  const originHeader = trimTrailingSlash(req.get("origin") || "");
  const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim();
  const forwardedHost = String(req.get("x-forwarded-host") || "").split(",")[0].trim();
  const host = forwardedHost || req.get("host") || "localhost:5173";
  const protocol = forwardedProto || req.protocol || "http";
  const requestOrigin = originHeader || `${protocol}://${host}`;
  let requestIsExternal = false;
  try {
    requestIsExternal = !isLoopbackHost(new URL(requestOrigin).hostname);
  } catch {
  }

  if (preferredConfigured) {
    try {
      const configuredIsLoopback = isLoopbackHost(new URL(preferredConfigured).hostname);
      if (configuredIsLoopback && requestIsExternal) {
        return requestOrigin;
      }
    } catch {
    }
    return preferredConfigured;
  }

  return requestOrigin;
}

function getShareStatus(share) {
  if (!share) {
    return "missing";
  }
  if (share.revokedAt) {
    return "revoked";
  }
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) {
    return "expired";
  }
  return "active";
}

function enrichShareRecord(share, req) {
  if (!share) {
    return null;
  }
  const file = getFileById(share.fileId);
  const shareOrigin = resolveShareWebOrigin(req);
  return {
    ...share,
    status: getShareStatus(share),
    shareUrl: `${trimTrailingSlash(shareOrigin)}/share.html?share=${encodeURIComponent(share.id)}`,
    file: file
      ? {
          id: file.id,
          clientId: file.clientId,
          path: file.path,
          name: file.name,
          size: Number(file.size || 0),
          mimeType: file.mimeType || "application/octet-stream",
          updatedAt: file.updatedAt
        }
      : share.fileName || share.filePath || share.clientId
        ? {
            id: share.fileId,
            clientId: share.clientId || "",
            path: share.filePath || "",
            name: share.fileName || path.basename(share.filePath || share.fileId || "") || "文件已移除",
            size: 0,
            mimeType: "application/octet-stream",
            updatedAt: ""
          }
        : null
  };
}

function serverLog(...args) {
  if (serverDebug) {
    console.log("[server]", ...args);
  }
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

function serializeUser(user) {
  if (!user) {
    return null;
  }
  const avatar = sanitizeAvatarResponse(user);
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    avatarUrl: avatar.avatarUrl,
    avatarClientId: avatar.avatarClientId,
    avatarPath: avatar.avatarPath,
    avatarFileId: avatar.avatarFileId,
    bio: user.bio || "",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt || user.createdAt
  };
}

function sanitizeProfilePatch(body = {}) {
  const displayName = String(body.displayName || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const avatarUrl = String(body.avatarUrl || "").trim();
  const bio = String(body.bio || "").trim();
  return {
    displayName: displayName.slice(0, 48),
    email: email.slice(0, 160),
    avatarUrl: avatarUrl.slice(0, 8_000_000),
    avatarClientId: String(body.avatarClientId || "").trim().slice(0, 120),
    avatarPath: String(body.avatarPath || "").trim().slice(0, 400),
    avatarFileId: String(body.avatarFileId || "").trim().slice(0, 400),
    bio: bio.slice(0, 240)
  };
}

function sanitizeChatDayKey(value = "") {
  const dayKey = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(dayKey) ? dayKey : "";
}

function buildCommentTree(comments, currentUserId) {
  const nodes = comments.map((item) => {
    const reactions = Array.isArray(item.reactions) ? item.reactions : [];
    const likes = reactions.filter((entry) => entry.value === 1).length;
    const dislikes = reactions.filter((entry) => entry.value === -1).length;
    const currentUserReaction = reactions.find((entry) => entry.userId === currentUserId)?.value || 0;
    const rawAvatarUrl = String(item.createdByAvatarUrl || "");
    const isInlineAvatar = /^data:/i.test(rawAvatarUrl);
    return {
      id: item.id,
      fileId: item.fileId,
      parentId: item.parentId || null,
      content: item.content,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      author: {
        id: item.createdByUserId,
        displayName: item.createdByDisplayName || "匿名用户",
        avatarUrl: isInlineAvatar ? "" : rawAvatarUrl,
        avatarClientId: item.createdByAvatarClientId || "",
        avatarPath: item.createdByAvatarPath || "",
        avatarFileId: item.createdByAvatarFileId || ""
      },
      reactions: {
        likes,
        dislikes,
        currentUserReaction
      },
      replies: []
    };
  });
  const map = new Map(nodes.map((item) => [item.id, item]));
  const roots = [];
  for (const node of nodes) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId).replies.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function serializeDanmakuItems(items = []) {
  return items.map((item) => {
    const rawAvatarUrl = String(item.createdByAvatarUrl || "");
    const isInlineAvatar = /^data:/i.test(rawAvatarUrl);
    return {
      id: item.id,
      fileId: item.fileId,
      content: item.content,
      timeSec: Math.max(0, Number(item.timeSec || 0)),
      color: item.color || "#FFFFFF",
      mode: item.mode || "scroll",
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      author: {
        id: item.createdByUserId,
        displayName: item.createdByDisplayName || "匿名用户",
        avatarUrl: isInlineAvatar ? "" : rawAvatarUrl,
        avatarClientId: item.createdByAvatarClientId || "",
        avatarPath: item.createdByAvatarPath || "",
        avatarFileId: item.createdByAvatarFileId || ""
      }
    };
  });
}

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: process.env.WEB_ORIGIN?.split(",") ?? ["http://localhost:5173"], credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const start = Date.now();
  req.reqId = reqId;
  if (serverDebug) {
    const bodyPreview = req.body && Object.keys(req.body).length
      ? JSON.stringify(req.body).slice(0, 300)
      : "";
    serverLog("request", reqId, req.method, req.originalUrl, bodyPreview);
  }
  res.on("finish", () => {
    const ms = Date.now() - start;
    serverLog("response", reqId, res.statusCode, `${ms}ms`, req.method, req.originalUrl);
  });
  next();
});

app.get("/api/health", (_, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post("/api/auth/register", async (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password || !displayName) {
    return res.status(400).json({ message: "email/password/displayName are required" });
  }
  if (getUserByEmail(email)) {
    return res.status(409).json({ message: "email already exists" });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = createUser({ email, passwordHash, displayName });
  const token = signUserToken(user);
  return res.json({ token, user: serializeUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = getUserByEmail(email ?? "");
  if (!user) {
    return res.status(401).json({ message: "invalid credentials" });
  }
  const isValid = await bcrypt.compare(password ?? "", user.passwordHash);
  if (!isValid) {
    return res.status(401).json({ message: "invalid credentials" });
  }
  const token = signUserToken(user);
  return res.json({ token, user: serializeUser(user) });
});

app.get("/api/me", requireAuth, (req, res) => {
  const user = getUserById(req.auth.sub);
  if (!user) {
    return res.status(404).json({ message: "user not found" });
  }
  const favorites = listFavoritesByUser(req.auth.sub);
  return res.json({ profile: serializeUser(user), favorites });
});

app.patch("/api/me", requireAuth, (req, res) => {
  const currentUser = getUserById(req.auth.sub);
  if (!currentUser) {
    return res.status(404).json({ message: "user not found" });
  }
  const patch = sanitizeProfilePatch(req.body || {});
  if (!patch.displayName || !patch.email) {
    return res.status(400).json({ message: "displayName and email are required" });
  }
  const existing = getUserByEmail(patch.email);
  if (existing && existing.id !== currentUser.id) {
    return res.status(409).json({ message: "email already exists" });
  }
  const updated = updateUserProfile(currentUser.id, patch);
  const token = signUserToken(updated);
  return res.json({ token, user: serializeUser(updated) });
});

app.get("/api/chat/messages", requireAuth, (req, res) => {
  const dayKey = sanitizeChatDayKey(req.query.dayKey || "");
  if (!dayKey) {
    return res.status(400).json({ message: "dayKey is required" });
  }
  return res.json({ messages: listChatMessagesByDay(dayKey) });
});

app.post("/api/chat/messages", requireAuth, (req, res) => {
  const sanitized = sanitizeUserChatPayload(req.body || {}, req.auth.sub);
  if (!sanitized) {
    return res.status(400).json({ message: "聊天室消息格式无效" });
  }
  const stored = persistChatMessage(sanitized);
  wsHub.broadcastToChatUsers({ type: "chat-room-message", payload: stored });
  return res.json({ message: stored });
});

app.get("/api/file-comments", requireAuth, (req, res) => {
  const fileId = String(req.query.fileId || "").trim();
  if (!fileId) {
    return res.status(400).json({ message: "fileId is required" });
  }
  const file = getFileById(fileId);
  if (!file) {
    return res.status(404).json({ message: "file not found" });
  }
  const comments = buildCommentTree(listFileComments(fileId), req.auth.sub);
  return res.json({ comments });
});

app.post("/api/file-comments", requireAuth, (req, res) => {
  const fileId = String(req.body?.fileId || "").trim();
  const parentId = String(req.body?.parentId || "").trim() || null;
  const content = String(req.body?.content || "").trim();
  if (!fileId || !content) {
    return res.status(400).json({ message: "fileId and content are required" });
  }
  const file = getFileById(fileId);
  if (!file) {
    return res.status(404).json({ message: "file not found" });
  }
  if (parentId) {
    const parent = getFileCommentById(parentId);
    if (!parent || parent.fileId !== fileId) {
      return res.status(400).json({ message: "invalid parent comment" });
    }
  }
  const user = getUserById(req.auth.sub);
  const created = createFileComment({
    fileId,
    parentId,
    content: content.slice(0, 1200),
    createdByUserId: req.auth.sub,
    createdByDisplayName: user?.displayName || req.auth.displayName,
    createdByAvatarUrl: user?.avatarUrl || "",
    createdByAvatarClientId: user?.avatarClientId || "",
    createdByAvatarPath: user?.avatarPath || "",
    createdByAvatarFileId: user?.avatarFileId || ""
  });
  return res.json({
    comment: buildCommentTree([created], req.auth.sub)[0],
    comments: buildCommentTree(listFileComments(fileId), req.auth.sub)
  });
});

app.post("/api/file-comments/:commentId/reaction", requireAuth, (req, res) => {
  const comment = getFileCommentById(req.params.commentId);
  if (!comment) {
    return res.status(404).json({ message: "comment not found" });
  }
  const rawValue = Number(req.body?.value || 0);
  const value = rawValue === 1 || rawValue === -1 ? rawValue : 0;
  setCommentReaction(comment.id, req.auth.sub, value);
  return res.json({ comments: buildCommentTree(listFileComments(comment.fileId), req.auth.sub) });
});

app.get("/api/file-danmaku", requireAuth, (req, res) => {
  const fileId = String(req.query.fileId || "").trim();
  if (!fileId) {
    return res.status(400).json({ message: "fileId is required" });
  }
  const file = getFileById(fileId);
  if (!file) {
    return res.status(404).json({ message: "file not found" });
  }
  return res.json({ danmaku: serializeDanmakuItems(listFileDanmaku(fileId)) });
});

app.post("/api/file-danmaku", requireAuth, (req, res) => {
  const fileId = String(req.body?.fileId || "").trim();
  const content = String(req.body?.content || "").trim();
  const timeSec = Math.max(0, Number(req.body?.timeSec || 0));
  const color = /^#([0-9a-f]{6})$/i.test(String(req.body?.color || "").trim())
    ? String(req.body.color).trim().toUpperCase()
    : "#FFFFFF";
  const mode = ["scroll", "top", "bottom"].includes(String(req.body?.mode || "").trim())
    ? String(req.body.mode).trim()
    : "scroll";
  if (!fileId || !content) {
    return res.status(400).json({ message: "fileId and content are required" });
  }
  const file = getFileById(fileId);
  if (!file) {
    return res.status(404).json({ message: "file not found" });
  }
  const user = getUserById(req.auth.sub);
  const created = createFileDanmaku({
    fileId,
    content: content.slice(0, 120),
    timeSec,
    color,
    mode,
    createdByUserId: req.auth.sub,
    createdByDisplayName: user?.displayName || req.auth.displayName,
    createdByAvatarUrl: user?.avatarUrl || "",
    createdByAvatarClientId: user?.avatarClientId || "",
    createdByAvatarPath: user?.avatarPath || "",
    createdByAvatarFileId: user?.avatarFileId || ""
  });
  const serializedItem = serializeDanmakuItems([created])[0];
  wsHub.broadcastToAppUsers({
    type: "file-danmaku-created",
    payload: serializedItem
  });
  return res.json({
    item: serializedItem,
    danmaku: serializeDanmakuItems(listFileDanmaku(fileId))
  });
});

app.get("/api/tv/sources", requireAuth, (req, res) => {
  return res.json({ sources: listTvSources() });
});

app.post("/api/tv/sources", requireAuth, (req, res) => {
  const label = String(req.body?.label || "").trim();
  const url   = String(req.body?.url   || "").trim() || null;
  const content = typeof req.body?.content === "string" ? req.body.content : null;
  const channelCount = Number(req.body?.channelCount) || 0;
  if (!label || channelCount < 1) {
    return res.status(400).json({ error: "label and channelCount >= 1 required" });
  }
  if (!url && !content) {
    return res.status(400).json({ error: "url or content required" });
  }
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch {
      return res.status(400).json({ error: "invalid url" });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return res.status(400).json({ error: "unsupported protocol" });
    }
  }
  const entity = saveTvSource({ label, url, content, channelCount });
  return res.json({ source: entity });
});

app.delete("/api/tv/sources/:id", requireAuth, (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "id required" });
  deleteTvSource(id);
  return res.json({ ok: true });
});

// HLS stream proxy — fetches any HLS resource server-side, rewrites M3U8 segment URLs
// to go through this proxy so the browser avoids CORS/mixed-content issues.
app.get("/api/tv/stream", requireAuth, async (req, res) => {
  const raw = String(req.query.url || "").trim();
  if (!raw) return res.status(400).json({ error: "url required" });
  let parsed;
  try { parsed = new URL(raw); } catch {
    return res.status(400).json({ error: "invalid url" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return res.status(400).json({ error: "unsupported protocol" });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const upstream = await fetch(raw, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
        "Accept": "application/x-mpegURL, application/vnd.apple.mpegurl, video/mp2t, */*",
        "Referer": `${parsed.protocol}//${parsed.host}/`,
        "Origin": `${parsed.protocol}//${parsed.host}`,
      },
    });
    clearTimeout(timer);
    if (!upstream.ok) {
      return res.status(502).json({ error: "upstream error", status: upstream.status });
    }
    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
    const pathNoQuery = raw.split("?")[0];
    const isM3u8 = contentType.includes("mpegurl") || contentType.includes("x-mpegurl") ||
                   contentType.includes("octet-stream") ||
                   /\.m3u8$/i.test(pathNoQuery);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");
    if (isM3u8) {
      const text = await upstream.text();
      // If the response looks like HTML (VIP player wrapper), try to extract real video URL
      if (/^\s*<!DOCTYPE|^\s*<html/i.test(text)) {
        const realUrl = extractVideoUrlFromHtml(text, raw);
        if (realUrl && realUrl !== raw) {
          return res.redirect(302, `/api/tv/stream?url=${encodeURIComponent(realUrl)}`);
        }
        return res.status(422).json({ error: "not an m3u8 stream (got HTML player page)" });
      }
      // If it doesn't look like an m3u8 manifest, pass it through raw as octet-stream
      if (!text.trimStart().startsWith("#EXTM3U")) {
        res.setHeader("Content-Type", contentType || "application/octet-stream");
        return res.send(text);
      }
      // Build base URL for resolving relative paths in the manifest
      const pathParts = parsed.pathname.split("/");
      pathParts.pop();
      const base = `${parsed.protocol}//${parsed.host}${pathParts.join("/")}/`;
      const toProxy = (urlStr) => {
        let abs;
        if (/^https?:\/\//i.test(urlStr)) { abs = urlStr; }
        else if (urlStr.startsWith("//")) { abs = `https:${urlStr}`; }
        else if (urlStr.startsWith("/")) { abs = `${parsed.protocol}//${parsed.host}${urlStr}`; }
        else { abs = base + urlStr; }
        return `/api/tv/stream?url=${encodeURIComponent(abs)}`;
      };
      const rewritten = text.split(/\r?\n/).map((line) => {
        const t = line.trim();
        if (!t) return line;
        // Rewrite URI="..." in any tag (EXT-X-KEY, EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF etc.)
        if (t.startsWith("#")) {
          if (/URI="/i.test(t)) {
            return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${toProxy(u)}"`);
          }
          return line;
        }
        return toProxy(t);
      }).join("\n");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      return res.send(rewritten);
    } else {
      // Binary segment (TS, AAC key, etc.) — stream through
      res.setHeader("Content-Type", contentType || "video/mp2t");
      const { Readable } = await import("node:stream");
      return Readable.fromWeb(upstream.body).pipe(res);
    }
  } catch (err) {
    clearTimeout(timer);
    if (!res.headersSent) {
      return res.status(502).json({ error: "fetch failed", detail: err.message });
    }
  }
});

app.get("/api/tv/playlist", requireAuth, async (req, res) => {
  const raw = String(req.query.url || "").trim();
  if (!raw) return res.status(400).json({ error: "url required" });
  let parsed;
  try { parsed = new URL(raw); } catch {
    return res.status(400).json({ error: "invalid url" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return res.status(400).json({ error: "unsupported protocol" });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const upstream = await fetch(raw, { signal: controller.signal });
    clearTimeout(timer);
    if (!upstream.ok) {
      return res.status(502).json({ error: "upstream error", status: upstream.status });
    }
    const text = await upstream.text();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.send(text);
  } catch (err) {
    clearTimeout(timer);
    return res.status(502).json({ error: "fetch failed", detail: err.message });
  }
});

app.get("/api/files", requireAuth, (req, res) => {
  const files = listFiles();
  const directories = listDirectories();
  const favorites = new Set(listFavoritesByUser(req.auth.sub));
  const metaMap = getFileMetaMap();
  const enriched = files.map((file) => {
    const meta = metaMap.get(file.id) || {};
    return {
      ...file,
      favorite: favorites.has(file.id),
      columnId: meta.columnId || "",
      folderPath: meta.folderPath || "",
      mimeType: meta.mimeType || file.mimeType,
      originalMimeType: file.mimeType,
      aiSummary: meta.aiSummary || null,
      subtitleCachePath: meta.subtitleCachePath || "",
      tags: Array.isArray(meta.tags) ? meta.tags : []
    };
  });
  const SUBTITLE_EXTS = new Set([".srt", ".ass", ".vtt", ".sub", ".ssa"]);
  const filtered = enriched.filter((file) => {
    const ext = String(file.name || "").match(/(\.[^.]+)$/)?.[1]?.toLowerCase() || "";
    return !SUBTITLE_EXTS.has(ext);
  });
  return res.json({ files: filtered, directories });
});

app.get("/api/tags", requireAuth, (req, res) => {
  const metaMap = getFileMetaMap();
  const tagSet = new Set();
  for (const meta of metaMap.values()) {
    if (Array.isArray(meta.tags)) {
      for (const tag of meta.tags) {
        if (tag && typeof tag === "string") {
          tagSet.add(tag.trim());
        }
      }
    }
  }
  return res.json({ tags: [...tagSet].sort() });
});

app.post("/api/files/tags", requireAuth, (req, res) => {
  const fileId = String(req.body?.fileId || "").trim();
  if (!fileId) {
    return res.status(400).json({ message: "fileId is required" });
  }
  const tags = req.body?.tags;
  if (!Array.isArray(tags)) {
    return res.status(400).json({ message: "tags must be an array" });
  }
  const cleanTags = tags.map((t) => String(t || "").trim()).filter(Boolean);
  const meta = upsertFileMeta(fileId, { tags: cleanTags });
  serverLog("files-tags-update", req.reqId, req.auth.sub, fileId, JSON.stringify(cleanTags));
  return res.json({ ok: true, fileId, tags: cleanTags, meta });
});

app.post("/api/files/update", requireAuth, (req, res) => {
  const {
    clientId,
    oldRelativePath,
    newRelativePath,
    columnId,
    folderPath,
    mimeType
  } = req.body || {};
  if (!clientId || !oldRelativePath) {
    return res.status(400).json({ message: "clientId/oldRelativePath required" });
  }

  const oldFileId = `${clientId}:${oldRelativePath}`;
  const nextRelativePath = newRelativePath || oldRelativePath;
  const newFileId = `${clientId}:${nextRelativePath}`;
  const patch = {
    columnId: columnId || "",
    folderPath: folderPath || "",
    mimeType: mimeType || ""
  };

  const meta = nextRelativePath !== oldRelativePath
    ? moveFileMeta(oldFileId, newFileId, patch)
    : upsertFileMeta(oldFileId, patch);
  return res.json({ ok: true, fileId: newFileId, meta });
});

app.get("/api/columns", requireAuth, (req, res) => {
  return res.json({ columns: listColumns() });
});

app.post("/api/columns", requireAuth, (req, res) => {
  try {
    const column = createColumn({ name: req.body?.name });
    return res.json({ column });
  } catch (error) {
    return res.status(400).json({ message: error.message || "invalid column" });
  }
});

app.get("/api/clients", requireAuth, (_, res) => {
  const clients = listClients().map((item) => ({
    id: item.id,
    name: item.name,
    status: item.status,
    lastHeartbeatAt: item.lastHeartbeatAt
  }));
  return res.json({ clients });
});

app.post("/api/favorites/:fileId", requireAuth, (req, res) => {
  const favorite = toggleFavorite({ userId: req.auth.sub, fileId: req.params.fileId });
  return res.json({ favorite });
});

app.post("/api/files/:fileId/share", requireAuth, (req, res) => {
  const { fileId } = req.params;
  const { expiresInDays } = req.body || {};
  const file = getFileById(fileId);
  if (!file) {
    return res.status(404).json({ message: "file not found" });
  }
  const share = createFileShare({
    fileId,
    fileName: file.name,
    filePath: file.path,
    clientId: file.clientId,
    createdByUserId: req.auth.sub,
    createdByDisplayName: req.auth.displayName,
    expiresInDays: expiresInDays || null
  });
  const shareOrigin = resolveShareWebOrigin(req);
  const shareUrl = `${trimTrailingSlash(shareOrigin)}/share.html?share=${encodeURIComponent(share.id)}`;
  serverLog("file-share-create", req.reqId, share.id, fileId);
  return res.json({ share: enrichShareRecord(share, req), shareUrl });
});

app.get("/api/shares", requireAuth, (req, res) => {
  const items = listFileShares()
    .filter((item) => req.auth.role === "admin" || item.createdByUserId === req.auth.sub)
    .sort((left, right) => (right.createdAt || "").localeCompare(left.createdAt || ""))
    .map((item) => enrichShareRecord(item, req));
  return res.json({ shares: items });
});

app.post("/api/shares/:shareId/revoke", requireAuth, (req, res) => {
  const share = listFileShares().find((item) => item.id === req.params.shareId);
  if (!share) {
    return res.status(404).json({ message: "share not found" });
  }
  if (req.auth.role !== "admin" && share.createdByUserId !== req.auth.sub) {
    return res.status(403).json({ message: "forbidden" });
  }
  const revoked = revokeFileShare(req.params.shareId, req.auth.sub);
  return res.json({ share: enrichShareRecord(revoked, req) });
});

app.delete("/api/shares/:shareId", requireAuth, (req, res) => {
  const share = listFileShares().find((item) => item.id === req.params.shareId);
  if (!share) {
    return res.status(404).json({ message: "share not found" });
  }
  if (req.auth.role !== "admin" && share.createdByUserId !== req.auth.sub) {
    return res.status(403).json({ message: "forbidden" });
  }
  const deleted = deleteFileShare(req.params.shareId);
  return res.json({ share: deleted, ok: true });
});

app.get("/api/share/:shareId", (req, res) => {
  const { shareId } = req.params;
  const result = resolveShareAccess(shareId);
  if (!result) {
    return res.status(404).json({ message: "share not found or expired" });
  }
  const { share, file, meta, client } = result;
  const shareToken = signShareToken(share, {
    ...file,
    mimeType: meta.mimeType || file.mimeType
  });
  const enrichedFile = {
    ...file,
    columnId: meta.columnId || "",
    folderPath: meta.folderPath || "",
    mimeType: meta.mimeType || file.mimeType,
    originalMimeType: file.mimeType
  };
  serverLog("file-share-access", shareId, file.id, `accessCount=${share.accessCount || 1}`);
  return res.json({
    file: enrichedFile,
    share: {
      ...share,
      status: getShareStatus(share),
      shareUrl: `${trimTrailingSlash(resolveShareWebOrigin(req))}/share.html?share=${encodeURIComponent(share.id)}`,
      accessCount: share.accessCount ?? 0
    },
    shareToken,
    client: client
      ? {
          id: client.id,
          name: client.name,
          status: client.status,
          lastHeartbeatAt: client.lastHeartbeatAt
        }
      : null
  });
});

app.post("/api/upload/prepare", requireAuth, (req, res) => {
  const { clientId, relativePath, mimeType, size } = req.body;
  if (!clientId || !relativePath) {
    return res.status(400).json({ message: "clientId/relativePath required" });
  }
  return res.json({
    mode: "p2p",
    instruction: "use-webrtc-datachannel",
    clientId,
    relativePath,
    mimeType,
    size
  });
});

app.get("/api/upload-jobs", requireAuth, (req, res) => {
  serverLog("upload-jobs-list", req.reqId, req.auth.sub);
  finalizeStaleUploadingJobs(2 * 60 * 1000);
  const jobs = listUploadJobs()
    .filter((job) => job.status === "uploading")
    .slice(0, 120);
  return res.json({ jobs });
});

app.post("/api/upload-jobs/start", requireAuth, (req, res) => {
  const { clientId, fileName, relativePath, size, mimeType, columnId, folderPath } = req.body || {};
  if (!clientId || !relativePath || !fileName) {
    return res.status(400).json({ message: "clientId/fileName/relativePath required" });
  }
  const fileId = `${clientId}:${relativePath}`;
  if (columnId || folderPath) {
    upsertFileMeta(fileId, { columnId: columnId || "", folderPath: folderPath || "" });
  }
  const job = createUploadJob({
    createdByUserId: req.auth.sub,
    createdByDisplayName: req.auth.displayName,
    clientId,
    fileName,
    relativePath,
    size,
    mimeType
  });
  serverLog("upload-job-start", req.reqId, job.id, job.clientId, job.relativePath, job.size);
  return res.json({ job });
});

app.post("/api/upload-jobs/:jobId/progress", requireAuth, (req, res) => {
  const { progress, transferredBytes, message } = req.body || {};
  const updated = updateUploadJobProgress(req.params.jobId, { progress, transferredBytes, message });
  if (!updated) {
    return res.status(404).json({ message: "job not found" });
  }
  serverLog("upload-job-progress", req.reqId, updated.id, updated.progress, updated.transferredBytes);
  return res.json({ job: updated });
});

app.post("/api/upload-jobs/:jobId/finish", requireAuth, (req, res) => {
  const done = finishUploadJob(req.params.jobId, { message: req.body?.message });
  if (!done) {
    return res.status(404).json({ message: "job not found" });
  }
  serverLog("upload-job-finish", req.reqId, done.id, done.clientId, done.relativePath);
  return res.json({ job: done });
});

app.post("/api/upload-jobs/:jobId/fail", requireAuth, (req, res) => {
  const failed = failUploadJob(req.params.jobId, { message: req.body?.message });
  if (!failed) {
    return res.status(404).json({ message: "job not found" });
  }
  serverLog("upload-job-fail", req.reqId, failed.id, failed.message);
  return res.json({ job: failed });
});

app.post("/api/admin/clients/register", (req, res) => {
  const { registrationKey, name } = req.body;
  if (!name || !registrationKey) {
    return res.status(400).json({ message: "name and registrationKey required" });
  }
  if (registrationKey !== process.env.CLIENT_REGISTRATION_KEY) {
    return res.status(401).json({ message: "invalid registration key" });
  }
  const client = registerClient({ name });
  const token = signClientToken(client);
  serverLog("client-register", req.reqId, client.id, client.name);
  return res.json({ token, client });
});

app.post("/api/client/heartbeat", requireAuth, requireRole("client"), (req, res) => {
  const client = touchClient(req.auth.sub, "online", req.body?.name);
  if (!client) {
    return res.status(404).json({ message: "client not found" });
  }
  serverLog("client-heartbeat", req.reqId, client.id, client.status, client.lastHeartbeatAt);
  return res.json({ ok: true, client });
});

app.post("/api/client/files-meta", requireAuth, requireRole("client"), (req, res) => {
  const fileId = String(req.body?.fileId || "").trim();
  if (!fileId) {
    return res.status(400).json({ message: "fileId is required" });
  }
  const patch = req.body?.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return res.status(400).json({ message: "patch must be a non-null object" });
  }
  const ALLOWED_META_FIELDS = ["aiSummary", "subtitleCachePath", "columnId", "folderPath", "mimeType", "tags"];
  const sanitized = {};
  for (const key of ALLOWED_META_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sanitized[key] = patch[key];
    }
  }
  const meta = upsertFileMeta(fileId, sanitized);
  serverLog("client-files-meta", req.reqId, req.auth.sub, fileId);
  return res.json({ ok: true, fileId, meta });
});

app.post("/api/client/filesync", requireAuth, requireRole("client"), (req, res) => {
  const files = Array.isArray(req.body.files) ? req.body.files : [];
  const directories = Array.isArray(req.body.directories) ? req.body.directories : [];
  const now = new Date().toISOString();
  const sanitized = files
    .filter((item) => item.path)
    .map((item) => ({
      path: item.path,
      name: item.name ?? path.basename(item.path),
      size: Number(item.size ?? 0),
      mimeType: item.mimeType ?? "application/octet-stream",
      createdAt: item.createdAt ?? item.updatedAt ?? now,
      updatedAt: item.updatedAt ?? item.createdAt ?? now
    }));
  const sanitizedDirectories = directories
    .filter((item) => item.path)
    .map((item) => ({
      path: item.path,
      name: item.name ?? path.basename(item.path),
      createdAt: item.createdAt ?? item.updatedAt ?? now,
      updatedAt: item.updatedAt ?? item.createdAt ?? now
    }));
  const saved = replaceClientFiles(req.auth.sub, sanitized);
  const savedDirectories = replaceClientDirectories(req.auth.sub, sanitizedDirectories);
  serverLog("client-filesync", req.reqId, req.auth.sub, `files=${saved.length}`, `dirs=${savedDirectories.length}`);
  return res.json({ count: saved.length, directoryCount: savedDirectories.length });
});

app.get("/api/admin/users", requireAuth, requireRole("admin"), (_, res) => {
  const users = listUsers().map((item) => ({
    ...serializeUser(item)
  }));
  return res.json({ users });
});

app.get("/api/admin/clients", requireAuth, requireRole("admin"), (_, res) => {
  return res.json({ clients: listClients() });
});

app.post("/api/admin/clients/:clientId/status", requireAuth, requireRole("admin"), (req, res) => {
  const { status } = req.body;
  if (!["online", "offline", "disabled"].includes(status)) {
    return res.status(400).json({ message: "invalid status" });
  }
  const client = setClientStatus(req.params.clientId, status);
  if (!client) {
    return res.status(404).json({ message: "client not found" });
  }
  return res.json({ client });
});

app.post("/api/dev/upload-relay", requireAuth, upload.single("file"), (req, res) => {
  return res.json({
    mode: "not-recommended",
    filename: req.file?.originalname,
    bytes: req.file?.size ?? 0,
    note: "Large files should use p2p mode"
  });
});

// ─── Anime CMS stream finder ───────────────────────────────────────────────────
// GET /api/anime/find-stream?name=NAME&ep=N
// Tries multiple 苹果CMS v10 anime sites, returns {sources:[{site,ep,url,playUrl}]}
// Verified 苹果CMS v10 compatible sites (all expose /api.php/provide/vod/)
// Try to extract a direct video URL from a VIP player HTML page.
// Many Chinese VIP players embed the stream URL as a JS variable or JSON field.
function extractVideoUrlFromHtml(html, sourceUrl) {
  // Pattern 1: URL encoded in query param of the source URL itself
  // e.g., https://jx.some-player.com/?url=https://cdn.example.com/video.m3u8
  try {
    const u = new URL(sourceUrl);
    for (const p of ["url", "v", "src", "video", "link", "play", "uri", "href"]) {
      const val = u.searchParams.get(p);
      if (!val) continue;
      let decoded = val;
      try { decoded = decodeURIComponent(val); } catch {}
      if (/^https?:\/\//i.test(decoded)) return decoded;
      // Try base64 decode (common in some VIP players)
      try {
        const b64 = Buffer.from(decoded, "base64").toString("utf-8");
        if (/^https?:\/\//i.test(b64)) return b64;
      } catch {}
    }
  } catch {}
  // Pattern 2: URL in JS variable or JSON
  const patterns = [
    /['"](https?:\/\/[^'"]{15,}\.m3u8(?:\?[^'"]{0,300})?)['"]/i,
    /['"](https?:\/\/[^'"]{15,}\.mp4(?:\?[^'"]{0,300})?)['"]/i,
    /"url"\s*:\s*"(https?:\/\/[^"]{15,})"/i,
    /url\s*[:=]\s*["'](https?:\/\/[^"']{15,}(?:\.m3u8|\.mp4)[^"']{0,300})["']/i,
    /src\s*[:=]\s*["'](https?:\/\/[^"']{15,}(?:\.m3u8|\.mp4)[^"']{0,300})["']/i,
    // player_aaaa / player_data config objects used by many CMS themes
    /var\s+player[_a-z]*\s*=\s*\{[^}]{0,600}["']url["']\s*:\s*["'](https?:\/\/[^"']{15,})["']/i,
    // file or stream field in JSON blobs
    /"(?:file|stream|hls|video_url|videoUrl|playUrl|play_url)"\s*:\s*"(https?:\/\/[^"]{15,})"/i,
    // dplayer / artplayer config
    /url\s*:\s*["'](https?:\/\/[^"']{15,}(?:m3u8|mp4)[^"']{0,300})["']/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return null;
}

// If a URL looks like a VIP player wrapper that embeds the real URL as a query param,
// extract that inner URL. Returns { url, referer } where referer is the player's origin
// (to be used as the Referer header when fetching the real stream).
function tryResolveEpisodeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const p = u.pathname.toLowerCase();
    // If the path itself is a direct video file, return as-is
    if (/\.(m3u8|mp4|flv|ts|mkv)(\/|$)/i.test(p)) return { url: rawUrl, referer: null };
    // Check if it looks like a player/VIP wrapper URL
    const looksLikePlayer = /\/(jx|player|vip|play|parse|dplayer|nplayer|ckplayer|oplayer)\b/i.test(p)
      || /^(jx|vip|m3u8)\./i.test(u.hostname)
      || u.search.includes("url=")
      || u.search.includes("&v=") || u.search.startsWith("?v=");
    if (!looksLikePlayer) return { url: rawUrl, referer: null };
    const playerReferer = `${u.protocol}//${u.host}/`;
    for (const param of ["url", "v", "src", "video", "link", "play", "uri", "href", "x"]) {
      const val = u.searchParams.get(param);
      if (!val) continue;
      let decoded = val;
      try { decoded = decodeURIComponent(val); } catch {}
      if (/^https?:\/\//i.test(decoded)) return { url: decoded, referer: playerReferer };
      // Try base64 decode (some VIP players encode the URL in base64)
      try {
        const b64 = Buffer.from(decoded, "base64").toString("utf-8");
        if (/^https?:\/\//i.test(b64)) return { url: b64, referer: playerReferer };
      } catch {}
    }
  } catch {}
  return { url: rawUrl, referer: null };
}

// True if url still looks like a 3rd-party VIP player page, not a direct stream
function isVipPlayerUrl(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    if (/\.(m3u8|mp4|flv|ts|mkv)(\/|$)/i.test(p)) return false;
    return /\/(jx|player|vip|play|parse|dplayer|nplayer|ckplayer|oplayer)\b/i.test(p)
      || /^(jx|vip|m3u8)\./i.test(u.hostname)
      || u.search.includes("url=")
      || u.search.includes("&v=") || u.search.startsWith("?v=");
  } catch {}
  return false;
}

// Fallback hardcoded list — used when subscription fetch fails
const CMS_ANIME_SITES_FALLBACK = [
  { name: "omofun",    base: "https://enlienli.link" },
  { name: "风铃动漫",  base: "https://www.aafun.cc" },
  { name: "叽哔动漫",  base: "https://www.jibi.cc" },
  { name: "E-ACG",     base: "https://eacg.net" },
  { name: "稀饭动漫",  base: "https://dm1.xfdm.pro" },
  { name: "森之屋动漫",base: "https://senfun.in" },
  { name: "去看吧",    base: "https://11kt.net" },
  { name: "海星动漫",  base: "https://www.haixingdmx.com" },
  { name: "酱紫社",    base: "http://www.jzsdm1.com" },
  { name: "樱花动漫",  base: "https://yhdm6go.top" },
  { name: "第一动漫",  base: "https://1anime2025.me" },
  { name: "米粒动漫",  base: "https://milimili.nl" },
  { name: "萌道动漫",  base: "https://www.gpjda.com" },
  { name: "UZVOD",     base: "https://uzvod.com" },
  { name: "嘀哩嘀哩",  base: "https://dilidili.io" },
  { name: "2k动漫",    base: "https://www.2kdm.org" },
  { name: "新优酷",    base: "https://www.youknow.tv" },
  { name: "girigiri",  base: "https://anime.girigirilove.icu" },
  { name: "风车动漫",  base: "https://vdm10.com" },
  { name: "趣动漫",    base: "https://www.qdm8.com" },
  { name: "咕咕番",    base: "https://www.gugu3.com" },
  { name: "喵物次元",  base: "https://www.mwcy.net" },
  { name: "虾皮动漫",  base: "https://xiapidm.com" },
  { name: "漫次元",    base: "https://www.mcydh.com" },
  { name: "蜜桃动漫",  base: "https://www.mitaodm.com" },
  { name: "次元城动画",base: "https://www.cyc-anime.net" },
  { name: "MX动漫",    base: "https://www.mxdm.xyz" },
  { name: "动漫蛋",    base: "https://www.dmdan8.com" },
  { name: "饭团动漫",  base: "https://acgfta.com" },
  { name: "番茄动漫",  base: "https://www.fqdm.cc" },
];

// Dynamic subscription loader — fetches animeko's datasource subscriptions.
// The css1.json format mirrors animeko's web-selector entries with searchUrl hosting
// the same 苹果CMS sites we query via JSON API (/api.php/provide/vod/).
const SUB_ONLINE_URL = "https://sub.creamycake.org/v1/css1.json";
let subSitesCache = null;
let subSitesCacheTime = 0;
const SUB_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function loadSubscriptionSites(forceRefresh = false) {
  if (!forceRefresh && subSitesCache && Date.now() - subSitesCacheTime < SUB_CACHE_TTL_MS) {
    return subSitesCache;
  }
  try {
    const r = await fetch(SUB_ONLINE_URL, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": CMS_HEADERS["User-Agent"] },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const mediaSources = data?.exportedMediaSourceDataList?.mediaSources ?? [];
    const sites = mediaSources
      .filter((entry) => entry?.factoryId === "web-selector" && entry?.arguments?.searchConfig?.searchUrl)
      .map((entry) => {
        const name = String(entry.arguments.name || "").trim();
        const searchUrl = String(entry.arguments.searchConfig.searchUrl || "");
        let base = "";
        try {
          const u = new URL(searchUrl.replace("{keyword}", "test"));
          base = `${u.protocol}//${u.host}`;
        } catch { /* skip */ }
        return name && base ? { name, base, selectors: extractSelectorConfig(entry.arguments.searchConfig) } : null;
      })
      .filter(Boolean);
    if (sites.length > 0) {
      subSitesCache = sites;
      subSitesCacheTime = Date.now();
      console.log(`[anime] Loaded ${sites.length} sites from subscription`);
      return sites;
    }
    throw new Error("empty subscription list");
  } catch (e) {
    console.warn(`[anime] Subscription fetch failed (${e.message}), using fallback list`);
    if (!subSitesCache) subSitesCache = CMS_ANIME_SITES_FALLBACK;
    // Retry the subscription after 5 minutes, not on every request
    subSitesCacheTime = Date.now() - (SUB_CACHE_TTL_MS - 5 * 60 * 1000);
    return subSitesCache;
  }
}

// Extract per-site CSS selector config from an animeko web-selector searchConfig.
// Mirrors the full SelectorSearchConfig structure: both subject format (search result parsing)
// and channel format (detail page episode parsing).
function extractSelectorConfig(searchConfig) {
  if (!searchConfig?.searchUrl) return null;

  // Subject format — mirrors SelectorSubjectFormat in animeko (how to parse search result HTML)
  const subjectFormatId = searchConfig.subjectFormatId || "a";
  let subject = null;
  if (subjectFormatId === "a") {
    const cfg = searchConfig.selectorSubjectFormatA;
    if (cfg?.selectLists) subject = { format: "a", selectLists: cfg.selectLists, preferShorterName: cfg.preferShorterName !== false };
  } else if (subjectFormatId === "indexed") {
    const cfg = searchConfig.selectorSubjectFormatIndexed;
    if (cfg?.selectNames && cfg?.selectLinks)
      subject = { format: "indexed", selectNames: cfg.selectNames, selectLinks: cfg.selectLinks, preferShorterName: cfg.preferShorterName !== false };
  }

  // Channel format — mirrors SelectorChannelFormat in animeko (how to parse detail page)
  const channelFormatId = searchConfig.channelFormatId;
  let channel = null;
  if (channelFormatId === "index-grouped") {
    const cfg = searchConfig.selectorChannelFormatFlattened;
    if (cfg?.selectEpisodeLists) {
      channel = {
        format: "index-grouped",
        selectChannelNames: cfg.selectChannelNames || "",
        matchChannelName: cfg.matchChannelName || "",       // regex: extract "ch" group; null match → skip channel
        selectEpisodeLists: cfg.selectEpisodeLists,
        selectEpisodesFromList: cfg.selectEpisodesFromList || "a",
        selectEpisodeLinksFromList: cfg.selectEpisodeLinksFromList || "", // separate link selector
        matchEpisodeSortFromName: cfg.matchEpisodeSortFromName || "",
      };
    }
  } else if (channelFormatId === "no-channel") {
    const cfg = searchConfig.selectorChannelFormatNoChannel;
    if (cfg?.selectEpisodes) {
      channel = {
        format: "no-channel",
        selectEpisodes: cfg.selectEpisodes,
        selectEpisodeLinks: cfg.selectEpisodeLinks || "",   // separate link selector
        matchEpisodeSortFromName: cfg.matchEpisodeSortFromName || "",
      };
    }
  }

  return {
    searchUrl: searchConfig.searchUrl,
    // Animeko's Kotlin defaults: both are true when absent from JSON.
    // Only treat as false when explicitly set to false.
    searchUseOnlyFirstWord: searchConfig.searchUseOnlyFirstWord !== false,
    searchRemoveSpecial: searchConfig.searchRemoveSpecial !== false,
    subject,
    channel,
  };
}

// Mirror animeko's MediaListFilters.removeSpecials + MediaSourceEngineHelpers.getSearchKeyword.
// Animeko's removeSpecials is a 5-stage character processing pipeline; we replicate the key parts:
// 1. Keep-word masking ("Re：" etc.)
// 2. Unconditional marker removal ("电影","剧场版","OVA","OAD","总集篇")
// 3. Position-aware special char handling (delete/replace-with-space after minimumLength non-specials)
// 4. Number replacement (Chinese/Roman → Arabic, context-aware)
// 5. Whitespace cleanup + mask restoration
const _CHARS_TO_DELETE = new Set([...`"""`].map(c => c.codePointAt(0)));
const _CHARS_TO_REPLACE_WS = new Set(
  [...`。、，·・[]～""~—-!@#$%^&*()_+{}|\\;':",.<>/?【】：「」！`].map(c => c.codePointAt(0))
);
const _KEEP_WORDS = [{ original: "Re：", mask: "\uE0010\uE002" }];
const _MIN_NONSPECIAL = 2;

function removeSpecials(str, { removeWhitespace = false, replaceNumbers = false, removeMarkers = false } = {}) {
  // Stage 1: mask keep-words
  let s = str;
  for (const kw of _KEEP_WORDS) s = s.replaceAll(kw.original, kw.mask);

  // Stage 2: unconditional marker removal
  if (removeMarkers) {
    s = s.replace(/电影|剧场版|OVA|OAD|总集篇/gi, "");
  }

  // Stage 3: position-aware special char handling
  let result = "";
  let nonSpecialCount = 0;
  let canProcess = false;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    const isDel = _CHARS_TO_DELETE.has(code);
    const isRepl = _CHARS_TO_REPLACE_WS.has(code);
    if (isDel || isRepl) {
      if (nonSpecialCount === 0 || canProcess) {
        if (isDel) { /* skip */ }
        else if (isRepl) result += " ";
      } else {
        result += ch; // not enough non-specials yet — keep as-is
      }
    } else {
      result += ch;
      nonSpecialCount++;
      if (!canProcess && nonSpecialCount >= _MIN_NONSPECIAL) canProcess = true;
    }
  }

  // Stage 4: number replacement (Chinese/Roman → Arabic)
  if (replaceNumbers) {
    const numMap = { "十":"10","九":"9","八":"8","七":"7","六":"6","五":"5","四":"4","三":"3","二":"2","一":"1",
      "X":"10","IX":"9","VIII":"8","VII":"7","VI":"6","V":"5","IV":"4","III":"3","II":"2","I":"1" };
    result = result.replace(/十|九|八|七|六|五|四|三|二|一|VIII|VII|IV|IX|VI|III|II|X|V|I/g, (m, off) => {
      // Context-aware: don't replace Chinese numbers inside words like "五等分の花嫁"
      const isChinese = /^[一二三四五六七八九十]$/.test(m);
      if (isChinese) {
        const prev = off > 0 ? result[off - 1] : "";
        const next = off + m.length < result.length ? result[off + m.length] : "";
        if (off === 0 && /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(next)) return m;
        if (prev && prev !== "第" && /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(prev)) return m;
      }
      // Don't replace "V" in "OVA"
      if (m === "V") {
        const prevCh = off > 0 ? result[off - 1] : "";
        const nextCh = off + 1 < result.length ? result[off + 1] : "";
        if (/[Oo]/.test(prevCh) && /[Aa]/.test(nextCh)) return m;
      }
      return numMap[m] || m;
    });
  }

  // Stage 5: whitespace cleanup + mask restoration
  if (removeWhitespace) {
    result = result.replace(/[\s\u3000]+/g, "");
  }
  result = result.trim();
  for (const kw of _KEEP_WORDS) result = result.replaceAll(kw.mask, kw.original);
  return result;
}

// Common traditional→simplified CJK conversions for anime titles.
// Applied to search keywords so traditional Chinese names match simplified-indexed sites.
const _T2S_MAP = {
  "蓮":"莲","劍":"剑","戰":"战","國":"国","體":"体","靈":"灵",
  "術":"术","學":"学","覺":"觉","發":"发","時":"时","來":"来",
  "應":"应","傳":"传","繪":"绘","進":"进","見":"见","說":"说",
  "還":"还","話":"话","對":"对","處":"处","實":"实","現":"现",
  "無":"无","開":"开","團":"团","請":"请","愛":"爱","從":"从",
  "關":"关","門":"门","長":"长","書":"书","風":"风","記":"记",
  "動":"动","機":"机","樂":"乐","東":"东","車":"车","電":"电",
  "鳳":"凤","華":"华","龍":"龙","鬥":"斗","魔":"魔","聖":"圣",
  "與":"与","這":"这","為":"为","將":"将","後":"后","個":"个",
};
const _T2S_RE = new RegExp(Object.keys(_T2S_MAP).join("|"), "g");
function toSimplified(s) { return s.replace(_T2S_RE, m => _T2S_MAP[m] || m); }

// Mirror animeko's getSearchKeyword: removeSpecials(forSearch) + optionally take first word.
function buildSearchKeyword(keyword, useOnlyFirstWord, removeSpecial) {
  let kw = keyword;
  if (removeSpecial) {
    kw = removeSpecials(kw, { removeMarkers: true });
    // Also collapse multi-space into single space for clean splitting
    kw = kw.replace(/\s+/g, " ").trim();
  }
  if (useOnlyFirstWord) kw = kw.split(/\s+/)[0] || kw;
  // Convert traditional Chinese to simplified for better site compatibility
  kw = toSimplified(kw);
  return kw;
}

// Resolve a potentially relative href against a base URL.
// Mirrors animeko's SelectorHelpers.computeAbsoluteUrl (= UrlHelpers.computeAbsoluteUrl):
//   - absolute href (starts with /) → use protocol+host only (standard browser resolution)
//   - scheme-relative (starts with //) → prepend https:
//   - relative → append to base directory
function resolveUrl(base, href) {
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) {
    // Absolute path — use host only, NOT the full base path
    try {
      const u = new URL(base);
      return `${u.protocol}//${u.host}${href}`;
    } catch {
      // fallback: strip everything after last slash
      return base.replace(/\/[^/]*$/, "") + href;
    }
  }
  // Relative path — append to base directory
  return base.replace(/\/$/, "") + "/" + href;
}

// Mirror animeko's guessIdFromUrl — extract CMS vod_id from a detail page URL.
// e.g. "/vod/detail/id/12345.html" → "12345", "/vod/12345" → "12345"
function guessIdFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    return path.replace(/\/$/, "").replace(/\.html$/, "").split("/").pop() || "";
  } catch { return ""; }
}

// Use subscription searchUrl + subject CSS selectors to find matching subjects.
// Mirrors SelectorMediaSourceEngine.searchSubjects + selectSubjects in animeko.
// Returns [{name, fullUrl}] or null.
async function htmlSearchSubjects(selectors, keyword, base, signal) {
  if (!selectors.subject) return null;
  const kw = buildSearchKeyword(keyword, selectors.searchUseOnlyFirstWord, selectors.searchRemoveSpecial);
  const searchUrl = selectors.searchUrl.replace("{keyword}", encodeURIComponent(kw));

  let r;
  try {
    r = await fetch(searchUrl, { signal, headers: { ...CMS_HEADERS, "Referer": base, "Accept": "text/html,*/*" } });
  } catch { return null; }
  const text = await r.text().catch(() => "");
  if (!r.ok || detectCloudflarePage(text, r.status)) return null;

  const cheerio = await loadCheerio();
  if (!cheerio) return null;
  const $ = cheerio.load(text);

  const candidates = [];
  if (selectors.subject.format === "a") {
    $(selectors.subject.selectLists).each((_, el) => {
      const $el = $(el);
      const name = $el.attr("title")?.trim() || $el.text().trim();
      const fullUrl = resolveUrl(base, $el.attr("href") || "");
      if (name && fullUrl) candidates.push({ name, fullUrl });
    });
  } else if (selectors.subject.format === "indexed") {
    const names = $(selectors.subject.selectNames).map((_, el) => $(el).text().trim()).get().filter(Boolean);
    const links = $(selectors.subject.selectLinks).map((_, el) => $(el).attr("href") || "").get().filter(Boolean);
    const count = Math.min(names.length, links.length);
    for (let i = 0; i < count; i++) {
      const fullUrl = resolveUrl(base, links[i]);
      if (names[i] && fullUrl) candidates.push({ name: names[i], fullUrl });
    }
  }
  if (selectors.subject.preferShorterName && candidates.length > 1) {
    candidates.sort((a, b) => a.name.length - b.name.length);
  }

  // Generic fallback: when CSS selectors matched 0 candidates but the page has real content,
  // scan all <a> tags for links whose text contains the search keyword.
  // This recovers results on sites where the subscription selectors are outdated or wrong.
  if (candidates.length === 0) {
    const lcKw = kw.toLowerCase();
    $("a[href]").each((_, el) => {
      const $el = $(el);
      const name = ($el.attr("title") || $el.text() || "").trim();
      const href = $el.attr("href") || "";
      if (!name || !href || name.length > 100) return;
      // Only consider links that contain the keyword and point to a detail-like page
      if (!name.toLowerCase().includes(lcKw)) return;
      // Filter out obvious navigation/non-detail links
      if (/^(javascript|#|mailto)/.test(href)) return;
      const fullUrl = resolveUrl(base, href);
      if (fullUrl) candidates.push({ name, fullUrl });
    });
    if (candidates.length > 0) {
      console.log(`[anime] generic fallback found ${candidates.length} candidates from <a> tags`);
    }
  }

  return candidates.length > 0 ? candidates : null;
}

const CMS_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
};

// Detect Cloudflare/WAF challenge pages (503 with HTML, or body with challenge markers)
function detectCloudflarePage(text, status) {
  const snip = (text || "").toLowerCase().slice(0, 3000);
  // Cloudflare always uses 503 for JS challenges; check body for CF specifics
  const cfBody = snip.includes("cf-browser-verification")
    || (snip.includes("cloudflare") && snip.includes("ray id"))
    || snip.includes("just a moment") && snip.includes("cloudflare");
  if (status === 503) return true; // CF always 503
  return cfBody;
}

// Fetch all search results (not just first). Returns { list, blocked }
async function cmsSearchAll(base, keyword, signal) {
  const url = `${base}/api.php/provide/vod/?ac=videolist&wd=${encodeURIComponent(keyword)}`;
  let r;
  try {
    r = await fetch(url, { signal, headers: { ...CMS_HEADERS, "Referer": base } });
  } catch { return { list: [], blocked: false }; }

  const text = await r.text().catch(() => "");
  if (!r.ok) return { list: [], blocked: detectCloudflarePage(text, r.status) };

  // Check for HTML response where we expected JSON
  if (detectCloudflarePage(text, r.status)) return { list: [], blocked: true };

  try {
    const data = JSON.parse(text);
    return { list: Array.isArray(data?.list) ? data.list : [], blocked: false };
  } catch {
    // JSON parse failed — check if it's an HTML challenge page
    return { list: [], blocked: detectCloudflarePage(text, r.status) };
  }
}

async function cmsDetail(base, id, signal) {
  try {
    const url = `${base}/api.php/provide/vod/?ac=detail&ids=${id}`;
    const r = await fetch(url, { signal, headers: { ...CMS_HEADERS, "Referer": base } });
    if (!r.ok) return null;
    const data = await r.json(); // may throw if response is HTML (e.g. Cloudflare)
    return data?.list?.[0] ?? null;
  } catch { return null; }
}

// Fetch the CMS HTML detail page and extract episode labels, channel names, and play URLs per route.
// detailUrl: if provided (from HTML search results), use it directly; otherwise construct from vodId.
// channelSelectors: the site's channel CSS selectors (site.selectors?.channel), or null for hardcoded fallback.
// Returns { episodeLabels: string[][], channelNames: string[], episodeUrls: string[][] } or null.
async function fetchCmsHtmlEpisodeLabels(base, vodId, channelSelectors, signal, detailUrl = null) {
  const url = detailUrl || `${base}/vod/detail/id/${vodId}.html`;
  // Compute base for resolving relative hrefs — drop the last path segment (file name)
  // mirrors animeko's dropLastPathSegment(detailUrl)
  const urlBase = getDetailPageBase(url, base);
  try {
    const r = await fetch(url, {
      signal,
      headers: { ...CMS_HEADERS, "Referer": base, "Accept": "text/html,application/xhtml+xml,*/*" },
    });
    if (!r.ok) return null;
    const html = await r.text();

    if (channelSelectors) {
      return await extractEpisodeLabelsWithSelectors(html, channelSelectors, urlBase);
    }
    return extractEpisodeLabelsHardcoded(html, urlBase);
  } catch {
    return null;
  }
}

// Returns the base URL for resolving hrefs on a detail page.
// Mirrors animeko's dropLastPathSegment: drop the filename, keep the directory.
// e.g. "https://eacg.net/voddetail/12345.html" → "https://eacg.net/voddetail/"
function getDetailPageBase(detailUrl, fallback) {
  try {
    const u = new URL(detailUrl);
    const pathParts = u.pathname.split("/").filter(Boolean);
    pathParts.pop(); // drop last segment (the filename or id)
    u.pathname = pathParts.length ? "/" + pathParts.join("/") + "/" : "/";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return fallback;
  }
}

// Mirrors animeko's Kotlin findGroupOrFullText(text, "ch") for matchChannelName regex:
//   - no regex → return text (use full text)
//   - regex doesn't match → return null (skip this channel)
//   - regex matches, has "ch" named group → return group value
//   - regex matches, no "ch" group → return full text
function applyChannelNameRegex(pattern, text) {
  if (!pattern) return text;
  let m;
  try { m = new RegExp(pattern).exec(text); } catch { return text; }
  if (!m) return null;      // no match → skip channel
  return m.groups?.ch !== undefined ? m.groups.ch : text;
}

// Use cheerio with animeko's per-site CSS selectors to extract episode labels + channel names.
// cheerio is loaded lazily so the server still starts even if npm install hasn't been run yet.
let _cheerio = null;
async function loadCheerio() {
  if (_cheerio) return _cheerio;
  try {
    _cheerio = await import("cheerio");
    return _cheerio;
  } catch {
    return null;
  }
}

// Use cheerio with animeko's per-site CSS selectors to extract episode labels, channel names, and play URLs.
// urlBase: base URL for resolving relative hrefs (from getDetailPageBase).
// Returns { episodeLabels: string[][], channelNames: string[], episodeUrls: string[][] } or null.
async function extractEpisodeLabelsWithSelectors(html, selectors, urlBase) {
  const cheerio = await loadCheerio();
  if (!cheerio) return null; // cheerio not installed → fall back to regex
  const $ = cheerio.load(html);

  // Resolve a relative href to an absolute URL using the detail page base
  function resolveHref(href) {
    if (!href || href === "#") return null;
    return resolveUrl(urlBase, href);
  }

  if (selectors.format === "index-grouped") {
    // Preserve index alignment: do NOT filter blanks — blank tabs still occupy an index slot
    // that must align 1:1 with the corresponding episode list.
    const rawChannelNames = selectors.selectChannelNames
      ? $(selectors.selectChannelNames).map((_, el) => $(el).text().trim()).get()
      : [];
    const lists = $(selectors.selectEpisodeLists).toArray();
    if (!lists.length) return null;

    const channelNames = [];
    const episodeLabels = [];
    const episodeUrls = [];

    const count = rawChannelNames.length > 0 ? Math.min(rawChannelNames.length, lists.length) : lists.length;
    for (let i = 0; i < count; i++) {
      // Apply matchChannelName: filter/rename channel
      const rawName = rawChannelNames[i] || `线路${i + 1}`;
      const channelName = applyChannelNameRegex(selectors.matchChannelName, rawName);
      if (channelName === null) continue; // skip filtered-out channel

      const container = lists[i];
      // selectEpisodesFromList: CSS for episode items (default: "a")
      const episodeSelector = selectors.selectEpisodesFromList || "a";
      const episodeEls = $(episodeSelector, container).toArray();

      const labels = [];
      const urls = [];
      for (const el of episodeEls) {
        const label = $(el).text().trim();
        if (!label) continue;

        // If selectEpisodeLinksFromList is set, find the link element relative to the episode item
        // Otherwise use the item itself (should be an <a>)
        let linkEl = el;
        if (selectors.selectEpisodeLinksFromList) {
          linkEl = $(selectors.selectEpisodeLinksFromList, el).first()[0] || el;
        }
        const href = $(linkEl).attr("href");
        labels.push(label);
        urls.push(resolveHref(href));
      }

      if (labels.length > 0) {
        channelNames.push(channelName);
        episodeLabels.push(labels);
        episodeUrls.push(urls);
      }
    }
    return episodeLabels.some((l) => l.length > 0) ? { episodeLabels, channelNames, episodeUrls } : null;
  }

  if (selectors.format === "no-channel") {
    const episodeEls = $(selectors.selectEpisodes).toArray();
    const labels = [];
    const urls = [];
    for (const el of episodeEls) {
      const label = $(el).text().trim();
      if (!label) continue;

      let linkEl = el;
      if (selectors.selectEpisodeLinks) {
        linkEl = $(selectors.selectEpisodeLinks, el).first()[0] || el;
      }
      const href = $(linkEl).attr("href");
      labels.push(label);
      urls.push(resolveHref(href));
    }
    return labels.length > 0 ? { episodeLabels: [labels], channelNames: [], episodeUrls: [urls] } : null;
  }

  return null;
}

// Fallback: hardcoded regex for the standard mxcms .anthology-list-box layout.
// Also extracts .anthology-tab channel names and episode play URL hrefs.
// urlBase: base for resolving relative hrefs.
function extractEpisodeLabelsHardcoded(html, urlBase) {
  // Extract channel names from tab bar
  const channelNames = [];
  const tabRe = /class="[^"]*anthology-tab[^"]*"[^>]*>([\s\S]*?)<\/(?:div|nav|ul)>/i;
  const tabMatch = tabRe.exec(html);
  if (tabMatch) {
    const aRe = /<a\b[^>]*>([^<]*)<\/a>/gi;
    let m;
    while ((m = aRe.exec(tabMatch[1])) !== null) {
      const text = m[1].trim();
      if (text) channelNames.push(text);
    }
  }

  const episodeLabels = [];
  const episodeUrls = [];
  const boxRe = /class="[^"]*anthology-list-box[^"]*"[^>]*>([\s\S]*?)<\/(?:div|ul)>/gi;
  let boxMatch;
  while ((boxMatch = boxRe.exec(html)) !== null) {
    const block = boxMatch[1];
    const labels = [];
    const urls = [];
    const aRe = /<a\b([^>]*)>([^<]*)<\/a>/gi;
    let aMatch;
    while ((aMatch = aRe.exec(block)) !== null) {
      const text = aMatch[2].trim();
      if (!text) continue;
      labels.push(text);
      // Extract href from attributes
      const hrefM = /\bhref="([^"]*)"/i.exec(aMatch[1]);
      const href = hrefM ? hrefM[1] : null;
      const resolved = href && href !== "#" ? resolveUrl(urlBase, href) : null;
      urls.push(resolved);
    }
    if (labels.length > 0) {
      episodeLabels.push(labels);
      episodeUrls.push(urls);
    }
  }
  return episodeLabels.length > 0 ? { episodeLabels, channelNames, episodeUrls } : null;
}

// Fetch a player page and extract the actual video stream URL from `var player_aaaa = {...}`.
// Mirrors what animeko does via WebView URL interception: we eagerly extract the URL from the player page JS.
// Returns { url, referer } or null.
async function resolvePlayerPageVideoUrl(playerPageUrl, siteBase, signal) {
  if (!playerPageUrl) return null;
  try {
    const r = await fetch(playerPageUrl, {
      signal,
      headers: { ...CMS_HEADERS, "Referer": siteBase, "Accept": "text/html,*/*" },
    });
    if (!r.ok) return null;
    const html = await r.text();

    // Most mxcms player pages embed: var player_aaaa = {"url":"https://..."}
    // Use brace counting to extract the full JSON object (handles nested structures).
    const aaaIdx = html.indexOf('player_aaaa');
    if (aaaIdx !== -1) {
      const startBrace = html.indexOf('{', aaaIdx);
      if (startBrace !== -1) {
        let depth = 0, i = startBrace;
        while (i < html.length) {
          if (html[i] === '{') depth++;
          else if (html[i] === '}') { depth--; if (depth === 0) break; }
          i++;
        }
        if (depth === 0) {
          try {
            const config = JSON.parse(html.slice(startBrace, i + 1));
            let streamUrl = config.url || config.url_next || config.link;
            if (streamUrl) {
              // Decode base64-encrypted URL (encrypt: 1 or "1" is the mxcms convention)
              if (config.encrypt === 1 || config.encrypt === "1") {
                try {
                  const decoded = Buffer.from(streamUrl, 'base64').toString('utf-8');
                  if (/^https?:\/\//i.test(decoded)) streamUrl = decoded;
                } catch {}
              }
              // Auto-detect base64: if URL doesn't start with http, try decoding
              if (!/^https?:\/\//i.test(streamUrl)) {
                try {
                  const decoded = Buffer.from(streamUrl, 'base64').toString('utf-8');
                  if (/^https?:\/\//i.test(decoded)) streamUrl = decoded;
                } catch {}
              }
              if (/^https?:\/\//i.test(streamUrl)) {
                return { url: streamUrl, referer: playerPageUrl };
              }
            }
          } catch { /* fall through to raw URL search */ }
        }
      }
    }

    // Fallback: find any m3u8 or mp4 URL in the page HTML
    const urlRe = /https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)(?:[?#][^\s"'<>]*)?/gi;
    const found = html.match(urlRe);
    if (found?.length) return { url: found[0], referer: playerPageUrl };

    return null;
  } catch {
    return null;
  }
}

// Build routes from HTML episode data (when cmsDetail API is unavailable).
// Resolves each episode's player page URL to an actual stream URL in parallel.
// Returns routes array in the same format as parseCmsPlayUrl produces.
async function buildHtmlRoutes(htmlEpLabels, siteBase, signal) {
  const { episodeLabels, channelNames, episodeUrls } = htmlEpLabels;
  const routes = [];

  for (let ri = 0; ri < episodeLabels.length; ri++) {
    const routeName = channelNames[ri] || `线路${ri + 1}`;
    const labels = episodeLabels[ri] || [];
    const playerUrls = episodeUrls?.[ri] || [];

    // Resolve player pages concurrently (cap at 10 parallel to avoid hammering)
    const BATCH = 10;
    const episodes = [];
    for (let start = 0; start < labels.length; start += BATCH) {
      const batch = labels.slice(start, start + BATCH);
      const urlBatch = playerUrls.slice(start, start + BATCH);
      const resolved = await Promise.all(
        batch.map((label, bi) => resolvePlayerPageVideoUrl(urlBatch[bi], siteBase, signal))
      );
      for (let bi = 0; bi < batch.length; bi++) {
        const label = batch[bi];
        const stream = resolved[bi];
        if (!stream?.url) continue;
        const epNum = parseEpLabel(label) ?? (start + bi + 1);
        const type = /\.(mp4|flv|mkv)(\?|$)/i.test(stream.url) ? "mp4" : "hls";
        const { url: finalUrl, referer: vipReferer } = tryResolveEpisodeUrl(stream.url);
        const vipWrapped = isVipPlayerUrl(finalUrl);
        episodes.push({ ep: epNum, label, url: finalUrl, type, vipWrapped, referer: vipReferer || siteBase });
      }
    }
    if (episodes.length > 0) routes.push({ route: routeName, episodes });
  }
  return routes;
}

// Strip trailing season markers so "葬送的芙莉蓮 第二季" → "葬送的芙莉蓮"
function stripSeason(title) {
  return title
    .replace(/\s*第[一二三四五六七八九十百\d]+[季期]\s*$/, "")
    .replace(/\s*Season\s*\d+\s*$/i, "")
    .replace(/\s*第\d+期\s*$/, "")
    .trim();
}

// Normalize for fuzzy comparison: lowercase, Japanese particles → Chinese equivalents,
// common traditional→simplified CJK pairs, then strip non-alphanumeric.
function normTitle(s) {
  return String(s || "")
    .toLowerCase()
    // Japanese genitive particle frequently appears in CMS-stored anime titles
    .replace(/の/g, "的")
    // Common traditional→simplified pairs seen in anime titles
    .replace(/蓮/g, "莲").replace(/劍/g, "剑").replace(/戰/g, "战")
    .replace(/國/g, "国").replace(/體/g, "体").replace(/靈/g, "灵")
    .replace(/術/g, "术").replace(/學/g, "学").replace(/覺/g, "觉")
    .replace(/發/g, "发").replace(/時/g, "时").replace(/來/g, "来")
    .replace(/應/g, "应").replace(/傳/g, "传").replace(/繪/g, "绘")
    .replace(/進/g, "进").replace(/見/g, "见").replace(/說/g, "说")
    .replace(/還/g, "还").replace(/話/g, "话").replace(/對/g, "对")
    .replace(/處/g, "处").replace(/實/g, "实").replace(/現/g, "现")
    .replace(/無/g, "无").replace(/開/g, "开").replace(/團/g, "团")
    .replace(/請/g, "请").replace(/愛/g, "爱").replace(/從/g, "从")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

// Score how well a CMS title matches the expected title (0-100)
function titleScore(cmsTitle, expected) {
  // Normalize both titles using removeSpecials (like animeko) before comparison
  const aCleaned = removeSpecials(cmsTitle, { removeWhitespace: true, replaceNumbers: true });
  const bCleaned = removeSpecials(expected, { removeWhitespace: true, replaceNumbers: true });
  const a = normTitle(aCleaned);
  const b = normTitle(bCleaned);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 80;
  // character overlap ratio
  const setA = new Set([...a]);
  const common = [...b].filter((c) => setA.has(c)).length;
  return Math.floor((common / b.length) * 60);
}

// Pick the best matching result from a list of CMS hits.
// When the query has a season suffix (e.g. "第二季"), prefer matching the full
// name (with season) over the stripped name — prevents S1 entries from beating S2.
function pickBestHit(hits, fullName, minScore = 40) {
  if (!hits.length) return null;
  const stripped = stripSeason(fullName);
  const isSeasonSearch = stripped !== fullName; // query has a season marker
  let best = null, bestScore = -1;
  for (const h of hits) {
    const scoreFull = titleScore(h.vod_name, fullName);
    const scoreStripped = titleScore(h.vod_name, stripped);
    // If this is a season search, weight the full-name score more heavily so
    // "葬送の芙莉蓮第二季" (100 vs full) beats "葬送の芙莉蓮" (100 vs stripped).
    const s = isSeasonSearch
      ? (scoreFull >= 40 ? scoreFull : scoreStripped * 0.7)
      : Math.max(scoreFull, scoreStripped);
    if (s > bestScore) { bestScore = s; best = h; }
  }
  return bestScore >= minScore ? best : null;
}

// Parse an episode number from a CMS label like "第15集", "EP5", "5", "0.5"
function parseEpLabel(label) {
  if (!label) return null;
  let m = /第\s*(\d+(?:\.\d+)?)\s*[集话]/i.exec(label);
  if (m) return parseFloat(m[1]);
  m = /[Ee][Pp]?\s*(\d+(?:\.\d+)?)/.exec(label);
  if (m) return parseFloat(m[1]);
  m = /^[\s\u3000]*(\d+(?:\.\d+)?)[\s\u3000]*$/.exec(label);
  if (m) return parseFloat(m[1]);
  return null;
}

// Returns all routes, each with all their episode URLs
// vod_play_url format: "EP01$url|EP02$url$$$线路2_EP01$url|..."
// siteBase: the CMS site origin used as fallback Referer for direct CDN URLs
function parseAllRoutes(vodPlayUrl, vodPlayFrom, siteBase) {
  if (!vodPlayUrl) return [];
  const routes = [];
  const urlRoutes = vodPlayUrl.split("$$$");
  const fromRoutes = vodPlayFrom ? vodPlayFrom.split("$$$") : [];
  const defaultReferer = siteBase ? siteBase.replace(/\/$/, "") + "/" : "";
  urlRoutes.forEach((routeStr, ri) => {
    const routeName = fromRoutes[ri]?.trim() || `线路${ri + 1}`;
    // Most CMS sites use '|' as episode separator, but some (e.g. dytt) use '#'.
    // Detect by checking if '|' yields only 1 segment yet '#' yields multiple url-bearing segments.
    let eps = routeStr.split("|");
    if (eps.length === 1 && routeStr.includes("#")) {
      const hashEps = routeStr.split("#");
      if (hashEps.filter((e) => /\$https?:\/\//i.test(e)).length > 1) eps = hashEps;
    }
    const episodes = [];
    eps.forEach((epEntry, ei) => {
      if (!epEntry.trim()) return;
      const parts = epEntry.split("$");
      const urlPart = parts[parts.length - 1]?.trim();
      if (!urlPart || !/^https?:\/\//i.test(urlPart)) return;
      // Label is everything before the last $-segment (e.g. "第15集")
      const labelPart = parts.length > 1 ? parts.slice(0, -1).join("$").trim() : "";
      const epNum = parseEpLabel(labelPart) ?? (ei + 1);
      const label = labelPart || `EP${epNum}`;
      // If URL looks like a VIP player wrapper, try to extract the actual stream URL.
      // tryResolveEpisodeUrl returns {url, referer} — referer is the VIP player origin.
      const { url, referer: vipReferer } = tryResolveEpisodeUrl(urlPart);
      const vipWrapped = isVipPlayerUrl(url); // true if URL is still a VIP player page
      const type = /\.(mp4|flv|mkv)(\?|$)/i.test(url) ? "mp4" : "hls";
      // referer: VIP player origin (if extracted) or CMS site (for direct CDN URLs).
      // Used by the client to set Referer when fetching via the proxy.
      const referer = vipReferer || defaultReferer;
      episodes.push({ ep: epNum, label, url, type, vipWrapped, referer });
    });
    if (episodes.length > 0) routes.push({ route: routeName, episodes });
  });
  return routes;
}

app.get("/api/anime/find-stream", requireAuth, async (req, res) => {
  const name = String(req.query.name || "").trim();
  const nameFallback = String(req.query.nameFallback || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const animeSites = await loadSubscriptionSites();

  let finished = false;
  const seen = new Set(); // deduplicate source by site+route key
  const blockedSeen = new Set(); // deduplicate blocked events by site name

  function sendSource(src) {
    const key = `${src.site}:::${src.route}`;
    if (finished || seen.has(key)) return;
    seen.add(key);
    res.write(`data: ${JSON.stringify({ type: "source", source: src })}\n\n`);
  }
  function sendChecked(siteName) {
    if (finished) return;
    res.write(`data: ${JSON.stringify({ type: "checked", site: siteName })}\n\n`);
  }
  function sendBlocked(siteName, siteUrl) {
    if (finished || blockedSeen.has(siteName)) return;
    blockedSeen.add(siteName);
    res.write(`data: ${JSON.stringify({ type: "blocked", site: siteName, url: siteUrl })}\n\n`);
  }
  function done() {
    if (finished) return;
    finished = true;
    res.write(`data: ${JSON.stringify({ type: "done", total: animeSites.length })}\n\n`);
    res.end();
  }

  async function querySite(site, fullName) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000); // 20s for search + detail fetch
    try {
      let hit = null;
      let hitDetailUrl = null; // full URL from HTML search results (may differ from /vod/detail/id/{id}.html)

      const hasSelectors = !!(site.selectors?.searchUrl && site.selectors?.subject);

      // Phase 1: animeko-style HTML search using subscription CSS selectors.
      // Pass fullName directly (no season stripping) — buildSearchKeyword handles first-word/removeSpecial.
      // This mirrors animeko: getSearchKeyword() receives the raw subject name, not a pre-stripped one.
      if (hasSelectors) {
        const candidates = await htmlSearchSubjects(site.selectors, fullName, site.base, controller.signal);
        if (candidates?.length) {
          const best = pickBestHit(
            candidates.map((c) => ({ vod_name: c.name, vod_id: guessIdFromUrl(c.fullUrl), _fullUrl: c.fullUrl })),
            fullName,
            30, // Lower threshold for HTML search: site already filtered by keyword
          );
          if (best) {
            hit = best;
            hitDetailUrl = best._fullUrl;
            console.log(`[anime] ${site.name}: HTML search → "${best.vod_name}" (id=${best.vod_id || "slug"}, url=${hitDetailUrl})`);
          }
        }
      }

      // Phase 2: JSON API fallback — used when HTML search finds nothing (Cloudflare-gated HTML but open
      // API is common) or for fallback-list sites without subscription selectors.
      // Apply the same buildSearchKeyword transform for consistency with HTML search.
      if (!hit) {
        const rawKw = stripSeason(fullName) || fullName;
        const searchKw = hasSelectors && site.selectors
          ? buildSearchKeyword(rawKw, site.selectors.searchUseOnlyFirstWord, site.selectors.searchRemoveSpecial)
          : toSimplified(rawKw); // Ensure simplified Chinese for non-subscription sites too
        const { list: hits, blocked } = await cmsSearchAll(site.base, searchKw, controller.signal);
        if (blocked) {
          console.log(`[anime] ${site.name}: blocked (Cloudflare/captcha)`);
          sendBlocked(site.name, site.base);
          return;
        }
        if (!hits.length) {
          console.log(`[anime] ${site.name}: 0 results for "${searchKw}"`);
          return;
        }
        hit = pickBestHit(hits, fullName);
      }

      if (!hit) {
        console.log(`[anime] ${site.name}: no match for "${fullName}"`);
        return;
      }

      // Ensure we have a usable vod_id for JSON API detail, or at least hitDetailUrl for HTML path
      const vodId = hit.vod_id || guessIdFromUrl(hitDetailUrl || "");

      // Fetch JSON detail (for vod_play_url) + HTML episode page (for labels/channel names/play URLs) in parallel.
      const [detail, htmlEpLabels] = await Promise.all([
        vodId ? cmsDetail(site.base, vodId, controller.signal) : Promise.resolve(null),
        fetchCmsHtmlEpisodeLabels(site.base, vodId, site.selectors?.channel ?? null, controller.signal, hitDetailUrl),
      ]);

      // If JSON detail API returned play URLs → use them (overlay HTML labels for display).
      // If parseAllRoutes yields nothing (encoded/unsupported URLs), fall through to HTML routes below.
      if (detail?.vod_play_url) {
        const vodName = detail.vod_name || hit.vod_name || fullName;
        const allRoutes = parseAllRoutes(detail.vod_play_url, detail.vod_play_from, site.base);
        if (allRoutes.length) {
          // Overlay HTML-scraped channel names and episode labels onto JSON routes.
          if (htmlEpLabels) {
            const { episodeLabels, channelNames } = htmlEpLabels;
            allRoutes.forEach((r, ri) => {
              const htmlName = channelNames?.[ri]?.trim();
              if (htmlName) r.route = htmlName;

              const htmlLabels = episodeLabels?.[ri];
              if (!htmlLabels?.length) return;
              if (htmlLabels.length !== r.episodes.length) return;
              r.episodes.forEach((ep, ei) => {
                const htmlLabel = htmlLabels[ei]?.trim();
                if (!htmlLabel) return;
                const parsed = parseEpLabel(htmlLabel);
                if (parsed !== null) ep.ep = parsed;
                ep.label = htmlLabel;
              });
            });
            console.log(`[anime] ${site.name}: HTML labels applied for ${allRoutes.length} routes`);
          }

          console.log(`[anime] ${site.name}: "${vodName}" — ${allRoutes.map((r) => `${r.route}(${r.episodes.length}ep)`).join(", ")}`);
          for (const { route, episodes } of allRoutes) {
            sendSource({ site: site.name, route, vodName, episodes });
          }
          return;
        }
        console.log(`[anime] ${site.name}: "${vodName}" — JSON play data has no usable URLs, trying HTML routes`);
      }

      // No JSON play URL — try to build routes from HTML-extracted player page URLs.
      // This path is taken for non-mxcms sites (e.g. E-ACG, omofun111) that only expose play URLs via HTML.
      const hasHtmlUrls = htmlEpLabels?.episodeUrls?.some((row) => row.some(Boolean));
      if (!hasHtmlUrls) {
        console.log(`[anime] ${site.name}: matched "${hit.vod_name}" but no play URL and no HTML episode URLs`);
        return;
      }

      console.log(`[anime] ${site.name}: no JSON play URL, resolving HTML episode player pages…`);
      // Use a fresh controller for player page fetching (15s budget)
      const playerController = new AbortController();
      const playerTimer = setTimeout(() => playerController.abort(), 15_000);
      let allRoutes;
      try {
        allRoutes = await buildHtmlRoutes(htmlEpLabels, site.base, playerController.signal);
      } finally {
        clearTimeout(playerTimer);
      }

      if (!allRoutes?.length) {
        console.log(`[anime] ${site.name}: HTML player page resolution yielded no valid stream URLs`);
        return;
      }

      const vodName = detail?.vod_name || hit.vod_name || fullName;
      console.log(`[anime] ${site.name}: "${vodName}" (HTML) — ${allRoutes.map((r) => `${r.route}(${r.episodes.length}ep)`).join(", ")}`);
      for (const { route, episodes } of allRoutes) {
        sendSource({ site: site.name, route, vodName, episodes });
      }
    } catch (e) {
      console.log(`[anime] ${site.name}: ${e.message?.slice(0, 80) ?? e}`);
    } finally { clearTimeout(timer); sendChecked(site.name); }
  }

  const tasks = animeSites.flatMap((site) => {
    const t = [querySite(site, name)];
    if (nameFallback && nameFallback !== name) t.push(querySite(site, nameFallback));
    return t;
  });

  const hardTimer = setTimeout(done, 55_000); // 55s: 20s search+detail + 15s player resolution + buffer
  Promise.allSettled(tasks).then(() => { clearTimeout(hardTimer); done(); });
});

// ─── Anime URL resolver (VIP player → real stream URL) ────────────────────────
// GET /api/anime/resolve-url?url=...
// Client calls this when an episode URL is still a VIP player wrapper after
// static extraction. Server fetches the player page HTML, extracts the real
// stream URL, and returns it as JSON. No stream proxying — browser loads direct.
app.get("/api/anime/resolve-url", requireAuth, async (req, res) => {
  const raw = String(req.query.url || "").trim();
  if (!raw) return res.status(400).json({ error: "url required" });

  // If static resolution already gives a non-VIP URL, return it immediately
  const { url: staticUrl, referer: staticReferer } = tryResolveEpisodeUrl(raw);
  if (!isVipPlayerUrl(staticUrl)) {
    return res.json({ url: staticUrl, referer: staticReferer });
  }

  // Fetch the VIP player HTML and extract the real stream URL
  try {
    let parsed;
    try { parsed = new URL(raw); } catch { return res.status(400).json({ error: "invalid url" }); }
    const playerReferer = `${parsed.protocol}//${parsed.host}/`;
    const r = await fetch(raw, {
      signal: AbortSignal.timeout(8_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
        "Accept": "text/html,*/*",
        "Referer": playerReferer,
      },
    });
    if (!r.ok) return res.status(502).json({ error: `upstream HTTP ${r.status}` });
    const html = await r.text();
    const realUrl = extractVideoUrlFromHtml(html, raw);
    if (realUrl && realUrl !== raw) return res.json({ url: realUrl, referer: playerReferer });
    return res.status(422).json({ error: "could not extract stream URL from player page" });
  } catch (e) {
    return res.status(502).json({ error: e.message || "fetch failed" });
  }
});

// ─── Danmaku proxy (bypass CORS) ──────────────────────────────────────────────
// The animeko danmaku server doesn't set Access-Control-Allow-Origin, so
// browser requests from our domain are blocked. Proxy through our server.
app.get("/api/anime/danmaku/:episodeId", requireAuth, async (req, res) => {
  const epId = req.params.episodeId;
  if (!epId || !/^\d+$/.test(epId)) return res.status(400).json({ error: "invalid episodeId" });
  try {
    const r = await fetch(`https://danmaku-cn.myani.org/v1/danmaku/${epId}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return res.status(r.status).json({ error: `upstream ${r.status}` });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── HLS stream proxy ─────────────────────────────────────────────────────────
// GET /api/anime/proxy-stream?url=ENCODED_URL&ref=ENCODED_REFERER
// Fetches an m3u8 playlist (or .ts/.m4s segment) on behalf of the client,
// injecting the correct Referer header so CDNs that check it don't return 403.
// For m3u8 playlists: rewrites all segment/child-playlist URLs through this
// endpoint so every subsequent request also carries the correct Referer.
// Required because browser security prevents setting arbitrary Referer headers.
app.get("/api/anime/proxy-stream", requireAuth, async (req, res) => {
  const rawUrl = String(req.query.url || "").trim();
  const referer = String(req.query.ref || "").trim();
  if (!rawUrl) return res.status(400).end("url required");

  // Construct the proxy URL for a child path (segment or child playlist)
  function makeProxyUrl(childUrl) {
    let absolute;
    try { absolute = new URL(childUrl, rawUrl).href; } catch { absolute = childUrl; }
    return `/api/anime/proxy-stream?url=${encodeURIComponent(absolute)}&ref=${encodeURIComponent(referer)}`;
  }

  try {
    const fetchHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    };
    if (referer) {
      fetchHeaders["Referer"] = referer;
      try { fetchHeaders["Origin"] = new URL(referer).origin; } catch {}
    }

    const upstream = await fetch(rawUrl, {
      signal: AbortSignal.timeout(20_000),
      headers: fetchHeaders,
    });

    if (!upstream.ok) return res.status(upstream.status).end();

    const ct = upstream.headers.get("content-type") || "";
    const urlHint = rawUrl.split("?")[0];
    const isM3u8 = ct.includes("mpegurl") || ct.includes("x-mpegurl")
      || /\.m3u8$/i.test(urlHint);

    if (isM3u8) {
      const text = await upstream.text();
      const out = text.split("\n").map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith("#")) {
          // Rewrite URI="..." inside EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, etc.
          return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${makeProxyUrl(uri)}"`);
        }
        // Non-comment lines are segment URLs or child playlist paths
        return makeProxyUrl(t);
      }).join("\n");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store");
      return res.end(out);
    } else {
      // Binary segment (.ts, .m4s, .aac, etc.) — pipe through
      res.setHeader("Content-Type", ct || "video/MP2T");
      res.setHeader("Access-Control-Allow-Origin", "*");
      const cl = upstream.headers.get("content-length");
      if (cl) res.setHeader("Content-Length", cl);
      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.end(buf);
    }
  } catch (e) {
    return res.status(502).end(e.message || "proxy error");
  }
});

// ─── Anime CMS Site Diagnostics ───────────────────────────────────────────────
// GET /api/anime/test-sites?name=keyword — checks which CMS sites respond to the API
app.get("/api/anime/test-sites", requireAuth, async (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  const animeSites = await loadSubscriptionSites();
  const results = await Promise.allSettled(
    animeSites.map(async (site) => {
      const start = Date.now();
      try {
        const kw = stripSeason(name);
        const url = `${site.base}/api.php/provide/vod/?ac=videolist&wd=${encodeURIComponent(kw)}`;
        const r = await fetch(url, {
          signal: AbortSignal.timeout(6_000),
          headers: { ...CMS_HEADERS, Referer: site.base },
        });
        const ms = Date.now() - start;
        if (!r.ok) return { site: site.name, status: `HTTP ${r.status}`, ms };
        const data = await r.json();
        const hits = Array.isArray(data?.list) ? data.list : [];
        return { site: site.name, status: "ok", hits: hits.length, ms,
          names: hits.slice(0, 3).map((h) => h.vod_name) };
      } catch (e) {
        return { site: site.name, status: "err", error: e.message?.slice(0, 60), ms: Date.now() - start };
      }
    })
  );
  const rows = results.map((r) => r.value || r.reason);
  res.json({ name, sites: rows });
});

app.post("/api/anime/reload-subscription", requireAuth, async (req, res) => {
  const sites = await loadSubscriptionSites(true);
  res.json({ count: sites.length, source: subSitesCacheTime > 0 ? "subscription" : "fallback" });
});

// ─── Anime Episode Download (ffmpeg-based) ────────────────────────────────────

const ANIME_DL_DIR = path.resolve(process.env.ANIME_DOWNLOAD_DIR || path.join(process.cwd(), "server/data/anime-downloads"));
const animeDownloadJobs = new Map();

function sanitizeFilename(name = "") {
  return String(name || "download").replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_").replace(/\s+/g, " ").trim() || "download";
}

// POST /api/anime/download-episode
// Body: { url, referer, animeName, episodeName, type: "hls"|"mp4" }
app.post("/api/anime/download-episode", requireAuth, async (req, res) => {
  const { url, referer, animeName, episodeName, type } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });
  if (!animeName) return res.status(400).json({ error: "animeName required" });

  const safeName = sanitizeFilename(animeName);
  const safeEp = sanitizeFilename(episodeName || "episode");
  const folder = path.join(ANIME_DL_DIR, safeName);
  const outFile = path.join(folder, `${safeEp}.mp4`);

  // Avoid duplicate download of same file
  for (const [, job] of animeDownloadJobs) {
    if (job.outFile === outFile && (job.status === "downloading" || job.status === "queued")) {
      return res.json({ jobId: job.id, status: job.status, message: "已在下载中" });
    }
  }

  try {
    await fs.promises.mkdir(folder, { recursive: true });
  } catch (e) {
    return res.status(500).json({ error: `创建目录失败: ${e.message}` });
  }

  const jobId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id: jobId,
    animeName: safeName,
    episodeName: safeEp,
    outFile,
    status: "downloading",
    progress: "",
    startedAt: Date.now(),
    error: null,
  };
  animeDownloadJobs.set(jobId, job);

  // Build ffmpeg command
  const ffArgs = [];
  // Set referer/user-agent for HTTP input
  const headers = [
    "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  ];
  if (referer) headers.push(`Referer: ${referer}`);
  ffArgs.push("-headers", headers.join("\r\n") + "\r\n");
  ffArgs.push("-i", url);
  ffArgs.push("-c", "copy"); // no re-encoding
  ffArgs.push("-y"); // overwrite
  ffArgs.push("-movflags", "+faststart");
  ffArgs.push(outFile);

  try {
    const proc = spawn("ffmpeg", ffArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stderrBuf = "";

    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      // Extract progress from ffmpeg stderr (time=XX:XX:XX.XX)
      const timeMatch = stderrBuf.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/g);
      if (timeMatch) {
        job.progress = timeMatch[timeMatch.length - 1].replace("time=", "");
      }
      // Keep only last 4KB of stderr to avoid memory bloat
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        job.status = "done";
        job.finishedAt = Date.now();
      } else {
        job.status = "failed";
        job.error = `ffmpeg exited with code ${code}`;
        job.finishedAt = Date.now();
      }
    });

    proc.on("error", (err) => {
      job.status = "failed";
      job.error = err.message;
      job.finishedAt = Date.now();
    });
  } catch (e) {
    job.status = "failed";
    job.error = e.message;
    return res.status(500).json({ error: e.message });
  }

  res.json({ jobId, status: "downloading", outFile: `${safeName}/${safeEp}.mp4` });
});

// GET /api/anime/download-jobs — list active/recent download jobs
app.get("/api/anime/download-jobs", requireAuth, (req, res) => {
  const jobs = [];
  for (const [, job] of animeDownloadJobs) {
    jobs.push({
      id: job.id,
      animeName: job.animeName,
      episodeName: job.episodeName,
      status: job.status,
      progress: job.progress,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    });
  }
  // Clean up old finished jobs (older than 1 hour)
  const cutoff = Date.now() - 3600_000;
  for (const [id, job] of animeDownloadJobs) {
    if ((job.status === "done" || job.status === "failed") && (job.finishedAt || 0) < cutoff) {
      animeDownloadJobs.delete(id);
    }
  }
  res.json({ jobs });
});

// ─── Anime BT torrent search (multi-source) ───────────────────────────────────
// GET /api/anime/bt-search?q=keyword
// Searches Mikan, ACG.RIP, 动漫花园, Nyaa in parallel and returns unified results

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = (/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block) || [])[1]?.trim() || "";
    const link = (/<enclosure url="([^"]+)"/.exec(block) || /<link>(.*?)<\/link>/.exec(block) || [])[1]?.trim() || "";
    const pubDate = (/<pubDate>(.*?)<\/pubDate>/.exec(block) || [])[1]?.trim() || "";
    const size = (/<contentLength>(.*?)<\/contentLength>/.exec(block) || /<nyaa:size>(.*?)<\/nyaa:size>/.exec(block) || [])[1]?.trim() || "";
    // Prefer magnetUrl/magnetUri over enclosure link (which may be a .torrent URL)
    const magnet = (/<magnetUrl><!\[CDATA\[(.*?)\]\]><\/magnetUrl>/.exec(block)
      || /<magnetUrl>(.*?)<\/magnetUrl>/.exec(block)
      || /<nyaa:magnetUri>(.*?)<\/nyaa:magnetUri>/.exec(block)
      || [])[1]?.trim() || link;
    if (title) items.push({ title, link, magnet, pubDate, size });
  }
  return items;
}

const BT_SOURCES = [
  { id: "mikan",  name: "蜜柑计划", url: (q) => `https://mikanime.tv/RSS/Search?searchstr=${encodeURIComponent(q)}&subgroupid=0` },
  { id: "acgrip", name: "ACG.RIP",  url: (q) => `https://acg.rip/.xml?term=${encodeURIComponent(q)}` },
  { id: "dmhy",   name: "动漫花园", url: (q) => `https://share.dmhy.org/topics/rss/rss.xml?keyword=${encodeURIComponent(q)}&sort_id=2` },
  { id: "nyaa",   name: "Nyaa",     url: (q) => `https://nyaa.si/?page=rss&c=1_0&q=${encodeURIComponent(q)}` },
];

app.get("/api/anime/bt-search", requireAuth, async (req, res) => {
  const keyword = String(req.query.q || "").trim();
  if (!keyword) return res.status(400).json({ error: "q required" });

  const results = await Promise.allSettled(
    BT_SOURCES.map(async (source) => {
      const url = source.url(keyword);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        const upstream = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "NAS-Media-Manager/1.0", "Accept": "application/rss+xml, application/xml, text/xml, */*" }
        });
        clearTimeout(timer);
        if (!upstream.ok) return { source: source.id, name: source.name, items: [], error: `HTTP ${upstream.status}` };
        const xml = await upstream.text();
        const items = parseRssItems(xml).map((item) => ({ ...item, source: source.id, sourceName: source.name }));
        return { source: source.id, name: source.name, items };
      } catch (err) {
        clearTimeout(timer);
        return { source: source.id, name: source.name, items: [], error: err.message };
      }
    })
  );

  const sources = results.map((r) => r.status === "fulfilled" ? r.value : { source: "?", name: "?", items: [], error: String(r.reason) });
  const allItems = sources.flatMap((s) => s.items);
  return res.json({
    items: allItems,
    sources: sources.map((s) => ({ source: s.source, name: s.name, count: s.items.length, error: s.error || null })),
    keyword
  });
});

// ─── Mikan anime torrent search proxy ─────────────────────────────────────────
// GET /api/anime/mikan?q=keyword
// Fetches Mikan RSS and returns parsed torrent list
app.get("/api/anime/mikan", requireAuth, async (req, res) => {
  const keyword = String(req.query.q || "").trim();
  if (!keyword) return res.status(400).json({ error: "q required" });
  const url = `https://mikanime.tv/RSS/Search?searchstr=${encodeURIComponent(keyword)}&subgroupid=0`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "NAS-Media-Manager/1.0",
        "Accept": "application/rss+xml, application/xml, text/xml, */*"
      }
    });
    clearTimeout(timer);
    if (!upstream.ok) {
      return res.status(502).json({ error: `mikan ${upstream.status}` });
    }
    const xml = await upstream.text();
    // Parse RSS items: title, enclosure url (magnet or torrent), size, pubDate
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(xml)) !== null) {
      const block = m[1];
      const title = (/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block) || [])[1]?.trim() || "";
      const link = (/<enclosure url="([^"]+)"/.exec(block) || /<link>(.*?)<\/link>/.exec(block) || [])[1]?.trim() || "";
      const pubDate = (/<pubDate>(.*?)<\/pubDate>/.exec(block) || [])[1]?.trim() || "";
      const size = (/<contentLength>(.*?)<\/contentLength>/.exec(block) || [])[1]?.trim() || "";
      const magnet = (/<magnetUrl><!\[CDATA\[(.*?)\]\]><\/magnetUrl>/.exec(block) || /<magnetUrl>(.*?)<\/magnetUrl>/.exec(block) || [])[1]?.trim() || link;
      if (title) {
        items.push({ title, link, magnet, pubDate, size });
      }
    }
    return res.json({ items, keyword });
  } catch (err) {
    clearTimeout(timer);
    return res.status(502).json({ error: "fetch failed", detail: err.message });
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDist = path.resolve(__dirname, "..", "..", "web", "dist");
app.use(express.static(webDist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }
  return res.sendFile(path.join(webDist, "index.html"), (err) => {
    if (err) {
      res.status(404).json({ message: "frontend not built yet" });
    }
  });
});

async function bootstrap() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required");
  }
  const adminEmail = process.env.ADMIN_INIT_EMAIL ?? "admin@example.com";
  const adminPassword = process.env.ADMIN_INIT_PASSWORD ?? "ChangeMe123!";
  const passwordHash = await bcrypt.hash(adminPassword, 10);
  ensureAdmin({ email: adminEmail, passwordHash });

  const port = Number(process.env.SERVER_PORT ?? 8080);
  server.listen(port, () => {
    console.log(`NAS server listening on :${port}`);
  });
}

bootstrap();
