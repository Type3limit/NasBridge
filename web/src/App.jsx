import { useEffect, useMemo, useRef, useState } from "react";
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
  MessageBar,
  Option,
  Spinner,
  Subtitle1,
  Text,
  Title3
} from "@fluentui/react-components";
import Hls from "hls.js";
import { apiRequest } from "./api";
import { P2PBridge } from "./webrtc";

const THUMB_CACHE_STORAGE_KEY = "nas_thumb_cache_v1";
const THUMB_CACHE_MAX_ITEMS = 120;
const THUMB_CACHE_MAX_BLOB_SIZE = 450 * 1024;
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

function buildP2pHlsManifestUrl(clientId, relativePath, hlsId) {
  return `https://p2p-hls.local/manifest/${encodeURIComponent(clientId)}/${encodeURIComponent(hlsId)}/index.m3u8?path=${encodeURIComponent(relativePath || "")}`;
}

function buildP2pHlsSegmentUrl(clientId, hlsId, segmentName) {
  return `https://p2p-hls.local/segment/${encodeURIComponent(clientId)}/${encodeURIComponent(hlsId)}/${encodeURIComponent(segmentName)}`;
}

function parseP2pHlsSegmentUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "p2p-hls.local") {
      return null;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] !== "segment") {
      return null;
    }
    if (parts.length < 4) {
      return null;
    }
    return {
      clientId: decodeURIComponent(parts[1]),
      hlsId: decodeURIComponent(parts[2]),
      segmentName: decodeURIComponent(parts.slice(3).join("/"))
    };
  } catch {
    return null;
  }
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

