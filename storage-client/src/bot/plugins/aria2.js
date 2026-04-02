import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createBotJobMessageId } from "../context.js";
import { importFileIntoLibrary, triggerLibraryRescan } from "../tools/libraryImport.js";
import { createBotPlugin } from "./base.js";

const aria2ImportDir = process.env.ARIA2_IMPORT_DIR || "downloads/aria2";
const ARIA2_POLL_INTERVAL_MS = 2500;
const ARIA2_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// ──────────────────────────────────────────────
// aria2 JSON-RPC helpers
// ──────────────────────────────────────────────

let _rpcSeq = 1;

function getRpcUrl() {
  return String(process.env.ARIA2_RPC_URL || "http://127.0.0.1:6800/jsonrpc").trim();
}

function getRpcSecret() {
  return String(process.env.ARIA2_RPC_SECRET || "").trim();
}

async function aria2Call(method, params = [], { signal } = {}) {
  const secret = getRpcSecret();
  const fullParams = secret ? [`token:${secret}`, ...params] : params;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: String(_rpcSeq++),
    method,
    params: fullParams
  });
  const response = await fetch(getRpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal
  });
  if (!response.ok) {
    throw Object.assign(new Error(`aria2 RPC HTTP ${response.status}`), { code: "ARIA2_HTTP_ERROR" });
  }
  const data = await response.json();
  if (data.error) {
    throw Object.assign(
      new Error(`aria2 RPC error: ${data.error.message || JSON.stringify(data.error)}`),
      { code: "ARIA2_RPC_ERROR", rpcCode: data.error.code }
    );
  }
  return data.result;
}

async function aria2AddUri(uris, options = {}, { signal } = {}) {
  return aria2Call("aria2.addUri", [uris, options], { signal });
}

async function aria2TellStatus(gid, { signal } = {}) {
  return aria2Call("aria2.tellStatus", [
    gid,
    ["gid", "status", "totalLength", "completedLength", "downloadSpeed", "uploadSpeed", "files", "errorMessage", "errorCode", "bittorrent", "infoHash"]
  ], { signal });
}

async function aria2Remove(gid, { signal } = {}) {
  return aria2Call("aria2.remove", [gid], { signal }).catch(() =>
    aria2Call("aria2.forceRemove", [gid], { signal }).catch(() => null)
  );
}

async function aria2GetVersion({ signal } = {}) {
  return aria2Call("aria2.getVersion", [], { signal });
}

// ──────────────────────────────────────────────
// URL / source classification
// ──────────────────────────────────────────────

function classifySource(raw = "") {
  const text = String(raw || "").trim();
  if (/^magnet:\?/i.test(text)) {
    return "magnet";
  }
  if (/^ed2k:\/\//i.test(text)) {
    return "ed2k";
  }
  if (/^https?:\/\//i.test(text)) {
    return /\.torrent(\?|$)/i.test(text) ? "torrent-url" : "http";
  }
  return "unknown";
}

function isValidSource(raw = "") {
  return classifySource(raw) !== "unknown";
}

function labelForSourceType(type = "") {
  return new Map([
    ["magnet", "磁力链接"],
    ["ed2k", "电驴链接"],
    ["torrent-url", "Torrent 文件"],
    ["http", "HTTP 下载"]
  ]).get(type) || "未知链接";
}

function extractSourceFromText(rawText = "") {
  const text = String(rawText || "").trim();
  // magnet
  const magnetMatch = text.match(/magnet:\?[^\s]*/i);
  if (magnetMatch) {
    return magnetMatch[0];
  }
  // ed2k
  const ed2kMatch = text.match(/ed2k:\/\/[^\s]*/i);
  if (ed2kMatch) {
    return ed2kMatch[0];
  }
  // explicit http(s) URL (may be .torrent)
  const urlMatch = text.match(/https?:\/\/\S+/i);
  if (urlMatch) {
    return urlMatch[0];
  }
  return "";
}

