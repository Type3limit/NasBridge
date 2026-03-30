import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

const dataDir = path.resolve(process.cwd(), "server/data");
const dbPath = path.join(dataDir, "db.json");

const defaultDb = {
  users: [],
  clients: [],
  files: [],
  directories: [],
  columns: [],
  fileMeta: [],
  favorites: [],
  uploadJobs: [],
  fileShares: [],
  comments: [],
  danmaku: [],
  tvSources: []
};

function ensureDb() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify(defaultDb, null, 2), "utf-8");
  }
}

function readDb() {
  ensureDb();
  const raw = fs.readFileSync(dbPath, "utf-8");
  const db = JSON.parse(raw);
  if (!Array.isArray(db.columns)) {
    db.columns = [];
  }
  if (!Array.isArray(db.directories)) {
    db.directories = [];
  }
  if (!Array.isArray(db.fileMeta)) {
    db.fileMeta = [];
  }
  if (!Array.isArray(db.uploadJobs)) {
    db.uploadJobs = [];
  }
  if (!Array.isArray(db.fileShares)) {
    db.fileShares = [];
  }
  if (!Array.isArray(db.comments)) {
    db.comments = [];
  }
  if (!Array.isArray(db.danmaku)) {
    db.danmaku = [];
  }
  if (!Array.isArray(db.tvSources)) {
    db.tvSources = [];
  }
  writeDb(db);
  return db;
}

function writeDb(db) {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf-8");
}

export function listUsers() {
  return readDb().users;
}

export function getUserByEmail(email) {
  return readDb().users.find((item) => item.email.toLowerCase() === email.toLowerCase());
}

export function getUserById(userId) {
  return readDb().users.find((item) => item.id === userId);
}

export function createUser({ email, passwordHash, displayName, role = "user" }) {
  const db = readDb();
  const entity = {
    id: nanoid(12),
    email,
    passwordHash,
    displayName,
    avatarUrl: "",
    avatarClientId: "",
    avatarPath: "",
    avatarFileId: "",
    bio: "",
    role,
    createdAt: new Date().toISOString()
  };
  db.users.push(entity);
  writeDb(db);
  return entity;
}

export function ensureAdmin({ email, passwordHash }) {
  const db = readDb();
  const existing = db.users.find((item) => item.role === "admin" || item.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    return existing;
  }
  const admin = {
    id: nanoid(12),
    email,
    passwordHash,
    displayName: "Administrator",
    avatarUrl: "",
    avatarClientId: "",
    avatarPath: "",
    avatarFileId: "",
    bio: "",
    role: "admin",
    createdAt: new Date().toISOString()
  };
  db.users.push(admin);
  writeDb(db);
  return admin;
}

export function updateUserProfile(userId, patch = {}) {
  const db = readDb();
  const user = db.users.find((item) => item.id === userId);
  if (!user) {
    return null;
  }
  if (typeof patch.email === "string") {
    user.email = patch.email;
  }
  if (typeof patch.displayName === "string") {
    user.displayName = patch.displayName;
  }
  if (typeof patch.avatarUrl === "string") {
    user.avatarUrl = patch.avatarUrl;
  }
  if (typeof patch.avatarClientId === "string") {
    user.avatarClientId = patch.avatarClientId;
  }
  if (typeof patch.avatarPath === "string") {
    user.avatarPath = patch.avatarPath;
  }
  if (typeof patch.avatarFileId === "string") {
    user.avatarFileId = patch.avatarFileId;
  }
  if (typeof patch.bio === "string") {
    user.bio = patch.bio;
  }
  for (const share of db.fileShares || []) {
    if (share.createdByUserId === userId) {
      share.createdByDisplayName = user.displayName;
    }
  }
  for (const comment of db.comments || []) {
    if (comment.createdByUserId === userId) {
      comment.createdByDisplayName = user.displayName;
      comment.createdByAvatarUrl = user.avatarUrl || "";
      comment.createdByAvatarClientId = user.avatarClientId || "";
      comment.createdByAvatarPath = user.avatarPath || "";
      comment.createdByAvatarFileId = user.avatarFileId || "";
    }
  }
  for (const item of db.danmaku || []) {
    if (item.createdByUserId === userId) {
      item.createdByDisplayName = user.displayName;
      item.createdByAvatarUrl = user.avatarUrl || "";
      item.createdByAvatarClientId = user.avatarClientId || "";
      item.createdByAvatarPath = user.avatarPath || "";
      item.createdByAvatarFileId = user.avatarFileId || "";
    }
  }
  for (const job of db.uploadJobs || []) {
    if (job.createdByUserId === userId) {
      job.createdByDisplayName = user.displayName;
    }
  }
  user.updatedAt = new Date().toISOString();
  writeDb(db);
  return user;
}

