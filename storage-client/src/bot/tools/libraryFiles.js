import fs from "node:fs";
import path from "node:path";
import { getStorageHiddenDirectoryNames, safeJoin, scanFiles } from "../../fsIndex.js";
import { extractDocumentTextExcerpt, isExtractableDocumentPath } from "./documentText.js";
import { probeMediaFile } from "./mediaProbe.js";

export const MAX_LIBRARY_LIST_LIMIT = 80;
export const MAX_LIBRARY_DETAIL_FILES = 20;
export const MAX_SUBTITLE_INLINE_CHARS = 50_000;
export const MAX_TEXT_EXCERPT_CHARS = 20_000;
export const MAX_TEXT_EXCERPT_READ_BYTES = 512_000;
export const MAX_METADATA_UPDATE_FILES = 10;
export const MAX_FILE_ORGANIZE_ACTIONS = 20;

const SUBTITLE_EXTS = new Set([".srt", ".ass", ".vtt", ".sub", ".ssa"]);
const RAW_TEXT_EXTS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".log",
  ".xml",
  ".yaml",
  ".yml",
  ".ini",
  ".toml",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".html",
  ".htm",
  ".srt",
  ".ass",
  ".vtt",
  ".sub",
  ".ssa"
]);

export function clampInteger(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function normalizeRelativePath(value = "") {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  const single = String(value || "").trim();
  return single ? [single] : [];
}

function getExtension(relativePath = "") {
  return path.extname(String(relativePath || "")).toLowerCase();
}

function normalizeExtensionList(input = {}) {
  return normalizeStringList(input.extensions || input.extension || input.ext)
    .map((item) => String(item || "").trim().toLowerCase().replace(/^\*+/, ""))
    .map((item) => item && !item.startsWith(".") ? `.${item}` : item)
    .filter(Boolean);
}

function parseTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const ts = Date.parse(String(value || ""));
  return Number.isFinite(ts) ? ts : null;
}

function normalizeTagFilter(input = {}) {
  const tags = normalizeStringList(input.tags || input.tag);
  const anyTags = normalizeStringList(input.anyTags);
  const allTags = normalizeStringList(input.allTags);
  const mode = String(input.tagMode || "").trim().toLowerCase();
  if (allTags.length) {
    return { tags: allTags, mode: "all" };
  }
  if (anyTags.length) {
    return { tags: anyTags, mode: "any" };
  }
  if (tags.length) {
    return { tags, mode: mode === "all" ? "all" : "any" };
  }
  return { tags: [], mode: "any" };
}

function isSubtitlePath(relativePath = "") {
  return SUBTITLE_EXTS.has(getExtension(relativePath));
}

function isLikelyTextFile(file = {}) {
  const mimeType = String(file.mimeType || "").toLowerCase();
  const ext = getExtension(file.relativePath);
  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    mimeType.includes("javascript") ||
    mimeType.includes("typescript") ||
    mimeType.includes("yaml") ||
    mimeType.includes("csv") ||
    RAW_TEXT_EXTS.has(ext)
  );
}

export function isDocumentTextExtractable(file = {}) {
  return isExtractableDocumentPath(file.relativePath || file.path || file.name || "", file.mimeType || "");
}

function isMediaFile(file = {}) {
  const mimeType = String(file.mimeType || "").toLowerCase();
  return mimeType.startsWith("video/") || mimeType.startsWith("audio/") || mimeType.startsWith("image/");
}

function isVideoOrAudioFile(file = {}) {
  const mimeType = String(file.mimeType || "").toLowerCase();
  return mimeType.startsWith("video/") || mimeType.startsWith("audio/");
}

function isImageFile(file = {}) {
  return String(file.mimeType || "").toLowerCase().startsWith("image/");
}

function getSubtitleCandidates(relativePath = "", explicitPath = "") {
  const normalizedExplicit = normalizeRelativePath(explicitPath);
  const basePath = normalizeRelativePath(relativePath).replace(/\.[^/.]+$/, "");
  return [
    normalizedExplicit,
    ...[".srt", ".vtt", ".ass", ".ssa", ".sub"].map((ext) => `${basePath}${ext}`)
  ].filter(Boolean);
}

