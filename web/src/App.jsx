import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Caption1,
  Dropdown,
  Field,
  Input,
  Option,
  Spinner,
  Subtitle1,
  Text,
  Title3
} from "@fluentui/react-components";
import {
  AddRegular,
  AppsListRegular,
  ArrowDownloadRegular,
  ArrowRightRegular,
  ArrowSwapRegular,
  ArrowSyncRegular,
  ChatRegular,
  ChevronRightRegular,
  DeleteRegular,
  CopyRegular,
  DesktopRegular,
  DismissRegular,
  EditRegular,
  EyeRegular,
  FilterRegular,
  FolderOpenRegular,
  ShareRegular,
  StarFilled,
  StarRegular,
  StreamRegular
} from "@fluentui/react-icons";
import { apiRequest } from "./api";
import { P2PBridgePool } from "./webrtc";
import AvatarFace from "./components/AvatarFace";
import ChatRoom from "./components/ChatRoom";
import GlobalMusicPlayer from "./components/GlobalMusicPlayer";
import ProfileDialog from "./components/ProfileDialog";
import { useIsMobile } from "./hooks/useIsMobile";
import MobileBottomTabBar from "./components/mobile/MobileBottomTabBar";
import MobileMoreSheet from "./components/mobile/MobileMoreSheet";
import MobileFilterSheet from "./components/mobile/MobileFilterSheet";
import MiniMusicBar from "./components/mobile/MiniMusicBar";
import VideoHoverPreview from "./components/VideoHoverPreview";

const PreviewModal = lazy(() => import("./components/PreviewModal"));
const TVStream = lazy(() => import("./components/TVStream"));

const THUMB_CACHE_STORAGE_KEY = "nas_thumb_cache_v1";
const THUMB_CACHE_MAX_ITEMS = 120;
const THUMB_CACHE_MAX_BLOB_SIZE = 450 * 1024;
const DESKTOP_STREAM_SAVE_THRESHOLD_BYTES = 512 * 1024 * 1024;
const PREVIEW_FORCE_BLOB_MAX_SIZE = 120 * 1024 * 1024;
const PREVIEW_FIRST_FRAME_TIMEOUT_MS = 8000;
const PREVIEW_HLS_STALL_TIMEOUT_MS = 10000;
const IMAGE_PREVIEW_COMPRESS_THRESHOLD = 6 * 1024 * 1024;
const P2P_PEER_ROLES = ["download", "upload", "preview", "control"];
const MIME_PRESET_OPTIONS = [
  { value: "application/octet-stream", label: "通用二进制" },
  { value: "application/pdf", label: "PDF 文档" },
  { value: "image/jpeg", label: "JPEG 图片" },
  { value: "image/png", label: "PNG 图片" },
  { value: "image/gif", label: "GIF 图片" },
  { value: "video/mp4", label: "MP4 视频" },
  { value: "video/webm", label: "WebM 视频" },
  { value: "audio/mpeg", label: "MP3 音频" },
  { value: "audio/mp4", label: "M4A 音频" },
  { value: "text/plain", label: "纯文本" }
];
const SHARE_EXPIRY_OPTIONS = [
  { value: "1", label: "1 天后失效" },
  { value: "7", label: "7 天后失效" },
  { value: "30", label: "30 天后失效" },
  { value: "0", label: "长期有效" }
];
const FILE_SORT_OPTIONS = [
  { value: "name", label: "按文件名" },
  { value: "createdAt", label: "按上传时间" },
  { value: "type", label: "按类型" }
];
const ROOT_FOLDER_OPTION_VALUE = "__root__";
const PROFILE_AVATAR_DIR_NAME = ".nas-user-avatars";

function sanitizePathSegment(value = "") {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "asset";
}

function getThumbKey(file) {
  return `${file.clientId}|${file.path}|${file.size}|${file.mimeType || ""}`;
}