export function registerClient({ name }) {
  const db = readDb();
  const now = new Date().toISOString();
  const normalizedName = (name ?? "").trim();
  const key = normalizedName.toLowerCase();

  const sameNameClients = db.clients.filter((item) => (item.name ?? "").trim().toLowerCase() === key);

  if (sameNameClients.length > 0) {
    const [primaryClient, ...duplicates] = sameNameClients;
    const duplicateIds = new Set(duplicates.map((item) => item.id));

    if (duplicateIds.size > 0) {
      db.clients = db.clients.filter((item) => item.id === primaryClient.id || !duplicateIds.has(item.id));

      const dedupedFiles = new Map();
      for (const file of db.files) {
        const clientId = duplicateIds.has(file.clientId) ? primaryClient.id : file.clientId;
        const mapped = {
          ...file,
          clientId,
          id: `${clientId}:${file.path}`
        };
        dedupedFiles.set(mapped.id, mapped);
      }
      db.files = [...dedupedFiles.values()];

      const dedupedDirectories = new Map();
      for (const directory of db.directories || []) {
        const clientId = duplicateIds.has(directory.clientId) ? primaryClient.id : directory.clientId;
        const mapped = {
          ...directory,
          clientId,
          id: `${clientId}:${directory.path}`
        };
        dedupedDirectories.set(mapped.id, mapped);
      }
      db.directories = [...dedupedDirectories.values()];
    }

    primaryClient.name = normalizedName || primaryClient.name;
    primaryClient.status = "online";
    primaryClient.lastHeartbeatAt = now;
    writeDb(db);
    return primaryClient;
  }

  const entity = {
    id: nanoid(12),
    name: normalizedName || name,
    status: "online",
    createdAt: now,
    lastHeartbeatAt: now
  };
  db.clients.push(entity);
  writeDb(db);
  return entity;
}

export function listClients() {
  return readDb().clients;
}

export function touchClient(clientId, status = "online", name) {
  const db = readDb();
  const client = db.clients.find((item) => item.id === clientId);
  if (!client) {
    return null;
  }
  if (name && String(name).trim()) {
    client.name = String(name).trim();
  }
  client.status = status;
  client.lastHeartbeatAt = new Date().toISOString();
  writeDb(db);
  return client;
}

export function setClientStatus(clientId, status) {
  const db = readDb();
  const client = db.clients.find((item) => item.id === clientId);
  if (!client) {
    return null;
  }
  client.status = status;
  writeDb(db);
  return client;
}

export function replaceClientFiles(clientId, files) {
  const db = readDb();
  const now = new Date().toISOString();
  db.files = db.files.filter((item) => item.clientId !== clientId);
  const stamped = files.map((file) => ({
    ...file,
    id: `${clientId}:${file.path}`,
    clientId,
    createdAt: file.createdAt || file.updatedAt || now,
    updatedAt: file.updatedAt || file.createdAt || now,
    syncedAt: now
  }));
  db.files.push(...stamped);
  writeDb(db);
  return stamped;
}

export function replaceClientDirectories(clientId, directories) {
  const db = readDb();
  const now = new Date().toISOString();
  db.directories = (db.directories || []).filter((item) => item.clientId !== clientId);
  const stamped = directories.map((directory) => ({
    ...directory,
    id: `${clientId}:${directory.path}`,
    clientId,
    createdAt: directory.createdAt || directory.updatedAt || now,
    updatedAt: directory.updatedAt || directory.createdAt || now,
    syncedAt: now
  }));
  db.directories.push(...stamped);
  writeDb(db);
  return stamped;
}

export function listFiles() {
  return [...readDb().files].sort((left, right) => {
    const leftCreatedAt = String(left?.createdAt || left?.updatedAt || left?.syncedAt || "");
    const rightCreatedAt = String(right?.createdAt || right?.updatedAt || right?.syncedAt || "");
    const createdAtCompare = rightCreatedAt.localeCompare(leftCreatedAt);
    if (createdAtCompare !== 0) {
      return createdAtCompare;
    }
    return String(left?.name || "").localeCompare(String(right?.name || ""), "zh-CN", {
      numeric: true,
      sensitivity: "base"
    });
  });
}