function normalizeTags(tags) {
  return Array.isArray(tags)
    ? tags.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function dedupeTags(tags = []) {
  const seen = new Set();
  const result = [];
  for (const tag of normalizeTags(tags)) {
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(tag);
  }
  return result;
}

function normalizeFileRecord(file = {}, clientId = "") {
  const relativePath = normalizeRelativePath(file.path || file.relativePath || "");
  const fileClientId = String(file.clientId || clientId || "").trim();
  const id = String(file.id || (fileClientId && relativePath ? `${fileClientId}:${relativePath}` : relativePath)).trim();
  return {
    ...file,
    id,
    clientId: fileClientId,
    path: relativePath,
    relativePath,
    name: String(file.name || path.basename(relativePath) || "").trim(),
    size: Number(file.size || 0),
    mimeType: String(file.mimeType || "application/octet-stream").trim() || "application/octet-stream",
    createdAt: String(file.createdAt || "").trim(),
    updatedAt: String(file.updatedAt || "").trim(),
    aiSummary: String(file.aiSummary || "").trim() || null,
    subtitleCachePath: normalizeRelativePath(file.subtitleCachePath || ""),
    tags: normalizeTags(file.tags)
  };
}

function normalizeDirectoryRecord(directory = {}, clientId = "") {
  const relativePath = normalizeRelativePath(directory.path || directory.relativePath || "");
  const directoryClientId = String(directory.clientId || clientId || "").trim();
  return {
    ...directory,
    id: String(directory.id || (directoryClientId && relativePath ? `${directoryClientId}:${relativePath}` : relativePath)).trim(),
    clientId: directoryClientId,
    path: relativePath,
    relativePath,
    name: String(directory.name || path.basename(relativePath) || "").trim(),
    createdAt: String(directory.createdAt || "").trim(),
    updatedAt: String(directory.updatedAt || "").trim()
  };
}

function addDerivedFileFlags(files = []) {
  const pathSet = new Set(files.map((file) => file.relativePath).filter(Boolean));
  return files.map((file) => {
    const subtitleCandidates = getSubtitleCandidates(file.relativePath, file.subtitleCachePath);
    const subtitlePath = subtitleCandidates.find((candidate) => pathSet.has(candidate)) || file.subtitleCachePath || "";
    return {
      ...file,
      isSubtitleSidecar: isSubtitlePath(file.relativePath),
      aiSummaryAvailable: Boolean(file.aiSummary),
      subtitleAvailable: Boolean(subtitlePath),
      subtitlePath
    };
  });
}

function normalizeIsoTimestamp(value = "") {
  const ts = Date.parse(String(value || ""));
  return Number.isFinite(ts) ? new Date(ts).toISOString() : "";
}

function findLatestUpdatedAt(records = []) {
  let latest = 0;
  for (const record of records) {
    const ts = Date.parse(String(record?.updatedAt || ""));
    if (Number.isFinite(ts) && ts > latest) {
      latest = ts;
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : "";
}

export async function loadLibrarySnapshot(api) {
  const clientId = String(api?.clientId || "").trim();
  let snapshot = null;
  let source = "dependency";
  if (typeof api?.dependencies?.listLibraryFiles === "function") {
    snapshot = await api.dependencies.listLibraryFiles();
  }
  if (!snapshot) {
    snapshot = await scanFiles(api.storageRoot);
    source = "scan";
  } else {
    source = String(snapshot.source || snapshot.indexSource || source).trim() || source;
  }
  const files = addDerivedFileFlags(
    (Array.isArray(snapshot.files) ? snapshot.files : [])
      .map((file) => normalizeFileRecord(file, clientId))
      .filter((file) => file.relativePath)
  );
  const directories = (Array.isArray(snapshot.directories) ? snapshot.directories : [])
    .map((directory) => normalizeDirectoryRecord(directory, clientId))
    .filter((directory) => directory.relativePath);
  return {
    clientId: String(snapshot.clientId || clientId || "").trim(),
    source,
    indexSource: source,
    generatedAt: normalizeIsoTimestamp(snapshot.generatedAt || snapshot.indexedAt || snapshot.scannedAt) || new Date().toISOString(),
    latestFileUpdatedAt: findLatestUpdatedAt([...files, ...directories]),
    hiddenDirectories: normalizeStringList(snapshot.hiddenDirectories || snapshot.hiddenDirs).length
      ? normalizeStringList(snapshot.hiddenDirectories || snapshot.hiddenDirs)
      : getHiddenDirectoryNames(),
    skippedDirectories: normalizeStringList(snapshot.skippedDirectories || snapshot.excludedDirectories),
    files,
    directories
  };
}

function matchesKind(file, kind = "all") {
  const normalized = String(kind || "all").trim().toLowerCase();
  if (!normalized || normalized === "all") {
    return true;
  }
  const mimeType = String(file.mimeType || "").toLowerCase();
  const ext = getExtension(file.relativePath);
  if (normalized === "video") {
    return mimeType.startsWith("video/");
  }
  if (normalized === "audio") {
    return mimeType.startsWith("audio/");
  }
  if (normalized === "image") {
    return mimeType.startsWith("image/");
  }
  if (normalized === "subtitle") {
    return SUBTITLE_EXTS.has(ext);
  }
  if (normalized === "document") {
    return mimeType.startsWith("text/") || mimeType.includes("pdf") || mimeType.includes("document") || mimeType.includes("sheet") || mimeType.includes("presentation");
  }
  return true;
}

function matchesQuery(file, query = "") {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const haystack = [
    file.name,
    file.relativePath,
    file.mimeType,
    ...(Array.isArray(file.tags) ? file.tags : []),
    file.aiSummary || ""
  ].join("\n").toLowerCase();
  return haystack.includes(normalized);
}

function matchesTags(file = {}, tagFilter = {}) {
  const wanted = Array.isArray(tagFilter.tags) ? tagFilter.tags.map((item) => item.toLowerCase()) : [];
  if (!wanted.length) {
    return true;
  }
  const available = new Set(normalizeTags(file.tags).map((item) => item.toLowerCase()));
  if (tagFilter.mode === "all") {
    return wanted.every((tag) => available.has(tag));
  }
  return wanted.some((tag) => available.has(tag));
}

function matchesDateRange(file = {}, field = "updatedAt", after = null, before = null) {
  if (after === null && before === null) {
    return true;
  }
  const ts = Date.parse(String(file[field] || ""));
  if (!Number.isFinite(ts)) {
    return false;
  }
  if (after !== null && ts < after) {
    return false;
  }
  if (before !== null && ts > before) {
    return false;
  }
  return true;
}

function matchesSizeRange(file = {}, minSize = null, maxSize = null) {
  const size = Number(file.size || 0);
  if (minSize !== null && size < minSize) {
    return false;
  }
  if (maxSize !== null && size > maxSize) {
    return false;
  }
  return true;
}

function sortFiles(files = [], sortBy = "updatedAt", sortDirection = "desc") {
  const key = String(sortBy || "updatedAt").trim();
  const direction = String(sortDirection || "desc").toLowerCase() === "asc" ? 1 : -1;
  return [...files].sort((left, right) => {
    if (key === "name" || key === "path" || key === "mimeType") {
      return direction * String(left[key] || "").localeCompare(String(right[key] || ""), "zh-CN");
    }
    if (key === "size") {
      return direction * (Number(left.size || 0) - Number(right.size || 0));
    }
    const leftTs = Date.parse(String(left[key] || "")) || 0;
    const rightTs = Date.parse(String(right[key] || "")) || 0;
    return direction * (leftTs - rightTs);
  });
}

export function filterLibraryFiles(files = [], input = {}) {
  const pathPrefix = normalizeRelativePath(input.pathPrefix || input.folder || "");
  const mimePrefix = String(input.mimePrefix || "").trim().toLowerCase();
  const extensions = normalizeExtensionList(input);
  const tagFilter = normalizeTagFilter(input);
  const updatedAfter = parseTimestamp(input.updatedAfter || input.modifiedAfter || input.after);
  const updatedBefore = parseTimestamp(input.updatedBefore || input.modifiedBefore || input.before);
  const createdAfter = parseTimestamp(input.createdAfter);
  const createdBefore = parseTimestamp(input.createdBefore);
  const minSize = Number.isFinite(Number(input.minSize ?? input.sizeMin)) ? Number(input.minSize ?? input.sizeMin) : null;
  const maxSize = Number.isFinite(Number(input.maxSize ?? input.sizeMax)) ? Number(input.maxSize ?? input.sizeMax) : null;
  const includeSubtitles = input.includeSubtitles === true;
  const hasAiSummary = typeof input.hasAiSummary === "boolean" ? input.hasAiSummary : null;
  const hasSubtitle = typeof input.hasSubtitle === "boolean" ? input.hasSubtitle : null;
  return files.filter((file) => {
    if (!includeSubtitles && file.isSubtitleSidecar) {
      return false;
    }
    if (pathPrefix && !file.relativePath.startsWith(pathPrefix)) {
      return false;
    }
    if (mimePrefix && !String(file.mimeType || "").toLowerCase().startsWith(mimePrefix)) {
      return false;
    }
    if (extensions.length && !extensions.includes(getExtension(file.relativePath))) {
      return false;
    }
    if (!matchesTags(file, tagFilter)) {
      return false;
    }
    if (!matchesDateRange(file, "updatedAt", updatedAfter, updatedBefore)) {
      return false;
    }
    if (!matchesDateRange(file, "createdAt", createdAfter, createdBefore)) {
      return false;
    }
    if (!matchesSizeRange(file, minSize, maxSize)) {
      return false;
    }
    if (hasAiSummary !== null && Boolean(file.aiSummaryAvailable) !== hasAiSummary) {
      return false;
    }
    if (hasSubtitle !== null && Boolean(file.subtitleAvailable) !== hasSubtitle) {
      return false;
    }
    return matchesKind(file, input.kind) && matchesQuery(file, input.query);
  });
}

export function compactLibraryFile(file = {}, index = 0) {
  return {
    index: index + 1,
    fileId: file.id,
    path: file.relativePath,
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    updatedAt: file.updatedAt,
    aiSummaryAvailable: Boolean(file.aiSummaryAvailable),
    subtitleAvailable: Boolean(file.subtitleAvailable),
    subtitlePath: file.subtitlePath || "",
    tags: file.tags || []
  };
}

export function createFileLookup(files = []) {
  const byId = new Map();
  const byPath = new Map();
  for (const file of files) {
    if (file.id) {
      byId.set(String(file.id), file);
    }
    if (file.relativePath) {
      byPath.set(String(file.relativePath).toLowerCase(), file);
    }
  }
  return { byId, byPath };
}

export function resolveLibraryFile(files = [], identifier = "") {
  const normalized = String(identifier || "").trim();
  if (!normalized) {
    return null;
  }
  const { byId, byPath } = createFileLookup(files);
  if (byId.has(normalized)) {
    return byId.get(normalized);
  }
  const maybePath = normalizeRelativePath(normalized.includes(":") ? normalized.split(":").slice(1).join(":") : normalized);
  return byPath.get(maybePath.toLowerCase()) || null;
}

async function readTextRelative(storageRoot, relativePath = "", maxChars = MAX_SUBTITLE_INLINE_CHARS) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return null;
  }
  const absolutePath = safeJoin(storageRoot, normalized);
  const content = await fs.promises.readFile(absolutePath, "utf8");
  const limit = clampInteger(maxChars, 1, MAX_SUBTITLE_INLINE_CHARS);
  return {
    path: normalized,
    text: content.length > limit ? content.slice(0, limit) : content,
    length: content.length,
    truncated: content.length > limit
  };
}

async function readTextExcerptRelative(storageRoot, relativePath = "", options = {}) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    throw new Error("path is required");
  }
  const absolutePath = safeJoin(storageRoot, normalized);
  const stat = await fs.promises.stat(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`不是可读取文件：${normalized}`);
  }

  const maxChars = clampInteger(options.maxChars || 8_000, 1, MAX_TEXT_EXCERPT_CHARS);
  const startChar = clampInteger(options.startChar || options.offset || 0, 0, Number.MAX_SAFE_INTEGER);
  if (isExtractableDocumentPath(normalized, options.mimeType || "")) {
    const documentExcerpt = await extractDocumentTextExcerpt(absolutePath, {
      ...options,
      relativePath: normalized,
      maxChars,
      startChar,
      maxAllowedChars: MAX_TEXT_EXCERPT_CHARS
    });
    return {
      path: normalized,
      source: "document",
      text: documentExcerpt.text,
      startChar: documentExcerpt.startChar,
      nextStartChar: documentExcerpt.nextStartChar,
      length: documentExcerpt.length,
      fileSize: stat.size,
      truncated: documentExcerpt.truncated,
      extractor: documentExcerpt.extractor,
      format: documentExcerpt.format,
      sourceTruncated: documentExcerpt.sourceTruncated === true
    };
  }
  const approximateByteOffset = Math.max(0, startChar);
  const readLength = Math.min(MAX_TEXT_EXCERPT_READ_BYTES, Math.max(maxChars * 4 + 4096, 4096));

  if (startChar === 0 && stat.size <= readLength) {
    const content = await fs.promises.readFile(absolutePath, "utf8");
    const text = content.slice(0, maxChars);
    return {
      path: normalized,
      source: normalized,
      text,
      startChar: 0,
      nextStartChar: text.length,
      length: content.length,
      fileSize: stat.size,
      truncated: content.length > text.length
    };
  }

  const handle = await fs.promises.open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(readLength, Math.max(0, stat.size - approximateByteOffset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, approximateByteOffset);
    const decoded = buffer.subarray(0, bytesRead).toString("utf8");
    const text = decoded.slice(0, maxChars);
    return {
      path: normalized,
      source: normalized,
      text,
      startChar,
      nextStartChar: startChar + text.length,
      length: null,
      fileSize: stat.size,
      truncated: approximateByteOffset + bytesRead < stat.size || decoded.length > text.length,
      offsetMode: "byte-approx"
    };
  } finally {
    await handle.close();
  }
}

