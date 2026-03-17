import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createBotJobMessageId } from "../context.js";
import { importFileIntoLibrary, triggerLibraryRescan } from "../tools/libraryImport.js";
import { createBotPlugin } from "./base.js";

const ytDlpPath = process.env.YT_DLP_PATH || "yt-dlp";
const bilibiliImportDir = process.env.BOT_BILIBILI_IMPORT_DIR || "downloads/bilibili";
const bilibiliCookieFile = process.env.BOT_BILIBILI_COOKIE_FILE || "";
const bilibiliDownloadBackend = String(process.env.BOT_BILIBILI_DOWNLOAD_BACKEND || "playwright").trim().toLowerCase();
const bilibiliPlaywrightHeadless = process.env.BOT_BILIBILI_PLAYWRIGHT_HEADLESS !== "0";
const bilibiliPlaywrightExecutablePath = String(process.env.BOT_BILIBILI_PLAYWRIGHT_EXECUTABLE_PATH || "").trim();
const bilibiliPlaywrightProxy = String(process.env.BOT_BILIBILI_PLAYWRIGHT_PROXY || "").trim();
const bundledBrowserMissingPattern = /Executable doesn't exist|browserType\.launch:.*executable/i;

function getPlaywrightExecutableCandidates() {
  const candidates = [];
  if (bilibiliPlaywrightExecutablePath) {
    candidates.push(bilibiliPlaywrightExecutablePath);
  }
  if (process.platform === "win32") {
    const localAppData = String(process.env.LOCALAPPDATA || "").trim();
    candidates.push(
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
    );
    if (localAppData) {
      candidates.push(
        `${localAppData}/Google/Chrome/Application/chrome.exe`,
        `${localAppData}/Microsoft/Edge/Application/msedge.exe`
      );
    }
  }
  return [...new Set(candidates.map((item) => String(item || "").trim()).filter(Boolean))];
}

function resolveExistingPlaywrightExecutable() {
  for (const candidate of getPlaywrightExecutableCandidates()) {
    const normalized = candidate.replace(/\//g, path.sep);
    if (fs.existsSync(normalized)) {
      return normalized;
    }
  }
  return "";
}

function extractBilibiliVideoId(value = "") {
  const match = String(value || "").match(/\b(BV[0-9A-Za-z]+)\b/i);
  const raw = String(match?.[1] || "").trim();
  if (!raw) {
    return "";
  }
  return `BV${raw.slice(2)}`;
}

function canonicalizeBilibiliVideoId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  return `bvid:${raw.toLowerCase()}`;
}

function normalizeBilibiliSource(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  const videoId = extractBilibiliVideoId(raw);
  if (videoId) {
    return `https://www.bilibili.com/video/${videoId}`;
  }
  return raw;
}

function isSupportedBilibiliSource(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return false;
  }
  if (/^BV[0-9A-Za-z]+$/i.test(raw)) {
    return true;
  }
  try {
    const url = new URL(raw);
    const hostname = String(url.hostname || "").toLowerCase();
    return hostname === "b23.tv" || hostname === "bilibili.com" || hostname === "www.bilibili.com" || hostname.endsWith(".bilibili.com");
  } catch {
    return false;
  }
}

function sanitizeImportFolder(value = "") {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.\./g, "").replace(/\/+/g, "/");
}

function sanitizeTempName(value = "", fallback = "bilibili") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "");
  return cleaned || fallback;
}

function guessFileExtension(url = "", fallback = ".bin") {
  try {
    const pathname = new URL(url).pathname || "";
    return path.extname(pathname) || fallback;
  } catch {
    return fallback;
  }
}

