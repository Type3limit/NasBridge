import { createContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Caption1, Input, Spinner, Text } from "@fluentui/react-components";
import {
  ChevronRightRegular,
  PauseRegular,
  PlayRegular
} from "@fluentui/react-icons";

export const MusicPlayerContext = createContext(null);

const QUEUE_PAGE_SIZE = 20;
const FLOATING_PLAYER_STORAGE_KEY = "nas-global-music-player-position-v2";
const FLOATING_BUTTON_SIZE = 56;
const FLOATING_EDGE_MARGIN = 16;
const FLOATING_SNAP_DISTANCE = 40;
const FLOATING_CARD_TRANSITION_MS = 280;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatDuration(seconds = 0) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${minutes}:${String(remain).padStart(2, "0")}`;
}

function formatProgressLabel(track = null) {
  const percent = Number(track?.progress?.percent);
  const label = String(track?.progress?.label || "").trim();
  if (Number.isFinite(percent)) {
    return label ? `${label} · ${percent}%` : `${percent}%`;
  }
  return label || "等待缓冲";
}

function chooseHostClient(clients = []) {
  return clients.find((item) => item.status === "online") || null;
}

function pickLatestPlayerState(currentState, nextState) {
  if (!nextState) {
    return currentState;
  }
  if (!currentState) {
    return nextState;
  }
  const currentUpdatedAt = Date.parse(String(currentState.updatedAt || "")) || 0;
  const nextUpdatedAt = Date.parse(String(nextState.updatedAt || "")) || 0;
  if (nextUpdatedAt >= currentUpdatedAt) {
    return nextState;
  }
  return currentState;
}

function normalizePlayerStateSnapshot(state) {
  if (!state || typeof state !== "object") {
    return null;
  }
  const queue = Array.isArray(state.queue)
    ? state.queue.map((item, index) => ({
        ...item,
        index
      }))
    : [];
  const currentIndex = Number(state.currentIndex ?? -1);
  const currentTrack = currentIndex >= 0 && currentIndex < queue.length
    ? queue[currentIndex]
    : (state.currentTrack || null);
  return {
    ...state,
    queue,
    currentIndex,
    currentTrack,
    source: String(state.source || currentTrack?.source || "bilibili")
  };
}

function isLikelyFlacTrack(track = null) {
  const ext = String(track?.ext || "").trim().toLowerCase();
  const mimeType = String(track?.mimeType || "").trim().toLowerCase();
  return ext === ".flac" || mimeType.includes("flac");
}

function canBrowserPlayAudioMime(mimeType = "") {
  if (typeof document === "undefined") {
    return true;
  }
  const audio = document.createElement("audio");
  if (!audio || typeof audio.canPlayType !== "function") {
    return true;
  }
  const result = String(audio.canPlayType(String(mimeType || "").trim())).trim().toLowerCase();
  return result === "probably" || result === "maybe";
}

function browserSupportsFlacPlayback() {
  return canBrowserPlayAudioMime("audio/flac") || canBrowserPlayAudioMime("audio/x-flac");
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

function shouldTranscodeTrackForStreaming(track = null, forcedFlacFallbackTrackId = "") {
  const trackId = String(track?.id || "").trim();
  const mimeType = String(track?.mimeType || "").trim().toLowerCase();
  if (isLikelyFlacTrack(track)) {
    return forcedFlacFallbackTrackId === trackId || !browserSupportsFlacPlayback();
  }
  if (!mimeType) {
    return false;
  }
  if (mimeType === "audio/mpeg" || mimeType === "audio/mp3" || mimeType === "audio/mp4" || mimeType === "audio/webm") {
    return false;
  }
  return !canBrowserPlayAudioMime(mimeType);
}

function getFloatingFootprint(element = null) {
  const rect = element?.getBoundingClientRect?.();
  return {
    width: Math.max(FLOATING_BUTTON_SIZE, Math.ceil(Number(rect?.width || FLOATING_BUTTON_SIZE))),
    height: Math.max(FLOATING_BUTTON_SIZE, Math.ceil(Number(rect?.height || FLOATING_BUTTON_SIZE)))
  };
}

function clampFloatingPosition(position = {}, viewportWidth = 0, viewportHeight = 0, footprint = {}) {
  const width = Math.max(0, Number(viewportWidth || 0));
  const height = Math.max(0, Number(viewportHeight || 0));
  const footprintWidth = Math.max(FLOATING_BUTTON_SIZE, Number(footprint?.width || FLOATING_BUTTON_SIZE));
  const footprintHeight = Math.max(FLOATING_BUTTON_SIZE, Number(footprint?.height || FLOATING_BUTTON_SIZE));
  const maxX = Math.max(FLOATING_EDGE_MARGIN, width - footprintWidth - FLOATING_EDGE_MARGIN);
  const maxY = Math.max(FLOATING_EDGE_MARGIN, height - footprintHeight - FLOATING_EDGE_MARGIN);
  const x = clamp(Number(position?.x || 0), FLOATING_EDGE_MARGIN, maxX);
  const y = clamp(Number(position?.y || 0), FLOATING_EDGE_MARGIN, maxY);
  return {
    x,
    y,
    side: x + (footprintWidth / 2) <= width / 2 ? "left" : "right"
  };
}

function snapFloatingPosition(position = {}, viewportWidth = 0, viewportHeight = 0, footprint = {}) {
  const clamped = clampFloatingPosition(position, viewportWidth, viewportHeight, footprint);
  const width = Math.max(0, Number(viewportWidth || 0));
  const footprintWidth = Math.max(FLOATING_BUTTON_SIZE, Number(footprint?.width || FLOATING_BUTTON_SIZE));
  const rightX = Math.max(FLOATING_EDGE_MARGIN, width - footprintWidth - FLOATING_EDGE_MARGIN);
  const distanceLeft = Math.abs(clamped.x - FLOATING_EDGE_MARGIN);
  const distanceRight = Math.abs(clamped.x - rightX);
  let nextX = clamped.x;
  if (Math.min(distanceLeft, distanceRight) <= FLOATING_SNAP_DISTANCE) {
    nextX = distanceLeft <= distanceRight ? FLOATING_EDGE_MARGIN : rightX;
  }
  const side = nextX + (footprintWidth / 2) <= width / 2 ? "left" : "right";
  return {
    x: nextX,
    y: clamped.y,
    side
  };
}

function loadFloatingPosition() {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(FLOATING_PLAYER_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveFloatingPosition(position = null) {
  if (typeof window === "undefined" || !position) {
    return;
  }
  try {
    window.localStorage.setItem(FLOATING_PLAYER_STORAGE_KEY, JSON.stringify(position));
  } catch {
  }
}

export default function GlobalMusicPlayer({ p2p, clients = [], user = null, onToast, children = null }) {
  const hostClient = useMemo(() => chooseHostClient(clients), [clients]);
  const hostClientId = hostClient?.id || "";
  const shellRef = useRef(null);
  const floatingSurfaceRef = useRef(null);
  const audioRef = useRef(null);
  const hlsRef = useRef(null);
  const hlsActiveRef = useRef(false);
  const pollTimerRef = useRef(null);
  const loadTokenRef = useRef(0);
  const loadingAudioKeyRef = useRef("");
  const objectUrlRef = useRef("");
  const objectReleaseRef = useRef(null);
  const seekTimerRef = useRef(null);
  const previousTrackIdRef = useRef("");
  const floatingPositionRef = useRef({ x: FLOATING_EDGE_MARGIN, y: 92, side: "right" });
  const dragRef = useRef(null);
  const suppressToggleRef = useRef(false);

  const [playerState, setPlayerState] = useState(null);
  const [keyword, setKeyword] = useState("");
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [volume, setVolume] = useState(78);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioTrackId, setAudioTrackId] = useState("");
  const [audioError, setAudioError] = useState("");
  const [audioNotice, setAudioNotice] = useState("");
  const [audioNoticeLevel, setAudioNoticeLevel] = useState("");
  const [coverLoadErrorTrackId, setCoverLoadErrorTrackId] = useState("");
  const [forcedFlacFallbackTrackId, setForcedFlacFallbackTrackId] = useState("");
  const [pendingPlaybackTrackId, setPendingPlaybackTrackId] = useState("");
  const [localTime, setLocalTime] = useState(0);
  const [pendingSeek, setPendingSeek] = useState(null);
  const [searching, setSearching] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  const [deckTab, setDeckTab] = useState("queue");
  const [requestBusyId, setRequestBusyId] = useState("");
  const [qqAccount, setQqAccount] = useState(null);
  const [qqLogin, setQqLogin] = useState(null);
  const [searchResults, setSearchResults] = useState([]);
  const [searchError, setSearchError] = useState("");
  const [selectionBusyId, setSelectionBusyId] = useState("");
  const [visibleQueueCount, setVisibleQueueCount] = useState(QUEUE_PAGE_SIZE);
  const [floatingPosition, setFloatingPosition] = useState({ x: FLOATING_EDGE_MARGIN, y: 92, side: "right" });
  const [cardPinnedOpen, setCardPinnedOpen] = useState(false);
  const [cardRendered, setCardRendered] = useState(false);
  const [cardVisible, setCardVisible] = useState(false);
  const [dragging, setDragging] = useState(false);

  const queueItems = Array.isArray(playerState?.queue) ? playerState.queue : [];
  // Who is requesting, liking or withdrawing; the storage node applies the queue rules per person.
  const listenerId = user?.id ? String(user.id) : "";
  const musicActor = useMemo(() => (user?.id ? { id: String(user.id), name: user.displayName || user.email || "", role: user.role || "user" } : null), [user?.id, user?.displayName, user?.email, user?.role]);
  const currentQueueIndex = Number(playerState?.currentIndex ?? -1);
  const derivedCurrentTrack = currentQueueIndex >= 0 && currentQueueIndex < queueItems.length
    ? queueItems[currentQueueIndex]
    : null;
  const currentTrack = derivedCurrentTrack || playerState?.currentTrack || null;
  const currentTrackId = currentTrack?.id || "";
  const currentSource = playerState?.source || currentTrack?.source || "bilibili";
  const transportPosition = Number(playerState?.positionSeconds || 0);
  const currentDuration = Number(currentTrack?.duration || 0);
  const trackWaitingForPlayback = Boolean(currentTrackId && pendingPlaybackTrackId === currentTrackId);
  const showCompactCover = Boolean(currentTrack?.coverUrl && coverLoadErrorTrackId !== currentTrackId);
  const progressValue = pendingSeek ?? (audioTrackId && audioTrackId === currentTrackId ? localTime : (trackWaitingForPlayback ? 0 : transportPosition));
  const progressPercent = currentDuration > 0 ? Math.max(0, Math.min(100, (progressValue / currentDuration) * 100)) : 0;
  const queueCount = queueItems.length;
  const queuedCandidateKeys = useMemo(() => new Set(queueItems.map((item) => `${String(item?.source || "")}:${String(item?.providerTrackId || "")}`)), [queueItems]);
  const cardOpen = !dragging && (cardPinnedOpen || popupOpen);
  const showFloatingCard = cardRendered;

  function getCandidateQueueKey(candidate = null) {
    return `${String(candidate?.source || currentSource || "")}:${String(candidate?.providerTrackId || "")}`;
  }

  async function tryResumeAudioPlayback(options = {}) {
    const audio = audioRef.current;
    if (!audio || !currentTrackId || audioTrackId !== currentTrackId || !playerState?.isPlaying) {
      return false;
    }
    try {
      await audio.play();
      updateAudioError("");
      return true;
    } catch (error) {
      if (options.report !== false) {
        reportAudioEvent("autoplay-blocked", "已重新下载但 audio 播放被拦截，请再点一次播放按钮。", {
          isError: true,
          level: "warn"
        });
      }
      return false;
    }
  }

  function resetSearchState(options = {}) {
    const preserveKeyword = Boolean(options.preserveKeyword);
    setSearchResults([]);
    setSearchError("");
    setSelectionBusyId("");
    if (!preserveKeyword) {
      setKeyword("");
    }
  }

  function closePopup(options = {}) {
    setPopupOpen(false);
    resetSearchState(options);
  }

  function closeFloatingCard(options = {}) {
    setPopupOpen(false);
    setCardPinnedOpen(false);
    resetSearchState(options);
  }

  function updateAudioNotice(message = "") {
    setAudioNotice(String(message || "").trim());
    setAudioNoticeLevel(message ? "warn" : "");
  }

  function updateAudioError(message = "") {
    setAudioError(String(message || "").trim());
    if (message) {
      setAudioNotice("");
      setAudioNoticeLevel("");
    }
  }

  function reportAudioEvent(kind, message = "", options = {}) {
    const text = String(message || "").trim();
    const level = options.level || (options.isError ? "error" : "info");
    const payload = {
      trackId: currentTrackId,
      relativePath: currentTrack?.relativePath || "",
      status: currentTrack?.status || "",
      audioTrackId,
      ready: Boolean(objectUrlRef.current)
    };
    if (level === "error") {
      console.error("[global-music-audio]", kind, payload);
    } else if (level === "warn") {
      console.warn("[global-music-audio]", kind, payload);
    } else {
      console.info("[global-music-audio]", kind, payload);
    }
    if (options.isError) {
      updateAudioNotice("");
      updateAudioError(text);
      return;
    }
    if (level === "warn") {
      updateAudioNotice(text);
    }
  }

  function clearLoadedAudio() {
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch {
      }
      hlsRef.current = null;
    }
    hlsActiveRef.current = false;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }
    if (typeof objectReleaseRef.current === "function") {
      try {
        objectReleaseRef.current();
      } catch {
      }
      objectReleaseRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = "";
    }
    loadingAudioKeyRef.current = "";
    setAudioTrackId("");
  }

  function updateFloatingPosition(nextValue) {
    floatingPositionRef.current = nextValue;
    setFloatingPosition(nextValue);
  }

  function applyIncomingPlayerState(nextState, options = {}) {
    const normalizedState = normalizePlayerStateSnapshot(nextState);
    if (!normalizedState) {
      return null;
    }
    if (options.force) {
      setPlayerState(normalizedState);
      return normalizedState;
    }
    setPlayerState((current) => pickLatestPlayerState(current, normalizedState));
    return normalizedState;
  }

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }
    audioRef.current.volume = Math.max(0, Math.min(1, volume / 100));
  }, [volume]);

  useEffect(() => {
    if (forcedFlacFallbackTrackId && forcedFlacFallbackTrackId !== currentTrackId) {
      setForcedFlacFallbackTrackId("");
    }
  }, [currentTrackId, forcedFlacFallbackTrackId]);

  useEffect(() => {
    if (!currentTrackId || coverLoadErrorTrackId === currentTrackId) {
      return;
    }
    setCoverLoadErrorTrackId("");
  }, [coverLoadErrorTrackId, currentTrackId]);

  useEffect(() => {
    const previousTrackId = previousTrackIdRef.current;
    if (currentTrackId && previousTrackId && previousTrackId !== currentTrackId) {
      setPendingPlaybackTrackId(currentTrackId);
      setLocalTime(0);
    }
    if (!currentTrackId) {
      setPendingPlaybackTrackId("");
      setLocalTime(0);
    }
    previousTrackIdRef.current = currentTrackId;
  }, [currentTrackId]);

  useEffect(() => {
    floatingPositionRef.current = floatingPosition;
  }, [floatingPosition]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const stored = loadFloatingPosition();
    const defaultPosition = clampFloatingPosition(
      stored || { x: FLOATING_EDGE_MARGIN, y: window.innerHeight - FLOATING_BUTTON_SIZE - 76 },
      window.innerWidth,
      window.innerHeight
    );
    updateFloatingPosition(defaultPosition);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    function handleResize() {
      const next = clampFloatingPosition(
        floatingPositionRef.current,
        window.innerWidth,
        window.innerHeight,
        getFloatingFootprint(floatingSurfaceRef.current)
      );
      updateFloatingPosition(next);
      saveFloatingPosition(next);
    }
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    let timeoutId = 0;
    let frameId = 0;
    if (cardOpen) {
      setCardRendered(true);
      if (typeof window !== "undefined") {
        frameId = window.requestAnimationFrame(() => {
          setCardVisible(true);
        });
      } else {
        setCardVisible(true);
      }
    } else {
      setCardVisible(false);
      if (typeof window !== "undefined") {
        timeoutId = window.setTimeout(() => {
          setCardRendered(false);
        }, FLOATING_CARD_TRANSITION_MS);
      } else {
        setCardRendered(false);
      }
    }
    return () => {
      if (frameId && typeof window !== "undefined") {
        window.cancelAnimationFrame(frameId);
      }
      if (timeoutId && typeof window !== "undefined") {
        window.clearTimeout(timeoutId);
      }
    };
  }, [cardOpen]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
      if (seekTimerRef.current) {
        clearTimeout(seekTimerRef.current);
      }
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = "";
      }
    };
  }, []);

  useEffect(() => {
    if (!cardPinnedOpen && !popupOpen) {
      return undefined;
    }
    function handlePointerDown(event) {
      if (!shellRef.current?.contains(event.target)) {
        closeFloatingCard();
      }
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        closeFloatingCard();
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [cardPinnedOpen, popupOpen]);

  useEffect(() => {
    if (keyword.trim()) {
      return;
    }
    setSearchResults([]);
    setSearchError("");
    setSelectionBusyId("");
  }, [keyword]);

  useEffect(() => {
    if (!queueItems.length) {
      setVisibleQueueCount(QUEUE_PAGE_SIZE);
      return;
    }
    const minimumVisible = Math.min(queueItems.length, Math.max(QUEUE_PAGE_SIZE, currentQueueIndex + 1));
    setVisibleQueueCount((current) => {
      if (current < minimumVisible) {
        return minimumVisible;
      }
      if (current > queueItems.length) {
        return queueItems.length;
      }
      return current;
    });
  }, [currentQueueIndex, queueItems.length]);

  useEffect(() => {
    if (!playerState?.isPlaying || !currentTrackId || audioTrackId !== currentTrackId) {
      return undefined;
    }
    function resumePlayback() {
      tryResumeAudioPlayback({ report: false }).catch(() => {});
    }
    window.addEventListener("pointerdown", resumePlayback);
    window.addEventListener("keydown", resumePlayback);
    return () => {
      window.removeEventListener("pointerdown", resumePlayback);
      window.removeEventListener("keydown", resumePlayback);
    };
  }, [audioTrackId, currentTrackId, playerState?.isPlaying]);

  useEffect(() => {
    if (!p2p || !hostClientId) {
      setPlayerState(null);
      return undefined;
    }

    let disposed = false;
    async function poll() {
      try {
        const result = await p2p.getMusicPlayerState(hostClientId, listenerId ? { id: listenerId } : null);
        if (!disposed) {
          applyIncomingPlayerState(result?.state || null);
        }
      } catch (error) {
        if (!disposed) {
          setAudioError(error?.message || "播放器状态获取失败");
        }
      } finally {
        if (!disposed) {
          pollTimerRef.current = setTimeout(poll, 2000);
        }
      }
    }

    poll();
    return () => {
      disposed = true;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, [hostClientId, p2p, listenerId]);

  useEffect(() => {
    if (!p2p || !hostClientId || !currentTrackId || !currentTrack?.relativePath || currentTrack?.status !== "ready") {
      if (currentTrackId !== audioTrackId) {
        clearLoadedAudio();
        updateAudioNotice("");
      }
      return undefined;
    }
    if (audioTrackId === currentTrackId && (objectUrlRef.current || hlsActiveRef.current)) {
      return undefined;
    }

    let disposed = false;
    let localHls = null;
    const token = loadTokenRef.current + 1;
    loadTokenRef.current = token;
    const targetStartPosition = trackWaitingForPlayback ? 0 : Math.max(0, Number(playerState?.positionSeconds || 0));
    const shouldUseTranscodedStream = shouldTranscodeTrackForStreaming(currentTrack, forcedFlacFallbackTrackId);
    const loadMode = "audio-hls";
    const loadingAudioKey = `${currentTrackId}:${loadMode}`;
    if (loadingAudioKeyRef.current === loadingAudioKey) {
      return undefined;
    }

    loadingAudioKeyRef.current = loadingAudioKey;
    setAudioLoading(true);
    updateAudioError("");
    updateAudioNotice("");
    reportAudioEvent("p2p-download-start", "正在连接分段音频缓存流…");

    const applyReadyAudio = (ready) => {
      if (disposed || loadTokenRef.current !== token || !audioRef.current) {
        ready?.release?.();
        return;
      }
      if (objectUrlRef.current && objectUrlRef.current !== ready.url) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      if (typeof objectReleaseRef.current === "function" && objectReleaseRef.current !== ready.release) {
        try {
          objectReleaseRef.current();
        } catch {
        }
      }
      objectUrlRef.current = ready.url;
      objectReleaseRef.current = typeof ready.release === "function" ? ready.release : null;
      setAudioTrackId(currentTrackId);
      setLocalTime(trackWaitingForPlayback ? 0 : Math.max(0, Number(playerState?.positionSeconds || 0)));
      setAudioLoading(false);
      reportAudioEvent(
        "p2p-download-ready",
        shouldUseTranscodedStream
            ? "音频兼容流已开始推送，浏览器可以边下边播。"
            : "原始音频已下载完成，浏览器可以直接播放。",
        { level: "info" }
      );
      audioRef.current.src = ready.url;
      audioRef.current.autoplay = Boolean(playerState?.isPlaying);
      audioRef.current.load();
    };

      const loadFallbackAudio = async () => {
        if (shouldUseTranscodedStream) {
          return p2p.streamPreviewFile(
            hostClientId,
            currentTrack.relativePath,
            applyReadyAudio,
            {
              channelName: "audio",
              transcode: "mp3",
              timeoutMs: 300_000
            }
          );
        }

        const result = await p2p.downloadFile(hostClientId, currentTrack.relativePath, {
          onProgress: (progress) => {
            if (disposed || loadTokenRef.current !== token) {
              return;
            }
            const totalBytes = Number(progress?.totalBytes || 0);
            const transferredBytes = Number(progress?.transferredBytes || 0);
            const percent = Number(progress?.progress);
            if (Number.isFinite(percent) && percent > 0) {
              updateAudioNotice(`正在回退下载原始音频… ${percent}%`);
              return;
            }
            if (totalBytes > 0 && transferredBytes > 0) {
              const transferredMiB = (transferredBytes / (1024 * 1024)).toFixed(1);
              const totalMiB = (totalBytes / (1024 * 1024)).toFixed(1);
              updateAudioNotice(`正在回退下载原始音频… ${transferredMiB}/${totalMiB} MiB`);
            }
          }
        });

        if (disposed || loadTokenRef.current !== token) {
          return null;
        }

        const objectUrl = URL.createObjectURL(result.blob);
        const release = () => URL.revokeObjectURL(objectUrl);
        applyReadyAudio({
          url: objectUrl,
          meta: result.meta,
          release
        });
        return {
          url: objectUrl,
          meta: result.meta,
          release
        };
      };

    const loadAudioTask = (async () => {
      const manifestResult = await p2p.getHlsManifest(hostClientId, currentTrack.relativePath, {
        profile: "audio",
        onProgress: (status) => {
          if (disposed || loadTokenRef.current !== token) {
            return;
          }
          const message = String(status?.message || "").trim();
          if (message) {
            updateAudioNotice(message);
          }
        }
      });
      if (disposed || loadTokenRef.current !== token || !audioRef.current) {
        return null;
      }

      const mod = await import("hls.js");
      const Hls = mod?.default;
      if (!Hls?.isSupported?.()) {
        throw new Error("当前浏览器环境不支持 hls.js 音频播放");
      }

      const rewrittenManifest = String(manifestResult?.manifest || "")
        .split(/\r?\n/)
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) {
            return line;
          }
          if (trimmed.startsWith("#EXT-X-MAP:")) {
            return line.replace(/URI="([^"]+)"/, (_match, segmentName) => `URI="${buildP2pHlsSegmentUrl(hostClientId, manifestResult.hlsId, segmentName)}"`);
          }
          if (trimmed.startsWith("#")) {
            return line;
          }
          return buildP2pHlsSegmentUrl(hostClientId, manifestResult.hlsId, trimmed);
        })
        .join("\n");
      const manifestDataUrl = `data:application/vnd.apple.mpegurl;charset=utf-8,${encodeURIComponent(rewrittenManifest)}`;

      class P2PAudioSegmentLoader {
        constructor() {
          this.stats = {
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
          this.aborted = false;
        }

        destroy() {}

        abort() {
          this.aborted = true;
          this.stats.aborted = true;
        }

        load(context, _config, callbacks) {
          this.stats.loading.start = performance.now();
          (async () => {
            try {
              const parsed = parseP2pHlsSegmentUrl(context.url);
              if (!parsed && typeof context.url === "string" && (/^https?:\/\//i.test(context.url) || /^data:/i.test(context.url))) {
                const response = await fetch(context.url);
                if (!response.ok) {
                  throw new Error(`audio hls loader failed: ${response.status}`);
                }
                const isText = context.type === "manifest" || context.type === "level" || context.type === "audioTrack";
                const data = isText ? await response.text() : await response.arrayBuffer();
                const now = performance.now();
                this.stats.loading.first = now;
                this.stats.loading.end = now;
                this.stats.loaded = isText ? data.length : data.byteLength;
                this.stats.total = this.stats.loaded;
                this.stats.chunkCount = 1;
                callbacks.onSuccess({ url: context.url, data }, this.stats, context, response);
                return;
              }
              if (!parsed) {
                throw new Error("invalid audio hls segment url");
              }
              const response = await p2p.getHlsSegment(parsed.clientId, parsed.hlsId, parsed.segmentName, {
                channelName: "audio",
                timeoutMs: 120_000
              });
              if (this.aborted || disposed) {
                return;
              }
              const data = await response.blob.arrayBuffer();
              const now = performance.now();
              this.stats.loading.first = now;
              this.stats.loading.end = now;
              this.stats.loaded = data.byteLength;
              this.stats.total = data.byteLength;
              this.stats.chunkCount = 1;
              callbacks.onSuccess({ url: context.url, data }, this.stats, context, response);
            } catch (error) {
              const errorText = error?.message || "audio hls load failed";
              callbacks.onError({ code: 0, text: errorText }, context, null, this.stats);
            }
          })();
        }
      }

      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      localHls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        autoStartLoad: false,
        startPosition: targetStartPosition,
        startFragPrefetch: false,
        maxBufferLength: 18,
        maxMaxBufferLength: 30,
        maxBufferHole: 0.5,
        backBufferLength: 30,
        fLoader: P2PAudioSegmentLoader
      });
      hlsRef.current = localHls;
      hlsActiveRef.current = true;

      localHls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal || disposed || loadTokenRef.current !== token) {
          return;
        }
        reportAudioEvent("audio-hls-failed", `分段音频播放失败，回退普通流：${data?.details || data?.type || "unknown"}`, {
          level: "warn"
        });
        try {
          localHls?.destroy();
        } catch {
        }
        if (hlsRef.current === localHls) {
          hlsRef.current = null;
        }
        hlsActiveRef.current = false;
        clearLoadedAudio();
        loadFallbackAudio().catch((error) => {
          if (!disposed && loadTokenRef.current === token) {
            reportAudioEvent("p2p-download-failed", `普通音频流回退失败：${error?.message || "音频加载失败"}`, {
              isError: true,
              level: "error"
            });
          }
        });
      });

      await new Promise((resolve, reject) => {
        localHls.on(Hls.Events.MEDIA_ATTACHED, () => {
          try {
            localHls.loadSource(manifestDataUrl);
          } catch (error) {
            reject(error);
          }
        });
        localHls.on(Hls.Events.MANIFEST_PARSED, () => {
          try {
            if (audioRef.current && Number.isFinite(targetStartPosition) && targetStartPosition > 0) {
              audioRef.current.currentTime = targetStartPosition;
            }
          } catch {
          }
          try {
            localHls.startLoad(targetStartPosition);
          } catch {
          }
          resolve();
        });
        localHls.on(Hls.Events.ERROR, (_event, data) => {
          if (data?.fatal) {
            reject(new Error(data?.details || data?.type || "audio hls load failed"));
          }
        });
        localHls.attachMedia(audioRef.current);
      });

      if (disposed || loadTokenRef.current !== token || !audioRef.current) {
        return null;
      }

      setAudioTrackId(currentTrackId);
  setLocalTime(targetStartPosition);
      setAudioLoading(false);
      updateAudioNotice("");
      reportAudioEvent("p2p-download-ready", "分段音频缓存已连接，浏览器可以按片拉流播放。", { level: "info" });
      audioRef.current.autoplay = Boolean(playerState?.isPlaying);
      return { release: null };
    })().catch(async (error) => {
      if (!disposed && loadTokenRef.current === token) {
        reportAudioEvent("audio-hls-unavailable", `分段音频缓存不可用，回退普通流：${error?.message || "unknown"}`, {
          level: "warn"
        });
      }
      return loadFallbackAudio();
    });

    loadAudioTask
      .then((result) => {
        if (disposed || loadTokenRef.current !== token) {
          result?.release?.();
        }
      })
      .catch((error) => {
        if (!disposed && loadTokenRef.current === token) {
          reportAudioEvent("p2p-download-failed", `P2P 下载阶段就失败：${error?.message || "音频加载失败"}`, {
            isError: true,
            level: "error"
          });
        }
      })
      .finally(() => {
        if (!disposed && loadTokenRef.current === token) {
          loadingAudioKeyRef.current = "";
          setAudioLoading(false);
        } else if (loadingAudioKeyRef.current === loadingAudioKey) {
          loadingAudioKeyRef.current = "";
        }
      });

    return () => {
      disposed = true;
      if (localHls && hlsRef.current === localHls) {
        try {
          localHls.destroy();
        } catch {
        }
        hlsRef.current = null;
        hlsActiveRef.current = false;
      }
    };
  }, [currentTrack?.relativePath, currentTrack?.status, currentTrackId, forcedFlacFallbackTrackId, hostClientId, p2p]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrackId || audioTrackId !== currentTrackId) {
      return;
    }
    const targetPosition = trackWaitingForPlayback
      ? 0
      : Math.max(0, Number(playerState?.positionSeconds || 0));
    const syncTolerance = hlsActiveRef.current ? 8 : 2.2;
    const shouldForceSync = pendingSeek == null
      && Number.isFinite(targetPosition)
      && Math.abs((audio.currentTime || 0) - targetPosition) > syncTolerance
      && (!hlsActiveRef.current || !playerState?.isPlaying);
    if (shouldForceSync) {
      try {
        audio.currentTime = targetPosition;
      } catch {
      }
    }
    if (playerState?.isPlaying) {
      tryResumeAudioPlayback().catch(() => {});
    } else {
      audio.pause();
    }
  }, [audioTrackId, currentTrackId, pendingSeek, playerState?.isPlaying, playerState?.positionSeconds, trackWaitingForPlayback]);

  async function handleSearchSubmit(event) {
    event.preventDefault();
    if (!p2p || !hostClientId || !keyword.trim()) {
      return;
    }
    setSearching(true);
    setSearchError("");
    setAudioError("");
    try {
      const result = await p2p.searchMusicCandidates(hostClientId, keyword.trim(), currentSource, 8);
      const items = Array.isArray(result?.candidates) ? result.candidates : [];
      setSearchResults(items);
      setPopupOpen(true);
      if (!items.length) {
        setSearchError("没有找到匹配曲目，请换个关键词或音源。");
      }
    } catch (error) {
      const message = error?.message || "搜索失败";
      setSearchError(message);
      setSearchResults([]);
      setPopupOpen(true);
      onToast?.(message, "error");
    } finally {
      setSearching(false);
    }
  }

  async function handleSelectCandidate(candidate) {
    if (!p2p || !hostClientId || !candidate?.providerTrackId) {
      return;
    }
    const candidateId = String(candidate.providerTrackId || "");
    setSelectionBusyId(candidateId);
    updateAudioError("");
    setSearchError("");
    try {
      const result = await p2p.enqueueMusicSelection(
        hostClientId,
        candidate.source || currentSource,
        candidate,
        user?.displayName || user?.email || "web",
        musicActor
      );
      applyIncomingPlayerState(result?.state || null);
      resetSearchState();
      onToast?.(`已加入全局播放队列: ${result?.track?.title || candidate.title || "新曲目"}`, "success");
    } catch (error) {
      const message = error?.message || "入队失败";
      updateAudioError(message);
      setSearchError(message);
      onToast?.(message, "error");
    } finally {
      setSelectionBusyId("");
    }
  }

  async function sendControl(action, payload = {}, options = {}) {
    if (!p2p || !hostClientId) {
      return null;
    }
    try {
      const nextPayload = options.includeCurrentTrackId === false
        ? { ...payload }
        : {
            currentTrackId,
            ...payload
          };
      const result = await p2p.controlMusicPlayer(hostClientId, action, {
        ...nextPayload,
        actor: musicActor
      });
      applyIncomingPlayerState(result?.state || null);
      return result?.state || null;
    } catch (error) {
      const message = error?.message || "播放器操作失败";
      updateAudioError(message);
      if (!options.silentError) {
        onToast?.(message, "error");
      }
      if (options.throwOnError) {
        throw error;
      }
      return null;
    }
  }

  function handleSeekChange(event) {
    const next = Number(event.target.value || 0);
    setPendingSeek(next);
    setLocalTime(next);
    if (seekTimerRef.current) {
      clearTimeout(seekTimerRef.current);
    }
    seekTimerRef.current = setTimeout(() => {
      sendControl("seek", { positionSeconds: next });
      setPendingSeek(null);
    }, 180);
  }

  async function handlePlayButtonClick() {
    if (!currentTrackId) {
      return;
    }
    if (playerState?.isPlaying) {
      await sendControl("pause");
      return;
    }
    await sendControl("play");
  }

  // The <video> element is the audio engine; it stays mounted while the bar and panel change.
  const mediaElement = (
        <video
            ref={audioRef}
            preload="auto"
            autoPlay
            playsInline
            style={{ display: "none", width: 0, height: 0 }}
            aria-hidden="true"
            onLoadedMetadata={() => {
              const nextPosition = trackWaitingForPlayback ? 0 : transportPosition;
              if (audioRef.current && Number.isFinite(nextPosition)) {
                try {
                  audioRef.current.currentTime = nextPosition;
                } catch {
                }
              }
            }}
            onCanPlay={() => {
              updateAudioNotice("");
              reportAudioEvent("audio-can-play", "已重新下载，浏览器已完成解码准备，可以播放。", {
                level: "info"
              });
              tryResumeAudioPlayback({ report: false }).catch(() => {});
            }}
            onPlay={() => {
              updateAudioNotice("");
              updateAudioError("");
              reportAudioEvent("audio-play", "音频已进入播放流程，等待开始输出声音。", {
                level: "info"
              });
            }}
            onPlaying={() => {
              setPendingPlaybackTrackId((value) => (value === currentTrackId ? "" : value));
              updateAudioNotice("");
              updateAudioError("");
              reportAudioEvent("audio-playing", "音频已开始实际播放。", {
                level: "info"
              });
            }}
            onStalled={() => {
              reportAudioEvent("audio-stalled", "已重新下载，但浏览器当前播放发生等待或卡顿。", {
                level: "warn"
              });
            }}
            onError={() => {
              const mediaError = audioRef.current?.error;
              const code = Number(mediaError?.code || 0);
              if (isLikelyFlacTrack(currentTrack) && forcedFlacFallbackTrackId !== currentTrackId) {
                setForcedFlacFallbackTrackId(currentTrackId);
                clearLoadedAudio();
                reportAudioEvent("audio-flac-fallback", "浏览器未能直接解码 FLAC，正在切换到 MP3 兼容流。", {
                  level: "warn"
                });
                return;
              }
              if (code === 3 || code === 4) {
                reportAudioEvent("audio-decode-failed", "已重新下载但音频解码失败。", {
                  isError: true,
                  level: "error"
                });
                return;
              }
              reportAudioEvent("audio-element-error", `音频元素播放失败${code ? `（code=${code}）` : ""}。`, {
                isError: true,
                level: "error"
              });
            }}
            onTimeUpdate={() => {
              if (audioRef.current) {
                setLocalTime(audioRef.current.currentTime || 0);
              }
            }}
            onEnded={() => {
              sendControl("complete").catch(() => {});
            }}
          />
  );

  const currentIndexValue = Number(playerState?.currentIndex ?? -1);
  const upcomingTracks = queueItems.slice(currentIndexValue + 1);
  // Played songs loop back once the requests run out, oldest first.
  const loopTracks = queueItems.slice(0, Math.max(0, currentIndexValue));
  const nextUpTrack = upcomingTracks[0] || loopTracks[0] || null;
  const myId = musicActor?.id || "";
  const isAdmin = musicActor?.role === "admin";
  const myPendingCount = upcomingTracks.filter((track) => track.submittedById && track.submittedById === myId).length;
  const maxPending = Number(playerState?.rules?.maxPendingPerUser || 2);
  const nodeFeatures = Array.isArray(playerState?.features) ? playerState.features : [];
  const nodeOutdated = Boolean(playerState) && !nodeFeatures.includes("qq-login");
  const outdatedNotice = "当前存储节点版本较旧：请在该节点 git pull 并重启存储端后再用这个功能";
  const cooldownSeconds = Number(playerState?.rules?.cooldownSeconds || 30);
  // Anyone may ask to skip; the node counts it as a vote unless it is your song,
  // you are an admin, or you are the only one listening.
  const skipState = playerState?.skip || null;
  const skipsAtOnce = !nodeFeatures.includes("vote-skip") || isAdmin || Boolean(currentTrack?.submittedById && currentTrack.submittedById === myId) || Number(skipState?.listeners || 0) < 2;
  const mySkipVoted = Boolean(skipState?.votedBy?.includes(myId));
  const skipLabel = skipsAtOnce ? "下一首" : `投票切歌 ${skipState?.votes || 0}/${skipState?.needed || 1}`;

  async function skipTrack() {
    const before = currentTrackId;
    const state = await sendControl("next");
    if (state && !skipsAtOnce && state.currentTrack?.id === before) {
      onToast?.(`已投票切歌 ${state.skip?.votes || 0}/${state.skip?.needed || 1}，过半就切`, "info");
    }
  }

  // A short notice whenever the song changes, saying why if someone skipped it.
  const lastTrackIdRef = useRef(currentTrackId);
  useEffect(() => {
    const previous = lastTrackIdRef.current;
    lastTrackIdRef.current = currentTrackId;
    if (!previous || !currentTrackId || previous === currentTrackId) {
      return;
    }
    const skip = playerState?.lastSkip;
    const now = `现在播放《${currentTrack?.title || ""}》${currentTrack?.submittedBy ? ` · ${currentTrack.submittedBy} 点的` : ""}`;
    if (skip?.trackId !== previous) {
      onToast?.(now, "info");
      return;
    }
    const why = skip.reason === "vote" ? `${skip.votes} 人投票跳过了` : skip.reason === "admin" ? `管理员 ${skip.by} 跳过了` : `${skip.by} 跳过了自己点的`;
    onToast?.(`${why}《${skip.title}》，${now}`, "info");
  }, [currentTrackId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Admins sign the node into QQ Music from the panel; the cookie stays on the node.
  useEffect(() => {
    if (!popupOpen || deckTab !== "account" || !p2p || !hostClientId) {
      return undefined;
    }
    let cancelled = false;
    p2p.qqMusicLogin(hostClientId, "status")
      .then((result) => { if (!cancelled) setQqAccount(result?.account || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [popupOpen, deckTab, p2p, hostClientId]);

  useEffect(() => {
    if (!qqLogin?.qrDataUrl || !["waiting", "scanned"].includes(qqLogin.status) || !p2p || !hostClientId) {
      return undefined;
    }
    const timer = setTimeout(async () => {
      try {
        const result = await p2p.qqMusicLogin(hostClientId, "poll");
        setQqLogin((current) => (current ? { ...current, status: result?.status || "error", message: result?.message || "" } : current));
        if (result?.status === "success") {
          setQqAccount(result.account || null);
          onToast?.("QQ 音乐已登录，点歌台会用这个账号搜索和播放", "success");
        }
      } catch (error) {
        setQqLogin((current) => (current ? { ...current, status: "error", message: error?.message || "查询登录状态失败" } : current));
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [qqLogin, p2p, hostClientId]);

  async function startQqLogin(provider) {
    if (!p2p || !hostClientId) {
      return;
    }
    setQqLogin({ provider, status: "loading", message: "正在获取二维码…" });
    try {
      const result = await p2p.qqMusicLogin(hostClientId, "start", provider);
      setQqLogin({ provider, status: result?.status || "waiting", message: result?.message || "", qrDataUrl: result?.qrDataUrl || "" });
    } catch (error) {
      setQqLogin({ provider, status: "error", message: error?.message || "获取二维码失败" });
    }
  }

  function openDeck(tab = "") {
    if (tab) {
      setDeckTab(tab);
    }
    setPopupOpen(true);
  }

  async function handleRequestAction(action, track, successText = "") {
    if (!track?.id || requestBusyId) {
      return;
    }
    setRequestBusyId(`${action}:${track.id}`);
    const state = await sendControl(action, { trackId: track.id }, { includeCurrentTrackId: false });
    setRequestBusyId("");
    if (state && successText) {
      onToast?.(successText, "success");
    }
  }

  function renderTrackCover(track, className) {
    return track?.coverUrl
      ? <img className={className} src={track.coverUrl} alt="" />
      : <span className={`${className} empty`} aria-hidden="true">♪</span>;
  }

  function renderUpcomingRow(track, position) {
    const mine = Boolean(myId) && track.submittedById === myId;
    const liked = Array.isArray(track.votedBy) && track.votedBy.includes(myId);
    const busyPrefix = requestBusyId.split(":")[1] === track.id ? requestBusyId.split(":")[0] : "";
    return (
      <li key={track.id} className={`musicDeckRow${mine ? " mine" : ""}${track.pinned ? " pinned" : ""}`}>
        <span className="musicDeckRank">{String(position + 1).padStart(2, "0")}</span>
        {renderTrackCover(track, "musicDeckCover")}
        <div className="musicDeckRowText">
          <span className="musicDeckRowTitle" title={track.title}>{track.title}</span>
          <span className="musicDeckRowMeta">
            {track.artist}
            {track.submittedBy ? ` · ${mine ? "我" : track.submittedBy} 点的` : ""}
            {track.pinned ? " · 管理员插队" : ""}
          </span>
        </div>
        <div className="musicDeckRowActions">
          <button
            type="button"
            className={`musicDeckLike${liked ? " active" : ""}`}
            disabled={mine || !myId || Boolean(requestBusyId)}
            title={mine ? "自己点的歌不能点赞" : liked ? "取消点赞" : "点赞，让它在本轮更靠前"}
            onClick={() => handleRequestAction(liked ? "unvote-track" : "vote-track", track)}
          >
            {busyPrefix.endsWith("vote-track") ? <Spinner size="extra-tiny" /> : <span aria-hidden="true">▲</span>}
            <span className="musicDeckLikeCount">{track.votes || 0}</span>
          </button>
          {isAdmin && !track.pinned ? (
            <button type="button" className="musicDeckIconButton" disabled={Boolean(requestBusyId)} title="插队到下一首（管理员）" onClick={() => handleRequestAction("pin-track", track, `已插队：${track.title}`)}>
              置顶
            </button>
          ) : null}
          {mine || isAdmin ? (
            <button type="button" className="musicDeckIconButton danger" disabled={Boolean(requestBusyId)} title={mine ? "撤回我点的歌" : "移除（管理员）"} onClick={() => handleRequestAction("withdraw-track", track, `已撤回：${track.title}`)}>
              {busyPrefix === "withdraw-track" ? <Spinner size="extra-tiny" /> : mine ? "撤回" : "移除"}
            </button>
          ) : null}
        </div>
      </li>
    );
  }

  const searchPanel = (
    <div className="musicDeckPane">
      <form className="musicDeckSearch" onSubmit={handleSearchSubmit}>
        <Input
          className="musicDeckSearchInput"
          placeholder={hostClientId ? "输入歌名或歌手，回车搜索 QQ 音乐" : "等待存储终端上线"}
          value={keyword}
          onChange={(_, data) => {
            setKeyword(data.value);
            if (!data.value.trim()) {
              resetSearchState({ preserveKeyword: true });
            }
          }}
          disabled={!hostClientId || searching}
        />
        <button type="submit" className="musicDeckPrimary" disabled={!hostClientId || searching || !keyword.trim()}>
          {searching ? <Spinner size="tiny" /> : "搜索"}
        </button>
      </form>
      <p className="musicDeckHint">每人最多同时排 {maxPending} 首，{cooldownSeconds} 秒内只能点一首；你现在排了 {myPendingCount} 首。</p>
      {searchError ? <p className="musicDeckError">{searchError}</p> : null}
      <ul className="musicDeckList">
        {searchResults.map((candidate) => {
          const candidateId = String(candidate.providerTrackId || "");
          const busy = selectionBusyId && selectionBusyId === candidateId;
          const alreadyQueued = queuedCandidateKeys.has(getCandidateQueueKey(candidate));
          return (
            <li key={candidateId || `${candidate.source}-${candidate.title}`} className="musicDeckRow">
              {renderTrackCover(candidate, "musicDeckCover")}
              <div className="musicDeckRowText">
                <span className="musicDeckRowTitle" title={candidate.title}>{candidate.title}</span>
                <span className="musicDeckRowMeta">{candidate.artist || "未知艺术家"} · {formatDuration(candidate.duration)}</span>
              </div>
              {alreadyQueued ? (
                <span className="musicDeckTag">已在队列</span>
              ) : (
                <button type="button" className="musicDeckPrimary" onClick={() => handleSelectCandidate(candidate)} disabled={Boolean(selectionBusyId) || myPendingCount >= maxPending && !isAdmin}>
                  {busy ? "点歌中" : "点这首"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );

  const queuePanel = (
    <div className="musicDeckPane">
      <p className="musicDeckHint">按轮流顺序播放：每人一首为一轮，同一轮里点赞多的先播。</p>
      {upcomingTracks.length ? (
        <ol className="musicDeckList">{upcomingTracks.map((track, position) => renderUpcomingRow(track, position))}</ol>
      ) : (
        <div className="musicDeckEmpty">
          <span>{loopTracks.length ? "没有新点的歌，正在循环播放下面的列表" : "队列空了"}</span>
          <button type="button" className="musicDeckPrimary" onClick={() => setDeckTab("search")}>去点一首</button>
        </div>
      )}
      {loopTracks.length ? (
        <>
          <p className="musicDeckSection">循环播放 · {loopTracks.length} 首</p>
          <ul className="musicDeckList">
            {loopTracks.map((track) => (
              <li key={track.id} className="musicDeckRow looped">
                {renderTrackCover(track, "musicDeckCover")}
                <div className="musicDeckRowText">
                  <span className="musicDeckRowTitle" title={track.title}>{track.title}</span>
                  <span className="musicDeckRowMeta">{track.artist}{track.submittedBy ? ` · ${track.submittedBy} 点的` : ""}</span>
                </div>
                <button
                  type="button"
                  className="musicDeckIconButton"
                  disabled={!myId || Boolean(requestBusyId) || !nodeFeatures.includes("loop")}
                  title={nodeFeatures.includes("loop") ? "把这首放进点歌队列，按轮流顺序播放" : outdatedNotice}
                  onClick={() => handleRequestAction("requeue-track", track, `已提前：${track.title}`)}
                >
                  {requestBusyId === `requeue-track:${track.id}` ? <Spinner size="extra-tiny" /> : "提前"}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );

  const accountPanel = (
    <div className="musicDeckPane">
      <div className="musicAccountStatus">
        <span className={`musicAccountDot${qqAccount?.loggedIn ? " on" : ""}`} aria-hidden="true" />
        <div className="musicDeckRowText">
          <span className="musicDeckRowTitle">{qqAccount?.loggedIn ? `已登录 ${qqAccount.account || ""}` : "未登录 QQ 音乐"}</span>
          <span className="musicDeckRowMeta">
            {qqAccount?.loggedIn
              ? `${qqAccount.provider === "wechat" ? "微信" : "QQ"} 扫码 · ${qqAccount.refreshedAt ? new Date(qqAccount.refreshedAt).toLocaleString() : "手动填写"}${qqAccount.expiresAt ? ` · ${new Date(qqAccount.expiresAt).toLocaleDateString()} 到期` : ""}`
              : "登录后才能搜索和播放 QQ 音乐的大部分歌曲"}
          </span>
        </div>
      </div>
      {nodeOutdated ? <p className="musicDeckError">{outdatedNotice}</p> : null}
      <div className="musicAccountActions">
        <button type="button" className="musicDeckPrimary" disabled={nodeOutdated || qqLogin?.status === "loading"} onClick={() => startQqLogin("qq")}>QQ 扫码登录</button>
        <button type="button" className="musicDeckPrimary wechat" disabled={nodeOutdated || qqLogin?.status === "loading"} onClick={() => startQqLogin("wechat")}>微信扫码登录</button>
      </div>
      {qqLogin ? (
        <div className={`musicAccountQr status-${qqLogin.status}`}>
          {qqLogin.qrDataUrl && !["success", "expired"].includes(qqLogin.status) ? <img src={qqLogin.qrDataUrl} alt={`${qqLogin.provider === "wechat" ? "微信" : "QQ"} 登录二维码`} /> : null}
          <p>{qqLogin.message}</p>
        </div>
      ) : null}
      <p className="musicDeckHint">登录凭证只保存在当前存储节点（写入音乐桥 .env），不会上传到服务器。</p>
    </div>
  );

  return (
    <MusicPlayerContext.Provider value={{
      currentTrack,
      isPlaying: Boolean(playerState?.isPlaying),
      togglePlay: handlePlayButtonClick,
      nextTrack: skipTrack,
      prevTrack: () => sendControl("previous"),
      openDeck,
      upcomingCount: upcomingTracks.length,
      upcomingTracks,
      loopTracks,
      queueItems,
      skipLabel,
      skipsAtOnce,
      mySkipVoted,
      progressPercent,
      hostName: hostClient?.name || ""
    }}>
      {/* Portaled to <body>: the top bar that mounts this has a backdrop filter, which would pin a fixed child to the bar. */}
      {createPortal(<div ref={shellRef} className={`musicShell${popupOpen ? " deckOpen" : ""}`}>
        {mediaElement}
        <div className={`musicDock${currentTrack ? "" : " idle"}${playerState?.isPlaying ? " playing" : ""}`} role="region" aria-label="正在播放">
          <span className="musicDockProgress" style={{ "--music-progress": `${progressPercent}%` }} aria-hidden="true" />
          {renderTrackCover(currentTrack, "musicDockCover")}
          <div className="musicDockInfo">
            <span className="musicDockTitle" title={currentTrack?.title || ""}>{currentTrack?.title || "还没有人点歌"}</span>
            <span className="musicDockMeta">
              {currentTrack
                ? `${currentTrack.artist || ""}${currentTrack.submittedBy ? ` · ${currentTrack.submittedBy} 点的` : ""}${nextUpTrack ? ` · 下一首：${nextUpTrack.title}${upcomingTracks.length ? "" : "（循环）"}` : ""}`
                : "打开点歌台，搜一首大家一起听"}
            </span>
          </div>
          <span className="musicDockEq" aria-hidden="true"><i /><i /><i /><i /></span>
          <div className="musicDockControls">
            <button type="button" className="musicDockButton" onClick={() => handlePlayButtonClick()} disabled={!currentTrackId || audioLoading} aria-label={playerState?.isPlaying ? "暂停" : "播放"} title={playerState?.isPlaying ? "暂停" : "播放"}>
              {audioLoading ? <Spinner size="tiny" /> : playerState?.isPlaying ? <PauseRegular /> : <PlayRegular />}
            </button>
            <button type="button" className={`musicDockButton${skipsAtOnce ? "" : " vote"}`} onClick={skipTrack} disabled={!nextUpTrack || mySkipVoted} aria-label={skipLabel} title={mySkipVoted ? "你已经投过票了" : skipLabel}>
              {skipsAtOnce ? <ChevronRightRegular /> : <span>跳过 {skipState?.votes || 0}/{skipState?.needed || 1}</span>}
            </button>
          </div>
          <button type="button" className={`musicDockOpen${popupOpen ? " active" : ""}`} onClick={() => (popupOpen ? closePopup({ preserveKeyword: true }) : openDeck(upcomingTracks.length ? "queue" : "search"))}>
            <span>点歌台</span>
            <span className="musicDockCount">{upcomingTracks.length}</span>
          </button>
        </div>

        {popupOpen ? (
          <aside className="musicDeck" role="dialog" aria-label="点歌台" onClick={(event) => event.stopPropagation()}>
            <header className="musicDeckHeader">
              <div className="musicDeckHeaderText">
                <span className="musicDeckEyebrow">JUKEBOX // QQ 音乐</span>
                <span className="musicDeckTitle">点歌台</span>
              </div>
              <button type="button" className="musicDeckClose" onClick={() => closePopup({ preserveKeyword: true })} aria-label="关闭点歌台">×</button>
            </header>
            <section className="musicDeckNow">
              {renderTrackCover(currentTrack, "musicDeckNowCover")}
              <div className="musicDeckNowText">
                <span className="musicDeckRowTitle">{currentTrack?.title || "等待点歌"}</span>
                <span className="musicDeckRowMeta">{currentTrack ? `${currentTrack.artist || ""}${currentTrack.submittedBy ? ` · ${currentTrack.submittedBy} 点的` : ""}` : "队列为空"}</span>
                <div className="musicDeckSeek">
                  <span>{formatDuration(progressValue)}</span>
                  <input
                    className="globalMusicRange"
                    type="range"
                    min={0}
                    max={Math.max(1, currentDuration || 1)}
                    step="1"
                    value={Math.max(0, Math.min(currentDuration || 1, progressValue || 0))}
                    onChange={handleSeekChange}
                    disabled={!currentDuration || !currentTrackId}
                    style={{ "--music-progress": `${progressPercent}%` }}
                  />
                  <span>{formatDuration(currentDuration)}</span>
                </div>
              </div>
              <label className="musicDeckVolume" title="音量（只影响你自己）">
                <span aria-hidden="true">VOL</span>
                <input className="globalMusicVolumeRange" type="range" min="0" max="100" step="1" value={volume} onChange={(event) => setVolume(Number(event.target.value || 0))} style={{ "--music-progress": `${volume}%` }} />
              </label>
            </section>
            {nodeOutdated ? <p className="musicDeckError">存储节点「{hostClient?.name || hostClientId}」还在运行旧版本，循环播放、提前和扫码登录需要更新并重启它。</p> : null}
            {audioError ? <p className="musicDeckError">{audioError}</p> : null}
            <nav className="musicDeckTabs" role="tablist">
              {[["search", "搜索"], ["queue", `队列 ${upcomingTracks.length}`], ["lyrics", "歌词"], ...(isAdmin ? [["account", "账号"]] : [])].map(([key, label]) => (
                <button key={key} type="button" role="tab" aria-selected={deckTab === key} className={`musicDeckTab${deckTab === key ? " active" : ""}`} onClick={() => setDeckTab(key)}>{label}</button>
              ))}
            </nav>
            {deckTab === "search" ? searchPanel : null}
            {deckTab === "queue" ? queuePanel : null}
            {deckTab === "account" && isAdmin ? accountPanel : null}
            {deckTab === "lyrics" ? (
              <div className="musicDeckPane"><pre className="musicDeckLyrics">{currentTrack?.lyrics || "当前曲目没有可用歌词。"}</pre></div>
            ) : null}
          </aside>
        ) : null}
      </div>, document.body)}
      {children}
    </MusicPlayerContext.Provider>
  );
}