export function listDirectories() {
  return [...(readDb().directories || [])].sort((left, right) => {
    const leftUpdatedAt = String(left?.updatedAt || left?.createdAt || left?.syncedAt || "");
    const rightUpdatedAt = String(right?.updatedAt || right?.createdAt || right?.syncedAt || "");
    const updatedAtCompare = rightUpdatedAt.localeCompare(leftUpdatedAt);
    if (updatedAtCompare !== 0) {
      return updatedAtCompare;
    }
    return String(left?.path || "").localeCompare(String(right?.path || ""), "zh-CN", {
      numeric: true,
      sensitivity: "base"
    });
  });
}

export function listColumns() {
  return readDb().columns || [];
}

export function createColumn({ name }) {
  const db = readDb();
  const normalized = String(name || "").trim();
  if (!normalized) {
    throw new Error("name is required");
  }
  const existing = (db.columns || []).find((item) => String(item.name || "").toLowerCase() === normalized.toLowerCase());
  if (existing) {
    return existing;
  }
  const now = new Date().toISOString();
  const entity = {
    id: nanoid(10),
    name: normalized,
    createdAt: now
  };
  db.columns = db.columns || [];
  db.columns.push(entity);
  writeDb(db);
  return entity;
}

export function upsertFileMeta(fileId, patch) {
  if (!fileId) {
    return null;
  }
  const db = readDb();
  db.fileMeta = db.fileMeta || [];
  const now = new Date().toISOString();
  const existing = db.fileMeta.find((item) => item.fileId === fileId);
  if (existing) {
    Object.assign(existing, patch, { updatedAt: now });
    writeDb(db);
    return existing;
  }
  const entity = {
    fileId,
    columnId: patch?.columnId || "",
    folderPath: patch?.folderPath || "",
    mimeType: patch?.mimeType || "",
    createdAt: now,
    updatedAt: now
  };
  db.fileMeta.push(entity);
  writeDb(db);
  return entity;
}

export function moveFileMeta(oldFileId, newFileId, patch = {}) {
  if (!oldFileId || !newFileId) {
    return null;
  }
  const db = readDb();
  db.fileMeta = db.fileMeta || [];
  const now = new Date().toISOString();
  const existing = db.fileMeta.find((item) => item.fileId === oldFileId);
  const target = db.fileMeta.find((item) => item.fileId === newFileId);
  const base = {
    columnId: existing?.columnId || "",
    folderPath: existing?.folderPath || "",
    mimeType: existing?.mimeType || ""
  };

  if (target) {
    Object.assign(target, base, patch, { updatedAt: now });
  } else {
    db.fileMeta.push({
      fileId: newFileId,
      ...base,
      ...patch,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    });
  }

  db.fileMeta = db.fileMeta.filter((item) => item.fileId !== oldFileId);
  writeDb(db);
  return db.fileMeta.find((item) => item.fileId === newFileId) || null;
}

export function getFileMetaMap() {
  const db = readDb();
  const map = new Map();
  for (const meta of db.fileMeta || []) {
    if (meta?.fileId) {
      map.set(meta.fileId, meta);
    }
  }
  return map;
}

export function clearClientFiles(clientId) {
  const db = readDb();
  const before = db.files.length;
  const beforeDirectories = (db.directories || []).length;
  db.files = db.files.filter((item) => item.clientId !== clientId);
  db.directories = (db.directories || []).filter((item) => item.clientId !== clientId);
  if (db.files.length !== before || db.directories.length !== beforeDirectories) {
    writeDb(db);
  }
  return (before - db.files.length) + (beforeDirectories - db.directories.length);
}

export function listFavoritesByUser(userId) {
  return readDb().favorites.filter((item) => item.userId === userId).map((item) => item.fileId);
}

export function toggleFavorite({ userId, fileId }) {
  const db = readDb();
  const found = db.favorites.find((item) => item.userId === userId && item.fileId === fileId);
  if (found) {
    db.favorites = db.favorites.filter((item) => !(item.userId === userId && item.fileId === fileId));
    writeDb(db);
    return false;
  }
  db.favorites.push({
    id: nanoid(12),
    userId,
    fileId,
    createdAt: new Date().toISOString()
  });
  writeDb(db);
  return true;
}