function formatDurationLabel(durationSeconds = 0) {
  const seconds = Math.max(0, Math.floor(Number(durationSeconds || 0)));
  if (!seconds) {
    return "";
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainSeconds = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainSeconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainSeconds).padStart(2, "0")}`;
}

function buildMediaHeaders(sourceUrl, userAgent = "", cookieHeader = "") {
  const referer = String(sourceUrl || "https://www.bilibili.com/").trim() || "https://www.bilibili.com/";
  const headers = {
    Referer: referer,
    Origin: "https://www.bilibili.com",
    Accept: "*/*"
  };
  if (userAgent) {
    headers["User-Agent"] = userAgent;
  }
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }
  return headers;
}

function buildCookieHeader(cookies = []) {
  return cookies.filter((cookie) => cookie?.name).map((cookie) => `${cookie.name}=${cookie.value || ""}`).join("; ");
}

function buildSourceKeys(source, metadata = {}) {
  const keys = new Set();
  const sourceText = String(source || "").trim();
  const webpageUrl = String(metadata?.webpage_url || "").trim();
  const originalUrl = String(metadata?.original_url || "").trim();
  const videoId = String(metadata?.id || extractBilibiliVideoId(sourceText) || extractBilibiliVideoId(webpageUrl) || extractBilibiliVideoId(originalUrl)).trim();
  if (sourceText) {
    keys.add(`source:${sourceText}`);
  }
  if (webpageUrl) {
    keys.add(`url:${webpageUrl}`);
  }
  if (originalUrl) {
    keys.add(`url:${originalUrl}`);
  }
  if (videoId) {
    keys.add(canonicalizeBilibiliVideoId(videoId));
  }
  return [...keys];
}

async function readReuseIndex(appDataRoot) {
  const indexPath = path.join(appDataRoot, "bilibili-cache.json");
  try {
    const raw = await fs.promises.readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeReuseIndex(appDataRoot, index) {
  const indexPath = path.join(appDataRoot, "bilibili-cache.json");
  await fs.promises.mkdir(appDataRoot, { recursive: true });
  await fs.promises.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
}

async function findReusableImport({ appDataRoot, storageRoot, targetFolder, source, metadata }) {
  const keys = buildSourceKeys(source, metadata);
  const index = await readReuseIndex(appDataRoot);
  for (const key of keys) {
    const hit = index?.[key];
    const relativePath = String(hit?.relativePath || "").trim();
    if (!relativePath) {
      continue;
    }
    const absolutePath = path.join(storageRoot, relativePath.replace(/\//g, path.sep));
    try {
      const stat = await fs.promises.stat(absolutePath);
      return {
        absolutePath,
        relativePath,
        fileName: path.basename(absolutePath),
        size: Number(stat.size || 0),
        mimeType: String(hit?.mimeType || "application/octet-stream")
      };
    } catch {
    }
  }

  const videoId = String(metadata?.id || "").trim() || extractBilibiliVideoId(source);
  if (!videoId) {
    return null;
  }
  const targetDir = path.join(storageRoot, sanitizeImportFolder(targetFolder || bilibiliImportDir));
  try {
    const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.includes(`[${videoId}]`)) {
        continue;
      }
      const absolutePath = path.join(targetDir, entry.name);
      const stat = await fs.promises.stat(absolutePath);
      return {
        absolutePath,
        relativePath: path.relative(storageRoot, absolutePath).split(path.sep).join("/"),
        fileName: entry.name,
        size: Number(stat.size || 0),
        mimeType: "application/octet-stream"
      };
    }
  } catch {
  }
  return null;
}

async function rememberImportedResult({ appDataRoot, source, metadata, imported }) {
  const keys = buildSourceKeys(source, metadata);
  if (!keys.length || !imported?.relativePath) {
    return;
  }
  const index = await readReuseIndex(appDataRoot);
  for (const key of keys) {
    index[key] = {
      relativePath: String(imported.relativePath || ""),
      mimeType: String(imported.mimeType || "application/octet-stream"),
      updatedAt: new Date().toISOString()
    };
  }
  await writeReuseIndex(appDataRoot, index);
}

function extractSourceFromContext(context) {
  const explicit = String(context?.trigger?.parsedArgs?.source || "").trim();
  if (explicit) {
    return normalizeBilibiliSource(explicit);
  }
  const rawText = String(context?.trigger?.rawText || "");
  const urlMatch = rawText.match(/https?:\/\/\S+/i);
  if (urlMatch?.[0]) {
    return normalizeBilibiliSource(urlMatch[0]);
  }
  const bvMatch = rawText.match(/\bBV[0-9A-Za-z]+\b/i);
  if (bvMatch?.[0]) {
    return normalizeBilibiliSource(bvMatch[0]);
  }
  return "";
}

function buildBilibiliCard({ metadata, imported, source, attachmentId, status = "succeeded", reusable = false }) {
  const title = String(metadata?.title || imported?.fileName || "Bilibili download").trim();
  const uploader = String(metadata?.owner?.name || metadata?.uploader || metadata?.channel || "").trim();
  const durationLabel = formatDurationLabel(metadata?.duration || 0);
  const sourceLabel = String(metadata?.webpage_url || source || "").trim();
  const imageUrl = String(metadata?.thumbnail || metadata?.pic || "").trim();
  const subtitle = [uploader, durationLabel, imported?.relativePath || imported?.fileName || ""].filter(Boolean).join(" · ");
  const actions = [];
  if (attachmentId && String(imported?.mimeType || "").startsWith("video/")) {
    actions.push({ type: "open-attachment", label: "打开资源", attachmentId });
  }
  if (sourceLabel) {
    actions.push({ type: "open-url", label: "打开来源", url: sourceLabel });
  }
  return {
    type: "media-result",
    status,
    title,
    subtitle,
    body: reusable ? "已复用已入库资源" : `已入库到 ${imported?.relativePath || imported?.fileName || "资源库"}`,
    progress: null,
    imageUrl,
    imageAlt: title,
    mediaAttachmentId: attachmentId || "",
    sourceLabel,
    sourceUrl: sourceLabel,
    actions
  };
}

function readYtDlpProgress(text = "") {
  const matches = [...String(text || "").matchAll(/\[download\]\s+(\d+(?:\.\d+)?)%/gi)];
  const rawValue = matches.length ? matches[matches.length - 1]?.[1] : "";
  const percent = Number(rawValue);
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;
}

function detectYtDlpPhase(text = "") {
  const value = String(text || "");
  if (/\[download\].*Destination:/i.test(value)) {
    return { phase: "download-remote", label: "下载视频中", percent: 12 };
  }
  if (/\[Merger\]|Merging formats/i.test(value)) {
    return { phase: "postprocess", label: "合并中", percent: 88 };
  }
  if (/\[ExtractAudio\]|Extracting audio/i.test(value)) {
    return { phase: "download-remote", label: "下载音频中", percent: 78 };
  }
  if (/\[Metadata\]|Adding metadata/i.test(value)) {
    return { phase: "postprocess", label: "整理元数据中", percent: 92 };
  }
  if (/\[MoveFiles\]|after_move:filepath/i.test(value)) {
    return { phase: "postprocess", label: "收尾处理中", percent: 94 };
  }
  return null;
}

async function runYtDlp(args, { cwd, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onOutput?.(text, "stdout");
    });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onOutput?.(text, "stderr");
    });
    proc.on("error", (error) => {
      reject(new Error(`failed to start yt-dlp (${ytDlpPath}): ${error.message || error}`));
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}: ${(stderr || stdout).trim() || "unknown error"}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function loadPlaywrightCookies(targetUrl) {
  if (!bilibiliCookieFile) {
    return [];
  }
  const raw = await fs.promises.readFile(bilibiliCookieFile, "utf-8");
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  const pageUrl = new URL(targetUrl);
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    const cookies = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : [];
    return cookies.filter((item) => item?.name && item?.value);
  }
  const cookies = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const next = String(line || "").trim();
    if (!next || next.startsWith("#")) {
      continue;
    }
    const parts = next.split("\t");
    if (parts.length < 7) {
      continue;
    }
    const [domain, includeSubdomains, cookiePath, secureFlag, expiresRaw, name, value] = parts;
    const normalizedDomain = String(domain || "").trim();
    const normalizedPath = String(cookiePath || "/").trim() || "/";
    const host = pageUrl.hostname;
    const domainMatches = normalizedDomain.startsWith(".")
      ? host === normalizedDomain.slice(1) || host.endsWith(normalizedDomain)
      : host === normalizedDomain || (includeSubdomains === "TRUE" && host.endsWith(`.${normalizedDomain}`));
    if (!domainMatches || !name) {
      continue;
    }
    cookies.push({
      name: String(name || "").trim(),
      value: String(value || ""),
      domain: normalizedDomain,
      path: normalizedPath,
      secure: String(secureFlag || "").toUpperCase() === "TRUE",
      expires: Number(expiresRaw || 0) > 0 ? Number(expiresRaw) : -1,
      httpOnly: false,
      sameSite: "Lax"
    });
  }
  return cookies;
}

async function loadPlaywrightChromium() {
  const mod = await import("playwright");
  return mod.chromium || mod.default?.chromium || null;
}

async function launchPlaywrightBrowser(chromium) {
  const baseOptions = {
    headless: bilibiliPlaywrightHeadless,
    proxy: bilibiliPlaywrightProxy ? { server: bilibiliPlaywrightProxy } : undefined
  };
  const preferredExecutable = resolveExistingPlaywrightExecutable();
  if (preferredExecutable) {
    return chromium.launch({
      ...baseOptions,
      executablePath: preferredExecutable
    });
  }
  try {
    return await chromium.launch(baseOptions);
  } catch (error) {
    if (!bundledBrowserMissingPattern.test(String(error?.message || error || ""))) {
      throw error;
    }
    const fallbackExecutable = resolveExistingPlaywrightExecutable();
    if (!fallbackExecutable) {
      throw error;
    }
    return chromium.launch({
      ...baseOptions,
      executablePath: fallbackExecutable
    });
  }
}

async function extractPlaywrightPageData(source) {
  const chromium = await loadPlaywrightChromium();
  if (!chromium) {
    throw new Error("playwright chromium is unavailable");
  }
  const browser = await launchPlaywrightBrowser(chromium);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const cookies = await loadPlaywrightCookies(source).catch(() => []);
    if (cookies.length) {
      await context.addCookies(cookies);
    }
    const page = await context.newPage();
    await page.goto(source, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);
    await page.waitForFunction(() => Boolean(window.__INITIAL_STATE__ || window.__playinfo__), null, { timeout: 8000 }).catch(() => {});
    const extracted = await page.evaluate(() => {
      function extractJsonObject(text, marker) {
        const index = text.indexOf(marker);
        if (index < 0) return null;
        const start = text.indexOf("{", index + marker.length);
        if (start < 0) return null;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let pos = start; pos < text.length; pos += 1) {
          const char = text[pos];
          if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
          }
          if (char === '"') {
            inString = true;
            continue;
          }
          if (char === "{") {
            depth += 1;
            continue;
          }
          if (char === "}") {
            depth -= 1;
            if (depth === 0) {
              try {
                return JSON.parse(text.slice(start, pos + 1));
              } catch {
                return null;
              }
            }
          }
        }
        return null;
      }
      function parseInlineWindowObject(name) {
        for (const script of Array.from(document.scripts || [])) {
          const text = script.textContent || "";
          const parsed = extractJsonObject(text, `window.${name}=`);
          if (parsed) {
            return parsed;
          }
        }
        return null;
      }
      const state = window.__INITIAL_STATE__ || parseInlineWindowObject("__INITIAL_STATE__") || {};
      const playinfo = window.__playinfo__ || parseInlineWindowObject("__playinfo__") || {};
      const videoData = state?.videoData || {};
      const owner = videoData?.owner || state?.upData || {};
      const playData = playinfo?.data || playinfo?.result || {};
      return {
        title: String(videoData?.title || document.title || "").trim(),
        webpage_url: location.href,
        id: String(videoData?.bvid || videoData?.bvidStr || "").trim(),
        thumbnail: String(videoData?.pic || "").trim(),
        duration: Number(videoData?.duration || 0),
        owner: { name: String(owner?.name || "").trim() },
        playData: playData && typeof playData === "object" ? playData : {}
      };
    });
    const currentUrl = page.url();
    const contextCookies = await context.cookies(currentUrl);
    return {
      metadata: {
        title: extracted?.title || "",
        webpage_url: extracted?.webpage_url || currentUrl,
        id: extracted?.id || extractBilibiliVideoId(currentUrl),
        thumbnail: extracted?.thumbnail || "",
        owner: extracted?.owner || {},
        duration: Number(extracted?.duration || 0)
      },
      playData: extracted?.playData || {},
      userAgent: await page.evaluate(() => navigator.userAgent),
      cookieHeader: buildCookieHeader(contextCookies)
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

function chooseBestDashVideo(videos = []) {
  return [...(videos || [])]
    .filter((item) => item?.baseUrl || item?.base_url)
    .sort((left, right) => {
      const leftAvc = /avc|h264/i.test(String(left?.codecs || "")) ? 1 : 0;
      const rightAvc = /avc|h264/i.test(String(right?.codecs || "")) ? 1 : 0;
      if (leftAvc !== rightAvc) {
        return rightAvc - leftAvc;
      }
      return Number(right?.bandwidth || right?.bandWidth || 0) - Number(left?.bandwidth || left?.bandWidth || 0);
    })[0] || null;
}

function chooseBestDashAudio(audios = []) {
  return [...(audios || [])]
    .filter((item) => item?.baseUrl || item?.base_url)
    .sort((left, right) => Number(right?.bandwidth || right?.bandWidth || 0) - Number(left?.bandwidth || left?.bandWidth || 0))[0] || null;
}

async function downloadUrlToFile(url, targetPath, options = {}) {
  const response = await fetch(url, { method: "GET", headers: options.headers || {}, redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`.trim());
  }
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const totalBytes = Number(response.headers.get("content-length") || 0) || 0;
  const handle = await fs.promises.open(targetPath, options.append ? "a" : "w");
  let transferredBytes = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      await handle.write(chunk, 0, chunk.length);
      transferredBytes += chunk.length;
      options.onProgress?.({ transferredBytes, totalBytes });
    }
  } finally {
    await handle.close();
  }
  return { totalBytes: Math.max(totalBytes, transferredBytes), transferredBytes };
}

