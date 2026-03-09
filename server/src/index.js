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
  listUsers,
  registerClient,
  listClients,
  touchClient,
  setClientStatus,
  replaceClientFiles,
  listFiles,
  listColumns,
  createColumn,
  upsertFileMeta,
  getFileMetaMap,
  listFavoritesByUser,
  toggleFavorite,
  listUploadJobs,
  createUploadJob,
  updateUploadJobProgress,
  finishUploadJob,
  failUploadJob,
  finalizeStaleUploadingJobs
} from "./db.js";
import { signUserToken, signClientToken } from "./auth.js";
import { requireAuth, requireRole } from "./middleware.js";
import { initWsHub } from "./wsHub.js";

const app = express();
const server = http.createServer(app);
initWsHub(server);
const serverDebug = process.env.SERVER_DEBUG === "1";

function serverLog(...args) {
  if (serverDebug) {
    console.log("[server]", ...args);
  }
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
  return res.json({ token, user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role } });
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
  return res.json({ token, user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role } });
});

app.get("/api/me", requireAuth, (req, res) => {
  const favorites = listFavoritesByUser(req.auth.sub);
  return res.json({ profile: req.auth, favorites });
});

app.get("/api/files", requireAuth, (req, res) => {
  const files = listFiles();
  const favorites = new Set(listFavoritesByUser(req.auth.sub));
  const metaMap = getFileMetaMap();
  const enriched = files.map((file) => {
    const meta = metaMap.get(file.id) || {};
    return {
      ...file,
      favorite: favorites.has(file.id),
      columnId: meta.columnId || "",
      folderPath: meta.folderPath || ""
    };
  });
  return res.json({ files: enriched });
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
  finalizeStaleUploadingJobs(10 * 60 * 1000);
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

app.post("/api/client/filesync", requireAuth, requireRole("client"), (req, res) => {
  const files = Array.isArray(req.body.files) ? req.body.files : [];
  const sanitized = files
    .filter((item) => item.path)
    .map((item) => ({
      path: item.path,
      name: item.name ?? path.basename(item.path),
      size: Number(item.size ?? 0),
      mimeType: item.mimeType ?? "application/octet-stream",
      updatedAt: item.updatedAt ?? new Date().toISOString()
    }));
  const saved = replaceClientFiles(req.auth.sub, sanitized);
  serverLog("client-filesync", req.reqId, req.auth.sub, `count=${saved.length}`);
  return res.json({ count: saved.length });
});

app.get("/api/admin/users", requireAuth, requireRole("admin"), (_, res) => {
  const users = listUsers().map((item) => ({
    id: item.id,
    email: item.email,
    displayName: item.displayName,
    role: item.role,
    createdAt: item.createdAt
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
