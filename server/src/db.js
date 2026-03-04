import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

const dataDir = path.resolve(process.cwd(), "server/data");
const dbPath = path.join(dataDir, "db.json");

const defaultDb = {
  users: [],
  clients: [],
  files: [],
  favorites: [],
  uploadJobs: []
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
  if (!Array.isArray(db.uploadJobs)) {
    db.uploadJobs = [];
    writeDb(db);
  }
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
    role: "admin",
    createdAt: new Date().toISOString()
  };
  db.users.push(admin);
  writeDb(db);
  return admin;
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
  db.files = db.files.filter((item) => item.clientId !== clientId);
  const stamped = files.map((file) => ({
    ...file,
    id: `${clientId}:${file.path}`,
    clientId,
    updatedAt: new Date().toISOString()
  }));
  db.files.push(...stamped);
  writeDb(db);
  return stamped;
}

export function listFiles() {
  return readDb().files;
}

export function clearClientFiles(clientId) {
  const db = readDb();
  const before = db.files.length;
  db.files = db.files.filter((item) => item.clientId !== clientId);
  if (db.files.length !== before) {
    writeDb(db);
  }
  return before - db.files.length;
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