function buildWeightedProgressReporter(api, ranges = []) {
  const totals = new Map();
  const loaded = new Map();
  return async (key, payload = {}) => {
    const range = ranges.find((item) => item.key === key) || { min: 10, max: 80, label: "下载中", phase: "download-remote" };
    if (Number.isFinite(payload.totalBytes) && payload.totalBytes > 0) totals.set(key, Number(payload.totalBytes));
    if (Number.isFinite(payload.transferredBytes) && payload.transferredBytes >= 0) loaded.set(key, Number(payload.transferredBytes));
    const min = Number(range.min || 0);
    const max = Number(range.max || 100);
    const total = totals.get(key) || 0;
    const current = loaded.get(key) || 0;
    let percent = min;
    if (total > 0) {
      percent = min + Math.round(Math.max(0, Math.min(1, current / total)) * Math.max(0, max - min));
    } else if (current > 0) {
      percent = Math.min(max - 2, min + Math.floor(current / (5 * 1024 * 1024)) * 4);
    }
    await api.emitProgress({ phase: String(range.phase || "download-remote"), label: String(payload.label || range.label || "下载中"), percent: Math.max(min, Math.min(max, percent)) });
  };
}

async function mergeStreamsWithFfmpeg(videoPath, audioPath, outputPath, api) {
  const ffmpegBin = String(api.dependencies?.ffmpegPath || "ffmpeg").trim() || "ffmpeg";
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, ["-y", "-i", videoPath, "-i", audioPath, "-c", "copy", outputPath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => reject(new Error(`failed to start ffmpeg (${ffmpegBin}): ${error.message || error}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim() || "unknown error"}`));
        return;
      }
      resolve(outputPath);
    });
  });
}