function loadThumbCache() {
  try {
    const raw = localStorage.getItem(THUMB_CACHE_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function saveThumbCache(cache) {
  try {
    localStorage.setItem(THUMB_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
  }
}

function pruneThumbCache(cache) {
  const entries = Object.entries(cache);
  if (entries.length <= THUMB_CACHE_MAX_ITEMS) {
    return cache;
  }
  entries.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
  const kept = entries.slice(0, THUMB_CACHE_MAX_ITEMS);
  return Object.fromEntries(kept);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "-";
  return `${formatBytes(bytesPerSecond)}/s`;
}

function getRouteLabel(diag = {}) {
  const route = diag.routeLabel || diag.route || "unknown";
  return route;
}

function getRouteColor(diag = {}) {
  const route = diag.route || "unknown";
  if (route === "relay") return "warning";
  if (route === "direct") return "success";
  return "informative";
}

function getPeerRoleLabel(role) {
  if (role === "download") return "下载";
  if (role === "upload") return "上传";
  if (role === "preview") return "预览";
  if (role === "control") return "控制";
  return role || "未知";
}

function formatPeerRoleSummary(diag = {}) {
  const peers = diag.peers || {};
  const items = P2P_PEER_ROLES
    .filter((role) => peers[role])
    .map((role) => {
      const peerDiag = peers[role] || {};
      const route = peerDiag.routeLabel || peerDiag.route || "unknown";
      const state = peerDiag.connectionState || peerDiag.iceState || "new";
      return `${getPeerRoleLabel(role)}:${route}/${state}`;
    });
  return items.join(" · ");
}

function getPeerRoleDiagnostics(diag = {}, role) {
  return diag?.peers?.[role] || {};
}

function buildUploadDraft(file, index = 0) {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${index}-${Math.random().toString(36).slice(2, 7)}`,
    file,
    desiredName: file.name
  };
}

function sanitizeUploadFileName(value, fallbackName = "") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[\\/]+/g, "_")
    .replace(/^\.+$/, "");
  return cleaned || String(fallbackName || "upload.bin");
}

function buildUploadTargetPath(basePath, fileName) {
  const cleanName = sanitizeUploadFileName(fileName, "upload.bin");
  return basePath ? `${basePath}/${cleanName}` : cleanName;
}

function isMobileBrowser() {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || "");
}

function supportsAnchorDownload() {
  if (typeof document === "undefined") {
    return false;
  }
  const link = document.createElement("a");
  return "download" in link;
}

function triggerBrowserDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "download";
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 60_000);
}

async function tryShareDownloadedFile(blob, fileName, mimeType = "application/octet-stream") {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
    return false;
  }
  try {
    const file = new File([blob], fileName || "download", { type: blob.type || mimeType });
    if (typeof navigator.canShare === "function" && !navigator.canShare({ files: [file] })) {
      return false;
    }
    await navigator.share({ files: [file], title: file.name });
    return true;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw error;
    }
    return false;
  }
}

function normalizeFolderPath(value) {
  return (value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function isImageMime(mimeType = "") {
  return mimeType.startsWith("image/");
}

function isVideoMime(mimeType = "") {
  return mimeType.startsWith("video/");
}

function isAudioMime(mimeType = "") {
  return mimeType.startsWith("audio/");
}

function isTextPreviewMime(mimeType = "") {
  const normalized = String(mimeType || "").toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("text/")) {
    return true;
  }
  if (normalized === "application/json" || normalized === "application/xml") {
    return true;
  }
  if (normalized.includes("markdown") || normalized.includes("md")) {
    return true;
  }
  if (normalized.endsWith("+json") || normalized.endsWith("+xml")) {
    return true;
  }
  return false;
}

function isInlinePreviewMime(mimeType = "") {
  return isImageMime(mimeType) || isVideoMime(mimeType) || isAudioMime(mimeType) || isTextPreviewMime(mimeType) || mimeType === "application/pdf";
}

function canBrowserPlayVideoMime(mimeType = "") {
  if (!isVideoMime(mimeType)) {
    return false;
  }
  const video = document.createElement("video");
  const result = video.canPlayType(mimeType);
  return result === "probably" || result === "maybe";
}

function getFileTypeGroup(mimeType = "") {
  if (isImageMime(mimeType)) return "image";
  if (isVideoMime(mimeType)) return "video";
  if (isAudioMime(mimeType)) return "audio";
  if (mimeType === "application/pdf") return "doc";
  return "other";
}

function getFileTypeLabel(type) {
  if (type === "image") return "图片";
  if (type === "video") return "视频";
  if (type === "audio") return "音频";
  if (type === "doc") return "文档";
  if (type === "other") return "其他";
  return "全部类型";
}

function getFileCreatedAt(file = {}) {
  return file.createdAt || file.updatedAt || file.syncedAt || "";
}

function getFileSortTimestamp(file = {}) {
  const ts = Date.parse(getFileCreatedAt(file));
  return Number.isFinite(ts) ? ts : 0;
}

function compareFileNames(left = {}, right = {}) {
  return String(left.name || "").localeCompare(String(right.name || ""), "zh-CN", { numeric: true, sensitivity: "base" });
}

function compareFilesByType(left = {}, right = {}) {
  const groupCompare = getFileTypeLabel(getFileTypeGroup(left.mimeType)).localeCompare(
    getFileTypeLabel(getFileTypeGroup(right.mimeType)),
    "zh-CN",
    { sensitivity: "base" }
  );
  if (groupCompare !== 0) {
    return groupCompare;
  }
  return compareFileNames(left, right);
}

function sortFiles(files = [], sortBy = "createdAt") {
  const next = [...files];
  next.sort((left, right) => {
    if (sortBy === "createdAt") {
      const timeDelta = getFileSortTimestamp(right) - getFileSortTimestamp(left);
      if (timeDelta !== 0) {
        return timeDelta;
      }
      return compareFileNames(left, right);
    }
    if (sortBy === "type") {
      return compareFilesByType(left, right);
    }
    return compareFileNames(left, right);
  });
  return next;
}

function getShareExpiryLabel(value) {
  const matched = SHARE_EXPIRY_OPTIONS.find((item) => item.value === String(value ?? "7"));
  return matched?.label || "7 天后失效";
}

function getShareStatusLabel(status = "") {
  if (status === "active") return "有效";
  if (status === "expired") return "已过期";
  if (status === "revoked") return "已撤销";
  return "未知";
}

function getShareStatusColor(status = "") {
  if (status === "active") return "success";
  if (status === "expired") return "warning";
  if (status === "revoked") return "danger";
  return "informative";
}

function isShareValid(status = "") {
  return status === "active";
}

function getPathFileName(filePath = "") {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function getPathDirectory(filePath = "") {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(0, -1).join("/");
}

function findMimePreset(mimeType = "") {
  const normalized = String(mimeType || "").trim().toLowerCase();
  return MIME_PRESET_OPTIONS.find((item) => item.value.toLowerCase() === normalized) || null;
}

function getMimeDisplayValue(mimeType = "") {
  const preset = findMimePreset(mimeType);
  return preset?.label || mimeType || "自定义 MIME";
}

function getPathSegments(filePath = "") {
  return normalizeFolderPath(filePath).split("/").filter(Boolean);
}

function getImmediateChildFolderPath(filePath = "", currentFolderPath = "") {
  const directorySegments = getPathSegments(getPathDirectory(filePath));
  const currentSegments = getPathSegments(currentFolderPath);
  if (directorySegments.length <= currentSegments.length) {
    return "";
  }
  for (let index = 0; index < currentSegments.length; index += 1) {
    if (directorySegments[index] !== currentSegments[index]) {
      return "";
    }
  }
  return directorySegments.slice(0, currentSegments.length + 1).join("/");
}

function buildExplorerFolderEntries(files = [], directories = [], currentFolderPath = "") {
  const folderMap = new Map();
  for (const directory of directories) {
    const childFolderPath = getImmediateChildFolderPath(directory.path, currentFolderPath);
    if (!childFolderPath) {
      continue;
    }
    const existing = folderMap.get(childFolderPath) || {
      id: `folder:${childFolderPath}`,
      path: childFolderPath,
      name: getPathFileName(childFolderPath),
      fileCount: 0,
      totalBytes: 0,
      clientIds: new Set(),
      latestTimestamp: 0,
      latestCreatedAt: ""
    };
    if (directory.clientId) {
      existing.clientIds.add(directory.clientId);
    }
    const timestamp = getFileSortTimestamp(directory);
    if (timestamp >= existing.latestTimestamp) {
      existing.latestTimestamp = timestamp;
      existing.latestCreatedAt = getFileCreatedAt(directory);
    }
    folderMap.set(childFolderPath, existing);
  }
  for (const file of files) {
    const childFolderPath = getImmediateChildFolderPath(file.path, currentFolderPath);
    if (!childFolderPath) {
      continue;
    }
    const existing = folderMap.get(childFolderPath) || {
      id: `folder:${childFolderPath}`,
      path: childFolderPath,
      name: getPathFileName(childFolderPath),
      fileCount: 0,
      totalBytes: 0,
      clientIds: new Set(),
      latestTimestamp: 0,
      latestCreatedAt: ""
    };
    existing.fileCount += 1;
    existing.totalBytes += Number(file.size || 0);
    if (file.clientId) {
      existing.clientIds.add(file.clientId);
    }
    const timestamp = getFileSortTimestamp(file);
    if (timestamp >= existing.latestTimestamp) {
      existing.latestTimestamp = timestamp;
      existing.latestCreatedAt = getFileCreatedAt(file);
    }
    folderMap.set(childFolderPath, existing);
  }
  return Array.from(folderMap.values())
    .map((folder) => ({
      ...folder,
      clientCount: folder.clientIds.size,
      clientIds: [...folder.clientIds],
      singleClientId: folder.clientIds.size === 1 ? [...folder.clientIds][0] : ""
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
}

function emptyPreviewDebug() {
  return {
    mode: "",
    hlsId: "",
    hlsProfile: "",
    codec: "",
    sourceWidth: 0,
    sourceHeight: 0,
    manifestSegments: 0,
    segmentRequests: 0,
    segmentCompleted: 0,
    segmentErrors: 0,
    segmentBytes: 0,
    lastSegment: "",
    lastError: "",
    hlsState: "idle",
    lastHlsEvent: "",
    bufferedAhead: 0,
    currentTime: 0,
    duration: 0,
    firstFrameAt: ""
  };
}

function formatRelativeTime(value) {
  if (!value) return "-";
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return "-";
  const diff = Date.now() - ts;
  if (diff < 10_000) return "刚刚";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  return `${Math.floor(diff / 86_400_000)}天前`;
}

function getClientStatusColor(status) {
  if (status === "online") return "success";
  if (status === "disabled") return "danger";
  return "informative";
}

async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
  }
  return false;
}

let hlsModulePromise = null;

async function getHlsPlaybackSupport() {
  try {
    hlsModulePromise ||= import("hls.js");
    const mod = await hlsModulePromise;
    const Hls = mod?.default;
    if (!Hls) {
      return { supported: false, reason: "hls.js 未正确加载" };
    }
    if (typeof Hls.isSupported === "function" && Hls.isSupported()) {
      return { supported: true, reason: "hls.js supported" };
    }
    const hasMse = typeof window !== "undefined" && !!(window.MediaSource || window.ManagedMediaSource || window.WebKitMediaSource);
    if (hasMse) {
      return { supported: true, reason: "MediaSource 可用，尝试 HLS" };
    }
    return { supported: false, reason: "当前浏览器缺少 MediaSource 支持" };
  } catch (error) {
    return { supported: false, reason: error?.message || "hls.js 动态加载失败" };
  }
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("nas_token") || "");
  const [user, setUser] = useState(null);
  const [files, setFiles] = useState([]);
  const [directories, setDirectories] = useState([]);
  const [clients, setClients] = useState([]);
  const [users, setUsers] = useState([]);
  const [uploadJobs, setUploadJobs] = useState([]);
  const [downloadJobs, setDownloadJobs] = useState([]);
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [viewMode, setViewMode] = useState("grid");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [diagnostics, setDiagnostics] = useState({ wsState: "idle", clients: {} });
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [authMode, setAuthMode] = useState("login");
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState("explorer");
  const [navExpanded, setNavExpanded] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.innerWidth <= 760;
  });

  // 移动端布局状态
  const isMobile = useIsMobile();
  const [moreSheetOpen, setMoreSheetOpen] = useState(false);
  const [moreNavigatedTab, setMoreNavigatedTab] = useState(null);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  const [previewing, setPreviewing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareTarget, setShareTarget] = useState(null);
  const [shareExpiryDays, setShareExpiryDays] = useState("7");
  const [shareHistoryOpen, setShareHistoryOpen] = useState(false);
  const [editFileOpen, setEditFileOpen] = useState(false);
  const [editFileDraft, setEditFileDraft] = useState(null);
  const [editFileAdvancedOpen, setEditFileAdvancedOpen] = useState(false);
  const [editFolderOpen, setEditFolderOpen] = useState(false);
  const [editFolderDraft, setEditFolderDraft] = useState(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [createFolderSaving, setCreateFolderSaving] = useState(false);
  const [createFolderDraft, setCreateFolderDraft] = useState({ clientId: "", folderName: "" });
  const [createFolderContext, setCreateFolderContext] = useState({ source: "explorer", basePath: "", uploadFolderBasePath: "" });
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteStep, setDeleteStep] = useState(1);
  const [selectedFileIds, setSelectedFileIds] = useState([]);
  const [previewName, setPreviewName] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewMime, setPreviewMime] = useState("");
  const [previewPath, setPreviewPath] = useState("");
  const [previewClientId, setPreviewClientId] = useState("");
  const [previewStatusText, setPreviewStatusText] = useState("");
  const [previewProgress, setPreviewProgress] = useState(null);
  const [previewHlsSource, setPreviewHlsSource] = useState(null);
  const [previewDebug, setPreviewDebug] = useState(emptyPreviewDebug());
  const [previewStage, setPreviewStage] = useState("");

  const [lastRefreshAt, setLastRefreshAt] = useState("");
  const [lastPollAt, setLastPollAt] = useState("");

  const [uploadClientId, setUploadClientId] = useState("");
  const [uploadFolderPath, setUploadFolderPath] = useState("");
  const [uploadFiles, setUploadFiles] = useState([]);
  const [uploadColumnId, setUploadColumnId] = useState("");
  const [columnDraftName, setColumnDraftName] = useState("");
  const [uploadStep, setUploadStep] = useState(1);
  const [uploadAdvancedOpen, setUploadAdvancedOpen] = useState(false);

  const [columns, setColumns] = useState([]);
  const [keyword, setKeyword] = useState("");
  const [columnFilter, setColumnFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sortBy, setSortBy] = useState("createdAt");
  const [currentExplorerPath, setCurrentExplorerPath] = useState("");

  const [thumbMap, setThumbMap] = useState(() => {
    const cache = loadThumbCache();
    return Object.fromEntries(
      Object.entries(cache)
        .filter(([, value]) => typeof value?.dataUrl === "string")
        .map(([key, value]) => [key, { url: value.dataUrl, persisted: true }])
    );
  });
  const thumbnailLoading = useRef(new Set());
  const thumbnailRetry = useRef({});
  const thumbnailCache = useRef(loadThumbCache());
  const previewReleaseRef = useRef(null);
  const previewModeRef = useRef("");
  const previewFirstFrameRef = useRef(false);
  const previewAutoFallbackRef = useRef("");
  const previewHlsFallbackRef = useRef("");
  const previewSessionIdRef = useRef(0);
  const fileInputRef = useRef(null);
  const uploadProgressReportAt = useRef({});
  const activeLocalUploadJobIds = useRef(new Set());
  const fileListRef = useRef(null);
  const toastTimersRef = useRef(new Map());
  const mobilePageContentRef = useRef(null);
  const [listHeight, setListHeight] = useState(520);
  const [listScrollTop, setListScrollTop] = useState(0);

  const [p2p, setP2p] = useState(null);

  // 跨页面启动：大屏页「↗ 主页预览」跳回时自动打开 PreviewModal
  const mainToPreviewLaunchRef = useRef((() => {
    try {
      const raw = sessionStorage.getItem("lr_to_main_preview");
      if (!raw) return null;
      sessionStorage.removeItem("lr_to_main_preview");
      return JSON.parse(raw);
    } catch { return null; }
  })());

  function getDownloadJobId(file) {
    return `${file.clientId}|${file.path}`;
  }

  function upsertDownloadJob(file, patch = {}) {
    const jobId = getDownloadJobId(file);
    const now = Date.now();
    setDownloadJobs((prev) => {
      const idx = prev.findIndex((item) => item.id === jobId);
      const current = idx >= 0 ? prev[idx] : {
        id: jobId,
        clientId: file.clientId,
        fileName: file.name,
        path: file.path,
        channelName: "file",
        requestId: "",
        size: Number(file.size || 0),
        transferredBytes: 0,
        progress: 0,
        speedBytesPerSec: 0,
        mode: "browser",
        startedAt: now,
        lastProgressAt: now
      };
      const nextTransferredBytes = typeof patch.transferredBytes === "number"
        ? patch.transferredBytes
        : (current.transferredBytes || 0);
      const nextSize = typeof patch.size === "number"
        ? patch.size
        : (current.size || Number(file.size || 0));
      let nextSpeed = current.speedBytesPerSec || 0;
      let nextLastProgressAt = current.lastProgressAt || current.startedAt || now;
      if (typeof patch.transferredBytes === "number") {
        const deltaBytes = patch.transferredBytes - (current.transferredBytes || 0);
        const deltaMs = now - (current.lastProgressAt || current.startedAt || now);
        if (deltaBytes > 0 && deltaMs > 0) {
          nextSpeed = Math.round(deltaBytes / (deltaMs / 1000));
        } else {
          const elapsedMs = Math.max(1, now - (current.startedAt || now));
          nextSpeed = Math.round(nextTransferredBytes / (elapsedMs / 1000));
        }
        nextLastProgressAt = now;
      }
      const nextJob = {
        ...current,
        ...patch,
        id: jobId,
        clientId: file.clientId,
        fileName: file.name,
        path: file.path,
        channelName: patch.channelName || current.channelName || "file",
        requestId: patch.requestId || current.requestId || "",
        size: nextSize,
        transferredBytes: nextTransferredBytes,
        progress: typeof patch.progress === "number"
          ? patch.progress
          : (nextSize > 0 ? Math.max(0, Math.min(100, Math.round((nextTransferredBytes / nextSize) * 100))) : (current.progress || 0)),
        speedBytesPerSec: nextSpeed,
        updatedAt: now,
        lastProgressAt: nextLastProgressAt
      };
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = nextJob;
        return next;
      }
      return [nextJob, ...prev].slice(0, 12);
    });
    return jobId;
  }

  function removeDownloadJob(jobId) {
    setDownloadJobs((prev) => prev.filter((item) => item.id !== jobId));
  }

  function cancelDownloadJob(job) {
    if (!p2p || !job?.clientId) {
      return;
    }
    const cancelled = p2p.cancelOperation(job.clientId, job.channelName || "file", job.requestId || "");
    removeDownloadJob(job.id);
    setMessage(cancelled ? `已取消下载: ${job.fileName || job.path || "任务"}` : "下载任务已结束或无法取消", cancelled ? "warning" : "info");
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shareId = params.get("share");
    if (!shareId) {
      return;
    }
    const currentPath = window.location.pathname || "/";
    if (/share\.html$/i.test(currentPath)) {
      return;
    }
    window.location.replace(`/share.html?share=${encodeURIComponent(shareId)}`);
  }, []);

  useEffect(() => {
    if (!token) {
      setP2p((prev) => { prev?.dispose(); return null; });
      return;
    }
    const bridge = new P2PBridgePool(token);
    setP2p((prev) => { prev?.dispose(); return bridge; });
    return () => bridge.dispose();
  }, [token]);

  useEffect(() => {
    return () => {
      for (const timer of toastTimersRef.current.values()) {
        clearTimeout(timer);
      }
      toastTimersRef.current.clear();
    };
  }, []);

  const visibleUploadJobs = useMemo(() => {
    return uploadJobs.filter((job) => job.status === "uploading");
  }, [uploadJobs]);

  const uploadingFileKeys = useMemo(() => {
    const set = new Set();
    for (const job of uploadJobs) {
      if (job.status === "uploading" && job.clientId && job.relativePath) {
        set.add(`${job.clientId}|${job.relativePath}`);
      }
    }
    return set;
  }, [uploadJobs]);

  const onlineCount = useMemo(() => clients.filter((item) => item.status === "online").length, [clients]);
  const relayCount = useMemo(
    () => clients.filter((c) => (diagnostics.clients[c.id]?.route || "unknown") === "relay").length,
    [clients, diagnostics]
  );
  const uploadingCount = useMemo(
    () => uploadJobs.filter((job) => job.status === "uploading").length,
    [uploadJobs]
  );
  const downloadingCount = useMemo(() => downloadJobs.length, [downloadJobs]);

  const onlineFiles = useMemo(() => {
    const onlineIds = new Set(clients.filter((c) => c.status === "online").map((c) => c.id));
    return files.filter((f) => onlineIds.has(f.clientId));
  }, [files, clients]);

  const onlineDirectories = useMemo(() => {
    const onlineIds = new Set(clients.filter((c) => c.status === "online").map((c) => c.id));
    return directories.filter((directory) => onlineIds.has(directory.clientId));
  }, [directories, clients]);

  const columnMap = useMemo(() => {
    return new Map(columns.map((item) => [item.id, item.name]));
  }, [columns]);

  const filteredOnlineFiles = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const filtered = onlineFiles.filter((file) => {
      if (columnFilter === "none" && file.columnId) {
        return false;
      }
      if (columnFilter !== "all" && columnFilter !== "none" && file.columnId !== columnFilter) {
        return false;
      }
      if (typeFilter !== "all" && getFileTypeGroup(file.mimeType) !== typeFilter) {
        return false;
      }
      if (kw) {
        const hay = `${file.name} ${file.path}`.toLowerCase();
        if (!hay.includes(kw)) {
          return false;
        }
      }
      return true;
    });
    return sortFiles(filtered, sortBy);
  }, [onlineFiles, columnFilter, typeFilter, keyword, sortBy]);

  const filteredOnlineDirectories = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return onlineDirectories
      .filter((directory) => {
        if (columnFilter !== "all" || typeFilter !== "all") {
          return false;
        }
        if (kw) {
          const hay = `${directory.name || ""} ${directory.path || ""}`.toLowerCase();
          if (!hay.includes(kw)) {
            return false;
          }
        }
        return true;
      })
      .sort((left, right) => String(left.path || "").localeCompare(String(right.path || ""), "zh-CN", { numeric: true, sensitivity: "base" }));
  }, [onlineDirectories, columnFilter, typeFilter, keyword]);

  const explorerFolderEntries = useMemo(
    () => buildExplorerFolderEntries(filteredOnlineFiles, filteredOnlineDirectories, currentExplorerPath),
    [filteredOnlineFiles, filteredOnlineDirectories, currentExplorerPath]
  );
  const currentFolderFiles = useMemo(
    () => filteredOnlineFiles.filter((file) => normalizeFolderPath(getPathDirectory(file.path)) === currentExplorerPath),
    [filteredOnlineFiles, currentExplorerPath]
  );
  const currentFolderDirectories = useMemo(
    () => onlineDirectories.filter((directory) => normalizeFolderPath(getPathDirectory(directory.path)) === currentExplorerPath),
    [onlineDirectories, currentExplorerPath]
  );
  const currentExplorerEntries = useMemo(
    () => [
      ...explorerFolderEntries.map((folder) => ({ kind: "folder", key: folder.id, folder })),
      ...currentFolderFiles.map((file) => ({ kind: "file", key: file.id, file }))
    ],
    [explorerFolderEntries, currentFolderFiles]
  );
  const explorerBreadcrumbs = useMemo(() => {
    const segments = getPathSegments(currentExplorerPath);
    return segments.map((segment, index) => ({
      label: segment,
      path: segments.slice(0, index + 1).join("/")
    }));
  }, [currentExplorerPath]);
  const editFolderOptions = useMemo(() => {
    const options = new Set([""]);
    const currentPath = normalizeFolderPath(editFileDraft?.directoryPath || "");
    if (currentPath) {
      options.add(currentPath);
    }
    for (const directory of directories) {
      if (editFileDraft?.clientId && directory.clientId !== editFileDraft.clientId) {
        continue;
      }
      const directoryPath = normalizeFolderPath(directory.path);
      if (directoryPath) {
        options.add(directoryPath);
      }
    }
    for (const file of files) {
      if (editFileDraft?.clientId && file.clientId !== editFileDraft.clientId) {
        continue;
      }
      const directoryPath = normalizeFolderPath(getPathDirectory(file.path));
      if (directoryPath) {
        options.add(directoryPath);
      }
    }
    return Array.from(options).sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" }));
  }, [directories, files, editFileDraft?.clientId, editFileDraft?.directoryPath]);
  const createFolderClientOptions = useMemo(
    () => clients.filter((client) => client.status === "online"),
    [clients]
  );
  const preferredCreateFolderClientId = useMemo(() => {
    const onlineIds = new Set(createFolderClientOptions.map((client) => client.id));
    const currentIds = new Set();
    for (const file of currentFolderFiles) {
      if (file.clientId && onlineIds.has(file.clientId)) {
        currentIds.add(file.clientId);
      }
    }
    for (const directory of currentFolderDirectories) {
      if (directory.clientId && onlineIds.has(directory.clientId)) {
        currentIds.add(directory.clientId);
      }
    }
    if (currentIds.size === 1) {
      return [...currentIds][0];
    }
    if (uploadClientId && onlineIds.has(uploadClientId)) {
      return uploadClientId;
    }
    return createFolderClientOptions[0]?.id || "";
  }, [createFolderClientOptions, currentFolderDirectories, currentFolderFiles, uploadClientId]);

  const totalOnlineBytes = useMemo(
    () => onlineFiles.reduce((sum, file) => sum + Number(file.size || 0), 0),
    [onlineFiles]
  );
  const mediaFileCount = useMemo(
    () => onlineFiles.filter((file) => isImageMime(file.mimeType) || isVideoMime(file.mimeType)).length,
    [onlineFiles]
  );
  const favoriteCount = useMemo(
    () => onlineFiles.filter((file) => file.favorite).length,
    [onlineFiles]
  );
  const previewTargetFile = useMemo(
    () => files.find((item) => item.clientId === previewClientId && item.path === previewPath) || null,
    [files, previewClientId, previewPath]
  );
  const categorizedCount = useMemo(
    () => onlineFiles.filter((file) => file.columnId).length,
    [onlineFiles]
  );
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (keyword.trim()) count += 1;
    if (columnFilter !== "all") count += 1;
    if (typeFilter !== "all") count += 1;
    if (sortBy !== "createdAt") count += 1;
    return count;
  }, [keyword, columnFilter, typeFilter, sortBy]);
  const uploadTargetPreview = useMemo(() => {
    const folderPath = normalizeFolderPath(uploadFolderPath);
    const columnName = columnMap.get(uploadColumnId) || "";
    return normalizeFolderPath([columnName, folderPath].filter(Boolean).join("/"));
  }, [uploadFolderPath, uploadColumnId, columnMap]);
  const uploadFolderOptions = useMemo(() => {
    const options = new Set([""]);
    const clientId = String(uploadClientId || "").trim();
    const columnName = normalizeFolderPath(columnMap.get(uploadColumnId) || "");
    const prefix = columnName ? `${columnName}/` : "";
    const currentPath = normalizeFolderPath(uploadFolderPath);
    if (currentPath) {
      options.add(currentPath);
    }
    for (const directory of directories) {
      if (clientId && directory.clientId !== clientId) {
        continue;
      }
      const directoryPath = normalizeFolderPath(directory.path);
      if (!directoryPath) {
        continue;
      }
      if (columnName) {
        if (directoryPath === columnName) {
          options.add("");
          continue;
        }
        if (!directoryPath.startsWith(prefix)) {
          continue;
        }
        options.add(normalizeFolderPath(directoryPath.slice(prefix.length)));
        continue;
      }
      options.add(directoryPath);
    }
    return Array.from(options).sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" }));
  }, [columnMap, directories, uploadClientId, uploadColumnId, uploadFolderPath]);
  const uploadFolderBreadcrumbs = useMemo(() => {
    const segments = getPathSegments(uploadFolderPath);
    return segments.map((segment, index) => ({
      label: segment,
      path: segments.slice(0, index + 1).join("/")
    }));
  }, [uploadFolderPath]);
  const uploadFolderChildren = useMemo(() => {
    const folderMap = new Map();
    for (const option of uploadFolderOptions.filter(Boolean)) {
      const childPath = getImmediateChildFolderPath(option, uploadFolderPath);
      if (!childPath) {
        continue;
      }
      if (!folderMap.has(childPath)) {
        folderMap.set(childPath, {
          path: childPath,
          name: getPathFileName(childPath)
        });
      }
    }
    return Array.from(folderMap.values()).sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
  }, [uploadFolderOptions, uploadFolderPath]);
  const uploadTotalBytes = useMemo(
    () => uploadFiles.reduce((sum, item) => sum + Number(item?.file?.size || 0), 0),
    [uploadFiles]
  );
  const currentFileShares = useMemo(() => {
    if (!shareTarget?.id) {
      return [];
    }
    return shares.filter((item) => item.file?.id === shareTarget.id || item.fileId === shareTarget.id).slice(0, 8);
  }, [shares, shareTarget]);
  const selectedVisibleFiles = useMemo(
    () => currentFolderFiles.filter((file) => selectedFileIds.includes(file.id)),
    [currentFolderFiles, selectedFileIds]
  );
  const selectedVisibleAllFavorite = useMemo(
    () => selectedVisibleFiles.length > 0 && selectedVisibleFiles.every((file) => file.favorite),
    [selectedVisibleFiles]
  );
  const allVisibleSelected = useMemo(
    () => currentFolderFiles.length > 0 && currentFolderFiles.every((file) => selectedFileIds.includes(file.id)),
    [currentFolderFiles, selectedFileIds]
  );

  useEffect(() => {
    const allowedTabs = new Set(["explorer", "chat", "overview", "terminals", "transfers", "shares", "tv"]);
    if (user?.role === "admin") {
      allowedTabs.add("admin-users");
      allowedTabs.add("admin-clients");
    }
    if (!allowedTabs.has(activeWorkspaceTab)) {
      setActiveWorkspaceTab("explorer");
    }
  }, [activeWorkspaceTab, user?.role]);

  const detailItemHeight = 96;
  const detailOverscan = 6;
  const detailTotal = currentExplorerEntries.length;
  const detailStart = Math.max(0, Math.floor(listScrollTop / detailItemHeight) - detailOverscan);
  const detailEnd = Math.min(
    detailTotal,
    Math.ceil((listScrollTop + listHeight) / detailItemHeight) + detailOverscan
  );
  const detailSlice = isMobileViewport ? currentExplorerEntries : currentExplorerEntries.slice(detailStart, detailEnd);
  const detailPaddingTop = isMobileViewport ? 0 : detailStart * detailItemHeight;
  const detailPaddingBottom = isMobileViewport ? 0 : Math.max(0, (detailTotal - detailEnd) * detailItemHeight);

  function openExplorerFolder(nextPath = "") {
    const normalized = normalizeFolderPath(nextPath);
    setCurrentExplorerPath(normalized);
    setListScrollTop(0);
    if (fileListRef.current) {
      fileListRef.current.scrollTop = 0;
    }
  }

  function openExplorerParentFolder() {
    const segments = getPathSegments(currentExplorerPath);
    if (!segments.length) {
      return;
    }
    segments.pop();
    openExplorerFolder(segments.join("/"));
  }

  function openCreateFolderModal(options = {}) {
    const source = String(options.source || "explorer");
    const basePath = normalizeFolderPath(options.basePath ?? currentExplorerPath);
    const clientId = String(options.clientId || (source === "upload" ? uploadClientId : preferredCreateFolderClientId) || "").trim();
    setCreateFolderDraft({
      clientId,
      folderName: ""
    });
    setCreateFolderContext({
      source,
      basePath,
      uploadFolderBasePath: normalizeFolderPath(options.uploadFolderBasePath || "")
    });
    setCreateFolderOpen(true);
  }

  function closeCreateFolderModal(force = false) {
    if (createFolderSaving && !force) {
      return;
    }
    setCreateFolderOpen(false);
    setCreateFolderDraft({ clientId: "", folderName: "" });
    setCreateFolderContext({ source: "explorer", basePath: "", uploadFolderBasePath: "" });
  }

  function isUploadingFile(file) {
    return uploadingFileKeys.has(`${file.clientId}|${file.path}`);
  }

  function appendUploadFiles(fileList) {
    const nextFiles = Array.from(fileList || []);
    if (!nextFiles.length) {
      return;
    }
    setUploadFiles((prev) => [
      ...prev,
      ...nextFiles.map((file, index) => buildUploadDraft(file, prev.length + index))
    ]);
  }

  function updateUploadFileName(id, value) {
    setUploadFiles((prev) => prev.map((item) => (
      item.id === id ? { ...item, desiredName: value } : item
    )));
  }

  function removeUploadDraft(id) {
    setUploadFiles((prev) => prev.filter((item) => item.id !== id));
  }

  function removeUploadJobLocal(jobId) {
    if (!jobId) {
      return;
    }
    activeLocalUploadJobIds.current.delete(jobId);
    setUploadJobs((prev) => prev.filter((item) => item.id !== jobId));
  }

  function mergePolledUploadJobs(previousJobs, incomingJobs) {
    const prevList = Array.isArray(previousJobs) ? previousJobs : [];
    const nextList = Array.isArray(incomingJobs) ? incomingJobs : [];
    const prevById = new Map(prevList.filter((job) => job?.id).map((job) => [job.id, job]));
    const incomingIds = new Set();
    const merged = nextList.map((job) => {
      if (!job?.id) {
        return job;
      }
      incomingIds.add(job.id);
      const previous = prevById.get(job.id);
      if (!previous) {
        return job;
      }
      const combined = { ...previous, ...job };
      if (combined.status === "uploading") {
        combined.progress = Math.max(previous.progress || 0, combined.progress || 0);
        combined.transferredBytes = Math.max(previous.transferredBytes || 0, combined.transferredBytes || 0);
        combined.speedBytesPerSec = combined.speedBytesPerSec || previous.speedBytesPerSec || 0;
        combined.lastProgressAt = combined.lastProgressAt || previous.lastProgressAt || 0;
      }
      return combined;
    });

    const preservedActive = prevList.filter((job) => (
      job?.id
      && job.status === "uploading"
      && activeLocalUploadJobIds.current.has(job.id)
      && !incomingIds.has(job.id)
    ));

    return [...preservedActive, ...merged].slice(0, 120);
  }

  function replaceUploadJobs(incomingJobs) {
    setUploadJobs((prev) => mergePolledUploadJobs(prev, incomingJobs));
  }

  function getColumnDisplayValue(columnId) {
    if (columnId === "all") {
      return "全部栏目";
    }
    if (!columnId || columnId === "none") {
      return "未分类";
    }
    return columnMap.get(columnId) || "未分类";
  }

  function getClientDropdownValue(clientId) {
    return clientId ? getClientDisplayName(clientId) : "请选择终端";
  }

  function getTypeDropdownValue(type) {
    if (!type || type === "all") {
      return "全部类型";
    }
    return getFileTypeLabel(type);
  }

  function getShareFileName(share) {
    if (!share) {
      return "文件已移除";
    }
    return share.file?.name || share.fileName || getPathFileName(share.file?.path || share.filePath || share.fileId || "") || "文件已移除";
  }

  function getShareFilePath(share) {
    if (!share) {
      return "";
    }
    return share.file?.path || share.filePath || share.fileId || "";
  }

  function getFileSortDropdownValue(value) {
    const matched = FILE_SORT_OPTIONS.find((item) => item.value === value);
    return matched?.label || "按上传时间";
  }

  function renderOverviewPage() {
    return (
      <section className="workspacePage">
        <div className="workspacePageCard commandCard">
          <div className="workspacePageHeader">
            <div className="workspacePageTitleBlock">
              <Subtitle1>系统概览</Subtitle1>
              <Caption1>集中查看同步状态、快速操作和当前工作负载。</Caption1>
            </div>
            <div className="workspacePageActions">
              <Button appearance="primary" onClick={() => setUploadOpen(true)}>发起上传</Button>
              <Button onClick={() => setDiagnosticsOpen(true)}>打开诊断</Button>
              <Button onClick={() => refreshAll()}>{loading ? <Spinner size="tiny" /> : "同步索引"}</Button>
              <Button onClick={() => setViewMode((prev) => prev === "grid" ? "details" : "grid")}>{viewMode === "grid" ? "切到详情" : "切到卡片"}</Button>
            </div>
          </div>

          <div className="workspaceMetricsGrid overviewMetricsGrid">
            <div className="railMetric">
              <Caption1>信令状态</Caption1>
              <Text>{diagnostics.wsState || "idle"}</Text>
            </div>
            <div className="railMetric">
              <Caption1>最近刷新</Caption1>
              <Text>{formatRelativeTime(lastRefreshAt)}</Text>
            </div>
            <div className="railMetric">
              <Caption1>轮询更新</Caption1>
              <Text>{formatRelativeTime(lastPollAt)}</Text>
            </div>
            <div className="railMetric">
              <Caption1>在线终端</Caption1>
              <Text>{onlineCount}</Text>
            </div>
            <div className="railMetric">
              <Caption1>当前筛选</Caption1>
              <Text>{activeFilterCount ? `${activeFilterCount} 项` : "无"}</Text>
            </div>
            <div className="railMetric">
              <Caption1>上传队列</Caption1>
              <Text>{visibleUploadJobs.length} 项</Text>
            </div>
            <div className="railMetric">
              <Caption1>下载队列</Caption1>
              <Text>{downloadingCount} 项</Text>
            </div>
            <div className="railMetric">
              <Caption1>分享链接</Caption1>
              <Text>{shares.length} 条</Text>
            </div>
          </div>
        </div>
      </section>
    );
  }

  function renderTerminalsPage() {
    return (
      <section className="workspacePage">
        <div className="workspacePageCard">
          <div className="workspacePageHeader">
            <div className="workspacePageTitleBlock">
              <Subtitle1>终端状态</Subtitle1>
              <Caption1>查看在线情况、路由模式与各存储终端最近心跳。</Caption1>
            </div>
            <div className="workspacePageActions">
              <Badge appearance="outline" color={onlineCount ? "success" : "informative"}>在线 {onlineCount}</Badge>
              <Badge appearance="outline" color={relayCount ? "warning" : "informative"}>中继 {relayCount}</Badge>
            </div>
          </div>

          <div className="miniList workspaceList">
            {clients.map((client) => (
              <div key={client.id} className="miniListRow terminalRow workspaceTerminalRow">
                <div className="miniListMain">
                  <Text className="miniListTitle">{getClientDisplayName(client.id)}</Text>
                  <Caption1>ID: {client.id}</Caption1>
                  <Caption1>{client.lastHeartbeatAt ? `心跳 ${formatRelativeTime(client.lastHeartbeatAt)}` : "无心跳"}</Caption1>
                  <Caption1>{formatPeerRoleSummary(diagnostics.clients[client.id] || {}) || "暂无角色连接"}</Caption1>
                </div>
                <div className="miniListBadges">
                  <Badge appearance="outline" color={getClientStatusColor(client.status)}>{client.status || "unknown"}</Badge>
                  <Badge appearance="outline" color={(diagnostics.clients[client.id]?.route || "unknown") === "relay" ? "warning" : "informative"}>{diagnostics.clients[client.id]?.route || "unknown"}</Badge>
                </div>
              </div>
            ))}
            {!clients.length && <Caption1>暂无终端数据</Caption1>}
          </div>
        </div>
      </section>
    );
  }

  function renderTransfersPage() {
    return (
      <section className="workspacePage">
        <div className="workspacePageCard">
          <div className="workspacePageHeader">
            <div className="workspacePageTitleBlock">
              <Subtitle1>传输队列</Subtitle1>
              <Caption1>统一查看上传与下载任务、传输速率和当前链路。</Caption1>
            </div>
            <div className="workspacePageActions">
              <Badge appearance="outline" color={visibleUploadJobs.length ? "success" : "subtle"}>上传 {visibleUploadJobs.length}</Badge>
              <Badge appearance="outline" color={downloadJobs.length ? "informative" : "subtle"}>下载 {downloadJobs.length}</Badge>
            </div>
          </div>

          <div className="miniList workspaceList">
            {downloadJobs.map((job) => renderTransferQueueRow(job, "download"))}
            {visibleUploadJobs.map((job) => renderTransferQueueRow(job, "upload"))}
            {!downloadJobs.length && !visibleUploadJobs.length && <Caption1>当前没有正在传输的任务</Caption1>}
          </div>
        </div>
      </section>
    );
  }

  function renderSharesPage() {
    return (
      <section className="workspacePage">
        <div className="workspacePageCard">
          <div className="workspacePageHeader">
            <div className="workspacePageTitleBlock">
              <Subtitle1>分享管理</Subtitle1>
              <Caption1>统一维护已生成的分享链接、有效期和访问统计。</Caption1>
            </div>
            <div className="workspacePageActions">
              <Badge appearance="outline" color={shares.length ? "informative" : "subtle"}>{shares.length}</Badge>
            </div>
          </div>

          <div className="miniList shareMiniList workspaceList">
            {shares.map((share) => (
              <div key={share.id} className="miniListRow shareMiniRow shareManagerRow">
                <div className="miniListMain shareMiniMain shareManagerMain">
                  <div className="shareManagerTitleRow">
                    <span
                      className={`shareStatusDot ${isShareValid(share.status) ? "valid" : "invalid"}`}
                      title={isShareValid(share.status) ? "有效" : "无效"}
                      aria-label={isShareValid(share.status) ? "有效" : "无效"}
                    />
                    <Text className="miniListTitle shareManagerTitle">{getShareFileName(share)}</Text>
                  </div>
                  <Caption1 className="shareManagerPath">{getShareFilePath(share) || "路径不可用"}</Caption1>
                  <Caption1 className="shareManagerMetaLine">
                    创建于 {formatRelativeTime(share.createdAt)} · 访问 {share.accessCount || 0} 次 · {share.expiresAt ? `到期 ${formatRelativeTime(share.expiresAt)}` : "长期有效"}
                  </Caption1>
                </div>
                <div className="miniListBadges shareMiniActions shareManagerActions">
                  <button
                    type="button"
                    className="iconActionButton shareManagerIconButton"
                    title="复制分享链接"
                    aria-label="复制分享链接"
                    onClick={() => copyShareUrl(share.shareUrl)}
                  >
                    <CopyRegular />
                  </button>
                  <button
                    type="button"
                    className="iconActionButton shareManagerIconButton"
                    title="撤销分享"
                    aria-label="撤销分享"
                    disabled={share.status !== "active"}
                    onClick={() => revokeShare(share.id)}
                  >
                    <DismissRegular />
                  </button>
                  <button
                    type="button"
                    className="iconActionButton shareManagerIconButton danger"
                    title="删除分享记录"
                    aria-label="删除分享记录"
                    onClick={() => deleteShare(share.id)}
                  >
                    <DeleteRegular />
                  </button>
                </div>
              </div>
            ))}
            {!shares.length && <Caption1>当前还没有已生成的分享链接</Caption1>}
          </div>
        </div>
      </section>
    );
  }

  function renderAdminUsersPage() {
    return (
      <section className="workspacePage">
        <div className="workspacePageCard">
          <div className="workspacePageHeader">
            <div className="workspacePageTitleBlock">
              <Subtitle1>后台管理 - 用户</Subtitle1>
              <Caption1>查看当前系统用户、角色与邮箱信息。</Caption1>
            </div>
            <div className="workspacePageActions">
              <Badge appearance="outline" color={users.length ? "informative" : "subtle"}>{users.length}</Badge>
            </div>
          </div>
          <div className="adminList workspaceList">
            {users.map((item) => (
              <div key={item.id} className="simpleRow">
                <div>
                  <div className="fileName">{item.displayName} · {item.role}</div>
                  <div className="fileSub">{item.email}</div>
                </div>
              </div>
            ))}
            {!users.length && <Caption1>暂无用户数据</Caption1>}
          </div>
        </div>
      </section>
    );
  }

  function renderAdminClientsPage() {
    return (
      <section className="workspacePage">
        <div className="workspacePageCard">
          <div className="workspacePageHeader">
            <div className="workspacePageTitleBlock">
              <Subtitle1>后台管理 - 存储终端</Subtitle1>
              <Caption1>管理终端启停、路由连接和全角色重连。</Caption1>
            </div>
            <div className="workspacePageActions">
              <Badge appearance="outline" color={clients.length ? "informative" : "subtle"}>{clients.length}</Badge>
            </div>
          </div>
          <div className="adminList workspaceList">
            {clients.map((item) => (
              <div key={item.id} className="simpleRow withActions">
                <div>
                  <div className="fileName">{item.name || item.id}</div>
                  <div className="fileSub">ID: {item.id}</div>
                  <div className="fileSub">
                    状态: {item.status} · 心跳: {formatRelativeTime(item.lastHeartbeatAt)} · 路由: {diagnostics.clients[item.id]?.route || "unknown"}
                  </div>
                </div>
                <div className="row">
                  <Badge appearance="outline" color={getClientStatusColor(item.status)}>{item.status}</Badge>
                  <Button size="small" onClick={() => Promise.all(["download", "upload", "preview", "control"].map((role) => p2p?.connectToPeer(item.id, role)))}>全部重连</Button>
                  <Button size="small" onClick={() => changeClientStatus(item.id, "online")}>启用</Button>
                  <Button size="small" onClick={() => changeClientStatus(item.id, "disabled")}>禁用</Button>
                </div>
              </div>
            ))}
            {!clients.length && <Caption1>暂无存储终端数据</Caption1>}
          </div>
        </div>
      </section>
    );
  }

  function renderExplorerPage() {
    return (
      <section className="workspacePage filePanel explorerPanel">
        <div className="explorerShell workspacePageCard">
          <div className="explorerTop">
            <div className="explorerTitleBlock">
              <Subtitle1>资源浏览器</Subtitle1>
              <Caption1>浏览当前目录、切换展示模式并管理目录结构。</Caption1>
            </div>
            <div className="explorerToolbar">
              <div className="toolbarControlGroup">
                <button
                  type="button"
                  className="iconActionButton explorerToolbarButton"
                  title="新建文件夹"
                  aria-label="新建文件夹"
                  onClick={() => openCreateFolderModal()}
                  disabled={!createFolderClientOptions.length}
                >
                  <FolderOpenRegular />
                </button>
                <button
                  type="button"
                  className={`iconActionButton explorerToolbarButton${viewMode === "grid" ? " active" : ""}`}
                  title="图标模式"
                  aria-label="图标模式"
                  onClick={() => setViewMode("grid")}
                >
                  ▦
                </button>
                <button
                  type="button"
                  className={`iconActionButton explorerToolbarButton${viewMode === "details" ? " active" : ""}`}
                  title="列表模式"
                  aria-label="列表模式"
                  onClick={() => setViewMode("details")}
                >
                  ☰
                </button>
                <div className="filterToggleWrap">
                  <button
                    type="button"
                    className={`iconActionButton filterToggleButton${filtersExpanded ? " active" : ""}`}
                    title={filtersExpanded ? "收起筛选与排序" : "展开筛选与排序"}
                    aria-label={filtersExpanded ? "收起筛选与排序" : "展开筛选与排序"}
                    onClick={() => {
                      if (isMobile) { setFilterSheetOpen(true); return; }
                      setFiltersExpanded((prev) => !prev);
                    }}
                  >
                    <FilterRegular />
                  </button>
                  {activeFilterCount > 0 ? <span className="filterToggleBadge">{activeFilterCount}</span> : null}
                </div>
              </div>
            </div>
          </div>

          <div className="explorerPathBar">
            <div className="explorerBreadcrumbs">
              <button
                type="button"
                className={`explorerCrumbButton${!currentExplorerPath ? " current" : ""}`}
                onClick={() => openExplorerFolder("")}
              >
                根目录
              </button>
              {(() => {
                const truncated = isMobile && explorerBreadcrumbs.length > 2;
                const visible = truncated ? explorerBreadcrumbs.slice(-2) : explorerBreadcrumbs;
                return (
                  <>
                    {truncated && (
                      <div className="explorerCrumbItem">
                        <ChevronRightRegular className="explorerCrumbIcon" />
                        <span className="explorerCrumbEllipsis">…</span>
                      </div>
                    )}
                    {visible.map((crumb) => (
                      <div key={crumb.path} className="explorerCrumbItem">
                        <ChevronRightRegular className="explorerCrumbIcon" />
                        <button
                          type="button"
                          className={`explorerCrumbButton${crumb.path === currentExplorerPath ? " current" : ""}`}
                          onClick={() => openExplorerFolder(crumb.path)}
                        >
                          {crumb.label}
                        </button>
                      </div>
                    ))}
                  </>
                );
              })()}
            </div>
            <div className="explorerPathActions">
              <Caption1>{currentExplorerPath || "当前位于根目录"}</Caption1>
              <button
                type="button"
                className="folderEnterButton pathBackButton"
                disabled={!currentExplorerPath}
                onClick={openExplorerParentFolder}
                aria-label="返回上级"
                title="返回上级"
              >
                <ArrowRightRegular />
              </button>
            </div>
          </div>

          {filtersExpanded && (
            <div className="filterPanelShell">
              <div className="filterWorkbench">
                <Field className="filterField filterControl searchField" label="搜索文件">
                  <Input
                    className="filterInput"
                    value={keyword}
                    onChange={(_, data) => setKeyword(data.value)}
                    placeholder="搜索文件名或路径"
                  />
                </Field>
                <Field className="filterField filterControl columnField" label="栏目">
                  <Dropdown className="filterDropdown" selectedOptions={[columnFilter]} value={getColumnDisplayValue(columnFilter)} onOptionSelect={(_, data) => setColumnFilter(data.optionValue || "all")}>
                    <Option value="all">全部栏目</Option>
                    <Option value="none">未分类</Option>
                    {columns.map((col) => (
                      <Option key={col.id} value={col.id}>{col.name}</Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field className="filterField filterControl typeField" label="分类">
                  <Dropdown className="filterDropdown" selectedOptions={[typeFilter]} value={getTypeDropdownValue(typeFilter)} onOptionSelect={(_, data) => setTypeFilter(data.optionValue || "all")}>
                    <Option value="all">全部类型</Option>
                    <Option value="image">图片</Option>
                    <Option value="video">视频</Option>
                    <Option value="audio">音频</Option>
                    <Option value="doc">文档</Option>
                    <Option value="other">其他</Option>
                  </Dropdown>
                </Field>
                <Field className="filterField filterControl sortField" label="排序">
                  <Dropdown className="filterDropdown" selectedOptions={[sortBy]} value={getFileSortDropdownValue(sortBy)} onOptionSelect={(_, data) => setSortBy(data.optionValue || "createdAt")}>
                    {FILE_SORT_OPTIONS.map((item) => (
                      <Option key={item.value} value={item.value}>{item.label}</Option>
                    ))}
                  </Dropdown>
                </Field>
                <div className="filterActionBlock filterMetaBlock">
                  <button
                    type="button"
                    className="iconActionButton filterClearButton"
                    title="清空筛选与排序"
                    aria-label="清空筛选与排序"
                    onClick={() => { setKeyword(""); setColumnFilter("all"); setTypeFilter("all"); setSortBy("createdAt"); }}
                  >
                    <DismissRegular />
                  </button>
                  <Caption1>{activeFilterCount ? `已启用 ${activeFilterCount} 项筛选或排序` : "正在查看全部文件"}</Caption1>
                </div>
              </div>
            </div>
          )}

          {selectedVisibleFiles.length > 0 && (
            <div className="bulkToolbar">
              <div className="bulkToolbarInfo">
                <Text>已选中 {selectedVisibleFiles.length} 项</Text>
                <Caption1>{allVisibleSelected ? "当前结果已全选" : "批量收藏、下载、删除"}</Caption1>
              </div>
              <div className="bulkToolbarActions">
                <Button size="small" onClick={toggleSelectAllVisible}>{allVisibleSelected ? "取消全选" : "全选当前结果"}</Button>
                <Button size="small" onClick={() => setSelectedFileIds([])}>清空选择</Button>
                <Button size="small" onClick={batchToggleFavorite}>{selectedVisibleAllFavorite ? "批量取消收藏" : "批量切换收藏"}</Button>
                <Button size="small" onClick={batchDownload}>批量下载</Button>
                <Button size="small" appearance="primary" onClick={requestBatchDelete}>批量删除</Button>
              </div>
            </div>
          )}

          {viewMode === "details" && (
            <>
              {visibleUploadJobs.length > 0 && (
                <div className="uploadList">
                  {visibleUploadJobs.map((job) => (
                    <div key={job.id} className={`fileRow uploadRow status-${job.status || "uploading"}`}>
                      <div className="thumbFallback">上传</div>
                      <div className="fileMeta">
                        <div className="fileName">{job.fileName || "上传任务"}</div>
                        <div className="fileSub">{job.relativePath} · {getClientDisplayName(job.clientId)} · 发起人: {job.createdByDisplayName || "-"}</div>
                        <div className="uploadProgressBar">
                          <div className="uploadProgressInner" style={{ width: `${Math.max(0, Math.min(100, job.progress || 0))}%` }} />
                        </div>
                        <div className="fileSub">
                          {job.message || "处理中"}
                          {typeof job.progress === "number" ? ` · ${job.progress}%` : ""}
                          {typeof job.transferredBytes === "number" && typeof job.size === "number" && job.size > 0
                            ? ` · ${formatBytes(job.transferredBytes)} / ${formatBytes(job.size)}`
                            : ""}
                        </div>
                      </div>
                      <div className="actions">
                        <button type="button" className="iconActionButton uploadInlineCancel danger" title="取消上传" aria-label="取消上传" onClick={() => cancelUploadJob(job)}>
                          <DismissRegular />
                        </button>
                        <Badge appearance="outline" color="informative">上传中</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div
                className="fileList"
                ref={fileListRef}
                onScroll={(event) => setListScrollTop(event.currentTarget.scrollTop)}
              >
                <div style={{ paddingTop: detailPaddingTop, paddingBottom: detailPaddingBottom }}>
                  {detailSlice.map((entry) => entry.kind === "folder" ? (
                    <div key={entry.key} className="fileRow folderRow" onDoubleClick={() => openExplorerFolder(entry.folder.path)}>
                      <div className="thumbShell">
                        <button className="thumbButton folderThumbButton" onClick={() => openExplorerFolder(entry.folder.path)}>
                          <div className="thumbFallback folderThumbFallback">
                            <FolderOpenRegular className="folderCoverIcon" />
                          </div>
                        </button>
                      </div>
                      <div className="fileMeta">
                        <div className="fileName">{entry.folder.name}</div>
                        <div className="fileSub">
                          {entry.folder.path} · 包含 {entry.folder.fileCount} 个文件 · {formatBytes(entry.folder.totalBytes)}
                        </div>
                        <div className="fileSub">
                          {entry.folder.clientCount > 1 ? `${entry.folder.clientCount} 个终端 · ` : ""}最近更新 {formatRelativeTime(entry.folder.latestCreatedAt)}
                        </div>
                      </div>
                      <div className="actions">
                        {renderFolderActionTray(entry.folder)}
                        <Caption1 className="actionHint">双击目录卡片也可进入</Caption1>
                      </div>
                    </div>
                  ) : (
                    <div key={entry.key} className="fileRow">
                      <VideoHoverPreview file={entry.file} p2p={p2p} enabled={isVideoMime(entry.file.mimeType)}>
                        <div className="thumbShell">
                          <button className="thumbButton" onClick={() => preview(entry.file)}>
                            {thumbMap[getThumbKey(entry.file)]?.url ? <img src={thumbMap[getThumbKey(entry.file)].url} className="thumbImg" /> : <div className="thumbFallback">{isUploadingFile(entry.file) ? "上传中" : isImageMime(entry.file.mimeType) ? "图片" : isVideoMime(entry.file.mimeType) ? "视频" : "文件"}</div>}
                          </button>
                          {renderSelectionToggle(entry.file)}
                        </div>
                      </VideoHoverPreview>
                      <div className="fileMeta">
                        <div className="fileName">{entry.file.name}</div>
                        <div className="fileSub">
                          {entry.file.path} · {formatBytes(entry.file.size)} · {getClientDisplayName(entry.file.clientId)}
                        </div>
                        <div className="fileSub">
                          栏目: {columnMap.get(entry.file.columnId) || "未分类"} · 上传: {formatRelativeTime(getFileCreatedAt(entry.file))}
                        </div>
                      </div>
                      <div className="actions">
                        {renderFileActionTray(entry.file)}
                        <Caption1 className="actionHint">点击缩略图可直接预览</Caption1>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {viewMode === "grid" && (
            <div
              className="fileList fileGridScroller"
              ref={fileListRef}
              onScroll={(event) => setListScrollTop(event.currentTarget.scrollTop)}
            >
              <div className="fileGrid">
                {visibleUploadJobs.map((job) => (
                  <div key={job.id} className="gridItem uploadGridItem">
                    <div className="thumbFallback">上传</div>
                    <div className="gridName" title={job.fileName || "上传任务"}>{job.fileName || "上传任务"}</div>
                    <Caption1>{job.createdByDisplayName || "-"}</Caption1>
                    <Caption1>{getClientDisplayName(job.clientId)}</Caption1>
                    <div className="uploadProgressBar">
                      <div className="uploadProgressInner" style={{ width: `${Math.max(0, Math.min(100, job.progress || 0))}%` }} />
                    </div>
                    <Caption1>上传中 {typeof job.progress === "number" ? `${job.progress}%` : ""}</Caption1>
                    <button type="button" className="iconActionButton uploadGridCancel danger" title="取消上传" aria-label="取消上传" onClick={() => cancelUploadJob(job)}>
                      <DismissRegular />
                    </button>
                  </div>
                ))}
                {currentExplorerEntries.map((entry) => entry.kind === "folder" ? (
                  <div key={entry.key} className="gridItem folderGridItem" onDoubleClick={() => openExplorerFolder(entry.folder.path)}>
                    <button className="gridThumb folderGridThumb" onClick={() => openExplorerFolder(entry.folder.path)}>
                      <div className="thumbFallback folderThumbFallback">
                        <FolderOpenRegular className="folderCoverIcon folderCoverIconLarge" />
                      </div>
                    </button>
                    <div className="gridName" title={entry.folder.name}>{entry.folder.name}</div>
                    <Caption1 className="gridMetaLine" title={entry.folder.path}>{entry.folder.path}</Caption1>
                    <Caption1 className="gridMetaLine">{entry.folder.fileCount} 个文件 · {formatBytes(entry.folder.totalBytes)}</Caption1>
                    <div className="gridCardFooter">
                      {renderFolderActionTray(entry.folder)}
                    </div>
                  </div>
                ) : (
                  <div key={entry.key} className="gridItem">
                    <VideoHoverPreview file={entry.file} p2p={p2p} enabled={isVideoMime(entry.file.mimeType)} className="fileVisualShell">
                      <button className="gridThumb" onClick={() => preview(entry.file)}>
                        {thumbMap[getThumbKey(entry.file)]?.url ? <img src={thumbMap[getThumbKey(entry.file)].url} className="thumbImg" /> : <div className="thumbFallback">{isUploadingFile(entry.file) ? "上传中" : isImageMime(entry.file.mimeType) ? "图片" : isVideoMime(entry.file.mimeType) ? "视频" : "文件"}</div>}
                      </button>
                      {renderSelectionToggle(entry.file)}
                    </VideoHoverPreview>
                    <div className="gridName" title={entry.file.name}>{entry.file.name}</div>
                    <Caption1 className="gridMetaLine">{getClientDisplayName(entry.file.clientId)} · {formatBytes(entry.file.size)}</Caption1>
                    <Caption1 className="gridMetaLine">{columnMap.get(entry.file.columnId) || "未分类"} · {formatRelativeTime(getFileCreatedAt(entry.file))}</Caption1>
                    <div className="gridCardFooter">
                      {renderFileActionTray(entry.file)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!currentExplorerEntries.length && !visibleUploadJobs.length && (
            <Text>{filteredOnlineFiles.length ? "当前目录下暂无内容，可返回上级继续查看。" : "暂无可用文件，等待在线存储终端上报。"}</Text>
          )}
        </div>
      </section>
    );
  }

  const workspaceTabs = [
    { id: "explorer", label: "资源浏览器", icon: <EyeRegular />, meta: `${filteredOnlineFiles.length}` },
    { id: "chat", label: "聊天室", icon: <ChatRegular />, meta: onlineCount ? "live" : "offline" },
    { id: "overview", label: "系统概览", icon: <AppsListRegular />, meta: diagnostics.wsState || "idle" },
    { id: "terminals", label: "终端状态", icon: <DesktopRegular />, meta: `${onlineCount}` },
    { id: "transfers", label: "传输队列", icon: <ArrowSwapRegular />, meta: `${visibleUploadJobs.length + downloadingCount}` },
    { id: "shares", label: "分享管理", icon: <ShareRegular />, meta: `${shares.length}` },
    { id: "tv", label: "TV直播", icon: <StreamRegular />, meta: "live" },
    ...(user?.role === "admin"
      ? [
          { id: "admin-users", label: "用户管理", icon: <EditRegular />, meta: `${users.length}` },
          { id: "admin-clients", label: "终端管理", icon: <DesktopRegular />, meta: `${clients.length}` }
        ]
      : [])
  ];

  function handleWorkspaceTabSelect(tabId) {
    setActiveWorkspaceTab(tabId);
    setNavExpanded(false);
  }

  function closeWorkspaceNav() {
    setNavExpanded(false);
  }

  function renderActiveWorkspacePage() {
    if (activeWorkspaceTab === "chat") {
      return (
        <ChatRoom
          authToken={token}
          currentUser={user}
          clients={clients}
          p2p={p2p}
          setMessage={setMessage}
          getClientDisplayName={getClientDisplayName}
          openMediaPreview={preview}
          saveChatAttachmentToLibrary={saveChatAttachmentToLibrary}
        />
      );
    }
    if (activeWorkspaceTab === "overview") {
      return renderOverviewPage();
    }
    if (activeWorkspaceTab === "terminals") {
      return renderTerminalsPage();
    }
    if (activeWorkspaceTab === "transfers") {
      return renderTransfersPage();
    }
    if (activeWorkspaceTab === "shares") {
      return renderSharesPage();
    }
    if (activeWorkspaceTab === "admin-users") {
      return renderAdminUsersPage();
    }
    if (activeWorkspaceTab === "admin-clients") {
      return renderAdminClientsPage();
    }
    if (activeWorkspaceTab === "tv") {
      return (
        <Suspense fallback={<Spinner size="large" />}>
          <TVStream authToken={token} setMessage={setMessage} />
        </Suspense>
      );
    }
    return renderExplorerPage();
  }

  function closeEditFileModal() {
    setEditFileOpen(false);
    setEditFileDraft(null);
    setEditFileAdvancedOpen(false);
  }

  function closeEditFolderModal() {
    setEditFolderOpen(false);
    setEditFolderDraft(null);
  }

  function openEditFile(file) {
    if (!file) {
      return;
    }
    setEditFileDraft({
      id: file.id,
      clientId: file.clientId,
      currentPath: file.path,
      currentName: file.name,
      fileName: file.name,
      directoryPath: getPathDirectory(file.path),
      columnId: file.columnId || "",
      mimeType: file.mimeType || "application/octet-stream",
      mimePreset: findMimePreset(file.mimeType || "application/octet-stream")?.value || "custom",
      mimeAdvanced: !findMimePreset(file.mimeType || "application/octet-stream")
    });
    setEditFileAdvancedOpen(false);
    setEditFileOpen(true);
  }

  function openEditFolder(folder) {
    if (!folder?.singleClientId) {
      setMessage("该目录当前聚合了多个终端，暂不支持直接重命名，请先缩小到单一终端后再操作", "warning");
      return;
    }
    setEditFolderDraft({
      clientId: folder.singleClientId,
      currentPath: folder.path,
      currentName: folder.name,
      folderName: folder.name,
      parentPath: getPathDirectory(folder.path)
    });
    setEditFolderOpen(true);
  }

  async function submitEditFile() {
    if (!editFileDraft?.clientId || !editFileDraft?.currentPath) {
      return;
    }
    const nextFileName = sanitizeUploadFileName(editFileDraft.fileName, editFileDraft.currentName || "");
    const nextDirectoryPath = normalizeFolderPath(editFileDraft.directoryPath);
    const nextRelativePath = buildUploadTargetPath(nextDirectoryPath, nextFileName);
    const currentRelativePath = editFileDraft.currentPath;
    const renamed = nextRelativePath !== currentRelativePath;
    const nextMimeType = editFileDraft.mimeAdvanced
      ? String(editFileDraft.mimeType || "application/octet-stream").trim() || "application/octet-stream"
      : (editFileDraft.mimePreset && editFileDraft.mimePreset !== "custom"
        ? editFileDraft.mimePreset
        : String(editFileDraft.mimeType || "application/octet-stream").trim() || "application/octet-stream");

    try {
      if (renamed) {
        if (!ensureClientOnline(editFileDraft.clientId)) {
          return;
        }
        if (!(await ensureSignalingReady("control"))) {
          return;
        }
        await p2p.renameFile(editFileDraft.clientId, currentRelativePath, nextRelativePath);
      }

      await apiRequest("/api/files/update", {
        method: "POST",
        token,
        body: {
          clientId: editFileDraft.clientId,
          oldRelativePath: currentRelativePath,
          newRelativePath: nextRelativePath,
          columnId: editFileDraft.columnId || "",
          folderPath: nextDirectoryPath,
          mimeType: nextMimeType
        }
      });
      closeEditFileModal();
      await refreshAll();
      setMessage("文件信息已更新", "success");
    } catch (error) {
      setMessage(`更新文件失败: ${error.message}`);
    }
  }

  async function submitEditFolder() {
    if (!editFolderDraft?.clientId || !editFolderDraft?.currentPath) {
      return;
    }
    const nextFolderName = String(editFolderDraft.folderName || "").trim();
    if (!nextFolderName || nextFolderName === "." || nextFolderName === ".." || /[\\/]/.test(nextFolderName)) {
      setMessage("请输入合法的文件夹名称");
      return;
    }
    const nextRelativePath = normalizeFolderPath(editFolderDraft.parentPath ? `${editFolderDraft.parentPath}/${nextFolderName}` : nextFolderName);
    if (!nextRelativePath || nextRelativePath === editFolderDraft.currentPath) {
      closeEditFolderModal();
      return;
    }

    try {
      if (!ensureClientOnline(editFolderDraft.clientId)) {
        return;
      }
      if (!(await ensureSignalingReady("control"))) {
        return;
      }
      await p2p.renameFolder(editFolderDraft.clientId, editFolderDraft.currentPath, nextRelativePath);
      closeEditFolderModal();
      await refreshAll();
      setMessage("文件夹已重命名", "success");
    } catch (error) {
      setMessage(`重命名文件夹失败: ${error.message}`);
    }
  }

  async function submitCreateFolder() {
    const clientId = String(createFolderDraft.clientId || "").trim();
    const folderName = String(createFolderDraft.folderName || "").trim();
    if (!clientId) {
      setMessage("请选择要创建目录的存储终端");
      return;
    }
    if (!folderName) {
      setMessage("请输入文件夹名称");
      return;
    }
    if (folderName === "." || folderName === ".." || /[\\/]/.test(folderName)) {
      setMessage("文件夹名称不能包含斜杠，且不能是 . 或 ..");
      return;
    }
    const targetPath = normalizeFolderPath(createFolderContext.basePath ? `${createFolderContext.basePath}/${folderName}` : folderName);
    if (!targetPath) {
      setMessage("文件夹路径无效");
      return;
    }
    const alreadyExists = directories.some((directory) => directory.clientId === clientId && normalizeFolderPath(directory.path) === targetPath);
    if (alreadyExists) {
      setMessage("该文件夹已存在", "warning");
      return;
    }

    try {
      setCreateFolderSaving(true);
      if (!ensureClientOnline(clientId)) {
        return;
      }
      if (!(await ensureSignalingReady("control"))) {
        return;
      }
      await p2p.createFolder(clientId, targetPath);
      closeCreateFolderModal(true);
      if (createFolderContext.source === "upload") {
        setUploadFolderPath(normalizeFolderPath(createFolderContext.uploadFolderBasePath ? `${createFolderContext.uploadFolderBasePath}/${folderName}` : folderName));
      }
      await refreshAll();
      if (createFolderContext.source === "explorer") {
        openExplorerFolder(createFolderContext.basePath);
      }
      setMessage(`文件夹已创建: ${targetPath}`, "success");
    } catch (error) {
      setMessage(`创建文件夹失败: ${error.message}`);
    } finally {
      setCreateFolderSaving(false);
    }
  }

  function requestFolderDelete(folder) {
    if (!folder?.singleClientId) {
      setMessage("该目录当前聚合了多个终端，暂不支持直接删除，请先缩小到单一终端后再操作", "warning");
      return;
    }
    setDeleteStep(1);
    setDeleteTarget({ kind: "folder", folders: [folder] });
  }

  function dismissToast(id) {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }

  function resolveToastIntent(text, intent) {
    if (intent !== "info") {
      return intent;
    }
    if (/失败|错误|不可用|超时/i.test(text)) {
      return "error";
    }
    if (/成功|完成|已就绪|已复制|已处理|已触发/i.test(text)) {
      return "success";
    }
    if (/取消|排队|稍候|不在线|不支持|未开始|未选择|请输入|上传中/i.test(text)) {
      return "warning";
    }
    return "info";
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const setMessage = useCallback((text, intent = "info") => {
    if (!text) {
      return;
    }
    const nextIntent = resolveToastIntent(text, intent);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev.slice(-3), { id, text, intent: nextIntent }]);
    const timer = setTimeout(() => dismissToast(id), nextIntent === "error" ? 5600 : 3600);
    toastTimersRef.current.set(id, timer);
  }, []);

  function ensureClientOnline(clientId) {
    const client = clients.find((item) => item.id === clientId);
    if (!client || client.status !== "online") {
      setMessage("目标存储终端当前不在线，请先启动 storage-client 并刷新列表");
      return false;
    }
    return true;
  }

  function getClientDisplayName(clientId) {
    if (!clientId || typeof clientId !== "string") {
      return "终端-未知";
    }
    const client = clients.find((item) => item.id === clientId);
    const name = (client?.name || "").trim();
    if (!name || name === clientId) {
      return `终端-${clientId.slice(0, 6)}`;
    }
    return name;
  }

  function clearPreview() {
    if (previewReleaseRef.current) {
      previewReleaseRef.current();
      previewReleaseRef.current = null;
    } else if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewUrl("");
    setPreviewMime("");
    setPreviewName("");
    setPreviewPath("");
    setPreviewClientId("");
    setPreviewStatusText("");
    setPreviewProgress(null);
    setPreviewHlsSource(null);
    setPreviewDebug(emptyPreviewDebug());
    setPreviewStage("");
    previewModeRef.current = "";
    previewFirstFrameRef.current = false;
    previewAutoFallbackRef.current = "";
    previewHlsFallbackRef.current = "";
  }

  function stopActivePreviewSession() {
    previewSessionIdRef.current++;
    if (p2p && previewClientId) {
      p2p.cancelClientChannel(previewClientId, "preview");
    }
    clearPreview();
    setPreviewOpen(false);
  }

  useEffect(() => {
    if (!previewOpen || previewing) {
      return;
    }
    if (!previewUrl || !previewMime.startsWith("video/")) {
      return;
    }
    if (previewModeRef.current !== "direct-stream") {
      return;
    }

    const key = `${previewClientId}|${previewPath}`;
    if (!key || previewAutoFallbackRef.current === key) {
      return;
    }

    const timer = setTimeout(async () => {
      if (previewModeRef.current !== "direct-stream") {
        return;
      }
      if (previewFirstFrameRef.current) {
        return;
      }
      if (previewAutoFallbackRef.current === key) {
        return;
      }
      previewAutoFallbackRef.current = key;

      const target = files.find((item) => item.clientId === previewClientId && item.path === previewPath);
      if (!target) {
        return;
      }

      setPreviewStatusText("首帧超时，正在切换转码预览...");
      setPreviewProgress(0);
      await preview(target, { forceTranscode: true });
    }, PREVIEW_FIRST_FRAME_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [previewOpen, previewing, previewUrl, previewMime, previewClientId, previewPath, files]);

  useEffect(() => {
    if (!previewOpen || previewing) {
      return;
    }
    if (!previewMime.startsWith("video/")) {
      return;
    }
    if (previewModeRef.current !== "hls-stream") {
      return;
    }

    const key = `${previewClientId}|${previewPath}`;
    if (!key || previewHlsFallbackRef.current === key) {
      return;
    }

    const timer = setTimeout(async () => {
      if (previewModeRef.current !== "hls-stream") {
        return;
      }
      if (previewFirstFrameRef.current) {
        return;
      }
      if (previewHlsFallbackRef.current === key) {
        return;
      }

      const target = files.find((item) => item.clientId === previewClientId && item.path === previewPath);
      if (!target) {
        return;
      }

      previewHlsFallbackRef.current = key;
      setPreviewStatusText("HLS 首帧超时，自动切换直连转码预览...");
      setPreviewProgress(0);
      await preview(target, { forceTranscode: true, skipHls: true });
    }, PREVIEW_HLS_STALL_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [previewOpen, previewing, previewMime, previewClientId, previewPath, files]);

  function upsertUploadJob(job) {
    if (!job?.id) {
      return;
    }
    setUploadJobs((prev) => {
      const idx = prev.findIndex((item) => item.id === job.id);
      if (idx === -1) {
        return [{ speedBytesPerSec: 0, lastProgressAt: Date.now(), ...job }, ...prev].slice(0, 120);
      }
      const next = [...prev];
      const merged = { ...next[idx], ...job };
      if (merged.status === "uploading") {
        merged.progress = Math.max(next[idx].progress || 0, merged.progress || 0);
        merged.transferredBytes = Math.max(next[idx].transferredBytes || 0, merged.transferredBytes || 0);
        if (typeof job.transferredBytes === "number") {
          const now = Date.now();
          const deltaBytes = merged.transferredBytes - (next[idx].transferredBytes || 0);
          const deltaMs = now - (next[idx].lastProgressAt || now);
          merged.speedBytesPerSec = deltaBytes > 0 && deltaMs > 0
            ? Math.round(deltaBytes / (deltaMs / 1000))
            : (next[idx].speedBytesPerSec || 0);
          merged.lastProgressAt = now;
        }
      }
      next[idx] = merged;
      return next;
    });
  }

  async function saveChatAttachmentToLibrary(attachment, options = {}) {
    if (!p2p || !attachment?.clientId || !attachment?.path) {
      setMessage("当前附件无法转存", "error");
      return;
    }
    const sourceClientId = attachment.clientId;
    const targetClientId = uploadClientId || attachment.clientId;
    const folderPath = normalizeFolderPath(options.preferredFolderPath || uploadFolderPath || "chat-saved");
    const columnName = columnMap.get(uploadColumnId) || "";
    const basePath = normalizeFolderPath([columnName, folderPath].filter(Boolean).join("/"));
    const uploadName = sanitizeUploadFileName(options.preferredName || attachment.name, attachment.name || "attachment.bin");
    const targetPath = buildUploadTargetPath(basePath, uploadName);

    if (!ensureClientOnline(sourceClientId) || !ensureClientOnline(targetClientId)) {
      return;
    }
    if (!(await ensureSignalingReady("download")) || !(await ensureSignalingReady("upload"))) {
      return;
    }

    let jobId = "";
    try {
      setMessage(`正在转存 ${uploadName}...`);
      const downloadResult = await p2p.downloadFile(sourceClientId, attachment.path);
      const blob = downloadResult?.blob;
      if (!blob) {
        throw new Error("读取附件失败");
      }
      const file = new File([blob], uploadName, { type: downloadResult?.meta?.mimeType || attachment.mimeType || blob.type || "application/octet-stream" });
      const started = await apiRequest("/api/upload-jobs/start", {
        method: "POST",
        token,
        body: {
          clientId: targetClientId,
          fileName: uploadName,
          relativePath: targetPath,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
          columnId: uploadColumnId || "",
          folderPath: folderPath || ""
        }
      });
      if (started?.job) {
        jobId = started.job.id;
        activeLocalUploadJobIds.current.add(jobId);
        upsertUploadJob(started.job);
      }
      await p2p.uploadFile(targetClientId, targetPath, file, {
        uploadName,
        onProgress: ({ transferredBytes, progress }) => {
          if (!jobId) {
            return;
          }
          upsertUploadJob({
            id: jobId,
            clientId: targetClientId,
            relativePath: targetPath,
            fileName: uploadName,
            size: file.size,
            transferredBytes,
            progress,
            status: "uploading"
          });
        }
      });
      if (jobId) {
        const finished = await apiRequest(`/api/upload-jobs/${jobId}/finish`, {
          method: "POST",
          token,
          body: { message: "转存完成，等待资源列表刷新" }
        });
        if (finished?.job) {
          upsertUploadJob(finished.job);
        }
        upsertUploadJob({
          id: jobId,
          clientId: targetClientId,
          relativePath: targetPath,
          fileName: uploadName,
          size: file.size,
          transferredBytes: file.size,
          progress: 100,
          status: "completed"
        });
      }
      await refreshAll();
      const appeared = await waitForFileToAppear(targetClientId, targetPath);
      if (!appeared) {
        await refreshAll();
      }
      setMessage("已转存到资源列表", "success");
    } catch (error) {
      if (jobId) {
        upsertUploadJob({ id: jobId, status: "failed", error: error?.message || "转存失败" });
      }
      setMessage(error?.message || "转存到资源列表失败", "error");
    } finally {
      if (jobId) {
        activeLocalUploadJobIds.current.delete(jobId);
      }
    }
  }

  function getTransferDiag(clientId, kind) {
    if (!clientId || typeof clientId !== "string") {
      return {};
    }
    const diag = diagnostics.clients[clientId] || {};
    const role = kind === "download" ? "download" : kind === "upload" ? "upload" : "";
    if (!role) {
      return diag;
    }
    return diag.peers?.[role] || diag;
  }

  function renderTransferQueueRow(job, kind) {
    const safeJob = job || {};
    const diag = getTransferDiag(safeJob.clientId, kind);
    const routeLabel = getRouteLabel(diag);
    const speed = kind === "download" ? safeJob.speedBytesPerSec : (safeJob.speedBytesPerSec || 0);
    const progress = Math.max(0, Math.min(100, safeJob.progress || 0));
    const subStatus = kind === "download" ? "下载中" : "上传中";
    const extraMode = kind === "download"
      ? (safeJob.mode === "direct-save" ? "直存" : safeJob.mode === "mobile" ? "移动端" : "浏览器")
      : "P2P 上传";
    const targetPath = safeJob.path || safeJob.relativePath || "-";
    return (
      <div key={`${kind}-${safeJob.id || safeJob.relativePath || safeJob.fileName || "unknown"}`} className={`miniListRow queueRow transferQueueRow ${kind === "download" ? "downloadTransferRow" : "uploadTransferRow"}`}>
        <div className="miniListMain">
          <div className="transferQueueHeader">
            <div className="transferQueueTitleBlock">
              <Text className="miniListTitle transferQueueTitle" title={safeJob.fileName || safeJob.relativePath}>{safeJob.fileName || `${kind === "download" ? "下载" : "上传"}任务`}</Text>
              <Caption1 className="transferQueuePath" title={targetPath}>{targetPath}</Caption1>
            </div>
            <div className="transferQueueBadges">
              <Badge appearance="outline" color={kind === "download" ? "informative" : "success"}>{subStatus}</Badge>
              <Badge appearance="outline" color="informative">{typeof safeJob.progress === "number" ? `${safeJob.progress}%` : "-"}</Badge>
            </div>
          </div>
          <div className="transferQueueFacts">
            <Caption1>{getClientDisplayName(safeJob.clientId)}</Caption1>
            <Caption1>{typeof safeJob.transferredBytes === "number" && typeof safeJob.size === "number" && safeJob.size > 0
              ? `${formatBytes(safeJob.transferredBytes)} / ${formatBytes(safeJob.size)}`
              : formatBytes(safeJob.transferredBytes || 0)}</Caption1>
            <Caption1>{formatSpeed(speed)}</Caption1>
            <Caption1>{extraMode}</Caption1>
          </div>
          <div className="transferQueueFacts detail">
            <Caption1>{routeLabel}</Caption1>
            <Caption1>候选 {diag.localCandidateType || "-"} {"->"} {diag.remoteCandidateType || "-"}</Caption1>
            <Caption1>下行 {formatSpeed(diag.currentRecvBps || 0)}</Caption1>
            <Caption1>上行 {formatSpeed(diag.currentSendBps || 0)}</Caption1>
          </div>
          <div className="uploadProgressBar">
            <div className="uploadProgressInner" style={{ width: `${progress}%` }} />
          </div>
        </div>
        {kind === "download" ? (
          <button type="button" className="iconActionButton queueIconButton danger" title="取消下载" aria-label="取消下载" onClick={() => cancelDownloadJob(safeJob)}>
            <DismissRegular />
          </button>
        ) : (
          <button type="button" className="iconActionButton queueIconButton danger" title="取消上传" aria-label="取消上传" onClick={() => cancelUploadJob(safeJob)}>
            <DismissRegular />
          </button>
        )}
      </div>
    );
  }

  function renderPeerDiagnosticCard(clientId, role, diag) {
    const roleDiag = getPeerRoleDiagnostics(diag, role);
    const routeLabel = roleDiag.routeLabel || roleDiag.route || "idle";
    const connectionState = roleDiag.connectionState || roleDiag.iceState || "idle";
    return (
      <div key={`${clientId}-${role}`} className="diagRoleCard">
        <div className="diagRoleHeader">
          <div>
            <Caption1>{getPeerRoleLabel(role)}</Caption1>
            <Text>{routeLabel}</Text>
            <Caption1>{connectionState}</Caption1>
          </div>
          <div className="row">
            <Button size="small" onClick={() => p2p?.connectToPeer(clientId, role)}>重连</Button>
            <Button size="small" onClick={() => p2p?.closePeer(clientId, true, role)}>断开</Button>
          </div>
        </div>
        <div className="diagRoleMetrics">
          <Caption1>候选: {roleDiag.localCandidateType || "-"} {"->"} {roleDiag.remoteCandidateType || "-"}</Caption1>
          <Caption1>下行吞吐: {formatSpeed(roleDiag.currentRecvBps || 0)}</Caption1>
          <Caption1>上行吞吐: {formatSpeed(roleDiag.currentSendBps || 0)}</Caption1>
          <Caption1>累计接收: {formatBytes(roleDiag.totalBytesReceived || 0)}</Caption1>
          <Caption1>累计发送: {formatBytes(roleDiag.totalBytesSent || 0)}</Caption1>
          <Caption1>重试: {roleDiag.retries || 0}</Caption1>
        </div>
        {roleDiag.lastError ? <Caption1>最近错误: {roleDiag.lastError}</Caption1> : null}
      </div>
    );
  }

  async function refreshAll(currentToken = token) {
    if (!currentToken) return;
    setLoading(true);
    try {
      const me = await apiRequest("/api/me", { token: currentToken });
      setUser(me.profile);

      const [fileData, clientsData, uploadData, shareData] = await Promise.all([
        apiRequest("/api/files", { token: currentToken }),
        apiRequest("/api/clients", { token: currentToken }),
        apiRequest("/api/upload-jobs", { token: currentToken }),
        apiRequest("/api/shares", { token: currentToken })
      ]);

      setFiles(sortFiles(fileData.files || [], sortBy || "createdAt"));
      setDirectories(fileData.directories || []);
      setClients(clientsData.clients);
      replaceUploadJobs(uploadData.jobs || []);
      setShares(shareData.shares || []);
      setLastRefreshAt(new Date().toISOString());

      const columnData = await apiRequest("/api/columns", { token: currentToken });
      setColumns(columnData.columns || []);
      if (uploadColumnId && !(columnData.columns || []).some((item) => item.id === uploadColumnId)) {
        setUploadColumnId("");
      }

      if (!uploadClientId && clientsData.clients.length) {
        setUploadClientId(clientsData.clients[0].id);
      }

      if (me.profile.role === "admin") {
        const [usersData, adminClientsData] = await Promise.all([
          apiRequest("/api/admin/users", { token: currentToken }),
          apiRequest("/api/admin/clients", { token: currentToken })
        ]);
        setUsers(usersData.users);
        setClients(adminClientsData.clients);
      }
    } catch (error) {
      setMessage(`刷新数据失败: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }
  async function waitForFileToAppear(targetClientId, targetPath, options = {}) {
    const currentToken = options.currentToken || token;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
    const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 600;
    if (!currentToken || !targetClientId || !targetPath) {
      return false;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const fileData = await apiRequest("/api/files", { token: currentToken });
      setFiles(sortFiles(fileData.files || [], sortBy || "createdAt"));
      setDirectories(fileData.directories || []);
      setLastRefreshAt(new Date().toISOString());
      const found = (fileData.files || []).some((file) => file.clientId === targetClientId && file.path === targetPath);
      if (found) {
        return true;
      }
      await sleep(intervalMs);
    }

    return false;
  }

  useEffect(() => {
    refreshAll();
  }, [token]);

  // 大屏页「↗ 主页预览」跳回时自动打开 PreviewModal
  useEffect(() => {
    const launch = mainToPreviewLaunchRef.current;
    if (!launch || !p2p || !files.length) return;
    const file = files.find((f) => f.id === launch.fileId);
    if (!file) return;
    mainToPreviewLaunchRef.current = null; // 消费，防止重复触发
    preview(file);
  }, [p2p, files]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!token) return;
    let consecutiveErrors = 0;
    let timer;
    const poll = async () => {
      try {
        const [clientsData, uploadData, fileData] = await Promise.all([
          apiRequest("/api/clients", { token }),
          apiRequest("/api/upload-jobs", { token }),
          apiRequest("/api/files", { token })
        ]);
        setClients(clientsData.clients);
        replaceUploadJobs(uploadData.jobs || []);
        setFiles(sortFiles(fileData.files || [], sortBy || "createdAt"));
        setDirectories(fileData.directories || []);
        setLastPollAt(new Date().toISOString());
        consecutiveErrors = 0;
      } catch {
        consecutiveErrors++;
      }
      const delay = consecutiveErrors > 0
        ? Math.min(30000, 5000 * Math.pow(1.5, consecutiveErrors - 1))
        : 5000;
      timer = setTimeout(poll, delay);
    };
    timer = setTimeout(poll, 5000);
    return () => clearTimeout(timer);
  }, [sortBy, token]);

  useEffect(() => {
    if (!p2p) {
      setDiagnostics({ wsState: "idle", clients: {} });
      return;
    }
    p2p.setDiagnosticsListener((snapshot) => {
      setDiagnostics(snapshot);
    });
    return () => {
      p2p.setDiagnosticsListener(null);
    };
  }, [p2p]);

  useEffect(() => {
    const el = fileListRef.current;
    if (!el) {
      setListHeight(520);
      setListScrollTop(0);
      return;
    }

    const updateHeight = () => {
      const nextHeight = el.clientHeight || 520;
      setListHeight(nextHeight);
      setListScrollTop(el.scrollTop || 0);
    };

    updateHeight();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => updateHeight());
      observer.observe(el);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", updateHeight);
    return () => window.removeEventListener("resize", updateHeight);
  }, [viewMode]);

  useEffect(() => {
    const onResize = () => setIsMobileViewport(window.innerWidth <= 760);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!p2p) return;
    if (!clients.length) return;
    if (previewing) return;
    const mediaFiles = files
      .filter((file) => {
        if (isUploadingFile(file)) {
          return false;
        }
        return isImageMime(file.mimeType) || isVideoMime(file.mimeType);
      })
      .filter((file) => clients.find((item) => item.id === file.clientId)?.status === "online")
      .slice(0, 12);

    mediaFiles.forEach((file) => {
      const thumbKey = getThumbKey(file);
      if (!thumbMap[thumbKey] && !thumbnailLoading.current.has(thumbKey)) {
        ensureThumbnail(file);
      }
    });
  }, [files, clients, p2p, previewing, thumbMap, uploadingFileKeys]);

  useEffect(() => {
    if (viewMode !== "details") {
      return;
    }
    setListScrollTop(0);
    if (fileListRef.current) {
      fileListRef.current.scrollTop = 0;
    }
  }, [viewMode, currentExplorerPath, currentExplorerEntries.length]);

  useEffect(() => {
    setSelectedFileIds((prev) => prev.filter((id) => onlineFiles.some((file) => file.id === id)));
  }, [onlineFiles]);

  useEffect(() => {
    if (!uploadOpen) {
      setUploadStep(1);
      setUploadAdvancedOpen(false);
    }
  }, [uploadOpen]);

  async function login() {
    try {
      const data = await apiRequest("/api/auth/login", {
        method: "POST",
        body: { email, password }
      });
      localStorage.setItem("nas_token", data.token);
      setToken(data.token);
      setMessage("登录成功");
    } catch (error) {
      setMessage(`登录失败: ${error.message}`);
    }
  }

  async function register() {
    try {
      const data = await apiRequest("/api/auth/register", {
        method: "POST",
        body: { email, password, displayName }
      });
      localStorage.setItem("nas_token", data.token);
      setToken(data.token);
      setMessage("注册成功");
    } catch (error) {
      setMessage(`注册失败: ${error.message}`);
    }
  }

  async function toggleFavorite(fileId) {
    await apiRequest(`/api/favorites/${encodeURIComponent(fileId)}`, {
      method: "POST",
      token
    });
    await refreshAll();
  }

  function openShareDialog(file) {
    setShareTarget(file || null);
    setShareExpiryDays("7");
    setShareHistoryOpen(false);
    setShareDialogOpen(true);
  }

  function closeShareDialog() {
    setShareDialogOpen(false);
    setShareTarget(null);
    setShareExpiryDays("7");
    setShareHistoryOpen(false);
  }

  async function copyShareUrl(shareUrl) {
    const copied = await copyText(shareUrl);
    if (copied) {
      setMessage("分享链接已复制到剪贴板", "success");
    } else {
      setMessage(`分享链接: ${shareUrl}`);
    }
  }

  async function revokeShare(shareId) {
    if (!shareId) {
      return;
    }
    try {
      await apiRequest(`/api/shares/${encodeURIComponent(shareId)}/revoke`, {
        method: "POST",
        token
      });
      setMessage("分享链接已撤销", "success");
      await refreshAll();
    } catch (error) {
      setMessage(`撤销分享失败: ${error.message}`);
    }
  }

  async function deleteShare(shareId) {
    if (!shareId) {
      return;
    }
    try {
      await apiRequest(`/api/shares/${encodeURIComponent(shareId)}`, {
        method: "DELETE",
        token
      });
      setShares((prev) => prev.filter((item) => item.id !== shareId));
      setMessage("分享记录已删除", "success");
    } catch (error) {
      setMessage(`删除分享失败: ${error.message}`);
    }
  }

  async function shareFile(file = shareTarget) {
    if (!file || shareLoading) return;
    setShareLoading(true);
    try {
      const expiresInDays = Number(shareExpiryDays || 0);
      const { share, shareUrl } = await apiRequest(`/api/files/${encodeURIComponent(file.id)}/share`, {
        method: "POST",
        token,
        body: {
          expiresInDays: expiresInDays > 0 ? expiresInDays : null
        }
      });
      if (share?.id) {
        setShares((prev) => [share, ...prev.filter((item) => item.id !== share.id)]);
      }
      await copyShareUrl(shareUrl);
    } catch (error) {
      setMessage(`生成分享链接失败: ${error.message}`);
    } finally {
      setShareLoading(false);
    }
  }

  async function createColumn() {
    const name = columnDraftName.trim();
    if (!name) {
      setMessage("请输入栏目名称");
      return;
    }
    try {
      const result = await apiRequest("/api/columns", {
        method: "POST",
        token,
        body: { name }
      });
      const next = result.column;
      if (next?.id) {
        setColumns((prev) => [next, ...prev.filter((item) => item.id !== next.id)]);
        setUploadColumnId(next.id);
        setColumnDraftName("");
      }
    } catch (error) {
      setMessage(`创建栏目失败: ${error.message}`);
    }
  }

  async function ensureThumbnail(file) {
    if (isUploadingFile(file)) {
      return;
    }
    const thumbKey = getThumbKey(file);
    const isOnline = clients.find((item) => item.id === file.clientId)?.status === "online";
    if (!p2p || !isOnline || thumbMap[thumbKey] || thumbnailLoading.current.has(thumbKey)) {
      return;
    }

    const cached = thumbnailCache.current[thumbKey]?.dataUrl;
    if (cached) {
      setThumbMap((prev) => ({ ...prev, [thumbKey]: { url: cached, persisted: true } }));
      return;
    }

    thumbnailLoading.current.add(thumbKey);
    try {
      const result = await p2p.thumbnailFile(file.clientId, file.path);
      let thumbUrl = URL.createObjectURL(result.blob);
      let persisted = false;

      if (result.blob.size <= THUMB_CACHE_MAX_BLOB_SIZE) {
        try {
          const dataUrl = await blobToDataUrl(result.blob);
          thumbUrl = dataUrl;
          persisted = true;
          thumbnailCache.current[thumbKey] = {
            dataUrl,
            updatedAt: Date.now()
          };
          thumbnailCache.current = pruneThumbCache(thumbnailCache.current);
          saveThumbCache(thumbnailCache.current);
        } catch {
        }
      }

      if (isImageMime(file.mimeType) || isVideoMime(file.mimeType)) {
        setThumbMap((prev) => ({ ...prev, [thumbKey]: { url: thumbUrl, persisted } }));
      }
      thumbnailRetry.current[thumbKey] = 0;
    } catch {
      const retried = thumbnailRetry.current[thumbKey] || 0;
      if (retried < 8) {
        thumbnailRetry.current[thumbKey] = retried + 1;
        setTimeout(() => ensureThumbnail(file), Math.min(15000, 1800 + retried * 1200));
      }
    } finally {
      thumbnailLoading.current.delete(thumbKey);
    }
  }

  async function forceRefreshThumbnail(file) {
    if (!p2p || isUploadingFile(file)) return;
    const key = getThumbKey(file);
    const isOnline = clients.find((c) => c.id === file.clientId)?.status === "online";
    if (!isOnline) return;
    // 询问用户是否指定封面帧时间点
    const raw = window.prompt("输入封面时间点（秒），留空则自动选帧", "");
    if (raw === null) return; // 取消
    const parsedSec = raw.trim() === "" ? null : Number(raw.trim());
    if (parsedSec !== null && !Number.isFinite(parsedSec)) {
      window.alert("请输入有效数字（秒）"); return;
    }
    const thumbnailOptions = { force: true, ...(parsedSec != null ? { seekSeconds: parsedSec } : {}) };
    // 清理本地缓存，让重新生成的封面能刷新到界面
    delete thumbnailCache.current[key];
    thumbnailLoading.current.delete(key);
    thumbnailRetry.current[key] = 0;
    setThumbMap((prev) => { const next = { ...prev }; delete next[key]; return next; });
    saveThumbCache(thumbnailCache.current);
    thumbnailLoading.current.add(key);
    try {
      // force: true 让终端删除旧缓存文件并用 ffmpeg 重新生成
      const result = await p2p.thumbnailFile(file.clientId, file.path, thumbnailOptions);
      let thumbUrl = URL.createObjectURL(result.blob);
      let persisted = false;
      if (result.blob.size <= THUMB_CACHE_MAX_BLOB_SIZE) {
        try {
          const dataUrl = await blobToDataUrl(result.blob);
          thumbUrl = dataUrl;
          persisted = true;
          thumbnailCache.current[key] = { dataUrl, updatedAt: Date.now() };
          thumbnailCache.current = pruneThumbCache(thumbnailCache.current);
          saveThumbCache(thumbnailCache.current);
        } catch { }
      }
      if (isImageMime(file.mimeType) || isVideoMime(file.mimeType)) {
        setThumbMap((prev) => ({ ...prev, [key]: { url: thumbUrl, persisted } }));
      }
    } catch { } finally {
      thumbnailLoading.current.delete(key);
    }
  }

  async function ensureSignalingReady(role) {
    if (!p2p) {
      return false;
    }
    if (p2p.isSocketOpen(role)) {
      return true;
    }
    setMessage(role ? `${getPeerRoleLabel(role)} 信令未就绪，正在建立连接...` : "信令连接已断开，正在重连...");
    try {
      await p2p.ensureSocketOpen(role);
      return true;
    } catch {
      setMessage("信令连接不可用，请确认 server 正在运行并稍后重试");
      return false;
    }
  }

  async function download(file) {
    if (!p2p || !ensureClientOnline(file.clientId)) return;
    if (!(await ensureSignalingReady("download"))) return;
    const jobId = getDownloadJobId(file);
    const onStart = ({ requestId, channelName }) => {
      upsertDownloadJob(file, {
        requestId,
        channelName: channelName || "file"
      });
    };
    const onMeta = (meta) => {
      upsertDownloadJob(file, {
        size: Number(meta?.size || file.size || 0),
        progress: 0
      });
    };
    const onProgress = ({ transferredBytes, totalBytes, progress }) => {
      upsertDownloadJob(file, {
        size: Number(totalBytes || file.size || 0),
        transferredBytes: Number(transferredBytes || 0),
        progress: typeof progress === "number" ? progress : undefined
      });
    };
    try {
      const mobileBrowser = isMobileBrowser();
      const preferDesktopDirectSave = !mobileBrowser
        && Number(file.size || 0) >= DESKTOP_STREAM_SAVE_THRESHOLD_BYTES
        && typeof window.showSaveFilePicker === "function"
        && typeof p2p.downloadFileStream === "function";

      if (preferDesktopDirectSave) {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: file.name });
          const writable = await handle.createWritable();
          upsertDownloadJob(file, { mode: "direct-save", progress: 0, transferredBytes: 0, size: Number(file.size || 0) });
          setMessage("正在建立P2P连接并直接写入文件...");
          await p2p.downloadFileStream(file.clientId, file.path, { writable, onStart, onMeta, onProgress });
          removeDownloadJob(jobId);
          setMessage("下载完成（已直接写入本地）", "success");
          return;
        } catch (error) {
          removeDownloadJob(jobId);
          if (error?.name === "AbortError") {
            setMessage("已取消保存");
            return;
          }
          setMessage("直存失败，回退浏览器下载...", "warning");
        }
      }

      upsertDownloadJob(file, { mode: mobileBrowser ? "mobile" : "browser", progress: 0, transferredBytes: 0, size: Number(file.size || 0) });
      setMessage("正在建立P2P连接并下载...");
  const result = await p2p.downloadFile(file.clientId, file.path, { onStart, onMeta, onProgress });

      if (mobileBrowser) {
        try {
          const shared = await tryShareDownloadedFile(result.blob, file.name, result.meta?.mimeType || file.mimeType);
          if (shared) {
            removeDownloadJob(jobId);
            setMessage("已打开系统分享/存储面板", "success");
            return;
          }
        } catch (error) {
          removeDownloadJob(jobId);
          if (error?.name === "AbortError") {
            setMessage("已取消保存");
            return;
          }
        }
      }

      if (supportsAnchorDownload()) {
        triggerBrowserDownload(result.blob, file.name);
        removeDownloadJob(jobId);
        setMessage(mobileBrowser ? "文件已交给浏览器处理" : "浏览器下载已开始", "success");
        return;
      }

      removeDownloadJob(jobId);
      throw new Error("当前浏览器不支持标准下载或文件直存");
    } catch (error) {
      removeDownloadJob(jobId);
      if (error?.cancelled || /cancelled|operation cancelled|已取消/i.test(error?.message || "")) {
        setMessage(`已取消下载: ${file.name}`, "warning");
        return;
      }
      setMessage(`下载失败: ${error.message}`);
    }
  }

  async function preview(file, options = {}) {
    if (!p2p || !ensureClientOnline(file.clientId)) return;
    if (!(await ensureSignalingReady("preview"))) return;
    const sessionId = ++previewSessionIdRef.current;

    if (previewClientId && previewClientId !== file.clientId) {
      p2p.cancelClientChannel(previewClientId, "preview");
    }
    p2p.cancelClientChannel(file.clientId, "preview");

    if (p2p.isClientBusy(file.clientId, "preview")) {
      setMessage("目标终端正在处理其他任务，预览已排队，请稍候...");
    }

    const needTranscode = !!options.forceTranscode || (isVideoMime(file.mimeType) && !canBrowserPlayVideoMime(file.mimeType));

    if (!isInlinePreviewMime(file.mimeType)) {
      clearPreview();
      setPreviewName(file.name);
      setPreviewMime(file.mimeType);
      setPreviewPath(file.path);
      setPreviewClientId(file.clientId);
      setPreviewOpen(true);
      setMessage("该文件类型暂不支持在线预览，请使用下载");
      return;
    }

    try {
      setPreviewing(true);
      setPreviewOpen(true);
      setPreviewProgress(null);
      setPreviewStatusText("");
      setPreviewStage("连接终端");
      setMessage("正在获取预览...");
      previewFirstFrameRef.current = false;
      previewModeRef.current = "";
      clearPreview();

      let url = "";
      let mimeType = file.mimeType;

      const withTimeout = (promise, ms) =>
        Promise.race([
          promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("预览超时，请检查诊断信息（ICE/relay）")), ms))
        ]);

      const sizeBasedTimeoutMs = Math.min(
        12 * 60 * 1000,
        Math.max(90_000, Math.ceil(Number(file.size || 0) / (1024 * 1024)) * 1200)
      );
      const fallbackDownloadTimeoutMs = Math.min(12 * 60 * 1000, Math.max(120_000, sizeBasedTimeoutMs));
      const requestedHlsProfile = String(options.hlsProfile || "max");
      const hlsCapability = isVideoMime(file.mimeType) && !options.forceTranscode && !options.skipHls
        ? await getHlsPlaybackSupport()
        : { supported: false, reason: "当前预览流程未启用 HLS" };
      const hlsSupported = !!hlsCapability.supported;

      if (isVideoMime(file.mimeType) && !options.forceTranscode && !options.skipHls && !hlsSupported) {
        setPreviewDebug((prev) => ({
          ...prev,
          lastError: `hls-skip:${hlsCapability.reason}`,
          hlsState: "unsupported",
          lastHlsEvent: "HLS_SKIPPED"
        }));
        setMessage(`HLS 未启用，已回退源文件预览: ${hlsCapability.reason}`, "warning");
      }

      if (isVideoMime(file.mimeType) || isAudioMime(file.mimeType)) {
        if (hlsSupported) {
          try {
            setPreviewStage("准备 HLS");
            setPreviewStatusText("正在准备 HLS 预览...");
            const hlsResult = await withTimeout(
              p2p.getHlsManifest(file.clientId, file.path, {
                profile: requestedHlsProfile,
                onProgress: (status) => {
                  if (!status) return;
                  setPreviewStatusText(status.message || "正在生成 HLS 预览...");
                  if (status.codec) {
                    setPreviewDebug((prev) => ({ ...prev, codec: status.codec }));
                  }
                  if (typeof status.progress === "number") {
                    setPreviewProgress(Math.max(0, Math.min(100, status.progress)));
                  }
                }
              }),
              // 内层超时 480s × 2（单次重试）+ 60s 缓冲，外层必须比这长，否则在重试期间会过早超时
              Math.max(480_000 * 2 + 60_000, sizeBasedTimeoutMs)
            );
            setPreviewName(file.name);
            setPreviewMime("video/mp4");
            setPreviewPath(file.path);
            setPreviewClientId(file.clientId);
            setPreviewHlsSource({
              clientId: file.clientId,
              path: file.path,
              hlsId: hlsResult.hlsId,
              manifest: hlsResult.manifest,
              codec: hlsResult.codec || "",
              profile: hlsResult.profile || requestedHlsProfile,
              availableProfiles: Array.isArray(hlsResult.availableProfiles) ? hlsResult.availableProfiles : [],
              sourceWidth: Number(hlsResult.sourceWidth || 0),
              sourceHeight: Number(hlsResult.sourceHeight || 0)
            });
            setPreviewing(false);
            previewModeRef.current = "hls-stream";
            setPreviewDebug((prev) => ({
              ...prev,
              mode: "hls-stream",
              hlsId: hlsResult.hlsId || "",
              hlsProfile: hlsResult.profile || requestedHlsProfile,
              codec: hlsResult.codec || prev.codec || "",
              sourceWidth: Number(hlsResult.sourceWidth || 0),
              sourceHeight: Number(hlsResult.sourceHeight || 0)
            }));
            setPreviewStage(`${hlsResult.profile || requestedHlsProfile} HLS 就绪`);
            setMessage(`HLS 预览已就绪${hlsResult.profile ? ` (${hlsResult.profile})` : ""}`);
            return;
          } catch (error) {
            if (previewSessionIdRef.current !== sessionId) return;
            setPreviewDebug((prev) => ({
              ...prev,
              lastError: `hls-manifest:${error?.message || "unknown"}`,
              hlsState: "fallback",
              lastHlsEvent: "HLS_MANIFEST_FAILED"
            }));
            setPreviewStage("HLS 回退");
            setMessage(`HLS 预览失败，已回退源文件预览: ${error?.message || "unknown"}`, "warning");
            if (import.meta.env.VITE_P2P_DEBUG === "1") {
              console.log("[web-p2p] hls-fallback", error?.message || error);
            }
            setPreviewHlsSource(null);
          }
        }

        try {
          if (needTranscode) {
            setPreviewStage("转码准备");
            setPreviewStatusText("正在请求客户端转码...");
            setPreviewProgress(0);
            setMessage("视频格式不兼容，正在请求客户端 ffmpeg 转码预览...");
          } else {
            setPreviewStage("加载媒体");
            setPreviewStatusText("正在加载媒体，完成后可拖动进度条...");
          }
          const forceBlobPreview = Number(file.size || 0) <= PREVIEW_FORCE_BLOB_MAX_SIZE;
          const forceBlobByText = isTextPreviewMime(file.mimeType);
          if (import.meta.env.VITE_P2P_DEBUG === "1") {
            console.log("[web-p2p] preview-mode", {
              file: file.name,
              size: file.size,
              needTranscode,
              forceBlobPreview,
              forceBlobByText
            });
          }
          const streamOnce = () => withTimeout(
            p2p.streamPreviewFile(file.clientId, file.path, (ready) => {
              setPreviewUrl(ready.url);
              setPreviewName(file.name);
              setPreviewMime(ready.meta?.mimeType || file.mimeType);
              setPreviewPath(file.path);
              setPreviewClientId(file.clientId);
              setPreviewHlsSource(null);
              previewReleaseRef.current = ready.release;
              previewModeRef.current = needTranscode ? "transcode-stream" : "direct-stream";
              setPreviewDebug((prev) => ({ ...prev, mode: needTranscode ? "transcode-stream" : "direct-stream" }));
              previewFirstFrameRef.current = false;
              setPreviewStage(needTranscode ? "转码预览" : "流式预览");
              setPreviewing(false);
              setMessage("流式预览已开始");
            }, {
              ...(needTranscode ? { transcode: "mp4" } : {}),
              ...(isVideoMime(file.mimeType) ? { previewProfile: "fast" } : {}),
              forceBlob: forceBlobPreview || forceBlobByText,
              maxFallbackBytes: PREVIEW_FORCE_BLOB_MAX_SIZE,
              timeoutMs: needTranscode ? Math.max(240000, sizeBasedTimeoutMs) : sizeBasedTimeoutMs,
              onProgress: (status) => {
                if (!status) return;
                setPreviewStatusText(status.message || "正在转码...");
                if (typeof status.progress === "number") {
                  setPreviewProgress(Math.max(0, Math.min(100, status.progress)));
                }
              }
            }),
            needTranscode ? Math.max(240000, sizeBasedTimeoutMs) : sizeBasedTimeoutMs
          );

          let streamResult;
          try {
            streamResult = await streamOnce();
          } catch (firstError) {
            if (previewSessionIdRef.current !== sessionId) return;
            setPreviewStage("重试连接");
            setPreviewStatusText("连接抖动，正在重试预览...");
            streamResult = await streamOnce();
            if (!streamResult) {
              throw firstError;
            }
          }

          url = streamResult.url;
          mimeType = streamResult.meta?.mimeType || file.mimeType;
          previewReleaseRef.current = streamResult.release;
          setMessage("预览已就绪，可拖动进度条");
        } catch {
          if (previewSessionIdRef.current !== sessionId) return;
          if (!needTranscode && isVideoMime(file.mimeType)) {
            try {
              if (import.meta.env.VITE_P2P_DEBUG === "1") {
                console.log("[web-p2p] preview-retry", "transcode");
              }
              setPreviewStage("转码重试");
              setPreviewStatusText("原格式流失败，正在转码重试...");
              setPreviewProgress(0);
              const transcodeResult = await withTimeout(
                p2p.streamPreviewFile(file.clientId, file.path, (ready) => {
                  setPreviewUrl(ready.url);
                  setPreviewName(file.name);
                  setPreviewMime(ready.meta?.mimeType || "video/mp4");
                  setPreviewPath(file.path);
                  setPreviewClientId(file.clientId);
                  setPreviewHlsSource(null);
                  previewReleaseRef.current = ready.release;
                  previewModeRef.current = "transcode-stream";
                  setPreviewDebug((prev) => ({ ...prev, mode: "transcode-stream" }));
                  previewFirstFrameRef.current = false;
                  setPreviewStage("转码预览");
                  setPreviewing(false);
                  setMessage("流式预览已开始（转码）");
                }, {
                  transcode: "mp4",
                  previewProfile: "fast",
                  forceBlob: Number(file.size || 0) <= PREVIEW_FORCE_BLOB_MAX_SIZE,
                  maxFallbackBytes: PREVIEW_FORCE_BLOB_MAX_SIZE,
                  timeoutMs: Math.max(240000, sizeBasedTimeoutMs),
                  onProgress: (status) => {
                    if (!status) return;
                    setPreviewStatusText(status.message || "正在转码...");
                    if (typeof status.progress === "number") {
                      setPreviewProgress(Math.max(0, Math.min(100, status.progress)));
                    }
                  }
                }),
                Math.max(240000, sizeBasedTimeoutMs)
              );
              url = transcodeResult.url;
              mimeType = transcodeResult.meta?.mimeType || "video/mp4";
              previewReleaseRef.current = transcodeResult.release;
              setMessage("预览已就绪（已自动转码）");
            } catch {
              if (previewSessionIdRef.current !== sessionId) return;
              if (import.meta.env.VITE_P2P_DEBUG === "1") {
                console.log("[web-p2p] preview-fallback", "full-download-after-transcode-fail");
              }
              setPreviewStage("回退下载");
              setPreviewStatusText("流式预览失败，正在回退整文件预览...");
              const result = await withTimeout(p2p.downloadFile(file.clientId, file.path), fallbackDownloadTimeoutMs);
              url = URL.createObjectURL(result.blob);
              mimeType = result.meta?.mimeType || file.mimeType;
              previewReleaseRef.current = () => URL.revokeObjectURL(url);
              previewModeRef.current = "blob";
              setPreviewDebug((prev) => ({ ...prev, mode: "blob" }));
              setPreviewHlsSource(null);
            }
          } else {
            if (previewSessionIdRef.current !== sessionId) return;
            if (import.meta.env.VITE_P2P_DEBUG === "1") {
              console.log("[web-p2p] preview-fallback", "full-download-direct");
            }
            setPreviewStage("回退下载");
            setPreviewStatusText("流式预览失败，正在回退整文件预览...");
            const result = await withTimeout(p2p.downloadFile(file.clientId, file.path), fallbackDownloadTimeoutMs);
            url = URL.createObjectURL(result.blob);
            mimeType = result.meta?.mimeType || file.mimeType;
            previewReleaseRef.current = () => URL.revokeObjectURL(url);
            previewModeRef.current = "blob";
            setPreviewDebug((prev) => ({ ...prev, mode: "blob" }));
            setPreviewHlsSource(null);
          }
        }
      } else {
        if (isImageMime(file.mimeType) && Number(file.size || 0) >= IMAGE_PREVIEW_COMPRESS_THRESHOLD) {
          setPreviewStage("图片压缩");
          setPreviewStatusText("图片较大，正在生成压缩预览...");
          const result = await withTimeout(p2p.previewImageCompressed(file.clientId, file.path), fallbackDownloadTimeoutMs);
          url = URL.createObjectURL(result.blob);
          mimeType = result.meta?.mimeType || "image/jpeg";
          previewReleaseRef.current = () => URL.revokeObjectURL(url);
          previewModeRef.current = "image-compressed";
          setPreviewDebug((prev) => ({ ...prev, mode: "image-compressed" }));
          setPreviewHlsSource(null);
        } else {
          const result = await withTimeout(p2p.downloadFile(file.clientId, file.path), fallbackDownloadTimeoutMs);
          url = URL.createObjectURL(result.blob);
          mimeType = result.meta?.mimeType || file.mimeType;
          previewReleaseRef.current = () => URL.revokeObjectURL(url);
          previewModeRef.current = "blob";
          setPreviewDebug((prev) => ({ ...prev, mode: "blob" }));
          setPreviewHlsSource(null);
        }
      }

      setPreviewUrl(url);
      setPreviewName(file.name);
      setPreviewMime(mimeType);
      setPreviewPath(file.path);
      setPreviewClientId(file.clientId);
      setMessage("预览已就绪");
    } catch (error) {
      if (previewSessionIdRef.current !== sessionId) return;
      if (error?.cancelled || error?.intentionalClose) return;
      setMessage(`预览失败: ${error.message}`);
      setPreviewOpen(false);
    } finally {
      if (previewSessionIdRef.current === sessionId) {
        setPreviewing(false);
      }
    }
  }

  async function switchPreviewHlsProfile(profileId) {
    if (!previewTargetFile || !isVideoMime(previewTargetFile.mimeType) || !profileId) {
      return;
    }
    if (previewHlsSource?.profile === profileId) {
      return;
    }
    await preview(previewTargetFile, { hlsProfile: profileId });
  }

  async function removeFile(file) {
    if (!p2p || !ensureClientOnline(file.clientId)) return;
    if (isUploadingFile(file)) {
      setMessage("该文件仍在上传中，请先取消上传或等待任务结束后再删除");
      return;
    }
    setDeleteTarget({ kind: "single", files: [file] });
    setDeleteStep(1);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    if (!(await ensureSignalingReady("control"))) {
      setDeleteTarget(null);
      setDeleteStep(1);
      return;
    }

    if (deleteTarget.kind === "folder") {
      const folder = deleteTarget.folders?.[0];
      try {
        if (!folder?.singleClientId || !folder?.path) {
          throw new Error("folder delete target is invalid");
        }
        if (!ensureClientOnline(folder.singleClientId)) {
          setDeleteTarget(null);
          setDeleteStep(1);
          return;
        }
        setMessage(`正在删除文件夹 ${folder.name || folder.path}...`);
        await p2p.deleteFolder(folder.singleClientId, folder.path);
        if (currentExplorerPath === folder.path || currentExplorerPath.startsWith(`${folder.path}/`)) {
          openExplorerFolder(getPathDirectory(folder.path));
        }
        setDeleteTarget(null);
        setDeleteStep(1);
        await refreshAll();
        setMessage("文件夹已删除", "success");
      } catch (error) {
        setMessage(`删除文件夹失败: ${error.message}`);
        setDeleteTarget(null);
        setDeleteStep(1);
      }
      return;
    }

    const targets = deleteTarget.files || [];
    let deletedCount = 0;
    let failedCount = 0;
    try {
      setMessage(targets.length > 1 ? `正在删除 ${targets.length} 个文件...` : "正在删除文件...");
      for (const target of targets) {
        if (!ensureClientOnline(target.clientId)) {
          failedCount += 1;
          continue;
        }
        if (p2p?.isClientBusy(target.clientId, "control")) {
          setMessage("部分目标终端当前忙，删除请求已排队，请稍候...");
        }
        await p2p.deleteFile(target.clientId, target.path);
        if (previewPath === target.path && previewClientId === target.clientId) {
          clearPreview();
          setPreviewOpen(false);
        }
        deletedCount += 1;
        delete thumbnailCache.current[getThumbKey(target)];
      }
      setThumbMap((prev) => {
        const next = { ...prev };
        for (const target of targets) {
          delete next[getThumbKey(target)];
        }
        return next;
      });
      saveThumbCache(thumbnailCache.current);
      setSelectedFileIds((prev) => prev.filter((id) => !targets.some((item) => item.id === id)));
      setMessage(targets.length > 1 ? `批量删除完成：成功 ${deletedCount}，失败 ${failedCount}` : "文件已删除");
      setDeleteTarget(null);
      setDeleteStep(1);
      await refreshAll();
    } catch (error) {
      setMessage(`删除失败: ${error.message}`);
      setDeleteTarget(null);
      setDeleteStep(1);
    }
  }

  async function upload() {
    if (!p2p || !uploadFiles.length || !uploadClientId) {
      setMessage("请先选择终端和文件");
      return;
    }
    if (!ensureClientOnline(uploadClientId)) return;
    if (!(await ensureSignalingReady("upload"))) return;

    const folderPath = normalizeFolderPath(uploadFolderPath);
    const columnName = columnMap.get(uploadColumnId) || "";
    const basePath = normalizeFolderPath([columnName, folderPath].filter(Boolean).join("/"));
    setUploadOpen(false);

    let successCount = 0;
    let failedCount = 0;
    let cancelledCount = 0;

    for (const uploadItem of uploadFiles) {
      let jobId = "";
      try {
        const file = uploadItem.file;
        const uploadName = sanitizeUploadFileName(uploadItem.desiredName, file.name);
        const targetPath = buildUploadTargetPath(basePath, uploadName);
        const started = await apiRequest("/api/upload-jobs/start", {
          method: "POST",
          token,
          body: {
            clientId: uploadClientId,
            fileName: uploadName,
            relativePath: targetPath,
            size: file.size,
            mimeType: file.type || "application/octet-stream",
            columnId: uploadColumnId || "",
            folderPath: folderPath || ""
          }
        });
        if (started?.job) {
          jobId = started.job.id;
          activeLocalUploadJobIds.current.add(jobId);
          upsertUploadJob(started.job);
        }

        setMessage(`正在上传 ${uploadName}...`);
        await p2p.uploadFile(uploadClientId, targetPath, file, {
          uploadName,
          onProgress: ({ transferredBytes, progress }) => {
            if (!jobId) {
              return;
            }
            upsertUploadJob({
              id: jobId,
              status: "uploading",
              progress,
              transferredBytes,
              size: file.size,
              updatedAt: new Date().toISOString(),
              message: `上传中 ${progress}%`
            });

            const now = Date.now();
            const prevAt = uploadProgressReportAt.current[jobId] || 0;
            const shouldReport = now - prevAt >= 1000 || progress >= 100;
            if (!shouldReport) {
              return;
            }
            uploadProgressReportAt.current[jobId] = now;
            apiRequest(`/api/upload-jobs/${jobId}/progress`, {
              method: "POST",
              token,
              body: {
                progress,
                transferredBytes,
                message: `上传中 ${progress}%`
              }
            }).catch(() => {});
          }
        });

        if (jobId) {
          const finished = await apiRequest(`/api/upload-jobs/${jobId}/finish`, {
            method: "POST",
            token,
            body: { message: "上传完成，等待文件索引刷新" }
          });
          if (finished?.job) {
            upsertUploadJob(finished.job);
          }
        }
        successCount += 1;
      } catch (error) {
        const isCancelled = /已取消|cancelled/i.test(error?.message || "");
        if (isCancelled) {
          cancelledCount += 1;
        } else {
          failedCount += 1;
        }
        if (!isCancelled && jobId) {
          apiRequest(`/api/upload-jobs/${jobId}/fail`, {
            method: "POST",
            token,
            body: { message: `上传失败: ${error.message}` }
          }).catch(() => {});
          upsertUploadJob({
            id: jobId,
            status: "failed",
            message: `上传失败: ${error.message}`,
            updatedAt: new Date().toISOString()
          });
        }
        if (!isCancelled) {
          setMessage(`上传失败: ${error.message}`);
        }
      } finally {
        if (jobId) {
          activeLocalUploadJobIds.current.delete(jobId);
          delete uploadProgressReportAt.current[jobId];
        }
      }
    }

    await refreshAll();
    if (successCount && !failedCount && !cancelledCount) {
      setMessage(`已完成 ${successCount} 个文件上传`);
    } else if (successCount || failedCount || cancelledCount) {
      setMessage(`上传结束：成功 ${successCount}，失败 ${failedCount}，取消 ${cancelledCount}`);
    } else {
      setMessage("未开始上传任务");
    }
    setUploadFiles([]);
    setUploadOpen(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function cancelUploadJob(job) {
    if (!p2p || !job?.clientId || !job?.relativePath) return;
    let cancelled = false;
    try {
      cancelled = p2p.cancelUpload(job.clientId, job.relativePath);
    } catch (error) {
      setMessage(`取消上传失败: ${error?.message || error}`);
      return;
    }
    if (!cancelled) {
      setMessage("当前上传任务不在本地活跃队列中，未执行通道取消", "warning");
      return;
    }
    if (job.id) {
      removeUploadJobLocal(job.id);
      apiRequest(`/api/upload-jobs/${job.id}/fail`, {
        method: "POST",
        token,
        body: { message: "用户取消上传" }
      }).catch(() => {});
    }
    setMessage("上传已取消");
  }

  function toggleFileSelected(fileId) {
    setSelectedFileIds((prev) => (prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]));
  }

  function toggleSelectAllVisible() {
    setSelectedFileIds((prev) => {
      const visibleIds = currentFolderFiles.map((file) => file.id);
      if (visibleIds.length === 0) {
        return prev;
      }
      const prevSet = new Set(prev);
      const allSelected = visibleIds.every((id) => prevSet.has(id));
      if (allSelected) {
        return prev.filter((id) => !visibleIds.includes(id));
      }
      return Array.from(new Set([...prev, ...visibleIds]));
    });
  }

  async function batchToggleFavorite() {
    if (!selectedVisibleFiles.length) {
      return;
    }
    for (const file of selectedVisibleFiles) {
      await apiRequest(`/api/favorites/${encodeURIComponent(file.id)}`, {
        method: "POST",
        token
      });
    }
    await refreshAll();
    setMessage(`已处理 ${selectedVisibleFiles.length} 个文件的收藏状态`);
  }

  async function batchDownload() {
    if (!selectedVisibleFiles.length) {
      return;
    }
    for (const file of selectedVisibleFiles) {
      await download(file);
    }
    setMessage(`已触发 ${selectedVisibleFiles.length} 个文件的下载`);
  }

  function requestBatchDelete() {
    const deletableFiles = selectedVisibleFiles.filter((file) => !isUploadingFile(file));
    if (!deletableFiles.length) {
      setMessage("当前选中文件里没有可删除项");
      return;
    }
    setDeleteTarget({ kind: "batch", files: deletableFiles });
    setDeleteStep(1);
  }

  async function changeClientStatus(clientId, status) {
    try {
      await apiRequest(`/api/admin/clients/${clientId}/status`, {
        method: "POST",
        token,
        body: { status }
      });
      setMessage(`终端状态已更新为 ${status}`);
      await refreshAll();
    } catch (error) {
      setMessage(`更新终端状态失败: ${error.message}`);
    }
  }

  function logout() {
    localStorage.removeItem("nas_token");
    setToken("");
    setUser(null);
    setFiles([]);
    setShares([]);
    setUsers([]);
    setClients([]);
    setUploadJobs([]);
    closeShareDialog();
    clearPreview();
    setPreviewOpen(false);
  }

  async function saveProfile(draft) {
    try {
      setProfileSaving(true);
      const profilePatch = {
        displayName: draft.displayName,
        email: draft.email,
        avatarUrl: user.avatarUrl || "",
        avatarClientId: user.avatarClientId || "",
        avatarPath: user.avatarPath || "",
        avatarFileId: user.avatarFileId || "",
        bio: draft.bio
      };

        const finished = await apiRequest(`/api/upload-jobs/${jobId}/finish`, {
          method: "POST",
          token,
          body: { message: "转存完成，等待资源列表刷新" }
        });
        if (finished?.job) {
          upsertUploadJob(finished.job);
        }
      if (draft.avatarFile) {
        if (!p2p) {
          throw new Error("当前 P2P 通道尚未就绪，无法上传头像");
        }
        const targetClientId = uploadClientId || clients.find((item) => item.status === "online")?.id || "";
        if (!targetClientId) {
          throw new Error("没有可用的在线存储终端，无法上传头像");
        }
        const ext = (() => {
          const matched = /\.([a-zA-Z0-9]+)$/.exec(draft.avatarFile.name || "");
          return matched ? `.${matched[1].toLowerCase()}` : "";
        })();
        const avatarRelativePath = `${PROFILE_AVATAR_DIR_NAME}/${sanitizePathSegment(user.id)}/${Date.now()}-${sanitizePathSegment(draft.avatarFile.name || "avatar")}${ext}`;
        await p2p.uploadFile(targetClientId, avatarRelativePath, draft.avatarFile, {
          uploadName: draft.avatarFile.name || "avatar"
        });
        profilePatch.avatarClientId = targetClientId;
        profilePatch.avatarPath = avatarRelativePath;
        profilePatch.avatarFileId = `${targetClientId}:${avatarRelativePath}`;
        profilePatch.avatarUrl = "";
      }

      const data = await apiRequest("/api/me", {
        method: "PATCH",
        token,
        body: profilePatch
      });
      localStorage.setItem("nas_token", data.token);
      setToken(data.token);
      setUser(data.user);
      setProfileOpen(false);
      setMessage("个人资料已更新");
      await refreshAll(data.token);
    } catch (error) {
      setMessage(`更新个人资料失败: ${error.message}`);
    } finally {
      setProfileSaving(false);
    }
  }

  const livingRoomWinRef = useRef(null);

  function openInLivingRoom(file) {
    // 关闭预览窗，停止本页播放
    clearPreview();
    setPreviewOpen(false);

    const payload = {
      id: file.id,
      clientId: file.clientId,
      path: file.path,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size
    };
    const win = livingRoomWinRef.current;
    if (win && !win.closed) {
      win.postMessage({ type: "lr_play_file", file: payload }, window.location.origin);
      try { win.focus(); } catch { }
      return;
    }
    // Broadcast to any existing living-room tab (works across sessions/reloads)
    try {
      const bc = new BroadcastChannel("nas_living_room_bc");
      bc.postMessage({ type: "lr_play_file", file: payload });
      bc.close();
    } catch { }
    // Write to sessionStorage for brand-new windows (consumed at module load)
    try {
      sessionStorage.setItem("lr_main_launch", JSON.stringify(payload));
    } catch { }
    const newWin = window.open("/living-room.html", "nas_living_room");
    if (newWin) {
      livingRoomWinRef.current = newWin;
      try { newWin.focus(); } catch { }
    }
  }

  function renderFileActionTray(file, floating = false) {
    const deletingDisabled = isUploadingFile(file);
    return (
      <div className={`fileActionTray${floating ? " floating" : ""}`} onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className={`actionChip${file.favorite ? " active" : ""}`}
          title={file.favorite ? "取消收藏" : "收藏"}
          aria-label={file.favorite ? "取消收藏" : "收藏"}
          onClick={() => toggleFavorite(file.id)}
        >
          {file.favorite ? <StarFilled /> : <StarRegular />}
        </button>
        <button
          type="button"
          className="actionChip"
          title="编辑"
          aria-label="编辑"
          onClick={() => openEditFile(file)}
        >
          <EditRegular />
        </button>
        <button
          type="button"
          className="actionChip"
          title="分享"
          aria-label="分享"
          onClick={() => openShareDialog(file)}
          disabled={shareLoading}
        >
          <ShareRegular />
        </button>
        <button
          type="button"
          className="actionChip"
          title="预览"
          aria-label="预览"
          onClick={() => preview(file)}
        >
          <EyeRegular />
        </button>
        <button
          type="button"
          className="actionChip"
          title="下载"
          aria-label="下载"
          onClick={() => download(file)}
        >
          <ArrowDownloadRegular />
        </button>
        {(isVideoMime(file.mimeType) || isAudioMime(file.mimeType)) && (
          <button
            type="button"
            className="actionChip"
            title="大屏播放"
            aria-label="大屏播放"
            onClick={() => openInLivingRoom(file)}
          >
            <StreamRegular />
          </button>
        )}
        {(isVideoMime(file.mimeType) || isImageMime(file.mimeType)) && (
          <button
            type="button"
            className="actionChip"
            title="重新获取封面"
            aria-label="重新获取封面"
            onClick={() => forceRefreshThumbnail(file)}
          >
            <ArrowSyncRegular />
          </button>
        )}
        <button
          type="button"
          className="actionChip danger"
          title={deletingDisabled ? "上传中不可删除" : "删除"}
          aria-label={deletingDisabled ? "上传中不可删除" : "删除"}
          disabled={deletingDisabled}
          onClick={() => removeFile(file)}
        >
          <DeleteRegular />
        </button>
      </div>
    );
  }

  function renderFolderActionTray(folder) {
    const disabled = !folder?.singleClientId;
    const sharedTitle = disabled ? "该目录在多个终端上同时存在，暂不支持直接修改" : "编辑目录";
    return (
      <div className="fileActionTray" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="actionChip actionChipPrimary"
          title={`进入目录 ${folder?.name || ""}`}
          aria-label={`进入目录 ${folder?.name || ""}`}
          onClick={() => openExplorerFolder(folder.path)}
        >
          <ArrowRightRegular />
        </button>
        <button
          type="button"
          className="actionChip"
          title={sharedTitle}
          aria-label={sharedTitle}
          disabled={disabled}
          onClick={() => openEditFolder(folder)}
        >
          <EditRegular />
        </button>
        <button
          type="button"
          className="actionChip danger"
          title={disabled ? "该目录在多个终端上同时存在，暂不支持直接删除" : "删除目录"}
          aria-label={disabled ? "该目录在多个终端上同时存在，暂不支持直接删除" : "删除目录"}
          disabled={disabled}
          onClick={() => requestFolderDelete(folder)}
        >
          <DeleteRegular />
        </button>
      </div>
    );
  }

  function renderSelectionToggle(file) {
    const selected = selectedFileIds.includes(file.id);
    return (
      <button
        type="button"
        className={`selectToggle${selected ? " active" : ""}`}
        aria-label={selected ? "取消选中" : "选中文件"}
        onClick={(event) => {
          event.stopPropagation();
          toggleFileSelected(file.id);
        }}
      >
        <span className="selectToggleFrame">
          <span className="selectToggleMark" />
        </span>
        <span className="selectToggleGlow" />
      </button>
    );
  }

  function renderToastViewport() {
    if (!toasts.length) {
      return null;
    }
    return (
      <div className="toastViewport" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toastItem ${toast.intent}`}
            role="button"
            tabIndex={0}
            title="点击关闭提示"
            onClick={() => dismissToast(toast.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                dismissToast(toast.id);
              }
            }}
          >
            <div className="toastBody">
              <Caption1>{toast.intent === "error" ? "错误" : toast.intent === "success" ? "已完成" : toast.intent === "warning" ? "注意" : "状态"}</Caption1>
              <Text>{toast.text}</Text>
            </div>
            <button type="button" className="toastClose" aria-label="关闭提示" onClick={() => dismissToast(toast.id)}>
              关闭
            </button>
          </div>
        ))}
      </div>
    );
  }

  // ─── 移动端辅助函数 ───────────────────────────────────────────

  // Android 回退键：在 moreNavigatedTab 子页面时，物理返回键回到更多抽屉
  useEffect(() => {
    if (!moreNavigatedTab) return;
    window.history.pushState({ moreNav: true }, "");
    const onPop = () => {
      // 若当前处于全屏状态（如 TV 视频全屏），重新推入历史避免误触页面导航
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        window.history.pushState({ moreNav: true }, "");
        return;
      }
      setMoreNavigatedTab(null);
      setMoreSheetOpen(true);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [moreNavigatedTab]);

  // 移动端预览弹窗打开时：物理返回键关闭预览
  useEffect(() => {
    if (!previewOpen || !isMobile) return;
    window.history.pushState({ previewBack: true }, "");
    const onPop = () => {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        // 已在全屏中，重新推历史以防后退键退出全屏时误关预览
        window.history.pushState({ previewBack: true }, "");
        return;
      }
      // Android Chrome 在 requestFullscreen() 时会先触发 popstate，
      // 此时 fullscreenElement 尚未赋值（转场中）。
      // 延迟一帧再判断，让全屏转场有机会完成。
      window.setTimeout(() => {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
          window.history.pushState({ previewBack: true }, "");
          return;
        }
        stopActivePreviewSession();
      }, 60);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [previewOpen, isMobile]);

  // 移动端切换回文件页时恢复滚动位置
  useEffect(() => {
    if (!isMobile || activeWorkspaceTab !== "explorer") return;
    if (mobilePageContentRef.current) {
      mobilePageContentRef.current.scrollTop = listScrollTop;
    }
  }, [activeWorkspaceTab, isMobile]);

  if (!token || !user) {
    return (
      <div className="page authPage">
        {renderToastViewport()}
        <div className="authLayout authExperience">
          <section className="surfaceCard authShowcase">
            <div className="authShowcaseCopy">
              <div className="authShowcaseTop">
                <Badge appearance="outline" color="informative">NAS Bridge</Badge>
                <div className="authShowcasePulse">
                  <span className="authShowcasePulseDot" />
                  <Caption1>Private cloud relay console</Caption1>
                </div>
              </div>

              <div className="authShowcaseHeadline">
                <Title3>一个入口，接管所有远端存储节点。</Title3>
                <Text>
                  登录后直接进入文件工作台，处理预览、上传、批量操作和多终端连接，不再把这些动作拆在不同页面里。
                </Text>
              </div>

              <div className="authShowcaseMetrics">
                <div className="authMetricCard primary">
                  <Caption1>连接层</Caption1>
                  <Text>03 条链路</Text>
                </div>
                <div className="authMetricCard">
                  <Caption1>操作面</Caption1>
                  <Text>04 类动作</Text>
                </div>
                <div className="authMetricCard">
                  <Caption1>控制台</Caption1>
                  <Text>01 个入口</Text>
                </div>
              </div>

              <div className="authFeatureRail">
                <div className="authFeatureBlock">
                  <Caption1>P2P First</Caption1>
                  <Text>直连优先</Text>
                </div>
                <div className="authFeatureBlock">
                  <Caption1>Relay Ready</Caption1>
                  <Text>中继兜底</Text>
                </div>
                <div className="authFeatureBlock">
                  <Caption1>Media Stack</Caption1>
                  <Text>预览可切换</Text>
                </div>
              </div>
            </div>

            <div className="authShowcaseVisual" aria-hidden="true">
              <div className="authVisualHalo haloA" />
              <div className="authVisualHalo haloB" />
              <div className="authVisualCard authVisualPrimary">
                <div className="authVisualHeader">
                  <span className="authVisualWindowDot red" />
                  <span className="authVisualWindowDot amber" />
                  <span className="authVisualWindowDot green" />
                </div>
                <div className="authVisualBody">
                  <div className="authVisualRow">
                    <span>node/home</span>
                    <strong>online</strong>
                  </div>
                  <div className="authVisualBars">
                    <span style={{ width: "84%" }} />
                    <span style={{ width: "66%" }} />
                    <span style={{ width: "92%" }} />
                  </div>
                  <div className="authVisualTerminal">
                    <span>preview channel ready</span>
                    <span>upload queue synced</span>
                    <span>relay fallback standby</span>
                  </div>
                </div>
              </div>
              <div className="authVisualStack">
                <div className="authVisualCard authVisualMini">
                  <Caption1>PREVIEW</Caption1>
                  <Text>HLS / Stream / Blob</Text>
                </div>
                <div className="authVisualCard authVisualMini alt">
                  <Caption1>NODES</Caption1>
                  <Text>Live routes synced</Text>
                </div>
              </div>
            </div>
          </section>

          <Card className="surfaceCard authPanel authPanelElevated">
            <div className="authPanelHeader">
              <div className="authPanelBrand">
                <div className="brandLogo authPanelLogo" aria-hidden="true">
                  <span className="brandLogoCore" />
                  <span className="brandLogoOrbit orbitA" />
                  <span className="brandLogoOrbit orbitB" />
                </div>
                <div>
                  <Caption1>NAS Bridge Access</Caption1>
                </div>
              </div>
              <div>
                <Title3>{authMode === "login" ? "进入文件工作台" : "创建访问入口"}</Title3>
                <Caption1>{authMode === "login" ? "Sign in to the bridge console" : "Create account and enter the console"}</Caption1>
              </div>
              <div className="authModeSwitch">
                <Button appearance={authMode === "login" ? "primary" : "secondary"} onClick={() => setAuthMode("login")}>登录</Button>
                <Button appearance={authMode === "register" ? "primary" : "secondary"} onClick={() => setAuthMode("register")}>注册</Button>
              </div>
            </div>

            <div className="authForm">
              <Field label="邮箱">
                <Input value={email} placeholder="name@example.com" onChange={(_, data) => setEmail(data.value)} />
              </Field>
              <Field label="密码">
                <Input
                  type="password"
                  value={password}
                  placeholder="输入登录密码"
                  onChange={(_, data) => setPassword(data.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      if (authMode === "login") {
                        login();
                      } else {
                        register();
                      }
                    }
                  }}
                />
              </Field>
              {authMode === "register" && (
                <Field label="显示名">
                  <Input value={displayName} placeholder="例如：家用 NAS" onChange={(_, data) => setDisplayName(data.value)} />
                </Field>
              )}
              <div className="authActions">
                <Button appearance="primary" onClick={authMode === "login" ? login : register}>
                  {authMode === "login" ? "进入控制台" : "创建并进入"}
                </Button>
                <Button onClick={() => setAuthMode(authMode === "login" ? "register" : "login")}>
                  {authMode === "login" ? "没有账号？去注册" : "已有账号？去登录"}
                </Button>
              </div>
              <div className="authPanelFooterNote">
                <Caption1>
                  {authMode === "login"
                    ? "登录后直接进入文件、终端和任务视图。"
                    : "显示名会立即用于终端归属与上传记录展示。"}
                </Caption1>
              </div>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  function handleMobileTabChange(id) {
    if (id === "more") {
      setMoreSheetOpen(true);
      return;
    }
    setMoreSheetOpen(false);
    setMoreNavigatedTab(null);
    setActiveWorkspaceTab(id);
  }

  function handleMoreNavigate(tabId) {
    setMoreSheetOpen(false);
    setMoreNavigatedTab(tabId);
    setActiveWorkspaceTab("more");
  }

  function renderDialogs() {
    return (
      <>
        {shareDialogOpen && shareTarget && (
          <div className="overlay drawerOverlay dialogOverlayRaised">
            <div className="modalWindow shareModal drawerSheet dialogModal" onClick={(event) => event.stopPropagation()}>
              <div className="drawerHandle" />
              <div className="modalHeader">
                <div>
                  <Subtitle1>分享链接</Subtitle1>
                  <Caption1>{shareTarget.name} · {formatBytes(shareTarget.size)} · {getClientDisplayName(shareTarget.clientId)}</Caption1>
                </div>
                <Button size="small" className="dialogActionButton dialogIconOnlyButton" icon={<DismissRegular />} aria-label="关闭" title="关闭" onClick={closeShareDialog} />
              </div>
              <div className="drawerSection shareComposerCard shareComposerSolo">
                <Text className="dialogPathLine" title={shareTarget.path}>{shareTarget.path}</Text>
                <div>
                  <Caption1>有效期</Caption1>
                  <div className="dialogChoiceGrid">
                    {SHARE_EXPIRY_OPTIONS.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        className={`dialogChoicePill${shareExpiryDays === item.value ? " active" : ""}`}
                        onClick={() => setShareExpiryDays(item.value)}
                        aria-pressed={shareExpiryDays === item.value}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="drawerFooter dialogFooterInline">
                <div className="dialogFooterMeta">
                  <Caption1>{getShareExpiryLabel(shareExpiryDays)}，生成后自动复制</Caption1>
                </div>
                <div className="row editFileActions">
                  <Button className="dialogActionButton dialogIconOnlyButton" icon={<DismissRegular />} aria-label="取消" title="取消" onClick={closeShareDialog} />
                  <Button className="dialogActionButton dialogPrimaryButton" appearance="primary" icon={<ShareRegular />} onClick={() => shareFile(shareTarget)} disabled={shareLoading}>
                    {shareLoading ? "生成中..." : "生成并复制链接"}
                  </Button>
                </div>
              </div>
              <button type="button" className="dialogSecondaryToggle" onClick={() => setShareHistoryOpen((prev) => !prev)}>
                {shareHistoryOpen ? "收起历史链接" : `查看历史链接${currentFileShares.length ? `（${currentFileShares.length}）` : ""}`}
              </button>
              {shareHistoryOpen && (
                <div className="drawerSection shareHistorySection">
                  <div className="sectionHeaderCompact">
                    <Subtitle1>该文件的分享记录</Subtitle1>
                    <Badge appearance="outline" color={currentFileShares.length ? "informative" : "subtle"}>{currentFileShares.length}</Badge>
                  </div>
                  <div className="shareHistoryList">
                    {currentFileShares.map((share) => (
                      <div key={share.id} className="shareHistoryRow">
                        <div className="shareHistoryMeta">
                          <Text>{share.shareUrl}</Text>
                          <Caption1>创建于 {formatRelativeTime(share.createdAt)} · 访问 {share.accessCount || 0} 次 · {share.expiresAt ? `到期 ${formatRelativeTime(share.expiresAt)}` : "长期有效"}</Caption1>
                        </div>
                        <div className="shareHistoryActions">
                          <Badge appearance="outline" color={getShareStatusColor(share.status)}>{getShareStatusLabel(share.status)}</Badge>
                          <Button size="small" className="dialogActionButton" icon={<CopyRegular />} onClick={() => copyShareUrl(share.shareUrl)}>复制</Button>
                          <Button size="small" className="dialogActionButton" icon={<DismissRegular />} disabled={share.status !== "active"} onClick={() => revokeShare(share.id)}>撤销</Button>
                          <Button size="small" className="dialogActionButton dangerButton" icon={<DeleteRegular />} onClick={() => deleteShare(share.id)}>删除</Button>
                        </div>
                      </div>
                    ))}
                    {!currentFileShares.length && <Caption1>还没有为这个文件生成过分享链接。</Caption1>}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {uploadOpen && (
          <div className="overlay drawerOverlay dialogOverlayRaised">
            <div className="modalWindow uploadModal drawerSheet dialogModal" onClick={(event) => event.stopPropagation()}>
              <div className="drawerHandle" />
              <div className="modalHeader">
                <div>
                  <Subtitle1>上传工作台</Subtitle1>
                  <Caption1>{uploadStep === 1 ? "先选目标终端，再进入本地文件选择。" : "先选本地文件，再按需要补目录和命名。"}</Caption1>
                </div>
                <Button size="small" className="dialogActionButton dialogIconOnlyButton" icon={<DismissRegular />} aria-label="关闭" title="关闭" onClick={() => setUploadOpen(false)} />
              </div>
              <div className="drawerSteps">
                <div className={`drawerStepBadge${uploadStep === 1 ? " active" : ""}`}>1. 选择目标</div>
                <div className={`drawerStepBadge${uploadStep === 2 ? " active" : ""}`}>2. 路径、命名与文件</div>
              </div>
              {uploadStep === 1 && (
                <div className="drawerSection uploadTargetSection">
                  <Text className="dialogPrimaryLine">上传到哪个存储终端</Text>
                  <Caption1>这里只做一个选择，其他内容下一步再处理。</Caption1>
                  <div className="uploadTargetRow">
                    <Field className="filterField filterControl dialogField" label="目标存储终端">
                      <Dropdown className="filterDropdown dialogDropdown" selectedOptions={uploadClientId ? [uploadClientId] : []} value={getClientDropdownValue(uploadClientId)} onOptionSelect={(_, data) => setUploadClientId(data.optionValue || "") }>
                        {clients.map((item) => (
                          <Option key={item.id} value={item.id}>{getClientDisplayName(item.id)}</Option>
                        ))}
                      </Dropdown>
                    </Field>
                    <Button className="dialogActionButton dialogPrimaryButton uploadTargetContinue" appearance="primary" icon={<ArrowRightRegular />} disabled={!uploadClientId} onClick={() => setUploadStep(2)}>继续</Button>
                  </div>
                </div>
              )}
              {uploadStep === 2 && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hiddenInput"
                    onChange={(event) => {
                      appendUploadFiles(event.target.files || []);
                      event.target.value = "";
                    }}
                  />
                  <div className="drawerSection uploadPrimaryActionBar">
                    <div>
                      <Text className="dialogPrimaryLine">先选择本地文件</Text>
                      <Caption1>{getClientDisplayName(uploadClientId) || "未选择终端"}{uploadFolderPath ? ` / ${uploadFolderPath}` : " / 根目录"}</Caption1>
                    </div>
                    <div className="uploadPrimaryActionButtons">
                      <Button className="dialogActionButton dialogPrimaryButton uploadPickButton" appearance="primary" icon={<AddRegular />} onClick={() => fileInputRef.current?.click()}>选择本地文件</Button>
                      <Button className="dialogActionButton" icon={<ArrowSwapRegular />} onClick={() => setUploadStep(1)}>切换目标</Button>
                    </div>
                  </div>
                  <div className="uploadWorkbenchGrid uploadWorkbenchStep2">
                    <div className="drawerSection uploadPanelSection uploadComposerSection">
                      <Field className="filterField filterControl dialogField" label="上传到哪个目录">
                        <div className="uploadFolderComposer">
                          <Dropdown
                            className="filterDropdown dialogDropdown"
                            selectedOptions={[normalizeFolderPath(uploadFolderPath) || ROOT_FOLDER_OPTION_VALUE]}
                            value={normalizeFolderPath(uploadFolderPath) || "根目录"}
                            onOptionSelect={(_, data) => setUploadFolderPath(data.optionValue === ROOT_FOLDER_OPTION_VALUE ? "" : normalizeFolderPath(data.optionValue || ""))}
                          >
                            <Option value={ROOT_FOLDER_OPTION_VALUE}>根目录</Option>
                            {uploadFolderOptions.filter(Boolean).map((option) => (
                              <Option key={option} value={option}>{option}</Option>
                            ))}
                          </Dropdown>
                          <Button
                            className="dialogActionButton"
                            icon={<AddRegular />}
                            appearance="secondary"
                            onClick={() => openCreateFolderModal({
                              source: "upload",
                              basePath: uploadTargetPreview,
                              clientId: uploadClientId,
                              uploadFolderBasePath: uploadFolderPath
                            })}
                            disabled={!uploadClientId}
                          >
                            新建目录
                          </Button>
                        </div>
                      </Field>
                      <div className="uploadFolderBrowser">
                        <div className="uploadFolderBrowserHeader">
                          <Caption1>目录导航</Caption1>
                          <Caption1>{uploadFolderPath || "根目录"}</Caption1>
                        </div>
                        <div className="uploadFolderBreadcrumbs">
                          <button type="button" className={`uploadFolderCrumb${!uploadFolderPath ? " current" : ""}`} onClick={() => setUploadFolderPath("")}>根目录</button>
                          {uploadFolderBreadcrumbs.map((crumb) => (
                            <button key={crumb.path} type="button" className={`uploadFolderCrumb${crumb.path === uploadFolderPath ? " current" : ""}`} onClick={() => setUploadFolderPath(crumb.path)}>
                              {crumb.label}
                            </button>
                          ))}
                        </div>
                        <div className="uploadFolderTree">
                          {uploadFolderChildren.length ? uploadFolderChildren.map((folder) => (
                            <button key={folder.path} type="button" className={`uploadFolderTreeItem${folder.path === uploadFolderPath ? " active" : ""}`} onClick={() => setUploadFolderPath(folder.path)}>
                              <FolderOpenRegular />
                              <span>{folder.name}</span>
                            </button>
                          )) : <Caption1>当前目录下没有更多子目录，可直接新建目录或手动输入。</Caption1>}
                        </div>
                      </div>
                      <button type="button" className="dialogSecondaryToggle" onClick={() => setUploadAdvancedOpen((prev) => !prev)}>
                        {uploadAdvancedOpen ? "收起高级设置" : "展开高级设置（栏目、手动路径）"}
                      </button>
                      {uploadAdvancedOpen && (
                        <div className="dialogAdvancedPanel">
                          <Field className="filterField filterControl dialogField" label="栏目（可选）">
                            <Dropdown className="filterDropdown dialogDropdown" selectedOptions={uploadColumnId ? [uploadColumnId] : ["none"]} value={getColumnDisplayValue(uploadColumnId || "none")} onOptionSelect={(_, data) => setUploadColumnId(data.optionValue === "none" ? "" : data.optionValue || "") }>
                              <Option value="none">未分类</Option>
                              {columns.map((item) => (
                                <Option key={item.id} value={item.id}>{item.name}</Option>
                              ))}
                            </Dropdown>
                          </Field>
                          <div className="drawerInlineFields">
                            <Input className="filterInput dialogInput" value={columnDraftName} onChange={(_, data) => setColumnDraftName(data.value)} placeholder="新建栏目，例如：旅行、工作文档" />
                            <Button size="small" className="dialogActionButton" appearance="secondary" icon={<AddRegular />} onClick={createColumn}>新增栏目</Button>
                          </div>
                          <Field className="filterField filterControl dialogField" label="手动输入子目录">
                            <Input className="filterInput dialogInput" value={uploadFolderPath} onChange={(_, data) => setUploadFolderPath(normalizeFolderPath(data.value))} placeholder="例如 media/photos" />
                          </Field>
                        </div>
                      )}
                    </div>
                    <div className="drawerSection selectedFilesList uploadSelectionPanel">
                      <div className="uploadSelectionHeader">
                        <div>
                          <Text>待上传文件</Text>
                          <Caption1>{uploadFiles.length ? `${uploadFiles.length} 个文件，${formatBytes(uploadTotalBytes)}` : "还没有选择本地文件"}</Caption1>
                        </div>
                        <div className="uploadListActions">
                          <Badge appearance="outline" color={uploadFiles.length ? "informative" : "subtle"}>{uploadFiles.length}</Badge>
                          <Button className="dialogActionButton" appearance="secondary" icon={<DismissRegular />} onClick={() => setUploadFiles([])} disabled={!uploadFiles.length}>清空</Button>
                        </div>
                      </div>
                      {uploadFiles.length > 0 ? uploadFiles.map((item) => {
                        const finalName = sanitizeUploadFileName(item.desiredName, item.file.name);
                        return (
                          <div key={item.id} className="selectedFileRow uploadDraftRow">
                            <div className="uploadDraftMeta">
                              <Text className="selectedFileName" title={item.file.name}>{item.file.name}</Text>
                              <Caption1>{formatBytes(item.file.size)}</Caption1>
                            </div>
                            <div className="uploadDraftEditor">
                              <Field className="filterField filterControl dialogField" label="上传名称">
                                <Input className="filterInput dialogInput" value={item.desiredName} onChange={(_, data) => updateUploadFileName(item.id, data.value)} />
                              </Field>
                              <Caption1 className="uploadDraftPath" title={buildUploadTargetPath(uploadTargetPreview, finalName)}>
                                最终路径：{buildUploadTargetPath(uploadTargetPreview, finalName)}
                              </Caption1>
                            </div>
                            <Button size="small" className="dialogActionButton dangerButton" icon={<DeleteRegular />} onClick={() => removeUploadDraft(item.id)}>移除</Button>
                          </div>
                        );
                      }) : (
                        <div className="uploadEmptyState">
                          <Text>还没有选择本地文件</Text>
                          <Caption1>先点上面的"选择本地文件"，选择后这里才会出现待上传列表。</Caption1>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="drawerFooter uploadFooterBar">
                    <div className="dialogFooterMeta">
                      <Caption1>{uploadFiles.length ? `将上传到 ${uploadTargetPreview || "/"}` : "先选择本地文件"}</Caption1>
                    </div>
                    <div className="row editFileActions">
                      <Button className="dialogActionButton" icon={<ArrowSwapRegular />} onClick={() => setUploadStep(1)}>上一步</Button>
                      <Button className="dialogActionButton dialogPrimaryButton" appearance="primary" icon={<ArrowRightRegular />} disabled={!uploadFiles.length || !uploadClientId} onClick={async () => { await upload(); }}>开始上传</Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {editFileOpen && editFileDraft && (
          <div className="overlay dialogOverlayRaised">
            <div className="modalWindow editFileModal dialogModal" onClick={(event) => event.stopPropagation()}>
              <div className="modalHeader">
                <div>
                  <Subtitle1>编辑文件</Subtitle1>
                  <Caption1>{editFileDraft.currentPath}</Caption1>
                </div>
                <Button size="small" className="dialogActionButton dialogIconOnlyButton" icon={<DismissRegular />} aria-label="关闭" title="关闭" onClick={closeEditFileModal} />
              </div>
              <div className="editFileForm editFileFormSingle">
                <Field className="filterField filterControl dialogField" label="文件名称">
                  <Input className="filterInput dialogInput" value={editFileDraft.fileName} onChange={(_, data) => setEditFileDraft((prev) => ({ ...prev, fileName: data.value }))} />
                </Field>
                <button type="button" className="dialogSecondaryToggle" onClick={() => setEditFileAdvancedOpen((prev) => !prev)}>
                  {editFileAdvancedOpen ? "收起更多设置" : "展开更多设置（目录、栏目、文件类型）"}
                </button>
                {editFileAdvancedOpen && (
                  <div className="dialogAdvancedPanel">
                    <Field className="filterField filterControl dialogField" label="已有目录选择器">
                      <Dropdown
                        className="filterDropdown dialogDropdown"
                        selectedOptions={[normalizeFolderPath(editFileDraft.directoryPath) || ROOT_FOLDER_OPTION_VALUE]}
                        value={normalizeFolderPath(editFileDraft.directoryPath) || "根目录"}
                        onOptionSelect={(_, data) => setEditFileDraft((prev) => ({
                          ...prev,
                          directoryPath: data.optionValue === ROOT_FOLDER_OPTION_VALUE ? "" : normalizeFolderPath(data.optionValue || "")
                        }))}
                      >
                        {editFolderOptions.map((optionPath) => (
                          <Option key={optionPath || ROOT_FOLDER_OPTION_VALUE} value={optionPath || ROOT_FOLDER_OPTION_VALUE}>
                            {optionPath || "根目录"}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>
                    <Field className="filterField filterControl dialogField" label="目标目录">
                      <Input className="filterInput dialogInput" value={editFileDraft.directoryPath} onChange={(_, data) => setEditFileDraft((prev) => ({ ...prev, directoryPath: normalizeFolderPath(data.value) }))} placeholder="例如 media/photos 或留空放在根目录" />
                    </Field>
                    <Field className="filterField filterControl dialogField" label="栏目">
                      <Dropdown
                        className="filterDropdown dialogDropdown"
                        selectedOptions={editFileDraft.columnId ? [editFileDraft.columnId] : ["none"]}
                        value={getColumnDisplayValue(editFileDraft.columnId || "none")}
                        onOptionSelect={(_, data) => setEditFileDraft((prev) => ({ ...prev, columnId: data.optionValue === "none" ? "" : data.optionValue || "" }))}
                      >
                        <Option value="none">未分类</Option>
                        {columns.map((item) => (
                          <Option key={item.id} value={item.id}>{item.name}</Option>
                        ))}
                      </Dropdown>
                    </Field>
                    <div className="editMimeBlock">
                      <Field className="filterField filterControl dialogField" label="文件类型预设">
                        <Dropdown
                          className="filterDropdown dialogDropdown"
                          selectedOptions={[editFileDraft.mimeAdvanced ? "custom" : (editFileDraft.mimePreset || "application/octet-stream")]}
                          value={editFileDraft.mimeAdvanced ? "高级自定义" : getMimeDisplayValue(editFileDraft.mimePreset || editFileDraft.mimeType)}
                          onOptionSelect={(_, data) => {
                            const nextValue = data.optionValue || "application/octet-stream";
                            if (nextValue === "custom") {
                              setEditFileDraft((prev) => ({ ...prev, mimeAdvanced: true, mimePreset: "custom" }));
                              return;
                            }
                            setEditFileDraft((prev) => ({ ...prev, mimeAdvanced: false, mimePreset: nextValue, mimeType: nextValue }));
                          }}
                        >
                          {MIME_PRESET_OPTIONS.map((item) => (
                            <Option key={item.value} value={item.value}>{item.label}</Option>
                          ))}
                          <Option value="custom">高级自定义</Option>
                        </Dropdown>
                      </Field>
                      <div className="editMimeActions">
                        <Button size="small" className="dialogActionButton" appearance={editFileDraft.mimeAdvanced ? "primary" : "secondary"} icon={<EditRegular />} onClick={() => setEditFileDraft((prev) => ({ ...prev, mimeAdvanced: !prev.mimeAdvanced, mimePreset: !prev.mimeAdvanced ? "custom" : (findMimePreset(prev.mimeType || "")?.value || "application/octet-stream") }))}>
                          {editFileDraft.mimeAdvanced ? "关闭高级输入" : "高级输入"}
                        </Button>
                        <Caption1>{editFileDraft.mimeAdvanced ? "可手动填写任意 MIME 类型" : "优先使用预设类型，减少误填"}</Caption1>
                      </div>
                      {editFileDraft.mimeAdvanced && (
                        <Field className="filterField filterControl dialogField" label="自定义 MIME 类型">
                          <Input className="filterInput dialogInput" value={editFileDraft.mimeType} onChange={(_, data) => setEditFileDraft((prev) => ({ ...prev, mimeType: data.value }))} placeholder="例如 application/vnd.custom+json" />
                        </Field>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="row editFileActions">
                <Button className="dialogActionButton dialogIconOnlyButton" icon={<DismissRegular />} aria-label="取消" title="取消" onClick={closeEditFileModal} />
                <Button className="dialogActionButton dialogPrimaryButton" appearance="primary" icon={<EditRegular />} onClick={submitEditFile}>保存修改</Button>
              </div>
            </div>
          </div>
        )}

        {editFolderOpen && editFolderDraft && (
          <div className="overlay dialogOverlayTop" onClick={closeEditFolderModal}>
            <div className="modalWindow createFolderDialog dialogModal" onClick={(event) => event.stopPropagation()}>
              <div className="modalHeader">
                <div>
                  <Subtitle1>重命名文件夹</Subtitle1>
                  <Caption1>{editFolderDraft.currentPath}</Caption1>
                </div>
                <Button size="small" className="dialogActionButton dialogIconOnlyButton" icon={<DismissRegular />} aria-label="关闭" title="关闭" onClick={closeEditFolderModal} />
              </div>
              <Caption1 className="dialogMetaInline">终端：{getClientDisplayName(editFolderDraft.clientId)} · 修改后：{normalizeFolderPath(editFolderDraft.parentPath ? `${editFolderDraft.parentPath}/${String(editFolderDraft.folderName || "").trim()}` : String(editFolderDraft.folderName || "").trim()) || "未填写"}</Caption1>
              <Field className="filterField filterControl dialogField" label="文件夹名称">
                <Input
                  className="filterInput dialogInput"
                  value={editFolderDraft.folderName}
                  onChange={(_, data) => setEditFolderDraft((prev) => ({ ...prev, folderName: data.value }))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submitEditFolder();
                    }
                  }}
                />
              </Field>
              <div className="row editFileActions">
                <Button className="dialogActionButton dialogIconOnlyButton" icon={<DismissRegular />} aria-label="取消" title="取消" onClick={closeEditFolderModal} />
                <Button className="dialogActionButton dialogPrimaryButton" appearance="primary" icon={<EditRegular />} onClick={submitEditFolder}>保存修改</Button>
              </div>
            </div>
          </div>
        )}

        {deleteTarget && (
          <div className="overlay dialogOverlayTop" onClick={() => setDeleteTarget(null)}>
            <div className="modalWindow dangerModal dialogModal" onClick={(event) => event.stopPropagation()}>
              <div className="modalHeader">
                <Subtitle1>删除确认</Subtitle1>
                <Button size="small" className="dialogActionButton dialogIconOnlyButton" icon={<DismissRegular />} aria-label="取消" title="取消" onClick={() => setDeleteTarget(null)} />
              </div>
              {deleteTarget.kind === "batch" ? (
                <>
                  <Text>将删除 {deleteTarget.files.length} 个已选文件</Text>
                  <Caption1>仅会删除当前可见且不在上传中的文件。</Caption1>
                </>
              ) : deleteTarget.kind === "folder" ? (
                <>
                  <Text>文件夹：{deleteTarget.folders?.[0]?.name}</Text>
                  <Caption1>终端：{getClientDisplayName(deleteTarget.folders?.[0]?.singleClientId || "")}</Caption1>
                  <Caption1>路径：{deleteTarget.folders?.[0]?.path}</Caption1>
                  <Caption1>将递归删除该目录下的所有文件和子目录。</Caption1>
                </>
              ) : (
                <>
                  <Text>文件：{deleteTarget.files[0]?.name}</Text>
                  <Caption1>终端：{getClientDisplayName(deleteTarget.files[0]?.clientId || "")}</Caption1>
                  <Caption1>路径：{deleteTarget.files[0]?.path}</Caption1>
                </>
              )}
              {deleteStep === 1 ? (
                <div className="row" style={{ marginTop: 12 }}>
                  <Button className="dialogActionButton dialogIconOnlyButton" icon={<DismissRegular />} aria-label="取消" title="取消" onClick={() => setDeleteTarget(null)} />
                  <Button className="dialogActionButton dialogPrimaryButton" appearance="primary" icon={<ArrowRightRegular />} onClick={() => setDeleteStep(2)}>继续</Button>
                </div>
              ) : (
                <div className="row" style={{ marginTop: 12 }}>
                  <Text>此操作不可恢复，确认删除？</Text>
                  <Button className="dialogActionButton" icon={<ArrowSwapRegular />} onClick={() => setDeleteStep(1)}>返回</Button>
                  <Button className="dialogActionButton dangerButton" appearance="primary" icon={<DeleteRegular />} onClick={confirmDelete}>确认删除</Button>
                </div>
              )}
            </div>
          </div>
        )}

        {createFolderOpen && (
          <div className="overlay dialogOverlayTop" onClick={closeCreateFolderModal}>
            <div className="modalWindow createFolderDialog dialogModal" onClick={(event) => event.stopPropagation()}>
              <div className="modalHeader">
                <div>
                  <Subtitle1>新建文件夹</Subtitle1>
                  <Caption1>{createFolderContext.basePath || "根目录"}</Caption1>
                </div>
                <Button size="small" className="dialogActionButton dialogIconOnlyButton" icon={<DismissRegular />} aria-label="取消" title="取消" onClick={closeCreateFolderModal} disabled={createFolderSaving} />
              </div>
              <div className="editFileForm">
                <Field className="filterField filterControl dialogField" label="目标终端">
                  <Dropdown
                    className="filterDropdown dialogDropdown"
                    selectedOptions={createFolderDraft.clientId ? [createFolderDraft.clientId] : []}
                    value={createFolderDraft.clientId ? getClientDisplayName(createFolderDraft.clientId) : "请选择终端"}
                    onOptionSelect={(_, data) => setCreateFolderDraft((prev) => ({ ...prev, clientId: data.optionValue || "" }))}
                  >
                    {createFolderClientOptions.map((client) => (
                      <Option key={client.id} value={client.id}>{getClientDisplayName(client.id)}</Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field className="filterField filterControl dialogField" label="文件夹名称">
                  <Input
                    className="filterInput dialogInput"
                    value={createFolderDraft.folderName}
                    onChange={(_, data) => setCreateFolderDraft((prev) => ({ ...prev, folderName: data.value }))}
                    placeholder="例如 movies 或 projects"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        submitCreateFolder();
                      }
                    }}
                  />
                </Field>
              </div>
              <Caption1 className="dialogMetaInline">将创建为：{normalizeFolderPath(createFolderContext.basePath ? `${createFolderContext.basePath}/${String(createFolderDraft.folderName || "").trim()}` : String(createFolderDraft.folderName || "").trim()) || "未填写"}</Caption1>
              <div className="row editFileActions">
                <Button className="dialogActionButton dialogIconOnlyButton" icon={<DismissRegular />} aria-label="取消" title="取消" onClick={closeCreateFolderModal} disabled={createFolderSaving} />
                <Button className="dialogActionButton dialogPrimaryButton" appearance="primary" icon={<FolderOpenRegular />} onClick={submitCreateFolder} disabled={createFolderSaving || !createFolderClientOptions.length}>
                  {createFolderSaving ? <Spinner size="tiny" /> : "创建文件夹"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {diagnosticsOpen && (
          <div className="overlay drawerOverlay" onClick={() => setDiagnosticsOpen(false)}>
            <div className="modalWindow drawerSheet diagnosticsDrawer" onClick={(event) => event.stopPropagation()}>
              <div className="drawerHandle" />
              <div className="modalHeader">
                <Subtitle1>连接诊断</Subtitle1>
                <div className="row">
                  <Button size="small" className="dialogActionButton" icon={<ArrowSwapRegular />} onClick={() => refreshAll()}>刷新</Button>
                  <Button size="small" className="dialogActionButton dialogIconOnlyButton" icon={<DismissRegular />} aria-label="关闭" title="关闭" onClick={() => setDiagnosticsOpen(false)} />
                </div>
              </div>
              <div className="diagRow">
                <Text>信令 WS</Text>
                <div className="row">
                  <Badge appearance="filled" color={diagnostics.wsState === "open" ? "success" : "informative"}>{diagnostics.wsState}</Badge>
                  <Button
                    size="small"
                    className="dialogActionButton"
                    icon={<ArrowRightRegular />}
                    onClick={() => ensureSignalingReady()}
                  >
                    拉起全部 WS
                  </Button>
                </div>
              </div>
              {diagnostics.wsLastError ? <Caption1>最近WS错误: {diagnostics.wsLastError}</Caption1> : null}
              <Caption1 className="dialogMetaInline">终端 {clients.length} · 在线 {clients.filter((c) => c.status === "online").length} · 中继 {clients.filter((c) => (diagnostics.clients[c.id]?.route || "unknown") === "relay").length} · 重试 {clients.reduce((sum, c) => sum + (diagnostics.clients[c.id]?.retries || 0), 0)}</Caption1>
              <div className="diagList">
                {clients.map((client) => {
                  const diag = diagnostics.clients[client.id] || {};
                  const route = diag.route || "unknown";
                  const routeLabel = getRouteLabel(diag);
                  return (
                    <div key={client.id} className="diagItem">
                      <div className="diagHead">
                        <div>
                          <Text>{client.name || client.id}</Text>
                          <Caption1>{client.id}</Caption1>
                        </div>
                        <div className="row">
                          <Badge appearance="outline" color={getClientStatusColor(client.status)}>{client.status || "unknown"}</Badge>
                          <Badge appearance="outline" color={getRouteColor(diag)}>{routeLabel}</Badge>
                        </div>
                      </div>
                      <div className="diagMetaGrid compact">
                        <Caption1>最近心跳: {formatRelativeTime(client.lastHeartbeatAt)}</Caption1>
                        <Caption1>总重试: {diag.retries || 0}</Caption1>
                        <Caption1>主路由: {routeLabel}</Caption1>
                        <Caption1>活跃角色: {formatPeerRoleSummary(diag) || "暂无"}</Caption1>
                      </div>
                      <div className="diagRoleActions">
                        {P2P_PEER_ROLES.map((role) => renderPeerDiagnosticCard(client.id, role, diag))}
                      </div>
                      <div className="diagActions">
                        <Button size="small" className="dialogActionButton" icon={<ArrowSwapRegular />} onClick={() => Promise.all(P2P_PEER_ROLES.map((role) => p2p?.connectToPeer(client.id, role)))}>全部重连</Button>
                        <Button size="small" className="dialogActionButton" icon={<DismissRegular />} onClick={() => p2p?.closePeer(client.id, true)}>全部断开</Button>
                        <Button
                          size="small"
                          className="dialogActionButton"
                          icon={<CopyRegular />}
                          onClick={async () => {
                            const ok = await copyText(client.id);
                            if (ok) {
                              setMessage("终端ID已复制");
                            }
                          }}
                        >
                          复制ID
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {!clients.length && <Caption1>暂无终端诊断数据</Caption1>}
              </div>
            </div>
          </div>
        )}

        {previewOpen && (
          <Suspense
            fallback={
              <div className="overlay">
                <div className="modalWindow previewModal previewFallbackModal">
                  <Spinner label="正在加载预览模块..." />
                </div>
              </div>
            }
          >
            <PreviewModal
              previewing={previewing}
              previewName={previewName}
              previewMime={previewMime}
              previewPath={previewPath}
              previewClientId={previewClientId}
              previewUrl={previewUrl}
              previewStatusText={previewStatusText}
              previewProgress={previewProgress}
              previewStage={previewStage}
              previewDebug={previewDebug}
              previewHlsSource={previewHlsSource}
              p2p={p2p}
              onSelectHlsProfile={switchPreviewHlsProfile}
              setPreviewHlsSource={setPreviewHlsSource}
              setPreviewDebug={setPreviewDebug}
              setMessage={setMessage}
              setPreviewStatusText={setPreviewStatusText}
              onClose={stopActivePreviewSession}
              onFirstFrame={() => {
                previewFirstFrameRef.current = true;
                setPreviewStatusText("");
                setPreviewDebug((prev) => ({
                  ...prev,
                  firstFrameAt: prev.firstFrameAt || new Date().toLocaleTimeString()
                }));
              }}
              onFavorite={previewTargetFile ? () => toggleFavorite(previewTargetFile.id) : undefined}
              onEdit={previewTargetFile ? () => openEditFile(previewTargetFile) : undefined}
              onShare={previewTargetFile ? () => openShareDialog(previewTargetFile) : undefined}
              onDownload={() => download({ name: previewName, path: previewPath, clientId: previewClientId, mimeType: previewMime })}
              onOpenInLivingRoom={previewTargetFile ? () => openInLivingRoom(previewTargetFile) : undefined}
              getClientDisplayName={getClientDisplayName}
              formatBytes={formatBytes}
              formatRelativeTime={formatRelativeTime}
              isInlinePreviewMime={isInlinePreviewMime}
              authToken={token}
              currentUser={user}
              previewFileId={previewTargetFile?.id || ""}
              favorite={Boolean(previewTargetFile?.favorite)}
              commentsEnabled
            />
          </Suspense>
        )}

        <ProfileDialog
          open={profileOpen}
          user={user}
          p2p={p2p}
          saving={profileSaving}
          onClose={() => setProfileOpen(false)}
          onSave={saveProfile}
        />
      </>
    );
  }

  function renderMobileActivePage() {
    if (activeWorkspaceTab === "more" && moreNavigatedTab) {
      return renderMoreSubPage(moreNavigatedTab);
    }
    if (activeWorkspaceTab === "chat") {
      return (
        <ChatRoom
          authToken={token}
          currentUser={user}
          clients={clients}
          p2p={p2p}
          setMessage={setMessage}
          getClientDisplayName={getClientDisplayName}
          openMediaPreview={preview}
          saveChatAttachmentToLibrary={saveChatAttachmentToLibrary}
        />
      );
    }
    if (activeWorkspaceTab === "overview") return renderOverviewPage();
    if (activeWorkspaceTab === "tv") {
      return (
        <Suspense fallback={<Spinner size="large" />}>
          <TVStream authToken={token} setMessage={setMessage} />
        </Suspense>
      );
    }
    return renderExplorerPage();
  }

  function renderMoreSubPage(tabId) {
    return (
      <div className="mobileSubPage">
        <div className="mobileSubPageHeader">
          <button
            type="button"
            className="mobileBackButton"
            onClick={() => {
              setMoreNavigatedTab(null);
              setMoreSheetOpen(true);
            }}
          >
            ← 更多
          </button>
        </div>
        {tabId === "transfers"     && renderTransfersPage()}
        {tabId === "shares"        && renderSharesPage()}
        {tabId === "terminals"     && renderTerminalsPage()}
        {tabId === "admin-users"   && renderAdminUsersPage()}
        {tabId === "admin-clients" && renderAdminClientsPage()}
      </div>
    );
  }

  function renderMobileLayout() {
    const activeBadge = visibleUploadJobs.length + downloadingCount;
    return (
      <div className="page">
        {renderToastViewport()}
        {/* GlobalMusicPlayer 保持挂载以维持音频实例，CSS 隐藏悬浮 UI */}
        <GlobalMusicPlayer p2p={p2p} clients={clients} user={user} onToast={setMessage} />
        <div className="mobileApp">
          {/* 顶栏 */}
          <header className="mobileTopbar">
            <div className="mobileTopbarBrand">
              <Title3>NAS Console</Title3>
            </div>
            <div className="mobileTopbarActions">
              <button
                type="button"
                className="iconActionButton mobileTopbarAvatarButton"
                title="用户档案"
                aria-label="用户档案"
                onClick={() => setProfileOpen(true)}
              >
                <AvatarFace
                  className="mobileTopbarAvatar"
                  displayName={user.displayName}
                  avatarUrl={user.avatarUrl}
                  avatarClientId={user.avatarClientId}
                  avatarPath={user.avatarPath}
                  avatarFileId={user.avatarFileId}
                  p2p={p2p}
                />
              </button>
              <button
                type="button"
                className="iconActionButton mobileTopbarIconButton"
                title="上传文件"
                aria-label="上传文件"
                onClick={() => setUploadOpen(true)}
              >
                <ArrowDownloadRegular />
              </button>
              <button
                type="button"
                className="iconActionButton mobileTopbarIconButton"
                title="同步索引"
                aria-label="同步索引"
                onClick={() => refreshAll()}
              >
                {loading ? <Spinner size="tiny" /> : <ArrowSwapRegular />}
              </button>
            </div>
          </header>

          {/* 内容区 */}
          <div
            ref={mobilePageContentRef}
            className={`mobilePageContent${activeWorkspaceTab === "chat" ? " chatMode" : ""}`}
          >
            {renderMobileActivePage()}
          </div>

          {/* 迷你音乐栏（有曲目时显示） */}
          <MiniMusicBar />

          {/* 底部导航栏 */}
          <MobileBottomTabBar
            activeTab={activeWorkspaceTab}
            moreSheetOpen={moreSheetOpen}
            onTabChange={handleMobileTabChange}
            explorerBadge={filteredOnlineFiles.length > 0 ? String(filteredOnlineFiles.length) : null}
            moreBadge={activeBadge > 0 ? String(activeBadge) : null}
          />
        </div>

        {/* 更多抽屉（Portal 到 body） */}
        <MobileMoreSheet
          open={moreSheetOpen}
          onClose={() => setMoreSheetOpen(false)}
          onNavigate={handleMoreNavigate}
          user={user}
          transferCount={visibleUploadJobs.length + downloadingCount}
          shareCount={shares.length}
          onlineClientCount={onlineCount}
          onLogout={logout}
        />
        {/* 筛选抽屉（Portal 到 body） */}
        <MobileFilterSheet
          open={filterSheetOpen}
          onClose={() => setFilterSheetOpen(false)}
          keyword={keyword}
          columnFilter={columnFilter}
          typeFilter={typeFilter}
          sortBy={sortBy}
          columns={columns}
          onApply={({ keyword: k, columnFilter: c, typeFilter: t, sortBy: s }) => {
            setKeyword(k);
            setColumnFilter(c);
            setTypeFilter(t);
            setSortBy(s);
            setFilterSheetOpen(false);
          }}
          onReset={() => {
            setKeyword("");
            setColumnFilter("all");
            setTypeFilter("all");
            setSortBy("createdAt");
            setFilterSheetOpen(false);
          }}
        />
        {renderDialogs()}
      </div>
    );
  }

  // 移动端早期返回（在桌面布局之前判断）
  if (isMobile) {
    return renderMobileLayout();
  }

  return (
    <div className="page">
      {renderToastViewport()}
      <div className="shell appShell">
        <header className="appTopbar surfaceCard">
          <div className="topbarStart">
            <button
              type="button"
              className={`workspaceFlyoutTrigger topbarFlyoutTrigger${navExpanded ? " active" : ""}`}
              aria-label={navExpanded ? "收起工作区导航" : "展开工作区导航"}
              title={navExpanded ? "收起工作区导航" : "展开工作区导航"}
              onClick={() => setNavExpanded((prev) => !prev)}
            >
              <AppsListRegular />
            </button>
            <div className="brandBlock">
              <div className="brandIdentity compact">
                <Title3>NAS Console</Title3>
                <GlobalMusicPlayer p2p={p2p} clients={clients} user={user} onToast={setMessage} />
              </div>
            </div>
          </div>
          <div className="topbarActions">
            <button type="button" className="profileTrigger" onClick={() => setProfileOpen(true)}>
              <AvatarFace
                className="profileTriggerAvatar"
                displayName={user.displayName}
                avatarUrl={user.avatarUrl}
                avatarClientId={user.avatarClientId}
                avatarPath={user.avatarPath}
                avatarFileId={user.avatarFileId}
                p2p={p2p}
              />
              <span className="profileTriggerText">
                <Text>{user.displayName} · {user.role === "admin" ? "管理员" : "成员"}</Text>
                <Caption1>{user.email}</Caption1>
              </span>
            </button>
            <button type="button" className="iconActionButton topbarIconButton" title="切换到大屏模式" aria-label="切换到大屏模式" onClick={() => { const w = window.open("/living-room.html", "nas_living_room"); w?.focus(); }}>
              <StreamRegular />
            </button>
            <button type="button" className="iconActionButton topbarIconButton" title="上传文件" aria-label="上传文件" onClick={() => setUploadOpen(true)}>
              <ArrowDownloadRegular className="topbarUploadIcon" />
            </button>
            <button type="button" className="iconActionButton topbarIconButton" title="同步索引" aria-label="同步索引" onClick={() => refreshAll()}>
              {loading ? <Spinner size="tiny" /> : <ArrowSwapRegular />}
            </button>
            <button type="button" className="iconActionButton topbarIconButton" title="退出" aria-label="退出" onClick={logout}>
              <ArrowRightRegular />
            </button>
          </div>
        </header>

        <div className={`workspaceLayout${navExpanded ? " navExpanded" : ""}`}>
          <aside className={`controlRail navRail${navExpanded ? " expanded" : ""}`}>
            <Card className="surfaceCard panelCard workspaceNavCard">
              <div className="workspaceNavHeader">
                <Subtitle1>工作区导航</Subtitle1>
                <Caption1>左侧切换模块，右侧展示对应页面内容。</Caption1>
              </div>
              <div className="workspaceNavList" role="tablist" aria-orientation="vertical">
                {workspaceTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={activeWorkspaceTab === tab.id}
                    className={`workspaceNavButton${activeWorkspaceTab === tab.id ? " active" : ""}`}
                    onClick={() => handleWorkspaceTabSelect(tab.id)}
                    title={tab.label}
                  >
                    <span className="workspaceNavButtonMain">
                      <span className="railSectionIcon workspaceNavIcon" aria-hidden="true">{tab.icon}</span>
                      <span className="workspaceNavText">
                        <span className="workspaceNavLabel">{tab.label}</span>
                      </span>
                    </span>
                    <Badge appearance="outline" color={activeWorkspaceTab === tab.id ? "informative" : "subtle"}>{tab.meta}</Badge>
                  </button>
                ))}
              </div>
            </Card>
          </aside>

          <main className="mainCanvas">
            {renderActiveWorkspacePage()}
          </main>
        </div>

        {renderDialogs()}

      </div>
    </div>
  );
}