function extractTargetFolder(rawText = "") {
  const match = String(rawText || "").match(/(?:^|\s)(?:folder|dir|目录)\s*[=:]\s*([^\s]+)/i);
  return match ? sanitizeFolder(match[1]) : "";
}

function sanitizeFolder(value = "") {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.\./g, "")
    .replace(/\/+/g, "/");
}

function sanitizeFileName(value = "", fallback = "download") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "");
  return cleaned || fallback;
}

// ──────────────────────────────────────────────
// Formatting helpers
// ──────────────────────────────────────────────

function formatBytes(bytes = 0) {
  const n = Number(bytes || 0);
  if (n <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log2(n) / 10), units.length - 1);
  return `${(n / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatSpeed(bytesPerSec = 0) {
  const n = Number(bytesPerSec || 0);
  if (n <= 0) {
    return "";
  }
  return `${formatBytes(n)}/s`;
}

function calcPercent(completed = 0, total = 0) {
  const c = Number(completed || 0);
  const t = Number(total || 0);
  if (t <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((c / t) * 100)));
}

function formatEta(completed = 0, total = 0, speed = 0) {
  const remaining = Number(total || 0) - Number(completed || 0);
  const bps = Number(speed || 0);
  if (bps <= 0 || remaining <= 0) {
    return "";
  }
  const secs = Math.ceil(remaining / bps);
  if (secs < 60) {
    return `${secs}s`;
  }
  if (secs < 3600) {
    return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  }
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function resolveTorrentName(status = {}) {
  const btName = String(status?.bittorrent?.info?.name || "").trim();
  if (btName) {
    return btName;
  }
  const files = Array.isArray(status?.files) ? status.files : [];
  if (files.length > 0) {
    return path.basename(String(files[0]?.path || "").trim()) || "";
  }
  return "";
}

// ──────────────────────────────────────────────
// Card builder
// ──────────────────────────────────────────────

function buildDownloadCard({
  status = "info",
  title = "下载任务",
  subtitle = "",
  body = "",
  sourceUrl = "",
  progress = null,
  actions = []
} = {}) {
  // Frontend expects card.progress to be a number (0-100) or null
  const progressValue = Number.isFinite(Number(progress)) ? Math.max(0, Math.min(100, Number(progress))) : null;
  return {
    type: "media-result",
    status,
    title: String(title || "下载任务").trim(),
    subtitle: String(subtitle || "").trim(),
    body: String(body || "").trim(),
    progress: progressValue,
    imageUrl: "",
    imageAlt: String(title || "下载任务").trim(),
    mediaAttachmentId: "",
    sourceLabel: sourceUrl ? "查看来源" : "",
    sourceUrl: String(sourceUrl || "").trim(),
    actions: Array.isArray(actions) ? actions : []
  };
}

// ──────────────────────────────────────────────
// Misc
// ──────────────────────────────────────────────

async function waitWithSignal(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      reject(Object.assign(new Error("job cancelled"), { name: "AbortError" }));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function collectDownloadedFiles(tempDir) {
  const results = [];
  let entries;
  try {
    entries = await fs.promises.readdir(tempDir, { withFileTypes: true, recursive: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const entryDir = typeof entry.parentPath === "string" ? entry.parentPath : (entry.path || tempDir);
    const absolutePath = path.join(entryDir, entry.name);
    try {
      const stat = await fs.promises.stat(absolutePath);
      results.push({ absolutePath, size: Number(stat.size || 0) });
    } catch {
      // skip inaccessible files
    }
  }
  return results;
}

// ──────────────────────────────────────────────
// Core download executor
// ──────────────────────────────────────────────

async function executeAria2Download(context, api) {
  const rawText = String(context?.trigger?.rawText || "").trim();
  const parsedArgs = context?.trigger?.parsedArgs && typeof context.trigger.parsedArgs === "object"
    ? context.trigger.parsedArgs
    : {};
  const sourceFromArgs = String(parsedArgs.source || parsedArgs.sourceUrl || parsedArgs.url || "").trim();
  const source = sourceFromArgs || extractSourceFromText(rawText);

  const messageId = createBotJobMessageId(context.jobId);
  const targetFolder = sanitizeFolder(
    String(parsedArgs.targetFolder || parsedArgs.folder || parsedArgs.dir || "").trim()
    || extractTargetFolder(rawText)
    || aria2ImportDir
  );

  // ── Validate source ──
  if (!source) {
    const chatReply = await api.publishChatReply({
      id: messageId,
      createdAt: context.createdAt,
      text: "",
      attachments: [],
      card: buildDownloadCard({
        status: "failed",
        title: "缺少下载链接",
        body: "请提供磁力链接（magnet:?）、电驴链接（ed2k://）或 HTTP(S) 下载地址。\n\n示例：\n@dl magnet:?xt=urn:btih:...\n@dl ed2k://|file|...|/\n@dl https://example.com/file.iso"
      })
    });
    return { chatReply, importedFiles: [], artifacts: [] };
  }

  const sourceType = classifySource(source);
  if (!isValidSource(source)) {
    const chatReply = await api.publishChatReply({
      id: messageId,
      createdAt: context.createdAt,
      text: "",
      attachments: [],
      card: buildDownloadCard({
        status: "failed",
        title: "不支持的链接格式",
        body: `无法识别链接类型：${source.slice(0, 60)}\n\n支持：magnet:? / ed2k:// / http:// / https://`,
        sourceUrl: /^https?:\/\//i.test(source) ? source : ""
      })
    });
    return { chatReply, importedFiles: [], artifacts: [] };
  }

  // ── Check aria2 RPC connectivity ──
  try {
    await aria2GetVersion({ signal: AbortSignal.timeout(5000) });
  } catch (err) {
    const rpcUrl = getRpcUrl();
    const body = [
      `无法连接到 aria2 RPC（${rpcUrl}）。`,
      "",
      "请先在 NAS 上启动 aria2 守护进程，例如：",
      "  aria2c --enable-rpc --rpc-listen-all=false --rpc-listen-port=6800 \\",
      "    --daemon --log-level=warn",
      "",
      "如已设置了 RPC 密钥（--rpc-secret），请同时配置环境变量：",
      "  ARIA2_RPC_SECRET=your-secret",
      "",
      "如需更改 RPC 地址，请设置：",
      "  ARIA2_RPC_URL=http://127.0.0.1:6800/jsonrpc"
    ].join("\n");
    const chatReply = await api.publishChatReply({
      id: messageId,
      createdAt: context.createdAt,
      text: "",
      attachments: [],
      card: buildDownloadCard({
        status: "failed",
        title: "aria2 未运行",
        body
      })
    });
    return { chatReply, importedFiles: [], artifacts: [] };
  }

  // ── Prepare temp download dir ──
  const tempDir = path.join(api.appDataRoot, "aria2-temp", context.jobId);
  await fs.promises.mkdir(tempDir, { recursive: true });

  const shortSource = source.length > 80 ? `${source.slice(0, 77)}…` : source;
  const typeLabel = labelForSourceType(sourceType);

  // ── Add download to aria2 ──
  let gid;
  try {
    gid = await aria2AddUri([source], { dir: tempDir }, { signal: api.signal });
    await api.appendLog(`aria2 addUri gid=${gid} source=${source}`);
  } catch (err) {
    await api.appendLog(`aria2 addUri failed: ${err.message}`);
    const chatReply = await api.publishChatReply({
      id: messageId,
      createdAt: context.createdAt,
      text: "",
      attachments: [],
      card: buildDownloadCard({
        status: "failed",
        title: "提交下载失败",
        subtitle: typeLabel,
        body: `aria2 无法接受此链接。\n\n错误：${err.message}`,
        sourceUrl: /^https?:\/\//i.test(source) ? source : ""
      })
    });
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return { chatReply, importedFiles: [], artifacts: [] };
  }

  // ── Post initial queued card ──
  await api.publishChatReply({
    id: messageId,
    createdAt: context.createdAt,
    text: "",
    attachments: [],
    card: buildDownloadCard({
      status: "info",
      title: "下载已加入队列",
      subtitle: typeLabel,
      body: shortSource,
      progress: 0,
      actions: [{ type: "cancel-bot-job", label: "取消" }]
    })
  });

  // ── Poll for progress ──
  const startedAt = Date.now();
  let lastTransientAt = 0;
  let downloadName = "";

  while (Date.now() - startedAt < ARIA2_TIMEOUT_MS) {
    api.throwIfCancelled?.();

    let status;
    try {
      status = await aria2TellStatus(gid, { signal: api.signal });
    } catch (err) {
      await api.appendLog(`aria2 tellStatus error gid=${gid}: ${err.message}`);
      // Brief pause then retry – RPC might be temporarily busy
      await waitWithSignal(ARIA2_POLL_INTERVAL_MS, api.signal);
      continue;
    }

    const aria2Status = String(status?.status || "").toLowerCase();
    const totalLength = Number(status?.totalLength || 0);
    const completedLength = Number(status?.completedLength || 0);
    const downloadSpeed = Number(status?.downloadSpeed || 0);
    const percent = calcPercent(completedLength, totalLength);
    const resolvedName = resolveTorrentName(status) || downloadName;
    if (resolvedName) {
      downloadName = resolvedName;
    }
    const displayName = downloadName || shortSource;

    await api.emitProgress({ phase: "downloading", label: `下载中 ${percent}%`, percent });

    // ── Completed ──
    if (aria2Status === "complete") {
      await api.appendLog(`aria2 download complete gid=${gid} dir=${tempDir}`);
      const downloadedFiles = await collectDownloadedFiles(tempDir);

      if (downloadedFiles.length === 0) {
        const chatReply = await api.publishChatReply({
          id: messageId,
          createdAt: context.createdAt,
          text: "",
          attachments: [],
          card: buildDownloadCard({
            status: "failed",
            title: "下载完成但未找到文件",
            subtitle: displayName,
            body: `aria2 报告完成，但在临时目录 ${tempDir} 中未找到任何文件。`
          })
        });
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        return { chatReply, importedFiles: [], artifacts: [] };
      }

      // Import all downloaded files into library
      const importedFiles = [];
      const importErrors = [];
      for (const file of downloadedFiles) {
        try {
          const imported = await importFileIntoLibrary({
            storageRoot: api.storageRoot,
            sourcePath: file.absolutePath,
            targetFolder,
            fileName: path.basename(file.absolutePath)
          });
          importedFiles.push(imported);
          await api.appendLog(`imported: ${imported.relativePath}`);
        } catch (importErr) {
          importErrors.push(`${path.basename(file.absolutePath)}: ${importErr.message}`);
          await api.appendLog(`import failed: ${importErr.message}`);
        }
      }

      await triggerLibraryRescan({ syncFiles: api.dependencies?.syncFiles });
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});

      const importSummary = importedFiles.map((f) => f.relativePath || f.fileName).join("\n");
      const bodyLines = ["下载完成。"];
      if (importedFiles.length > 0) {
        bodyLines.push(`\n已入库：\n${importSummary}`);
      }
      if (importErrors.length > 0) {
        bodyLines.push(`\n导入失败：\n${importErrors.join("\n")}`);
      }

      const chatReply = await api.publishChatReply({
        id: messageId,
        createdAt: context.createdAt,
        text: "",
        attachments: [],
        card: buildDownloadCard({
          status: importedFiles.length > 0 ? "succeeded" : "failed",
          title: importedFiles.length > 0 ? "下载完成" : "下载完成但入库失败",
          subtitle: [typeLabel, displayName].filter(Boolean).join(" · "),
          body: bodyLines.join(""),
          progress: 100
        })
      });
      return { chatReply, importedFiles, artifacts: [] };
    }

    // ── Error ──
    if (aria2Status === "error") {
      const errorMessage = String(status?.errorMessage || "").trim() || "下载失败";
      await api.appendLog(`aria2 download error gid=${gid}: ${errorMessage}`);
      await aria2Remove(gid).catch(() => {});
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      const chatReply = await api.publishChatReply({
        id: messageId,
        createdAt: context.createdAt,
        text: "",
        attachments: [],
        card: buildDownloadCard({
          status: "failed",
          title: "下载失败",
          subtitle: [typeLabel, displayName].filter(Boolean).join(" · "),
          body: errorMessage,
          sourceUrl: /^https?:\/\//i.test(source) ? source : "",
          actions: [
            {
              type: "invoke-bot",
              label: "重试",
              botId: "aria2.downloader",
              rawText: source,
              parsedArgs: { source, targetFolder, __chatReplyMode: "replace-chat-message" }
            }
          ]
        })
      });
      return { chatReply, importedFiles: [], artifacts: [] };
    }

    // ── Removed / paused ──
    if (aria2Status === "removed" || aria2Status === "paused") {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      const chatReply = await api.publishChatReply({
        id: messageId,
        createdAt: context.createdAt,
        text: "",
        attachments: [],
        card: buildDownloadCard({
          status: "failed",
          title: aria2Status === "removed" ? "下载已取消" : "下载已暂停",
          subtitle: typeLabel,
          body: shortSource
        })
      });
      return { chatReply, importedFiles: [], artifacts: [] };
    }

    // ── In-progress: emit transient update at most every ~10 s ──
    const now = Date.now();
    if (now - lastTransientAt >= 10_000) {
      lastTransientAt = now;
      const speedLabel = formatSpeed(downloadSpeed);
      const eta = formatEta(completedLength, totalLength, downloadSpeed);
      const bodyParts = [
        totalLength > 0 ? `${formatBytes(completedLength)} / ${formatBytes(totalLength)}` : "连接中…",
        speedLabel,
        eta ? `剩余 ${eta}` : ""
      ].filter(Boolean);
      await api.publishTransientChatReply({
        id: messageId,
        createdAt: context.createdAt,
        text: "",
        attachments: [],
        card: buildDownloadCard({
          status: "info",
          title: displayName || "下载中",
          subtitle: typeLabel,
          body: bodyParts.join(" · "),
          progress: percent,
          actions: [{ type: "cancel-bot-job", label: "取消" }]
        })
      });
    }

    await waitWithSignal(ARIA2_POLL_INTERVAL_MS, api.signal);
  }

  // ── Timeout ──
  await aria2Remove(gid).catch(() => {});
  await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  const chatReply = await api.publishChatReply({
    id: messageId,
    createdAt: context.createdAt,
    text: "",
    attachments: [],
    card: buildDownloadCard({
      status: "failed",
      title: "下载超时",
      subtitle: typeLabel,
      body: `等待超过 24 小时，已自动停止。\n\n${shortSource}`
    })
  });
  return { chatReply, importedFiles: [], artifacts: [] };
}

// ──────────────────────────────────────────────
// Plugin export
// ──────────────────────────────────────────────

export function createAria2DownloaderPlugin() {
  return createBotPlugin({
    botId: "aria2.downloader",
    displayName: "aria2 下载助手",
    description: "通过 aria2 下载磁力链接、电驴链接（ed2k://）及 HTTP(S) 文件，并自动入库。",
    kind: "task",
    aliases: ["dl", "aria2", "下载"],
    capabilities: ["download"],
    permissions: {
      readStorage: true,
      writeStorage: true,
      network: true
    },
    limits: {
      maxConcurrentJobs: 3,
      timeoutMs: ARIA2_TIMEOUT_MS
    },
    async execute(context, api) {
      return executeAria2Download(context, api);
    }
  });
}