async function readMetadata(source, tempDir, api) {
  if (bilibiliDownloadBackend !== "yt-dlp") {
    try {
      const extracted = await extractPlaywrightPageData(source);
      return { ...extracted.metadata, __playwright: extracted };
    } catch (error) {
      await api?.appendLog?.(`playwright metadata failed: ${error.message || error}`);
      if (bilibiliDownloadBackend === "playwright-only") {
        throw error;
      }
    }
  }
  const args = ["--dump-single-json", "--no-warnings", "--skip-download"];
  if (bilibiliCookieFile) {
    args.push("--cookies", bilibiliCookieFile);
  }
  args.push(source);
  const result = await runYtDlp(args, { cwd: tempDir });
  const lines = result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const rawJson = lines.find((line) => line.startsWith("{")) || "{}";
  try {
    return JSON.parse(rawJson);
  } catch {
    return {};
  }
}

async function findNewestDownloadedFile(rootDir) {
  const candidates = [];
  async function walk(currentDir) {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (/\.(part|ytdl|temp|tmp)$/i.test(entry.name)) {
        continue;
      }
      try {
        const stat = await fs.promises.stat(absolutePath);
        if (!stat.isFile() || stat.size <= 0) continue;
        candidates.push({ absolutePath, mtimeMs: Number(stat.mtimeMs || 0) });
      } catch {
      }
    }
  }
  try {
    await walk(rootDir);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.absolutePath || "";
}

