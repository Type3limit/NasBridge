import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "./api.js";
import { P2PBridgePool } from "./webrtc.js";
import VideoPlayerControls, { VideoDanmakuComposer } from "./components/VideoPlayerControls";
import {
  filterPlayableFiles,
  isVideoMime,
  isAudioMime,
  getHlsPlaybackSupport
} from "./media/mediaCapabilities.js";

// ────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────
const TOKEN_KEY = "nas_token";
const CONTINUE_KEY = "lr_continue_watching_v1";
const THUMB_KEY = "nas_thumb_cache_v1"; // 与 App.jsx 共用同一缓存，保证两页封面展示一致
const SHARE_LAUNCH_KEY = "lr_share_launch";
const MAIN_LAUNCH_KEY = "lr_main_launch";
const MAIN_PREVIEW_KEY = "lr_to_main_preview";
const THUMB_MAX = 80;
const THUMB_MAX_BLOB = 400 * 1024;
const POLL_INTERVAL_MS = 8000;
const CONTROLS_HIDE_MS = 2800;

// 从 sessionStorage 一次性消费 launch 数据（模块加载时执行，保证只读一次）
const _initialShareLaunch = (() => {
  try {
    const raw = sessionStorage.getItem(SHARE_LAUNCH_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(SHARE_LAUNCH_KEY);
    return JSON.parse(raw);
  } catch { return null; }
})();

const _initialMainLaunch = (() => {
  try {
    const raw = sessionStorage.getItem(MAIN_LAUNCH_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(MAIN_LAUNCH_KEY);
    return JSON.parse(raw);
  } catch { return null; }
})();

// ────────────────────────────────────────────────────────────
// 纯函数工具
// ────────────────────────────────────────────────────────────
function formatClock(sec = 0) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(t / 3600);
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

function formatRelative(value) {
  if (!value) return "";
  const diff = Date.now() - Date.parse(value);
  if (!Number.isFinite(diff)) return "";
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  return `${Math.floor(diff / 86_400_000)}天前`;
}

function formatSize(size) {
  if (!size) return "";
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(0)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

function getFileTs(file) {
  return Date.parse(file.createdAt || file.updatedAt || file.syncedAt || "") || 0;
}

function getFileTypeIcon(file) {
  if (isVideoMime(file.mimeType)) return "▶";
  if (isAudioMime(file.mimeType)) return "♪";
  return "◇";
}

// ────────────────────────────────────────────────────────────
// 继续观看持久化 (localStorage)
// ────────────────────────────────────────────────────────────
function loadContinueWatching() {
  try {
    return JSON.parse(localStorage.getItem(CONTINUE_KEY) || "[]");
  } catch { return []; }
}

function saveContinueRecord(fileId, clientId, filePath, fileName, currentTime, duration) {
  if (!fileId || !currentTime) return;
  const list = loadContinueWatching();
  const idx = list.findIndex((r) => r.fileId === fileId);
  const record = {
    fileId, clientId, filePath, fileName,
    currentTime: Math.floor(currentTime),
    duration: Math.floor(duration || 0),
    updatedAt: new Date().toISOString()
  };
  if (idx >= 0) { list[idx] = record; } else { list.unshift(record); }
  try { localStorage.setItem(CONTINUE_KEY, JSON.stringify(list.slice(0, 20))); } catch { }
}

function removeContinueRecord(fileId) {
  const list = loadContinueWatching().filter((r) => r.fileId !== fileId);
  try { localStorage.setItem(CONTINUE_KEY, JSON.stringify(list)); } catch { }
}

// ────────────────────────────────────────────────────────────
// 缩略图缓存
// ────────────────────────────────────────────────────────────
function loadThumbCache() {
  try { return JSON.parse(localStorage.getItem(THUMB_KEY) || "{}"); } catch { return {}; }
}
function saveThumbCache(cache) {
  try { localStorage.setItem(THUMB_KEY, JSON.stringify(cache)); } catch { }
}
function pruneThumbCache(cache) {
  const entries = Object.entries(cache);
  if (entries.length <= THUMB_MAX) return cache;
  entries.sort((a, b) => (b[1].t || 0) - (a[1].t || 0));
  return Object.fromEntries(entries.slice(0, THUMB_MAX));
}
function thumbKey(file) {
  return `${file.clientId}|${file.path}|${file.size}|${file.mimeType || ""}`;
}

// ────────────────────────────────────────────────────────────
// 弹幕工具
// ────────────────────────────────────────────────────────────
function normalizeDanmakuItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: String(item?.id || ""),
      fileId: String(item?.fileId || ""),
      content: String(item?.content || ""),
      timeSec: Math.max(0, Number(item?.timeSec || 0)),
      color: /^#([0-9a-f]{6})$/i.test(String(item?.color || "")) ? String(item.color).toUpperCase() : "#FFFFFF",
      mode: ["scroll", "top", "bottom"].includes(String(item?.mode || "")) ? String(item.mode) : "scroll",
    }))
    .filter((item) => item.id && item.content);
}

function mergeDanmakuItems(existing = [], incoming = []) {
  const m = new Map();
  for (const item of normalizeDanmakuItems(existing)) m.set(item.id, item);
  for (const item of normalizeDanmakuItems(incoming)) m.set(item.id, item);
  return [...m.values()].sort((a, b) => a.timeSec - b.timeSec);
}

function toAlphaColor(opacity) {
  const alpha = Math.round(Math.min(0.9, Math.max(0, Number(opacity || 0))) * 255).toString(16).padStart(2, "0");
  return `#000000${alpha}`;
}

// ────────────────────────────────────────────────────────────
// P2P HLS 段 URL 工具（与 PreviewModal/GlobalMusicPlayer 保持一致）
// ────────────────────────────────────────────────────────────
function buildP2pHlsSegmentUrl(clientId, hlsId, segmentName) {
  return `https://p2p-hls.local/segment/${encodeURIComponent(clientId)}/${encodeURIComponent(hlsId)}/${encodeURIComponent(segmentName)}`;
}

function parseP2pHlsSegmentUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "p2p-hls.local") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] !== "segment" || parts.length < 4) return null;
    return {
      clientId: decodeURIComponent(parts[1]),
      hlsId: decodeURIComponent(parts[2]),
      segmentName: decodeURIComponent(parts.slice(3).join("/"))
    };
  } catch { return null; }
}

// ────────────────────────────────────────────────────────────
// 货架数据构建
// ────────────────────────────────────────────────────────────
const SHELF_PREVIEW_COUNT = 12;
const DANMAKU_SCROLL_DURATION_MS = 9000;
const DANMAKU_FIXED_DURATION_MS = 4200;
const DANMAKU_SCROLL_LANES = 8;
const DANMAKU_FIXED_LANES = 3; // 货架只展示前 N 张，其余进网格

function buildShelves(playableFiles, continueList, onlineClientIds) {
  const onlineFiles = playableFiles.filter((f) => onlineClientIds.has(f.clientId));

  // 全量保留，不再截断——货架自己只展示前 SHELF_PREVIEW_COUNT 张
  const recent = onlineFiles;

  const continueFiles = continueList
    .map((r) => onlineFiles.find((f) => f.id === r.fileId))
    .filter(Boolean);

  const favorites = onlineFiles.filter((f) => f.favorite);

  const audio = onlineFiles.filter((f) => isAudioMime(f.mimeType));

  return { recent, continueFiles, favorites, audio };
}

// ────────────────────────────────────────────────────────────
// P2P HLS Loader 工厂（复用于主播放器和 Hero 背景视频）
// ────────────────────────────────────────────────────────────
function createP2PHlsLoaderClass(p2pInstance) {
  const newHlsStats = () => ({
    aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 }
  });
  return class P2PHlsLoader {
    constructor() {
      this.aborted = false;
      this.stats = newHlsStats();
    }
    load(context, _config, callbacks) {
      this.stats = newHlsStats();
      this.stats.loading.start = performance.now();
      const self = this;
      (async () => {
        try {
          if (self.aborted) return;
          const parsed = parseP2pHlsSegmentUrl(context.url);
          if (!parsed) {
            const resp = await fetch(context.url);
            if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
            const isText = context.type === "manifest" || context.type === "level";
            const data = isText ? await resp.text() : await resp.arrayBuffer();
            const now = performance.now();
            self.stats.loading.first = self.stats.loading.end = now;
            self.stats.loaded = self.stats.total = isText ? data.length : data.byteLength;
            self.stats.chunkCount = 1;
            callbacks.onSuccess({ url: context.url, data }, self.stats, context, null);
            return;
          }
          const response = await p2pInstance.getHlsSegment(
            parsed.clientId, parsed.hlsId, parsed.segmentName, { timeoutMs: 120_000 }
          );
          if (self.aborted) return;
          const data = await response.blob.arrayBuffer();
          const now = performance.now();
          self.stats.loading.first = self.stats.loading.end = now;
          self.stats.loaded = self.stats.total = data.byteLength;
          self.stats.chunkCount = 1;
          callbacks.onSuccess({ url: context.url, data }, self.stats, context, response);
        } catch (err) {
          if (self.aborted) return;
          self.stats.loading.end = performance.now();
          callbacks.onError({ code: 0, text: err.message || "hls load failed" }, context, null, self.stats);
        }
      })();
    }
    abort() {
      this.aborted = true;
      this.stats.aborted = true;
      this.stats.loading.end = performance.now();
    }
    destroy() { this.aborted = true; }
  };
}

