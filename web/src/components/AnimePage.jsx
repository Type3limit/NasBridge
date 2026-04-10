import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Spinner, Badge, Select } from "@fluentui/react-components";
import {
  ArrowDownloadRegular,
  ChevronRightRegular,
  DismissRegular,
  OpenRegular,
  PlayRegular,
  SearchRegular,
  StarFilled,
} from "@fluentui/react-icons";
import Hls from "hls.js";
import { apiRequest } from "../api";
import VideoPlayerControls, { VideoDanmakuComposer } from "./VideoPlayerControls";
import VideoViewportSurface from "./VideoViewportSurface";

const BGM_API = "https://api.bgm.tv";
const BGM_HEADERS = { "User-Agent": "nas-media-manager/1.0 (https://github.com)" };

// Subject type 2 = anime
const ANIME_TYPE = 2;

const WEEKDAY_LABELS = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

// ─── Danmaku constants ────────────────────────────────────────────────────────
const DANMAKU_SCROLL_DURATION_MS = 9000;
const DANMAKU_FIXED_DURATION_MS = 4200;
const DANMAKU_SCROLL_LANES = 8;
const DANMAKU_FIXED_LANES = 3;

// animeko public danmaku server (Bangumi episode IDs) — proxied via /api/anime/danmaku/:id

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function toAlphaColor(alpha = 0.12) {
  return `rgba(2, 6, 23, ${clampNum(alpha, 0, 0.9, 0.12)})`;
}

// Normalize animeko danmaku item → internal format
function normalizeAnimekoDanmaku(raw) {
  const info = raw?.danmakuInfo ?? {};
  const color = Number.isFinite(Number(info.color))
    ? `#${Number(info.color).toString(16).padStart(6, "0").toUpperCase()}`
    : "#FFFFFF";
  const mode = info.location === 1 ? "top" : info.location === 2 ? "bottom" : "scroll";
  return {
    id: String(raw?.id ?? Math.random()),
    content: String(info.text || "").trim(),
    timeSec: Math.max(0, Number(info.playTime || 0)),
    color,
    mode,
  };
}

// ─── Source cache (module-level, survives component re-mounts) ─────────────────
// Key: animeName, Value: { routes: [...], time: timestamp }
const SOURCE_CACHE = new Map();
const CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes

function getCachedRoutes(animeName) {
  const entry = SOURCE_CACHE.get(animeName);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL_MS) { SOURCE_CACHE.delete(animeName); return null; }
  return entry.routes;
}
function setCachedRoutes(animeName, routes) {
  if (routes.length > 0) SOURCE_CACHE.set(animeName, { routes, time: Date.now() });
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchCalendar() {
  const res = await fetch(`${BGM_API}/calendar`, { headers: BGM_HEADERS });
  if (!res.ok) throw new Error(`calendar ${res.status}`);
  return res.json();
}

// Fetch trending/popular anime from Bangumi (sorted by popularity for recommendations)
async function fetchTrending(limit = 24) {
  const res = await fetch(`${BGM_API}/v0/search/subjects?limit=${limit}&offset=0`, {
    method: "POST",
    headers: { ...BGM_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      keyword: "",
      sort: "heat",
      filter: { type: [ANIME_TYPE], nsfw: false, air_date: [">=" + getCurrentSeasonStart()] },
    }),
  });
  if (!res.ok) throw new Error(`trending ${res.status}`);
  return res.json(); // { total, data: Subject[] }
}

// Get the start date of the current anime season (Jan/Apr/Jul/Oct)
function getCurrentSeasonStart() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed
  const seasonMonth = Math.floor(month / 3) * 3 + 1; // 1, 4, 7, 10
  return `${year}-${String(seasonMonth).padStart(2, "0")}-01`;
}

async function searchSubjects(keyword, offset = 0, limit = 24) {
  const res = await fetch(`${BGM_API}/v0/search/subjects?limit=${limit}&offset=${offset}`, {
    method: "POST",
    headers: { ...BGM_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      keyword,
      sort: "rank",
      filter: { type: [ANIME_TYPE], nsfw: false }
    })
  });
  if (!res.ok) throw new Error(`search ${res.status}`);
  return res.json(); // { total, data: Subject[] }
}

// Generic search with tag + year + sort filters (for CatalogView)
async function searchWithFilters({ tags = [], year, sort = "heat", offset = 0, limit = 24 } = {}) {
  const filter = { type: [ANIME_TYPE], nsfw: false };
  if (tags.length > 0) filter.tag = tags;
  if (year) {
    filter.air_date = [`>=${year}-01-01`, `<${Number(year) + 1}-01-01`];
  }
  const res = await fetch(`${BGM_API}/v0/search/subjects?limit=${limit}&offset=${offset}`, {
    method: "POST",
    headers: { ...BGM_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ keyword: "", sort, filter }),
  });
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  return res.json();
}

async function fetchSubjectDetail(id) {
  const res = await fetch(`${BGM_API}/v0/subjects/${id}`, { headers: BGM_HEADERS });
  if (!res.ok) throw new Error(`subject ${res.status}`);
  return res.json();
}

