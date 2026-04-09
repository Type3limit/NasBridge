import "dotenv/config";
import path from "node:path";
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
      // If the response looks like HTML (VIP player wrapper), reject it
      if (/^\s*<!DOCTYPE|^\s*<html/i.test(text)) {
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
const CMS_ANIME_SITES = [
  // ── from animeko-prime.json ──────────────────────────────────────────
  { name: "七色番",     base: "https://www.7sefun.top" },
  { name: "LIBVIO",    base: "https://www.libvio.site" },
  { name: "喵物次元",  base: "https://www.mwcy.net" },
  { name: "高清点播",  base: "https://hqvod.com" },
  { name: "omofun",    base: "https://enlienli.link" },
  { name: "去看吧",    base: "https://11kt.net" },
  { name: "风铃动漫",  base: "https://www.aafun.cc" },
  { name: "咕咕番",    base: "https://www.gugu3.com" },
  { name: "酱紫社",    base: "http://www.jzsdm1.com" },
  { name: "热播之家",  base: "https://www.rebozj.pro" },
  { name: "第一动漫",  base: "https://1anime2026.me" },
  { name: "柯南影视",  base: "https://www.knvod.com" },
  // ── from ani-yuan.json ───────────────────────────────────────────────
  { name: "落攻动漫",  base: "https://www.fengchedonman.com" },
  { name: "嘀哩嘀哩",  base: "https://dilidili.online" },
  { name: "新动漫网",  base: "https://www.xdmdy.cc" },
  { name: "秋之动漫",  base: "https://www.akianime.cc" },
  { name: "AGE动漫",   base: "https://www.agedm.org" },
  { name: "新优酷",    base: "https://www.youknow.tv" },
  { name: "萌番动漫",  base: "https://www.moefan.cc" },
  { name: "E-ACG",     base: "https://www.eacg1.com" },
  { name: "叽哔动漫",  base: "https://www.jibi.cc" },
  { name: "佩可爱动漫",base: "https://acg.pekolove.net" },
  { name: "火狼动漫",  base: "https://huolangdm2.net" },
  { name: "风车动漫",  base: "https://dmfengche.cc" },
  { name: "影视大全",  base: "https://cctv5566.cc" },
  { name: "风车动漫2", base: "https://yhdmya.com" },
  { name: "蜜桃动漫",  base: "https://www.mitaodm.com" },
  { name: "趣动漫",    base: "https://www.qdm66.com" },
  { name: "九兔动漫",  base: "https://www.jtdm.cc" },
  { name: "girigiri",  base: "https://bgm.girigirilove.com" },
  { name: "黑猫动漫",  base: "https://m.baimaodm.com" },
  { name: "海星动漫",  base: "https://www.haixingdmx.com" },
  { name: "追剧影院",  base: "https://pzlyw.com" },
  { name: "影视森林",  base: "http://www.hc34567.com" },
];

const CMS_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
};

async function cmsSearch(base, keyword, signal) {
  const url = `${base}/api.php/provide/vod/?ac=videolist&wd=${encodeURIComponent(keyword)}`;
  const r = await fetch(url, { signal, headers: { ...CMS_HEADERS, "Referer": base } });
  if (!r.ok) return null;
  const data = await r.json();
  return data?.list?.[0] ?? null;
}

async function cmsDetail(base, id, signal) {
  const url = `${base}/api.php/provide/vod/?ac=detail&ids=${id}`;
  const r = await fetch(url, { signal, headers: { ...CMS_HEADERS, "Referer": base } });
  if (!r.ok) return null;
  const data = await r.json();
  return data?.list?.[0] ?? null;
}

// Returns all routes for a given episode from vod_play_url + vod_play_from
// vod_play_url format: "EP01$url|EP02$url$$$线路2EP01$url|..."
// vod_play_from format: "source1$$$source2$$$..."  (route names)
function parseAllEpisodeUrls(vodPlayUrl, vodPlayFrom, epIndex) {
  if (!vodPlayUrl) return [];
  const results = [];
  const urlRoutes = vodPlayUrl.split("$$$");
  const fromRoutes = vodPlayFrom ? vodPlayFrom.split("$$$") : [];
  urlRoutes.forEach((route, ri) => {
    const routeName = fromRoutes[ri]?.trim() || `线路${ri + 1}`;
    const eps = route.split("|");
    const epEntry = eps[epIndex - 1] || (epIndex <= eps.length ? eps[epIndex - 1] : null);
    if (!epEntry) return;
    const parts = epEntry.split("$");
    const url = parts[parts.length - 1]?.trim();
    if (url && /^https?:\/\//i.test(url)) {
      results.push({ route: routeName, url });
    }
  });
  return results;
}

app.get("/api/anime/find-stream", requireAuth, async (req, res) => {
  const name = String(req.query.name || "").trim();
  const nameFallback = String(req.query.nameFallback || "").trim(); // alternate search name
  const ep = Math.max(1, parseInt(req.query.ep || "1", 10) || 1);
  if (!name) return res.status(400).json({ error: "name required" });

  const sources = [];

  async function querySite(site, keyword) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const hit = await cmsSearch(site.base, keyword, controller.signal);
      if (!hit?.vod_id) return;
      const detail = await cmsDetail(site.base, hit.vod_id, controller.signal);
      if (!detail?.vod_play_url) return;
      const vodName = detail.vod_name || hit.vod_name || keyword;
      const routeUrls = parseAllEpisodeUrls(detail.vod_play_url, detail.vod_play_from, ep);
      for (const { route, url } of routeUrls) {
        const playUrl = `/api/tv/stream?url=${encodeURIComponent(url)}`;
        sources.push({ site: site.name, route, ep, url, playUrl, vodName });
      }
    } catch { /* ignore per-site errors */ } finally { clearTimeout(timer); }
  }

  // Hard cap: respond within 10 seconds no matter what
  const hardTimeout = new Promise((resolve) => setTimeout(resolve, 10_000));
  const searchAll = Promise.allSettled(
    CMS_ANIME_SITES.flatMap((site) => {
      const tasks = [querySite(site, name)];
      if (nameFallback && nameFallback !== name) tasks.push(querySite(site, nameFallback));
      return tasks;
    })
  );
  await Promise.race([searchAll, hardTimeout]);

  return res.json({ sources, name, ep });
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