function detectPrintedFilePath(lines, tempDir) {
  const normalizedTempDir = path.resolve(tempDir);
  for (const line of [...lines].reverse()) {
    const value = String(line || "").trim().replace(/^"|"$/g, "");
    if (!value) continue;
    if (fs.existsSync(value)) return path.resolve(value);
    const destinationMatch = value.match(/Destination:\s+(.+)$/i);
    const mergerMatch = value.match(/Merging formats into\s+"(.+)"/i);
    const movedMatch = value.match(/into\s+"(.+)"/i);
    const candidate = String(destinationMatch?.[1] || mergerMatch?.[1] || movedMatch?.[1] || "").trim().replace(/^"|"$/g, "");
    if (!candidate) continue;
    const resolved = path.isAbsolute(candidate) ? candidate : path.join(normalizedTempDir, candidate);
    if (fs.existsSync(resolved)) return path.resolve(resolved);
  }
  return "";
}

async function downloadMediaWithPlaywright(source, tempDir, api, metadata = {}) {
  const extracted = metadata?.__playwright || await extractPlaywrightPageData(source);
  const playData = extracted?.playData || {};
  const pageUrl = String(metadata?.webpage_url || extracted?.metadata?.webpage_url || source).trim();
  const mediaHeaders = buildMediaHeaders(pageUrl, extracted?.userAgent || "", extracted?.cookieHeader || "");
  const identifier = String(metadata?.id || extracted?.metadata?.id || extractBilibiliVideoId(source) || "video").trim();
  const baseStem = sanitizeTempName(`${metadata?.title || extracted?.metadata?.title || "Bilibili"} [${identifier}]`, `Bilibili [${identifier}]`);

  if (Array.isArray(playData?.durl) && playData.durl.length) {
    const progressiveUrl = String(playData.durl[0]?.url || "").trim();
    if (!progressiveUrl) {
      throw new Error("playwright extracted empty progressive url");
    }
    const targetPath = path.join(tempDir, `${baseStem}${guessFileExtension(progressiveUrl, ".mp4")}`);
    const reportProgress = buildWeightedProgressReporter(api, [{ key: "progressive", min: 12, max: 88, label: "下载视频中", phase: "download-remote" }]);
    await downloadUrlToFile(progressiveUrl, targetPath, { headers: mediaHeaders, onProgress: (payload) => reportProgress("progressive", payload) });
    await api.appendLog(`playwright downloaded progressive media: ${targetPath}`);
    return path.resolve(targetPath);
  }

  const dashVideo = chooseBestDashVideo(playData?.dash?.video || []);
  const dashAudio = chooseBestDashAudio(playData?.dash?.audio || []);
  if (!dashVideo) {
    throw new Error("playwright could not resolve bilibili media streams");
  }

  const videoUrl = String(dashVideo.baseUrl || dashVideo.base_url || "").trim();
  const audioUrl = String(dashAudio?.baseUrl || dashAudio?.base_url || "").trim();
  const videoPath = path.join(tempDir, `${baseStem}.video${guessFileExtension(videoUrl, ".m4s")}`);
  const audioPath = audioUrl ? path.join(tempDir, `${baseStem}.audio${guessFileExtension(audioUrl, ".m4s")}`) : "";
  const outputPath = path.join(tempDir, `${baseStem}.mp4`);
  const reportProgress = buildWeightedProgressReporter(api, [
    { key: "video", min: 12, max: audioUrl ? 62 : 84, label: "下载视频中", phase: "download-remote" },
    { key: "audio", min: 64, max: 84, label: "下载音频中", phase: "download-remote" }
  ]);

  await downloadUrlToFile(videoUrl, videoPath, { headers: mediaHeaders, onProgress: (payload) => reportProgress("video", payload) });
  if (audioUrl && audioPath) {
    await downloadUrlToFile(audioUrl, audioPath, { headers: mediaHeaders, onProgress: (payload) => reportProgress("audio", payload) });
    await api.emitProgress({ phase: "postprocess", label: "合并中", percent: 90 });
    await mergeStreamsWithFfmpeg(videoPath, audioPath, outputPath, api);
    await api.appendLog(`playwright merged media: ${outputPath}`);
    return path.resolve(outputPath);
  }
  await api.appendLog(`playwright downloaded video-only media: ${videoPath}`);
  return path.resolve(videoPath);
}

