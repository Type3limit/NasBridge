import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStorageHiddenDirectoryNames, getStorageTrashDirectoryName, safeJoin, scanFiles } from "../../fsIndex.js";
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

function unwrapPathLikeIdentifier(value = "") {
  let normalized = String(value || "").trim();
  while (normalized.length >= 2) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      normalized = normalized.slice(1, -1).trim();
      continue;
    }
    break;
  }
  return normalized;
}

function decodeFileUriPath(value = "") {
  const normalized = unwrapPathLikeIdentifier(value);
  if (!/^file:/i.test(normalized)) {
    return normalized;
  }
  try {
    return fileURLToPath(normalized);
  } catch {
    return normalized;
  }
}

function isAbsolutePathLike(value = "") {
  const normalized = decodeFileUriPath(value);
  return path.isAbsolute(normalized) || path.win32.isAbsolute(normalized) || path.posix.isAbsolute(normalized);
}

function getPathComparisonApi(left = "", right = "") {
  if (path.win32.isAbsolute(left) || path.win32.isAbsolute(right)) {
    return path.win32;
  }
  if (path.posix.isAbsolute(left) || path.posix.isAbsolute(right)) {
    return path.posix;
  }
  return path;
}

function isOutsideRootRelativePath(relative = "", pathApi = path) {
  return relative === ".." || relative.startsWith(`..${pathApi.sep}`) || relative.startsWith("../") || relative.startsWith("..\\");
}

function normalizeStorageRootRelativeIdentifier(identifier = "", storageRoot = "") {
  const raw = unwrapPathLikeIdentifier(identifier);
  const root = decodeFileUriPath(storageRoot);
  if (!raw || !root) {
    return null;
  }
  const candidate = decodeFileUriPath(raw);
  if (!isAbsolutePathLike(candidate) || !isAbsolutePathLike(root)) {
    return null;
  }
  const pathApi = getPathComparisonApi(root, candidate);
  const rootAbs = pathApi.resolve(root);
  const candidateAbs = pathApi.resolve(candidate);
  const relative = pathApi.relative(rootAbs, candidateAbs);
  if (!relative || relative === ".") {
    return "";
  }
  if (isOutsideRootRelativePath(relative, pathApi) || pathApi.isAbsolute(relative) || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative)) {
    return null;
  }
  return normalizeRelativePath(relative);
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

function parseDurationMs(value = "") {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/^(?:now\s*-\s*|-|last\s+)?(\d+(?:\.\d+)?)\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|yr|year|years)$/i);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }
  const unit = match[2].toLowerCase();
  const multipliers = {
    ms: 1,
    millisecond: 1,
    milliseconds: 1,
    s: 1000,
    sec: 1000,
    secs: 1000,
    second: 1000,
    seconds: 1000,
    m: 60 * 1000,
    min: 60 * 1000,
    mins: 60 * 1000,
    minute: 60 * 1000,
    minutes: 60 * 1000,
    h: 60 * 60 * 1000,
    hr: 60 * 60 * 1000,
    hrs: 60 * 60 * 1000,
    hour: 60 * 60 * 1000,
    hours: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
    mo: 30 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    months: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000,
    yr: 365 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
    years: 365 * 24 * 60 * 60 * 1000
  };
  return Math.round(amount * (multipliers[unit] || 0));
}

function parseTimestamp(value, referenceNow = Date.now()) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const text = String(value || "").trim();
  const relativeMs = parseDurationMs(text);
  if (relativeMs !== null) {
    const base = Date.parse(String(referenceNow || "")) || Number(referenceNow) || Date.now();
    return base - relativeMs;
  }
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : null;
}

function parseSizeBytes(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }
  const text = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!text) {
    return null;
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.floor(numeric);
  }
  const match = text.match(/^(\d+(?:\.\d+)?)(b|bytes?|kb|kib|k|mb|mib|m|gb|gib|g|tb|tib|t|兆|吉|g)$/i);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }
  const unit = match[2].toLowerCase();
  const multipliers = {
    b: 1,
    byte: 1,
    bytes: 1,
    k: 1024,
    kb: 1024,
    kib: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    "兆": 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    "吉": 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
    tib: 1024 ** 4
  };
  return Math.floor(amount * (multipliers[unit] || 1));
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
    notes: String(file.notes || "").trim(),
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
    file.aiSummary || "",
    file.notes || ""
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
  const referenceNow = input.referenceNow || input.now || Date.now();
  const updatedAfter = parseTimestamp(input.updatedAfter || input.modifiedAfter || input.after, referenceNow);
  const updatedBefore = parseTimestamp(input.updatedBefore || input.modifiedBefore || input.before, referenceNow);
  const createdAfter = parseTimestamp(input.createdAfter, referenceNow);
  const createdBefore = parseTimestamp(input.createdBefore, referenceNow);
  const minSize = parseSizeBytes(input.minSize ?? input.sizeMin);
  const maxSize = parseSizeBytes(input.maxSize ?? input.sizeMax);
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
    notesAvailable: Boolean(String(file.notes || "").trim()),
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

export function resolveLibraryFile(files = [], identifier = "", options = {}) {
  const normalized = unwrapPathLikeIdentifier(identifier);
  if (!normalized) {
    return null;
  }
  const { byId, byPath } = createFileLookup(files);
  if (byId.has(normalized)) {
    return byId.get(normalized);
  }
  const storageRelative = normalizeStorageRootRelativeIdentifier(normalized, options.storageRoot || options.root || "");
  const isAbsoluteInput = isAbsolutePathLike(normalized);
  const maybePath = storageRelative !== null
    ? storageRelative
    : normalizeRelativePath((normalized.includes(":") && !isAbsoluteInput) ? normalized.split(":").slice(1).join(":") : normalized);
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

function compactAccessActionInput(input = {}) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => {
    if (value === null || value === undefined || value === "") {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return true;
  }));
}