export async function readSubtitleForFile(api, file = {}, maxChars = MAX_SUBTITLE_INLINE_CHARS) {
  const candidates = getSubtitleCandidates(file.relativePath, file.subtitleCachePath || file.subtitlePath || "");
  for (const candidate of candidates) {
    try {
      return await readTextRelative(api.storageRoot, candidate, maxChars);
    } catch {
    }
  }
  return null;
}

function collectFileIdentifiers(input = {}) {
  return [
    ...(Array.isArray(input.fileIds) ? input.fileIds : []),
    ...(Array.isArray(input.paths) ? input.paths : []),
    input.fileId,
    input.path,
    input.filePath
  ].map((item) => String(item || "").trim()).filter(Boolean);
}

function buildContentAccessHints(file = {}) {
  const rawTextReadable = isLikelyTextFile(file);
  const documentTextExtractable = isDocumentTextExtractable(file);
  const textReadable = rawTextReadable || documentTextExtractable;
  const media = isMediaFile(file);
  const videoOrAudio = isVideoOrAudioFile(file);
  const image = isImageFile(file);
  const tools = ["read_file_metadata", "diagnose_file_access", "analyze_file_content"];
  if (textReadable) {
    tools.push("read_text_excerpt");
  }
  if (file.subtitleAvailable || file.aiSummaryAvailable || media) {
    tools.push("read_media_summary");
  }
  if ((videoOrAudio || file.subtitleAvailable) && !file.aiSummaryAvailable) {
    tools.push("invoke_video_analyze");
  }
  return {
    rawTextReadable,
    documentTextExtractable,
    textReadable,
    media,
    videoOrAudio,
    image,
    subtitleAvailable: Boolean(file.subtitleAvailable),
    aiSummaryAvailable: Boolean(file.aiSummaryAvailable),
    recommendedTools: tools
  };
}

function uniqueToolList(items = []) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function buildAccessLayer({ id = "", label = "", available = false, tools = [], riskLevel = "low", detail = "", reason = "", requires = [] } = {}) {
  return {
    id,
    label,
    available: available === true,
    riskLevel,
    tools: uniqueToolList(tools),
    requires: uniqueToolList(requires),
    detail: String(detail || "").trim(),
    reason: String(reason || "").trim()
  };
}