export function listUploadJobs() {
  const db = readDb();
  return [...db.uploadJobs].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function createUploadJob({ createdByUserId, createdByDisplayName, clientId, fileName, relativePath, size, mimeType }) {
  const db = readDb();
  const now = new Date().toISOString();
  const entity = {
    id: nanoid(12),
    createdByUserId,
    createdByDisplayName,
    clientId,
    fileName,
    relativePath,
    size: Number(size || 0),
    mimeType: mimeType || "application/octet-stream",
    status: "uploading",
    progress: 0,
    transferredBytes: 0,
    message: "上传中",
    createdAt: now,
    updatedAt: now,
    finishedAt: null
  };
  db.uploadJobs.push(entity);
  writeDb(db);
  return entity;
}

export function updateUploadJobProgress(jobId, { progress, transferredBytes, message }) {
  const db = readDb();
  const job = db.uploadJobs.find((item) => item.id === jobId);
  if (!job) {
    return null;
  }
  if (typeof progress === "number" && Number.isFinite(progress)) {
    const nextProgress = Math.max(0, Math.min(100, Math.round(progress)));
    job.progress = Math.max(job.progress || 0, nextProgress);
  }
  if (typeof transferredBytes === "number" && Number.isFinite(transferredBytes)) {
    const nextBytes = Math.max(0, Math.round(transferredBytes));
    job.transferredBytes = Math.max(job.transferredBytes || 0, nextBytes);
  }
  if (message) {
    job.message = String(message);
  }
  job.status = "uploading";
  job.updatedAt = new Date().toISOString();
  writeDb(db);
  return job;
}

export function finishUploadJob(jobId, { message }) {
  const db = readDb();
  const job = db.uploadJobs.find((item) => item.id === jobId);
  if (!job) {
    return null;
  }
  const now = new Date().toISOString();
  job.status = "completed";
  job.progress = 100;
  job.transferredBytes = Math.max(job.transferredBytes || 0, job.size || 0);
  job.message = message || "上传完成";
  job.updatedAt = now;
  job.finishedAt = now;
  writeDb(db);
  return job;
}

export function failUploadJob(jobId, { message }) {
  const db = readDb();
  const job = db.uploadJobs.find((item) => item.id === jobId);
  if (!job) {
    return null;
  }
  const now = new Date().toISOString();
  job.status = "failed";
  job.message = message || "上传失败";
  job.updatedAt = now;
  job.finishedAt = now;
  writeDb(db);
  return job;
}

export function finalizeStaleUploadingJobs(maxAgeMs = 10 * 60 * 1000) {
  const db = readDb();
  const now = Date.now();
  let changed = false;

  for (const job of db.uploadJobs) {
    if (job.status !== "uploading") {
      continue;
    }
    const updatedAt = job.updatedAt ? new Date(job.updatedAt).getTime() : 0;
    if (!updatedAt || now - updatedAt > maxAgeMs) {
      job.status = "failed";
      job.message = "上传任务超时结束";
      job.updatedAt = new Date().toISOString();
      job.finishedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    writeDb(db);
  }
  return changed;
}

export function createFileShare({ fileId, fileName = "", filePath = "", clientId = "", createdByUserId, createdByDisplayName, expiresInDays = null }) {
  const db = readDb();
  const now = new Date();
  const entity = {
    id: nanoid(16),
    fileId,
    fileName,
    filePath,
    clientId,
    createdByUserId,
    createdByDisplayName,
    createdAt: now.toISOString(),
    expiresAt: expiresInDays ? new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000).toISOString() : null,
    accessCount: 0,
    revokedAt: null,
    revokedByUserId: null
  };
  db.fileShares.push(entity);
  writeDb(db);
  return entity;
}

export function getFileShareById(shareId) {
  const db = readDb();
  const share = db.fileShares.find((item) => item.id === shareId);
  if (!share) {
    return null;
  }
  if (share.revokedAt) {
    return null;
  }
  if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
    return null;
  }
  return share;
}

export function incrementShareAccessCount(shareId) {
  const db = readDb();
  const share = db.fileShares.find((item) => item.id === shareId);
  if (!share) {
    return null;
  }
  share.accessCount = (share.accessCount || 0) + 1;
  writeDb(db);
  return share;
}

export function listFileShares() {
  return readDb().fileShares || [];
}

export function revokeFileShare(shareId, revokedByUserId) {
  const db = readDb();
  const share = db.fileShares.find((item) => item.id === shareId);
  if (!share) {
    return null;
  }
  if (!share.revokedAt) {
    share.revokedAt = new Date().toISOString();
    share.revokedByUserId = revokedByUserId || null;
    writeDb(db);
  }
  return share;
}