function buildAccessAction({
  id = "",
  tool = "",
  input = {},
  reason = "",
  riskLevel = "low",
  requiresConfirmation = false,
  blocked = false,
  blockerIds = [],
  contentLayer = ""
} = {}) {
  return Object.fromEntries(Object.entries({
    id,
    tool,
    input: compactAccessActionInput(input),
    reason: String(reason || "").trim(),
    riskLevel,
    requiresConfirmation: requiresConfirmation === true,
    blocked: blocked === true,
    blockerIds: uniqueToolList(blockerIds),
    contentLayer: String(contentLayer || "").trim()
  }).filter(([, value]) => {
    if (value === "" || value === null || value === undefined) {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (value && typeof value === "object") {
      return Object.keys(value).length > 0;
    }
    return true;
  }));
}

function buildGenericFileAccessActionPlan() {
  return [
    buildAccessAction({
      id: "search-index",
      tool: "search_library_files",
      input: { limit: 10 },
      reason: "先通过索引定位候选文件，避免凭聊天上下文猜路径。",
      contentLayer: "index"
    }),
    buildAccessAction({
      id: "diagnose-target",
      tool: "diagnose_file_access",
      reason: "目标文件明确后判断可读取层级、依赖状态和下一步工具。",
      contentLayer: "metadata"
    }),
    buildAccessAction({
      id: "read-controlled-content",
      tool: "read_text_excerpt",
      input: { maxChars: 8000 },
      reason: "文本、字幕、PDF/Office 抽取文本只读取受控长度片段。",
      contentLayer: "excerpt"
    }),
    buildAccessAction({
      id: "read-derived-media",
      tool: "read_media_summary",
      input: { includeSummary: true, includeProbe: true },
      reason: "视频/音频/图片优先读取摘要、字幕状态和媒体派生信息。",
      contentLayer: "derived-media"
    }),
    buildAccessAction({
      id: "write-metadata",
      tool: "update_file_metadata",
      reason: "写入 tags/aiSummary/notes 必须走 metadata 工具并记录审计。",
      riskLevel: "medium",
      requiresConfirmation: true,
      contentLayer: "write-metadata"
    }),
    buildAccessAction({
      id: "organize-files",
      tool: "organize_files",
      input: { dryRun: true },
      reason: "移动/重命名/批量整理先 dry-run 预览，确认后才执行。",
      riskLevel: "high",
      requiresConfirmation: true,
      contentLayer: "file-mutation"
    }),
    buildAccessAction({
      id: "trash-files",
      tool: "trash_files",
      input: { dryRun: true },
      reason: "用户明确要求删除时，只能先预览移入隐藏回收站，确认后才执行。",
      riskLevel: "high",
      requiresConfirmation: true,
      contentLayer: "file-mutation"
    })
  ];
}

function buildFileAccessToolSummaries() {
  return FILE_ACCESS_TOOL_SUMMARIES.map((tool) => ({
    id: tool.id,
    contentLayer: tool.contentLayer,
    riskLevel: tool.riskLevel,
    requiresConfirmation: tool.requiresConfirmation === true,
    summary: tool.summary
  }));
}

function buildFileAccessDiagnosisStatus(found = false, blockers = []) {
  if (!found) {
    return "not_found";
  }
  const items = Array.isArray(blockers) ? blockers : [];
  if (items.some((item) => String(item?.severity || "").trim().toLowerCase() === "error")) {
    return "blocked";
  }
  if (items.some((item) => String(item?.severity || "").trim().toLowerCase() === "warn")) {
    return "warn";
  }
  return "ok";
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

function buildFileIdentifierInput(file = {}, extra = {}) {
  const fileId = String(file.id || "").trim();
  return {
    ...(fileId ? { fileId } : { path: file.relativePath }),
    ...extra
  };
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

function buildConcreteFileAccessActionPlan(file = {}, hints = {}, pathSafe = true, hiddenDirectory = false, analysisDependencies = null) {
  if (!pathSafe) {
    return [
      buildAccessAction({
        id: "repair-index",
        tool: "search_library_files",
        input: { query: file.name || file.relativePath || "", limit: 10 },
        reason: "索引路径未通过 storage root 安全校验，先重新定位文件或刷新索引。",
        blocked: true,
        blockerIds: ["unsafe-relative-path"],
        contentLayer: "index"
      })
    ];
  }
  if (hiddenDirectory) {
    return [
      buildAccessAction({
        id: "read-metadata-only",
        tool: "read_file_metadata",
        input: buildFileIdentifierInput(file),
        reason: "文件位于隐藏/系统目录，默认只读取 metadata，不进入内容层。",
        blocked: true,
        blockerIds: ["hidden-directory"],
        contentLayer: "metadata"
      })
    ];
  }

  const dependencyBlockers = Array.isArray(analysisDependencies?.blockers) ? analysisDependencies.blockers : [];
  if (dependencyBlockers.length) {
    return [
      buildAccessAction({
        id: "repair-analysis-dependencies",
        tool: "diagnose_file_access",
        input: buildFileIdentifierInput(file),
        reason: analysisDependencies.nextAction || "内容分析依赖未就绪，修复后重新诊断。",
        blocked: true,
        blockerIds: dependencyBlockers.map((item) => `dependency-${item.id}`),
        contentLayer: "analysis"
      })
    ];
  }

  const actions = [
    buildAccessAction({
      id: "read-metadata",
      tool: "read_file_metadata",
      input: buildFileIdentifierInput(file),
      reason: "先读取 metadata 和可访问层级，确认不会误读二进制原文。",
      contentLayer: "metadata"
    })
  ];

  if (hints.aiSummaryAvailable || (hints.media && !hints.image)) {
    actions.push(buildAccessAction({
      id: "read-media-summary",
      tool: "read_media_summary",
      input: buildFileIdentifierInput(file, { includeSummary: true, includeProbe: true }),
      reason: hints.aiSummaryAvailable ? "已有 AI 摘要，优先复用派生内容。" : "媒体文件读取摘要状态、字幕状态和 probe 信息。",
      contentLayer: "derived-media"
    }));
  }
  if (hints.subtitleAvailable) {
    actions.push(buildAccessAction({
      id: "read-subtitle-excerpt",
      tool: "read_text_excerpt",
      input: buildFileIdentifierInput(file, { source: "subtitle", maxChars: 8000 }),
      reason: "已有字幕 sidecar，可读取受控字幕片段用于总结或问答。",
      contentLayer: "excerpt"
    }));
  } else if (hints.textReadable) {
    actions.push(buildAccessAction({
      id: "read-text-excerpt",
      tool: "read_text_excerpt",
      input: buildFileIdentifierInput(file, { maxChars: 8000 }),
      reason: "文本/文档类文件可分页读取受控片段。",
      contentLayer: "excerpt"
    }));
  }
  if (hints.image) {
    actions.push(buildAccessAction({
      id: "analyze-image",
      tool: "analyze_file_content",
      input: buildFileIdentifierInput(file, { mode: "image" }),
      reason: "图片走视觉模型分析，不直接暴露本机绝对路径。",
      contentLayer: "analysis"
    }));
  } else if (hints.videoOrAudio && !hints.aiSummaryAvailable) {
    actions.push(buildAccessAction({
      id: "start-media-analysis",
      tool: "invoke_video_analyze",
      input: buildFileIdentifierInput(file, { waitForCompletion: false }),
      reason: "媒体尚无摘要时启动转录与 AI 总结后台任务。",
      riskLevel: "medium",
      contentLayer: "analysis"
    }));
  } else if (hints.textReadable || hints.subtitleAvailable || hints.aiSummaryAvailable) {
    actions.push(buildAccessAction({
      id: "analyze-content",
      tool: "analyze_file_content",
      input: buildFileIdentifierInput(file, { mode: "auto" }),
      reason: "目标明确后可基于已允许的内容层生成总结或回答。",
      contentLayer: "analysis"
    }));
  }

  actions.push(buildAccessAction({
    id: "write-metadata-if-requested",
    tool: "update_file_metadata",
    input: buildFileIdentifierInput(file, { dryRun: true }),
    reason: "只有用户要求写标签/摘要/备注时才写入；批量或覆盖前需要确认。",
    riskLevel: "medium",
    requiresConfirmation: true,
    contentLayer: "write-metadata"
  }));

  return actions;
}

function buildMediaSummaryNextActions(file = {}, hints = {}, result = {}, analysisDependencies = null) {
  if (hints.aiSummaryAvailable && String(result.aiSummary || "").trim()) {
    return [
      "已有 AI 摘要；可直接基于 aiSummary 回答用户问题。",
      hints.subtitleAvailable ? "如需核对细节，调用 read_text_excerpt 并设置 source=subtitle 读取字幕片段。" : "如需更新摘要，再调用 invoke_video_analyze 或 analyze_file_content(startAnalysis=true)。"
    ];
  }
  if (result.transcriptExcerpt?.text) {
    const nextStart = Number.isFinite(Number(result.transcriptExcerpt.nextStartChar)) ? Number(result.transcriptExcerpt.nextStartChar) : null;
    return [
      nextStart != null && result.transcriptExcerpt.truncated === true
        ? `已读取字幕片段；需要更多上下文时继续调用 read_text_excerpt source=subtitle startChar=${nextStart}。`
        : "已读取字幕片段；可基于该片段回答或总结。",
      "需要完整视频摘要时，调用 analyze_file_content 或 invoke_video_analyze。"
    ];
  }
  if (hints.subtitleAvailable) {
    return [
      "没有 AI 摘要但已有字幕；先调用 read_text_excerpt source=subtitle 读取受控字幕片段。",
      "如需生成正式摘要，调用 analyze_file_content 或 invoke_video_analyze。"
    ];
  }
  if (Array.isArray(analysisDependencies?.blockers) && analysisDependencies.blockers.length) {
    return [
      analysisDependencies.nextAction,
      "修复依赖后重新调用 read_media_summary 或 diagnose_file_access，再启动媒体分析。"
    ];
  }
  if (hints.videoOrAudio) {
    return ["没有 AI 摘要或字幕；调用 invoke_video_analyze，可设置 waitUntilPhase=transcribe 或 waitForCompletion=true 生成字幕和摘要。"];
  }
  if (hints.image) {
    return ["图片摘要当前只有 metadata/probe 信息；需要理解图片内容时调用 analyze_file_content mode=image。"];
  }
  if (hints.media) {
    return ["当前只有媒体 metadata/probe 信息；需要内容理解时调用 analyze_file_content。"];
  }
  return ["该文件没有可用媒体派生内容；改用 diagnose_file_access 判断可读取层级。"];
}

function buildMediaSummaryActionPlan(file = {}, hints = {}, result = {}, analysisDependencies = null) {
  const actions = [];
  const dependencyBlockers = Array.isArray(analysisDependencies?.blockers) ? analysisDependencies.blockers : [];
  if (hints.subtitleAvailable && !result.transcriptExcerpt) {
    actions.push(buildAccessAction({
      id: "read-subtitle-excerpt",
      tool: "read_text_excerpt",
      input: buildFileIdentifierInput(file, { source: "subtitle", maxChars: 8000 }),
      reason: "已有字幕 sidecar，读取受控字幕片段可用于问答或总结。",
      contentLayer: "excerpt"
    }));
  }
  if (dependencyBlockers.length) {
    actions.push(buildAccessAction({
      id: "repair-analysis-dependencies",
      tool: "diagnose_file_access",
      input: buildFileIdentifierInput(file),
      reason: analysisDependencies.nextAction || "媒体分析依赖未就绪，修复后重新诊断。",
      blocked: true,
      blockerIds: dependencyBlockers.map((item) => `dependency-${item.id}`),
      contentLayer: "analysis"
    }));
  } else if (hints.videoOrAudio && !hints.aiSummaryAvailable) {
    actions.push(buildAccessAction({
      id: "start-media-analysis",
      tool: "invoke_video_analyze",
      input: buildFileIdentifierInput(file, { waitForCompletion: false, waitUntilPhase: "transcribe" }),
      reason: "媒体还没有 AI 摘要时启动转录与总结任务。",
      riskLevel: "medium",
      contentLayer: "analysis"
    }));
  } else if (hints.image) {
    actions.push(buildAccessAction({
      id: "analyze-image",
      tool: "analyze_file_content",
      input: buildFileIdentifierInput(file, { mode: "image" }),
      reason: "图片内容理解走视觉分析，不直接暴露本机绝对路径。",
      contentLayer: "analysis"
    }));
  }
  actions.push(buildAccessAction({
    id: "write-metadata-if-requested",
    tool: "update_file_metadata",
    input: buildFileIdentifierInput(file, { dryRun: true }),
    reason: "只有用户明确要求写标签/摘要/备注时才写入 metadata；批量或覆盖前需要确认。",
    riskLevel: "medium",
    requiresConfirmation: true,
    contentLayer: "write-metadata"
  }));
  return actions;
}

function buildTextExcerptNextActions(file = {}, excerpt = {}, source = "") {
  const normalizedSource = String(source || excerpt.source || "").trim();
  const isSubtitle = normalizedSource === "subtitle";
  const nextStart = Number.isFinite(Number(excerpt.nextStartChar)) ? Number(excerpt.nextStartChar) : null;
  const actions = [];
  if (excerpt.truncated === true && nextStart !== null) {
    actions.push(isSubtitle
      ? `片段已截断；需要更多字幕上下文时继续调用 read_text_excerpt source=subtitle startChar=${nextStart}。`
      : `片段已截断；需要更多上下文时继续调用 read_text_excerpt startChar=${nextStart}。`);
  }
  actions.push(isSubtitle
    ? "可基于当前字幕片段回答；需要完整媒体摘要时调用 read_media_summary 或 analyze_file_content。"
    : "可基于当前文本片段回答；需要完整总结时调用 analyze_file_content。");
  actions.push("只有用户明确要求保存摘要、标签或备注时，才调用 update_file_metadata dryRun=true 预览写入。");
  return actions;
}

function buildTextExcerptActionPlan(file = {}, excerpt = {}, source = "") {
  const normalizedSource = String(source || excerpt.source || "").trim();
  const isSubtitle = normalizedSource === "subtitle";
  const nextStart = Number.isFinite(Number(excerpt.nextStartChar)) ? Number(excerpt.nextStartChar) : null;
  const actions = [];
  if (excerpt.truncated === true && nextStart !== null) {
    actions.push(buildAccessAction({
      id: "read-next-excerpt-page",
      tool: "read_text_excerpt",
      input: buildFileIdentifierInput(file, {
        ...(isSubtitle ? { source: "subtitle" } : {}),
        startChar: nextStart,
        maxChars: Math.min(8000, MAX_TEXT_EXCERPT_CHARS)
      }),
      reason: "当前片段已截断，继续分页读取下一段受控文本。",
      contentLayer: "excerpt"
    }));
  }
  actions.push(buildAccessAction({
    id: isSubtitle ? "summarize-from-subtitle-excerpt" : "summarize-from-text-excerpt",
    tool: "analyze_file_content",
    input: buildFileIdentifierInput(file, { mode: "auto" }),
    reason: isSubtitle ? "基于字幕/媒体派生文本生成回答或摘要。" : "基于受控文本/文档片段生成回答或摘要。",
    contentLayer: "analysis"
  }));
  actions.push(buildAccessAction({
    id: "write-metadata-if-requested",
    tool: "update_file_metadata",
    input: buildFileIdentifierInput(file, { dryRun: true }),
    reason: "只有用户明确要求保存摘要、标签或备注时才写入 metadata；批量或覆盖前需要确认。",
    riskLevel: "medium",
    requiresConfirmation: true,
    contentLayer: "write-metadata"
  }));
  return actions;
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
  if (Object.prototype.hasOwnProperty.call(input, "notes")) {
    patch.notes = String(input.notes || "").trim();
    changedFields.push("notes");
  } else if (Object.prototype.hasOwnProperty.call(input, "note")) {
    patch.notes = String(input.note || "").trim();
    changedFields.push("notes");
  } else if (Object.prototype.hasOwnProperty.call(input, "remark")) {
    patch.notes = String(input.remark || "").trim();
    changedFields.push("notes");
  } else if (input.clearNotes === true || input.clearNote === true || input.clearRemark === true) {
    patch.notes = "";
    changedFields.push("notes");
  }
  return { patch, changedFields };
}

export function getHiddenDirectoryNames() {
  return getStorageHiddenDirectoryNames();
}

const PUBLIC_STORAGE_ROOT_LABEL = "STORAGE_ROOT";
const FILE_ACCESS_TOOL_SUMMARIES = [
  {
    id: "list_storage_files",
    contentLayer: "index",
    riskLevel: "low",
    summary: "列出或过滤 NAS 文件索引。"
  },
  {
    id: "search_library_files",
    contentLayer: "index",
    riskLevel: "low",
    summary: "按关键词、目录、扩展名、时间、大小、标签和摘要状态搜索文件。"
  },
  {
    id: "read_file_metadata",
    contentLayer: "metadata",
    riskLevel: "low",
    summary: "读取文件 metadata、标签、备注、摘要/字幕状态，不读取正文。"
  },
  {
    id: "diagnose_file_access",
    contentLayer: "metadata",
    riskLevel: "low",
    summary: "诊断单个文件能读哪一层、缺什么依赖、下一步该用哪个工具。"
  },
  {
    id: "get_storage_file_details",
    contentLayer: "metadata",
    riskLevel: "low",
    summary: "批量读取文件详情、已有摘要和可选字幕 sidecar。"
  },
  {
    id: "read_text_excerpt",
    contentLayer: "excerpt",
    riskLevel: "low",
    summary: "分页读取文本、字幕、Markdown、JSON、PDF/Office 抽取文本片段。"
  },
  {
    id: "read_media_summary",
    contentLayer: "derived-media",
    riskLevel: "low",
    summary: "读取媒体已有 AI 摘要、字幕状态、ffprobe 时长/分辨率等派生信息。"
  },
  {
    id: "analyze_file_content",
    contentLayer: "analysis",
    riskLevel: "medium",
    summary: "按类型分析文本/文档/图片/媒体；媒体可按需委派视频分析。"
  },
  {
    id: "invoke_video_analyze",
    contentLayer: "analysis",
    riskLevel: "medium",
    summary: "委派 video.analyze 生成视频/音频字幕和 AI 摘要。"
  },
  {
    id: "analyze_storage_video",
    contentLayer: "analysis",
    riskLevel: "medium",
    summary: "兼容旧工具名；对 NAS 视频/音频启动字幕和摘要分析。"
  },
  {
    id: "invoke_video_tag",
    contentLayer: "write-metadata",
    riskLevel: "medium",
    summary: "委派 video.tag 生成并写入视频/音频标签。"
  },
  {
    id: "tag_storage_video",
    contentLayer: "write-metadata",
    riskLevel: "medium",
    summary: "兼容旧工具名；为 NAS 视频/音频生成并写入标签。"
  },
  {
    id: "update_file_metadata",
    contentLayer: "write-metadata",
    riskLevel: "medium",
    requiresConfirmation: true,
    summary: "写入 tags、aiSummary、notes；批量写入需要确认并记录审计。"
  },
  {
    id: "organize_files",
    contentLayer: "file-mutation",
    riskLevel: "high",
    requiresConfirmation: true,
    summary: "在 STORAGE_ROOT 内移动或重命名文件；必须先 dry-run，再确认执行。"
  },
  {
    id: "trash_files",
    contentLayer: "file-mutation",
    riskLevel: "high",
    requiresConfirmation: true,
    summary: "把文件移动到 STORAGE_ROOT 内隐藏回收站；必须先 dry-run，再确认执行。"
  },
  {
    id: "explain_file_access",
    contentLayer: "policy",
    riskLevel: "low",
    summary: "解释 AI 当前对 NAS 文件的可访问范围、安全边界和推荐工具链。"
  }
];
const FILE_ACCESS_TOOL_IDS = FILE_ACCESS_TOOL_SUMMARIES.map((tool) => tool.id);

export function buildFileAccessPolicy(api = {}) {
  const root = String(api?.storageRoot || "").trim();
  return {
    root,
    allowedRoots: root ? [root] : [],
    hiddenDirs: getHiddenDirectoryNames(),
    hiddenDirectories: getHiddenDirectoryNames(),
    accessBy: ["fileId", "relativePath", "storageRootAbsolutePath"],
    maxListResults: MAX_LIBRARY_LIST_LIMIT,
    maxDetailFiles: MAX_LIBRARY_DETAIL_FILES,
    maxInlineTextChars: MAX_TEXT_EXCERPT_CHARS,
    maxTextExcerptChars: MAX_TEXT_EXCERPT_CHARS,
    maxBatchFiles: MAX_FILE_ORGANIZE_ACTIONS,
    allowRawTextRead: true,
    allowBinaryRead: false,
    binaryReadAllowed: false,
    acceptsStorageRootAbsolutePath: true,
    absolutePathInputScope: "storage-root-only",
    rawAbsolutePathExposed: false,
    storageRootOnly: true,
    writeRequiresConfirmation: true
  };
}

export function buildPublicFileAccessPolicy(api = {}) {
  const policy = buildFileAccessPolicy(api);
  const storageRootConfigured = Boolean(policy.root);
  return {
    ...policy,
    root: storageRootConfigured ? PUBLIC_STORAGE_ROOT_LABEL : "",
    allowedRoots: storageRootConfigured ? [PUBLIC_STORAGE_ROOT_LABEL] : [],
    rootLabel: PUBLIC_STORAGE_ROOT_LABEL,
    storageRootConfigured,
    absolutePathExposed: false
  };
}

async function inspectStorageRootAccess(api = {}) {
  const root = String(api?.storageRoot || "").trim();
  const result = {
    storageRoot: root ? PUBLIC_STORAGE_ROOT_LABEL : "",
    storageRootConfigured: Boolean(root),
    exists: false,
    readable: false,
    writable: false,
    status: "error",
    detail: root ? "storage root unavailable" : "storage root is not configured"
  };
  if (!root) {
    return result;
  }
  try {
    const stat = await fs.promises.stat(root);
    result.exists = stat.isDirectory();
    if (!result.exists) {
      result.detail = "configured storage root is not a directory";
      return result;
    }
  } catch (error) {
    result.detail = error?.code === "ENOENT"
      ? "configured storage root does not exist"
      : `storage root stat failed: ${String(error?.code || "unknown")}`;
    return result;
  }
  try {
    await fs.promises.access(root, fs.constants.R_OK);
    result.readable = true;
  } catch {
  }
  try {
    await fs.promises.access(root, fs.constants.W_OK);
    result.writable = true;
  } catch {
  }
  result.status = result.readable && result.writable ? "ok" : (result.readable ? "warn" : "error");
  result.detail = result.readable && result.writable
    ? "storage root is readable and writable"
    : `storage root access: readable=${result.readable} writable=${result.writable}`;
  return result;
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
  if (String(file.notes || "").trim()) {
    patch.notes = String(file.notes || "").trim();
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

function buildLibrarySearchSelection(page = [], total = 0, input = {}) {
  const query = String(input.query || "").trim();
  const kind = String(input.kind || "all").trim() || "all";
  const referenceNow = input.referenceNow || input.now || Date.now();
  const hasDateFilter = [
    input.updatedAfter || input.modifiedAfter || input.after,
    input.updatedBefore || input.modifiedBefore || input.before,
    input.createdAfter,
    input.createdBefore
  ].some((value) => parseTimestamp(value, referenceNow) !== null);
  const hasSizeFilter = [
    input.minSize ?? input.sizeMin,
    input.maxSize ?? input.sizeMax
  ].some((value) => parseSizeBytes(value) !== null);
  const hasNarrowingFilter = Boolean(
    query ||
    kind !== "all" ||
    normalizeRelativePath(input.pathPrefix || input.folder || "") ||
    normalizeExtensionList(input).length ||
    normalizeTagFilter(input).tags.length ||
    hasDateFilter ||
    hasSizeFilter ||
    typeof input.hasAiSummary === "boolean" ||
    typeof input.hasSubtitle === "boolean"
  );
  return {
    status: total === 0 ? "no-results" : (total === 1 ? "single-match" : "multiple-matches"),
    confidence: total === 0 ? "none" : (total === 1 && hasNarrowingFilter ? "high" : (total <= page.length ? "medium" : "low")),
    candidateCount: total,
    visibleCandidateCount: page.length,
    narrowedByUserInput: hasNarrowingFilter
  };
}

function buildLibrarySearchNextActions(page = [], total = 0, input = {}) {
  if (total === 0) {
    return [
      "没有匹配文件；放宽 kind/pathPrefix/extensions/tags/updatedAfter/minSize/hasAiSummary/hasSubtitle 等筛选，或换关键词再次调用 search_library_files。",
      "如果用户提供的是模糊描述，先向用户列出当前筛选条件并询问更具体的目录、类型或文件名片段。"
    ];
  }
  if (total === 1) {
    const file = page[0] || {};
    const hints = buildContentAccessHints(file);
    if (hints.aiSummaryAvailable || hints.subtitleAvailable || hints.media) {
      return ["候选唯一；先调用 read_file_metadata 确认目标，再调用 read_media_summary 或 diagnose_file_access 决定是否需要进一步分析。"];
    }
    if (hints.textReadable) {
      return ["候选唯一；先调用 read_file_metadata 确认目标，再调用 read_text_excerpt 分页读取受控片段。"];
    }
    return ["候选唯一；先调用 read_file_metadata 和 diagnose_file_access 判断可读取层级。"];
  }
  return [
    `找到 ${total} 个候选；如果用户没有明确选择依据，先向用户展示前 ${Math.min(page.length, 5)} 个候选并询问确认。`,
    "如果用户目标足够明确，可先调用 read_file_metadata 读取前几个候选的 metadata，再基于摘要/字幕/标签状态选择下一步。"
  ];
}

function buildLibrarySearchActionPlan(page = [], total = 0, input = {}) {
  if (total === 0) {
    return [
      buildAccessAction({
        id: "broaden-search",
        tool: "search_library_files",
        input: {
          query: input.query || "",
          kind: input.kind || "all",
          limit: input.limit || 20
        },
        reason: "当前筛选没有命中；放宽筛选或换关键词后重新搜索。",
        contentLayer: "index"
      })
    ];
  }
  if (!page.length) {
    return [];
  }
  const first = page[0];
  if (total === 1) {
    return [
      buildAccessAction({
        id: "read-selected-metadata",
        tool: "read_file_metadata",
        input: buildFileIdentifierInput(first),
        reason: "候选唯一，先确认 metadata、标签、摘要/字幕状态。",
        contentLayer: "metadata"
      }),
      buildAccessAction({
        id: "diagnose-selected-access",
        tool: "diagnose_file_access",
        input: buildFileIdentifierInput(first),
        reason: "确认可读取层级、依赖状态和安全边界，再选择内容读取或分析工具。",
        contentLayer: "metadata"
      })
    ];
  }
  return [
    buildAccessAction({
      id: "read-candidate-metadata",
      tool: "read_file_metadata",
      input: { fileIds: page.slice(0, 3).map((file) => file.id).filter(Boolean) },
      reason: "多个候选时先读取前几个 metadata，比直接分析单个文件更稳妥。",
      contentLayer: "metadata"
    }),
    buildAccessAction({
      id: "diagnose-leading-candidate",
      tool: "diagnose_file_access",
      input: buildFileIdentifierInput(first),
      reason: "如需立即推进，可先诊断排序第一的候选文件访问层级。",
      contentLayer: "metadata"
    })
  ];
}

function buildMetadataAccessProfile(api = {}, file = {}) {
  let pathSafe = true;
  try {
    safeJoin(api.storageRoot, file.relativePath);
  } catch {
    pathSafe = false;
  }
  const hiddenDirectory = isHiddenRelativePath(file.relativePath);
  const hints = buildContentAccessHints(file);
  const analyzeMode = inferAnalyzeAccessMode(file, hints);
  const analysisDependencies = buildDependencyStatus(getAnalysisDependencyRequirements(analyzeMode, hints), api, {
    blockingWarnIds: analyzeMode === "media" && hints.videoOrAudio && !hints.aiSummaryAvailable ? ["whisper"] : []
  });
  const actionPlan = buildConcreteFileAccessActionPlan(file, hints, pathSafe, hiddenDirectory, analysisDependencies)
    .filter((action) => action.id !== "read-metadata");
  return {
    contentAccess: hints,
    dependencies: {
      analysis: analysisDependencies
    },
    nextActions: buildAccessNextActions(file, hints, pathSafe, hiddenDirectory, analysisDependencies),
    actionPlan
  };
}

function buildMetadataResultNextActions(files = [], missing = []) {
  if (!files.length) {
    return missing.length
      ? [`未找到 ${missing.length} 个文件；先调用 search_library_files 重新定位候选文件。`]
      : ["没有可用文件 metadata；先调用 search_library_files 定位文件。"];
  }
  if (files.length === 1) {
    return Array.isArray(files[0].nextActions) ? files[0].nextActions : [];
  }
  return [
    `已读取 ${files.length} 个文件 metadata；根据 contentAccess、tags、aiSummary/subtitle 状态选择目标文件。`,
    "目标明确后调用该文件 actionPlan 中的 read_media_summary、read_text_excerpt、analyze_file_content 或 diagnose_file_access。"
  ];
}

function buildMetadataResultActionPlan(files = []) {
  if (!files.length) {
    return [];
  }
  if (files.length === 1) {
    return Array.isArray(files[0].actionPlan) ? files[0].actionPlan : [];
  }
  return files.slice(0, 3).map((file, index) => buildAccessAction({
    id: `diagnose-candidate-${index + 1}`,
    tool: "diagnose_file_access",
    input: { fileId: file.fileId },
    reason: "多文件 metadata 已读取；对候选文件进一步诊断可访问层级和依赖状态。",
    contentLayer: "metadata"
  }));
}

export async function buildLibraryListResult(api, input = {}) {
  const snapshot = await loadLibrarySnapshot(api);
  const offset = clampInteger(input.offset || 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInteger(input.limit || 20, 1, MAX_LIBRARY_LIST_LIMIT);
  const filtered = sortFiles(filterLibraryFiles(snapshot.files, input), input.sortBy, input.sortDirection);
  const page = filtered.slice(offset, offset + limit);
  const compactFiles = page.map((file, index) => compactLibraryFile(file, offset + index));
  const referenceNow = input.referenceNow || input.now || Date.now();
  return {
    clientId: snapshot.clientId,
    total: filtered.length,
    offset,
    limit,
    hasMore: offset + page.length < filtered.length,
    selection: buildLibrarySearchSelection(page, filtered.length, input),
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
      minSize: parseSizeBytes(input.minSize ?? input.sizeMin),
      maxSize: parseSizeBytes(input.maxSize ?? input.sizeMax),
      parsedUpdatedAfter: parseTimestamp(input.updatedAfter || input.modifiedAfter || input.after, referenceNow),
      parsedUpdatedBefore: parseTimestamp(input.updatedBefore || input.modifiedBefore || input.before, referenceNow),
      parsedCreatedAfter: parseTimestamp(input.createdAfter, referenceNow),
      parsedCreatedBefore: parseTimestamp(input.createdBefore, referenceNow),
      hasAiSummary: typeof input.hasAiSummary === "boolean" ? input.hasAiSummary : null,
      hasSubtitle: typeof input.hasSubtitle === "boolean" ? input.hasSubtitle : null
    },
    nextActions: buildLibrarySearchNextActions(page, filtered.length, input),
    actionPlan: buildLibrarySearchActionPlan(page, filtered.length, input),
    files: compactFiles
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
    const file = resolveLibraryFile(snapshot.files, identifier, { storageRoot: api.storageRoot });
    if (!file) {
      missing.push(identifier);
      continue;
    }
    const profile = buildMetadataAccessProfile(api, file);
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
      notes: file.notes || "",
      subtitlePath: file.subtitlePath || "",
      contentAccess: profile.contentAccess,
      dependencies: profile.dependencies,
      nextActions: profile.nextActions,
      actionPlan: profile.actionPlan
    });
  }
  return {
    count: files.length,
    missing,
    policy: {
      ...buildPublicFileAccessPolicy(api),
      contentLayer: "metadata"
    },
    nextActions: buildMetadataResultNextActions(files, missing),
    actionPlan: buildMetadataResultActionPlan(files),
    files
  };
}

export async function buildTextExcerptResult(api, input = {}) {
  const snapshot = await loadLibrarySnapshot(api);
  const identifier = collectFileIdentifiers(input)[0] || "";
  if (!identifier) {
    throw new Error("fileId or path is required");
  }

  const file = resolveLibraryFile(snapshot.files, identifier, { storageRoot: api.storageRoot });
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
    const excerpt = {
      path: subtitle.path,
      source: "subtitle",
      text,
      startChar,
      nextStartChar: startChar + text.length,
      length: subtitle.length,
      fileSize: null,
      truncated: subtitle.truncated || startChar + text.length < subtitle.length
    };
    return {
      file: {
        fileId: file.id,
        path: file.relativePath,
        name: file.name,
        mimeType: file.mimeType
      },
      excerpt,
      policy: {
        ...buildPublicFileAccessPolicy(api),
        contentLayer: "excerpt"
      },
      nextActions: buildTextExcerptNextActions(file, excerpt, "subtitle"),
      actionPlan: buildTextExcerptActionPlan(file, excerpt, "subtitle")
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
  const normalizedExcerpt = {
    ...excerpt,
    source: excerpt.source || source
  };
  return {
    file: {
      fileId: file.id,
      path: file.relativePath,
      name: file.name,
      mimeType: file.mimeType
    },
    excerpt: normalizedExcerpt,
    policy: {
      ...buildPublicFileAccessPolicy(api),
      contentLayer: "excerpt"
    },
    nextActions: buildTextExcerptNextActions(file, normalizedExcerpt, source),
    actionPlan: buildTextExcerptActionPlan(file, normalizedExcerpt, source)
  };
}

export async function buildMediaSummaryResult(api, input = {}) {
  const snapshot = await loadLibrarySnapshot(api);
  const identifier = collectFileIdentifiers(input)[0] || "";
  if (!identifier) {
    throw new Error("fileId or path is required");
  }
  const file = resolveLibraryFile(snapshot.files, identifier, { storageRoot: api.storageRoot });
  if (!file) {
    throw new Error(`文件未找到: ${identifier}`);
  }
  const hints = buildContentAccessHints(file);
  const analyzeMode = inferAnalyzeAccessMode(file, hints);
  const analysisDependencies = buildDependencyStatus(getAnalysisDependencyRequirements(analyzeMode, hints), api, {
    blockingWarnIds: analyzeMode === "media" && hints.videoOrAudio && !hints.aiSummaryAvailable ? ["whisper"] : []
  });

  const result = {
    file: {
      fileId: file.id,
      path: file.relativePath,
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      tags: file.tags || [],
      notes: file.notes || ""
    },
    media: {
      type: String(file.mimeType || "").split("/")[0] || "unknown",
      isMedia: isMediaFile(file)
    },
    derived: {
      aiSummaryAvailable: Boolean(file.aiSummaryAvailable),
      subtitleAvailable: Boolean(file.subtitleAvailable),
      subtitlePath: file.subtitlePath || ""
    },
    policy: {
      ...buildPublicFileAccessPolicy(api),
      contentLayer: "derived-media"
    },
    dependencies: {
      analysis: analysisDependencies
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
  result.nextActions = buildMediaSummaryNextActions(file, hints, result, analysisDependencies);
  result.actionPlan = buildMediaSummaryActionPlan(file, hints, result, analysisDependencies);
  return result;
}

export async function buildFileAccessExplanation(api, input = {}) {
  const snapshot = await loadLibrarySnapshot(api);
  const kind = String(input.kind || "summary").trim().toLowerCase();
  const policy = buildPublicFileAccessPolicy(api);
  const rootAccess = await inspectStorageRootAccess(api);
  const countsByKind = {
    video: snapshot.files.filter((file) => matchesKind(file, "video")).length,
    audio: snapshot.files.filter((file) => matchesKind(file, "audio")).length,
    image: snapshot.files.filter((file) => matchesKind(file, "image")).length,
    document: snapshot.files.filter((file) => matchesKind(file, "document")).length,
    subtitle: snapshot.files.filter((file) => matchesKind(file, "subtitle")).length
  };
  const currentStatus = {
    ...rootAccess,
    indexSource: snapshot.indexSource || snapshot.source || "unknown",
    indexedAt: snapshot.generatedAt || "",
    latestFileUpdatedAt: snapshot.latestFileUpdatedAt || "",
    visibleFiles: snapshot.files.length,
    visibleDirectories: snapshot.directories.length,
    hiddenDirsExcluded: Array.isArray(snapshot.hiddenDirectories) ? snapshot.hiddenDirectories.length : policy.hiddenDirs.length,
    skippedDirectories: Array.isArray(snapshot.skippedDirectories) ? snapshot.skippedDirectories.length : 0,
    countsByKind,
    policy: {
      storageRootOnly: policy.storageRootOnly,
      allowRawTextRead: policy.allowRawTextRead,
      allowBinaryRead: policy.allowBinaryRead,
      acceptsStorageRootAbsolutePath: policy.acceptsStorageRootAbsolutePath,
      absolutePathInputScope: policy.absolutePathInputScope,
      rawAbsolutePathExposed: policy.rawAbsolutePathExposed,
      writeRequiresConfirmation: policy.writeRequiresConfirmation,
      maxListResults: policy.maxListResults,
      maxInlineTextChars: policy.maxInlineTextChars,
      maxBatchFiles: policy.maxBatchFiles
    }
  };
  return {
    status: rootAccess.status,
    storageRoot: api.storageRoot ? PUBLIC_STORAGE_ROOT_LABEL : "",
    storageRootConfigured: Boolean(api.storageRoot),
    visibleFiles: snapshot.files.length,
    visibleDirectories: snapshot.directories.length,
    countsByKind,
    currentStatus,
    summary: "AI 可以通过索引、fileId、相对路径，以及用户提供且位于 STORAGE_ROOT 内的绝对路径访问 NAS 文件元数据、摘要、字幕和受控片段；绝对路径会先归一化为相对路径，不会暴露给模型。不能读取任意本机路径、STORAGE_ROOT 外文件或二进制原文。",
    canAccess: {
      indexedFiles: true,
      fileMetadata: true,
      textExcerpts: true,
      documentExtracts: true,
      subtitles: true,
      mediaDerivedContent: true,
      imageAnalysis: true,
      videoAudioAnalysisViaBot: true,
      storageRootAbsolutePathInput: true,
      directBinaryRawContent: false,
      arbitraryLocalPaths: false,
      outsideStorageRoot: false,
      unauditedWrites: false
    },
    policy,
    readableLayers: [
      "Index: 文件名、相对路径、MIME、大小、mtime、标签、摘要/字幕可用性",
      "Metadata: 单文件元数据、标签、摘要/字幕状态",
      "Excerpt: 文本、字幕、Markdown、JSON、PDF、Office Open XML 等可控长度片段",
      "Derived: 既有 AI summary、字幕 sidecar、媒体派生信息"
    ],
    blockedLayers: [
      "任意绝对路径读取；只有 STORAGE_ROOT 内绝对路径可作为输入别名并会被归一化",
      "STORAGE_ROOT 外文件",
      "二进制原文直接塞进模型上下文",
      "未经确认的移入回收站、移动、重命名、批量覆盖"
    ],
    recommendedFirstSteps: [
      "找文件: search_library_files/list_storage_files -> read_file_metadata",
      "判断具体文件能不能读或分析: search_library_files -> diagnose_file_access",
      "读取文本/字幕/PDF/Office 片段: diagnose_file_access -> read_text_excerpt",
      "读取媒体摘要或技术信息: read_media_summary",
      "生成视频/音频字幕和摘要: invoke_video_analyze 或 analyze_file_content(startAnalysis=true)",
      "写标签/摘要/备注: update_file_metadata；批量或覆盖前先确认",
      "移动/重命名: organize_files dryRun=true -> 用户确认 -> confirmed=true dryRun=false",
      "删除/清理: trash_files dryRun=true -> 用户确认 -> 移入隐藏回收站，不做永久删除"
    ],
    tools: buildFileAccessToolSummaries(),
    toolIds: FILE_ACCESS_TOOL_IDS,
    actionPlan: buildGenericFileAccessActionPlan(),
    detail: kind === "tools"
      ? FILE_ACCESS_TOOL_IDS
      : []
  };
}

export async function buildDiagnoseFileAccessResult(api, input = {}) {
  const snapshot = await loadLibrarySnapshot(api);
  const identifier = collectFileIdentifiers(input)[0] || "";
  const policy = buildPublicFileAccessPolicy(api);
  if (!identifier) {
    throw new Error("fileId or path is required");
  }

  const file = resolveLibraryFile(snapshot.files, identifier, { storageRoot: api.storageRoot });
  if (!file) {
    return {
      generatedAt: new Date().toISOString(),
      status: buildFileAccessDiagnosisStatus(false),
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
      actionPlan: [
        buildAccessAction({
          id: "search-index",
          tool: "search_library_files",
          input: { query: identifier, limit: 10 },
          reason: "文件不在当前索引中，先重新搜索或刷新文件库。",
          contentLayer: "index"
        }),
        buildAccessAction({
          id: "list-nearby-files",
          tool: "list_storage_files",
          input: { query: identifier, limit: 10 },
          reason: "必要时列出相近候选，拿到 fileId 后再诊断或读取。",
          contentLayer: "index"
        })
      ],
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
    status: buildFileAccessDiagnosisStatus(true, blockers),
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
      notes: file.notes || "",
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
        detail: "可写入 tags/aiSummary/notes；批量写入需要确认并记录审计。"
      }),
      buildAccessLayer({
        id: "file-mutation",
        label: "File Mutation",
        available: pathSafe && !hiddenDirectory,
        riskLevel: "high",
        tools: ["organize_files", "trash_files"],
        detail: "移动、重命名、移入回收站必须先 dry-run 预览，并在用户确认后执行。"
      })
    ],
    blockers,
    recommendedTools,
    actionPlan: buildConcreteFileAccessActionPlan(file, hints, pathSafe, hiddenDirectory, analysisDependencies),
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
    const file = resolveLibraryFile(snapshot.files, identifier, { storageRoot: api.storageRoot });
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
      notes: file.notes || "",
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

function collectMutationFileIds(items = [], field = "fileId") {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const value = String(field.split(".").reduce((current, key) => current?.[key], item) || "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function copyMetadataMutationInput(input = {}) {
  const result = {};
  for (const key of ["tags", "addTags", "removeTags"]) {
    if (Array.isArray(input[key])) {
      result[key] = input[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "aiSummary")) {
    result.aiSummary = String(input.aiSummary || "").trim();
  }
  if (input.clearAiSummary === true) {
    result.clearAiSummary = true;
  }
  if (Object.prototype.hasOwnProperty.call(input, "notes")) {
    result.notes = String(input.notes || "").trim();
  } else if (Object.prototype.hasOwnProperty.call(input, "note")) {
    result.notes = String(input.note || "").trim();
  } else if (Object.prototype.hasOwnProperty.call(input, "remark")) {
    result.notes = String(input.remark || "").trim();
  }
  if (input.clearNotes === true || input.clearNote === true || input.clearRemark === true) {
    result.clearNotes = true;
  }
  return result;
}

function buildMetadataMutationInput(input = {}, fileIds = [], extra = {}) {
  const ids = collectMutationFileIds(fileIds.map((fileId) => ({ fileId })));
  return {
    ...(ids.length === 1 ? { fileId: ids[0] } : { fileIds: ids }),
    ...copyMetadataMutationInput(input),
    ...extra
  };
}

function buildUpdateMetadataNextActions({
  dryRun = false,
  requiresConfirmation = false,
  executable = [],
  results = [],
  missing = []
} = {}) {
  const executableCount = executable.length;
  const updatedCount = results.filter((item) => item.status === "updated").length;
  const skippedCount = results.filter((item) => item.status === "skipped").length;
  if (requiresConfirmation) {
    return [
      `已生成 ${executableCount} 个文件的 metadata 写入 dry-run 预览，本次没有写入文件。`,
      "先向用户展示 confirmation.impact 和 results；用户明确确认后，再通过会话恢复链路执行 confirmation.confirmWith 中的 confirmed=true、dryRun=false。"
    ];
  }
  if (dryRun && executableCount) {
    return [
      `已生成 ${executableCount} 个文件的 metadata 写入预览，本次没有写入文件。`,
      "确认字段无误后调用 update_file_metadata dryRun=false 执行；执行后调用 read_file_metadata 复查 tags/aiSummary/notes。"
    ];
  }
  if (updatedCount) {
    return [
      `已写入 ${updatedCount} 个文件的 metadata，并记录了 riskLevel=medium 审计信息。`,
      "调用 read_file_metadata 复查 tags/aiSummary/notes 状态；如果索引或 metadata 缓存未刷新，先重新搜索目标文件。"
    ];
  }
  if (missing.length) {
    return [`未找到 ${missing.length} 个文件；先调用 search_library_files 重新定位候选文件，再写入 metadata。`];
  }
  if (skippedCount) {
    return ["没有可写 metadata 变化；请提供 tags/addTags/removeTags/aiSummary/clearAiSummary/notes/clearNotes 之一后再调用。"];
  }
  return ["没有执行任何 metadata 写入；先确认目标文件和要修改的字段。"];
}

function buildUpdateMetadataActionPlan(input = {}, {
  dryRun = false,
  requiresConfirmation = false,
  executable = [],
  results = [],
  missing = []
} = {}) {
  const executableFileIds = collectMutationFileIds(executable);
  const updatedFileIds = collectMutationFileIds(results.filter((item) => item.status === "updated"));
  const actions = [];
  if (requiresConfirmation && executableFileIds.length) {
    actions.push(buildAccessAction({
      id: "await-metadata-write-confirmation",
      tool: "update_file_metadata",
      input: buildMetadataMutationInput(input, executableFileIds, { confirmed: true, dryRun: false }),
      reason: "批量 metadata 写入需要先向用户展示影响范围；用户明确确认后才可由会话恢复链路执行。",
      riskLevel: "medium",
      requiresConfirmation: true,
      blocked: true,
      contentLayer: "write-metadata"
    }));
  } else if (dryRun && executableFileIds.length) {
    actions.push(buildAccessAction({
      id: "execute-metadata-write",
      tool: "update_file_metadata",
      input: buildMetadataMutationInput(input, executableFileIds, { dryRun: false }),
      reason: "dry-run 预览无误后执行单文件或已授权范围内的 metadata 写入。",
      riskLevel: "medium",
      contentLayer: "write-metadata"
    }));
  } else if (updatedFileIds.length) {
    actions.push(buildAccessAction({
      id: "verify-metadata-write",
      tool: "read_file_metadata",
      input: updatedFileIds.length === 1 ? { fileId: updatedFileIds[0] } : { fileIds: updatedFileIds },
      reason: "写入完成后复查 tags/aiSummary/notes，避免缓存或索引状态误导后续计划。",
      contentLayer: "metadata"
    }));
  }
  if (missing.length && !actions.some((action) => action.tool === "search_library_files")) {
    actions.push(buildAccessAction({
      id: "relocate-missing-files",
      tool: "search_library_files",
      input: { limit: 10 },
      reason: "存在未找到的目标文件；重新搜索索引后再选择 fileId。",
      contentLayer: "index"
    }));
  }
  return actions;
}

function buildOrganizeExecutionInput(executable = [], extra = {}) {
  return {
    actions: (Array.isArray(executable) ? executable : []).map((item) => ({
      fileId: String(item?.source?.fileId || "").trim(),
      targetPath: String(item?.target?.path || "").trim(),
      ...(item?.target?.overwrite === true ? { overwrite: true } : {})
    })).filter((item) => item.fileId && item.targetPath),
    ...extra
  };
}

function firstTargetPathPrefix(items = []) {
  for (const item of Array.isArray(items) ? items : []) {
    const targetPath = normalizeRelativePath(item?.target?.path || "");
    if (!targetPath) {
      continue;
    }
    const parts = targetPath.split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
  }
  return "";
}

function buildOrganizeNextActions({
  dryRun = true,
  requiresConfirmation = false,
  blockers = [],
  executable = [],
  results = [],
  missing = []
} = {}) {
  if (blockers.length) {
    return [
      `存在 ${blockers.length} 个整理阻塞项（缺失、非法目标或冲突），本次没有执行文件变更。`,
      executable.length
        ? "先修复 blockers 中的目标路径/冲突/缺失文件并重新 dry-run；不要在存在阻塞项时执行部分移动。"
        : "修正 targetPath/targetFolder/overwrite，或调用 search_library_files 重新定位文件后再预览整理。"
    ];
  }
  if (requiresConfirmation) {
    return [
      `已生成 ${executable.length} 个文件的移动/重命名预览，本次没有执行文件变更。`,
      "先向用户展示 confirmation.impact 和 actions；用户明确确认后，再通过会话恢复链路执行 confirmed=true、dryRun=false。"
    ];
  }
  if (dryRun && executable.length) {
    return [
      `已生成 ${executable.length} 个文件的整理预览，本次没有执行文件变更。`,
      "移动/重命名是高风险操作；展示目标路径并等待用户明确确认后，才可调用 organize_files confirmed=true dryRun=false。"
    ];
  }
  const movedCount = results.filter((item) => item.status === "moved").length;
  if (movedCount) {
    return [
      `已在 storage root 内移动/重命名 ${movedCount} 个文件，并尽量迁移 tags/aiSummary/notes metadata。`,
      "调用 search_library_files 检查目标目录；如果索引尚未刷新，等待下一次扫描后再用 read_file_metadata 复查新 fileId。"
    ];
  }
  if (missing.length) {
    return [`未找到 ${missing.length} 个文件；先调用 search_library_files 重新定位候选文件，再 dry-run 整理。`];
  }
  return ["没有可执行的整理动作；请提供目标目录、目标文件名或每个文件的 targetPath。"];
}

function buildOrganizeActionPlan({
  dryRun = true,
  requiresConfirmation = false,
  blockers = [],
  executable = [],
  results = [],
  missing = []
} = {}) {
  const actions = [];
  if (blockers.length) {
    actions.push(buildAccessAction({
      id: "repair-organize-preview",
      tool: "organize_files",
      input: { dryRun: true },
      reason: "修复缺失文件、非法目标或目标冲突后重新 dry-run；不要在存在阻塞项时执行文件移动。",
      riskLevel: "high",
      requiresConfirmation: true,
      blocked: true,
      blockerIds: blockers.map((item, index) => `organize-${item.status || "blocked"}-${index + 1}`),
      contentLayer: "file-mutation"
    }));
    if (missing.length) {
      actions.push(buildAccessAction({
        id: "relocate-organize-missing-files",
        tool: "search_library_files",
        input: { limit: 10 },
        reason: "存在未找到的源文件；重新搜索索引后再生成整理预览。",
        contentLayer: "index"
      }));
    }
    return actions;
  }
  if ((requiresConfirmation || dryRun) && executable.length) {
    actions.push(buildAccessAction({
      id: "await-organize-confirmation",
      tool: "organize_files",
      input: buildOrganizeExecutionInput(executable, { confirmed: true, dryRun: false }),
      reason: "移动/重命名属于高风险操作；用户明确确认目标路径后才可由会话恢复链路执行。",
      riskLevel: "high",
      requiresConfirmation: true,
      blocked: true,
      contentLayer: "file-mutation"
    }));
    return actions;
  }
  const moved = results.filter((item) => item.status === "moved");
  if (moved.length) {
    const pathPrefix = firstTargetPathPrefix(moved);
    const movedFileIds = collectMutationFileIds(moved, "target.fileId");
    actions.push(buildAccessAction({
      id: "verify-moved-files",
      tool: "search_library_files",
      input: {
        ...(pathPrefix ? { pathPrefix } : {}),
        limit: Math.min(MAX_LIBRARY_LIST_LIMIT, Math.max(10, moved.length))
      },
      reason: "移动完成后搜索目标目录，确认索引和目标路径状态。",
      contentLayer: "index"
    }));
    if (movedFileIds.length) {
      actions.push(buildAccessAction({
        id: "verify-moved-metadata",
        tool: "read_file_metadata",
        input: movedFileIds.length === 1 ? { fileId: movedFileIds[0] } : { fileIds: movedFileIds },
        reason: "索引刷新后复查迁移后的 tags/aiSummary/notes metadata。",
        contentLayer: "metadata"
      }));
    }
  }
  return actions;
}

function collectTrashActionInputs(input = {}) {
  if (Array.isArray(input.actions) && input.actions.length) {
    return input.actions.slice(0, MAX_FILE_ORGANIZE_ACTIONS).map((action) => ({
      identifier: String(action?.fileId || action?.path || action?.filePath || "").trim(),
      trashPath: action?.trashPath || action?.targetPath || action?.to
    }));
  }
  return [...new Set(collectFileIdentifiers(input))]
    .slice(0, MAX_FILE_ORGANIZE_ACTIONS)
    .map((identifier) => ({ identifier, trashPath: "" }));
}

function formatTrashDate(value = "") {
  const parsed = Date.parse(String(value || "").trim());
  const date = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function isInsideTrashDirectory(relativePath = "") {
  const trashDir = getStorageTrashDirectoryName();
  const first = normalizeRelativePath(relativePath).split("/").filter(Boolean)[0] || "";
  return first === trashDir;
}

function appendRelativePathSuffix(relativePath = "", suffix = "") {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split("/").filter(Boolean);
  const fileName = parts.pop() || "";
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  return [...parts, `${base}${suffix}${ext}`].join("/");
}

function buildTrashTargetPath(api = {}, file = {}, action = {}, input = {}, reservedTargets = new Set()) {
  const explicit = normalizeRelativePath(action.trashPath || "");
  if (explicit) {
    const targetPath = assertSafeMutationRelativePath(explicit);
    if (!isInsideTrashDirectory(targetPath)) {
      throw new Error(`trashPath must stay inside ${getStorageTrashDirectoryName()}`);
    }
    return targetPath;
  }

  const dateSegment = formatTrashDate(input.trashDate || input.now);
  const baseTarget = assertSafeMutationRelativePath(`${getStorageTrashDirectoryName()}/${dateSegment}/${file.relativePath}`);
  let targetPath = baseTarget;
  let suffix = 1;
  while (reservedTargets.has(targetPath.toLowerCase()) || fs.existsSync(safeJoin(api.storageRoot, targetPath))) {
    targetPath = appendRelativePathSuffix(baseTarget, `-${suffix}`);
    suffix += 1;
  }
  reservedTargets.add(targetPath.toLowerCase());
  return targetPath;
}

function buildTrashExecutionInput(executable = [], extra = {}) {
  return {
    actions: (Array.isArray(executable) ? executable : []).map((item) => ({
      fileId: String(item?.source?.fileId || "").trim(),
      trashPath: String(item?.target?.path || "").trim()
    })).filter((item) => item.fileId && item.trashPath),
    ...extra
  };
}

function buildTrashNextActions({
  dryRun = true,
  requiresConfirmation = false,
  blockers = [],
  executable = [],
  results = [],
  missing = []
} = {}) {
  if (blockers.length) {
    return [
      `存在 ${blockers.length} 个移入回收站阻塞项（缺失、隐藏目录、非法目标或冲突），本次没有执行文件变更。`,
      executable.length
        ? "先修复 blockers 后重新 dry-run；不要在存在阻塞项时执行部分移入回收站。"
        : "先调用 search_library_files 重新定位文件，或修正 trashPath 后再预览。"
    ];
  }
  if (requiresConfirmation) {
    return [
      `已生成 ${executable.length} 个文件的移入回收站预览，本次没有执行文件变更。`,
      "先向用户展示 confirmation.impact 和 actions；用户明确确认后，再通过会话恢复链路执行 confirmed=true、dryRun=false。"
    ];
  }
  if (dryRun && executable.length) {
    return [
      `已生成 ${executable.length} 个文件的移入回收站预览，本次没有执行文件变更。`,
      "移入回收站是高风险文件操作；展示原路径和回收站路径，用户确认后才可调用 trash_files confirmed=true dryRun=false。"
    ];
  }
  const trashedCount = results.filter((item) => item.status === "trashed").length;
  if (trashedCount) {
    return [
      `已把 ${trashedCount} 个文件移动到 ${getStorageTrashDirectoryName()} 隐藏回收站，没有永久删除。`,
      "如果误操作，可在 storage root 内从隐藏回收站按 target.path 手动移回 source.path；索引刷新后原文件将不再出现在普通搜索结果。"
    ];
  }
  if (missing.length) {
    return [`未找到 ${missing.length} 个文件；先调用 search_library_files 重新定位候选文件，再 dry-run 移入回收站。`];
  }
  return ["没有可执行的移入回收站动作；请提供 fileIds、paths 或 actions。"];
}

function buildTrashActionPlan({
  dryRun = true,
  requiresConfirmation = false,
  blockers = [],
  executable = [],
  results = [],
  missing = []
} = {}) {
  const actions = [];
  if (blockers.length) {
    actions.push(buildAccessAction({
      id: "repair-trash-preview",
      tool: "trash_files",
      input: { dryRun: true },
      reason: "修复缺失文件、隐藏目录、非法回收站路径或目标冲突后重新 dry-run；不要在存在阻塞项时移动文件。",
      riskLevel: "high",
      requiresConfirmation: true,
      blocked: true,
      blockerIds: blockers.map((item, index) => `trash-${item.status || "blocked"}-${index + 1}`),
      contentLayer: "file-mutation"
    }));
    if (missing.length) {
      actions.push(buildAccessAction({
        id: "relocate-trash-missing-files",
        tool: "search_library_files",
        input: { limit: 10 },
        reason: "存在未找到的源文件；重新搜索索引后再生成移入回收站预览。",
        contentLayer: "index"
      }));
    }
    return actions;
  }
  if ((requiresConfirmation || dryRun) && executable.length) {
    actions.push(buildAccessAction({
      id: "await-trash-confirmation",
      tool: "trash_files",
      input: buildTrashExecutionInput(executable, { confirmed: true, dryRun: false }),
      reason: "移入回收站属于高风险操作；用户明确确认目标路径后才可由会话恢复链路执行。",
      riskLevel: "high",
      requiresConfirmation: true,
      blocked: true,
      contentLayer: "file-mutation"
    }));
    return actions;
  }
  const trashed = results.filter((item) => item.status === "trashed");
  if (trashed.length) {
    actions.push(buildAccessAction({
      id: "verify-trash-removed-from-index",
      tool: "search_library_files",
      input: { limit: Math.min(MAX_LIBRARY_LIST_LIMIT, Math.max(10, trashed.length)) },
      reason: "索引刷新后确认这些文件不再出现在普通 NAS 文件搜索结果中。",
      contentLayer: "index"
    }));
  }
  return actions;
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
    const file = resolveLibraryFile(snapshot.files, identifier, { storageRoot: api.storageRoot });
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
          aiSummaryAvailable: Boolean(file.aiSummaryAvailable),
          notesLength: String(file.notes || "").length
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
        aiSummaryLength: String(file.aiSummary || "").length,
        notesLength: String(file.notes || "").length
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
    nextActions: buildUpdateMetadataNextActions({
      dryRun,
      requiresConfirmation,
      executable,
      results,
      missing
    }),
    actionPlan: buildUpdateMetadataActionPlan(input, {
      dryRun,
      requiresConfirmation,
      executable,
      results,
      missing
    }),
    confirmation: requiresConfirmation
      ? buildSafetyConfirmation({
          operation: "update_file_metadata",
          riskLevel: "medium",
          reason: "批量写入 tags/aiSummary/notes 会修改多个文件的 NAS metadata。",
          targetFileCount: executable.length,
          changedFields: [...allChangedFields],
          files: executable,
          recoverability: "metadata 写入会覆盖对应字段；请先确认 dry-run 预览，必要时保留当前标签/摘要/备注作为回滚依据。",
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
    const file = resolveLibraryFile(snapshot.files, identifier, { storageRoot: api.storageRoot });
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
        aiSummaryAvailable: Boolean(file.aiSummaryAvailable),
        notesAvailable: Boolean(String(file.notes || "").trim())
      },
      target: {
        path: targetPath,
        fileId: file.clientId && targetPath ? `${file.clientId}:${targetPath}` : targetPath,
        exists: targetExists,
        overwrite: action.overwrite === true
      },
      metadataMigration: {
        available: Boolean(file.tags?.length || file.aiSummary || String(file.notes || "").trim()),
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
      nextActions: buildOrganizeNextActions({
        dryRun: true,
        requiresConfirmation,
        blockers,
        executable,
        results: [],
        missing
      }),
      actionPlan: buildOrganizeActionPlan({
        dryRun: true,
        requiresConfirmation,
        blockers,
        executable,
        results: [],
        missing
      }),
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
    nextActions: buildOrganizeNextActions({
      dryRun: false,
      requiresConfirmation: false,
      blockers: [],
      executable: [],
      results,
      missing
    }),
    actionPlan: buildOrganizeActionPlan({
      dryRun: false,
      requiresConfirmation: false,
      blockers: [],
      executable: [],
      results,
      missing
    }),
    audit: {
      storageRootOnly: true,
      absolutePathsExposed: false,
      overwrite: input.overwrite === true
    }
  };
}

export async function buildTrashFilesResult(api, input = {}) {
  const actionInputs = collectTrashActionInputs(input);
  if (!actionInputs.length) {
    throw new Error("fileIds、paths 或 actions 至少需要一个");
  }

  const snapshot = await loadLibrarySnapshot(api);
  const confirmed = input.confirmed === true;
  const requestedDryRun = input.dryRun !== false;
  const dryRun = requestedDryRun || !confirmed;
  const missing = [];
  const planned = [];
  const reservedTargets = new Set();

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
    const file = resolveLibraryFile(snapshot.files, identifier, { storageRoot: api.storageRoot });
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

    let targetPath = "";
    try {
      if (isHiddenRelativePath(file.relativePath)) {
        throw new Error("source file is inside a hidden/system NAS directory");
      }
      safeJoin(api.storageRoot, file.relativePath);
      targetPath = buildTrashTargetPath(api, file, action, input, reservedTargets);
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

    const targetAbs = safeJoin(api.storageRoot, targetPath);
    const targetExists = fs.existsSync(targetAbs);
    planned.push({
      status: targetExists ? "conflict" : "ready",
      reason: targetExists ? "trash target already exists; dry-run again to choose a unique trashPath" : "",
      source: {
        fileId: file.id,
        path: file.relativePath,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        tags: file.tags || [],
        aiSummaryAvailable: Boolean(file.aiSummaryAvailable),
        notesAvailable: Boolean(String(file.notes || "").trim())
      },
      target: {
        path: targetPath,
        fileId: file.clientId && targetPath ? `${file.clientId}:${targetPath}` : targetPath,
        trashDirectory: getStorageTrashDirectoryName(),
        permanentDelete: false,
        exists: targetExists
      },
      restoreHint: {
        originalPath: file.relativePath,
        trashPath: targetPath
      }
    });
  }

  const targetCounts = new Map();
  for (const item of planned) {
    const key = String(item?.target?.path || "").toLowerCase();
    if (key) {
      targetCounts.set(key, (targetCounts.get(key) || 0) + 1);
    }
  }
  for (const item of planned) {
    const key = String(item?.target?.path || "").toLowerCase();
    if (key && targetCounts.get(key) > 1 && item.status === "ready") {
      item.status = "conflict";
      item.reason = "multiple actions target the same trashPath";
    }
  }

  const blockers = planned.filter((item) => ["invalid", "missing", "conflict"].includes(item.status));
  const executable = planned.filter((item) => item.status === "ready");
  const confirmationRequired = !requestedDryRun && !confirmed;
  if (dryRun || blockers.length) {
    const requiresConfirmation = confirmationRequired || executable.length > 0;
    return {
      generatedAt: new Date().toISOString(),
      operation: "trash_files",
      riskLevel: "high",
      dryRun: true,
      confirmed,
      requiresConfirmation,
      blocked: blockers.length > 0 || confirmationRequired,
      blockedReason: blockers.length
        ? "存在缺失文件、隐藏目录、非法回收站路径或目标冲突，未执行任何文件变更。"
        : (confirmationRequired ? "移入回收站属于高风险文件操作，需要用户确认并以 confirmed=true、dryRun=false 再次调用。" : ""),
      count: planned.length,
      executableCount: executable.length,
      missing,
      nextActions: buildTrashNextActions({
        dryRun: true,
        requiresConfirmation,
        blockers,
        executable,
        results: [],
        missing
      }),
      actionPlan: buildTrashActionPlan({
        dryRun: true,
        requiresConfirmation,
        blockers,
        executable,
        results: [],
        missing
      }),
      confirmation: requiresConfirmation
        ? buildSafetyConfirmation({
            operation: "trash_files",
            riskLevel: "high",
            reason: `文件会被移动到 ${getStorageTrashDirectoryName()} 隐藏回收站；不会永久删除，但普通索引将不再显示这些文件。`,
            targetFileCount: executable.length,
            changedFields: ["path"],
            files: executable,
            recoverability: "可在 storage root 内按 restoreHint.trashPath 手动移回 restoreHint.originalPath；如果原路径已被占用，需要人工处理冲突。",
            estimatedDuration: estimateSmallBatchDuration(executable.length),
            confirmWith: {
              ...buildTrashExecutionInput(executable),
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
    results.push({
      ...item,
      status: "trashed",
      target: {
        ...item.target,
        exists: true
      }
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    operation: "trash_files",
    riskLevel: "high",
    dryRun: false,
    confirmed: true,
    requiresConfirmation: false,
    blocked: false,
    count: results.length,
    missing,
    actions: results,
    nextActions: buildTrashNextActions({
      dryRun: false,
      requiresConfirmation: false,
      blockers: [],
      executable: [],
      results,
      missing
    }),
    actionPlan: buildTrashActionPlan({
      dryRun: false,
      requiresConfirmation: false,
      blockers: [],
      executable: [],
      results,
      missing
    }),
    audit: {
      storageRootOnly: true,
      absolutePathsExposed: false,
      permanentDelete: false,
      trashDirectory: getStorageTrashDirectoryName()
    }
  };
}
