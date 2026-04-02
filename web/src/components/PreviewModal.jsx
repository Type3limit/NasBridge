import { useEffect, useRef, useState } from "react";
import { Badge, Button, Caption1, Dropdown, Input, Option, Spinner, Subtitle1, Text } from "@fluentui/react-components";
import { ArrowDownloadRegular, ArrowDownRegular, ArrowReplyRegular, ArrowUpRegular, BugRegular, ChevronDownRegular, ChevronUpRegular, DismissRegular, EditRegular, EyeRegular, SendRegular, SettingsRegular, ShareRegular, StarFilled, StarRegular } from "@fluentui/react-icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiRequest } from "../api";
import AvatarFace from "./AvatarFace";
import VideoPlayerControls, { VideoDanmakuComposer } from "./VideoPlayerControls";
import VideoViewportSurface from "./VideoViewportSurface";

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

function formatTextPreview(text, mimeType = "") {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized === "application/json" || normalized.endsWith("+json")) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

function isMarkdownPreview({ mimeType = "", previewName = "", previewPath = "" } = {}) {
  const normalizedMime = String(mimeType || "").toLowerCase();
  if (normalizedMime.includes("markdown")) {
    return true;
  }
  const target = `${previewName} ${previewPath}`.toLowerCase();
  return /(^|[\s/\\])[^\s/\\]+\.(md|markdown|mdown|mkd|mdx)$/i.test(target);
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
    if (parts[0] !== "segment" || parts.length < 4) {
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

function getInitials(name = "") {
  const text = String(name || "").trim();
  if (!text) {
    return "NA";
  }
  const parts = text.split(/\s+/).slice(0, 2);
  return parts.map((item) => item[0]?.toUpperCase() || "").join("");
}

function fallbackRelativeTime(value) {
  if (!value) return "刚刚";
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return "刚刚";
  const diff = Date.now() - ts;
  if (diff < 10_000) return "刚刚";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  return `${Math.floor(diff / 86_400_000)}天前`;
}

const DANMAKU_SCROLL_DURATION_MS = 9000;
const DANMAKU_FIXED_DURATION_MS = 4200;
const DANMAKU_SCROLL_LANES = 8;
const DANMAKU_FIXED_LANES = 3;
const DANMAKU_SUBMIT_DEDUPE_WINDOW_MS = 1500;
const VIDEO_SEEK_STEP_SEC = 5;
const DANMAKU_SETTINGS_STORAGE_PREFIX = "nas_preview_danmaku_settings_v1";
const DEFAULT_DANMAKU_SETTINGS = {
  color: "#FFFFFF",
  mode: "scroll",
  visible: true,
  backgroundOpacity: 0.12,
  fontScale: 1,
  textOpacity: 1
};

function clampNumber(value, min, max, fallback = min) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function getDanmakuSettingsStorageKey(currentUser) {
  const userId = String(currentUser?.id || currentUser?.username || currentUser?.name || "guest");
  return `${DANMAKU_SETTINGS_STORAGE_PREFIX}:${userId}`;
}

function loadDanmakuSettings(currentUser) {
  if (typeof window === "undefined") {
    return { ...DEFAULT_DANMAKU_SETTINGS };
  }
  try {
    const raw = window.localStorage.getItem(getDanmakuSettingsStorageKey(currentUser));
    if (!raw) {
      return { ...DEFAULT_DANMAKU_SETTINGS };
    }
    const parsed = JSON.parse(raw);
    return {
      color: /^#([0-9a-f]{6})$/i.test(String(parsed?.color || "").trim()) ? String(parsed.color).trim().toUpperCase() : DEFAULT_DANMAKU_SETTINGS.color,
      mode: ["scroll", "top", "bottom"].includes(String(parsed?.mode || "")) ? String(parsed.mode) : DEFAULT_DANMAKU_SETTINGS.mode,
      visible: parsed?.visible !== false,
      backgroundOpacity: clampNumber(parsed?.backgroundOpacity, 0, 0.9, DEFAULT_DANMAKU_SETTINGS.backgroundOpacity),
      fontScale: clampNumber(parsed?.fontScale, 0.8, 1.6, DEFAULT_DANMAKU_SETTINGS.fontScale),
      textOpacity: clampNumber(parsed?.textOpacity, 0.2, 1, DEFAULT_DANMAKU_SETTINGS.textOpacity)
    };
  } catch {
    return { ...DEFAULT_DANMAKU_SETTINGS };
  }
}

function saveDanmakuSettings(currentUser, settings) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(getDanmakuSettingsStorageKey(currentUser), JSON.stringify(settings));
  } catch {
  }
}

function isEditableTarget(target) {
  const tagName = String(target?.tagName || "").toLowerCase();
  if (target?.isContentEditable) {
    return true;
  }
  if (tagName === "textarea" || tagName === "select") {
    return true;
  }
  if (tagName !== "input") {
    return false;
  }
  const inputType = String(target?.type || "").toLowerCase();
  return !["button", "range", "color", "checkbox", "radio", "file", "submit", "reset"].includes(inputType);
}