function redactDependencyDetail(value = "") {
  return String(value || "")
    .replace(/[A-Za-z]:[\\/][^\s；,，]+/g, "[local-path]")
    .replace(/\\\\[^\s；,，]+/g, "[network-path]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .slice(0, 240);
}

function buildDependencyStatus(required = [], api = {}, options = {}) {
  const requiredIds = uniqueToolList(required);
  const checks = Array.isArray(api?.healthSnapshot?.checks) ? api.healthSnapshot.checks : [];
  const byId = new Map(checks.map((check) => [String(check?.id || "").trim(), check]).filter(([id]) => id));
  const blockingWarnIds = new Set((Array.isArray(options.blockingWarnIds) ? options.blockingWarnIds : []).map((item) => String(item || "").trim()).filter(Boolean));
  const items = requiredIds.map((id) => {
    const check = byId.get(id);
    const status = String(check?.status || "unknown").trim() || "unknown";
    const blocking = status === "error" || (status === "warn" && blockingWarnIds.has(id));
    return {
      id,
      label: String(check?.label || id).trim(),
      status,
      blocking,
      detail: redactDependencyDetail(check?.detail || ""),
      repairHint: redactDependencyDetail(check?.repairHint || "")
    };
  });
  const blockers = items.filter((item) => item.blocking);
  const repairHints = blockers
    .filter((item) => item.repairHint)
    .map((item) => `${item.label}: ${item.repairHint}`);
  const status = blockers.some((item) => item.status === "error")
    ? "error"
    : (blockers.length ? "warn" : (items.some((item) => item.status === "warn") ? "warn" : (items.some((item) => item.status === "unknown") ? "unknown" : "ok")));
  return {
    healthAvailable: checks.length > 0,
    status,
    ready: blockers.length === 0,
    required: requiredIds,
    checks: items,
    blockers,
    repairHints,
    nextAction: blockers.length
      ? [
          `先修复依赖：${blockers.map((item) => `${item.label}=${item.status}`).join("、")}，再继续分析。`,
          repairHints.length ? `建议：${repairHints.slice(0, 3).join("；")}` : ""
        ].filter(Boolean).join(" ")
      : (checks.length ? "依赖未发现阻塞，可继续执行推荐工具。" : "本次没有 health snapshot；执行前仍需以工具返回为准。")
  };
}

function inferAnalyzeAccessMode(file = {}, hints = {}) {
  if (hints.image) {
    return "image";
  }
  if (hints.videoOrAudio || file.subtitleAvailable || file.aiSummaryAvailable) {
    return "media";
  }
  if (hints.textReadable) {
    return "text";
  }
  return "metadata";
}

function getAnalysisDependencyRequirements(analyzeMode = "metadata", hints = {}) {
  if (analyzeMode === "media" && hints.videoOrAudio && !hints.aiSummaryAvailable) {
    return ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root"];
  }
  if (analyzeMode === "text" && hints.documentTextExtractable) {
    return ["ai-model", "storage-root", "document-text"];
  }
  if (analyzeMode === "image") {
    return ["ai-model", "storage-root"];
  }
  if (analyzeMode === "text") {
    return ["ai-model", "storage-root"];
  }
  return ["storage-root"];
}

function buildAccessNextActions(file = {}, hints = {}, pathSafe = true, hiddenDirectory = false, analysisDependencies = null) {
  if (!pathSafe) {
    return ["该文件索引路径未通过 storage root 安全校验；不要继续读取内容，先重新扫描或修复索引。"];
  }
  if (hiddenDirectory) {
    return ["该文件位于隐藏/系统目录；默认只应查看索引信息，不要继续读取或修改。"];
  }
  if (Array.isArray(analysisDependencies?.blockers) && analysisDependencies.blockers.length) {
    return [
      analysisDependencies.nextAction,
      "修复后重新调用 diagnose_file_access 确认依赖状态，再启动内容分析。"
    ];
  }
  if (hints.aiSummaryAvailable) {
    return ["调用 read_media_summary 或 get_storage_file_details 读取已有 AI 摘要。"];
  }
  if (hints.subtitleAvailable) {
    return ["调用 read_text_excerpt 并设置 source=subtitle 读取字幕片段，或调用 read_media_summary 查看媒体派生信息。"];
  }
  if (hints.textReadable) {
    return ["调用 read_text_excerpt 分页读取受控文本片段；需要总结时再调用 analyze_file_content。"];
  }
  if (hints.image) {
    return ["调用 analyze_file_content 分析图片内容；不会把本机绝对路径暴露给模型。"];
  }
  if (hints.videoOrAudio) {
    return ["调用 invoke_video_analyze 或 analyze_file_content(startAnalysis=true) 生成字幕和 AI 摘要。"];
  }
  return ["只能读取 metadata；二进制原文不会直接进入模型上下文。"];
}

function buildTagsPatch(currentTags = [], input = {}) {
  const hasReplaceTags = Array.isArray(input.tags);
  const addTags = dedupeTags(input.addTags || []);
  const removeTags = new Set(dedupeTags(input.removeTags || []).map((item) => item.toLowerCase()));
  if (!hasReplaceTags && !addTags.length && !removeTags.size) {
    return null;
  }
  const base = hasReplaceTags ? dedupeTags(input.tags) : dedupeTags(currentTags);
  const merged = [];
  const seen = new Set();
  for (const tag of [...base, ...addTags]) {
    const key = tag.toLowerCase();
    if (removeTags.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(tag);
  }
  return merged;
}

function redactStoragePathText(value = "", api = {}, file = {}) {
  let text = String(value || "");
  const replacements = [
    String(api.storageRoot || "").trim(),
    file?.relativePath ? safeJoin(api.storageRoot || "", file.relativePath) : ""
  ].filter(Boolean);
  for (const item of replacements) {
    text = text.split(item).join(item.includes(":") || item.includes("\\") ? "[storage-path]" : String(file.relativePath || "[storage-path]"));
  }
  return text;
}

function buildMetadataPatch(file = {}, input = {}) {
  const patch = {};
  const changedFields = [];
  const nextTags = buildTagsPatch(file.tags || [], input);
  if (nextTags) {
    patch.tags = nextTags;
    changedFields.push("tags");
  }
  if (Object.prototype.hasOwnProperty.call(input, "aiSummary")) {
    patch.aiSummary = String(input.aiSummary || "").trim();
    changedFields.push("aiSummary");
  } else if (input.clearAiSummary === true) {
    patch.aiSummary = "";
    changedFields.push("aiSummary");
  }
  return { patch, changedFields };
}

export function getHiddenDirectoryNames() {
  return getStorageHiddenDirectoryNames();
}

export function buildFileAccessPolicy(api = {}) {
  const root = String(api?.storageRoot || "").trim();
  return {
    root,
    allowedRoots: root ? [root] : [],
    hiddenDirs: getHiddenDirectoryNames(),
    hiddenDirectories: getHiddenDirectoryNames(),
    accessBy: ["fileId", "relativePath"],
    maxListResults: MAX_LIBRARY_LIST_LIMIT,
    maxDetailFiles: MAX_LIBRARY_DETAIL_FILES,
    maxInlineTextChars: MAX_TEXT_EXCERPT_CHARS,
    maxTextExcerptChars: MAX_TEXT_EXCERPT_CHARS,
    maxBatchFiles: MAX_FILE_ORGANIZE_ACTIONS,
    allowRawTextRead: true,
    allowBinaryRead: false,
    binaryReadAllowed: false,
    rawAbsolutePathExposed: false,
    storageRootOnly: true,
    writeRequiresConfirmation: true
  };
}

function isHiddenRelativePath(relativePath = "") {
  const firstSegment = normalizeRelativePath(relativePath).split("/").filter(Boolean)[0] || "";
  return getHiddenDirectoryNames().includes(firstSegment);
}

function normalizeTargetName(value = "") {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  if (/[\\/]/.test(normalized) || normalized === "." || normalized === "..") {
    throw new Error("targetName must be a file name, not a path");
  }
  if (/[<>:"|?*\x00-\x1f]/.test(normalized)) {
    throw new Error("targetName contains characters that are invalid on Windows");
  }
  return normalized;
}

function assertSafeMutationRelativePath(relativePath = "") {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized.endsWith("/")) {
    throw new Error("targetPath must point to a file");
  }
  const segments = normalized.split("/").filter(Boolean);
  for (const segment of segments) {
    if (segment === "." || segment === ".." || /[<>:"|?*\x00-\x1f]/.test(segment)) {
      throw new Error("targetPath contains an invalid path segment");
    }
  }
  return normalized;
}

function buildFileMetaCarryPatch(file = {}) {
  const patch = {};
  if (Array.isArray(file.tags) && file.tags.length) {
    patch.tags = file.tags;
  }
  if (String(file.aiSummary || "").trim()) {
    patch.aiSummary = String(file.aiSummary || "").trim();
  }
  return patch;
}

function collectOrganizeActionInputs(input = {}) {
  if (Array.isArray(input.actions) && input.actions.length) {
    return input.actions.slice(0, MAX_FILE_ORGANIZE_ACTIONS).map((action) => ({
      identifier: String(action?.fileId || action?.path || action?.filePath || "").trim(),
      targetFolder: action?.targetFolder,
      targetName: action?.targetName || action?.name,
      targetPath: action?.targetPath || action?.to,
      overwrite: action?.overwrite === true
    }));
  }

  const identifiers = [...new Set(collectFileIdentifiers(input))].slice(0, MAX_FILE_ORGANIZE_ACTIONS);
  if (identifiers.length > 1 && (input.targetName || input.targetPath)) {
    throw new Error("批量整理时不能共用单个 targetName/targetPath；请使用 targetFolder，或传 actions 为每个文件指定目标。");
  }
  return identifiers.map((identifier) => ({
    identifier,
    targetFolder: input.targetFolder || input.folder,
    targetName: input.targetName || input.name,
    targetPath: input.targetPath || input.to,
    overwrite: input.overwrite === true
  }));
}

function buildOrganizeTargetPath(file = {}, action = {}) {
  const explicitTargetPath = normalizeRelativePath(action.targetPath || "");
  if (explicitTargetPath) {
    return assertSafeMutationRelativePath(explicitTargetPath);
  }
  const targetFolder = normalizeRelativePath(action.targetFolder || "");
  const targetName = normalizeTargetName(action.targetName || "") || file.name;
  if (!targetFolder && !action.targetName) {
    throw new Error("targetFolder、targetName 或 targetPath 至少需要一个");
  }
  return assertSafeMutationRelativePath([targetFolder, targetName].filter(Boolean).join("/"));
}

export async function buildLibraryListResult(api, input = {}) {
  const snapshot = await loadLibrarySnapshot(api);
  const offset = clampInteger(input.offset || 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInteger(input.limit || 20, 1, MAX_LIBRARY_LIST_LIMIT);
  const filtered = sortFiles(filterLibraryFiles(snapshot.files, input), input.sortBy, input.sortDirection);
  const page = filtered.slice(offset, offset + limit);
  return {
    clientId: snapshot.clientId,
    total: filtered.length,
    offset,
    limit,
    hasMore: offset + page.length < filtered.length,
    filters: {
      query: String(input.query || "").trim(),
      kind: String(input.kind || "all").trim() || "all",
      pathPrefix: normalizeRelativePath(input.pathPrefix || input.folder || ""),
      mimePrefix: String(input.mimePrefix || "").trim(),
      extensions: normalizeExtensionList(input),
      tags: normalizeTagFilter(input),
      updatedAfter: input.updatedAfter || input.modifiedAfter || input.after || "",
      updatedBefore: input.updatedBefore || input.modifiedBefore || input.before || "",
      createdAfter: input.createdAfter || "",
      createdBefore: input.createdBefore || "",
      minSize: Number.isFinite(Number(input.minSize ?? input.sizeMin)) ? Number(input.minSize ?? input.sizeMin) : null,
      maxSize: Number.isFinite(Number(input.maxSize ?? input.sizeMax)) ? Number(input.maxSize ?? input.sizeMax) : null,
      hasAiSummary: typeof input.hasAiSummary === "boolean" ? input.hasAiSummary : null,
      hasSubtitle: typeof input.hasSubtitle === "boolean" ? input.hasSubtitle : null
    },
    files: page.map((file, index) => compactLibraryFile(file, offset + index))
  };
}

export async function buildLibraryMetadataResult(api, input = {}) {
  const snapshot = await loadLibrarySnapshot(api);
  const identifiers = [...new Set(collectFileIdentifiers(input))].slice(0, MAX_LIBRARY_DETAIL_FILES);
  if (!identifiers.length) {
    throw new Error("fileIds or paths is required");
  }

  const files = [];
  const missing = [];
  for (const identifier of identifiers) {
    const file = resolveLibraryFile(snapshot.files, identifier);
    if (!file) {
      missing.push(identifier);
      continue;
    }
    files.push({
      fileId: file.id,
      clientId: file.clientId,
      path: file.relativePath,
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      tags: file.tags || [],
      subtitlePath: file.subtitlePath || "",
      contentAccess: buildContentAccessHints(file)
    });
  }
  return {
    count: files.length,
    missing,
    files
  };
}

export async function buildTextExcerptResult(api, input = {}) {
  const snapshot = await loadLibrarySnapshot(api);
  const identifier = collectFileIdentifiers(input)[0] || "";
  if (!identifier) {
    throw new Error("fileId or path is required");
  }

  const file = resolveLibraryFile(snapshot.files, identifier);
  if (!file) {
    throw new Error(`文件未找到: ${identifier}`);
  }

  const requestedSource = String(input.source || "").trim().toLowerCase();
  let targetPath = file.relativePath;
  let source = "file";
  if (requestedSource === "subtitle" || input.subtitle === true) {
    if (!file.subtitleAvailable && !file.subtitlePath) {
      throw new Error(`文件没有可读取的字幕 sidecar: ${file.relativePath}`);
    }
    const startChar = clampInteger(input.startChar || input.offset || 0, 0, Number.MAX_SAFE_INTEGER);
    const maxChars = clampInteger(input.maxChars || input.subtitleMaxChars || 8_000, 1, MAX_TEXT_EXCERPT_CHARS);
    const subtitleReadChars = clampInteger(startChar + maxChars, 1, MAX_SUBTITLE_INLINE_CHARS);
    const subtitle = await readSubtitleForFile(api, file, subtitleReadChars);
    if (!subtitle) {
      throw new Error(`字幕 sidecar 读取失败: ${file.relativePath}`);
    }
    const text = subtitle.text.slice(startChar, startChar + maxChars);
    return {
      file: {
        fileId: file.id,
        path: file.relativePath,
        name: file.name,
        mimeType: file.mimeType
      },
      excerpt: {
        path: subtitle.path,
        source: "subtitle",
        text,
        startChar,
        nextStartChar: startChar + text.length,
        length: subtitle.length,
        fileSize: null,
        truncated: subtitle.truncated || startChar + text.length < subtitle.length
      },
      policy: {
        ...buildFileAccessPolicy(api),
        contentLayer: "excerpt"
      }
    };
  }

  if (!isLikelyTextFile(file) && !isDocumentTextExtractable(file)) {
    if (file.subtitleAvailable && input.allowSubtitleFallback !== false) {
      const subtitle = await readSubtitleForFile(api, file, input.maxChars || input.subtitleMaxChars || MAX_TEXT_EXCERPT_CHARS);
      if (subtitle) {
        targetPath = subtitle.path;
        source = "subtitle";
      }
    }
    if (source !== "subtitle") {
      throw new Error(`文件不是可直接读取的文本类型：${file.mimeType}。请改用 read_media_summary 或 analyze_storage_video。`);
    }
  }

  const excerpt = await readTextExcerptRelative(api.storageRoot, targetPath, {
    maxChars: input.maxChars,
    startChar: input.startChar ?? input.offset,
    mimeType: source === "file" ? file.mimeType : ""
  });
  return {
    file: {
      fileId: file.id,
      path: file.relativePath,
      name: file.name,
      mimeType: file.mimeType
    },
    excerpt: {
      ...excerpt,
      source: excerpt.source || source
    },
    policy: {
      ...buildFileAccessPolicy(api),
      contentLayer: "excerpt"
    }
  };
}

export async function buildMediaSummaryResult(api, input = {}) {
  const snapshot = await loadLibrarySnapshot(api);
  const identifier = collectFileIdentifiers(input)[0] || "";
  if (!identifier) {
    throw new Error("fileId or path is required");
  }
  const file = resolveLibraryFile(snapshot.files, identifier);
  if (!file) {
    throw new Error(`文件未找到: ${identifier}`);
  }

  const result = {
    file: {
      fileId: file.id,
      path: file.relativePath,
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      tags: file.tags || []
    },
    media: {
      type: String(file.mimeType || "").split("/")[0] || "unknown",
      isMedia: isMediaFile(file)
    },
    derived: {
      aiSummaryAvailable: Boolean(file.aiSummaryAvailable),
      subtitleAvailable: Boolean(file.subtitleAvailable),
      subtitlePath: file.subtitlePath || ""
    }
  };
  if (input.includeSummary !== false) {
    result.aiSummary = file.aiSummary || "";
  }
  if (result.media.isMedia && input.includeProbe !== false) {
    let absolutePath = "";
    try {
      absolutePath = safeJoin(api.storageRoot, file.relativePath);
      const probe = typeof api.dependencies?.probeMediaFile === "function"
        ? await api.dependencies.probeMediaFile({
            file,
            relativePath: file.relativePath,
            absolutePath,
            signal: api.signal
          })
        : await probeMediaFile({
            filePath: absolutePath,
            ffprobePath: api.dependencies?.ffprobePath || process.env.FFPROBE_PATH || "ffprobe",
            signal: api.signal
          });
      result.media.probeAvailable = true;
      result.media.probe = probe;
      result.media.durationSeconds = Number(probe?.durationSeconds || 0);
      result.media.durationLabel = String(probe?.durationLabel || "").trim();
      result.media.resolution = String(probe?.resolution || "").trim();
      result.media.width = Number(probe?.width || 0);
      result.media.height = Number(probe?.height || 0);
      result.media.videoTrackCount = Number(probe?.videoTrackCount || 0);
      result.media.audioTrackCount = Number(probe?.audioTrackCount || 0);
      result.media.subtitleTrackCount = Number(probe?.subtitleTrackCount || 0);
      result.media.formatName = String(probe?.formatName || "").trim();
      result.media.bitRate = Number(probe?.bitRate || 0);
    } catch (error) {
      result.media.probeAvailable = false;
      result.media.probeError = redactStoragePathText(error?.message || error, api, file).slice(0, 500);
    }
  } else {
    result.media.probeAvailable = false;
  }
  if (input.includeTranscriptExcerpt === true || input.includeSubtitleExcerpt === true) {
    try {
      result.transcriptExcerpt = (await buildTextExcerptResult(api, {
        fileId: file.id,
        source: "subtitle",
        startChar: input.startChar || 0,
        maxChars: input.maxChars || input.subtitleMaxChars || 8_000
      })).excerpt;
    } catch (error) {
      result.transcriptExcerpt = null;
      result.transcriptError = String(error?.message || error);
    }
  }
  return result;
}

export async function buildFileAccessExplanation(api, input = {}) {
  const snapshot = await loadLibrarySnapshot(api);
  const kind = String(input.kind || "summary").trim().toLowerCase();
  const countsByKind = {
    video: snapshot.files.filter((file) => matchesKind(file, "video")).length,
    audio: snapshot.files.filter((file) => matchesKind(file, "audio")).length,
    image: snapshot.files.filter((file) => matchesKind(file, "image")).length,
    document: snapshot.files.filter((file) => matchesKind(file, "document")).length,
    subtitle: snapshot.files.filter((file) => matchesKind(file, "subtitle")).length
  };
  return {
    storageRoot: api.storageRoot || "",
    visibleFiles: snapshot.files.length,
    visibleDirectories: snapshot.directories.length,
    countsByKind,
    policy: buildFileAccessPolicy(api),
    readableLayers: [
      "Index: 文件名、相对路径、MIME、大小、mtime、标签、摘要/字幕可用性",
      "Metadata: 单文件元数据、标签、摘要/字幕状态",
      "Excerpt: 文本、字幕、Markdown、JSON、PDF、Office Open XML 等可控长度片段",
      "Derived: 既有 AI summary、字幕 sidecar、媒体派生信息"
    ],
    blockedLayers: [
      "任意绝对路径读取",
      "STORAGE_ROOT 外文件",
      "二进制原文直接塞进模型上下文",
      "未经确认的删除、移动、重命名、批量覆盖"
    ],
    detail: kind === "tools"
      ? ["list_storage_files", "search_library_files", "read_file_metadata", "diagnose_file_access", "get_storage_file_details", "read_text_excerpt", "read_media_summary", "analyze_file_content", "update_file_metadata", "organize_files", "invoke_video_analyze", "invoke_video_tag", "analyze_storage_video"]
      : []
  };
}

export async function buildDiagnoseFileAccessResult(api, input = {}) {
  const snapshot = await loadLibrarySnapshot(api);
  const identifier = collectFileIdentifiers(input)[0] || "";
  const policy = buildFileAccessPolicy(api);
  if (!identifier) {
    throw new Error("fileId or path is required");
  }

  const file = resolveLibraryFile(snapshot.files, identifier);
  if (!file) {
    return {
      generatedAt: new Date().toISOString(),
      identifier,
      found: false,
      policy,
      safety: {
        storageRootOnly: true,
        absolutePathExposed: false,
        binaryRawContentAllowed: false
      },
      blockers: [
        {
          id: "file-not-found",
          severity: "error",
          message: "文件不在当前 storage-client 索引中。"
        }
      ],
      recommendedTools: ["search_library_files", "list_storage_files"],
      nextActions: ["先调用 search_library_files/list_storage_files 重新定位文件，拿到 fileId 后再诊断或读取。"]
    };
  }

  let pathSafe = true;
  try {
    safeJoin(api.storageRoot, file.relativePath);
  } catch {
    pathSafe = false;
  }

  const hiddenDirectory = isHiddenRelativePath(file.relativePath);
  const hints = buildContentAccessHints(file);
  const analyzeMode = inferAnalyzeAccessMode(file, hints);
  const analysisDependencyRequirements = getAnalysisDependencyRequirements(analyzeMode, hints);
  const analysisDependencies = buildDependencyStatus(analysisDependencyRequirements, api, {
    blockingWarnIds: analyzeMode === "media" && hints.videoOrAudio && !hints.aiSummaryAvailable ? ["whisper"] : []
  });
  const canReadExcerpt = pathSafe && !hiddenDirectory && (hints.textReadable || hints.subtitleAvailable);
  const canReadMediaSummary = pathSafe && !hiddenDirectory && (hints.media || hints.aiSummaryAvailable || hints.subtitleAvailable);
  const canAnalyze = pathSafe && !hiddenDirectory && (hints.textReadable || hints.image || hints.videoOrAudio || hints.aiSummaryAvailable || hints.subtitleAvailable);
  const recommendedTools = uniqueToolList([
    "read_file_metadata",
    "get_storage_file_details",
    canReadExcerpt ? "read_text_excerpt" : "",
    canReadMediaSummary ? "read_media_summary" : "",
    canAnalyze ? "analyze_file_content" : "",
    hints.videoOrAudio && !hints.aiSummaryAvailable ? "invoke_video_analyze" : "",
    hints.videoOrAudio && !hints.aiSummaryAvailable ? "analyze_storage_video" : ""
  ]);
  const blockers = [];
  if (!pathSafe) {
    blockers.push({
      id: "unsafe-relative-path",
      severity: "error",
      message: "索引中的相对路径未通过 storage root 安全校验，已阻止内容读取建议。"
    });
  }
  if (hiddenDirectory) {
    blockers.push({
      id: "hidden-directory",
      severity: "warn",
      message: "文件位于隐藏/系统目录，默认不建议读取内容或执行写操作。"
    });
  }
  if (!hints.textReadable && !hints.subtitleAvailable) {
    blockers.push({
      id: "no-direct-text-layer",
      severity: "info",
      message: "没有可直接读取的文本/字幕层；不要尝试读取二进制原文。"
    });
  }
  if (hints.videoOrAudio && !hints.aiSummaryAvailable && !hints.subtitleAvailable) {
    blockers.push({
      id: "needs-derived-media-content",
      severity: "info",
      message: "媒体文件还没有 AI 摘要或字幕；需要 video.analyze 生成派生内容。",
      requires: ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root"]
    });
  }
  for (const blocker of analysisDependencies.blockers) {
    blockers.push({
      id: `dependency-${blocker.id}`,
      severity: blocker.status === "error" ? "error" : "warn",
      message: `分析依赖不可用：${blocker.label}=${blocker.status}${blocker.detail ? `；${blocker.detail}` : ""}`,
      repairHint: blocker.repairHint || "",
      requires: [blocker.id]
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    identifier,
    found: true,
    file: {
      fileId: file.id,
      clientId: file.clientId,
      path: file.relativePath,
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      tags: file.tags || [],
      aiSummaryAvailable: Boolean(file.aiSummaryAvailable),
      subtitleAvailable: Boolean(file.subtitleAvailable),
      subtitlePath: file.subtitlePath || ""
    },
    policy,
    safety: {
      storageRootOnly: true,
      pathSafe,
      hiddenDirectory,
      absolutePathExposed: false,
      binaryRawContentAllowed: false,
      writeRequiresConfirmation: true
    },
    contentAccess: {
      ...hints,
      analyzeMode,
      recommendedTools
    },
    dependencies: {
      analysis: analysisDependencies
    },
    layers: [
      buildAccessLayer({
        id: "index",
        label: "Index",
        available: true,
        tools: ["list_storage_files", "search_library_files"],
        detail: "文件名、相对路径、MIME、大小、mtime、标签和摘要/字幕状态。"
      }),
      buildAccessLayer({
        id: "metadata",
        label: "Metadata",
        available: true,
        tools: ["read_file_metadata", "get_storage_file_details"],
        detail: "文件元数据、标签、已有摘要和字幕 sidecar 状态。"
      }),
      buildAccessLayer({
        id: "excerpt",
        label: "Excerpt",
        available: canReadExcerpt,
        tools: canReadExcerpt ? ["read_text_excerpt"] : [],
        detail: canReadExcerpt ? "可分页读取受控长度的文本、文档抽取文本或字幕片段。" : "",
        reason: canReadExcerpt ? "" : "当前文件没有可直接读取的文本/字幕层，或路径不允许读取。"
      }),
      buildAccessLayer({
        id: "derived-media",
        label: "Derived Content",
        available: canReadMediaSummary,
        tools: canReadMediaSummary ? ["read_media_summary"] : [],
        detail: canReadMediaSummary ? "可读取已有 AI summary、字幕状态和媒体 probe 信息。" : "",
        reason: canReadMediaSummary ? "" : "没有可用媒体派生信息。"
      }),
      buildAccessLayer({
        id: "analysis",
        label: "Analysis",
        available: canAnalyze && analysisDependencies.ready,
        tools: canAnalyze ? uniqueToolList(["analyze_file_content", hints.videoOrAudio && !hints.aiSummaryAvailable ? "invoke_video_analyze" : ""]) : [],
        requires: analysisDependencyRequirements,
        detail: canAnalyze ? `建议分析模式：${analyzeMode}；依赖状态=${analysisDependencies.status}` : "",
        reason: canAnalyze
          ? (analysisDependencies.ready ? "" : analysisDependencies.nextAction)
          : "当前文件类型只能读取 metadata。"
      }),
      buildAccessLayer({
        id: "write-metadata",
        label: "Write Metadata",
        available: pathSafe && !hiddenDirectory,
        riskLevel: "medium",
        tools: ["update_file_metadata"],
        detail: "可写入 tags/aiSummary；批量写入需要确认并记录审计。"
      }),
      buildAccessLayer({
        id: "file-mutation",
        label: "File Mutation",
        available: pathSafe && !hiddenDirectory,
        riskLevel: "high",
        tools: ["organize_files"],
        detail: "移动/重命名必须先 dry-run 预览，并在用户确认后执行。"
      })
    ],
    blockers,
    recommendedTools,
    nextActions: buildAccessNextActions(file, hints, pathSafe, hiddenDirectory, analysisDependencies)
  };
}

export async function buildLibraryDetailsResult(api, input = {}) {
  const snapshot = await loadLibrarySnapshot(api);
  const identifiers = [
    ...(Array.isArray(input.fileIds) ? input.fileIds : []),
    ...(Array.isArray(input.paths) ? input.paths : []),
    input.fileId,
    input.path,
    input.filePath
  ].map((item) => String(item || "").trim()).filter(Boolean);
  const uniqueIdentifiers = [...new Set(identifiers)].slice(0, MAX_LIBRARY_DETAIL_FILES);
  if (!uniqueIdentifiers.length) {
    throw new Error("fileIds or paths is required");
  }

  const includeSummary = input.includeSummary !== false;
  const includeSubtitle = input.includeSubtitle === true || input.includeSrt === true;
  const subtitleMaxChars = clampInteger(input.subtitleMaxChars || 12_000, 1, MAX_SUBTITLE_INLINE_CHARS);
  const files = [];
  const missing = [];
  for (const identifier of uniqueIdentifiers) {
    const file = resolveLibraryFile(snapshot.files, identifier);
    if (!file) {
      missing.push(identifier);
      continue;
    }
    const detail = {
      fileId: file.id,
      clientId: file.clientId,
      path: file.relativePath,
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      tags: file.tags || [],
      aiSummaryAvailable: Boolean(file.aiSummaryAvailable),
      subtitleAvailable: Boolean(file.subtitleAvailable),
      subtitlePath: file.subtitlePath || ""
    };
    if (includeSummary) {
      detail.aiSummary = file.aiSummary || "";
    }
    if (includeSubtitle) {
      const subtitle = await readSubtitleForFile(api, file, subtitleMaxChars);
      detail.subtitle = subtitle ? {
        path: subtitle.path,
        text: subtitle.text,
        length: subtitle.length,
        truncated: subtitle.truncated
      } : null;
    }
    files.push(detail);
  }
  return {
    count: files.length,
    missing,
    files
  };
}

function buildSafetyConfirmation({
  operation = "",
  riskLevel = "medium",
  reason = "",
  targetFileCount = 0,
  changedFields = [],
  files = [],
  recoverability = "",
  estimatedDuration = "",
  confirmWith = {}
} = {}) {
  return {
    required: true,
    operation,
    riskLevel,
    reason,
    impact: {
      targetFileCount: Math.max(0, Number(targetFileCount) || 0),
      changedFields: Array.isArray(changedFields) ? changedFields.map((item) => String(item || "").trim()).filter(Boolean) : [],
      files: (Array.isArray(files) ? files : []).map((file) => ({
        fileId: String(file?.fileId || file?.id || file?.source?.fileId || "").trim(),
        path: String(file?.path || file?.source?.path || "").trim(),
        name: String(file?.name || file?.source?.name || "").trim(),
        status: String(file?.status || "").trim()
      })).filter((file) => file.fileId || file.path).slice(0, MAX_FILE_ORGANIZE_ACTIONS)
    },
    recoverability: String(recoverability || "").trim(),
    estimatedDuration: String(estimatedDuration || "").trim(),
    confirmWith
  };
}

function estimateSmallBatchDuration(count = 0) {
  const targetCount = Math.max(0, Number(count) || 0);
  if (targetCount <= 5) {
    return "< 1 分钟";
  }
  if (targetCount <= 20) {
    return "1-3 分钟";
  }
  return "数分钟，取决于磁盘速度和队列负载";
}

export async function buildUpdateFileMetadataResult(api, input = {}) {
  const snapshot = await loadLibrarySnapshot(api);
  const identifiers = [...new Set(collectFileIdentifiers(input))].slice(0, MAX_METADATA_UPDATE_FILES);
  if (!identifiers.length) {
    throw new Error("fileIds or paths is required");
  }
  const confirmed = input.confirmed === true;
  const requestedDryRun = input.dryRun === true;
  const batchRequest = (Array.isArray(input.fileIds) || Array.isArray(input.paths)) && identifiers.length > 1;
  const dryRun = requestedDryRun || (batchRequest && !confirmed);
  if (!dryRun && typeof api?.dependencies?.upsertFileMeta !== "function") {
    throw new Error("upsertFileMeta dependency is unavailable");
  }
  const results = [];
  const missing = [];
  const allChangedFields = new Set();
  for (const identifier of identifiers) {
    const file = resolveLibraryFile(snapshot.files, identifier);
    if (!file) {
      missing.push(identifier);
      continue;
    }
    const { patch, changedFields } = buildMetadataPatch(file, input);
    for (const field of changedFields) {
      allChangedFields.add(field);
    }
    if (!changedFields.length) {
      results.push({
        fileId: file.id,
        path: file.relativePath,
        status: "skipped",
        reason: "no supported metadata changes",
        before: {
          tags: file.tags || [],
          aiSummaryAvailable: Boolean(file.aiSummaryAvailable)
        },
        patch: {}
      });
      continue;
    }
    if (!dryRun) {
      await api.dependencies.upsertFileMeta(file.id, patch);
    }
    results.push({
      fileId: file.id,
      path: file.relativePath,
      name: file.name,
      status: dryRun ? "dry-run" : "updated",
      changedFields,
      before: {
        tags: file.tags || [],
        aiSummaryAvailable: Boolean(file.aiSummaryAvailable),
        aiSummaryLength: String(file.aiSummary || "").length
      },
      patch,
      audit: {
        riskLevel: "medium",
        operation: "update_file_metadata",
        dryRun,
        confirmed: input.confirmed === true,
        storageRootOnly: true
      }
    });
  }
  const executable = results.filter((item) => ["dry-run", "updated"].includes(item.status));
  const requiresConfirmation = batchRequest && !confirmed && executable.length > 0;
  return {
    generatedAt: new Date().toISOString(),
    operation: "update_file_metadata",
    riskLevel: "medium",
    dryRun,
    confirmed,
    requiresConfirmation,
    blocked: requiresConfirmation,
    blockedReason: requiresConfirmation
      ? "批量写入 metadata 需要用户确认；本次只返回预览，未写入任何文件。"
      : "",
    count: results.length,
    missing,
    results,
    confirmation: requiresConfirmation
      ? buildSafetyConfirmation({
          operation: "update_file_metadata",
          riskLevel: "medium",
          reason: "批量写入 tags/aiSummary 会修改多个文件的 NAS metadata。",
          targetFileCount: executable.length,
          changedFields: [...allChangedFields],
          files: executable,
          recoverability: "metadata 写入会覆盖对应字段；请先确认 dry-run 预览，必要时保留当前标签/摘要作为回滚依据。",
          estimatedDuration: estimateSmallBatchDuration(executable.length),
          confirmWith: {
            confirmed: true,
            dryRun: false
          }
        })
      : null
  };
}

export async function buildOrganizeFilesResult(api, input = {}) {
  const actionInputs = collectOrganizeActionInputs(input);
  if (!actionInputs.length) {
    throw new Error("fileIds、paths 或 actions 至少需要一个");
  }

  const snapshot = await loadLibrarySnapshot(api);
  const confirmed = input.confirmed === true;
  const requestedDryRun = input.dryRun !== false;
  const dryRun = requestedDryRun || !confirmed;
  const missing = [];
  const planned = [];
  const targetCounts = new Map();
  const sourceFiles = new Map();

  for (const action of actionInputs) {
    const identifier = String(action.identifier || "").trim();
    if (!identifier) {
      planned.push({
        status: "invalid",
        reason: "fileId or path is required",
        source: null,
        target: null
      });
      continue;
    }
    const file = resolveLibraryFile(snapshot.files, identifier);
    if (!file) {
      missing.push(identifier);
      planned.push({
        status: "missing",
        reason: `文件未找到: ${identifier}`,
        source: { identifier },
        target: null
      });
      continue;
    }
    sourceFiles.set(file.relativePath, file);

    let targetPath = "";
    try {
      targetPath = buildOrganizeTargetPath(file, action);
      if (isHiddenRelativePath(targetPath)) {
        throw new Error("targetPath points to a hidden/system NAS directory");
      }
      safeJoin(api.storageRoot, file.relativePath);
      safeJoin(api.storageRoot, targetPath);
    } catch (error) {
      planned.push({
        status: "invalid",
        reason: String(error?.message || error),
        source: {
          fileId: file.id,
          path: file.relativePath,
          name: file.name
        },
        target: { path: targetPath || "" }
      });
      continue;
    }

    const normalizedTargetKey = targetPath.toLowerCase();
    targetCounts.set(normalizedTargetKey, (targetCounts.get(normalizedTargetKey) || 0) + 1);
    const samePath = targetPath.toLowerCase() === String(file.relativePath || "").toLowerCase();
    const targetAbs = safeJoin(api.storageRoot, targetPath);
    const targetExists = fs.existsSync(targetAbs);
    const status = samePath
      ? "skipped"
      : (targetExists && action.overwrite !== true ? "conflict" : "ready");
    planned.push({
      status,
      reason: samePath
        ? "source and target are the same"
        : (status === "conflict" ? "target already exists; set overwrite=true only after explicit confirmation" : ""),
      source: {
        fileId: file.id,
        path: file.relativePath,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        tags: file.tags || [],
        aiSummaryAvailable: Boolean(file.aiSummaryAvailable)
      },
      target: {
        path: targetPath,
        fileId: file.clientId && targetPath ? `${file.clientId}:${targetPath}` : targetPath,
        exists: targetExists,
        overwrite: action.overwrite === true
      },
      metadataMigration: {
        available: Boolean(file.tags?.length || file.aiSummary),
        fields: Object.keys(buildFileMetaCarryPatch(file))
      }
    });
  }

  for (const item of planned) {
    const key = String(item?.target?.path || "").toLowerCase();
    if (key && targetCounts.get(key) > 1 && item.status === "ready") {
      item.status = "conflict";
      item.reason = "multiple actions target the same path";
    }
  }

  const blockers = planned.filter((item) => ["invalid", "missing", "conflict"].includes(item.status));
  const executable = planned.filter((item) => item.status === "ready");
  const confirmationRequired = !requestedDryRun && !confirmed;
  if (dryRun || blockers.length) {
    const requiresConfirmation = confirmationRequired || executable.length > 0;
    return {
      generatedAt: new Date().toISOString(),
      operation: "organize_files",
      riskLevel: "high",
      dryRun: true,
      confirmed,
      requiresConfirmation,
      blocked: blockers.length > 0 || confirmationRequired,
      blockedReason: blockers.length
        ? "存在缺失文件、非法目标或目标冲突，未执行任何文件变更。"
        : (confirmationRequired ? "移动/重命名属于高风险文件操作，需要用户确认并以 confirmed=true、dryRun=false 再次调用。" : ""),
      count: planned.length,
      executableCount: executable.length,
      missing,
      confirmation: requiresConfirmation
        ? buildSafetyConfirmation({
            operation: "organize_files",
            riskLevel: "high",
            reason: "移动/重命名会改变 NAS 文件路径，可能影响引用、播放列表和已有外部链接。",
            targetFileCount: executable.length,
            changedFields: ["path"],
            files: executable,
            recoverability: "同盘移动通常可手动移回；覆盖、跨盘或后续索引变更会增加恢复成本。",
            estimatedDuration: estimateSmallBatchDuration(executable.length),
            confirmWith: {
              confirmed: true,
              dryRun: false
            }
          })
        : null,
      actions: planned.map((item) => ({
        ...item,
        status: item.status === "ready" ? "dry-run" : item.status
      }))
    };
  }

  const results = [];
  for (const item of executable) {
    const sourceAbs = safeJoin(api.storageRoot, item.source.path);
    const targetAbs = safeJoin(api.storageRoot, item.target.path);
    await fs.promises.mkdir(path.dirname(targetAbs), { recursive: true });
    await fs.promises.rename(sourceAbs, targetAbs);

    const metadataPatch = buildFileMetaCarryPatch(sourceFiles.get(item.source.path) || {});
    let metadataStatus = Object.keys(metadataPatch).length ? "not-migrated" : "none";
    if (Object.keys(metadataPatch).length && typeof api?.dependencies?.upsertFileMeta === "function") {
      await api.dependencies.upsertFileMeta(item.target.fileId, metadataPatch);
      metadataStatus = "migrated";
    }

    results.push({
      ...item,
      status: "moved",
      metadataMigration: {
        ...item.metadataMigration,
        status: metadataStatus
      }
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    operation: "organize_files",
    riskLevel: "high",
    dryRun: false,
    confirmed: true,
    requiresConfirmation: false,
    blocked: false,
    count: results.length,
    missing,
    actions: [
      ...results,
      ...planned.filter((item) => item.status === "skipped")
    ],
    audit: {
      storageRootOnly: true,
      absolutePathsExposed: false,
      overwrite: input.overwrite === true
    }
  };
}
