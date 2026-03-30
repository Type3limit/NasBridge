import { createContext, useEffect, useMemo, useRef, useState } from "react";
import { Button, Caption1, Input, Spinner, Text } from "@fluentui/react-components";
import {
  ChevronLeftRegular,
  ChevronRightRegular,
  DeleteRegular,
  MoreHorizontalRegular,
  PauseRegular,
  PlayRegular
} from "@fluentui/react-icons";

export const MusicPlayerContext = createContext(null);

const QUEUE_PAGE_SIZE = 20;
const FLOATING_PLAYER_STORAGE_KEY = "nas-global-music-player-position";
const FLOATING_BUTTON_SIZE = 72;
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

function removeTrackFromPlayerState(state, trackId) {
  if (!state || !trackId) {
    return state;
  }
  const queue = Array.isArray(state.queue) ? [...state.queue] : [];
  const index = queue.findIndex((item) => String(item?.id || "") === trackId);
  if (index < 0) {
    return state;
  }

  const currentIndex = Number(state.currentIndex ?? -1);
  const wasCurrent = index === currentIndex;
  queue.splice(index, 1);

  let nextCurrentIndex = currentIndex;
  let nextIsPlaying = Boolean(state.isPlaying);
  let nextPositionSeconds = Number(state.positionSeconds || 0);
  if (!queue.length) {
    nextCurrentIndex = -1;
    nextIsPlaying = false;
    nextPositionSeconds = 0;
  } else if (wasCurrent) {
    nextCurrentIndex = Math.max(0, Math.min(index, queue.length - 1));
    nextPositionSeconds = 0;
  } else if (index < currentIndex) {
    nextCurrentIndex = Math.max(0, currentIndex - 1);
  }

  const normalizedQueue = queue.map((item, queueIndex) => ({
    ...item,
    index: queueIndex
  }));
  const nextCurrentTrack = nextCurrentIndex >= 0 && nextCurrentIndex < normalizedQueue.length
    ? normalizedQueue[nextCurrentIndex]
    : null;

  return {
    ...state,
    queue: normalizedQueue,
    currentIndex: nextCurrentIndex,
    currentTrack: nextCurrentTrack,
    isPlaying: nextIsPlaying,
    positionSeconds: nextPositionSeconds,
    updatedAt: new Date().toISOString(),
    lastError: ""
  };
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

export default function GlobalMusicPlayer({ p2p, clients = [], user = null, onToast }) {
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
  const queueListRef = useRef(null);
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
  const [searchResults, setSearchResults] = useState([]);
  const [searchError, setSearchError] = useState("");
  const [selectionBusyId, setSelectionBusyId] = useState("");
  const [removingTrackId, setRemovingTrackId] = useState("");
  const [visibleQueueCount, setVisibleQueueCount] = useState(QUEUE_PAGE_SIZE);
  const [floatingPosition, setFloatingPosition] = useState({ x: FLOATING_EDGE_MARGIN, y: 92, side: "right" });
  const [cardPinnedOpen, setCardPinnedOpen] = useState(false);
  const [cardRendered, setCardRendered] = useState(false);
  const [cardVisible, setCardVisible] = useState(false);
  const [dragging, setDragging] = useState(false);

  const queueItems = Array.isArray(playerState?.queue) ? playerState.queue : [];
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
  const visibleQueueItems = queueItems.slice(0, visibleQueueCount);
  const queuedCandidateKeys = useMemo(() => new Set(queueItems.map((item) => `${String(item?.source || "")}:${String(item?.providerTrackId || "")}`)), [queueItems]);
  const cardOpen = !dragging && (cardPinnedOpen || popupOpen);
  const showFloatingCard = cardRendered;

  function getCandidateQueueKey(candidate = null) {
    return `${String(candidate?.source || currentSource || "")}:${String(candidate?.providerTrackId || "")}`;
  }

  function renderCompactVisual() {
    if (showCompactCover) {
      return (
        <div className={`globalMusicCoverArtShell${playerState?.isPlaying ? " spinning" : ""}`}>
          <img
            className="globalMusicCoverArt"
            src={currentTrack.coverUrl}
            alt=""
            draggable={false}
            referrerPolicy="no-referrer"
            onError={() => setCoverLoadErrorTrackId(currentTrackId)}
          />
          <span className="globalMusicCoverArtCenter" />
        </div>
      );
    }
    return (
      <div className={`globalMusicDisc${playerState?.isPlaying ? " spinning" : ""}`}>
        <span className="globalMusicDiscGroove grooveA" />
        <span className="globalMusicDiscGroove grooveB" />
        <span className="globalMusicDiscLabel" />
      </div>
    );
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
      stored || { x: window.innerWidth - FLOATING_BUTTON_SIZE - FLOATING_EDGE_MARGIN, y: 92 },
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
        const result = await p2p.getMusicPlayerState(hostClientId);
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
  }, [hostClientId, p2p]);

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
        user?.displayName || user?.email || "web"
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
        ...nextPayload
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

  async function handleRemoveTrack(trackId = "", queueIndex = -1, track = null) {
    const normalizedTrackId = String(trackId || "").trim();
    if (!normalizedTrackId || !p2p || !hostClientId || removingTrackId) {
      return;
    }
    const removedTrack = track || queueItems.find((item) => String(item?.id || "") === normalizedTrackId) || null;
    const previousState = playerState;
    setRemovingTrackId(normalizedTrackId);
    setPlayerState((current) => removeTrackFromPlayerState(current, normalizedTrackId));
    try {
      await sendControl("remove-track", {
        trackId: normalizedTrackId,
        queueIndex,
        providerTrackId: removedTrack?.providerTrackId || "",
        relativePath: removedTrack?.relativePath || "",
        title: removedTrack?.title || "",
        source: removedTrack?.source || ""
      }, {
        includeCurrentTrackId: false,
        silentError: true,
        throwOnError: true
      });

      const confirmedState = await refreshState({ force: true });
      const trackStillExists = Array.isArray(confirmedState?.queue)
        && confirmedState.queue.some((item) => String(item?.id || "") === normalizedTrackId);
      if (trackStillExists) {
        throw new Error("移除没有生效，请稍后重试");
      }

      if (removedTrack?.title) {
        onToast?.(`已移除: ${removedTrack.title}`, "success");
      }
    } catch (error) {
      setPlayerState(previousState);
      const message = error?.message || "移除失败";
      updateAudioError(message);
      onToast?.(message, "error");
    } finally {
      setRemovingTrackId("");
    }
  }

  async function handleActivateTrack(track = null, queueIndex = -1) {
    if (!track?.id || queueIndex < 0 || !p2p || !hostClientId) {
      return;
    }
    updateAudioError("");
    if (track.id === currentTrackId) {
      await sendControl("play", {}, { silentError: true });
      return;
    }
    clearLoadedAudio();
    await sendControl("play-track", {
      queueIndex,
      trackId: track.id
    }, {
      includeCurrentTrackId: false,
      silentError: true
    });
  }

  function handleQueueScroll(event) {
    const element = event.currentTarget;
    if (element.scrollTop + element.clientHeight < element.scrollHeight - 120) {
      return;
    }
    setVisibleQueueCount((current) => Math.min(queueItems.length, current + QUEUE_PAGE_SIZE));
  }

  function handleFloatingButtonPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: floatingPositionRef.current.x,
      originY: floatingPositionRef.current.y,
      moved: false
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleFloatingButtonPointerMove(event) {
    const dragState = dragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId || typeof window === "undefined") {
      return;
    }
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) >= 4) {
      dragState.moved = true;
      suppressToggleRef.current = true;
      setDragging(true);
      setCardPinnedOpen(false);
      setPopupOpen(false);
    }
    if (!dragState.moved) {
      return;
    }
    updateFloatingPosition(clampFloatingPosition(
      {
        x: dragState.originX + dx,
        y: dragState.originY + dy
      },
      window.innerWidth,
      window.innerHeight,
      getFloatingFootprint(floatingSurfaceRef.current)
    ));
  }

  function finishFloatingDrag(event) {
    const dragState = dragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId || typeof window === "undefined") {
      return;
    }
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
    if (!dragState.moved) {
      return;
    }
    const snapped = snapFloatingPosition(
      floatingPositionRef.current,
      window.innerWidth,
      window.innerHeight,
      getFloatingFootprint(floatingSurfaceRef.current)
    );
    updateFloatingPosition(snapped);
    saveFloatingPosition(snapped);
    window.setTimeout(() => {
      setDragging(false);
      suppressToggleRef.current = false;
    }, 0);
  }

  function handleFloatingButtonClick() {
    if (suppressToggleRef.current) {
      suppressToggleRef.current = false;
      return;
    }
    setCardPinnedOpen((value) => !value);
  }

  return (
    <MusicPlayerContext.Provider value={{
      currentTrack,
      isPlaying: Boolean(playerState?.isPlaying),
      togglePlay: handlePlayButtonClick,
      nextTrack: () => sendControl("next"),
      prevTrack: () => sendControl("previous"),
    }}>
    <>
      <div
        ref={shellRef}
        className={`globalMusicPlayerShell floating side-${floatingPosition.side}${showFloatingCard ? " cardOpen" : ""}${popupOpen ? " popupOpen" : ""}${dragging ? " dragging" : ""}`}
        style={{ left: `${floatingPosition.x}px`, top: `${floatingPosition.y}px` }}
      >
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
        {!showFloatingCard ? (
          <button
            ref={floatingSurfaceRef}
            type="button"
            className={`globalMusicFloatButton${cardPinnedOpen ? " active" : ""}`}
            onPointerDown={handleFloatingButtonPointerDown}
            onPointerMove={handleFloatingButtonPointerMove}
            onPointerUp={finishFloatingDrag}
            onPointerCancel={finishFloatingDrag}
            onClick={handleFloatingButtonClick}
            aria-label={cardOpen ? "收起悬浮播放器" : "展开悬浮播放器"}
            title={cardOpen ? "收起悬浮播放器" : "展开悬浮播放器"}
          >
            <div className="globalMusicPlayerVisual floatingButton" aria-hidden="true">
              {renderCompactVisual()}
            </div>
          </button>
        ) : null}

        {showFloatingCard ? (
          <div ref={floatingSurfaceRef} className={`globalMusicPlayerCard compact floating${cardVisible ? " isVisible" : " isHidden"}${popupOpen ? " detailOpen" : ""}`}>
            <div
              className="globalMusicPlayerVisual inCard globalMusicDragHandle"
              aria-hidden="true"
              onDragStart={(event) => event.preventDefault()}
              onPointerDown={handleFloatingButtonPointerDown}
              onPointerMove={handleFloatingButtonPointerMove}
              onPointerUp={finishFloatingDrag}
              onPointerCancel={finishFloatingDrag}
            >
              {renderCompactVisual()}
            </div>
            <div className="globalMusicPlayerMain">
            <div className="globalMusicTopRow compactOnly">
              <Text weight="semibold" className="globalMusicTrackTitle compactOnly" title={currentTrack?.title || "等待点歌"}>
                {currentTrack?.title || "等待点歌"}
              </Text>
              <div className="globalMusicInlineActions compactOnly">
                <button
                  type="button"
                  className="globalMusicIconButton iconOnly compact"
                  onClick={() => sendControl("previous")}
                  disabled={!currentTrackId}
                  aria-label="上一曲"
                  title="上一曲"
                >
                  <ChevronLeftRegular />
                </button>
                <button
                  type="button"
                  className="globalMusicPlayButton"
                  onClick={() => handlePlayButtonClick()}
                  disabled={!currentTrackId || audioLoading}
                >
                  {audioLoading ? <Spinner size="tiny" /> : playerState?.isPlaying ? <PauseRegular /> : <PlayRegular />}
                </button>
                <button
                  type="button"
                  className="globalMusicIconButton iconOnly compact"
                  onClick={() => sendControl("next")}
                  disabled={!currentTrackId}
                  aria-label="下一曲"
                  title="下一曲"
                >
                  <ChevronRightRegular />
                </button>
                <button
                  type="button"
                  className={`globalMusicExpandButton${popupOpen ? " active" : ""}`}
                  onClick={() => {
                    if (popupOpen) {
                      closePopup({ preserveKeyword: true });
                      return;
                    }
                    setCardPinnedOpen(true);
                    setPopupOpen(true);
                  }}
                  aria-label={popupOpen ? "收起播放器详情" : "展开播放器详情"}
                  title={popupOpen ? "收起播放器详情" : "展开播放器详情"}
                >
                  <MoreHorizontalRegular />
                </button>
              </div>
            </div>

            <div className="globalMusicBottomRow compactOnly">
              <div className="globalMusicProgressBlock compact minimal">
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
              </div>
            </div>

            {audioError ? <Caption1 className="globalMusicErrorText">{audioError}</Caption1> : null}
            {!audioError && audioNotice ? <Caption1 className={audioNoticeLevel === "warn" ? "globalMusicWarningText" : ""}>{audioNotice}</Caption1> : null}
            </div>
              <div className={`globalMusicExpandedPanel${popupOpen ? " isVisible" : ""}`} onClick={(event) => event.stopPropagation()}>
            <div className="globalMusicPopupHeader">
              <Text weight="semibold">播放器详情</Text>
              <div className="globalMusicPopupBadgesInline">
                <span className="globalMusicStatusPill">{currentTrack?.status === "ready" ? "就绪" : formatProgressLabel(currentTrack)}</span>
                <span className="globalMusicSourcePill">{(currentSource || "bilibili").toUpperCase()}</span>
                <span className="globalMusicQueuePill">队列 {queueCount}</span>
              </div>
            </div>

            <div className="globalMusicPopupNowPlaying">
              <div className="globalMusicProgressMeta popup">
                <Caption1>{formatDuration(progressValue)}</Caption1>
                <div className="globalMusicProgressBlock popupDetail">
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
                </div>
                <Caption1>{formatDuration(currentDuration)}</Caption1>
              </div>
            </div>

            <div className="globalMusicPopupSection controls">
              <label className="globalMusicVolumeControl popup">
                <Caption1>音量</Caption1>
                <input
                  className="globalMusicVolumeRange"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={volume}
                  onChange={(event) => setVolume(Number(event.target.value || 0))}
                  style={{ "--music-progress": `${volume}%` }}
                />
              </label>
              <select
                className="musicSourceSelect"
                value={currentSource}
                onChange={(event) => sendControl("set-source", { source: event.target.value })}
                disabled={!hostClientId}
              >
                {(playerState?.supportedSources || []).map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
              <button type="button" className="globalMusicTextButton" onClick={() => setLyricsOpen((prev) => !prev)}>
                {lyricsOpen ? "隐藏歌词" : "显示歌词"}
              </button>
            </div>

            <form className="globalMusicComposer popup" onSubmit={handleSearchSubmit}>
              <Input
                className="globalMusicInput"
                placeholder={hostClientId ? "输入歌名，先搜候选再入队" : "等待 storage-client 在线"}
                value={keyword}
                onChange={(_, data) => {
                  const nextValue = data.value;
                  setKeyword(nextValue);
                  if (!nextValue.trim()) {
                    resetSearchState({ preserveKeyword: true });
                  }
                }}
                disabled={!hostClientId || searching}
              />
              <div className="globalMusicComposerActions">
                <button
                  type="button"
                  className="globalMusicIconButton iconOnly"
                  onClick={() => resetSearchState()}
                  disabled={!keyword.trim() && !searchResults.length && !searchError}
                  aria-label="清空搜索"
                  title="清空搜索"
                >
                  <span className="globalMusicButtonGlyph" aria-hidden="true">×</span>
                </button>
                <button
                  type="submit"
                  className="globalMusicIconButton iconOnly primary"
                  disabled={!hostClientId || searching || !keyword.trim()}
                  aria-label={searching ? "搜索中" : "搜索"}
                  title={searching ? "搜索中" : "搜索"}
                >
                  {searching ? <Spinner size="tiny" /> : <span className="globalMusicButtonGlyph" aria-hidden="true">⌕</span>}
                </button>
              </div>
            </form>

            {searchError ? <div className="musicSearchStatusText error">{searchError}</div> : null}

            {searchResults.length ? (
              <div className="musicSearchResultList popup">
                {searchResults.map((candidate) => {
                  const candidateId = String(candidate.providerTrackId || "");
                  const busy = selectionBusyId && selectionBusyId === candidateId;
                  const alreadyQueued = queuedCandidateKeys.has(getCandidateQueueKey(candidate));
                  return (
                    <div key={candidateId || `${candidate.source}-${candidate.title}`} className="musicSearchResultCard compact">
                      {candidate.coverUrl ? (
                        <img className="musicSearchCover" src={candidate.coverUrl} alt={candidate.title} />
                      ) : (
                        <div className="musicSearchCover fallback" aria-hidden="true" />
                      )}
                      <div className="musicSearchResultBody">
                        <Text className="musicSearchResultTitle" title={candidate.title}>{candidate.title}</Text>
                        <Caption1>{candidate.artist || "未知艺术家"}</Caption1>
                        <Caption1>{candidate.album || candidate.sourceLabel || candidate.source} · {formatDuration(candidate.duration)}</Caption1>
                      </div>
                      {alreadyQueued ? (
                        <Caption1 className="musicSearchResultStateText">已在队列</Caption1>
                      ) : (
                        <Button appearance="primary" onClick={() => handleSelectCandidate(candidate)} disabled={Boolean(selectionBusyId && selectionBusyId !== candidateId) || busy}>
                          {busy ? "入队中" : "加入队列"}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {lyricsOpen ? (
              <div className="globalMusicLyricsPanel popup">
                <Caption1 className="globalMusicLyricsLabel">歌词</Caption1>
                <div className="globalMusicLyricsBody">
                  {currentTrack?.lyrics ? currentTrack.lyrics : "当前曲目没有可用歌词。"}
                </div>
              </div>
            ) : null}

            <div ref={queueListRef} className="globalMusicQueueStrip popup" onScroll={handleQueueScroll}>
              {queueItems.length ? visibleQueueItems.map((track, index) => (
                <div
                  key={track.id}
                  className={`globalMusicQueueItem musicSearchResultCard compact${index === Number(playerState?.currentIndex ?? -1) ? " active" : ""}`}
                  onDoubleClick={() => handleActivateTrack(track, index)}
                  title="双击切换到这首歌"
                >
                  {track.coverUrl ? (
                    <img className="globalMusicQueueCover musicSearchCover" src={track.coverUrl} alt={track.title} />
                  ) : (
                    <div className="globalMusicQueueCover musicSearchCover fallback" aria-hidden="true" />
                  )}
                  <div className="globalMusicQueueItemBody musicSearchResultBody">
                    <Text className="globalMusicQueueItemTitle musicSearchResultTitle" title={track.title}>{track.title}</Text>
                    <Caption1 title={track.artist || track.sourceLabel || track.source}>{track.artist || track.sourceLabel || track.source}</Caption1>
                    <Caption1 className="globalMusicQueueItemMeta" title={`${track.album || track.sourceLabel || track.source} · ${track.status === "ready" ? "已缓冲完成" : formatProgressLabel(track)}`}>
                      {track.album || track.sourceLabel || track.source} · {track.status === "ready" ? "已缓冲完成" : formatProgressLabel(track)}
                    </Caption1>
                  </div>
                  <button
                    type="button"
                    className="globalMusicQueueRemoveButton"
                    onClick={() => handleRemoveTrack(track.id, index, track)}
                    disabled={Boolean(removingTrackId)}
                    aria-label={`移除 ${track.title}`}
                    title={`移除 ${track.title}`}
                  >
                    {removingTrackId === track.id ? <Spinner size="tiny" /> : <DeleteRegular />}
                  </button>
                </div>
              )) : (
                <div className="globalMusicQueueEmpty">
                  <Caption1>还没有人在点歌，先搜一首再入队。</Caption1>
                </div>
              )}
            </div>
              </div>
          </div>
        ) : null}
      </div>
    </>
    </MusicPlayerContext.Provider>
  );
}