async function downloadMediaWithYtDlp(source, tempDir, api) {
  const outputTemplate = path.join(tempDir, "%(title).120B [%(id)s].%(ext)s");
  const args = ["--newline", "--print", "after_move:filepath", "-o", outputTemplate];
  if (bilibiliCookieFile) {
    args.push("--cookies", bilibiliCookieFile);
  }
  if (api.dependencies?.ffmpegPath && /[\\/]/.test(String(api.dependencies.ffmpegPath))) {
    args.push("--ffmpeg-location", path.dirname(String(api.dependencies.ffmpegPath)));
  }
  args.push(source);
  let currentPercent = 10;
  let currentPhasePercent = 10;
  const result = await runYtDlp(args, {
    cwd: tempDir,
    onOutput: async (text) => {
      const nextPercent = readYtDlpProgress(text);
      if (nextPercent !== null && nextPercent !== currentPercent) {
        currentPercent = nextPercent;
        await api.emitProgress({ phase: "download-remote", label: `下载视频中`, percent: Math.max(12, Math.min(86, 12 + Math.round(nextPercent * 0.74))) });
        return;
      }
      const phaseUpdate = detectYtDlpPhase(text);
      if (phaseUpdate && phaseUpdate.percent > currentPhasePercent) {
        currentPhasePercent = phaseUpdate.percent;
        await api.emitProgress(phaseUpdate);
      }
    }
  });
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const downloadedPath = detectPrintedFilePath(lines, tempDir) || await findNewestDownloadedFile(tempDir);
  if (!downloadedPath) {
    throw new Error("yt-dlp completed but downloaded file path was not detected");
  }
  await api.appendLog(`downloaded file: ${downloadedPath}`);
  return path.resolve(downloadedPath);
}