function getFullscreenElement() {
  if (typeof document === "undefined") {
    return null;
  }
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

async function requestElementFullscreen(element) {
  if (!element) {
    return;
  }
  if (typeof element.requestFullscreen === "function") {
    await element.requestFullscreen();
    return;
  }
  if (typeof element.webkitRequestFullscreen === "function") {
    await element.webkitRequestFullscreen();
  }
}

async function exitElementFullscreen() {
  if (typeof document === "undefined") {
    return;
  }
  if (typeof document.exitFullscreen === "function") {
    await document.exitFullscreen();
    return;
  }
  if (typeof document.webkitExitFullscreen === "function") {
    await document.webkitExitFullscreen();
  }
}

function toAlphaColor(alpha = 0.12) {
  return `rgba(2, 6, 23, ${clampNumber(alpha, 0, 0.9, 0.12)})`;
}

function formatDanmakuClock(timeSec = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(timeSec || 0)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${minutes}:${seconds}`;
  }
  return `${minutes}:${seconds}`;
}

function normalizeDanmakuItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: String(item?.id || ""),
      fileId: String(item?.fileId || ""),
      content: String(item?.content || "").trim(),
      timeSec: Math.max(0, Number(item?.timeSec || 0)),
      color: /^#([0-9a-f]{6})$/i.test(String(item?.color || "").trim()) ? String(item.color).trim().toUpperCase() : "#FFFFFF",
      mode: ["scroll", "top", "bottom"].includes(String(item?.mode || "")) ? String(item.mode) : "scroll",
      createdAt: String(item?.createdAt || ""),
      updatedAt: String(item?.updatedAt || ""),
      author: {
        id: String(item?.author?.id || ""),
        displayName: String(item?.author?.displayName || "匿名用户"),
        avatarUrl: String(item?.author?.avatarUrl || ""),
        avatarClientId: String(item?.author?.avatarClientId || ""),
        avatarPath: String(item?.author?.avatarPath || ""),
        avatarFileId: String(item?.author?.avatarFileId || "")
      }
    }))
    .filter((item) => item.id && item.content)
    .sort((left, right) => left.timeSec - right.timeSec || left.createdAt.localeCompare(right.createdAt));
}

function mergeDanmakuItems(existing = [], incoming = []) {
  const map = new Map();
  for (const item of normalizeDanmakuItems(existing)) {
    map.set(item.id, item);
  }
  for (const item of normalizeDanmakuItems(incoming)) {
    map.set(item.id, item);
  }
  return [...map.values()].sort((left, right) => left.timeSec - right.timeSec || left.createdAt.localeCompare(right.createdAt));
}

function buildDanmakuSubmitFingerprint({ fileId = "", content = "", timeSec = 0, color = "#FFFFFF", mode = "scroll" } = {}) {
  const snappedTime = Math.round(Math.max(0, Number(timeSec || 0)) * 10) / 10;
  return [
    String(fileId || ""),
    String(content || "").trim(),
    snappedTime.toFixed(1),
    String(color || "#FFFFFF").trim().toUpperCase(),
    String(mode || "scroll").trim()
  ].join("|");
}

export default function PreviewModal({
  previewing,
  previewName,
  previewMime,
  previewPath,
  previewClientId,
  previewUrl,
  previewStatusText,
  previewProgress,
  previewStage,
  previewDebug,
  previewHlsSource,
  p2p,
  onSelectHlsProfile,
  setPreviewHlsSource,
  setPreviewDebug,
  setMessage,
  setPreviewStatusText,
  onClose,
  onFirstFrame,
  onFavorite,
  onEdit,
  onShare,
  onDownload,
  getClientDisplayName,
  formatBytes,
  formatRelativeTime,
  isInlinePreviewMime,
  authToken,
  currentUser,
  previewFileId,
  favorite = false,
  commentsEnabled = false
}) {
  const previewModalRef = useRef(null);
  const previewViewportRef = useRef(null);
  const previewVideoRef = useRef(null);
  const previewHlsRef = useRef(null);
  const hlsReadyRef = useRef(false);
  const [textPreviewContent, setTextPreviewContent] = useState("");
  const [textPreviewError, setTextPreviewError] = useState("");
  const [diagnosticsPopupOpen, setDiagnosticsPopupOpen] = useState(false);
  const [comments, setComments] = useState([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [replyDrafts, setReplyDrafts] = useState({});
  const [replyTargetId, setReplyTargetId] = useState("");
  const [expandedReplies, setExpandedReplies] = useState({});
  const [commentBusyId, setCommentBusyId] = useState("");
  const [commentError, setCommentError] = useState("");
  const [danmakuItems, setDanmakuItems] = useState([]);
  const [danmakuLoading, setDanmakuLoading] = useState(false);
  const [danmakuError, setDanmakuError] = useState("");
  const [danmakuDraft, setDanmakuDraft] = useState("");
  const [danmakuColor, setDanmakuColor] = useState(DEFAULT_DANMAKU_SETTINGS.color);
  const [danmakuMode, setDanmakuMode] = useState(DEFAULT_DANMAKU_SETTINGS.mode);
  const [danmakuVisible, setDanmakuVisible] = useState(DEFAULT_DANMAKU_SETTINGS.visible);
  const [danmakuBackgroundOpacity, setDanmakuBackgroundOpacity] = useState(DEFAULT_DANMAKU_SETTINGS.backgroundOpacity);
  const [danmakuFontScale, setDanmakuFontScale] = useState(DEFAULT_DANMAKU_SETTINGS.fontScale);
  const [danmakuTextOpacity, setDanmakuTextOpacity] = useState(DEFAULT_DANMAKU_SETTINGS.textOpacity);
  const [danmakuSettingsOpen, setDanmakuSettingsOpen] = useState(false);
  const [danmakuSettingsReady, setDanmakuSettingsReady] = useState(false);
  const [danmakuSubmitting, setDanmakuSubmitting] = useState(false);
  const [activeDanmaku, setActiveDanmaku] = useState([]);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoBufferedTime, setVideoBufferedTime] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [pictureInPictureActive, setPictureInPictureActive] = useState(false);
  const [pageFillActive, setPageFillActive] = useState(false);
  const [playerFullscreenActive, setPlayerFullscreenActive] = useState(false);
  const danmakuFiredRef = useRef(new Set());
  const danmakuScrollLaneRef = useRef(0);
  const danmakuTopLaneRef = useRef(0);
  const danmakuBottomLaneRef = useRef(0);
  const danmakuSequenceRef = useRef(0);
  const danmakuTimersRef = useRef(new Map());
  const activeDanmakuIdsRef = useRef(new Set());
  const lastVideoTimeRef = useRef(0);
  const danmakuSubmitRef = useRef({ pending: false, lastFingerprint: "", lastSubmittedAt: 0 });
  const formatCommentTime = typeof formatRelativeTime === "function" ? formatRelativeTime : fallbackRelativeTime;
  const markdownPreview = isMarkdownPreview({ mimeType: previewMime, previewName, previewPath });
  const canUseComments = Boolean(commentsEnabled && authToken && previewFileId);
  const availableHlsProfiles = Array.isArray(previewHlsSource?.availableProfiles) ? previewHlsSource.availableProfiles : [];
  const activeHlsProfile = String(previewHlsSource?.profile || previewDebug?.hlsProfile || "");
  const activeHlsProfileLabel = availableHlsProfiles.find((profile) => String(profile?.id || "") === activeHlsProfile)?.label || activeHlsProfile || "分辨率";
  const canUsePictureInPicture = previewMime.startsWith("video/")
    && typeof document !== "undefined"
    && Boolean(document.pictureInPictureEnabled);

  useEffect(() => {
    const settings = loadDanmakuSettings(currentUser);
    setDanmakuColor(settings.color);
    setDanmakuMode(settings.mode);
    setDanmakuVisible(settings.visible);
    setDanmakuBackgroundOpacity(settings.backgroundOpacity);
    setDanmakuFontScale(settings.fontScale);
    setDanmakuTextOpacity(settings.textOpacity);
    setDanmakuSettingsReady(true);
  }, [currentUser?.id, currentUser?.name, currentUser?.username]);

  useEffect(() => {
    if (!danmakuSettingsReady) {
      return;
    }
    saveDanmakuSettings(currentUser, {
      color: danmakuColor,
      mode: danmakuMode,
      visible: danmakuVisible,
      backgroundOpacity: danmakuBackgroundOpacity,
      fontScale: danmakuFontScale,
      textOpacity: danmakuTextOpacity
    });
  }, [currentUser, danmakuBackgroundOpacity, danmakuColor, danmakuFontScale, danmakuMode, danmakuSettingsReady, danmakuTextOpacity, danmakuVisible]);

  function clearActiveDanmaku() {
    for (const timer of danmakuTimersRef.current.values()) {
      clearTimeout(timer);
    }
    danmakuTimersRef.current.clear();
    activeDanmakuIdsRef.current.clear();
    setActiveDanmaku([]);
  }

  function enqueueDanmaku(item) {
    if (!item?.id || activeDanmakuIdsRef.current.has(item.id)) {
      return;
    }
    const overlayId = `${item.id}:${danmakuSequenceRef.current++}`;
    const isScroll = item.mode === "scroll";
    const lane = isScroll
      ? danmakuScrollLaneRef.current++ % DANMAKU_SCROLL_LANES
      : item.mode === "top"
        ? danmakuTopLaneRef.current++ % DANMAKU_FIXED_LANES
        : danmakuBottomLaneRef.current++ % DANMAKU_FIXED_LANES;
    const durationMs = isScroll ? DANMAKU_SCROLL_DURATION_MS : DANMAKU_FIXED_DURATION_MS;
    const next = {
      ...item,
      overlayId,
      lane,
      durationMs
    };
    activeDanmakuIdsRef.current.add(item.id);
    setActiveDanmaku((prev) => [...prev, next]);
    const timer = window.setTimeout(() => {
      danmakuTimersRef.current.delete(overlayId);
      activeDanmakuIdsRef.current.delete(item.id);
      setActiveDanmaku((prev) => prev.filter((entry) => entry.overlayId !== overlayId));
    }, durationMs + 400);
    danmakuTimersRef.current.set(overlayId, timer);
  }

  useEffect(() => {
    let disposed = false;
    if (previewing || !previewUrl || !isTextPreviewMime(previewMime)) {
      setTextPreviewContent("");
      setTextPreviewError("");
      return () => {
        disposed = true;
      };
    }

    fetch(previewUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`文本预览加载失败: ${response.status}`);
        }
        return response.text();
      })
      .then((text) => {
        if (disposed) {
          return;
        }
        setTextPreviewContent(markdownPreview ? text : formatTextPreview(text, previewMime));
        setTextPreviewError("");
      })
      .catch((error) => {
        if (disposed) {
          return;
        }
        setTextPreviewContent("");
        setTextPreviewError(error?.message || "文本预览加载失败");
      });

    return () => {
      disposed = true;
    };
  }, [markdownPreview, previewMime, previewUrl, previewing]);

  useEffect(() => {
    setDiagnosticsPopupOpen(false);
    setReplyTargetId("");
    setExpandedReplies({});
    setCommentDraft("");
    setReplyDrafts({});
    setCommentError("");
    setDanmakuDraft("");
    setDanmakuError("");
    setDanmakuSettingsOpen(false);
    setDanmakuItems([]);
    setVideoCurrentTime(0);
    setVideoDuration(0);
    setVideoBufferedTime(0);
    setVideoPlaying(false);
    setPageFillActive(false);
    danmakuFiredRef.current = new Set();
    danmakuScrollLaneRef.current = 0;
    danmakuTopLaneRef.current = 0;
    danmakuBottomLaneRef.current = 0;
    lastVideoTimeRef.current = 0;
    clearActiveDanmaku();
  }, [previewFileId, previewClientId, previewPath]);

  useEffect(() => {
    const modal = previewModalRef.current;
    if (!modal) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      modal.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [previewFileId, previewPath, previewMime, previewing]);

  useEffect(() => {
    let disposed = false;
    if (!canUseComments) {
      setComments([]);
      setCommentsLoading(false);
      return () => {
        disposed = true;
      };
    }

    async function loadComments() {
      try {
        setCommentsLoading(true);
        setCommentError("");
        const data = await apiRequest(`/api/file-comments?fileId=${encodeURIComponent(previewFileId)}`, {
          token: authToken
        });
        if (disposed) {
          return;
        }
        setComments(Array.isArray(data.comments) ? data.comments : []);
      } catch (error) {
        if (disposed) {
          return;
        }
        setComments([]);
        setCommentError(error?.message || "评论加载失败");
      } finally {
        if (!disposed) {
          setCommentsLoading(false);
        }
      }
    }

    loadComments();
    return () => {
      disposed = true;
    };
  }, [authToken, canUseComments, previewFileId]);

  useEffect(() => {
    let disposed = false;
    if (!canUseComments || !String(previewMime || "").startsWith("video/")) {
      setDanmakuItems([]);
      setDanmakuLoading(false);
      return () => {
        disposed = true;
      };
    }

    async function loadDanmaku() {
      try {
        setDanmakuLoading(true);
        setDanmakuError("");
        const data = await apiRequest(`/api/file-danmaku?fileId=${encodeURIComponent(previewFileId)}`, {
          token: authToken
        });
        if (disposed) {
          return;
        }
        setDanmakuItems((prev) => mergeDanmakuItems(prev, data.danmaku));
      } catch (error) {
        if (disposed) {
          return;
        }
        setDanmakuItems([]);
        setDanmakuError(error?.message || "弹幕加载失败");
      } finally {
        if (!disposed) {
          setDanmakuLoading(false);
        }
      }
    }

    loadDanmaku();
    return () => {
      disposed = true;
    };
  }, [authToken, canUseComments, previewFileId, previewMime]);

  useEffect(() => {
    if (!p2p || !canUseComments || !String(previewMime || "").startsWith("video/")) {
      return undefined;
    }
    return p2p.onServerMessage((message) => {
      if (message?.type !== "file-danmaku-created" || !message.payload) {
        return;
      }
      const created = normalizeDanmakuItems([message.payload])[0];
      if (!created || created.fileId !== previewFileId) {
        return;
      }
      setDanmakuItems((prev) => mergeDanmakuItems(prev, [created]));
      const currentTime = Number.isFinite(previewVideoRef.current?.currentTime)
        ? Number(previewVideoRef.current.currentTime)
        : Number(videoCurrentTime || 0);
      if (danmakuVisible && Math.abs(currentTime - created.timeSec) <= 0.8 && !danmakuFiredRef.current.has(created.id)) {
        danmakuFiredRef.current.add(created.id);
        enqueueDanmaku(created);
      }
    });
  }, [canUseComments, danmakuVisible, p2p, previewFileId, previewMime, videoCurrentTime]);

  useEffect(() => {
    if (previewing || !previewMime.startsWith("video/")) {
      setPictureInPictureActive(false);
      setPageFillActive(false);
      setPlayerFullscreenActive(false);
      return undefined;
    }
    const video = previewVideoRef.current;
    const syncPictureInPictureState = () => {
      if (typeof document === "undefined") {
        setPictureInPictureActive(false);
        return;
      }
      setPictureInPictureActive(document.pictureInPictureElement === video);
    };
    const syncFullscreenState = () => {
      const fullscreenElement = getFullscreenElement();
      const viewport = previewViewportRef.current;
      setPlayerFullscreenActive(Boolean(fullscreenElement && viewport && (fullscreenElement === viewport || viewport.contains(fullscreenElement))));
    };

    syncPictureInPictureState();
    syncFullscreenState();
    document.addEventListener("fullscreenchange", syncFullscreenState);
    document.addEventListener("webkitfullscreenchange", syncFullscreenState);
    video?.addEventListener("enterpictureinpicture", syncPictureInPictureState);
    video?.addEventListener("leavepictureinpicture", syncPictureInPictureState);

    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      document.removeEventListener("webkitfullscreenchange", syncFullscreenState);
      video?.removeEventListener("enterpictureinpicture", syncPictureInPictureState);
      video?.removeEventListener("leavepictureinpicture", syncPictureInPictureState);
    };
  }, [previewMime, previewing]);

  useEffect(() => {
    return () => {
      hlsReadyRef.current = false;
      clearActiveDanmaku();
      if (previewHlsRef.current) {
        previewHlsRef.current.destroy();
        previewHlsRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (previewing || !previewHlsSource || !p2p) {
      return;
    }

    let disposed = false;
    const video = previewVideoRef.current;
    if (!video) {
      return;
    }

    async function attachHls() {
      try {
        hlsReadyRef.current = false;
        const mod = await import("hls.js");
        const Hls = mod.default;
        if (disposed) {
          return;
        }
        const hasMse = typeof window !== "undefined" && !!(window.MediaSource || window.ManagedMediaSource || window.WebKitMediaSource);
        if (!Hls || (!Hls.isSupported?.() && !hasMse)) {
          setMessage("当前浏览器环境无法附加 HLS，已回退普通预览", "warning");
          setPreviewHlsSource(null);
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
                if (this.aborted || disposed) {
                  return;
                }

                setPreviewDebug((prev) => ({
                  ...prev,
                  lastHlsEvent: `loader:${context.type || "unknown"}`,
                  hlsState: "loading"
                }));

                const parsed = parseP2pHlsSegmentUrl(context.url);
                if (!parsed && typeof context.url === "string" && (/^https?:\/\//i.test(context.url) || /^data:/i.test(context.url))) {
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
                  setPreviewDebug((prev) => ({
                    ...prev,
                    lastError: "",
                    hlsState: /^data:/i.test(context.url) ? "manifest-data-loaded" : "loaded-fallback",
                    lastHlsEvent: /^data:/i.test(context.url) ? "MANIFEST_DATA_URL" : prev.lastHlsEvent
                  }));
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

                const response = await p2p.getHlsSegment(parsed.clientId, parsed.hlsId, parsed.segmentName, {
                  accessToken: previewHlsSource?.accessToken || ""
                });
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
                const isCancelled = this.aborted
                  || disposed
                  || error?.cancelled
                  || error?.intentionalClose
                  || /cancelled|operation cancelled|aborted/i.test(String(error?.message || ""));
                if (isCancelled) {
                  stats.aborted = true;
                  stats.loading.end = performance.now();
                  setPreviewDebug((prev) => ({
                    ...prev,
                    lastHlsEvent: `loader-cancelled:${context?.type || "unknown"}`,
                    hlsState: "cancelled"
                  }));
                  return;
                }
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

        const markHlsReady = () => {
          if (hlsReadyRef.current) {
            return;
          }
          hlsReadyRef.current = true;
          onFirstFrame?.();
        };

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
          if ((video.readyState || 0) >= 2) {
            markHlsReady();
          }
        });
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          setPreviewDebug((prev) => ({ ...prev, hlsState: "frag-buffered", lastHlsEvent: "FRAG_BUFFERED" }));
          markHlsReady();
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
      } catch (error) {
        setPreviewDebug((prev) => ({
          ...prev,
          lastError: error?.message || "hls-init-failed",
          hlsState: "error"
        }));
        setMessage(`HLS 初始化失败，已回退普通预览: ${error?.message || "unknown"}`, "warning");
        setPreviewHlsSource(null);
      }
    }

    attachHls();

    return () => {
      disposed = true;
      hlsReadyRef.current = false;
      if (previewHlsRef.current) {
        previewHlsRef.current.destroy();
        previewHlsRef.current = null;
      }
    };
  }, [previewing, previewHlsSource, p2p, setPreviewDebug, setPreviewHlsSource]);

  useEffect(() => {
    if (previewing || !previewMime.startsWith("video/")) {
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
  }, [previewMime, previewing, setPreviewDebug]);

  useEffect(() => {
    if (previewing || !previewMime.startsWith("video/")) {
      return undefined;
    }
    const video = previewVideoRef.current;
    if (!video) {
      return undefined;
    }

    const syncPlaybackState = () => {
      const currentTime = Number.isFinite(video.currentTime) ? Number(video.currentTime) : 0;
      const duration = Number.isFinite(video.duration) ? Number(video.duration) : 0;
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
      setVideoCurrentTime(currentTime);
      setVideoDuration(duration);
      setVideoBufferedTime(bufferedEnd);
      setVideoPlaying(!video.paused && !video.ended);
    };

    syncPlaybackState();
    video.addEventListener("timeupdate", syncPlaybackState);
    video.addEventListener("loadedmetadata", syncPlaybackState);
    video.addEventListener("durationchange", syncPlaybackState);
    video.addEventListener("progress", syncPlaybackState);
    video.addEventListener("play", syncPlaybackState);
    video.addEventListener("pause", syncPlaybackState);
    video.addEventListener("ended", syncPlaybackState);

    return () => {
      video.removeEventListener("timeupdate", syncPlaybackState);
      video.removeEventListener("loadedmetadata", syncPlaybackState);
      video.removeEventListener("durationchange", syncPlaybackState);
      video.removeEventListener("progress", syncPlaybackState);
      video.removeEventListener("play", syncPlaybackState);
      video.removeEventListener("pause", syncPlaybackState);
      video.removeEventListener("ended", syncPlaybackState);
    };
  }, [previewMime, previewing]);

  useEffect(() => {
    if (previewing || !previewMime.startsWith("video/")) {
      return undefined;
    }
    const video = previewVideoRef.current;
    if (!video) {
      return undefined;
    }

    const syncDanmaku = () => {
      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const previousTime = lastVideoTimeRef.current;
      const rewound = currentTime + 0.8 < previousTime;
      if (rewound) {
        danmakuFiredRef.current = new Set();
        danmakuScrollLaneRef.current = 0;
        danmakuTopLaneRef.current = 0;
        danmakuBottomLaneRef.current = 0;
        clearActiveDanmaku();
      }
      const lowerBound = rewound ? Math.max(0, currentTime - 0.1) : previousTime;
      const upperBound = currentTime + 0.12;
      setVideoCurrentTime(currentTime);
      if (danmakuVisible) {
        for (const item of danmakuItems) {
          if (danmakuFiredRef.current.has(item.id)) {
            continue;
          }
          if (item.timeSec >= lowerBound && item.timeSec <= upperBound) {
            danmakuFiredRef.current.add(item.id);
            enqueueDanmaku(item);
          }
        }
      }
      lastVideoTimeRef.current = currentTime;
    };

    const resetForReplay = () => {
      lastVideoTimeRef.current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      setVideoCurrentTime(lastVideoTimeRef.current);
    };

    video.addEventListener("timeupdate", syncDanmaku);
    video.addEventListener("seeked", syncDanmaku);
    video.addEventListener("loadedmetadata", resetForReplay);
    video.addEventListener("play", syncDanmaku);
    resetForReplay();

    return () => {
      video.removeEventListener("timeupdate", syncDanmaku);
      video.removeEventListener("seeked", syncDanmaku);
      video.removeEventListener("loadedmetadata", resetForReplay);
      video.removeEventListener("play", syncDanmaku);
    };
  }, [danmakuItems, danmakuVisible, previewMime, previewing]);

  useEffect(() => {
    if (previewing || !previewMime.startsWith("video/")) {
      return undefined;
    }

    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isEditableTarget(event.target)) {
        return;
      }
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        toggleVideoPlayback();
        return;
      }
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleVideoPlayback();
        return;
      }
      if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        togglePictureInPicture().catch(() => {});
        return;
      }
      if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        toggleDocumentFullscreen().catch(() => {});
        return;
      }
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        togglePlayerFullscreen().catch(() => {});
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekVideoBy(-VIDEO_SEEK_STEP_SEC);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        seekVideoBy(VIDEO_SEEK_STEP_SEC);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [previewMime, previewing, videoDuration]);

  function seekVideoTo(nextTime) {
    const video = previewVideoRef.current;
    if (!video) {
      return;
    }
    const duration = Number.isFinite(video.duration) ? Number(video.duration) : Number(videoDuration || 0);
    const maxTime = duration > 0 ? duration : Math.max(0, Number(nextTime || 0));
    const safeTime = clampNumber(nextTime, 0, maxTime, 0);
    video.currentTime = safeTime;
    setVideoCurrentTime(safeTime);
  }

  function seekVideoBy(offsetSec) {
    const video = previewVideoRef.current;
    if (!video) {
      return;
    }
    const currentTime = Number.isFinite(video.currentTime) ? Number(video.currentTime) : Number(videoCurrentTime || 0);
    seekVideoTo(currentTime + Number(offsetSec || 0));
  }

  function toggleVideoPlayback() {
    const video = previewVideoRef.current;
    if (!video) {
      return;
    }
    if (video.paused || video.ended) {
      video.play().catch(() => {});
      return;
    }
    video.pause();
  }

  async function togglePictureInPicture() {
    const video = previewVideoRef.current;
    if (!video || typeof document === "undefined" || !document.pictureInPictureEnabled) {
      return;
    }
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture();
      return;
    }
    if (typeof video.requestPictureInPicture === "function") {
      await video.requestPictureInPicture();
    }
  }

  async function toggleDocumentFullscreen() {
    setPageFillActive((prev) => !prev);
  }

  async function togglePlayerFullscreen() {
    const video = previewVideoRef.current;
    const viewport = previewViewportRef.current || video;
    if (!video || !viewport) {
      return;
    }
    const fullscreenElement = getFullscreenElement();
    if (fullscreenElement && (fullscreenElement === viewport || viewport.contains(fullscreenElement))) {
      await exitElementFullscreen();
      return;
    }
    if (typeof video.webkitEnterFullscreen === "function" && typeof viewport.requestFullscreen !== "function") {
      // iOS Safari：直接调 video 原生全屏（自动横屏）
      video.webkitEnterFullscreen();
      return;
    }
    await requestElementFullscreen(viewport);
    // 注意：不调用 screen.orientation.lock()。
    // 在非 PWA 环境（普通网页）中，锁定方向在部分 Android 设备上会触发页面刷新。
    // 横屏显示效果由全屏 CSS (@media orientation:landscape) 控制即可。
  }

  async function submitComment(parentId = null) {
    const draft = parentId ? (replyDrafts[parentId] || "") : commentDraft;
    const content = String(draft || "").trim();
    if (!content || !authToken || !previewFileId) {
      return;
    }
    try {
      setCommentBusyId(parentId || "root");
      setCommentError("");
      const data = await apiRequest("/api/file-comments", {
        method: "POST",
        token: authToken,
        body: {
          fileId: previewFileId,
          parentId,
          content
        }
      });
      setComments(Array.isArray(data.comments) ? data.comments : []);
      if (parentId) {
        setReplyDrafts((prev) => ({ ...prev, [parentId]: "" }));
        setExpandedReplies((prev) => ({ ...prev, [parentId]: true }));
        setReplyTargetId("");
      } else {
        setCommentDraft("");
      }
    } catch (error) {
      setCommentError(error?.message || "评论提交失败");
    } finally {
      setCommentBusyId("");
    }
  }

  async function reactToComment(commentId, value) {
    if (!authToken || !commentId) {
      return;
    }
    try {
      setCommentBusyId(commentId);
      setCommentError("");
      const data = await apiRequest(`/api/file-comments/${encodeURIComponent(commentId)}/reaction`, {
        method: "POST",
        token: authToken,
        body: { value }
      });
      setComments(Array.isArray(data.comments) ? data.comments : []);
    } catch (error) {
      setCommentError(error?.message || "评论互动失败");
    } finally {
      setCommentBusyId("");
    }
  }

  async function submitDanmaku() {
    const content = String(danmakuDraft || "").trim();
    if (!content || !authToken || !previewFileId) {
      return;
    }
    const currentTime = Number.isFinite(previewVideoRef.current?.currentTime)
      ? Number(previewVideoRef.current.currentTime)
      : Number(videoCurrentTime || 0);
    const fingerprint = buildDanmakuSubmitFingerprint({
      fileId: previewFileId,
      content,
      timeSec: currentTime,
      color: danmakuColor,
      mode: danmakuMode
    });
    const now = Date.now();
    if (danmakuSubmitRef.current.pending) {
      return;
    }
    if (
      danmakuSubmitRef.current.lastFingerprint === fingerprint
      && now - danmakuSubmitRef.current.lastSubmittedAt < DANMAKU_SUBMIT_DEDUPE_WINDOW_MS
    ) {
      return;
    }
    try {
      danmakuSubmitRef.current.pending = true;
      setDanmakuSubmitting(true);
      setDanmakuError("");
      const data = await apiRequest("/api/file-danmaku", {
        method: "POST",
        token: authToken,
        body: {
          fileId: previewFileId,
          content,
          timeSec: currentTime,
          color: danmakuColor,
          mode: danmakuMode
        }
      });
      danmakuSubmitRef.current.lastFingerprint = fingerprint;
      danmakuSubmitRef.current.lastSubmittedAt = Date.now();
      setDanmakuItems((prev) => mergeDanmakuItems(prev, data.danmaku));
      setDanmakuDraft("");
      const created = normalizeDanmakuItems([data.item])[0];
      if (created) {
        danmakuFiredRef.current.add(created.id);
        if (danmakuVisible) {
          enqueueDanmaku(created);
        }
      }
    } catch (error) {
      setDanmakuError(error?.message || "弹幕发送失败");
    } finally {
      danmakuSubmitRef.current.pending = false;
      setDanmakuSubmitting(false);
    }
  }

  function handleComposerKeyDown(event, submit) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent?.isComposing) {
      return;
    }
    event.preventDefault();
    submit().catch(() => {});
  }

  function renderDanmakuLayer() {
    if (!danmakuVisible || !activeDanmaku.length) {
      return null;
    }
    return (
      <div className="previewDanmakuLayer" aria-hidden="true">
        {activeDanmaku.map((item) => (
          <div
            key={item.overlayId}
            className={`previewDanmakuItem ${item.mode}`}
            style={{
              color: item.color,
              fontSize: `${Math.round(24 * danmakuFontScale)}px`,
                opacity: danmakuTextOpacity,
              top: item.mode === "scroll" ? `${14 + item.lane * 9}%` : item.mode === "top" ? `${8 + item.lane * 10}%` : "auto",
              bottom: item.mode === "bottom" ? `${10 + item.lane * 10}%` : "auto",
              animationDuration: `${item.durationMs}ms`
            }}
          >
            <span style={{ backgroundColor: toAlphaColor(danmakuBackgroundOpacity) }}>{item.content}</span>
          </div>
        ))}
      </div>
    );
  }

  function renderDanmakuControls() {
    if (!previewMime.startsWith("video/")) {
      return null;
    }
    return (
      <VideoPlayerControls
        currentTime={videoCurrentTime}
        duration={videoDuration}
        bufferedTime={videoBufferedTime}
        playing={videoPlaying}
        pictureInPictureActive={pictureInPictureActive}
        pageFillActive={pageFillActive}
        fullscreenActive={playerFullscreenActive}
        canUsePictureInPicture={canUsePictureInPicture}
        onTogglePlay={toggleVideoPlayback}
        onSeek={seekVideoTo}
        onTogglePictureInPicture={() => togglePictureInPicture().catch(() => {})}
        onTogglePageFill={() => toggleDocumentFullscreen().catch(() => {})}
        onToggleFullscreen={() => togglePlayerFullscreen().catch(() => {})}
      >
        <VideoDanmakuComposer
          danmakuVisible={danmakuVisible}
          danmakuItemsCount={danmakuItems.length}
          danmakuMode={danmakuMode}
          onDanmakuModeChange={setDanmakuMode}
          onToggleDanmakuVisible={() => setDanmakuVisible((prev) => !prev)}
          draft={danmakuDraft}
          onDraftChange={setDanmakuDraft}
          onDraftKeyDown={(event) => handleComposerKeyDown(event, submitDanmaku)}
          danmakuSettingsOpen={danmakuSettingsOpen}
          onToggleDanmakuSettings={() => setDanmakuSettingsOpen((prev) => !prev)}
          danmakuColor={danmakuColor}
          onDanmakuColorChange={setDanmakuColor}
          danmakuBackgroundOpacity={danmakuBackgroundOpacity}
          onDanmakuBackgroundOpacityChange={(value) => setDanmakuBackgroundOpacity(clampNumber(value, 0, 0.9, danmakuBackgroundOpacity))}
          danmakuTextOpacity={danmakuTextOpacity}
          onDanmakuTextOpacityChange={(value) => setDanmakuTextOpacity(clampNumber(value, 0.2, 1, danmakuTextOpacity))}
          danmakuFontScale={danmakuFontScale}
          onDanmakuFontScaleChange={(value) => setDanmakuFontScale(clampNumber(value, 0.8, 1.6, danmakuFontScale))}
          onSubmit={() => submitDanmaku().catch(() => {})}
          sendDisabled={danmakuSubmitting || !authToken || !String(danmakuDraft || "").trim()}
          inputNode={(
            <div className="previewDanmakuInputShell">
              <span className="previewDanmakuInputGlyph" aria-hidden="true">A</span>
              <Input
                className="previewDanmakuInput previewDanmakuInputBili"
                value={danmakuDraft}
                placeholder="发个友善的弹幕见证当下"
                onChange={(_, data) => setDanmakuDraft(data.value)}
                onKeyDown={(event) => handleComposerKeyDown(event, submitDanmaku)}
              />
            </div>
          )}
        />
      </VideoPlayerControls>
    );
  }

  function renderCommentComposer(parentId = null) {
    const draft = parentId ? (replyDrafts[parentId] || "") : commentDraft;
    const busy = commentBusyId === (parentId || "root");
    return (
      <div className={`commentComposer${parentId ? " nested" : ""}`}>
        <Input
          value={draft}
          placeholder={parentId ? "写下回复..." : "写下你对这个文件的看法..."}
          onChange={(_, data) => {
            if (parentId) {
              setReplyDrafts((prev) => ({ ...prev, [parentId]: data.value }));
            } else {
              setCommentDraft(data.value);
            }
          }}
          onKeyDown={(event) => handleComposerKeyDown(event, () => submitComment(parentId))}
        />
        <div className="commentComposerActions">
          {parentId ? <button type="button" className="iconActionButton commentIconButton" onClick={() => setReplyTargetId("")} aria-label="取消回复" title="取消回复"><DismissRegular /></button> : null}
          <button
            type="button"
            className="iconActionButton commentIconButton primary"
            disabled={busy || !String(draft || "").trim()}
            onClick={() => submitComment(parentId)}
            aria-label={parentId ? "发送回复" : "发送评论"}
            title={parentId ? "发送回复" : "发送评论"}
          >
            <SendRegular />
          </button>
        </div>
      </div>
    );
  }

  function renderCommentNode(comment, depth = 0) {
    const hasReplies = Array.isArray(comment.replies) && comment.replies.length > 0;
    const repliesExpanded = !!expandedReplies[comment.id];
    return (
      <div key={comment.id} className={`commentCard depth-${depth}`}>
        <div className="commentHeader">
          <div className="commentAuthorBlock">
            <AvatarFace
              className="commentAvatar"
              displayName={comment.author?.displayName}
              avatarUrl={comment.author?.avatarUrl}
              avatarClientId={comment.author?.avatarClientId}
              avatarPath={comment.author?.avatarPath}
              avatarFileId={comment.author?.avatarFileId}
              p2p={p2p}
            />
            <div className="commentAuthorMeta">
              <Text>{comment.author?.displayName || "匿名用户"}</Text>
              <Caption1>{formatCommentTime(comment.createdAt)}</Caption1>
            </div>
          </div>
          {hasReplies ? <Caption1 className="commentReplyMeta">{comment.replies.length} 条回复</Caption1> : null}
        </div>
        <div className="commentContent">
          <Text>{comment.content}</Text>
        </div>
        <div className="commentActionsBar">
          <button
            type="button"
            className={`iconActionButton commentIconButton${comment.reactions?.currentUserReaction === 1 ? " active" : ""}`}
            disabled={commentBusyId === comment.id}
            onClick={() => reactToComment(comment.id, comment.reactions?.currentUserReaction === 1 ? 0 : 1)}
            aria-label="点赞"
            title="点赞"
          >
            <ArrowUpRegular />
          </button>
          <Caption1>{comment.reactions?.likes || 0}</Caption1>
          <button
            type="button"
            className={`iconActionButton commentIconButton${comment.reactions?.currentUserReaction === -1 ? " active" : ""}`}
            disabled={commentBusyId === comment.id}
            onClick={() => reactToComment(comment.id, comment.reactions?.currentUserReaction === -1 ? 0 : -1)}
            aria-label="点踩"
            title="点踩"
          >
            <ArrowDownRegular />
          </button>
          <Caption1>{comment.reactions?.dislikes || 0}</Caption1>
          <button type="button" className={`iconActionButton commentIconButton${replyTargetId === comment.id ? " active" : ""}`} onClick={() => setReplyTargetId((prev) => prev === comment.id ? "" : comment.id)} aria-label="回复" title="回复">
            <ArrowReplyRegular />
          </button>
          {hasReplies ? (
            <button type="button" className={`iconActionButton commentIconButton${repliesExpanded ? " active" : ""}`} onClick={() => setExpandedReplies((prev) => ({ ...prev, [comment.id]: !prev[comment.id] }))} aria-label={repliesExpanded ? "收起回复" : "展开回复"} title={repliesExpanded ? "收起回复" : "展开回复"}>
              {repliesExpanded ? <ChevronUpRegular /> : <ChevronDownRegular />}
            </button>
          ) : null}
          {hasReplies ? <Caption1>{comment.replies.length}</Caption1> : null}
        </div>
        {replyTargetId === comment.id ? renderCommentComposer(comment.id) : null}
        {hasReplies && repliesExpanded ? (
          <div className="commentReplies">
            {comment.replies.map((reply) => renderCommentNode(reply, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="overlay previewOverlay">
      <div ref={previewModalRef} className={`modalWindow previewModal${pageFillActive ? " pageFillActive" : ""}`} onClick={(event) => event.stopPropagation()} tabIndex={-1}>
        <div className="previewTopBar">
          <div className="previewHeaderMeta">
            <Subtitle1 className="previewHeaderTitle" title={previewName || "文件"}>{previewName || "文件"}</Subtitle1>
            <Caption1 className="previewHeaderMime">{previewMime || "未知类型"}</Caption1>
          </div>
          <div className="previewToolbar">
            {previewHlsSource && availableHlsProfiles.length > 1 ? (
              <Dropdown
                className="filterDropdown dialogDropdown previewResolutionDropdown"
                disabled={previewing}
                size="small"
                selectedOptions={activeHlsProfile ? [activeHlsProfile] : []}
                value={activeHlsProfileLabel}
                aria-label="HLS 分辨率切换"
                title={activeHlsProfileLabel}
                onOptionSelect={(_, data) => {
                  const nextProfileId = String(data.optionValue || "");
                  if (!nextProfileId || nextProfileId === activeHlsProfile) {
                    return;
                  }
                  onSelectHlsProfile?.(nextProfileId);
                }}
              >
                {availableHlsProfiles.map((profile) => {
                  const profileId = String(profile?.id || "");
                  return (
                    <Option key={profileId} value={profileId} text={profile?.label || profileId}>
                      {profile?.label || profileId}
                    </Option>
                  );
                })}
              </Dropdown>
            ) : null}
            {onFavorite ? (
              <button
                type="button"
                className={`iconActionButton previewToolbarButton${favorite ? " active" : ""}`}
                title={favorite ? "取消收藏" : "收藏"}
                aria-label={favorite ? "取消收藏" : "收藏"}
                onClick={onFavorite}
              >
                {favorite ? <StarFilled /> : <StarRegular />}
              </button>
            ) : null}
            {onEdit ? (
              <button type="button" className="iconActionButton previewToolbarButton" title="编辑" aria-label="编辑" onClick={onEdit}>
                <EditRegular />
              </button>
            ) : null}
            {onShare ? (
              <button type="button" className="iconActionButton previewToolbarButton" title="分享" aria-label="分享" onClick={onShare}>
                <ShareRegular />
              </button>
            ) : null}
            <button type="button" className="iconActionButton previewToolbarButton" title="下载" aria-label="下载" onClick={onDownload}>
              <ArrowDownloadRegular />
            </button>
            <div className="previewToolbarPopupWrap">
              <button
                type="button"
                className={`iconActionButton previewToolbarButton${diagnosticsPopupOpen ? " active" : ""}`}
                title="诊断信息"
                aria-label="诊断信息"
                onClick={() => setDiagnosticsPopupOpen((prev) => !prev)}
              >
                <BugRegular />
              </button>
              {diagnosticsPopupOpen ? (
                <div className="previewDiagnosticsPopup" role="dialog" aria-label="诊断信息弹层">
                  <div className="previewDebugPanel compact stacked">
                    <div className="debugHighlightGrid compactGrid">
                      <div className="debugHighlightCard iconStatCard">
                        <span className="previewPanelToggleIcon" aria-hidden="true"><BugRegular /></span>
                        <div>
                          <Caption1>状态</Caption1>
                          <Text>{previewDebug.hlsState || previewStatusText || previewStage || "-"}</Text>
                        </div>
                      </div>
                      <div className="debugHighlightCard iconStatCard">
                        <span className="previewPanelToggleIcon" aria-hidden="true"><ArrowDownloadRegular /></span>
                        <div>
                          <Caption1>分片/流量</Caption1>
                          <Text>{previewDebug.segmentCompleted}/{Math.max(previewDebug.manifestSegments, previewDebug.segmentRequests)} · {formatBytes(previewDebug.segmentBytes || 0)}</Text>
                        </div>
                      </div>
                      <div className="debugHighlightCard iconStatCard">
                        <span className="previewPanelToggleIcon" aria-hidden="true"><EyeRegular /></span>
                        <div>
                          <Caption1>预览终端</Caption1>
                          <Text>{getClientDisplayName(previewClientId || "") || "-"}</Text>
                        </div>
                      </div>
                      <div className="debugHighlightCard iconStatCard wide">
                        <span className="previewPanelToggleIcon" aria-hidden="true"><SettingsRegular /></span>
                        <div>
                          <Caption1>文件路径</Caption1>
                          <Text>{previewPath || "-"}</Text>
                        </div>
                      </div>
                    </div>
                    <div className="previewDebugRow emphasis compactRow">
                      <Caption1>模式 {previewDebug.mode || "-"}</Caption1>
                      <Caption1>缓冲 {previewMime.startsWith("video/") ? `${previewDebug.bufferedAhead.toFixed(1)}s` : "-"}</Caption1>
                    </div>
                    <div className="previewDebugRow emphasis compactRow">
                      <Caption1>首帧 {previewDebug.firstFrameAt || "-"}</Caption1>
                      <Caption1>错误 {previewDebug.segmentErrors || 0}</Caption1>
                    </div>
                    <div className="previewDebugRow emphasis compactRow">
                      <Caption1>当前位置 {formatDanmakuClock(videoCurrentTime || 0)}</Caption1>
                      <Caption1>总时长 {formatDanmakuClock(videoDuration || 0)}</Caption1>
                    </div>
                    {previewDebug.lastError ? (
                      <div className="debugNotice danger compactNotice">
                        <Caption1>最近错误</Caption1>
                        <Text>{previewDebug.lastError}</Text>
                      </div>
                    ) : null}
                    <div className="debugNotice compactNotice">
                      <Caption1>最近事件</Caption1>
                      <Text>{previewDebug.lastHlsEvent || previewDebug.lastSegment || previewStage || "-"}</Text>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <button type="button" className="iconActionButton previewToolbarButton danger" title="关闭" aria-label="关闭" onClick={onClose}>
              <DismissRegular />
            </button>
          </div>
        </div>
        <div className="previewBody">
          <div className={`playerSurface${pageFillActive ? " pageFillActive" : ""}`}>
            {previewing && <Spinner label={previewStatusText || "正在加载预览..."} />}
            {previewing && previewStatusText ? (
              <Caption1>
                {previewStatusText}
                {typeof previewProgress === "number" ? ` (${previewProgress}%)` : ""}
              </Caption1>
            ) : null}
            {previewing && previewStage ? <Caption1 className="previewStage">阶段：{previewStage}</Caption1> : null}
            {!previewing && previewMime.startsWith("video/") && (
              <VideoViewportSurface
                surfaceRef={previewViewportRef}
                className={`previewViewport mediaViewport previewVideoViewport${pageFillActive ? " pageFillActive" : ""}`}
                overlay={renderDanmakuLayer()}
                controls={!previewing ? renderDanmakuControls() : null}
                playing={videoPlaying}
                forceControlsVisible={pageFillActive}
              >
                <div className="previewVideoViewportFrame">
                  <video
                    ref={previewVideoRef}
                    src={previewHlsSource ? undefined : previewUrl}
                    className="preview"
                    onLoadedData={onFirstFrame}
                    onPlaying={onFirstFrame}
                    playsInline
                  />
                </div>
              </VideoViewportSurface>
            )}
            {!previewing && previewMime.startsWith("audio/") && <audio src={previewUrl} controls className="previewAudio" />}
            {!previewing && previewMime.startsWith("image/") && (
              <div className="previewViewport mediaViewport">
                <img src={previewUrl} className="preview" />
              </div>
            )}
            {!previewing && previewMime === "application/pdf" && (
              <div className="previewViewport frameViewport">
                <iframe src={previewUrl} className="previewFrame" title="preview-frame" />
              </div>
            )}
            {!previewing && isTextPreviewMime(previewMime) && !textPreviewError && (
              markdownPreview ? (
                <div className="previewText previewMarkdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />
                    }}
                  >
                    {textPreviewContent}
                  </ReactMarkdown>
                </div>
              ) : (
                <pre className="previewText">{textPreviewContent}</pre>
              )
            )}
            {!previewing && isTextPreviewMime(previewMime) && textPreviewError && (
              <div className="unsupportedPreview">
                <Text>{textPreviewError}</Text>
              </div>
            )}
          </div>

          <aside className="previewSidePanel">
            <div className="previewPanelSection commentsPanel">
              <div className="commentsHeader" title={canUseComments ? "已登录，可评论、回复、点赞和发送弹幕" : authToken ? "当前文件暂不可评论" : "登录后可评论、回复和发送弹幕"}>
                <Subtitle1>文件评论</Subtitle1>
                <Badge appearance="outline" color="informative">{comments.length}</Badge>
              </div>

              {commentError ? (
                <div className="debugNotice danger compactNotice">
                  <Caption1>评论错误</Caption1>
                  <Text>{commentError}</Text>
                </div>
              ) : null}

              <div className="commentsList">
                {commentsLoading ? <Spinner label="正在加载评论..." /> : null}
                {!commentsLoading && canUseComments && !comments.length ? (
                  <div className="commentEmptyCard">
                    <span className="commentEmptyIcon" aria-hidden="true">
                      <ArrowReplyRegular />
                    </span>
                  </div>
                ) : null}
                {!commentsLoading ? comments.map((comment) => renderCommentNode(comment)) : null}
              </div>

              {canUseComments ? renderCommentComposer() : (
                <div className="commentLockedCard">
                  <Text>{authToken ? "当前文件暂不可评论，请稍后重试。" : "检测到登录后，这里会直接切换为可评论和可发送弹幕的预览模式。"}</Text>
                </div>
              )}
            </div>
          </aside>
        </div>
        {!previewing && previewName && !isInlinePreviewMime(previewMime) && (
          <div className="unsupportedPreview">
            <Text>当前文件类型不支持在线预览，请直接下载。</Text>
            <button type="button" className="iconActionButton previewToolbarButton" title="下载" aria-label="下载" onClick={onDownload}>
              <ArrowDownloadRegular />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}