function createHlsLoaderStats() {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 }
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

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("nas_token") || "");
  const [user, setUser] = useState(null);
  const [files, setFiles] = useState([]);
  const [clients, setClients] = useState([]);
  const [users, setUsers] = useState([]);
  const [uploadJobs, setUploadJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [viewMode, setViewMode] = useState("grid");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState({ wsState: "idle", clients: {} });
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  const [previewing, setPreviewing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteStep, setDeleteStep] = useState(1);
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
  const previewVideoRef = useRef(null);
  const previewHlsRef = useRef(null);
  const previewModeRef = useRef("");
  const previewFirstFrameRef = useRef(false);
  const previewAutoFallbackRef = useRef("");
  const previewHlsFallbackRef = useRef("");
  const previewSessionIdRef = useRef(0);
  const fileInputRef = useRef(null);
  const uploadProgressReportAt = useRef({});
  const fileListRef = useRef(null);
  const [listHeight, setListHeight] = useState(520);
  const [listScrollTop, setListScrollTop] = useState(0);

  const [p2p, setP2p] = useState(null);

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

  const detailItemHeight = 96;
  const detailOverscan = 6;
  const detailTotal = filteredOnlineFiles.length;
  const detailStart = Math.max(0, Math.floor(listScrollTop / detailItemHeight) - detailOverscan);
  const detailEnd = Math.min(
    detailTotal,
    Math.ceil((listScrollTop + listHeight) / detailItemHeight) + detailOverscan
  );
  const detailSlice = filteredOnlineFiles.slice(detailStart, detailEnd);
  const detailPaddingTop = detailStart * detailItemHeight;
  const detailPaddingBottom = Math.max(0, (detailTotal - detailEnd) * detailItemHeight);

  function isUploadingFile(file) {
    return uploadingFileKeys.has(`${file.clientId}|${file.path}`);
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
    const client = clients.find((item) => item.id === clientId);
    const name = (client?.name || "").trim();
    if (!name || name === clientId) {
      return `终端-${clientId.slice(0, 6)}`;
    }
    return name;
  }

  function clearPreview() {
    if (previewHlsRef.current) {
      previewHlsRef.current.destroy();
      previewHlsRef.current = null;
    }
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
    if (!previewOpen || previewing || !previewHlsSource || !p2p) {
      return;
    }
    if (!Hls.isSupported()) {
      setPreviewHlsSource(null);
      return;
    }

    const video = previewVideoRef.current;
    if (!video) {
      return;
    }

    if (previewHlsRef.current) {
      previewHlsRef.current.destroy();
      previewHlsRef.current = null;
    }

    const sourceSnapshot = previewHlsSource;
    const rewrittenManifest = String(sourceSnapshot.manifest || "")
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          return line;
        }
        return buildP2pHlsSegmentUrl(sourceSnapshot.clientId, sourceSnapshot.hlsId, trimmed);
      })
      .join("\n");
    const manifestDataUrl = `data:application/vnd.apple.mpegurl;charset=utf-8,${encodeURIComponent(rewrittenManifest)}`;
    const manifestSegments = String(sourceSnapshot.manifest || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .length;

    setPreviewDebug((prev) => ({
      ...prev,
      mode: "hls-stream",
      hlsId: sourceSnapshot.hlsId || "",
      codec: sourceSnapshot.codec || prev.codec || "",
      manifestSegments,
      segmentRequests: 0,
      segmentCompleted: 0,
      segmentErrors: 0,
      segmentBytes: 0,
      lastSegment: "",
      lastError: "",
      hlsState: "initializing",
      lastHlsEvent: "init"
    }));

    class P2PHlsLoader {
      constructor() {
        this.aborted = false;
        this.context = null;
        this.stats = createHlsLoaderStats();
      }

      load(context, _config, callbacks) {
        this.context = context;
        this.stats = createHlsLoaderStats();
        const stats = this.stats;
        stats.loading.start = performance.now();

        (async () => {
          try {
            if (this.aborted) {
              return;
            }

            setPreviewDebug((prev) => ({
              ...prev,
              lastHlsEvent: `loader:${context.type || "unknown"}`,
              hlsState: "loading"
            }));

            const parsed = parseP2pHlsSegmentUrl(context.url);
            if (!parsed && typeof context.url === "string" && /^https?:\/\//i.test(context.url)) {
              const response = await fetch(context.url);
              if (!response.ok) {
                throw new Error(`http fallback load failed: ${response.status}`);
              }
              const isText = context.type === "manifest" || context.type === "level" || context.type === "audioTrack";
              const data = isText ? await response.text() : await response.arrayBuffer();
              const now = performance.now();
              stats.loading.first = now;
              stats.loading.end = now;
              stats.loaded = isText ? data.length : data.byteLength;
              stats.total = stats.loaded;
              stats.chunkCount = Math.max(1, stats.chunkCount);
              setPreviewDebug((prev) => ({ ...prev, lastError: "", hlsState: "loaded-fallback" }));
              callbacks.onSuccess({ url: context.url, data }, stats, context, null);
              return;
            }

            if (!parsed) {
              throw new Error(`invalid hls url (${context.type || "unknown"}): ${context.url}`);
            }

            setPreviewDebug((prev) => ({
              ...prev,
              segmentRequests: prev.segmentRequests + 1,
              lastSegment: parsed.segmentName,
              hlsState: "segment-loading"
            }));

            const response = await p2p.getHlsSegment(parsed.clientId, parsed.hlsId, parsed.segmentName);
            const data = await response.blob.arrayBuffer();
            const now = performance.now();
            stats.loading.first = stats.loading.first || now;
            stats.loading.end = now;
            stats.loaded = data.byteLength;
            stats.total = data.byteLength;
            stats.chunkCount = Math.max(1, stats.chunkCount + 1);
            setPreviewDebug((prev) => ({
              ...prev,
              segmentCompleted: prev.segmentCompleted + 1,
              segmentBytes: prev.segmentBytes + data.byteLength,
              lastSegment: parsed.segmentName,
              lastError: "",
              hlsState: "segment-loaded"
            }));
            callbacks.onSuccess({ url: context.url, data }, stats, context, null);
          } catch (error) {
            const errorText = error?.message || "hls load failed";
            stats.loading.end = performance.now();
            setPreviewDebug((prev) => ({
              ...prev,
              segmentErrors: prev.segmentErrors + 1,
              lastError: errorText,
              hlsState: "error"
            }));
            callbacks.onError({ code: 0, text: errorText }, context, null, stats);
          }
        })();
      }

      abort() {
        this.aborted = true;
        if (this.stats) {
          this.stats.aborted = true;
          this.stats.loading.end = performance.now();
        }
      }

      destroy() {
        this.aborted = true;
      }
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      fLoader: P2PHlsLoader
    });
    previewHlsRef.current = hls;

    hls.on(Hls.Events.MANIFEST_LOADING, () => {
      setPreviewDebug((prev) => ({ ...prev, hlsState: "manifest-loading", lastHlsEvent: "MANIFEST_LOADING" }));
    });
    hls.on(Hls.Events.MANIFEST_LOADED, () => {
      setPreviewDebug((prev) => ({ ...prev, hlsState: "manifest-loaded", lastHlsEvent: "MANIFEST_LOADED" }));
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setPreviewDebug((prev) => ({ ...prev, hlsState: "manifest-parsed", lastHlsEvent: "MANIFEST_PARSED" }));
      video.play().catch(() => {});
    });
    hls.on(Hls.Events.FRAG_LOADING, (_event, data) => {
      setPreviewDebug((prev) => ({
        ...prev,
        hlsState: "frag-loading",
        lastHlsEvent: `FRAG_LOADING ${data?.frag?.sn ?? "-"}`
      }));
    });
    hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
      setPreviewDebug((prev) => ({
        ...prev,
        hlsState: "frag-loaded",
        lastHlsEvent: `FRAG_LOADED ${data?.frag?.sn ?? "-"}`
      }));
    });
    hls.on(Hls.Events.BUFFER_APPENDED, () => {
      setPreviewDebug((prev) => ({ ...prev, hlsState: "buffer-appended", lastHlsEvent: "BUFFER_APPENDED" }));
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      const detailText = [
        data?.details || data?.type || "unknown",
        data?.reason || "",
        data?.error?.message || ""
      ].filter(Boolean).join(" | ");
      if (!data?.fatal) {
        setPreviewDebug((prev) => ({
          ...prev,
          lastHlsEvent: `ERROR:${detailText || "non-fatal"}`
        }));
        return;
      }
      setPreviewDebug((prev) => ({
        ...prev,
        lastError: `hls-fatal:${detailText || "unknown"}`,
        segmentErrors: prev.segmentErrors + 1,
        hlsState: "fatal-error",
        lastHlsEvent: `FATAL:${detailText || "unknown"}`
      }));
      setMessage(`HLS预览失败: ${detailText || "unknown"}`);
      setPreviewHlsSource(null);
      hls.destroy();
      if (previewHlsRef.current === hls) {
        previewHlsRef.current = null;
      }
    });

    hls.attachMedia(video);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      setPreviewDebug((prev) => ({ ...prev, hlsState: "media-attached", lastHlsEvent: "MEDIA_ATTACHED" }));
      hls.loadSource(manifestDataUrl);
    });

    return () => {
      hls.destroy();
      if (previewHlsRef.current === hls) {
        previewHlsRef.current = null;
      }
    };
  }, [previewOpen, previewing, previewHlsSource, p2p]);

  useEffect(() => {
    if (!previewOpen || previewing || !previewMime.startsWith("video/")) {
      return;
    }
    const video = previewVideoRef.current;
    if (!video) {
      return;
    }

    const timer = setInterval(() => {
      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      let bufferedEnd = currentTime;
      try {
        for (let idx = 0; idx < video.buffered.length; idx += 1) {
          const start = video.buffered.start(idx);
          const end = video.buffered.end(idx);
          if (currentTime >= start && currentTime <= end) {
            bufferedEnd = end;
            break;
          }
          if (end > bufferedEnd) {
            bufferedEnd = end;
          }
        }
      } catch {
      }
      setPreviewDebug((prev) => ({
        ...prev,
        currentTime,
        duration,
        bufferedAhead: Math.max(0, bufferedEnd - currentTime)
      }));
    }, 500);

    return () => clearInterval(timer);
  }, [previewOpen, previewing, previewMime]);

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
        return [job, ...prev].slice(0, 120);
      }
      const next = [...prev];
      const merged = { ...next[idx], ...job };
      if (merged.status === "uploading") {
        merged.progress = Math.max(next[idx].progress || 0, merged.progress || 0);
        merged.transferredBytes = Math.max(next[idx].transferredBytes || 0, merged.transferredBytes || 0);
      }
      next[idx] = merged;
      return next;
    });
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
    try {
      const canStream = typeof window.showSaveFilePicker === "function" && typeof p2p.downloadFileStream === "function";
      if (canStream) {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: file.name });
          const writable = await handle.createWritable();
          setMessage("正在建立P2P连接并下载...");
          await p2p.downloadFileStream(file.clientId, file.path, { writable });
          setMessage("下载完成（P2P）");
          return;
        } catch (error) {
          if (error?.name === "AbortError") {
            setMessage("已取消保存");
            return;
          }
        }
      }

      setMessage("正在建立P2P连接并下载...");
      const result = await p2p.downloadFile(file.clientId, file.path);
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
      setMessage("下载完成（P2P）");
    } catch (error) {
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

      if (isVideoMime(file.mimeType) || isAudioMime(file.mimeType)) {
        if (isVideoMime(file.mimeType) && !options.forceTranscode && !options.skipHls && Hls.isSupported()) {
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
    setDeleteTarget(file);
    setDeleteStep(1);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    if (!(await ensureSignalingReady())) {
      setDeleteTarget(null);
      setDeleteStep(1);
      return;
    }
    if (p2p?.isClientBusy(deleteTarget.clientId)) {
      setMessage("目标终端当前忙，删除请求已排队，请稍候...");
    }
    try {
      setMessage("正在删除文件...");
      // deleteFile already retries once internally via withPeerRetry.
      await p2p.deleteFile(deleteTarget.clientId, deleteTarget.path);
      if (previewPath === deleteTarget.path && previewClientId === deleteTarget.clientId) {
        clearPreview();
        setPreviewOpen(false);
      }
      setThumbMap((prev) => {
        const next = { ...prev };
        delete next[getThumbKey(deleteTarget)];
        return next;
      });
      delete thumbnailCache.current[getThumbKey(deleteTarget)];
      saveThumbCache(thumbnailCache.current);
      setMessage("文件已删除");
      setDeleteTarget(null);
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
      } catch (error) {
        const isCancelled = /已取消|cancelled/i.test(error?.message || "");
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

    setMessage("上传完成（P2P）");
    await refreshAll();
    setUploadFiles([]);
    setUploadOpen(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function cancelUploadJob(job) {
    if (!p2p || !job?.clientId || !job?.relativePath) return;
    p2p.cancelUpload(job.clientId, job.relativePath);
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

  if (!token || !user) {
    return (
      <div className="page">
        <div className="shell authShell">
          <Card className="surfaceCard">
            <CardHeader header={<Title3>NAS Bridge 登录 / 注册</Title3>} />
            <Field label="邮箱">
              <Input value={email} onChange={(_, data) => setEmail(data.value)} />
            </Field>
            <Field label="密码">
              <Input type="password" value={password} onChange={(_, data) => setPassword(data.value)} />
            </Field>
            <Field label="显示名（注册时必填）">
              <Input value={displayName} onChange={(_, data) => setDisplayName(data.value)} />
            </Field>
            <div className="row">
              <Button appearance="primary" onClick={login}>登录</Button>
              <Button onClick={register}>注册</Button>
            </div>
            {message && <MessageBar>{message}</MessageBar>}
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="shell">
        <div className="header modernHeader">
          <div>
            <Title3>NAS Bridge</Title3>
            <Caption1>{user.displayName}（{user.role}）</Caption1>
          </div>
          <div className="row">
            <button className="onlineBadgeBtn" onClick={() => setDiagnosticsOpen(true)}>
              <Badge appearance="filled" color={clients.some((item) => item.status === "online") ? "success" : "informative"}>
                在线终端 {onlineCount}
              </Badge>
            </button>
            <Button size="small" onClick={() => refreshAll()}>{loading ? <Spinner size="tiny" /> : "刷新"}</Button>
            <Button size="small" onClick={logout}>退出</Button>
          </div>
        </div>

        <div className="statusBar">
          <div className="statusGroup">
            <div className="statusItem">
              <span className={`statusDot ${diagnostics.wsState === "open" ? "ok" : "warn"}`} />
              <Text>WS</Text>
              <Badge appearance="outline" color={diagnostics.wsState === "open" ? "success" : "informative"}>{diagnostics.wsState || "idle"}</Badge>
            </div>
            <div className="statusItem">
              <Text>在线终端</Text>
              <Text className="statusValue">{onlineCount}</Text>
            </div>
            <div className="statusItem">
              <Text>中继</Text>
              <Badge appearance="outline" color={relayCount ? "warning" : "success"}>{relayCount}</Badge>
            </div>
            <div className="statusItem">
              <Text>上传中</Text>
              <Badge appearance="outline" color={uploadingCount ? "informative" : "success"}>{uploadingCount}</Badge>
            </div>
          </div>
          <div className="statusGroup">
            <div className="statusItem">
              <Text>最近刷新</Text>
              <Caption1>{formatRelativeTime(lastRefreshAt)}</Caption1>
            </div>
            <div className="statusItem">
              <Text>轮询更新</Text>
              <Caption1>{formatRelativeTime(lastPollAt)}</Caption1>
            </div>
            <Button size="small" appearance="primary" onClick={() => setDiagnosticsOpen(true)}>诊断面板</Button>
          </div>
        </div>

        {message && <MessageBar className="messageBar">{message}</MessageBar>}

        <div className="contentLayout">
          <section className="filePanel">
            <Card className="surfaceCard panelCard">
              <div className="fileCenterHeader">
                <Subtitle1>文件中心</Subtitle1>
                <div className="row">
                  <Button size="small" appearance={viewMode === "grid" ? "primary" : "secondary"} onClick={() => setViewMode("grid")}>图标模式</Button>
                  <Button size="small" appearance={viewMode === "details" ? "primary" : "secondary"} onClick={() => setViewMode("details")}>详情模式</Button>
                  <Button size="small" appearance="primary" onClick={() => setUploadOpen(true)}>上传文件</Button>
                </div>
              </div>
              <Divider />

              <div className="filterBar">
                <Input
                  value={keyword}
                  onChange={(_, data) => setKeyword(data.value)}
                  placeholder="搜索文件名或路径"
                />
                <Dropdown selectedOptions={[columnFilter]} value={columnFilter} onOptionSelect={(_, data) => setColumnFilter(data.optionValue || "all")}>
                  <Option value="all">全部栏目</Option>
                  <Option value="none">未分类</Option>
                  {columns.map((col) => (
                    <Option key={col.id} value={col.id}>{col.name}</Option>
                  ))}
                </Dropdown>
                <Dropdown selectedOptions={[typeFilter]} value={typeFilter} onOptionSelect={(_, data) => setTypeFilter(data.optionValue || "all")}>
                  <Option value="all">全部类型</Option>
                  <Option value="image">图片</Option>
                  <Option value="video">视频</Option>
                  <Option value="audio">音频</Option>
                  <Option value="doc">文档</Option>
                  <Option value="other">其他</Option>
                </Dropdown>
                <Button size="small" onClick={() => { setKeyword(""); setColumnFilter("all"); setTypeFilter("all"); }}>清空筛选</Button>
              </div>

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
                          <button className="thumbButton" onClick={() => preview(file)}>
                            {thumbMap[getThumbKey(file)]?.url ? <img src={thumbMap[getThumbKey(file)].url} className="thumbImg" /> : <div className="thumbFallback">{isUploadingFile(file) ? "上传中" : isImageMime(file.mimeType) ? "图片" : isVideoMime(file.mimeType) ? "视频" : "文件"}</div>}
                          </button>
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
                            <Button size="small" onClick={() => toggleFavorite(file.id)}>{file.favorite ? "取消收藏" : "收藏"}</Button>
                            <Button size="small" onClick={() => preview(file)}>预览</Button>
                            <Button size="small" onClick={() => download(file)}>下载</Button>
                            <Button size="small" appearance="primary" onClick={() => removeFile(file)}>删除</Button>
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
                      <button className="gridThumb" onClick={() => preview(file)}>
                        {thumbMap[getThumbKey(file)]?.url ? <img src={thumbMap[getThumbKey(file)].url} className="thumbImg" /> : <div className="thumbFallback">{isUploadingFile(file) ? "上传中" : isImageMime(file.mimeType) ? "图片" : isVideoMime(file.mimeType) ? "视频" : "文件"}</div>}
                      </button>
                      <div className="gridName" title={file.name}>{file.name}</div>
                      <Caption1>{getClientDisplayName(file.clientId)}</Caption1>
                      <Caption1>{formatBytes(file.size)}</Caption1>
                      <Caption1>栏目: {columnMap.get(file.columnId) || "未分类"}</Caption1>
                      <Caption1>上传: {formatRelativeTime(file.updatedAt)}</Caption1>
                      <div className="row">
                        <Button size="small" onClick={() => preview(file)}>预览</Button>
                        <Button size="small" onClick={() => download(file)}>下载</Button>
                        <Button size="small" appearance="primary" onClick={() => removeFile(file)}>删除</Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {!filteredOnlineFiles.length && <Text>暂无可用文件，等待在线存储终端上报。</Text>}
            </Card>
          </section>

        </div>

        {uploadOpen && (
          <div className="overlay" onClick={() => setUploadOpen(false)}>
            <div className="modalWindow uploadModal" onClick={(event) => event.stopPropagation()}>
              <div className="modalHeader">
                <Subtitle1>上传文件</Subtitle1>
                <Button size="small" onClick={() => setUploadOpen(false)}>关闭</Button>
              </div>
              <Caption1>目标终端：{getClientDisplayName(uploadClientId) || "未选择"}</Caption1>
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
              <div className="row">
                <Input value={columnDraftName} onChange={(_, data) => setColumnDraftName(data.value)} placeholder="新建栏目名称" />
                <Button size="small" appearance="secondary" onClick={createColumn}>新增栏目</Button>
              </div>
              <Field label="目标目录（可选）">
                <Input value={uploadFolderPath} onChange={(_, data) => setUploadFolderPath(data.value)} placeholder="例如 media/photos" />
              </Field>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hiddenInput"
                onChange={(event) => setUploadFiles(Array.from(event.target.files || []))}
              />
              <div className="uploadChooser">
                <Button appearance="secondary" onClick={() => fileInputRef.current?.click()}>选择文件</Button>
                <Text>{uploadFiles.length ? `已选择 ${uploadFiles.length} 个文件` : "未选择文件"}</Text>
              </div>
              <Button appearance="primary" onClick={async () => { await upload(); }}>开始上传</Button>
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
              <Text>文件：{deleteTarget.name}</Text>
              <Caption1>终端：{getClientDisplayName(deleteTarget.clientId)}</Caption1>
              <Caption1>路径：{deleteTarget.path}</Caption1>
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
          <div className="overlay" onClick={() => setDiagnosticsOpen(false)}>
            <div className="modalWindow" onClick={(event) => event.stopPropagation()}>
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
                  const isRelay = route === "relay";
                  return (
                    <div key={client.id} className="diagItem">
                      <div className="diagHead">
                        <div>
                          <Text>{client.name || client.id}</Text>
                          <Caption1>{client.id}</Caption1>
                        </div>
                        <div className="row">
                          <Badge appearance="outline" color={getClientStatusColor(client.status)}>{client.status || "unknown"}</Badge>
                          <Badge appearance="outline" color={isRelay ? "warning" : route === "direct" ? "success" : "informative"}>{route}</Badge>
                        </div>
                      </div>
                      <div className="diagMetaGrid">
                        <Caption1>ICE: {diag.iceState || "new"}</Caption1>
                        <Caption1>Conn: {diag.connectionState || "new"}</Caption1>
                        <Caption1>候选: {diag.localCandidateType || "-"} {"->"} {diag.remoteCandidateType || "-"}</Caption1>
                        <Caption1>最近心跳: {formatRelativeTime(client.lastHeartbeatAt)}</Caption1>
                        <Caption1>重试: {diag.retries || 0}</Caption1>
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
          <div className="overlay" onClick={() => { stopActivePreviewSession(); }}>
            <div className="modalWindow previewModal" onClick={(event) => event.stopPropagation()}>
              <div className="previewTopBar">
                <div>
                  <Subtitle1>{previewName || "文件"}</Subtitle1>
                  <Caption1>{previewMime || "未知类型"}</Caption1>
                </div>
                <div className="row">
                  <Button size="small" onClick={() => download({ name: previewName, path: previewPath, clientId: previewClientId, mimeType: previewMime })}>下载</Button>
                  <Button size="small" onClick={() => { stopActivePreviewSession(); }}>关闭</Button>
                </div>
              </div>
              <div className="playerSurface">
                {previewing && <Spinner label={previewStatusText || "正在加载预览..."} />}
                {previewing && previewStatusText ? (
                  <Caption1>
                    {previewStatusText}
                    {typeof previewProgress === "number" ? ` (${previewProgress}%)` : ""}
                  </Caption1>
                ) : null}
                {previewing && previewStage ? (
                  <Caption1 className="previewStage">阶段：{previewStage}</Caption1>
                ) : null}
                {!previewing && previewMime.startsWith("video/") && (
                  <video
                    ref={previewVideoRef}
                    src={previewHlsSource ? undefined : previewUrl}
                    controls
                    className="preview"
                    onLoadedData={() => {
                      previewFirstFrameRef.current = true;
                      setPreviewStatusText("");
                      setPreviewDebug((prev) => ({
                        ...prev,
                        firstFrameAt: prev.firstFrameAt || new Date().toLocaleTimeString()
                      }));
                    }}
                    onPlaying={() => {
                      previewFirstFrameRef.current = true;
                    }}
                  />
                )}
                {!previewing && previewMime.startsWith("audio/") && <audio src={previewUrl} controls className="previewAudio" />}
                {!previewing && previewMime.startsWith("image/") && <img src={previewUrl} className="preview" />}
                {!previewing && previewMime === "application/pdf" && <iframe src={previewUrl} className="previewFrame" title="preview-frame" />}
              </div>
              {!previewing && previewMime.startsWith("video/") && (
                <div className="previewDebugPanel">
                  <div className="previewDebugRow">
                    <Caption1>模式：{previewDebug.mode || "-"}</Caption1>
                    <Caption1>HLS ID：{previewDebug.hlsId || "-"}</Caption1>
                    <Caption1>编码器：{previewDebug.codec || "-"}</Caption1>
                    <Caption1>状态：{previewDebug.hlsState || "-"}</Caption1>
                    <Caption1>首帧：{previewDebug.firstFrameAt || "-"}</Caption1>
                  </div>
                  <div className="previewDebugRow">
                    <Caption1>分片：{previewDebug.segmentCompleted}/{Math.max(previewDebug.manifestSegments, previewDebug.segmentRequests)}</Caption1>
                    <Caption1>错误：{previewDebug.segmentErrors}</Caption1>
                    <Caption1>流量：{formatBytes(previewDebug.segmentBytes || 0)}</Caption1>
                    <Caption1>最近分片：{previewDebug.lastSegment || "-"}</Caption1>
                  </div>
                  <div className="previewDebugRow">
                    <Caption1>错误详情：{previewDebug.lastError || "-"}</Caption1>
                  </div>
                  <div className="previewDebugRow">
                    <Caption1>事件：{previewDebug.lastHlsEvent || "-"}</Caption1>
                  </div>
                  <div className="previewDebugRow">
                    <Caption1>播放：{previewDebug.currentTime.toFixed(1)}s / {previewDebug.duration > 0 ? previewDebug.duration.toFixed(1) : "-"}s</Caption1>
                    <Caption1>缓冲前瞻：{previewDebug.bufferedAhead.toFixed(1)}s</Caption1>
                  </div>
                </div>
              )}
              <div className="previewMetaBar">
                <Caption1>终端：{getClientDisplayName(previewClientId || "") || "-"}</Caption1>
                <Caption1 title={previewPath}>{previewPath || "-"}</Caption1>
              </div>
              {!previewing && previewName && !isInlinePreviewMime(previewMime) && (
                <div className="unsupportedPreview">
                  <Text>当前文件类型不支持在线预览，请直接下载。</Text>
                  <Button appearance="primary" size="small" onClick={() => download({ name: previewName, path: previewPath, clientId: previewClientId, mimeType: previewMime })}>下载</Button>
                </div>
              )}
            </div>
          </div>
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