// ────────────────────────────────────────────────────────────
// 子组件：MediaCard
// ────────────────────────────────────────────────────────────
function MediaCard({ file, thumbUrl, continueRecord, focused, onClick, onKeyDown, onHover, onRefreshThumb }) {
  const icon = getFileTypeIcon(file);
  const progress = continueRecord && continueRecord.duration > 0
    ? Math.min(100, (continueRecord.currentTime / continueRecord.duration) * 100)
    : 0;

  return (
    <button
      type="button"
      className={`lrCard${focused ? " focused" : ""}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onFocus={() => onHover?.(file.id)}
      aria-label={file.name}
      data-file-id={file.id}
    >
      <div className="lrCardThumb">
        {thumbUrl
          ? <img src={thumbUrl} alt="" />
          : <div className="lrCardThumbFallback">{icon}</div>
        }
        {onRefreshThumb && (
          <button
            type="button"
            className="lrCardRefreshBtn"
            title="重新获取封面"
            aria-label="重新获取封面"
            onClick={(e) => { e.stopPropagation(); onRefreshThumb(file); }}
          >↺</button>
        )}
        {file.favorite && <span className="lrCardFavStar">★</span>}
        {isVideoMime(file.mimeType) && (
          <span className="lrCardThumbBadge">
            {isAudioMime(file.mimeType) ? "音" : "视频"}
          </span>
        )}
        {progress > 0 && (
          <div className="lrCardProgressBar">
            <div className="lrCardProgressInner" style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
      <div className="lrCardBody">
        <div className="lrCardName" title={file.name}>{file.name}</div>
        <div className="lrCardMeta">{formatSize(file.size)}{formatRelative(file.createdAt) ? ` · ${formatRelative(file.createdAt)}` : ""}</div>
      </div>
    </button>
  );
}

// ────────────────────────────────────────────────────────────
// 子组件：InfiniteStrip（横向无限滚动列表）
// ────────────────────────────────────────────────────────────
function InfiniteStrip({ files, thumbMap: tmap, continueMap, focusedId, onPlay, onFocus, onRefreshThumb }) {
  const trackRef = useRef(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(true);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    function sync() {
      setCanPrev(el.scrollLeft > 4);
      setCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    }
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", sync); ro.disconnect(); };
  }, [files.length]);

  // PS5 风格：选中项切换时始终平滑居中
  useEffect(() => {
    if (!focusedId || !trackRef.current) return;
    const track = trackRef.current;
    const el = track.querySelector(`[data-file-id="${focusedId}"]`);
    if (!el) return;
    const elCenter = el.offsetLeft + el.offsetWidth / 2;
    const targetLeft = elCenter - track.clientWidth / 2;
    track.scrollTo({ left: Math.max(0, targetLeft), behavior: "smooth" });
  }, [focusedId]);

  function scrollPrev() {
    const el = trackRef.current;
    if (el) el.scrollBy({ left: -(el.clientWidth * 0.8), behavior: "smooth" });
  }
  function scrollNext() {
    const el = trackRef.current;
    if (el) el.scrollBy({ left: el.clientWidth * 0.8, behavior: "smooth" });
  }

  if (!files.length) return null;

  return (
    <div className="lrInfiniteStrip">
      <div className="lrInfiniteStripHint">
        <span>← → 选择</span><span>↓ 展开搜索</span><span>Enter 播放</span>
        <span className="lrStripCount">{files.length} 项</span>
      </div>
      <div className="lrShelfTrackWrap">
        <button
          type="button"
          className={`lrShelfArrow lrShelfArrowL${canPrev ? "" : " lrShelfArrowHidden"}`}
          onClick={scrollPrev}
          aria-label="向左"
        >‹</button>
        <div className="lrShelfTrack" ref={trackRef} role="list">
          {files.map((file) => (
            <div key={file.id} role="listitem">
              <MediaCard
                file={file}
                thumbUrl={tmap[thumbKey(file)]?.url || ""}
                continueRecord={continueMap[file.id] || null}
                focused={focusedId === file.id}
                onClick={() => onPlay(file)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPlay(file); }
                }}
                onHover={onFocus}
                onRefreshThumb={onRefreshThumb}
              />
            </div>
          ))}
        </div>
        <button
          type="button"
          className={`lrShelfArrow lrShelfArrowR${canNext ? "" : " lrShelfArrowHidden"}`}
          onClick={scrollNext}
          aria-label="向右"
        >›</button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 子组件：InlineGrid（嵌入式网格 + 搜索，↓ 进入，↑首行 退出）
// ────────────────────────────────────────────────────────────
function InlineGrid({ files, thumbMap: tmap, continueMap, focusedId, query, onQueryChange, onPlay, onFocus, onClose, searchRef, onColsChange, onRefreshThumb }) {
  const gridRef = useRef(null);

  // 挂载时聚焦搜索框
  useEffect(() => {
    searchRef?.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 动态测量列数（供外部键盘导航用）
  useEffect(() => {
    if (!gridRef.current) return;
    const measure = () => {
      const el = gridRef.current;
      if (!el) return;
      const items = el.querySelectorAll("[role='listitem']");
      if (!items.length) return;
      let cols = 0;
      const firstTop = items[0].getBoundingClientRect().top;
      for (const item of items) {
        if (Math.abs(item.getBoundingClientRect().top - firstTop) > 4) break;
        cols++;
      }
      if (cols > 0) onColsChange?.(cols);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(gridRef.current);
    return () => ro.disconnect();
  }, [files, query, onColsChange]);

  // 聚焦项自动滚入可视区（已可见则不滚动）
  useEffect(() => {
    if (!focusedId || !gridRef.current) return;
    const grid = gridRef.current;
    const el = grid.querySelector(`[data-file-id="${focusedId}"]`);
    if (!el) return;
    // 用滚动容器（.lrGridBody = grid 的父级）的可视区判断，而非 grid 的内容高度
    const scrollContainer = grid.parentElement || grid;
    const elRect = el.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    if (elRect.top >= containerRect.top + 4 && elRect.bottom <= containerRect.bottom - 4) return;
    el.scrollIntoView({ behavior: "instant", block: "nearest" });
  }, [focusedId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.name.toLowerCase().includes(q));
  }, [files, query]);

  return (
    <div className="lrInlineGrid">
      <div className="lrGridTopBar">
        <button type="button" className="lrPlayerBackBtn" onClick={onClose} style={{ flexShrink: 0 }}>
          ← 收起
        </button>
        <div className="lrGridSearchWrap" style={{ flex: 1 }}>
          <input
            ref={searchRef}
            type="search"
            className="lrGridSearch"
            style={{ width: "100%" }}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="搜索媒体…"
            aria-label="搜索文件"
          />
        </div>
        <span className="lrGridCount">{filtered.length} 项</span>
      </div>
      <div className="lrGridBody">
        {filtered.length === 0 ? (
          <div className="lrGridEmpty">没有找到匹配的文件</div>
        ) : (
          <div className="lrGrid" ref={gridRef} role="list">
            {filtered.map((file) => (
              <div key={file.id} role="listitem">
                <MediaCard
                  file={file}
                  thumbUrl={tmap[thumbKey(file)]?.url || ""}
                  continueRecord={continueMap[file.id] || null}
                  focused={focusedId === file.id}
                  onClick={() => onPlay(file)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPlay(file); }
                  }}
                  onHover={onFocus}
                  onRefreshThumb={onRefreshThumb}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 子组件：Clock
// ────────────────────────────────────────────────────────────
function LiveClock() {
  const [time, setTime] = useState(() => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  });
  useEffect(() => {
    const id = setInterval(() => {
      const now = new Date();
      setTime(`${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
    }, 10_000);
    return () => clearInterval(id);
  }, []);
  return <span className="lrTopBarClock" aria-live="off">{time}</span>;
}