async function fetchEpisodes(id, limit = 100) {
  const res = await fetch(`${BGM_API}/v0/episodes?subject_id=${id}&type=0&limit=${limit}`, { headers: BGM_HEADERS });
  if (!res.ok) throw new Error(`episodes ${res.status}`);
  return res.json(); // { total, data: Episode[] }
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function scoreColor(score) {
  if (!score) return "#94a3b8";
  if (score >= 8) return "#16a34a";
  if (score >= 7) return "#2563eb";
  if (score >= 6) return "#d97706";
  return "#dc2626";
}

function subjectImage(item, size = "medium") {
  const img = item?.images || item?.image;
  if (img) return img[size] || img.common || img.large || img.medium || "";
  return "";
}

function displayName(item) {
  return item?.name_cn || item?.name || "—";
}

// ─── Anime Card ───────────────────────────────────────────────────────────────

function AnimeCard({ item, onClick }) {
  const img = subjectImage(item);
  const score = item?.rating?.score;
  const name = displayName(item);

  return (
    <button type="button" className="animeCard" onClick={() => onClick(item)}>
      <div className="animeCardPoster">
        {img
          ? <img src={img} alt={name} loading="lazy" className="animeCardImg" />
          : <div className="animeCardImgPlaceholder" />
        }
        {score > 0 && (
          <span className="animeCardScore" style={{ color: scoreColor(score) }}>
            <StarFilled style={{ fontSize: 11, verticalAlign: -1 }} />
            {score.toFixed(1)}
          </span>
        )}
      </div>
      <div className="animeCardInfo">
        <span className="animeCardTitle">{name}</span>
        {(item?.air_date || item?.date) && (
          <span className="animeCardMeta">{item.air_date || item.date}</span>
        )}
      </div>
    </button>
  );
}

// ─── Schedule View ────────────────────────────────────────────────────────────

function ScheduleView({ onSelectAnime }) {
  const [calendar, setCalendar] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeDay, setActiveDay] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetchCalendar()
      .then((data) => {
        setCalendar(data);
        // default to today
        const todayId = new Date().getDay() || 7; // JS 0=Sun → 7
        const found = data.find((d) => d.weekday?.id === todayId);
        setActiveDay(found ? todayId : data[0]?.weekday?.id);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="animePageCenter"><Spinner size="large" label="加载放送表…" /></div>;
  if (error) return <div className="animePageCenter animePageError">加载失败：{error}</div>;

  const activeGroup = calendar?.find((d) => d.weekday?.id === activeDay);
  const items = activeGroup?.items || [];

  return (
    <div className="animeScheduleView">
      <div className="animeDayBar">
        {calendar?.map((group) => {
          const dayId = group.weekday?.id;
          const label = WEEKDAY_LABELS[dayId] || group.weekday?.cn;
          const isToday = dayId === (new Date().getDay() || 7);
          return (
            <button
              key={dayId}
              type="button"
              className={`animeDayBtn${activeDay === dayId ? " active" : ""}${isToday ? " today" : ""}`}
              onClick={() => setActiveDay(dayId)}
            >
              {label}
              {isToday && <span className="animeDayTodayDot" />}
              <span className="animeDayCount">{group.items?.length || 0}</span>
            </button>
          );
        })}
      </div>

      {items.length === 0
        ? <div className="animePageCenter animePageEmpty">暂无放送</div>
        : (
          <div className="animeGrid">
            {items.map((item) => (
              <AnimeCard key={item.id} item={item} onClick={onSelectAnime} />
            ))}
          </div>
        )
      }
    </div>
  );
}

// ─── Recommendation View (shown when no search) ──────────────────────────────

function RecommendationView({ onSelectAnime }) {
  const [todayAnime, setTodayAnime] = useState(null);
  const [trending, setTrending] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.allSettled([
      fetchCalendar(),
      fetchTrending(24),
    ]).then(([calResult, trendResult]) => {
      if (cancelled) return;

      // Extract today's airing anime from calendar
      if (calResult.status === "fulfilled") {
        const todayId = new Date().getDay() || 7; // JS 0=Sun → 7
        const todayGroup = calResult.value?.find((d) => d.weekday?.id === todayId);
        setTodayAnime(todayGroup?.items || []);
      }

      // Set trending data
      if (trendResult.status === "fulfilled") {
        setTrending(trendResult.value?.data || []);
      }

      if (calResult.status === "rejected" && trendResult.status === "rejected") {
        setError("推荐加载失败");
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div className="animePageCenter"><Spinner size="large" label="加载推荐…" /></div>;
  }

  if (error && !todayAnime?.length && !trending?.length) {
    return <div className="animePageCenter animePageError">{error}</div>;
  }

  return (
    <div className="animeRecommendView">
      {todayAnime && todayAnime.length > 0 && (
        <section className="animeRecommendSection">
          <h3 className="animeRecommendTitle">📅 今日放送</h3>
          <div className="animeGrid">
            {todayAnime.map((item) => (
              <AnimeCard key={item.id} item={item} onClick={onSelectAnime} />
            ))}
          </div>
        </section>
      )}

      {trending && trending.length > 0 && (
        <section className="animeRecommendSection">
          <h3 className="animeRecommendTitle">🔥 本季热门</h3>
          <div className="animeGrid">
            {trending.map((item) => (
              <AnimeCard key={item.id} item={item} onClick={onSelectAnime} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Catalog View (filtered browsing) ─────────────────────────────────────────

const CATALOG_TAGS = [
  "日常", "搞笑", "战斗", "热血", "奇幻", "科幻", "冒险", "恋爱",
  "校园", "治愈", "运动", "悬疑", "推理", "百合", "后宫", "机战",
  "魔法", "励志", "青春", "恐怖", "竞技", "社会", "历史", "职场",
];
const CATALOG_YEARS = (() => {
  const y = new Date().getFullYear();
  const out = [];
  for (let i = y; i >= 2000; i--) out.push(String(i));
  return out;
})();
const CATALOG_SORTS = [
  { value: "heat", label: "热门" },
  { value: "rank", label: "排名" },
  { value: "score", label: "评分" },
];
const CATALOG_PAGE_SIZE = 24;

function CatalogView({ onSelectAnime }) {
  const [selectedTags, setSelectedTags] = useState([]);
  const [selectedYear, setSelectedYear] = useState("");
  const [sort, setSort] = useState("heat");
  const [results, setResults] = useState(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [autoLoaded, setAutoLoaded] = useState(false);

  const doSearch = useCallback(async (tags, year, sortBy, off) => {
    setLoading(true);
    setError(null);
    try {
      const data = await searchWithFilters({ tags, year: year || undefined, sort: sortBy, offset: off, limit: CATALOG_PAGE_SIZE });
      setResults(data.data || []);
      setTotal(data.total || 0);
      setOffset(off);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-load on mount (show default "heat" results)
  useEffect(() => {
    if (!autoLoaded) {
      setAutoLoaded(true);
      doSearch([], "", "heat", 0);
    }
  }, [autoLoaded, doSearch]);

  function toggleTag(tag) {
    const next = selectedTags.includes(tag) ? selectedTags.filter((t) => t !== tag) : [...selectedTags, tag];
    setSelectedTags(next);
    doSearch(next, selectedYear, sort, 0);
  }

  function selectYear(y) {
    const next = selectedYear === y ? "" : y;
    setSelectedYear(next);
    doSearch(selectedTags, next, sort, 0);
  }

  function changeSort(s) {
    setSort(s);
    doSearch(selectedTags, selectedYear, s, 0);
  }

  function handlePageChange(newOffset) {
    doSearch(selectedTags, selectedYear, sort, newOffset);
    window.scrollTo({ top: 0 });
  }

  const totalPages = Math.ceil(total / CATALOG_PAGE_SIZE);
  const currentPage = Math.floor(offset / CATALOG_PAGE_SIZE) + 1;

  return (
    <div className="animeCatalogView">
      {/* Filters */}
      <div className="animeCatalogFilters">
        <div className="animeCatalogFilterRow">
          <span className="animeCatalogLabel">类型</span>
          <div className="animeCatalogChips">
            {CATALOG_TAGS.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`animeCatalogChip${selectedTags.includes(tag) ? " active" : ""}`}
                onClick={() => toggleTag(tag)}
              >{tag}</button>
            ))}
          </div>
        </div>
        <div className="animeCatalogFilterRow">
          <span className="animeCatalogLabel">年份</span>
          <div className="animeCatalogChips">
            {CATALOG_YEARS.map((y) => (
              <button
                key={y}
                type="button"
                className={`animeCatalogChip${selectedYear === y ? " active" : ""}`}
                onClick={() => selectYear(y)}
              >{y}</button>
            ))}
          </div>
        </div>
        <div className="animeCatalogFilterRow">
          <span className="animeCatalogLabel">排序</span>
          <div className="animeCatalogChips">
            {CATALOG_SORTS.map((s) => (
              <button
                key={s.value}
                type="button"
                className={`animeCatalogChip${sort === s.value ? " active" : ""}`}
                onClick={() => changeSort(s.value)}
              >{s.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Results */}
      {loading && <div className="animePageCenter"><Spinner size="large" label="加载中…" /></div>}
      {error && <div className="animePageCenter animePageError">加载失败：{error}</div>}

      {!loading && results !== null && (
        <>
          <div className="animeSearchMeta">
            共 {total} 部，第 {currentPage} / {totalPages || 1} 页
          </div>
          {results.length === 0
            ? <div className="animePageCenter animePageEmpty">没有找到符合条件的番剧</div>
            : (
              <div className="animeGrid">
                {results.map((item) => (
                  <AnimeCard key={item.id} item={item} onClick={onSelectAnime} />
                ))}
              </div>
            )
          }
          {totalPages > 1 && (
            <div className="animePageNav">
              <Button
                disabled={offset === 0}
                onClick={() => handlePageChange(offset - CATALOG_PAGE_SIZE)}
              >上一页</Button>
              <span className="animePageNavLabel">{currentPage} / {totalPages}</span>
              <Button
                disabled={currentPage >= totalPages}
                onClick={() => handlePageChange(offset + CATALOG_PAGE_SIZE)}
              >下一页</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Search View ──────────────────────────────────────────────────────────────

const SEARCH_PAGE_SIZE = 24;

function SearchView({ onSelectAnime }) {
  const [keyword, setKeyword] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [results, setResults] = useState(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const doSearch = useCallback(async (kw, off) => {
    if (!kw.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await searchSubjects(kw.trim(), off, SEARCH_PAGE_SIZE);
      setResults(data.data || []);
      setTotal(data.total || 0);
      setOffset(off);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  function handleSearch(e) {
    e?.preventDefault();
    setKeyword(inputValue);
    setResults(null);
    doSearch(inputValue, 0);
  }

  function handlePageChange(newOffset) {
    doSearch(keyword, newOffset);
    window.scrollTo({ top: 0 });
  }

  const totalPages = Math.ceil(total / SEARCH_PAGE_SIZE);
  const currentPage = Math.floor(offset / SEARCH_PAGE_SIZE) + 1;

  return (
    <div className="animeSearchView">
      <form className="animeSearchBar" onSubmit={handleSearch}>
        <Input
          className="animeSearchInput"
          placeholder="搜索番剧名称…"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          contentBefore={<SearchRegular />}
        />
        <Button type="submit" appearance="primary" disabled={!inputValue.trim() || loading}>
          搜索
        </Button>
      </form>

      {loading && <div className="animePageCenter"><Spinner size="large" label="搜索中…" /></div>}
      {error && <div className="animePageCenter animePageError">搜索失败：{error}</div>}

      {!loading && results !== null && (
        <>
          <div className="animeSearchMeta">
            共找到 {total} 个结果，第 {currentPage} / {totalPages} 页
          </div>
          {results.length === 0
            ? <div className="animePageCenter animePageEmpty">没有找到相关番剧</div>
            : (
              <div className="animeGrid">
                {results.map((item) => (
                  <AnimeCard key={item.id} item={item} onClick={onSelectAnime} />
                ))}
              </div>
            )
          }
          {totalPages > 1 && (
            <div className="animePageNav">
              <Button
                disabled={offset === 0}
                onClick={() => handlePageChange(offset - SEARCH_PAGE_SIZE)}
              >上一页</Button>
              <span className="animePageNavLabel">{currentPage} / {totalPages}</span>
              <Button
                disabled={currentPage >= totalPages}
                onClick={() => handlePageChange(offset + SEARCH_PAGE_SIZE)}
              >下一页</Button>
            </div>
          )}
        </>
      )}

      {!loading && results === null && (
        <RecommendationView onSelectAnime={onSelectAnime} />
      )}
    </div>
  );
}

// Deterministic color from site name (for avatar circles)
function siteColor(name) {
  let h = 0;
  for (let i = 0; i < (name || "").length; i++) h = Math.imul(31, h) + name.charCodeAt(i) | 0;
  return `hsl(${Math.abs(h) % 360}, 50%, 42%)`;
}

// ─── Full-page Player ─────────────────────────────────────────────────────────
// playerState = { animeName, animeNameJa, hintEp, bgmEpisodes }
// Episode names come from Bangumi (bgmEpisodes); stream URLs from CMS sources.
function AnimePlayerPage({ playerState, authToken, p2p, clients, onBack }) {
  const { animeName, animeNameJa, hintEp, bgmEpisodes = [] } = playerState;

  // Bangumi may number episodes globally across seasons (e.g. S2 ep1 = sort 29).
  // CMS sites number per-season starting from 1. Use firstBgmSort as offset.
  const firstBgmSort = bgmEpisodes.length > 0 ? bgmEpisodes[0].sort : 1;
  // Maps Bangumi global sort number → CMS per-season episode number
  const bgmToCms = (bgmSort) => Math.max(1, bgmSort - firstBgmSort + 1);

  // routes: [{ site, route, vodName, episodes: [{ep, label, url, type, vipWrapped}] }]
  const [routes, setRoutes] = useState([]);
  const [currentRouteIdx, setCurrentRouteIdx] = useState(0);
  const [currentEp, setCurrentEp] = useState(null); // CMS episode number (1-based)
  const [searchLoading, setSearchLoading] = useState(true);
  const [playerError, setPlayerError] = useState(null);
  const [searchKey, setSearchKey] = useState(0); // increment to force re-search
  const [sitesChecked, setSitesChecked] = useState([]); // sites that have responded (may have dupes from nameFallback)
  const [sitesTotal, setSitesTotal] = useState(32);     // updated from SSE done event
  const [blockedSites, setBlockedSites] = useState([]); // sites returning Cloudflare/captcha challenges
  const [manualSelectOpen, setManualSelectOpen] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState(null); // null | "downloading" | "done" | "failed"
  const [downloadError, setDownloadError] = useState(null);
  const resolvedStreamRef = useRef(null); // { url, referer } after VIP resolution
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const routesAccumRef = useRef([]); // accumulates routes during SSE for caching

  // ── Custom player state ────────────────────────────────────────────────
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoBufferedTime, setVideoBufferedTime] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [pictureInPictureActive, setPictureInPictureActive] = useState(false);
  const [fullscreenActive, setFullscreenActive] = useState(false);
  const viewportRef = useRef(null);
  const canUsePip = typeof document !== "undefined" && Boolean(document.pictureInPictureEnabled);

  // ── Danmaku state ──────────────────────────────────────────────────────
  const [danmakuItems, setDanmakuItems] = useState([]);
  const [danmakuVisible, setDanmakuVisible] = useState(true);
  const [danmakuMode, setDanmakuMode] = useState("scroll");
  const [danmakuColor, setDanmakuColor] = useState("#FFFFFF");
  const [danmakuFontScale, setDanmakuFontScale] = useState(1);
  const [danmakuTextOpacity, setDanmakuTextOpacity] = useState(1);
  const [danmakuBackgroundOpacity, setDanmakuBackgroundOpacity] = useState(0.12);
  const [danmakuSettingsOpen, setDanmakuSettingsOpen] = useState(false);
  const [activeDanmaku, setActiveDanmaku] = useState([]);
  const danmakuFiredRef = useRef(new Set());
  const danmakuScrollLaneRef = useRef(0);
  const danmakuTopLaneRef = useRef(0);
  const danmakuBottomLaneRef = useRef(0);
  const danmakuSequenceRef = useRef(0);
  const danmakuTimersRef = useRef(new Map());
  const activeDanmakuIdsRef = useRef(new Set());
  const lastVideoTimeRef = useRef(0);

  function handleRefreshSources() {
    SOURCE_CACHE.delete(animeName);
    setSearchKey((k) => k + 1);
  }

  // Download the currently playing episode to server storage
  async function handleDownloadEpisode() {
    if (!currentEpisode?.url || downloadStatus === "downloading") return;

    // Need an online storage-client for aria2 download
    const onlineClients = (clients || []).filter((c) => c.status === "online");
    if (!onlineClients.length || !p2p) {
      setDownloadError("没有在线的存储终端");
      setDownloadStatus("failed");
      return;
    }

    setDownloadStatus("downloading");
    setDownloadError(null);

    // Build episode name from Bangumi or CMS data
    const bgmEp = bgmEpisodes.find((ep) => ep.sort === firstBgmSort + (currentEp ?? 1) - 1);
    const epLabel = bgmEp
      ? `EP${String(bgmEp.sort).padStart(2, "0")} ${bgmEp.name_cn || bgmEp.name || ""}`
      : (currentEpisode.label || `EP${currentEp || 1}`);

    try {
      // Use the resolved stream URL (after VIP wrapper extraction) if available
      const resolved = resolvedStreamRef.current;
      const dlUrl = resolved?.url || currentEpisode.url;
      const dlReferer = resolved?.referer || currentEpisode.referer || "";

      // Step 1: Ask server to prepare a one-time streaming download URL
      const prepared = await apiRequest("/api/anime/prepare-download", {
        method: "POST",
        token: authToken,
        body: {
          url: dlUrl,
          referer: dlReferer,
          animeName,
          episodeName: epLabel.trim(),
        },
      });

      if (!prepared.downloadUrl) throw new Error("服务器未返回下载链接");

      // Step 2: Invoke aria2 bot on storage-client with the streaming URL
      const clientId = onlineClients[0].id;
      const { job } = await p2p.invokeBot(clientId, {
        botId: "aria2.downloader",
        trigger: {
          type: "card-action",
          rawText: "",
          parsedArgs: {
            url: prepared.downloadUrl,
            targetFolder: prepared.targetFolder || `anime/${animeName}`,
          },
        },
      });

      // Step 3: Poll bot job status
      const jobId = job?.jobId;
      if (!jobId) {
        setDownloadStatus("done");
        return;
      }

      const poll = setInterval(async () => {
        try {
          const { job: latestJob } = await p2p.getBotJob(clientId, jobId);
          if (!latestJob) { clearInterval(poll); setDownloadStatus("done"); return; }
          if (latestJob.status === "succeeded") {
            clearInterval(poll);
            setDownloadStatus("done");
          } else if (latestJob.status === "failed" || latestJob.status === "cancelled") {
            clearInterval(poll);
            setDownloadStatus("failed");
            setDownloadError(latestJob.error || "下载失败");
          }
        } catch { /* ignore poll errors */ }
      }, 5000);
      // Stop polling after 30 minutes max
      setTimeout(() => clearInterval(poll), 30 * 60 * 1000);

    } catch (e) {
      setDownloadStatus("failed");
      setDownloadError(e.message);
    }
  }

  const currentRoute = routes[currentRouteIdx] ?? null;
  const cmsEpisodes = currentRoute?.episodes ?? [];
  const currentEpisode = (currentEp != null && cmsEpisodes.find((e) => e.ep === currentEp))
    || cmsEpisodes[0]
    || null;

  // Group routes by site name for the picker UI (animeko simple-mode style)
  const siteGroups = useMemo(() => {
    const map = new Map();
    routes.forEach((r, i) => {
      if (!map.has(r.site)) map.set(r.site, []);
      map.get(r.site).push({ route: r.route, idx: i });
    });
    return [...map.entries()].map(([site, siteRoutes]) => ({ site, routes: siteRoutes }));
  }, [routes]);

  // Deduplicate checked sites (each site may emit twice when nameFallback is different)
  const checkedUnique = useMemo(() => [...new Set(sitesChecked)], [sitesChecked]);

  // Prefer Bangumi episode name for the header; fall back to CMS label
  // Defined early so effects below can use currentBgmEp?.id as a dependency.
  const currentBgmEp = bgmEpisodes.find((ep) => ep.sort === firstBgmSort + (currentEp ?? 1) - 1);

  // Fetch all routes + their episode lists from CMS. Runs on mount; re-runs when searchKey changes.
  useEffect(() => {
    let cancelled = false;
    setRoutes([]);
    setCurrentRouteIdx(0);
    setCurrentEp(null);
    setPlayerError(null);
    setSearchLoading(true);
    setSitesChecked([]);
    setSitesTotal(32);
    setBlockedSites([]);
    setManualSelectOpen(false);
    setVideoReady(false);
    routesAccumRef.current = [];

    // Check cache first — skip SSE if we already have results
    const cached = getCachedRoutes(animeName);
    if (cached && cached.length > 0) {
      setRoutes(cached);
      setSearchLoading(false);
      const eps = cached[0].episodes || [];
      const cmsHintEp = hintEp != null ? bgmToCms(hintEp) : (eps[0]?.ep ?? 1);
      setCurrentEp(eps.find((e) => e.ep === cmsHintEp) ? cmsHintEp : (eps[0]?.ep ?? 1));
      return;
    }

    const controller = new AbortController();
    const hardTimer = setTimeout(() => controller.abort(), 50_000);

    (async () => {
      try {
        const params = new URLSearchParams({ name: animeName });
        if (animeNameJa && animeNameJa !== animeName) params.set("nameFallback", animeNameJa);
        const r = await fetch(`/api/anime/find-stream?${params}`, {
          headers: { Authorization: `Bearer ${authToken}` },
          signal: controller.signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);

        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let firstRoute = true;

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const chunks = buf.split("\n\n");
          buf = chunks.pop() ?? "";
          for (const chunk of chunks) {
            const line = chunk.trim();
            if (!line.startsWith("data: ")) continue;
            let msg;
            try { msg = JSON.parse(line.slice(6)); } catch { continue; }
            if (msg.type === "source") {
              if (!cancelled) {
                routesAccumRef.current = [...routesAccumRef.current, msg.source];
                setRoutes((prev) => [...prev, msg.source]);
                if (firstRoute) {
                  firstRoute = false;
                  setSearchLoading(false);
                  const eps = msg.source.episodes || [];
                  const cmsHintEp = hintEp != null ? bgmToCms(hintEp) : (eps[0]?.ep ?? 1);
                  setCurrentEp(eps.find((e) => e.ep === cmsHintEp) ? cmsHintEp : (eps[0]?.ep ?? 1));
                }
              }
            } else if (msg.type === "checked") {
              if (!cancelled) setSitesChecked((prev) => [...prev, msg.site]);
            } else if (msg.type === "blocked") {
              if (!cancelled) setBlockedSites((prev) => [...prev, { site: msg.site, url: msg.url }]);
            } else if (msg.type === "done") {
              if (!cancelled) {
                if (firstRoute) setPlayerError("未找到可用播放源");
                setSearchLoading(false);
                if (msg.total) setSitesTotal(msg.total);
                setCachedRoutes(animeName, routesAccumRef.current);
              }
            }
          }
        }
        if (!cancelled && firstRoute) { setPlayerError("未找到可用播放源"); setSearchLoading(false); }
        if (!cancelled) setCachedRoutes(animeName, routesAccumRef.current);
      } catch (e) {
        if (!cancelled) {
          setPlayerError(e.name === "AbortError" ? "搜索超时" : (e.message || "加载失败"));
          setSearchLoading(false);
          setCachedRoutes(animeName, routesAccumRef.current);
        }
      } finally { clearTimeout(hardTimer); }
    })();

    return () => { cancelled = true; controller.abort(); clearTimeout(hardTimer); };
  }, [searchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load video whenever the active episode changes.
  // All streams are routed through /api/anime/proxy-stream which injects the
  // correct Referer header, bypassing CDN Referer checks that cause manifestLoadError.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !currentEpisode?.url) return;
    setPlayerError(null);
    setVideoReady(false);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    let cancelled = false;

    async function loadStream() {
      let streamUrl = currentEpisode.url;
      let streamReferer = currentEpisode.referer || "";

      // Resolve VIP wrapper pages server-side (HTML extraction → real stream URL + referer)
      if (currentEpisode.vipWrapped) {
        try {
          const r = await fetch(
            `/api/anime/resolve-url?url=${encodeURIComponent(currentEpisode.url)}`,
            { headers: { Authorization: `Bearer ${authToken}` } }
          );
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
          if (data.url) { streamUrl = data.url; streamReferer = data.referer || streamReferer; }
        } catch (e) {
          if (!cancelled) setPlayerError(`链接解析失败：${e.message}`);
          return;
        }
      }

      if (cancelled) return;

      // Store resolved URL for download handler
      resolvedStreamRef.current = { url: streamUrl, referer: streamReferer };

      const isMp4 = currentEpisode.type === "mp4" || /\.(mp4|flv|mkv)(\?|$)/i.test(streamUrl);

      // Route all CDN requests through our server proxy so the correct Referer is sent.
      // HLS.js segment requests also go through the proxy via the rewritten m3u8 URLs.
      const proxied = `/api/anime/proxy-stream?url=${encodeURIComponent(streamUrl)}&ref=${encodeURIComponent(streamReferer)}`;

      if (isMp4) {
        video.src = proxied;
        video.play().catch(() => {});
        video.onerror = () => { if (!cancelled) setPlayerError(`播放失败：${video.error?.message || "未知错误"}`); };
      } else if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: false,
          fragLoadingMaxRetry: 1,
          manifestLoadingMaxRetry: 1,
          // All HLS.js requests (manifest + segments) go through our proxy endpoint
          // which requires auth, so we inject the Bearer token here.
          xhrSetup: (xhr) => {
            xhr.setRequestHeader("Authorization", `Bearer ${authToken}`);
          },
        });
        hlsRef.current = hls;
        hls.loadSource(proxied);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => { if (!cancelled) video.play().catch(() => {}); });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal && !cancelled) {
            setPlayerError(`播放失败：${data.details}`);
            hls.destroy();
            hlsRef.current = null;
          }
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = proxied;
        video.play().catch(() => {});
        video.onerror = () => { if (!cancelled) setPlayerError(`播放失败：${video.error?.message || "未知错误"}`); };
      } else {
        setPlayerError("当前浏览器不支持 HLS 播放");
      }
    }

    loadStream();
    return () => {
      cancelled = true;
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
  }, [currentEpisode]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleRouteSwitch(idx) {
    if (idx === currentRouteIdx) return;
    setCurrentRouteIdx(idx);
    setPlayerError(null);
    const newEps = routes[idx]?.episodes ?? [];
    if (!newEps.find((e) => e.ep === currentEp)) setCurrentEp(newEps[0]?.ep ?? 1);
  }

  // ── Custom player: sync video element events → React state ────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const syncState = () => {
      const time = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      let buffered = time;
      try {
        for (let i = 0; i < video.buffered.length; i++) {
          if (time >= video.buffered.start(i) && time <= video.buffered.end(i)) {
            buffered = video.buffered.end(i);
            break;
          }
        }
      } catch { /* ignore */ }
      setVideoCurrentTime(time);
      setVideoDuration(dur);
      setVideoBufferedTime(buffered);
      setVideoPlaying(!video.paused && !video.ended);
    };
    const onPip = () => setPictureInPictureActive(document.pictureInPictureElement === video);
    const onFs = () => {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      setFullscreenActive(Boolean(fsEl && viewportRef.current?.contains(fsEl)));
    };
    video.addEventListener("timeupdate", syncState);
    video.addEventListener("durationchange", syncState);
    video.addEventListener("progress", syncState);
    video.addEventListener("play", syncState);
    video.addEventListener("pause", syncState);
    video.addEventListener("ended", syncState);
    video.addEventListener("enterpictureinpicture", onPip);
    video.addEventListener("leavepictureinpicture", onPip);
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    return () => {
      video.removeEventListener("timeupdate", syncState);
      video.removeEventListener("durationchange", syncState);
      video.removeEventListener("progress", syncState);
      video.removeEventListener("play", syncState);
      video.removeEventListener("pause", syncState);
      video.removeEventListener("ended", syncState);
      video.removeEventListener("enterpictureinpicture", onPip);
      video.removeEventListener("leavepictureinpicture", onPip);
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Danmaku: clear + queue display ────────────────────────────────────────
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

  // ── Danmaku: sync per video frame ─────────────────────────────────────────
  const danmakuItemsRef = useRef([]);
  danmakuItemsRef.current = danmakuItems; // always fresh snapshot
  const danmakuVisibleRef = useRef(danmakuVisible);
  danmakuVisibleRef.current = danmakuVisible;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
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
      if (danmakuVisibleRef.current) {
        for (const item of danmakuItemsRef.current) {
          if (danmakuFiredRef.current.has(item.id)) continue;
          if (item.timeSec >= lowerBound && item.timeSec < upperBound) {
            danmakuFiredRef.current.add(item.id);
            enqueueDanmaku(item);
          }
        }
      }
      lastVideoTimeRef.current = currentTime;
    };
    video.addEventListener("timeupdate", syncDanmaku);
    return () => video.removeEventListener("timeupdate", syncDanmaku);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Danmaku: fetch from animeko when episode changes ──────────────────────
  useEffect(() => {
    const bgmEpId = currentBgmEp?.id;
    if (!bgmEpId) { setDanmakuItems([]); return; }
    let cancelled = false;
    setDanmakuItems([]);
    danmakuFiredRef.current = new Set();
    clearActiveDanmaku();
    lastVideoTimeRef.current = 0;
    (async () => {
      try {
        const r = await fetch(`/api/anime/danmaku/${bgmEpId}`, {
          headers: { Authorization: `Bearer ${authToken}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (!r.ok || cancelled) return;
        const data = await r.json();
        const items = (data?.danmakuList ?? [])
          .map(normalizeAnimekoDanmaku)
          .filter((it) => it.content)
          .sort((a, b) => a.timeSec - b.timeSec);
        if (!cancelled) setDanmakuItems(items);
      } catch { /* silently ignore — danmaku is non-critical */ }
    })();
    return () => { cancelled = true; };
  }, [currentBgmEp?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Custom player actions ──────────────────────────────────────────────────
  function seekVideoTo(time) {
    const video = videoRef.current;
    if (!video) return;
    const safeDur = Number.isFinite(video.duration) ? video.duration : 0;
    video.currentTime = Math.max(0, Math.min(time, safeDur || time));
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {}); else video.pause();
  }

  async function togglePip() {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch { /* ignore */ }
  }

  async function toggleFullscreen() {
    const el = viewportRef.current;
    if (!el) return;
    try {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl) {
        await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
      } else {
        await (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.());
      }
    } catch { /* ignore */ }
  }

  // ── Danmaku overlay renderer ───────────────────────────────────────────────
  function renderDanmakuLayer() {
    if (!danmakuVisible || !activeDanmaku.length) return null;
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
              animationDuration: `${item.durationMs}ms`,
            }}
          >
            <span style={{ backgroundColor: toAlphaColor(danmakuBackgroundOpacity) }}>{item.content}</span>
          </div>
        ))}
      </div>
    );
  }

  const nextRouteIdx = currentRouteIdx + 1 < routes.length ? currentRouteIdx + 1 : null;
  const episodeTitle = currentBgmEp
    ? `${String(currentBgmEp.sort).padStart(2, "0")} ${currentBgmEp.name_cn || currentBgmEp.name || ""}`.trim()
    : currentEpisode ? (currentEpisode.label || `EP${currentEpisode.ep}`) : "";

  return (
    <div className="animePlayerPage">
      <div className="animePlayerPageHeader">
        <button type="button" className="animePlayerPageBack" onClick={onBack}>
          <ChevronRightRegular style={{ transform: "rotate(180deg)" }} /> 返回
        </button>
        <span className="animePlayerPageTitle">
          {currentRoute?.vodName || animeName}
          {episodeTitle ? ` · ${episodeTitle}` : ""}
        </span>
      </div>

      {/* ── Custom video player + danmaku ───────────────────────── */}
      <VideoViewportSurface
        surfaceRef={viewportRef}
        playing={videoPlaying}
        className="animePlayerPageVideo"
        controls={
          <VideoPlayerControls
            currentTime={videoCurrentTime}
            duration={videoDuration}
            bufferedTime={videoBufferedTime}
            playing={videoPlaying}
            pictureInPictureActive={pictureInPictureActive}
            pageFillActive={false}
            fullscreenActive={fullscreenActive}
            canUsePictureInPicture={canUsePip}
            onTogglePlay={togglePlay}
            onSeek={seekVideoTo}
            onTogglePictureInPicture={() => togglePip().catch(() => {})}
            onTogglePageFill={() => {}}
            onToggleFullscreen={() => toggleFullscreen().catch(() => {})}
            showPageFillButton={false}
          >
            <VideoDanmakuComposer
              danmakuVisible={danmakuVisible}
              danmakuItemsCount={danmakuItems.length}
              danmakuMode={danmakuMode}
              onDanmakuModeChange={setDanmakuMode}
              onToggleDanmakuVisible={() => setDanmakuVisible((v) => !v)}
              danmakuSettingsOpen={danmakuSettingsOpen}
              onToggleDanmakuSettings={() => setDanmakuSettingsOpen((v) => !v)}
              danmakuColor={danmakuColor}
              onDanmakuColorChange={setDanmakuColor}
              danmakuBackgroundOpacity={danmakuBackgroundOpacity}
              onDanmakuBackgroundOpacityChange={(v) => setDanmakuBackgroundOpacity(clampNum(v, 0, 0.9, danmakuBackgroundOpacity))}
              danmakuTextOpacity={danmakuTextOpacity}
              onDanmakuTextOpacityChange={(v) => setDanmakuTextOpacity(clampNum(v, 0.2, 1, danmakuTextOpacity))}
              danmakuFontScale={danmakuFontScale}
              onDanmakuFontScaleChange={(v) => setDanmakuFontScale(clampNum(v, 0.8, 1.6, danmakuFontScale))}
              sendDisabled={true}
            />
          </VideoPlayerControls>
        }
        overlay={
          <>
            {renderDanmakuLayer()}

            {/* No source yet — still searching */}
            {!currentEpisode && !playerError && (
              <div className="animePlayerOverlay">
                <div className="animePlayerOverlayText">正在自动选择数据源，请稍候</div>
              </div>
            )}

            {/* Source found but video buffering / resolving */}
            {currentEpisode && !videoReady && !playerError && (
              <div className="animePlayerOverlay">
                <Spinner size="small" />
                <div className="animePlayerOverlayText">正在解析资源链接</div>
                <div className="animePlayerOverlaySub">通常几秒内完成，否则请切换数据源</div>
              </div>
            )}

            {/* Player error */}
            {playerError && (
              <div className="animePlayerOverlay">
                <div className="animePlayerErrorMsg">{playerError}</div>
                {nextRouteIdx !== null && (
                  <button type="button" className="animeSourceBtn active"
                    onClick={() => { handleRouteSwitch(nextRouteIdx); setPlayerError(null); }}>
                    尝试下一线路 →
                  </button>
                )}
              </div>
            )}
          </>
        }
        onDoubleClick={() => toggleFullscreen().catch(() => {})}
      >
        <video
          ref={videoRef}
          className="animePlayerPageVideoEl"
          style={{ visibility: videoReady && !playerError ? "visible" : "hidden" }}
          playsInline autoPlay
          onCanPlay={() => setVideoReady(true)}
        />
      </VideoViewportSurface>

      {/* ── Scroll area ─────────────────────────────────────────── */}
      <div className="animePlayerPageScroll">

        {/* Source panel */}
        <div className="animeSourcePanel">
          {routes.length === 0 ? (
            /* Still searching OR done with no results */
            <>
              <div className="animeSourcePanelSearchRow">
                {searchLoading && <span className="animeSourcePulse" />}
                <span className="animeSourcePanelSearchLabel">
                  {searchLoading ? "正在自动选择数据源" : "未找到可用播放源"}
                </span>
                <button type="button" className="animeSourceManualBtn"
                  onClick={() => setManualSelectOpen(true)} disabled={routes.length === 0}>
                  ⇌ 手动选择
                </button>
              </div>
              {searchLoading && (
                <div className="animeSourceProgressTrack">
                  <div className="animeSourceProgressFill"
                    style={{ width: `${Math.min((checkedUnique.length / sitesTotal) * 100, 96)}%` }} />
                </div>
              )}
              <div className="animeSourceCheckedRow">
                <span className="animeSourceCheckedLabel">已查找：</span>
                {checkedUnique.slice(0, 6).map((name) => (
                  <span key={name} className="animeSourceSiteAvatar" title={name}
                    style={{ background: siteColor(name) }}>
                    {name[0]}
                  </span>
                ))}
                {checkedUnique.length > 6 && (
                  <span className="animeSourceCheckedMore">+{checkedUnique.length - 6}</span>
                )}
              </div>
              {!searchLoading && (
                <button type="button" className="animeSourceBtn animeSourceRefreshBtn"
                  style={{ marginTop: 10 }} onClick={handleRefreshSources}>
                  ↻ 重新搜索
                </button>
              )}
            </>
          ) : (
            /* Source chosen — found mode */
            <div className="animeSourcePanelFoundRow">
              <span className="animeSourceSiteAvatar animeSourceSiteAvatarLg"
                style={{ background: siteColor(currentRoute?.site || "") }}>
                {(currentRoute?.site || "?")[0]}
              </span>
              <div className="animeSourcePanelFoundInfo">
                <span className="animeSourcePanelMeta">数据源</span>
                <span className="animeSourcePanelName">
                  {currentRoute?.site}
                  {currentRoute?.route ? ` · ${currentRoute.route}` : ""}
                </span>
              </div>
              <button type="button" className="animeSourceRefreshBtn animeSourceManualBtn"
                onClick={handleRefreshSources} title="刷新源">
                ↻ 刷新源
              </button>
              <button type="button" className="animeSourceManualBtn"
                onClick={() => setManualSelectOpen(true)}>
                ⇌ 更换
              </button>
              {videoReady && !playerError && (
                <button
                  type="button"
                  className={`animeSourceManualBtn animeDownloadEpBtn${downloadStatus === "downloading" ? " downloading" : ""}${downloadStatus === "done" ? " done" : ""}`}
                  onClick={handleDownloadEpisode}
                  disabled={downloadStatus === "downloading"}
                  title={downloadStatus === "done" ? "下载完成" : downloadStatus === "failed" ? (downloadError || "下载失败") : "下载当前集到NAS"}
                >
                  {downloadStatus === "downloading" ? "⏳ 下载中…" : downloadStatus === "done" ? "✓ 已下载" : downloadStatus === "failed" ? "✕ 失败" : "↓ 下载"}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Episode combobox — Bangumi names preferred, CMS episodes as fallback */}
        {(bgmEpisodes.length > 0 || cmsEpisodes.length > 0) && (
          <div className="animePlayerPageEps">
            <div className="animePlayerPageEpsHeader">
              <span className="animePlayerPageEpsTitle">
                剧集（共 {bgmEpisodes.length > 0 ? bgmEpisodes.length : cmsEpisodes.length} 话）
              </span>
              <Select
                className="animeEpSelect"
                value={currentEp ?? ""}
                onChange={(_, data) => {
                  const val = Number(data.value);
                  if (!Number.isNaN(val)) { setCurrentEp(val); setPlayerError(null); setDownloadStatus(null); setDownloadError(null); resolvedStreamRef.current = null; }
                }}
              >
                {bgmEpisodes.length > 0 ? bgmEpisodes.map((ep) => {
                  const cmsEp = bgmToCms(ep.sort);
                  const hasStream = cmsEpisodes.some((ce) => ce.ep === cmsEp);
                  const sortLabel = String(ep.sort).padStart(2, "0");
                  const epName = ep.name_cn || ep.name || `第${ep.sort}集`;
                  return (
                    <option key={ep.id || ep.sort} value={cmsEp} disabled={!hasStream}>
                      {sortLabel} {epName}
                    </option>
                  );
                }) : cmsEpisodes.map((ep) => (
                  <option key={ep.ep} value={ep.ep}>
                    {String(ep.ep).padStart(2, "0")} {ep.label || `第${ep.ep}集`}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        )}
      </div>

      {/* ── Source selection sheet — animeko simple-mode style ──── */}
      {manualSelectOpen && (
        <div className="animeManualSelectSheet"
          onClick={(e) => { if (e.target === e.currentTarget) setManualSelectOpen(false); }}>
          <div className="animeManualSelectPanel">
            <div className="animeManualSelectHeader">
              <span>选择数据源</span>
              <button type="button" onClick={() => setManualSelectOpen(false)}>
                <DismissRegular />
              </button>
            </div>
            <div className="animeManualSelectList">
              {/* Group by site — each site row has route pills like animeko */}
              {siteGroups.map(({ site, routes: siteRoutes }) => (
                <div key={site} className="animeSourceSiteRow">
                  <span className="animeSourceSiteAvatar" style={{ background: siteColor(site) }}>
                    {site[0]}
                  </span>
                  <span className="animeSourceSiteName">{site}</span>
                  <div className="animeSourceRoutePills">
                    {siteRoutes.map(({ route, idx }) => (
                      <button key={idx} type="button"
                        className={`animeRoutePill${idx === currentRouteIdx ? " active" : ""}`}
                        onClick={() => { handleRouteSwitch(idx); setManualSelectOpen(false); }}>
                        {route}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {searchLoading && (
                <div className="animeManualSelectLoading">
                  <Spinner size="tiny" /> 仍在搜索更多源…
                </div>
              )}
              {!searchLoading && siteGroups.length === 0 && blockedSites.length === 0 && (
                <div className="animeManualSelectLoading">暂无可用数据源</div>
              )}
              {/* Blocked/captcha sites — inside the picker with verify links */}
              {blockedSites.length > 0 && (
                <div className="animeBlockedInPicker">
                  <span className="animeBlockedPickerTitle">
                    以下站点需验证后可用（{blockedSites.length}）
                  </span>
                  <div className="animeBlockedPickerList">
                    {blockedSites.map(({ site, url }) => (
                      <a key={site} href={url} target="_blank" rel="noreferrer"
                        className="animeBlockedPickerLink">
                        <span className="animeSourceSiteAvatar animeBlockedPickerAvatar"
                          style={{ background: siteColor(site) }}>
                          {site[0]}
                        </span>
                        <span className="animeBlockedPickerName">{site}</span>
                        <span className="animeBlockedPickerBadge">验证 ↗</span>
                      </a>
                    ))}
                  </div>
                  <span className="animeBlockedHint" style={{ padding: "4px 0 0" }}>
                    在浏览器完成验证后，点击"刷新源"重试
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Stream Source Error ──────────────────────────────────────────────────────
function StreamSourceError({ message, onClose }) {
  return (
    <div className="mikanPicker">
      <div className="mikanPickerHeader">
        <span className="mikanPickerTitle" style={{ color: "#dc2626" }}>未找到播放源</span>
        <button type="button" className="animeDetailClose" onClick={onClose}><DismissRegular /></button>
      </div>
      <div className="animePageCenter animePageEmpty" style={{ padding: 24 }}>{message}</div>
    </div>
  );
}

// ─── Mikan Torrent Picker ─────────────────────────────────────────────────────

function MikanPicker({ keyword, authToken, onPickMagnet, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [items, setItems] = useState([]);

  useEffect(() => {
    setLoading(true);
    apiRequest(`/api/anime/bt-search?q=${encodeURIComponent(keyword)}`, { token: authToken })
      .then((data) => setItems(data.items || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [keyword, authToken]);

  return (
    <div className="mikanPicker">
      <div className="mikanPickerHeader">
        <span className="mikanPickerTitle">BT 搜索：{keyword}</span>
        <button type="button" className="animeDetailClose" onClick={onClose}><DismissRegular /></button>
      </div>
      {loading && <div className="animePageCenter"><Spinner size="small" label="搜索中…" /></div>}
      {error && <div className="animePageCenter animePageError">搜索失败：{error}</div>}
      {!loading && items.length === 0 && !error && (
        <div className="animePageCenter animePageEmpty">未找到相关种子</div>
      )}
      {!loading && items.length > 0 && (
        <div className="mikanPickerList">
          {items.map((item, i) => (
            <button
              key={i}
              type="button"
              className="mikanPickerItem"
              onClick={() => onPickMagnet(item)}
              title={item.title}
            >
              <ArrowDownloadRegular className="mikanPickerIcon" />
              <span className="mikanPickerName">{item.title}</span>
              {item.sourceName && <span className="mikanPickerSource">{item.sourceName}</span>}
              {item.pubDate && <span className="mikanPickerDate">{item.pubDate.slice(0, 10)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Detail Panel ─────────────────────────────────────────────────────────────

function DetailPanel({ subjectId, authToken, onClose, onPlay }) {
  const [detail, setDetail] = useState(null);
  const [episodes, setEpisodes] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [episodesExpanded, setEpisodesExpanded] = useState(false);

  useEffect(() => {
    if (!subjectId) return;
    setLoading(true);
    setError(null);
    setDetail(null);
    setEpisodes(null);
    setEpisodesExpanded(false);
    Promise.all([
      fetchSubjectDetail(subjectId),
      fetchEpisodes(subjectId)
    ])
      .then(([d, e]) => {
        setDetail(d);
        setEpisodes(e?.data || []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [subjectId]);

  // Navigate to player page — pass Bangumi episodes for episode names
  function handlePlayEpisode(epSort, animeName, animeNameJa) {
    onPlay({ animeName, animeNameJa, hintEp: epSort, bgmEpisodes: episodes || [] });
  }

  const score = detail?.rating?.score;
  const rank = detail?.rating?.rank;
  const img = subjectImage(detail, "large") || subjectImage(detail, "common");
  const tags = (detail?.tags || []).slice(0, 12);
  const visibleEpisodes = episodesExpanded ? episodes : episodes?.slice(0, 12);
  const animeName = displayName(detail);           // Chinese name (preferred)
  const animeNameJa = detail?.name || "";          // Japanese/original name (fallback)
  const bilibiliSearchUrl = detail
    ? `https://search.bilibili.com/all?keyword=${encodeURIComponent(animeName)}`
    : "";

  return (
    <div className="animeDetailPanel">
      <div className="animeDetailHeader">
        <button type="button" className="animeDetailClose" onClick={onClose} title="关闭">
          <DismissRegular />
        </button>
        {detail && (
          <div className="animeDetailHeaderActions">
            <a
              href={bilibiliSearchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="animeDetailBgmLink"
              title="在 B 站搜索"
            >
              B 站
            </a>
            <a
              href={`https://bgm.tv/subject/${subjectId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="animeDetailBgmLink"
            >
              <OpenRegular /> Bangumi
            </a>
          </div>
        )}
      </div>

      {loading && <div className="animePageCenter" style={{ minHeight: 200 }}><Spinner size="large" label="加载中…" /></div>}
      {error && <div className="animePageCenter animePageError">加载失败：{error}</div>}

      {detail && !loading && (
        <div className="animeDetailBody">
          <div className="animeDetailHero">
            {img && <img src={img} alt={animeName} className="animeDetailPoster" />}
            <div className="animeDetailMeta">
              <div className="animeDetailName">{animeName}</div>
              {detail.name && detail.name !== animeName && (
                <div className="animeDetailNameJa">{detail.name}</div>
              )}
              <div className="animeDetailStats">
                {score > 0 && (
                  <span className="animeDetailScore" style={{ color: scoreColor(score) }}>
                    <StarFilled style={{ fontSize: 14, verticalAlign: -2 }} /> {score.toFixed(1)}
                  </span>
                )}
                {rank > 0 && <span className="animeDetailRank">#{rank}</span>}
              </div>
              {detail.date && (
                <div className="animeDetailInfoRow">
                  <span className="animeDetailInfoLabel">首播</span>
                  <span>{detail.date}</span>
                </div>
              )}
              {detail.total_episodes > 0 && (
                <div className="animeDetailInfoRow">
                  <span className="animeDetailInfoLabel">集数</span>
                  <span>{detail.total_episodes} 集</span>
                </div>
              )}
              {detail.platform && (
                <div className="animeDetailInfoRow">
                  <span className="animeDetailInfoLabel">平台</span>
                  <span>{detail.platform}</span>
                </div>
              )}
            </div>
          </div>

          <div className="animeDetailActions">
            <Button
              appearance="primary"
              icon={<PlayRegular />}
              className="animeWatchBtn"
              onClick={() => handlePlayEpisode(1, animeName, animeNameJa)}
            >
              开始观看
            </Button>
          </div>

          {tags.length > 0 && (
            <div className="animeDetailTags">
              {tags.map((t) => (
                <Badge key={t.name} appearance="tint" color="informative" size="small">
                  {t.name}
                </Badge>
              ))}
            </div>
          )}

          {detail.summary && (
            <div className="animeDetailSection">
              <div className="animeDetailSectionTitle">简介</div>
              <p className="animeDetailSummary">{detail.summary}</p>
            </div>
          )}

          {episodes && episodes.length > 0 && (
            <div className="animeDetailSection">
              <div className="animeDetailSectionTitle">集数列表（{episodes.length} 集）</div>
              <div className="animeEpisodeList">
                {visibleEpisodes.map((ep) => {
                  const epName = ep.name_cn || ep.name || `第 ${ep.sort} 集`;
                  return (
                    <div key={ep.id} className="animeEpisodeItem">
                      <span className="animeEpNum">EP{ep.sort}</span>
                      <span className="animeEpName">{epName}</span>
                      {ep.airdate && <span className="animeEpDate">{ep.airdate}</span>}
                      <button
                        type="button"
                        className="animeEpPlay"
                        title={`在线播放 第${ep.sort}集`}
                        onClick={() => handlePlayEpisode(ep.sort, animeName, animeNameJa)}
                      >
                        <PlayRegular />
                      </button>
                    </div>
                  );
                })}
              </div>
              {episodes.length > 12 && (
                <button
                  type="button"
                  className="animeEpisodesToggle"
                  onClick={() => setEpisodesExpanded(!episodesExpanded)}
                >
                  {episodesExpanded ? "收起" : `展开全部 ${episodes.length} 集`}
                  <ChevronRightRegular className={episodesExpanded ? "animeToggleIconUp" : ""} />
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main AnimePage ───────────────────────────────────────────────────────────

const TABS = [
  { id: "schedule", label: "新番时间表" },
  { id: "catalog", label: "目录" },
  { id: "search", label: "搜索番剧" },
];

export default function AnimePage({ authToken, p2p, clients }) {
  const [activeTab, setActiveTab] = useState("schedule");
  const [selectedSubjectId, setSelectedSubjectId] = useState(null);
  const [playerState, setPlayerState] = useState(null); // {sources,episodes,animeName,currentEp}

  function handleSelectAnime(item) {
    setSelectedSubjectId(item?.id || null);
  }

  function handleCloseDetail() {
    setSelectedSubjectId(null);
  }

  // Full-page player takes over when active
  if (playerState) {
    return (
      <AnimePlayerPage
        playerState={playerState}
        authToken={authToken}
        p2p={p2p}
        clients={clients}
        onBack={() => setPlayerState(null)}
      />
    );
  }

  return (
    <div className={`animePage${selectedSubjectId ? " hasDetail" : ""}`}>
      <div className="animeMain">
        <div className="animePageTabBar">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`animePageTab${activeTab === tab.id ? " active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="animeContent">
          {activeTab === "schedule" && (
            <ScheduleView onSelectAnime={handleSelectAnime} />
          )}
          {activeTab === "catalog" && (
            <CatalogView onSelectAnime={handleSelectAnime} />
          )}
          {activeTab === "search" && (
            <SearchView onSelectAnime={handleSelectAnime} />
          )}
        </div>
      </div>

      {selectedSubjectId && (
        <DetailPanel
          subjectId={selectedSubjectId}
          authToken={authToken}
          onClose={handleCloseDetail}
          onPlay={setPlayerState}
        />
      )}
    </div>
  );
}
