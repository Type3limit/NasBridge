import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Caption1,
  Divider,
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
  ArrowDownloadRegular,
  ChevronDownRegular,
  ChevronUpRegular,
  DeleteRegular,
  EyeRegular,
  StarFilled,
  StarRegular
} from "@fluentui/react-icons";
import { apiRequest } from "./api";
import { P2PBridge } from "./webrtc";

const PreviewModal = lazy(() => import("./components/PreviewModal"));

const THUMB_CACHE_STORAGE_KEY = "nas_thumb_cache_v1";
const THUMB_CACHE_MAX_ITEMS = 120;
const THUMB_CACHE_MAX_BLOB_SIZE = 450 * 1024;
const DESKTOP_STREAM_SAVE_THRESHOLD_BYTES = 512 * 1024 * 1024;
const PREVIEW_FORCE_BLOB_MAX_SIZE = 120 * 1024 * 1024;
const PREVIEW_FIRST_FRAME_TIMEOUT_MS = 8000;
const PREVIEW_HLS_STALL_TIMEOUT_MS = 10000;
const IMAGE_PREVIEW_COMPRESS_THRESHOLD = 6 * 1024 * 1024;

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

function isInlinePreviewMime(mimeType = "") {
  return isImageMime(mimeType) || isVideoMime(mimeType) || isAudioMime(mimeType) || mimeType === "application/pdf";
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

function isGifMime(mimeType = "") {
  return mimeType === "image/gif";
}

function emptyPreviewDebug() {
  return {
    mode: "",
    hlsId: "",
    codec: "",
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
  const [clients, setClients] = useState([]);
  const [users, setUsers] = useState([]);
  const [uploadJobs, setUploadJobs] = useState([]);
  const [downloadJobs, setDownloadJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [viewMode, setViewMode] = useState("grid");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState({ wsState: "idle", clients: {} });
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [authMode, setAuthMode] = useState("login");
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.innerWidth <= 760;
  });

  const [previewing, setPreviewing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
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

  const [columns, setColumns] = useState([]);
  const [keyword, setKeyword] = useState("");
  const [columnFilter, setColumnFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");

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
  const fileListRef = useRef(null);
  const toastTimersRef = useRef(new Map());
  const [listHeight, setListHeight] = useState(520);
  const [listScrollTop, setListScrollTop] = useState(0);

  const [p2p, setP2p] = useState(null);

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
    if (!token) {
      setP2p((prev) => { prev?.dispose(); return null; });
      return;
    }
    const bridge = new P2PBridge(token);
    bridge.connect();
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
    return uploadJobs.filter((job) => {
      if (job.status !== "uploading") {
        return false;
      }
      const alreadyPresent = files.some((file) => file.clientId === job.clientId && file.path === job.relativePath);
      return !alreadyPresent;
    });
  }, [uploadJobs, files]);

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

  const columnMap = useMemo(() => {
    return new Map(columns.map((item) => [item.id, item.name]));
  }, [columns]);

  const filteredOnlineFiles = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return onlineFiles.filter((file) => {
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
  }, [onlineFiles, columnFilter, typeFilter, keyword]);

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
  const categorizedCount = useMemo(
    () => onlineFiles.filter((file) => file.columnId).length,
    [onlineFiles]
  );
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (keyword.trim()) count += 1;
    if (columnFilter !== "all") count += 1;
    if (typeFilter !== "all") count += 1;
    return count;
  }, [keyword, columnFilter, typeFilter]);
  const uploadTargetPreview = useMemo(() => {
    const folderPath = normalizeFolderPath(uploadFolderPath);
    const columnName = columnMap.get(uploadColumnId) || "";
    return normalizeFolderPath([columnName, folderPath].filter(Boolean).join("/"));
  }, [uploadFolderPath, uploadColumnId, columnMap]);
  const spotlightClients = useMemo(() => {
    return [...clients]
      .sort((left, right) => {
        if (left.status === right.status) {
          return (right.lastHeartbeatAt || "").localeCompare(left.lastHeartbeatAt || "");
        }
        return left.status === "online" ? -1 : 1;
      })
      .slice(0, 8);
  }, [clients]);
  const uploadQueuePreview = useMemo(() => visibleUploadJobs.slice(0, 4), [visibleUploadJobs]);
  const downloadQueuePreview = useMemo(() => downloadJobs.slice(0, 4), [downloadJobs]);
  const selectedFiles = useMemo(
    () => onlineFiles.filter((file) => selectedFileIds.includes(file.id)),
    [onlineFiles, selectedFileIds]
  );
  const selectedVisibleFiles = useMemo(
    () => filteredOnlineFiles.filter((file) => selectedFileIds.includes(file.id)),
    [filteredOnlineFiles, selectedFileIds]
  );
  const selectedVisibleAllFavorite = useMemo(
    () => selectedVisibleFiles.length > 0 && selectedVisibleFiles.every((file) => file.favorite),
    [selectedVisibleFiles]
  );
  const allVisibleSelected = useMemo(
    () => filteredOnlineFiles.length > 0 && filteredOnlineFiles.every((file) => selectedFileIds.includes(file.id)),
    [filteredOnlineFiles, selectedFileIds]
  );

  const detailItemHeight = 96;
  const detailOverscan = 6;
  const detailTotal = filteredOnlineFiles.length;
  const detailStart = Math.max(0, Math.floor(listScrollTop / detailItemHeight) - detailOverscan);
  const detailEnd = Math.min(
    detailTotal,
    Math.ceil((listScrollTop + listHeight) / detailItemHeight) + detailOverscan
  );
  const detailSlice = isMobileViewport ? filteredOnlineFiles : filteredOnlineFiles.slice(detailStart, detailEnd);
  const detailPaddingTop = isMobileViewport ? 0 : detailStart * detailItemHeight;
  const detailPaddingBottom = isMobileViewport ? 0 : Math.max(0, (detailTotal - detailEnd) * detailItemHeight);

  function isUploadingFile(file) {
    return uploadingFileKeys.has(`${file.clientId}|${file.path}`);
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

  function setMessage(text, intent = "info") {
    if (!text) {
      return;
    }
    const nextIntent = resolveToastIntent(text, intent);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev.slice(-3), { id, text, intent: nextIntent }]);
    const timer = setTimeout(() => dismissToast(id), nextIntent === "error" ? 5600 : 3600);
    toastTimersRef.current.set(id, timer);
  }

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

  function getTransferDiag(clientId) {
    if (!clientId || typeof clientId !== "string") {
      return {};
    }
    return diagnostics.clients[clientId] || {};
  }

  function renderTransferQueueRow(job, kind) {
    const safeJob = job || {};
    const diag = getTransferDiag(safeJob.clientId);
    const routeLabel = getRouteLabel(diag);
    const speed = kind === "download" ? safeJob.speedBytesPerSec : (safeJob.speedBytesPerSec || 0);
    const progress = Math.max(0, Math.min(100, safeJob.progress || 0));
    const subStatus = kind === "download"
      ? `下载中 · ${typeof safeJob.progress === "number" ? `${safeJob.progress}%` : "-"}`
      : `上传中 · ${typeof safeJob.progress === "number" ? `${safeJob.progress}%` : "-"}`;
    const extraMode = kind === "download"
      ? (safeJob.mode === "direct-save" ? "直存" : safeJob.mode === "mobile" ? "移动端" : "浏览器")
      : "P2P 上传";
    return (
      <div key={`${kind}-${safeJob.id || safeJob.relativePath || safeJob.fileName || "unknown"}`} className="miniListRow queueRow transferQueueRow">
        <div className="miniListMain">
          <Text className="miniListTitle" title={safeJob.fileName || safeJob.relativePath}>{safeJob.fileName || `${kind === "download" ? "下载" : "上传"}任务`}</Text>
          <Caption1>{getClientDisplayName(safeJob.clientId)} · {subStatus}</Caption1>
          <Caption1>
            {typeof safeJob.transferredBytes === "number" && typeof safeJob.size === "number" && safeJob.size > 0
              ? `${formatBytes(safeJob.transferredBytes)} / ${formatBytes(safeJob.size)}`
              : formatBytes(safeJob.transferredBytes || 0)}
            {` · ${formatSpeed(speed)}`}
            {` · ${routeLabel}`}
            {` · ${extraMode}`}
          </Caption1>
          <Caption1>
            候选: {diag.localCandidateType || "-"} {"->"} {diag.remoteCandidateType || "-"}
            {` · 下行 ${formatSpeed(diag.currentRecvBps || 0)}`}
            {` · 上行 ${formatSpeed(diag.currentSendBps || 0)}`}
          </Caption1>
          <div className="uploadProgressBar">
            <div className="uploadProgressInner" style={{ width: `${progress}%` }} />
          </div>
        </div>
        {kind === "download" ? (
          <Button size="small" onClick={() => cancelDownloadJob(safeJob)}>取消</Button>
        ) : (
          <Button size="small" onClick={() => cancelUploadJob(safeJob)}>取消</Button>
        )}
      </div>
    );
  }

  async function navigatePreview(offset) {
    if (!previewOpen || previewing || !onlineFiles.length) {
      return;
    }

    const currentIndex = onlineFiles.findIndex(
      (item) => item.path === previewPath && item.clientId === previewClientId
    );

    if (currentIndex < 0) {
      return;
    }

    const nextIndex = (currentIndex + offset + onlineFiles.length) % onlineFiles.length;
    const target = onlineFiles[nextIndex];
    if (!target) {
      return;
    }
    await preview(target);
  }

  async function refreshAll(currentToken = token) {
    if (!currentToken) return;
    setLoading(true);
    try {
      const me = await apiRequest("/api/me", { token: currentToken });
      setUser(me.profile);

      const [fileData, clientsData, uploadData] = await Promise.all([
        apiRequest("/api/files", { token: currentToken }),
        apiRequest("/api/clients", { token: currentToken }),
        apiRequest("/api/upload-jobs", { token: currentToken })
      ]);

      setFiles(fileData.files);
      setClients(clientsData.clients);
      setUploadJobs(uploadData.jobs || []);
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

  useEffect(() => {
    refreshAll();
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let consecutiveErrors = 0;
    let timer;
    const poll = async () => {
      try {
        const [clientsData, uploadData] = await Promise.all([
          apiRequest("/api/clients", { token }),
          apiRequest("/api/upload-jobs", { token })
        ]);
        setClients(clientsData.clients);
        setUploadJobs(uploadData.jobs || []);
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
  }, [token]);

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
    if (!previewOpen) {
      return;
    }

    const onKeyDown = (event) => {
      const targetTag = String(event.target?.tagName || "").toLowerCase();
      const editable = event.target?.isContentEditable || targetTag === "input" || targetTag === "textarea" || targetTag === "select";
      if (editable) {
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigatePreview(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        navigatePreview(1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [previewOpen, previewing, onlineFiles, previewPath, previewClientId]);

  useEffect(() => {
    const el = fileListRef.current;
    if (!el) {
      return;
    }

    const updateHeight = () => {
      const nextHeight = el.clientHeight || 520;
      setListHeight(nextHeight);
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

  // Pre-establish P2P connections to online clients
  useEffect(() => {
    if (!p2p) return;
    const onlineClients = clients.filter((c) => c.status === "online");
    for (const client of onlineClients) {
      if (!p2p.isPeerConnected(client.id)) {
        p2p.connectToPeer(client.id);
      }
    }
  }, [p2p, clients]);

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
  }, [viewMode, onlineFiles.length]);

  useEffect(() => {
    setSelectedFileIds((prev) => prev.filter((id) => onlineFiles.some((file) => file.id === id)));
  }, [onlineFiles]);

  useEffect(() => {
    if (!uploadOpen) {
      setUploadStep(1);
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

  async function ensureSignalingReady() {
    if (!p2p) {
      return false;
    }
    if (p2p.isSocketOpen()) {
      return true;
    }
    setMessage("信令连接已断开，正在重连...");
    try {
      await p2p.ensureSocketOpen();
      return true;
    } catch {
      setMessage("信令连接不可用，请确认 server 正在运行并稍后重试");
      return false;
    }
  }

  async function download(file) {
    if (!p2p || !ensureClientOnline(file.clientId)) return;
    if (!(await ensureSignalingReady())) return;
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
    if (!(await ensureSignalingReady())) return;
    const sessionId = ++previewSessionIdRef.current;

    if (previewClientId && previewClientId !== file.clientId) {
      p2p.cancelClientChannel(previewClientId, "preview");
    }
    p2p.cancelClientChannel(file.clientId, "preview");

    if (p2p.isClientBusy(file.clientId)) {
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
                profile: "720p",
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
              Math.max(300000, sizeBasedTimeoutMs)
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
              codec: hlsResult.codec || ""
            });
            setPreviewing(false);
            previewModeRef.current = "hls-stream";
            setPreviewDebug((prev) => ({
              ...prev,
              mode: "hls-stream",
              hlsId: hlsResult.hlsId || "",
              codec: hlsResult.codec || prev.codec || ""
            }));
            setPreviewStage("HLS 就绪");
            setMessage("HLS 预览已就绪");
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
          if (import.meta.env.VITE_P2P_DEBUG === "1") {
            console.log("[web-p2p] preview-mode", {
              file: file.name,
              size: file.size,
              needTranscode,
              forceBlobPreview
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
              forceBlob: forceBlobPreview,
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
    if (!(await ensureSignalingReady())) {
      setDeleteTarget(null);
      setDeleteStep(1);
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
        if (p2p?.isClientBusy(target.clientId)) {
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
    if (!(await ensureSignalingReady())) return;

    const folderPath = normalizeFolderPath(uploadFolderPath);
    const columnName = columnMap.get(uploadColumnId) || "";
    const basePath = normalizeFolderPath([columnName, folderPath].filter(Boolean).join("/"));
    setUploadOpen(false);

    let successCount = 0;
    let failedCount = 0;
    let cancelledCount = 0;

    for (const file of uploadFiles) {
      let jobId = "";
      try {
        const targetPath = basePath ? `${basePath}/${file.name}` : file.name;
        const started = await apiRequest("/api/upload-jobs/start", {
          method: "POST",
          token,
          body: {
            clientId: uploadClientId,
            fileName: file.name,
            relativePath: targetPath,
            size: file.size,
            mimeType: file.type || "application/octet-stream",
            columnId: uploadColumnId || "",
            folderPath: folderPath || ""
          }
        });
        if (started?.job) {
          jobId = started.job.id;
          upsertUploadJob(started.job);
        }

        setMessage(`正在上传 ${file.name}...`);
        await p2p.uploadFile(uploadClientId, targetPath, file, {
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
      apiRequest(`/api/upload-jobs/${job.id}/fail`, {
        method: "POST",
        token,
        body: { message: "用户取消上传" }
      }).catch(() => {});
      upsertUploadJob({
        id: job.id,
        status: "failed",
        message: "用户取消上传",
        updatedAt: new Date().toISOString()
      });
    }
    setMessage("上传已取消");
  }

  function toggleFileSelected(fileId) {
    setSelectedFileIds((prev) => (prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]));
  }

  function toggleSelectAllVisible() {
    setSelectedFileIds((prev) => {
      const visibleIds = filteredOnlineFiles.map((file) => file.id);
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
    setUsers([]);
    setClients([]);
    setUploadJobs([]);
    clearPreview();
    setPreviewOpen(false);
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
          <div key={toast.id} className={`toastItem ${toast.intent}`}>
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

  return (
    <div className="page">
      {renderToastViewport()}
      <div className="shell appShell">
        <header className="appTopbar surfaceCard">
          <div className="brandBlock">
            <div className="brandIdentity">
              <div className="brandLogo" aria-hidden="true">
                <span className="brandLogoCore" />
                <span className="brandLogoOrbit orbitA" />
                <span className="brandLogoOrbit orbitB" />
              </div>
              <div>
                <Title3>NAS Console</Title3>
                <Caption1>{user.displayName} · {user.role === "admin" ? "管理员" : "成员"}</Caption1>
              </div>
            </div>
            <div className="brandMetaRow">
              <Badge appearance="outline" color={diagnostics.wsState === "open" ? "success" : "informative"}>WS {diagnostics.wsState || "idle"}</Badge>
              <Badge appearance="outline" color={onlineCount ? "success" : "informative"}>在线终端 {onlineCount}</Badge>
              <Caption1>最近刷新 {formatRelativeTime(lastRefreshAt)}</Caption1>
            </div>
          </div>
          <div className="topbarActions">
            <Button appearance="primary" onClick={() => setUploadOpen(true)}>上传文件</Button>
            <Button onClick={() => refreshAll()}>{loading ? <Spinner size="tiny" /> : "同步索引"}</Button>
            <Button onClick={logout}>退出</Button>
          </div>
        </header>

        <div className="workspaceLayout">
          <aside className="controlRail">
            <Card className="surfaceCard panelCard controlCard commandCard">
              <div className="sectionHeaderCompact">
                <div>
                  <Subtitle1>系统概览</Subtitle1>
                </div>
                <Badge appearance="filled" color={diagnostics.wsState === "open" ? "success" : "informative"}>{diagnostics.wsState || "idle"}</Badge>
              </div>
              <div className="controlActionGrid">
                <Button appearance="primary" onClick={() => setUploadOpen(true)}>发起上传</Button>
                <Button onClick={() => setDiagnosticsOpen(true)}>打开诊断</Button>
                <Button onClick={() => refreshAll()}>{loading ? <Spinner size="tiny" /> : "同步索引"}</Button>
                <Button onClick={() => setViewMode((prev) => prev === "grid" ? "details" : "grid")}>{viewMode === "grid" ? "切到详情" : "切到卡片"}</Button>
              </div>
              <div className="railMetricList">
                <div className="railMetric">
                  <Caption1>信令状态</Caption1>
                  <Text>{diagnostics.wsState || "idle"}</Text>
                </div>
                <div className="railMetric">
                  <Caption1>轮询更新</Caption1>
                  <Text>{formatRelativeTime(lastPollAt)}</Text>
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
              </div>
            </Card>

            <Card className="surfaceCard panelCard controlCard">
              <div className="sectionHeaderCompact">
                <Subtitle1>终端状态</Subtitle1>
                <Badge appearance="outline" color={onlineCount ? "success" : "informative"}>在线 {onlineCount}</Badge>
              </div>
              <div className="miniList">
                {spotlightClients.map((client) => (
                  <div key={client.id} className="miniListRow terminalRow">
                    <div className="miniListMain">
                      <Text className="miniListTitle">{getClientDisplayName(client.id)}</Text>
                      <Caption1>{client.lastHeartbeatAt ? `心跳 ${formatRelativeTime(client.lastHeartbeatAt)}` : "无心跳"}</Caption1>
                    </div>
                    <div className="miniListBadges">
                      <Badge appearance="outline" color={getClientStatusColor(client.status)}>{client.status || "unknown"}</Badge>
                      <Badge appearance="outline" color={(diagnostics.clients[client.id]?.route || "unknown") === "relay" ? "warning" : "informative"}>{diagnostics.clients[client.id]?.route || "unknown"}</Badge>
                    </div>
                  </div>
                ))}
                {!spotlightClients.length && <Caption1>暂无终端数据</Caption1>}
              </div>
            </Card>

            <Card className="surfaceCard panelCard controlCard">
              <div className="sectionHeaderCompact">
                <Subtitle1>传输队列</Subtitle1>
                <Badge appearance="outline" color={visibleUploadJobs.length || downloadingCount ? "warning" : "success"}>{visibleUploadJobs.length + downloadingCount}</Badge>
              </div>
              <div className="miniList">
                          {downloadQueuePreview.map((job) => renderTransferQueueRow(job, "download"))}
                          {uploadQueuePreview.map((job) => renderTransferQueueRow(job, "upload"))}
                {!downloadQueuePreview.length && !uploadQueuePreview.length && <Caption1>当前没有正在传输的任务</Caption1>}
              </div>
            </Card>
          </aside>

          <main className="mainCanvas">
            <section className="filePanel explorerPanel">
              <Card className="surfaceCard panelCard explorerShell">
                <div className="explorerTop">
                  <div className="explorerTitleBlock">
                    <Subtitle1>资源浏览器</Subtitle1>
                  </div>
                  <div className="explorerToolbar">
                    <div className="summaryStrip">
                      <div className="summaryPill">
                        <Caption1>文件</Caption1>
                        <Text>{filteredOnlineFiles.length} / {onlineFiles.length}</Text>
                      </div>
                      <div className="summaryPill">
                        <Caption1>媒体</Caption1>
                        <Text>{mediaFileCount}</Text>
                      </div>
                      <div className="summaryPill">
                        <Caption1>上传中</Caption1>
                        <Text>{visibleUploadJobs.length}</Text>
                      </div>
                    </div>
                    <div className="segmentedControl iconSwitch">
                      <Button
                        size="small"
                        appearance={viewMode === "grid" ? "primary" : "secondary"}
                        onClick={() => setViewMode("grid")}
                        aria-label="卡片模式"
                      >
                        ▦
                      </Button>
                      <Button
                        size="small"
                        appearance={viewMode === "details" ? "primary" : "secondary"}
                        onClick={() => setViewMode("details")}
                        aria-label="详情模式"
                      >
                        ☰
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="filterPanelShell">
                  <div className="filterPanelHeader">
                    <div>
                      <Text>筛选与排序</Text>
                      <Caption1>{activeFilterCount ? `已启用 ${activeFilterCount} 项` : "按需展开"}</Caption1>
                    </div>
                    <div className="row">
                      {activeFilterCount > 0 && <Badge appearance="outline" color="informative">已筛选</Badge>}
                      <Button size="small" onClick={() => setFiltersExpanded((prev) => !prev)} icon={filtersExpanded ? <ChevronUpRegular /> : <ChevronDownRegular />}>
                        {filtersExpanded ? "收起筛选" : "展开筛选"}
                      </Button>
                    </div>
                  </div>
                  {filtersExpanded && (
                    <>
                      <div className="filterWorkbench">
                        <Field className="filterField searchField" label="搜索文件">
                          <Input
                            value={keyword}
                            onChange={(_, data) => setKeyword(data.value)}
                            placeholder="搜索文件名或路径"
                          />
                        </Field>
                        <Field className="filterField columnField" label="栏目">
                          <Dropdown selectedOptions={[columnFilter]} value={columnFilter} onOptionSelect={(_, data) => setColumnFilter(data.optionValue || "all")}>
                            <Option value="all">全部栏目</Option>
                            <Option value="none">未分类</Option>
                            {columns.map((col) => (
                              <Option key={col.id} value={col.id}>{col.name}</Option>
                            ))}
                          </Dropdown>
                        </Field>
                        <Field className="filterField typeField" label="分类">
                          <Dropdown selectedOptions={[typeFilter]} value={typeFilter} onOptionSelect={(_, data) => setTypeFilter(data.optionValue || "all")}>
                            <Option value="all">全部类型</Option>
                            <Option value="image">图片</Option>
                            <Option value="video">视频</Option>
                            <Option value="audio">音频</Option>
                            <Option value="doc">文档</Option>
                            <Option value="other">其他</Option>
                          </Dropdown>
                        </Field>
                        <div className="filterActionBlock filterMetaBlock">
                          <Button size="small" onClick={() => { setKeyword(""); setColumnFilter("all"); setTypeFilter("all"); }}>清空筛选</Button>
                          <Badge appearance="outline" color={columns.length ? "informative" : "subtle"}>栏目 {columns.length}</Badge>
                          <Badge appearance="outline" color={relayCount ? "warning" : "success"}>连接 {relayCount ? "含中继" : "直连优先"}</Badge>
                        </div>
                      </div>
                    </>
                  )}
                </div>

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
                            <Button size="small" appearance="primary" onClick={() => cancelUploadJob(job)}>取消上传</Button>
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
                      {detailSlice.map((file) => (
                        <div key={file.id} className="fileRow">
                          <div className="thumbShell">
                            <button className="thumbButton" onClick={() => preview(file)}>
                              {thumbMap[getThumbKey(file)]?.url ? <img src={thumbMap[getThumbKey(file)].url} className="thumbImg" /> : <div className="thumbFallback">{isUploadingFile(file) ? "上传中" : isImageMime(file.mimeType) ? "图片" : isVideoMime(file.mimeType) ? "视频" : "文件"}</div>}
                            </button>
                            {renderSelectionToggle(file)}
                          </div>
                          <div className="fileMeta">
                            <div className="fileName">{file.name}</div>
                            <div className="fileSub">
                              {file.path} · {formatBytes(file.size)} · {getClientDisplayName(file.clientId)}
                            </div>
                            <div className="fileSub">
                              栏目: {columnMap.get(file.columnId) || "未分类"} · 上传: {formatRelativeTime(file.updatedAt)}
                            </div>
                          </div>
                          <div className="actions">
                            {renderFileActionTray(file)}
                            <Caption1 className="actionHint">点击缩略图可直接预览</Caption1>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {viewMode === "grid" && (
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
                      <Button size="small" appearance="primary" onClick={() => cancelUploadJob(job)}>取消</Button>
                    </div>
                  ))}
                  {filteredOnlineFiles.map((file) => (
                    <div key={file.id} className="gridItem">
                      <div className="fileVisualShell">
                        <button className="gridThumb" onClick={() => preview(file)}>
                          {thumbMap[getThumbKey(file)]?.url ? <img src={thumbMap[getThumbKey(file)].url} className="thumbImg" /> : <div className="thumbFallback">{isUploadingFile(file) ? "上传中" : isImageMime(file.mimeType) ? "图片" : isVideoMime(file.mimeType) ? "视频" : "文件"}</div>}
                        </button>
                        {renderSelectionToggle(file)}
                      </div>
                      <div className="gridName" title={file.name}>{file.name}</div>
                      <Caption1>{getClientDisplayName(file.clientId)}</Caption1>
                      <Caption1>{formatBytes(file.size)}</Caption1>
                      <Caption1>栏目: {columnMap.get(file.columnId) || "未分类"}</Caption1>
                      <Caption1>上传: {formatRelativeTime(file.updatedAt)}</Caption1>
                      <div className="gridCardFooter">
                        {renderFileActionTray(file)}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {!filteredOnlineFiles.length && <Text>暂无可用文件，等待在线存储终端上报。</Text>}
              </Card>
            </section>
          </main>
        </div>

        {uploadOpen && (
          <div className="overlay drawerOverlay" onClick={() => setUploadOpen(false)}>
            <div className="modalWindow uploadModal drawerSheet" onClick={(event) => event.stopPropagation()}>
              <div className="drawerHandle" />
              <div className="modalHeader">
                <Subtitle1>上传文件</Subtitle1>
                <Button size="small" onClick={() => setUploadOpen(false)}>关闭</Button>
              </div>
              <Caption1>目标终端：{getClientDisplayName(uploadClientId) || "未选择"}</Caption1>
              <div className="drawerSteps">
                <div className={`drawerStepBadge${uploadStep === 1 ? " active" : ""}`}>1. 选择目标</div>
                <div className={`drawerStepBadge${uploadStep === 2 ? " active" : ""}`}>2. 路径与文件</div>
              </div>
              {uploadStep === 1 && (
                <div className="drawerSection">
                  <Field label="目标存储终端">
                    <Dropdown selectedOptions={uploadClientId ? [uploadClientId] : []} value={uploadClientId} onOptionSelect={(_, data) => setUploadClientId(data.optionValue || "") }>
                      {clients.map((item) => (
                        <Option key={item.id} value={item.id}>{getClientDisplayName(item.id)}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field label="栏目">
                    <Dropdown selectedOptions={uploadColumnId ? [uploadColumnId] : ["none"]} value={uploadColumnId || "none"} onOptionSelect={(_, data) => setUploadColumnId(data.optionValue === "none" ? "" : data.optionValue || "") }>
                      <Option value="none">未分类</Option>
                      {columns.map((item) => (
                        <Option key={item.id} value={item.id}>{item.name}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <div className="drawerInlineFields">
                    <Input value={columnDraftName} onChange={(_, data) => setColumnDraftName(data.value)} placeholder="需要新栏目时再输入" />
                    <Button size="small" appearance="secondary" onClick={createColumn}>新增栏目</Button>
                  </div>
                  <div className="drawerFooterInline">
                    <Button appearance="primary" disabled={!uploadClientId} onClick={() => setUploadStep(2)}>下一步</Button>
                  </div>
                </div>
              )}
              {uploadStep === 2 && (
                <>
                  <div className="drawerSection">
                    <Field label="目标目录（可选）">
                      <Input value={uploadFolderPath} onChange={(_, data) => setUploadFolderPath(data.value)} placeholder="例如 media/photos" />
                    </Field>
                    <Caption1>最终上传路径会按“栏目 / 目录 / 文件名”的顺序组合。</Caption1>
                  </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hiddenInput"
                onChange={(event) => setUploadFiles(Array.from(event.target.files || []))}
              />
                  <div className="drawerSection">
                    <div className="uploadChooser">
                      <Button appearance="secondary" onClick={() => fileInputRef.current?.click()}>选择文件</Button>
                      <Text>{uploadFiles.length ? `已选择 ${uploadFiles.length} 个文件` : "未选择文件"}</Text>
                    </div>
                    <div className="uploadPlan">
                      <div className="uploadPlanCard">
                        <Caption1>目标终端</Caption1>
                        <Text>{getClientDisplayName(uploadClientId) || "未选择"}</Text>
                      </div>
                      <div className="uploadPlanCard">
                        <Caption1>目标路径</Caption1>
                        <Text>{uploadTargetPreview || "/"}</Text>
                      </div>
                      <div className="uploadPlanCard">
                        <Caption1>预计文件数</Caption1>
                        <Text>{uploadFiles.length}</Text>
                      </div>
                    </div>
                  </div>
              {uploadFiles.length > 0 && (
                <div className="selectedFilesList drawerSection">
                  {uploadFiles.slice(0, 6).map((file) => (
                    <div key={`${file.name}-${file.size}-${file.lastModified}`} className="selectedFileRow">
                      <span className="selectedFileName" title={file.name}>{file.name}</span>
                      <Caption1>{formatBytes(file.size)}</Caption1>
                    </div>
                  ))}
                  {uploadFiles.length > 6 && <Caption1>还有 {uploadFiles.length - 6} 个文件未展开显示</Caption1>}
                </div>
              )}
              <div className="drawerFooter">
                <Button onClick={() => setUploadStep(1)}>上一步</Button>
                <Button appearance="primary" onClick={async () => { await upload(); }}>开始上传</Button>
              </div>
                </>
              )}
            </div>
          </div>
        )}

        {deleteTarget && (
          <div className="overlay" onClick={() => setDeleteTarget(null)}>
            <div className="modalWindow dangerModal" onClick={(event) => event.stopPropagation()}>
              <div className="modalHeader">
                <Subtitle1>删除确认</Subtitle1>
                <Button size="small" onClick={() => setDeleteTarget(null)}>取消</Button>
              </div>
              {deleteTarget.kind === "batch" ? (
                <>
                  <Text>将删除 {deleteTarget.files.length} 个已选文件</Text>
                  <Caption1>仅会删除当前可见且不在上传中的文件。</Caption1>
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
                  <Button onClick={() => setDeleteTarget(null)}>取消</Button>
                  <Button appearance="primary" onClick={() => setDeleteStep(2)}>继续</Button>
                </div>
              ) : (
                <div className="row" style={{ marginTop: 12 }}>
                  <Text>此操作不可恢复，确认删除？</Text>
                  <Button onClick={() => setDeleteStep(1)}>返回</Button>
                  <Button appearance="primary" onClick={confirmDelete}>确认删除</Button>
                </div>
              )}
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
                  <Button size="small" onClick={() => refreshAll()}>刷新</Button>
                  <Button size="small" onClick={() => setDiagnosticsOpen(false)}>关闭</Button>
                </div>
              </div>
              <div className="diagRow">
                <Text>信令 WS</Text>
                <div className="row">
                  <Badge appearance="filled" color={diagnostics.wsState === "open" ? "success" : "informative"}>{diagnostics.wsState}</Badge>
                  <Button
                    size="small"
                    onClick={() => ensureSignalingReady()}
                  >
                    重连 WS
                  </Button>
                </div>
              </div>
              <Caption1>WS URL: {diagnostics.wsUrl || "-"}</Caption1>
              {diagnostics.wsLastError ? <Caption1>最近WS错误: {diagnostics.wsLastError}</Caption1> : null}
              <div className="diagSummary">
                <div>
                  <Caption1>终端总数</Caption1>
                  <Text>{clients.length}</Text>
                </div>
                <div>
                  <Caption1>在线</Caption1>
                  <Text>{clients.filter((c) => c.status === "online").length}</Text>
                </div>
                <div>
                  <Caption1>中继</Caption1>
                  <Text>{clients.filter((c) => (diagnostics.clients[c.id]?.route || "unknown") === "relay").length}</Text>
                </div>
                <div>
                  <Caption1>重试</Caption1>
                  <Text>{clients.reduce((sum, c) => sum + (diagnostics.clients[c.id]?.retries || 0), 0)}</Text>
                </div>
              </div>
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
                      <div className="diagMetaGrid">
                        <Caption1>ICE: {diag.iceState || "new"}</Caption1>
                        <Caption1>Conn: {diag.connectionState || "new"}</Caption1>
                        <Caption1>候选: {diag.localCandidateType || "-"} {"->"} {diag.remoteCandidateType || "-"}</Caption1>
                        <Caption1>最近心跳: {formatRelativeTime(client.lastHeartbeatAt)}</Caption1>
                        <Caption1>重试: {diag.retries || 0}</Caption1>
                        <Caption1>下行吞吐: {formatSpeed(diag.currentRecvBps || 0)}</Caption1>
                        <Caption1>上行吞吐: {formatSpeed(diag.currentSendBps || 0)}</Caption1>
                        <Caption1>累计接收: {formatBytes(diag.totalBytesReceived || 0)}</Caption1>
                        <Caption1>累计发送: {formatBytes(diag.totalBytesSent || 0)}</Caption1>
                      </div>
                      {diag.lastError ? <Caption1>最近错误: {diag.lastError}</Caption1> : null}
                      <div className="diagActions">
                        <Button size="small" onClick={() => p2p?.connectToPeer(client.id)}>重连</Button>
                        <Button size="small" onClick={() => p2p?.closePeer(client.id, true)}>断开</Button>
                        <Button
                          size="small"
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
              onDownload={() => download({ name: previewName, path: previewPath, clientId: previewClientId, mimeType: previewMime })}
              getClientDisplayName={getClientDisplayName}
              formatBytes={formatBytes}
              isInlinePreviewMime={isInlinePreviewMime}
            />
          </Suspense>
        )}

        {user.role === "admin" && (
          <div className="adminGrid">
            <Card className="surfaceCard panelCard">
              <CardHeader header={<Subtitle1>后台管理 - 用户</Subtitle1>} />
              <Divider />
              {users.map((item) => (
                <div key={item.id} className="simpleRow">
                  <div>
                    <div className="fileName">{item.displayName} · {item.role}</div>
                    <div className="fileSub">{item.email}</div>
                  </div>
                </div>
              ))}
            </Card>
            <Card className="surfaceCard panelCard">
              <CardHeader header={<Subtitle1>后台管理 - 存储终端</Subtitle1>} />
              <Divider />
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
                    <Button size="small" onClick={() => p2p?.connectToPeer(item.id)}>重连</Button>
                    <Button size="small" onClick={() => changeClientStatus(item.id, "online")}>启用</Button>
                    <Button size="small" onClick={() => changeClientStatus(item.id, "disabled")}>禁用</Button>
                  </div>
                </div>
              ))}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