// ────────────────────────────────────────────────────────────
// 主组件
// ────────────────────────────────────────────────────────────
export default function LivingRoomPage() {
  // ── 认证 ───────────────────────────────────────────────────
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  // ── 跨页面启动 ──────────────────────────────────────────────
  // shareMode: 来自分享页「大屏播放」，使用 shareToken 做 P2P，无需登录
  const [shareMode] = useState(_initialShareLaunch);
  // mainLaunchFile: 来自主页「大屏播放」，使用用户 token，库加载后自动播放
  const [mainLaunchFile] = useState(_initialMainLaunch);
  const [mainLaunchPlayed, setMainLaunchPlayed] = useState(false);

  // ── 数据 ───────────────────────────────────────────────────
  const [pageState, setPageState] = useState(() => {
    if (_initialShareLaunch) return "share-player";
    return (localStorage.getItem(TOKEN_KEY) || "") ? "booting" : "login";
  });
  const [files, setFiles] = useState([]);
  const [clients, setClients] = useState([]);
  const [continueList, setContinueList] = useState(() => loadContinueWatching());
  const [thumbMap, setThumbMap] = useState(() => {
    const raw = loadThumbCache();
    return Object.fromEntries(
      Object.entries(raw)
        .filter(([, v]) => v?.url)
        .map(([k, v]) => [k, { url: v.url }])
    );
  });
  const thumbCacheRef = useRef(loadThumbCache());
  const thumbLoadingRef = useRef(new Set());

  // ── P2P ────────────────────────────────────────────────────
  const [p2p, setP2p] = useState(null);

  // ── 播放 ───────────────────────────────────────────────────
  const [playingFile, setPlayingFile] = useState(null);
  const [playerState, setPlayerState] = useState("idle"); // idle | loading | playing | paused | error
  const [playerSrc, setPlayerSrc] = useState("");        // blob URL 或 HLS URL (m3u8)
  const [playerError, setPlayerError] = useState("");
  const [playerCurrentTime, setPlayerCurrentTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hlsAvailProfiles, setHlsAvailProfiles] = useState([]); // [{id,label,height}] 服务端返回
  const [hlsActiveProfile, setHlsActiveProfile] = useState("");  // 当前播放的 profile id
  const [qualityOpen, setQualityOpen] = useState(false);
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const seekOverrideRef = useRef(null); // 切换画质时保存当前播放位置
  const playerReleaseRef = useRef(null);
  const hideTimerRef = useRef(null);
  const saveProgressTimerRef = useRef(null);
  const continueSeekPendingRef = useRef(false);
  const pendingHlsInitRef = useRef(null); // <video> 挂载前 playFile 已就绪时的待处理 attach
  const sessionIdRef = useRef(0);
  const viewportRef = useRef(null);

  // ── Hero 背景视频 ─────────────────────────────────────────
  const heroBgVideoRef = useRef(null);
  const heroBgHlsRef = useRef(null);
  const heroBgTimerRef = useRef(null);

  // ── 弹幕 ───────────────────────────────────────────────────
  const [danmakuItems, setDanmakuItems] = useState([]);
  const [danmakuDraft, setDanmakuDraft] = useState("");
  const [danmakuColor, setDanmakuColor] = useState("#FFFFFF");
  const [danmakuMode, setDanmakuMode] = useState("scroll");
  const [danmakuVisible, setDanmakuVisible] = useState(true);
  const [danmakuBackgroundOpacity, setDanmakuBackgroundOpacity] = useState(0.12);
  const [danmakuFontScale, setDanmakuFontScale] = useState(1);
  const [danmakuTextOpacity, setDanmakuTextOpacity] = useState(1);
  const [danmakuSettingsOpen, setDanmakuSettingsOpen] = useState(false);
  const [danmakuSubmitting, setDanmakuSubmitting] = useState(false);
  const [activeDanmaku, setActiveDanmaku] = useState([]);
  const danmakuFiredRef = useRef(new Set());
  const danmakuScrollLaneRef = useRef(0);
  const danmakuTopLaneRef = useRef(0);
  const danmakuBottomLaneRef = useRef(0);
  const danmakuSequenceRef = useRef(0);
  const danmakuTimersRef = useRef(new Map());
  const activeDanmakuIdsRef = useRef(new Set());
  const lastVideoTimeRef = useRef(0);

  // ── 附加播放器状态 ──────────────────────────────────────────
  const [videoBufferedTime, setVideoBufferedTime] = useState(0);
  const [pictureInPictureActive, setPictureInPictureActive] = useState(false);
  const [fullscreenActive, setFullscreenActive] = useState(false);
  const canUsePictureInPicture = typeof document !== "undefined" && Boolean(document.pictureInPictureEnabled);

  // ── 焦点 ───────────────────────────────────────────────────
  const [focusedFileId, setFocusedFileId] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [browseMode, setBrowseMode] = useState("strip"); // "strip" | "grid"
  const [gridQuery, setGridQuery] = useState("");
  const gridSearchRef = useRef(null);
  const gridColsRef = useRef(6);
  const browseDivRef = useRef(null);
  // ────────────────────────────────────────────────────────────
  const onlineClientIds = useMemo(
    () => new Set(clients.filter((c) => c.status === "online").map((c) => c.id)),
    [clients]
  );

  const playableFiles = useMemo(() => filterPlayableFiles(files), [files]);

  const { recent, continueFiles, favorites, audio } = useMemo(
    () => buildShelves(playableFiles, continueList, onlineClientIds),
    [playableFiles, continueList, onlineClientIds]
  );

  const heroFile = useMemo(() => recent[0] || null, [recent]);
  const heroDisplayFile = useMemo(() => {
    if (focusedFileId) {
      const f = playableFiles.find((pf) => pf.id === focusedFileId);
      if (f) return f;
    }
    return heroFile;
  }, [focusedFileId, playableFiles, heroFile]);

  const continueMap = useMemo(() => {
    const m = {};
    for (const r of continueList) m[r.fileId] = r;
    return m;
  }, [continueList]);

  // 所有可浏览文件（横向列表 / 网格共用）
  const allBrowseFiles = useMemo(() => recent, [recent]);

  // 网格模式过滤结果
  const filteredBrowseFiles = useMemo(() => {
    const q = gridQuery.trim().toLowerCase();
    if (!q) return allBrowseFiles;
    return allBrowseFiles.filter((f) => f.name.toLowerCase().includes(q));
  }, [allBrowseFiles, gridQuery]);

  // ────────────────────────────────────────────────────────────
  // 引导 & P2P
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    const effectiveToken = shareMode?.shareToken || token;
    if (!effectiveToken) { setP2p((prev) => { prev?.dispose(); return null; }); return; }
    const bridge = new P2PBridgePool(effectiveToken, shareMode ? { accessToken: effectiveToken } : {});
    setP2p((prev) => { prev?.dispose(); return bridge; });
    return () => bridge.dispose();
  }, [token, shareMode]);

  const loadLibrary = useCallback(async (tok) => {
    setPageState("loading-library");
    try {
      const [meData, fileData, clientData] = await Promise.all([
        apiRequest("/api/me", { token: tok }),
        apiRequest("/api/files", { token: tok }),
        apiRequest("/api/clients", { token: tok })
      ]);
      setUser(meData.profile);
      setFiles(fileData.files || []);
      setClients(clientData.clients || []);
      setPageState("browsing");
    } catch (err) {
      setPageState(token ? "error" : "login");
      console.error("LivingRoom loadLibrary:", err);
    }
  }, [token]);

  useEffect(() => {
    if (token && pageState === "booting") {
      loadLibrary(token);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // 轮询刷新文件 & 客户端状态（不打断播放）
  useEffect(() => {
    if (!token || pageState !== "browsing") return;
    let timer;
    const poll = async () => {
      try {
        const [fileData, clientData] = await Promise.all([
          apiRequest("/api/files", { token }),
          apiRequest("/api/clients", { token })
        ]);
        setFiles(fileData.files || []);
        setClients(clientData.clients || []);
      } catch { /* silent */ }
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [token, pageState]);

  // ────────────────────────────────────────────────────────────
  // 缩略图
  // ────────────────────────────────────────────────────────────
  const ensureThumb = useCallback(async (file) => {
    if (!p2p || !onlineClientIds.has(file.clientId)) return;
    const k = thumbKey(file);
    if (thumbMap[k] || thumbLoadingRef.current.has(k)) return;
    const persisted = thumbCacheRef.current[k];
    if (persisted?.url) {
      setThumbMap((prev) => ({ ...prev, [k]: { url: persisted.url } }));
      return;
    }
    thumbLoadingRef.current.add(k);
    try {
      const result = await p2p.thumbnailFile(file.clientId, file.path);
      let url = URL.createObjectURL(result.blob);
      if (result.blob.size <= THUMB_MAX_BLOB) {
        try {
          const dataUrl = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onloadend = () => res(fr.result);
            fr.onerror = rej;
            fr.readAsDataURL(result.blob);
          });
          url = dataUrl;
          thumbCacheRef.current[k] = { url: dataUrl, t: Date.now() };
          thumbCacheRef.current = pruneThumbCache(thumbCacheRef.current);
          saveThumbCache(thumbCacheRef.current);
        } catch { /* keep blob url */ }
      }
      setThumbMap((prev) => ({ ...prev, [k]: { url } }));
    } catch { /* silent */ } finally {
      thumbLoadingRef.current.delete(k);
    }
  }, [p2p, onlineClientIds, thumbMap]);

  // 强制重新获取缩略图（让终端删除缓存并重新用 ffmpeg 生成）
  const forceRefreshThumb = useCallback(async (file) => {
    if (!p2p || !onlineClientIds.has(file.clientId)) return;
    // 询问用户是否指定封面帧时间点
    const raw = window.prompt("输入封面时间点（秒），留空则自动选帧", "");
    if (raw === null) return; // 取消
    const parsedSec = raw.trim() === "" ? null : Number(raw.trim());
    if (parsedSec !== null && !Number.isFinite(parsedSec)) {
      window.alert("请输入有效数字（秒）"); return;
    }
    const thumbnailOptions = { force: true, ...(parsedSec != null ? { seekSeconds: parsedSec } : {}) };
    const k = thumbKey(file);
    // 清理本地缓存
    delete thumbCacheRef.current[k];
    saveThumbCache(thumbCacheRef.current);
    thumbLoadingRef.current.delete(k);
    setThumbMap((prev) => { const next = { ...prev }; delete next[k]; return next; });
    thumbLoadingRef.current.add(k);
    try {
      // force: true 让终端删除旧缓存文件并用 ffmpeg 重新生成
      const result = await p2p.thumbnailFile(file.clientId, file.path, thumbnailOptions);
      let url = URL.createObjectURL(result.blob);
      if (result.blob.size <= THUMB_MAX_BLOB) {
        try {
          const dataUrl = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onloadend = () => res(fr.result);
            fr.onerror = rej;
            fr.readAsDataURL(result.blob);
          });
          url = dataUrl;
          thumbCacheRef.current[k] = { url: dataUrl, t: Date.now() };
          thumbCacheRef.current = pruneThumbCache(thumbCacheRef.current);
          saveThumbCache(thumbCacheRef.current);
        } catch { /* keep blob url */ }
      }
      setThumbMap((prev) => ({ ...prev, [k]: { url } }));
    } catch { /* silent */ } finally {
      thumbLoadingRef.current.delete(k);
    }
  }, [p2p, onlineClientIds]);

  // 批量预取前20张缩略图
  useEffect(() => {
    if (!p2p || !recent.length) return;
    for (const file of recent.slice(0, 20)) {
      ensureThumb(file);
    }
  }, [p2p, recent, ensureThumb]);

  // ────────────────────────────────────────────────────────────
  // Hero 背景视频：选中超过1秒后切换为 HLS 片段预览
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    // 清理函数：取消 timer + 销毁旧 HLS + 暂停视频
    const cleanup = () => {
      if (heroBgTimerRef.current) { clearTimeout(heroBgTimerRef.current); heroBgTimerRef.current = null; }
      if (heroBgHlsRef.current) { heroBgHlsRef.current.destroy(); heroBgHlsRef.current = null; }
      if (heroBgVideoRef.current) {
        heroBgVideoRef.current.pause();
        heroBgVideoRef.current.classList.remove("lrHeroBgVideoActive");
      }
    };

    if (!heroDisplayFile || !p2p || !isVideoMime(heroDisplayFile.mimeType) || browseMode !== "strip") {
      cleanup();
      return;
    }

    const file = heroDisplayFile;
    let stale = false;

    heroBgTimerRef.current = setTimeout(async () => {
      heroBgTimerRef.current = null;
      try {
        const hlsCap = await getHlsPlaybackSupport();
        if (stale || !hlsCap.supported) return;

        const hlsResult = await p2p.getHlsManifest(file.clientId, file.path, {
          onProgress: () => {}
        });
        if (stale) return;

        const mod = await import("hls.js");
        const Hls = mod.default;
        if (!Hls?.isSupported?.() || stale) return;

        const rewrittenManifest = String(hlsResult.manifest || "")
          .split(/\r?\n/)
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) return line;
            return buildP2pHlsSegmentUrl(file.clientId, hlsResult.hlsId, trimmed);
          })
          .join("\n");
        const manifestDataUrl = `data:application/vnd.apple.mpegurl;charset=utf-8,${encodeURIComponent(rewrittenManifest)}`;

        const P2PHlsLoaderClass = createP2PHlsLoaderClass(p2p);
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          fLoader: P2PHlsLoaderClass,
          maxBufferLength: 12,
          maxMaxBufferLength: 20,
        });
        heroBgHlsRef.current = hls;

        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) { hls.destroy(); if (heroBgHlsRef.current === hls) heroBgHlsRef.current = null; }
        });

        const video = heroBgVideoRef.current;
        if (!video || stale) { hls.destroy(); heroBgHlsRef.current = null; return; }

        hls.attachMedia(video);
        hls.on(Hls.Events.MEDIA_ATTACHED, () => { hls.loadSource(manifestDataUrl); });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (stale || !heroBgVideoRef.current) return;
          const vid = heroBgVideoRef.current;
          const activate = () => {
            vid.classList.add("lrHeroBgVideoActive");
            // 让封面图淡出
            const bgEl = vid.closest(".lrHero")?.querySelector(".lrHeroBg");
            if (bgEl) bgEl.classList.add("lrHeroBgFaded");
          };
          const doPlay = () => {
            if (stale || !heroBgVideoRef.current) return;
            const dur = vid.duration;
            if (isFinite(dur) && dur > 10) {
              vid.currentTime = dur * 0.3;
            }
            vid.play().catch(() => {});
            activate();
          };
          // MANIFEST_PARSED 阶段 video.duration 可能还是 NaN（尚未收到 segment），
          // 须等 loadedmetadata 之后才能 seek
          if (isFinite(vid.duration) && vid.duration > 0) {
            doPlay();
          } else {
            vid.addEventListener("loadedmetadata", doPlay, { once: true });
          }
        });
      } catch (e) {
        if (!stale) console.debug("[LR BgVideo]", e?.message);
      }
    }, 1000);

    return () => {
      stale = true;
      cleanup();
      // 恢复封面图
      if (heroBgVideoRef.current) {
        const bgEl = heroBgVideoRef.current.closest?.(".lrHero")?.querySelector(".lrHeroBg");
        if (bgEl) bgEl.classList.remove("lrHeroBgFaded");
      }
    };
  }, [heroDisplayFile, p2p, browseMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ────────────────────────────────────────────────────────────
  // 播放控制层——隐藏 timer
  // ────────────────────────────────────────────────────────────
  const cancelHideTimer = useCallback(() => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  }, []);

  const scheduleHide = useCallback(() => {
    cancelHideTimer();
    hideTimerRef.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) {
        setControlsVisible(false);
      }
      hideTimerRef.current = null;
    }, CONTROLS_HIDE_MS);
  }, [cancelHideTimer]);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (playerState === "playing") scheduleHide();
    else cancelHideTimer();
  }, [playerState, scheduleHide, cancelHideTimer]);

  useEffect(() => {
    return () => { cancelHideTimer(); };
  }, [cancelHideTimer]);

  // 画质菜单打开时禁止自动隐藏控制条
  useEffect(() => {
    if (qualityOpen) cancelHideTimer();
  }, [qualityOpen, cancelHideTimer]);

  // ────────────────────────────────────────────────────────────
  // 释放播放资源
  // ────────────────────────────────────────────────────────────
  const releasePlayer = useCallback(() => {
    // 退出画中画，避免关闭播放器时 PiP 小窗残留
    if (videoRef.current && document.pictureInPictureElement === videoRef.current) {
      document.exitPictureInPicture().catch(() => {});
    }
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    if (playerReleaseRef.current) { playerReleaseRef.current(); playerReleaseRef.current = null; }
    if (playerSrc && playerSrc.startsWith("blob:")) URL.revokeObjectURL(playerSrc);
    setPlayerSrc("");
    setPlayerState("idle");
    setPlayerError("");
    setPlayerCurrentTime(0);
    setPlayerDuration(0);
    setHlsAvailProfiles([]);
    setHlsActiveProfile("");
    setQualityOpen(false);
    setVideoBufferedTime(0);
    setDanmakuItems([]);
    setDanmakuDraft("");
    setActiveDanmaku([]);
    danmakuFiredRef.current = new Set();
    danmakuScrollLaneRef.current = 0;
    danmakuTopLaneRef.current = 0;
    danmakuBottomLaneRef.current = 0;
    lastVideoTimeRef.current = 0;
    for (const t of danmakuTimersRef.current.values()) clearTimeout(t);
    danmakuTimersRef.current.clear();
    activeDanmakuIdsRef.current.clear();
    continueSeekPendingRef.current = false;
    cancelHideTimer();
    if (saveProgressTimerRef.current) { clearInterval(saveProgressTimerRef.current); saveProgressTimerRef.current = null; }
  }, [playerSrc, cancelHideTimer]);

  // ────────────────────────────────────────────────────────────
  // 弹幕应用 / 清除
  // ────────────────────────────────────────────────────────────
  function clearActiveDanmaku() {
    for (const timer of danmakuTimersRef.current.values()) clearTimeout(timer);
    danmakuTimersRef.current.clear();
    activeDanmakuIdsRef.current.clear();
    setActiveDanmaku([]);
  }

  function enqueueDanmaku(item) {
    if (!item?.id || activeDanmakuIdsRef.current.has(item.id)) return;
    const overlayId = `${item.id}:${danmakuSequenceRef.current++}`;
    const isScroll = item.mode === "scroll";
    const lane = isScroll
      ? danmakuScrollLaneRef.current++ % DANMAKU_SCROLL_LANES
      : item.mode === "top"
        ? danmakuTopLaneRef.current++ % DANMAKU_FIXED_LANES
        : danmakuBottomLaneRef.current++ % DANMAKU_FIXED_LANES;
    const durationMs = isScroll ? DANMAKU_SCROLL_DURATION_MS : DANMAKU_FIXED_DURATION_MS;
    const next = { ...item, overlayId, lane, durationMs };
    activeDanmakuIdsRef.current.add(item.id);
    setActiveDanmaku((prev) => [...prev, next]);
    const timer = window.setTimeout(() => {
      danmakuTimersRef.current.delete(overlayId);
      activeDanmakuIdsRef.current.delete(item.id);
      setActiveDanmaku((prev) => prev.filter((e) => e.overlayId !== overlayId));
    }, durationMs + 400);
    danmakuTimersRef.current.set(overlayId, timer);
  }

  // ────────────────────────────────────────────────────────────
  // 打开媒体播放
  // ────────────────────────────────────────────────────────────
  const playFile = useCallback(async (file, { profile = "max", seekTo = null } = {}) => {
    if (!p2p) return;
    seekOverrideRef.current = seekTo;
    const sessionId = ++sessionIdRef.current;
    releasePlayer();
    setPlayingFile(file);
    setPlayerState("loading");
    setControlsVisible(true);

    try {
      const isVideo = isVideoMime(file.mimeType);
      const isAudio = isAudioMime(file.mimeType);
      if (!isVideo && !isAudio) {
        setPlayerError("该文件暂不支持在大屏页播放");
        setPlayerState("error");
        return;
      }

      if (isVideo) {
        const hlsCap = await getHlsPlaybackSupport();
        if (hlsCap.supported) {
          // 通过 P2P 获取 HLS manifest，与主工作台预览保持一致
          try {
            const hlsResult = await p2p.getHlsManifest(file.clientId, file.path, {
              profile: profile || "max",
              onProgress: (status) => {
                if (status?.message) console.debug("[LR HLS]", status.message);
              }
            });
            if (sessionId !== sessionIdRef.current) return;
            // 存储服务端返回的可用画质档位
            setHlsAvailProfiles(Array.isArray(hlsResult.availableProfiles) ? hlsResult.availableProfiles : []);
            setHlsActiveProfile(hlsResult.profile || "");

            const mod = await import("hls.js");
            const Hls = mod.default;
            if (!Hls?.isSupported?.()) throw new Error("hls.js not supported");

            // 将 manifest 中的段名重写为 P2P URL
            const rewrittenManifest = String(hlsResult.manifest || "")
              .split(/\r?\n/)
              .map((line) => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#")) return line;
                return buildP2pHlsSegmentUrl(file.clientId, hlsResult.hlsId, trimmed);
              })
              .join("\n");
            const manifestDataUrl = `data:application/vnd.apple.mpegurl;charset=utf-8,${encodeURIComponent(rewrittenManifest)}`;

            const currentP2p = p2p;
            const newHlsStats = () => ({
              aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
              loading: { start: 0, first: 0, end: 0 },
              parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 }
            });
            class P2PHlsLoader {
              constructor() {
                this.aborted = false;
                this.stats = newHlsStats(); // hls.js 外部会直接读取 loader.stats
              }
              load(context, _config, callbacks) {
                this.stats = newHlsStats();
                this.stats.loading.start = performance.now();
                const self = this;
                (async () => {
                  try {
                    if (self.aborted) return;
                    const parsed = parseP2pHlsSegmentUrl(context.url);
                    if (!parsed) {
                      const resp = await fetch(context.url);
                      if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
                      const isText = context.type === "manifest" || context.type === "level";
                      const data = isText ? await resp.text() : await resp.arrayBuffer();
                      const now = performance.now();
                      self.stats.loading.first = self.stats.loading.end = now;
                      self.stats.loaded = self.stats.total = isText ? data.length : data.byteLength;
                      self.stats.chunkCount = 1;
                      callbacks.onSuccess({ url: context.url, data }, self.stats, context, null);
                      return;
                    }
                    const response = await currentP2p.getHlsSegment(
                      parsed.clientId, parsed.hlsId, parsed.segmentName, { timeoutMs: 120_000 }
                    );
                    if (self.aborted) return;
                    const data = await response.blob.arrayBuffer();
                    const now = performance.now();
                    self.stats.loading.first = self.stats.loading.end = now;
                    self.stats.loaded = self.stats.total = data.byteLength;
                    self.stats.chunkCount = 1;
                    callbacks.onSuccess({ url: context.url, data }, self.stats, context, response);
                  } catch (err) {
                    if (self.aborted) return;
                    self.stats.loading.end = performance.now();
                    callbacks.onError({ code: 0, text: err.message || "hls load failed" }, context, null, self.stats);
                  }
                })();
              }
              abort() {
                this.aborted = true;
                this.stats.aborted = true;
                this.stats.loading.end = performance.now();
              }
              destroy() { this.aborted = true; }
            }

            const hls = new Hls({ enableWorker: true, lowLatencyMode: false, fLoader: P2PHlsLoader });
            hlsRef.current = hls;
            hls.on(Hls.Events.ERROR, (_, data) => {
              if (!data.fatal) return;
              setPlayerError(`HLS 错误: ${data.details || data.type}`);
              setPlayerState("error");
              cancelHideTimer();
              setControlsVisible(true);
            });
            const doAttach = (video) => {
              video.load(); // 重置视频元素，清除上一次 HLS 残留的 MediaSource
              hls.attachMedia(video);
              hls.on(Hls.Events.MEDIA_ATTACHED, () => {
                hls.loadSource(manifestDataUrl);
              });
              hls.on(Hls.Events.MANIFEST_PARSED, () => {
                if (sessionId !== sessionIdRef.current) return;
                setPlayerState("playing");
                setControlsVisible(true);
                scheduleHide();
                const seekTarget = seekOverrideRef.current;
                seekOverrideRef.current = null;
                if (seekTarget != null && video) {
                  video.currentTime = seekTarget;
                } else {
                  seekToContinue(file, video);
                }
              });
            };
            if (videoRef.current) {
              doAttach(videoRef.current);
            } else {
              // <video> 尚未挂载（从浏览态首次点击时 React 还未完成渲染）
              // 暂存 doAttach，等 useEffect 监测到视频元素挂载后再调用
              pendingHlsInitRef.current = { sessionId, doAttach };
            }
            return;
          } catch (hlsErr) {
            if (sessionId !== sessionIdRef.current) return;
            console.warn("[LR] HLS via P2P 失败，回退 blob:", hlsErr.message);
          }
        }
      }

      // 音频 或 视频 HLS 失败后 blob 回退
      await doDirectPlay(file, sessionId);
    } catch (err) {
      if (sessionId !== sessionIdRef.current) return;
      setPlayerError(err.message || "播放失败");
      setPlayerState("error");
    }
  }, [p2p, releasePlayer, scheduleHide, cancelHideTimer]); // eslint-disable-line react-hooks/exhaustive-deps

  // <video> 挂载后消费待处理的 HLS attach（修复首次播放时 videoRef 尚为 null 的竞态）
  // 用 useLayoutEffect 而非 useEffect：在 DOM commit 后同步执行，保证 videoRef 已设置
  useLayoutEffect(() => {
    if (!playingFile || !videoRef.current) return;
    const pending = pendingHlsInitRef.current;
    if (!pending || pending.sessionId !== sessionIdRef.current) {
      pendingHlsInitRef.current = null;
      return;
    }
    pendingHlsInitRef.current = null;
    pending.doAttach(videoRef.current);
  }, [playingFile]);

  async function doDirectPlay(file, sessionId) {
    const result = await p2p.downloadFile(file.clientId, file.path);
    if (sessionId !== sessionIdRef.current) return;
    const blobUrl = URL.createObjectURL(result.blob);
    playerReleaseRef.current = () => URL.revokeObjectURL(blobUrl);
    setPlayerSrc(blobUrl);
    setPlayerState("playing");
    setControlsVisible(true);
    scheduleHide();
    seekToContinue(file, videoRef.current);
  }

  function seekToContinue(file, videoEl) {
    const rec = loadContinueWatching().find((r) => r.fileId === file.id);
    if (!rec || !rec.currentTime || rec.currentTime < 2) return;
    if (rec.duration && rec.currentTime / rec.duration > 0.97) return;
    continueSeekPendingRef.current = true;
    // 等 video 元素加载 metadata 后 seek（在 onLoadedMetadata 里处理）
    if (videoEl && videoEl.readyState >= 1) {
      videoEl.currentTime = rec.currentTime;
      continueSeekPendingRef.current = false;
    }
  }

  // ────────────────────────────────────────────────────────────
  // 关闭播放
  // ────────────────────────────────────────────────────────────
  const closePlayer = useCallback(() => {
    if (playingFile && videoRef.current) {
      const ct = videoRef.current.currentTime;
      const dur = videoRef.current.duration;
      if (ct > 2) {
        saveContinueRecord(
          playingFile.id, playingFile.clientId, playingFile.path, playingFile.name, ct, dur
        );
        setContinueList(loadContinueWatching());
      }
    }
    releasePlayer();
    setPlayingFile(null);
  }, [playingFile, releasePlayer]);

  const switchQuality = useCallback((profileId) => {
    if (!playingFile) return;
    const currentTime = videoRef.current?.currentTime ?? null;
    setQualityOpen(false);
    playFile(playingFile, { profile: profileId, seekTo: currentTime });
  }, [playingFile, playFile]);

  // ────────────────────────────────────────────────────────────
  // 跨页面启动自动播放（在 playFile 声明之后，保证无 TDZ）
  // ────────────────────────────────────────────────────────────
  const [shareLaunched, setShareLaunched] = useState(false);
  useEffect(() => {
    if (!shareMode || !p2p || shareLaunched) return;
    setShareLaunched(true);
    playFile(shareMode.file, { seekTo: shareMode.seekTo || null });
  }, [shareMode, p2p, shareLaunched, playFile]);

  useEffect(() => {
    if (!mainLaunchFile || !p2p || mainLaunchPlayed || pageState !== "browsing") return;
    setMainLaunchPlayed(true);
    playFile(mainLaunchFile, { seekTo: null });
  }, [mainLaunchFile, p2p, mainLaunchPlayed, pageState, playFile]);

  // 接收主页通过 postMessage/BroadcastChannel 发来的播放指令
  useEffect(() => {
    function handleMessage(e) {
      if (e.origin !== window.location.origin) return;
      if (!e.data || e.data.type !== "lr_play_file") return;
      playFile(e.data.file, { seekTo: null });
    }
    window.addEventListener("message", handleMessage);
    let bc = null;
    try {
      bc = new BroadcastChannel("nas_living_room_bc");
      bc.onmessage = (e) => {
        if (!e.data || e.data.type !== "lr_play_file") return;
        playFile(e.data.file, { seekTo: null });
      };
    } catch { }
    return () => {
      window.removeEventListener("message", handleMessage);
      try { bc?.close(); } catch { }
    };
  }, [playFile]);

  // ────────────────────────────────────────────────────────────
  // 弹幕加载（打开文件时拉取历史弹幕）
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playingFile || !token || !isVideoMime(playingFile.mimeType)) {
      setDanmakuItems([]);
      return;
    }
    let disposed = false;
    apiRequest(`/api/file-danmaku?fileId=${encodeURIComponent(playingFile.id)}`, { token })
      .then((data) => { if (!disposed) setDanmakuItems(normalizeDanmakuItems(data.danmaku)); })
      .catch(() => {});
    return () => { disposed = true; };
  }, [playingFile, token]);

  // ────────────────────────────────────────────────────────────
  // P2P 实时弹幕推送
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!p2p || !playingFile || !isVideoMime(playingFile.mimeType)) return;
    return p2p.onServerMessage((message) => {
      if (message?.type !== "file-danmaku-created") return;
      const created = normalizeDanmakuItems([message.payload])[0];
      if (!created || created.fileId !== playingFile.id) return;
      setDanmakuItems((prev) => mergeDanmakuItems(prev, [created]));
      const ct = videoRef.current?.currentTime || 0;
      if (danmakuVisible && Math.abs(ct - created.timeSec) <= 0.8 && !danmakuFiredRef.current.has(created.id)) {
        danmakuFiredRef.current.add(created.id);
        enqueueDanmaku(created);
      }
    });
  }, [p2p, playingFile, danmakuVisible]); // eslint-disable-line react-hooks/exhaustive-deps

  // ────────────────────────────────────────────────────────────
  // 弹幕同步（取代 handleVideoTimeUpdate，监听 timeupdate/seeked/play）
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playingFile) return;
    const video = videoRef.current;
    if (!video) return;
    const syncDanmaku = () => {
      const ct = video.currentTime || 0;
      const prev = lastVideoTimeRef.current;
      const rewound = ct + 0.8 < prev;
      if (rewound) {
        danmakuFiredRef.current = new Set();
        danmakuScrollLaneRef.current = 0;
        danmakuTopLaneRef.current = 0;
        danmakuBottomLaneRef.current = 0;
        clearActiveDanmaku();
      }
      const lower = rewound ? Math.max(0, ct - 0.1) : prev;
      const upper = ct + 0.12;
      setPlayerCurrentTime(ct);
      if (video.buffered.length > 0) setVideoBufferedTime(video.buffered.end(video.buffered.length - 1));
      if (danmakuVisible) {
        for (const item of danmakuItems) {
          if (!danmakuFiredRef.current.has(item.id) && item.timeSec >= lower && item.timeSec <= upper) {
            danmakuFiredRef.current.add(item.id);
            enqueueDanmaku(item);
          }
        }
      }
      lastVideoTimeRef.current = ct;
    };
    video.addEventListener("timeupdate", syncDanmaku);
    video.addEventListener("seeked", syncDanmaku);
    video.addEventListener("play", syncDanmaku);
    return () => {
      video.removeEventListener("timeupdate", syncDanmaku);
      video.removeEventListener("seeked", syncDanmaku);
      video.removeEventListener("play", syncDanmaku);
    };
  }, [playingFile, danmakuItems, danmakuVisible]); // eslint-disable-line react-hooks/exhaustive-deps

  // ────────────────────────────────────────────────────────────
  // 画中画 + 全屏 状态同步
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playingFile) return;
    const video = videoRef.current;
    const syncPiP = () => setPictureInPictureActive(document.pictureInPictureElement === video);
    const syncFS = () => {
      const el = document.fullscreenElement || document.webkitFullscreenElement;
      const vp = viewportRef.current;
      setFullscreenActive(Boolean(el && vp && (el === vp || vp.contains(el))));
    };
    syncPiP();
    syncFS();
    document.addEventListener("fullscreenchange", syncFS);
    document.addEventListener("webkitfullscreenchange", syncFS);
    video?.addEventListener("enterpictureinpicture", syncPiP);
    video?.addEventListener("leavepictureinpicture", syncPiP);
    return () => {
      document.removeEventListener("fullscreenchange", syncFS);
      document.removeEventListener("webkitfullscreenchange", syncFS);
      video?.removeEventListener("enterpictureinpicture", syncPiP);
      video?.removeEventListener("leavepictureinpicture", syncPiP);
    };
  }, [playingFile]);

  // ────────────────────────────────────────────────────────────
  // Media Session API（画中画小窗的播放控制）
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playingFile || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: playingFile.name });
    navigator.mediaSession.setActionHandler("play", () => videoRef.current?.play().catch(() => {}));
    navigator.mediaSession.setActionHandler("pause", () => videoRef.current?.pause());
    navigator.mediaSession.setActionHandler("seekbackward", () => {
      if (videoRef.current) videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 10);
    });
    navigator.mediaSession.setActionHandler("seekforward", () => {
      if (videoRef.current) videoRef.current.currentTime = Math.min(videoRef.current.duration || 0, videoRef.current.currentTime + 10);
    });
    return () => {
      if ("mediaSession" in navigator) {
        ["play", "pause", "seekbackward", "seekforward"].forEach((action) => {
          navigator.mediaSession.setActionHandler(action, null);
        });
      }
    };
  }, [playingFile]);

  // ────────────────────────────────────────────────────────────
  // 发送弹幕
  // ────────────────────────────────────────────────────────────
  async function submitDanmaku() {
    const content = danmakuDraft.trim();
    if (!content || !playingFile || !token) return;
    setDanmakuSubmitting(true);
    try {
      const ct = videoRef.current?.currentTime || 0;
      const data = await apiRequest("/api/file-danmaku", {
        method: "POST",
        token,
        body: { fileId: playingFile.id, content, timeSec: ct, color: danmakuColor, mode: danmakuMode },
      });
      setDanmakuDraft("");
      // server returns { item, danmaku: [...] } — merge full list
      if (data?.danmaku) setDanmakuItems((prev) => mergeDanmakuItems(prev, data.danmaku));
    } catch (err) {
      console.error("[LR] danmaku submit:", err);
    } finally {
      setDanmakuSubmitting(false);
    }
  }

  // ────────────────────────────────────────────────────────────
  // 进度自动保存
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playingFile || playerState !== "playing") return;
    saveProgressTimerRef.current = setInterval(() => {
      if (!videoRef.current || !playingFile) return;
      const ct = videoRef.current.currentTime;
      const dur = videoRef.current.duration;
      if (ct > 2) saveContinueRecord(playingFile.id, playingFile.clientId, playingFile.path, playingFile.name, ct, dur);
    }, 10_000);
    return () => { clearInterval(saveProgressTimerRef.current); saveProgressTimerRef.current = null; };
  }, [playingFile, playerState]);

  // ────────────────────────────────────────────────────────────
  // 视频元素事件
  // ────────────────────────────────────────────────────────────
  function handleVideoLoadedMetadata() {
    const el = videoRef.current;
    if (!el) return;
    setPlayerDuration(el.duration || 0);
    if (continueSeekPendingRef.current) {
      const rec = playingFile ? loadContinueWatching().find((r) => r.fileId === playingFile.id) : null;
      if (rec?.currentTime && rec.currentTime < el.duration * 0.97) {
        el.currentTime = rec.currentTime;
      }
      continueSeekPendingRef.current = false;
    }
  }

  function handleVideoPlay() {
    setPlayerState("playing");
    scheduleHide();
  }

  function handleVideoPause() {
    setPlayerState("paused");
    cancelHideTimer();
    setControlsVisible(true);
  }

  function handleVideoEnded() {
    setPlayerState("paused");
    cancelHideTimer();
    setControlsVisible(true);
    if (playingFile) {
      removeContinueRecord(playingFile.id);
      setContinueList(loadContinueWatching());
    }
  }

  function handleVideoError() {
    const code = videoRef.current?.error?.code;
    setPlayerError(code ? `媒体错误 (code ${code})` : "播放器遇到未知错误");
    setPlayerState("error");
    cancelHideTimer();
    setControlsVisible(true);
  }

  // ────────────────────────────────────────────────────────────
  // 播放器操作
  // ────────────────────────────────────────────────────────────
  function togglePlay() {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) { el.play().catch(() => {}); }
    else { el.pause(); }
    revealControls();
  }

  function seekBy(deltaSec) {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + deltaSec));
    revealControls();
  }

  function handleSeekInput(e) {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Number(e.target.value);
    revealControls();
  }

  // ────────────────────────────────────────────────────────────
  // 键盘导航
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e) {
      // ── 播放层 ────────────────────────────────────────────
      if (playingFile) {
        if (e.key === "Escape" || e.key === "Backspace") {
          if (document.activeElement?.tagName === "INPUT") return;
          e.preventDefault();
          // 如果画中画正在运行，先退出 PiP 而非关闭播放器
          if (pictureInPictureActive) {
            document.exitPictureInPicture().catch(() => {});
            return;
          }
          closePlayer();
          return;
        }
        if (e.key === " " || e.key === "MediaPlayPause") { e.preventDefault(); togglePlay(); return; }
        if (e.key === "ArrowLeft") { e.preventDefault(); seekBy(-10); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); seekBy(10); return; }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); revealControls(); return; }
        // 全屏快捷键: Ctrl+Enter 或 F
        if ((e.key === "Enter" && e.ctrlKey) || (e.key === "f" && !e.ctrlKey && !e.metaKey && !e.altKey)) {
          e.preventDefault();
          const vp = viewportRef.current;
          if (!vp) return;
          if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
          else vp.requestFullscreen?.().catch(() => {});
          return;
        }
        return;
      }

      // ── 横向列表（strip）模式 ─────────────────────────────
      if (browseMode === "strip") {
        if (document.activeElement?.tagName === "INPUT") return;
        const files = allBrowseFiles;
        if (!files.length) return;
        const curIdx = focusedFileId != null ? files.findIndex((f) => f.id === focusedFileId) : -1;
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setFocusedFileId(files[(Math.max(0, curIdx) + 1) % files.length].id);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          setFocusedFileId(files[(curIdx <= 0 ? files.length : curIdx) - 1].id);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          setBrowseMode("grid");
        } else if (e.key === "Enter" || e.key === " ") {
          if (focusedFileId) {
            const file = files.find((f) => f.id === focusedFileId);
            if (file) { e.preventDefault(); playFile(file); }
          } else if (files[0]) {
            e.preventDefault();
            setFocusedFileId(files[0].id);
          }
        }
        return;
      }

      // ── 网格（grid）模式 ──────────────────────────────────
      if (browseMode === "grid") {
        if (e.key === "Escape") {
          if (document.activeElement?.tagName === "INPUT") {
            document.activeElement.blur();
            return;
          }
          e.preventDefault();
          setBrowseMode("strip");
          setGridQuery("");
          return;
        }

        const COLS = gridColsRef.current;
        const files = filteredBrowseFiles;
        const curIdx = focusedFileId != null ? files.findIndex((f) => f.id === focusedFileId) : -1;

        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
          e.preventDefault();
          if (e.key === "ArrowRight") {
            const next = files[curIdx + 1];
            if (next) setFocusedFileId(next.id);
          } else if (e.key === "ArrowLeft") {
            if (curIdx > 0) setFocusedFileId(files[curIdx - 1].id);
          } else if (e.key === "ArrowDown") {
            const next = files[curIdx + COLS];
            if (next) setFocusedFileId(next.id);
          } else if (e.key === "ArrowUp") {
            if (curIdx < COLS) {
              // 第一行：退回横向列表
              setBrowseMode("strip");
              setGridQuery("");
            } else {
              const prev = files[curIdx - COLS];
              if (prev) setFocusedFileId(prev.id);
            }
          }
          return;
        }

        if (e.key === "Enter" || e.key === " ") {
          if (focusedFileId) {
            const file = files.find((f) => f.id === focusedFileId);
            if (file) { e.preventDefault(); playFile(file); return; }
          }
          // 空格在搜索框里正常输入，回车在搜索框提交后退出
          return;
        }

        // 可打印字符 → 路由到搜索框（排除空格，空格用于播放）
        if (document.activeElement !== gridSearchRef.current) {
          if (e.key === "Backspace") {
            e.preventDefault();
            setGridQuery((prev) => prev.slice(0, -1));
            gridSearchRef.current?.focus();
          } else if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            setGridQuery((prev) => prev + e.key);
            gridSearchRef.current?.focus();
          }
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playingFile, pictureInPictureActive, browseMode, focusedFileId, allBrowseFiles, filteredBrowseFiles, closePlayer, togglePlay, seekBy, revealControls, playFile]);

  // ────────────────────────────────────────────────────────────
  // 鼠标滚轮浏览导航
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = browseDivRef.current;
    if (!el) return;
    function onWheel(e) {
      // 播放页开着时不处理
      if (playingFile) return;
      const down = e.deltaY > 0;
      if (browseMode === "strip") {
        // 滚轮下滚→切换网格模式
        if (down) {
          e.preventDefault();
          setBrowseMode("grid");
          // 保留当前选中项，若没有则选第一项
          if (!focusedFileId && allBrowseFiles.length) {
            setFocusedFileId(allBrowseFiles[0].id);
          }
        }
        return;
      }
      if (browseMode === "grid") {
        // 搜索框内满足滚动时由浏览器默认处理
        const searchEl = gridSearchRef.current;
        if (searchEl && document.activeElement === searchEl) return;
        const files = filteredBrowseFiles;
        if (!files.length) return;
        const COLS = gridColsRef.current || 1;
        const curIdx = focusedFileId != null ? files.findIndex((f) => f.id === focusedFileId) : -1;
        if (down) {
          // 向下选一行
          e.preventDefault();
          const next = files[curIdx + COLS];
          if (next) {
            setFocusedFileId(next.id);
          } else if (curIdx < files.length - 1) {
            // 最后一行尚没满，跳到最后一项
            setFocusedFileId(files[files.length - 1].id);
          }
        } else {
          // 向上滚
          e.preventDefault();
          if (curIdx <= 0) {
            // 第一项已是首项，退回 strip
            setBrowseMode("strip");
            setGridQuery("");
          } else if (curIdx < COLS) {
            // 第一行内任意一项，退回 strip
            setBrowseMode("strip");
            setGridQuery("");
          } else {
            const prev = files[curIdx - COLS];
            if (prev) setFocusedFileId(prev.id);
          }
        }
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [playingFile, browseMode, focusedFileId, allBrowseFiles, filteredBrowseFiles]);
  // eslint-disable-line react-hooks/exhaustive-deps

  // ────────────────────────────────────────────────────────────
  // 登录
  // ────────────────────────────────────────────────────────────
  async function handleLogin(e) {
    e?.preventDefault();
    if (!loginEmail || !loginPass) { setLoginError("请填写邮箱和密码"); return; }
    setLoginBusy(true);
    setLoginError("");
    try {
      const data = await apiRequest("/api/auth/login", {
        method: "POST",
        body: { email: loginEmail, password: loginPass }
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setPageState("booting");
    } catch (err) {
      setLoginError(err.message || "登录失败");
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleRegister(e) {
    e?.preventDefault();
    if (!loginEmail || !loginPass) { setLoginError("请填写邮箱和密码"); return; }
    setLoginBusy(true);
    setLoginError("");
    try {
      const data = await apiRequest("/api/auth/register", {
        method: "POST",
        body: { email: loginEmail, password: loginPass, displayName: loginEmail.split("@")[0] }
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setPageState("booting");
    } catch (err) {
      setLoginError(err.message || "注册失败");
    } finally {
      setLoginBusy(false);
    }
  }

  function handleLogout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setUser(null);
    setFiles([]);
    setClients([]);
    setPlayingFile(null);
    releasePlayer();
    setPageState("login");
  }

  // ────────────────────────────────────────────────────────────
  // 渲染
  // ────────────────────────────────────────────────────────────

  // 分享模式：播放器尚未启动时显示加载屏
  if (pageState === "share-player" && !playingFile) {
    return (
      <div className="lrBoot" role="status" aria-live="polite">
        <div className="lrBootSpinner" />
        <div className="lrBootTitle">正在启动大屏播放…</div>
        <div className="lrBootSub">{shareMode?.file?.name || "加载中"}</div>
      </div>
    );
  }

  // 启动中 / 加载中
  if (pageState === "booting" || pageState === "loading-library") {
    return (
      <div className="lrBoot" role="status" aria-live="polite">
        <div className="lrBootSpinner" />
        <div className="lrBootTitle">
          {pageState === "booting" ? "正在连接…" : "正在加载媒体库…"}
        </div>
        <div className="lrBootSub">NAS Bridge 大屏纯享</div>
      </div>
    );
  }

  // 错误
  if (pageState === "error") {
    return (
      <div className="lrBoot">
        <div style={{ fontSize: "2rem" }}>⚠</div>
        <div className="lrBootTitle">加载失败</div>
        <div className="lrBootSub">请检查网络或重新登录</div>
        <button
          type="button"
          className="lrLoginBtn"
          style={{ marginTop: 12, width: 160 }}
          onClick={handleLogout}
        >
          重新登录
        </button>
      </div>
    );
  }

  // 登录页
  if (pageState === "login") {
    return (
      <div className="lrLogin">
        <div className="lrLoginCard">
          <div>
            <div className="lrLoginTitle">NAS Bridge</div>
            <div className="lrLoginSub">大屏纯享页 — 请先登录</div>
          </div>
          <div className="lrLoginField">
            <label className="lrLoginLabel" htmlFor="lr-email">邮箱</label>
            <input
              id="lr-email"
              type="email"
              className="lrLoginInput"
              value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
              autoComplete="email"
              placeholder="user@example.com"
            />
          </div>
          <div className="lrLoginField">
            <label className="lrLoginLabel" htmlFor="lr-pass">密码</label>
            <input
              id="lr-pass"
              type="password"
              className="lrLoginInput"
              value={loginPass}
              onChange={(e) => setLoginPass(e.target.value)}
              autoComplete="current-password"
              onKeyDown={(e) => { if (e.key === "Enter") authMode === "login" ? handleLogin() : handleRegister(); }}
            />
          </div>
          {loginError && <div className="lrLoginError">{loginError}</div>}
          {authMode === "login" ? (
            <button type="button" className="lrLoginBtn" disabled={loginBusy} onClick={handleLogin}>
              {loginBusy ? "登录中…" : "登录"}
            </button>
          ) : (
            <button type="button" className="lrLoginBtn" disabled={loginBusy} onClick={handleRegister}>
              {loginBusy ? "注册中…" : "注册"}
            </button>
          )}
          <div className="lrLoginHint">
            {authMode === "login"
              ? <button type="button" className="lrTopBarBtn" onClick={() => setAuthMode("register")}>没有账号？注册</button>
              : <button type="button" className="lrTopBarBtn" onClick={() => setAuthMode("login")}>已有账号？登录</button>
            }
          </div>
        </div>
      </div>
    );
  }

  // ── 播放层 ────────────────────────────────────────────────
  const showPlayer = Boolean(playingFile);

  // ── 浏览层 ────────────────────────────────────────────────
  return (
    <>
      {/* ══ 播放层（覆盖全屏）══ */}
      {showPlayer && (
        <div className="lrPlayer">
          <div
            ref={viewportRef}
            className={`lrPlayerVideo${controlsVisible ? " controlsVisible" : ""}`}
            onMouseMove={revealControls}
            onMouseLeave={() => playerState === "playing" && scheduleHide()}
            onClick={() => { togglePlay(); revealControls(); }}
          >
            {/* 视频元素 */}
            <video
              ref={videoRef}
              className="lrPlayerVideoEl"
              src={playerSrc || undefined}
              autoPlay
              playsInline
              onLoadedMetadata={handleVideoLoadedMetadata}
              onPlay={handleVideoPlay}
              onPause={handleVideoPause}
              onEnded={handleVideoEnded}
              onError={handleVideoError}
            />

            {/* 加载旋转 */}
            {playerState === "loading" && <div className="lrPlayerLoadingSpinner" />}

            {/* 错误提示 */}
            {playerState === "error" && (
              <div className="lrPlayerStatus">
                <div style={{ fontSize: "2rem", marginBottom: 8 }}>⚠</div>
                <div>{playerError || "播放失败"}</div>
              </div>
            )}

            {/* 顶部关闭 */}
            <div
              className={`lrPlayerTopBar${controlsVisible ? "" : " hidden"}`}
              onMouseEnter={(e) => { e.stopPropagation(); cancelHideTimer(); }}
              onMouseMove={(e) => e.stopPropagation()}
              onMouseLeave={() => { if (playerState === "playing") scheduleHide(); }}
            >
              <button
                type="button"
                className="lrPlayerBackBtn"
                onClick={(e) => {
                  e.stopPropagation();
                  closePlayer();
                  if (shareMode?.shareHref) {
                    window.location.assign(shareMode.shareHref);
                  }
                }}
              >
                ← 返回
              </button>
              <span className="lrPlayerFileName">{playingFile?.name || ""}</span>
              {!shareMode && (
                <button
                  type="button"
                  className="lrPlayerBackBtn lrPlayerSwitchMainBtn"
                  onClick={(e) => {
                    e.stopPropagation();
                    try {
                      sessionStorage.setItem(MAIN_PREVIEW_KEY, JSON.stringify({
                        fileId: playingFile?.id || "",
                        clientId: playingFile?.clientId || "",
                        path: playingFile?.path || "",
                        name: playingFile?.name || "",
                        mimeType: playingFile?.mimeType || "",
                        size: playingFile?.size || 0
                      }));
                    } catch { }
                    closePlayer();
                    window.location.assign("/");
                  }}
                >
                  ↗ 主页预览
                </button>
              )}
            </div>

            {/* 弹幕层 */}
            {danmakuVisible && activeDanmaku.length > 0 && (
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
                      animationDuration: `${item.durationMs}ms`,
                    }}
                  >
                    <span style={{ backgroundColor: toAlphaColor(danmakuBackgroundOpacity) }}>{item.content}</span>
                  </div>
                ))}
              </div>
            )}

            {/* 底部控制条（VideoPlayerControls）*/}
            <div
              className={`lrPlayerControls${controlsVisible ? "" : " hidden"}`}
              onMouseEnter={(e) => { e.stopPropagation(); cancelHideTimer(); }}
              onMouseMove={(e) => e.stopPropagation()}
              onMouseLeave={() => { if (playerState === "playing") scheduleHide(); }}
              onFocusCapture={() => cancelHideTimer()}
              onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget) && playerState === "playing") scheduleHide(); }}
              onClick={(e) => e.stopPropagation()}
            >
              <VideoPlayerControls
                currentTime={playerCurrentTime}
                duration={playerDuration}
                bufferedTime={videoBufferedTime}
                playing={playerState === "playing"}
                pictureInPictureActive={pictureInPictureActive}
                fullscreenActive={fullscreenActive}
                canUsePictureInPicture={canUsePictureInPicture}
                onTogglePlay={togglePlay}
                onSeek={(t) => { if (videoRef.current) videoRef.current.currentTime = t; revealControls(); }}
                onTogglePictureInPicture={() => {
                  const v = videoRef.current;
                  if (!v) return;
                  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
                  else v.requestPictureInPicture?.().catch(() => {});
                }}
                onToggleFullscreen={() => {
                  const vp = viewportRef.current;
                  if (!vp) return;
                  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
                  else vp.requestFullscreen?.().catch(() => {});
                }}
                showPageFillButton={false}
                showPictureInPictureButton={canUsePictureInPicture}
              >
                {/* 弹幕组件 */}
                {isVideoMime(playingFile?.mimeType || "") && (
                  <VideoDanmakuComposer
                    danmakuVisible={danmakuVisible}
                    danmakuItemsCount={danmakuItems.length}
                    danmakuMode={danmakuMode}
                    onDanmakuModeChange={setDanmakuMode}
                    onToggleDanmakuVisible={() => setDanmakuVisible((v) => !v)}
                    draft={danmakuDraft}
                    onDraftChange={setDanmakuDraft}
                    onDraftKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent?.isComposing) {
                        e.preventDefault();
                        submitDanmaku();
                      }
                    }}
                    danmakuSettingsOpen={danmakuSettingsOpen}
                    onToggleDanmakuSettings={() => setDanmakuSettingsOpen((v) => !v)}
                    danmakuColor={danmakuColor}
                    onDanmakuColorChange={setDanmakuColor}
                    danmakuBackgroundOpacity={danmakuBackgroundOpacity}
                    onDanmakuBackgroundOpacityChange={(v) => setDanmakuBackgroundOpacity(Math.min(0.9, Math.max(0, Number(v))))}
                    danmakuTextOpacity={danmakuTextOpacity}
                    onDanmakuTextOpacityChange={(v) => setDanmakuTextOpacity(Math.min(1, Math.max(0.2, Number(v))))}
                    danmakuFontScale={danmakuFontScale}
                    onDanmakuFontScaleChange={(v) => setDanmakuFontScale(Math.min(1.6, Math.max(0.8, Number(v))))}
                    onSubmit={submitDanmaku}
                    sendDisabled={danmakuSubmitting || !token || !danmakuDraft.trim()}
                    inputNode={(
                      <div className="previewDanmakuInputShell">
                        <span className="previewDanmakuInputGlyph" aria-hidden="true">A</span>
                        <input
                          autoComplete="off"
                          className="previewDanmakuInput previewDanmakuInputBili lrDanmakuInput"
                          value={danmakuDraft}
                          placeholder="发个友善的弹幕见证当下"
                          onChange={(e) => setDanmakuDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === " ") {
                              // 防止空格默认触发播放/暂停键位事件
                              e.stopPropagation();
                              return;
                            }
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              submitDanmaku();
                            }
                          }}
                        />
                      </div>
                    )}
                  />
                )}
                {/* 画质切换（放在弹幕行末，flex-shrink: 0 靠右） */}
                {hlsAvailProfiles.length > 1 && (
                  <div className="lrQualityWrap">
                    <button
                      type="button"
                      className="lrPlayerBtn lrQualityBtn"
                      onClick={() => setQualityOpen((v) => !v)}
                      title="切换画质"
                      aria-label="切换画质"
                    >
                      {hlsAvailProfiles.find((p) => p.id === hlsActiveProfile)?.label || hlsActiveProfile || "画质"}
                    </button>
                    {qualityOpen && (
                      <div className="lrQualityMenu" role="menu">
                        {[...hlsAvailProfiles].reverse().map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            role="menuitem"
                            className={`lrQualityItem${p.id === hlsActiveProfile ? " active" : ""}`}
                            onClick={() => { switchQuality(p.id); setQualityOpen(false); }}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </VideoPlayerControls>
            </div>
          </div>
        </div>
      )}

      {/* ══ 浏览层 ══ */}
      <div className="lrBrowse" ref={browseDivRef} aria-hidden={showPlayer}>
        {/* TopBar */}
        <header className="lrTopBar">
          <span className="lrTopBarLogo">▶ NAS</span>
          <div className="lrTopBarCenter" />
          <div className="lrTopBarRight">
            <LiveClock />
            <button
              type="button"
              className="lrTopBarBtn"
              title="切换到主页"
              aria-label="切换到主页"
              onClick={() => { const w = window.open("/", "nas_main"); w?.focus(); }}
            >⊡ 主页</button>
            <div className="lrTopBarSettings">
              <button
                type="button"
                className="lrTopBarBtn"
                onClick={() => setSettingsOpen((v) => !v)}
                aria-label="设置"
              >
                {user?.displayName || user?.email?.split("@")[0] || "用户"} ⋯
              </button>
              {settingsOpen && (
                <div className="lrSettingsMenu">
                  <button type="button" className="lrSettingsItem" onClick={() => { loadLibrary(token); setSettingsOpen(false); }}>↺ 刷新</button>
                  <button type="button" className="lrSettingsItem lrSettingsItemDanger" onClick={handleLogout}>退出</button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Hero 区（strip 模式下显示）*/}
        {browseMode === "strip" && (
          <div className="lrHero">
            {heroDisplayFile && thumbMap[thumbKey(heroDisplayFile)]?.url && (
              <div
                className="lrHeroBg"
                style={{ backgroundImage: `url(${thumbMap[thumbKey(heroDisplayFile)].url})` }}
              />
            )}
            {/* 背景视频：选中超过1秒后替代封面图 */}
            <video
              ref={heroBgVideoRef}
              className="lrHeroBgVideo"
              muted
              loop
              playsInline
              aria-hidden="true"
            />
            <div className="lrHeroOverlay" />
            {heroDisplayFile && (
              <div className="lrHeroContent">
                <span className="lrHeroLabel">
                  {continueMap[heroDisplayFile.id] ? "继续观看" : "最新上传"}
                </span>
                <h1 className="lrHeroTitle">{heroDisplayFile.name}</h1>
                <div className="lrHeroMeta">
                  <span>{isVideoMime(heroDisplayFile.mimeType) ? "视频" : isAudioMime(heroDisplayFile.mimeType) ? "音频" : "媒体"}</span>
                  {heroDisplayFile.size ? <span>{formatSize(heroDisplayFile.size)}</span> : null}
                  {getFileTs(heroDisplayFile) ? <span>{formatRelative(heroDisplayFile.createdAt || heroDisplayFile.updatedAt)}</span> : null}
                </div>
                <button
                  type="button"
                  className="lrHeroCTA"
                  onClick={() => playFile(heroDisplayFile)}
                >
                  ▶ 立即播放
                </button>
              </div>
            )}
          </div>
        )}

        {/* 底部横向列表（strip 模式）/ 全屏网格（grid 模式）*/}
        {browseMode === "grid" ? (
          <InlineGrid
            files={allBrowseFiles}
            thumbMap={thumbMap}
            continueMap={continueMap}
            focusedId={focusedFileId}
            query={gridQuery}
            onQueryChange={setGridQuery}
            onPlay={(f) => { setGridQuery(""); setBrowseMode("strip"); playFile(f); }}
            onFocus={setFocusedFileId}
            onClose={() => { setBrowseMode("strip"); setGridQuery(""); }}
            searchRef={gridSearchRef}
            onColsChange={(cols) => { gridColsRef.current = cols; }}
            onRefreshThumb={forceRefreshThumb}
          />
        ) : (
          <div className="lrShelvesBottom">
            <InfiniteStrip
              files={allBrowseFiles}
              thumbMap={thumbMap}
              continueMap={continueMap}
              focusedId={focusedFileId}
              onPlay={playFile}
              onFocus={setFocusedFileId}
              onRefreshThumb={forceRefreshThumb}
            />
            {pageState === "browsing" && !allBrowseFiles.length && (
              <div className="lrShelfSection">
                <div className="lrShelfEmpty">
                  暂无在线媒体文件。请确认 storage-client 在线，且已上传视频或音频文件。
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