export function deleteFileShare(shareId) {
  const db = readDb();
  const share = db.fileShares.find((item) => item.id === shareId) || null;
  if (!share) {
    return null;
  }
  db.fileShares = db.fileShares.filter((item) => item.id !== shareId);
  writeDb(db);
  return share;
}

export function getFileById(fileId) {
  return readDb().files.find((item) => item.id === fileId) || null;
}

export function listFileComments(fileId) {
  return readDb()
    .comments
    .filter((item) => item.fileId === fileId)
    .sort((left, right) => (left.createdAt || "").localeCompare(right.createdAt || ""));
}

export function getFileCommentById(commentId) {
  return readDb().comments.find((item) => item.id === commentId) || null;
}

export function createFileComment({ fileId, parentId = null, content, createdByUserId, createdByDisplayName, createdByAvatarUrl, createdByAvatarClientId = "", createdByAvatarPath = "", createdByAvatarFileId = "" }) {
  const db = readDb();
  const now = new Date().toISOString();
  const entity = {
    id: nanoid(14),
    fileId,
    parentId: parentId || null,
    content,
    createdByUserId,
    createdByDisplayName: createdByDisplayName || "匿名用户",
    createdByAvatarUrl: createdByAvatarUrl || "",
    createdByAvatarClientId: createdByAvatarClientId || "",
    createdByAvatarPath: createdByAvatarPath || "",
    createdByAvatarFileId: createdByAvatarFileId || "",
    createdAt: now,
    updatedAt: now,
    reactions: []
  };
  db.comments.push(entity);
  writeDb(db);
  return entity;
}

export function setCommentReaction(commentId, userId, value) {
  const db = readDb();
  const comment = db.comments.find((item) => item.id === commentId);
  if (!comment) {
    return null;
  }
  comment.reactions = Array.isArray(comment.reactions) ? comment.reactions : [];
  comment.reactions = comment.reactions.filter((item) => item.userId !== userId);
  if (value === 1 || value === -1) {
    comment.reactions.push({
      id: nanoid(10),
      userId,
      value,
      createdAt: new Date().toISOString()
    });
  }
  comment.updatedAt = new Date().toISOString();
  writeDb(db);
  return comment;
}

export function listFileDanmaku(fileId) {
  return readDb()
    .danmaku
    .filter((item) => item.fileId === fileId)
    .sort((left, right) => {
      const timeDelta = Number(left.timeSec || 0) - Number(right.timeSec || 0);
      if (timeDelta !== 0) {
        return timeDelta;
      }
      return String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
    });
}

// ── TV Sources ──────────────────────────────────────────────────────────────

const TV_SOURCE_MAX_CONTENT_BYTES = 512 * 1024; // 512 KB cap per source
const TV_SOURCE_MAX_HISTORY = 50;

export function listTvSources() {
  return readDb().tvSources;
}

export function saveTvSource({ label, url = null, content = null, channelCount }) {
  const db = readDb();
  const now = new Date().toISOString();
  const safeContent = content && content.length <= TV_SOURCE_MAX_CONTENT_BYTES ? content : null;
  const entity = {
    id: nanoid(14),
    label: String(label || "").trim().slice(0, 120),
    url: url ? String(url).trim() : null,
    content: safeContent,
    channelCount: Math.max(0, Number(channelCount) || 0),
    savedAt: now
  };
  db.tvSources = [entity, ...db.tvSources].slice(0, TV_SOURCE_MAX_HISTORY);
  writeDb(db);
  return entity;
}

export function deleteTvSource(id) {
  const db = readDb();
  db.tvSources = db.tvSources.filter((item) => item.id !== id);
  writeDb(db);
}

export function createFileDanmaku({ fileId, content, timeSec = 0, color = "#FFFFFF", mode = "scroll", createdByUserId, createdByDisplayName, createdByAvatarUrl, createdByAvatarClientId = "", createdByAvatarPath = "", createdByAvatarFileId = "" }) {
  const db = readDb();
  const now = new Date().toISOString();
  const entity = {
    id: nanoid(14),
    fileId,
    content,
    timeSec: Math.max(0, Number(timeSec || 0)),
    color,
    mode,
    createdByUserId,
    createdByDisplayName: createdByDisplayName || "匿名用户",
    createdByAvatarUrl: createdByAvatarUrl || "",
    createdByAvatarClientId: createdByAvatarClientId || "",
    createdByAvatarPath: createdByAvatarPath || "",
    createdByAvatarFileId: createdByAvatarFileId || "",
    createdAt: now,
    updatedAt: now
  };
  db.danmaku.push(entity);
  writeDb(db);
  return entity;
}
