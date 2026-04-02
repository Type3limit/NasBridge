import fs from "node:fs";
import path from "node:path";
import { createBotJobMessageId } from "../context.js";
import { importFileIntoLibrary, triggerLibraryRescan } from "../tools/libraryImport.js";
import { createBotPlugin } from "./base.js";

const torrentImportDir = process.env.TORRENT_IMPORT_DIR || "downloads/torrent";
const TORRENT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// ──────────────────────────────────────────────
// Source helpers
// ──────────────────────────────────────────────

function classifySource(raw = "") {
  const text = String(raw || "").trim();
  if (/^magnet:\?/i.test(text)) {
    return "magnet";
  }
  if (/^https?:\/\//i.test(text)) {
    return /\.torrent(\?|$)/i.test(text) ? "torrent-url" : "unknown";
  }
  return "unknown";
}

function isValidSource(raw = "") {
  return classifySource(raw) !== "unknown";
}

function labelForSourceType(type = "") {
  return new Map([
    ["magnet", "磁力链接"],
    ["torrent-url", "Torrent 文件"]
  ]).get(type) || "未知链接";
}

function extractSourceFromText(rawText = "") {
  const text = String(rawText || "").trim();
  const magnetMatch = text.match(/magnet:\?[^\s]*/i);
  if (magnetMatch) {
    return magnetMatch[0];
  }
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

function formatEta(remaining = 0, speed = 0) {
  const bps = Number(speed || 0);
  const rem = Number(remaining || 0);
  if (bps <= 0 || rem <= 0) {
    return "";
  }
  const secs = Math.ceil(rem / bps);
  if (secs < 60) {
    return `${secs}s`;
  }
  if (secs < 3600) {
    return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  }
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function calcPercent(downloaded = 0, length = 0) {
  const d = Number(downloaded || 0);
  const l = Number(length || 0);
  if (l <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((d / l) * 100)));
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
  const progressValue = Number.isFinite(Number(progress))
    ? Math.max(0, Math.min(100, Number(progress)))
    : null;
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

// ──────────────────────────────────────────────
// Core executor
// ──────────────────────────────────────────────

async function executeTorrentDownload(context, api) {
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
    || torrentImportDir
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
        body: "请提供磁力链接（magnet:?）或 .torrent 文件的 HTTP(S) 地址。\n\n示例：\n@dl magnet:?xt=urn:btih:...\n@dl https://example.com/file.torrent"
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
        body: `支持：magnet:? 磁力链接 / .torrent 文件的 HTTP(S) 链接\n\n收到：${source.slice(0, 80)}`,
        sourceUrl: /^https?:\/\//i.test(source) ? source : ""
      })
    });
    return { chatReply, importedFiles: [], artifacts: [] };
  }

  const typeLabel = labelForSourceType(sourceType);
  const shortSource = source.length > 80 ? `${source.slice(0, 77)}…` : source;

  // ── Lazy-load WebTorrent (ESM dynamic import) ──
  let WebTorrent;
  try {
    const mod = await import("webtorrent");
    WebTorrent = mod.default;
  } catch (err) {
    const chatReply = await api.publishChatReply({
      id: messageId,
      createdAt: context.createdAt,
      text: "",
      attachments: [],
      card: buildDownloadCard({
        status: "failed",
        title: "webtorrent 模块加载失败",
        body: `请确认已安装依赖：npm install webtorrent\n\n错误：${err.message}`
      })
    });
    return { chatReply, importedFiles: [], artifacts: [] };
  }

  // ── Prepare temp download dir ──
  const tempDir = path.join(api.appDataRoot, "torrent-temp", context.jobId);
  await fs.promises.mkdir(tempDir, { recursive: true });

  // ── Post initial card ──
  await api.publishChatReply({
    id: messageId,
    createdAt: context.createdAt,
    text: "",
    attachments: [],
    card: buildDownloadCard({
      status: "info",
      title: "下载已开始",
      subtitle: typeLabel,
      body: shortSource,
      progress: 0,
      actions: [{ type: "cancel-bot-job", label: "取消" }]
    })
  });

  // ── Start WebTorrent ──
  const client = new WebTorrent();
  let cleanedUp = false;

  const cleanup = async () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    await new Promise((resolve) => client.destroy(resolve));
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const torrent = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Object.assign(new Error("添加种子超时（30s），请检查磁力链接是否有效"), { code: "ADD_TIMEOUT" }));
      }, 30_000);

      client.add(source, { path: tempDir }, (torrent) => {
        clearTimeout(timer);
        resolve(torrent);
      });

      client.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const torrentName = torrent.name || shortSource;
    await api.appendLog(`webtorrent added: "${torrentName}" files=${torrent.files.length} length=${torrent.length}`);
    await api.emitProgress({ phase: "downloading", label: "连接中", percent: 0 });

    // ── Poll progress ──
    const startedAt = Date.now();
    let lastTransientAt = 0;

    await new Promise((resolve, reject) => {
      // Abort signal → cancel
      const onAbort = () => reject(Object.assign(new Error("job cancelled"), { name: "AbortError" }));
      api.signal?.addEventListener?.("abort", onAbort, { once: true });

      // Timeout guard
      const timeoutTimer = setTimeout(() => {
        api.signal?.removeEventListener?.("abort", onAbort);
        reject(Object.assign(new Error("下载超时（24h）"), { code: "TIMEOUT" }));
      }, TORRENT_TIMEOUT_MS - (Date.now() - startedAt));

      torrent.on("error", (err) => {
        clearTimeout(timeoutTimer);
        api.signal?.removeEventListener?.("abort", onAbort);
        reject(err);
      });

      torrent.on("done", () => {
        clearTimeout(timeoutTimer);
        api.signal?.removeEventListener?.("abort", onAbort);
        resolve();
      });

      torrent.on("download", async () => {
        const percent = Math.round(torrent.progress * 100);
        await api.emitProgress({ phase: "downloading", label: `下载中 ${percent}%`, percent });

        const now = Date.now();
        if (now - lastTransientAt >= 10_000) {
          lastTransientAt = now;
          const speedLabel = formatSpeed(torrent.downloadSpeed);
          const eta = formatEta(torrent.length - torrent.downloaded, torrent.downloadSpeed);
          const bodyParts = [
            torrent.length > 0
              ? `${formatBytes(torrent.downloaded)} / ${formatBytes(torrent.length)}`
              : "连接中…",
            speedLabel,
            eta ? `剩余 ${eta}` : ""
          ].filter(Boolean);
          api.publishTransientChatReply({
            id: messageId,
            createdAt: context.createdAt,
            text: "",
            attachments: [],
            card: buildDownloadCard({
              status: "info",
              title: torrentName,
              subtitle: typeLabel,
              body: bodyParts.join(" · "),
              progress: percent,
              actions: [{ type: "cancel-bot-job", label: "取消" }]
            })
          }).catch(() => {});
        }
      });
    });

    // ── Import files ──
    const importedFiles = [];
    const importErrors = [];

    for (const file of torrent.files) {
      // webtorrent exposes file.path relative to torrent name
      const absolutePath = path.join(tempDir, file.path);
      try {
        await fs.promises.access(absolutePath);
        const imported = await importFileIntoLibrary({
          storageRoot: api.storageRoot,
          sourcePath: absolutePath,
          targetFolder: sanitizeFolder(`${targetFolder}/${torrent.name || "torrent"}`),
          fileName: path.basename(absolutePath)
        });
        importedFiles.push(imported);
        await api.appendLog(`imported: ${imported.relativePath}`);
      } catch (importErr) {
        importErrors.push(`${file.name}: ${importErr.message}`);
        await api.appendLog(`import failed: ${importErr.message}`);
      }
    }

    await triggerLibraryRescan({ syncFiles: api.dependencies?.syncFiles });
    await cleanup();

    const bodyLines = ["下载完成。"];
    if (importedFiles.length > 0) {
      bodyLines.push(`\n已入库：\n${importedFiles.map((f) => f.relativePath || f.fileName).join("\n")}`);
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
        subtitle: [typeLabel, torrentName].filter(Boolean).join(" · "),
        body: bodyLines.join(""),
        progress: 100
      })
    });
    return { chatReply, importedFiles, artifacts: [] };

  } catch (err) {
    await cleanup();
    const isCancel = err?.name === "AbortError";
    const isTimeout = err?.code === "TIMEOUT";
    const chatReply = await api.publishChatReply({
      id: messageId,
      createdAt: context.createdAt,
      text: "",
      attachments: [],
      card: buildDownloadCard({
        status: "failed",
        title: isCancel ? "下载已取消" : isTimeout ? "下载超时" : "下载失败",
        subtitle: typeLabel,
        body: isCancel ? shortSource : (err.message || "未知错误"),
        sourceUrl: /^https?:\/\//i.test(source) ? source : "",
        actions: isCancel ? [] : [
          {
            type: "invoke-bot",
            label: "重试",
            botId: "torrent.downloader",
            rawText: source,
            parsedArgs: { source, targetFolder, __chatReplyMode: "replace-chat-message" }
          }
        ]
      })
    });
    if (!isCancel) {
      await api.appendLog(`webtorrent error: ${err.message}`);
    }
    return { chatReply, importedFiles: [], artifacts: [] };
  }
}

// ──────────────────────────────────────────────
// Plugin export
// ──────────────────────────────────────────────

export function createTorrentDownloaderPlugin() {
  return createBotPlugin({
    botId: "torrent.downloader",
    displayName: "磁力下载助手",
    description: "通过 webtorrent 下载磁力链接（magnet:?）及 .torrent 文件，自动入库。无需外部工具。",
    kind: "task",
    aliases: ["dl", "torrent", "下载"],
    capabilities: ["download"],
    permissions: {
      readStorage: true,
      writeStorage: true,
      network: true
    },
    limits: {
      maxConcurrentJobs: 3,
      timeoutMs: TORRENT_TIMEOUT_MS
    },
    async execute(context, api) {
      return executeTorrentDownload(context, api);
    }
  });
}
