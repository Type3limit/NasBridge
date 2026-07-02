import fs from "node:fs";
import path from "node:path";
import { safeJoin, scanFiles } from "../../fsIndex.js";

export const MAX_LIBRARY_LIST_LIMIT = 80;
export const MAX_LIBRARY_DETAIL_FILES = 20;
export const MAX_SUBTITLE_INLINE_CHARS = 50_000;
export const MAX_TEXT_EXCERPT_CHARS = 20_000;
export const MAX_TEXT_EXCERPT_READ_BYTES = 512_000;

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

function getExtension(relativePath = "") {
  return path.extname(String(relativePath || "")).toLowerCase();
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

function isMediaFile(file = {}) {
  const mimeType = String(file.mimeType || "").toLowerCase();
  return mimeType.startsWith("video/") || mimeType.startsWith("audio/") || mimeType.startsWith("image/");
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

export async function loadLibrarySnapshot(api) {
  const clientId = String(api?.clientId || "").trim();
  let snapshot = null;
  if (typeof api?.dependencies?.listLibraryFiles === "function") {
    snapshot = await api.dependencies.listLibraryFiles();
  }
  if (!snapshot) {
    snapshot = await scanFiles(api.storageRoot);
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
  const textReadable = isLikelyTextFile(file);
  const media = isMediaFile(file);
  const tools = ["read_file_metadata"];
  if (textReadable) {
    tools.push("read_text_excerpt");
  }
  if (file.subtitleAvailable || file.aiSummaryAvailable || media) {
    tools.push("read_media_summary");
  }
  if ((media || file.subtitleAvailable) && !file.aiSummaryAvailable) {
    tools.push("analyze_storage_video");
  }
  return {
    rawTextReadable: textReadable,
    media,
    subtitleAvailable: Boolean(file.subtitleAvailable),
    aiSummaryAvailable: Boolean(file.aiSummaryAvailable),
    recommendedTools: tools
  };
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
        rawAbsolutePathExposed: false,
        storageRootOnly: true
      }
    };
  }

  if (!isLikelyTextFile(file)) {
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
    startChar: input.startChar ?? input.offset
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
      source
    },
    policy: {
      rawAbsolutePathExposed: false,
      storageRootOnly: true
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
    policy: {
      accessBy: ["fileId", "relativePath"],
      hiddenDirectories: getHiddenDirectoryNames(),
      maxListResults: MAX_LIBRARY_LIST_LIMIT,
      maxDetailFiles: MAX_LIBRARY_DETAIL_FILES,
      maxTextExcerptChars: MAX_TEXT_EXCERPT_CHARS,
      rawAbsolutePathExposed: false,
      binaryReadAllowed: false,
      writeRequiresConfirmation: true
    },
    readableLayers: [
      "Index: 文件名、相对路径、MIME、大小、mtime、标签、摘要/字幕可用性",
      "Metadata: 单文件元数据、标签、摘要/字幕状态",
      "Excerpt: 文本、字幕、Markdown、JSON 等可控长度片段",
      "Derived: 既有 AI summary、字幕 sidecar、媒体派生信息"
    ],
    blockedLayers: [
      "任意绝对路径读取",
      "STORAGE_ROOT 外文件",
      "二进制原文直接塞进模型上下文",
      "未经确认的删除、移动、重命名、批量覆盖"
    ],
    detail: kind === "tools"
      ? ["list_storage_files", "search_library_files", "read_file_metadata", "get_storage_file_details", "read_text_excerpt", "read_media_summary", "analyze_storage_video"]
      : []
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

function getHiddenDirectoryNames() {
  return [
    process.env.PREVIEW_CACHE_DIR_NAME || ".nas-preview-cache",
    process.env.HLS_CACHE_DIR_NAME || ".nas-hls-cache",
    process.env.AUDIO_STREAM_CACHE_DIR_NAME || ".nas-audio-stream-cache",
    process.env.PROFILE_AVATAR_DIR_NAME || ".nas-user-avatars",
    process.env.CHAT_ROOM_DIR_NAME || ".nas-chat-room",
    process.env.BOT_APP_DATA_DIR_NAME || ".nas-bot"
  ];
}