async function downloadMedia(source, tempDir, api, metadata = {}) {
  if (bilibiliDownloadBackend !== "yt-dlp") {
    try {
      await api.emitProgress({ phase: "download-remote", label: "解析中", percent: 10 });
      return await downloadMediaWithPlaywright(source, tempDir, api, metadata);
    } catch (error) {
      await api.appendLog(`playwright download failed: ${error.message || error}`);
      if (bilibiliDownloadBackend === "playwright-only") {
        throw error;
      }
      await api.emitProgress({ phase: "download-remote", label: "Playwright 失败，切换 yt-dlp", percent: 10 });
    }
  }
  await api.emitProgress({ phase: "download-remote", label: "解析中", percent: 10 });
  return downloadMediaWithYtDlp(source, tempDir, api);
}

export function createBilibiliDownloaderPlugin() {
  return createBotPlugin({
    botId: "bilibili.downloader",
    displayName: "Bilibili Downloader",
    aliases: ["bili", "bilibili"],
    description: "Download a Bilibili video by BV id or URL and import it into the local library.",
    capabilities: ["download.remote-media", "import.library", "reply.chat"],
    permissions: {
      writeLibrary: true,
      outboundHttp: true,
      spawnProcess: true,
      replyChat: true,
      publishJobEvents: true
    },
    limits: {
      maxConcurrentJobs: 1,
      timeoutMs: 60 * 60 * 1000,
      maxDownloadBytes: 20 * 1024 * 1024 * 1024
    },
    async execute(context, api) {
      const source = extractSourceFromContext(context);
      if (!source) {
        throw new Error("bilibili source is required: provide a BV id or Bilibili URL");
      }
      if (!isSupportedBilibiliSource(source)) {
        throw new Error("@bili 目前只支持 bilibili 链接、b23.tv 短链或 BV 号");
      }

      const tempDir = path.join(api.appDataRoot, "temp", context.jobId);
      await fs.promises.mkdir(tempDir, { recursive: true });
      await api.appendLog(`bilibili source: ${source}`);
      await api.emitProgress({ phase: "parse-input", label: "解析中", percent: 5 });

      let metadata = {};
      try {
        metadata = await readMetadata(source, tempDir, api);
        await api.appendLog(`metadata title: ${metadata?.title || "unknown"}`);
      } catch (error) {
        await api.appendLog(`metadata probe failed: ${error.message || error}`);
      }

      const targetFolder = sanitizeImportFolder(context?.trigger?.parsedArgs?.targetFolder || bilibiliImportDir) || bilibiliImportDir;
      const reusable = await findReusableImport({ appDataRoot: api.appDataRoot, storageRoot: api.storageRoot, targetFolder, source, metadata });
      if (reusable) {
        await api.appendLog(`reuse imported file: ${reusable.relativePath}`);
        await api.emitProgress({ phase: "reuse-existing", label: "已复用已入库资源", percent: 100 });
        const attachmentId = `bot-asset:${context.jobId}`;
        const chatReply = await api.publishChatReply({
          id: createBotJobMessageId(context.jobId),
          createdAt: context.createdAt,
          text: "",
          attachments: [{ id: attachmentId, name: reusable.fileName, mimeType: reusable.mimeType, size: reusable.size, path: reusable.relativePath, clientId: context.chat.hostClientId, kind: String(reusable.mimeType || "").startsWith("video/") ? "video" : "file" }],
          card: buildBilibiliCard({ metadata, imported: reusable, source, attachmentId, reusable: true })
        });
        return { chatReply, importedFiles: [reusable], artifacts: [] };
      }

      const downloadedPath = await downloadMedia(source, tempDir, api, metadata);
      await api.emitProgress({ phase: "import-library", label: "入库中", percent: 88 });
      const imported = await importFileIntoLibrary({ sourcePath: downloadedPath, storageRoot: api.storageRoot, targetFolder, fileName: path.basename(downloadedPath) });
      await api.appendLog(`imported file: ${imported.relativePath}`);
      await rememberImportedResult({ appDataRoot: api.appDataRoot, source, metadata, imported });
      await triggerLibraryRescan({ syncFiles: api.dependencies?.syncFiles });
      await api.emitProgress({ phase: "append-chat-reply", label: "生成结果卡片", percent: 95 });

      const attachmentId = `bot-asset:${context.jobId}`;
      const chatReply = await api.publishChatReply({
        id: createBotJobMessageId(context.jobId),
        createdAt: context.createdAt,
        text: "",
        attachments: [{ id: attachmentId, name: imported.fileName, mimeType: imported.mimeType, size: imported.size, path: imported.relativePath, clientId: context.chat.hostClientId, kind: String(imported.mimeType || "").startsWith("video/") ? "video" : "file" }],
        card: buildBilibiliCard({ metadata, imported, source, attachmentId })
      });

      return { chatReply, importedFiles: [imported], artifacts: [] };
    }
  });
}
