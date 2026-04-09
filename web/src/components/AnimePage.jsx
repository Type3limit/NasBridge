import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Spinner, Badge } from "@fluentui/react-components";
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

const BGM_API = "https://api.bgm.tv";
const BGM_HEADERS = { "User-Agent": "nas-media-manager/1.0 (https://github.com)" };

// Subject type 2 = anime
const ANIME_TYPE = 2;

const WEEKDAY_LABELS = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

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
        {item?.air_date && (
          <span className="animeCardMeta">{item.air_date}</span>
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
        <div className="animePageCenter animePageEmpty" style={{ marginTop: 80 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🔍</div>
          <div>输入番剧名称开始搜索</div>
        </div>
      )}
    </div>
  );
}

// ─── Full-page Player ─────────────────────────────────────────────────────────
// playerState = { animeName, animeNameJa, hintEp }
// Episode list comes entirely from CMS sources, NOT from Bangumi.
function AnimePlayerPage({ playerState, authToken, onBack }) {
  const { animeName, animeNameJa, hintEp } = playerState;

  // routes: [{ site, route, vodName, episodes: [{ep, url, playUrl, type}] }]
  const [routes, setRoutes] = useState([]);
  const [currentRouteIdx, setCurrentRouteIdx] = useState(0);
  const [currentEp, setCurrentEp] = useState(null); // CMS episode number (1-based)
  const [searchLoading, setSearchLoading] = useState(true);
  const [playerError, setPlayerError] = useState(null);
  const [searchKey, setSearchKey] = useState(0); // increment to force re-search
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const routesAccumRef = useRef([]); // accumulates routes during SSE for caching

  function handleRefreshSources() {
    SOURCE_CACHE.delete(animeName);
    setSearchKey((k) => k + 1);
  }

  const currentRoute = routes[currentRouteIdx] ?? null;
  const cmsEpisodes = currentRoute?.episodes ?? [];
  const currentEpisode = (currentEp != null && cmsEpisodes.find((e) => e.ep === currentEp))
    || cmsEpisodes[0]
    || null;

  // Fetch all routes + their episode lists from CMS. Runs on mount; re-runs when searchKey changes.
  useEffect(() => {
    let cancelled = false;
    setRoutes([]);
    setCurrentRouteIdx(0);
    setCurrentEp(null);
    setPlayerError(null);
    setSearchLoading(true);
    routesAccumRef.current = [];

    // Check cache first — skip SSE if we already have results
    const cached = getCachedRoutes(animeName);
    if (cached && cached.length > 0) {
      setRoutes(cached);
      setSearchLoading(false);
      const eps = cached[0].episodes || [];
      const found = hintEp != null && eps.find((e) => e.ep === hintEp);
      setCurrentEp(found ? hintEp : (eps[0]?.ep ?? 1));
      return;
    }

    const controller = new AbortController();
    const hardTimer = setTimeout(() => controller.abort(), 20_000);

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
                  const found = hintEp != null && eps.find((e) => e.ep === hintEp);
                  setCurrentEp(found ? hintEp : (eps[0]?.ep ?? 1));
                }
              }
            } else if (msg.type === "done") {
              if (!cancelled) {
                if (firstRoute) setPlayerError("未找到可用播放源");
                setSearchLoading(false);
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

  // Load video whenever the active episode changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !currentEpisode?.playUrl) return;
    setPlayerError(null);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    const isMp4 = currentEpisode.type === "mp4" || /\.(mp4|flv|mkv)(\?|$)/i.test(currentEpisode.url || "");

    if (isMp4) {
      video.src = currentEpisode.playUrl;
      video.play().catch(() => {});
      video.onerror = () => setPlayerError(`播放失败：${video.error?.message || "未知错误"}`);
    } else if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: false,
        fragLoadingMaxRetry: 1,
        manifestLoadingMaxRetry: 1,
        xhrSetup: (xhr) => { xhr.setRequestHeader("Authorization", `Bearer ${authToken}`); },
      });
      hlsRef.current = hls;
      hls.loadSource(currentEpisode.playUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) { setPlayerError(`播放失败：${data.details}`); hls.destroy(); hlsRef.current = null; }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = currentEpisode.playUrl;
      video.play().catch(() => {});
      video.onerror = () => setPlayerError(`播放失败：${video.error?.message || "未知错误"}`);
    } else {
      setPlayerError("当前浏览器不支持 HLS 播放");
    }
    return () => { if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; } };
  }, [currentEpisode]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleRouteSwitch(idx) {
    if (idx === currentRouteIdx) return;
    setCurrentRouteIdx(idx);
    setPlayerError(null);
    const newEps = routes[idx]?.episodes ?? [];
    if (!newEps.find((e) => e.ep === currentEp)) setCurrentEp(newEps[0]?.ep ?? 1);
  }

  const nextRouteIdx = currentRouteIdx + 1 < routes.length ? currentRouteIdx + 1 : null;

  return (
    <div className="animePlayerPage">
      <div className="animePlayerPageHeader">
        <button type="button" className="animePlayerPageBack" onClick={onBack}>
          <ChevronRightRegular style={{ transform: "rotate(180deg)" }} /> 返回
        </button>
        <span className="animePlayerPageTitle">
          {currentRoute?.vodName || animeName}
          {currentEpisode ? ` · EP${currentEpisode.ep}` : ""}
        </span>
      </div>

      <div className="animePlayerPageVideo">
        {searchLoading ? (
          <div className="animePlayerError">
            <Spinner size="medium" label="正在搜索播放源…" />
          </div>
        ) : playerError ? (
          <div className="animePlayerError">
            <div className="animePlayerErrorMsg">{playerError}</div>
            {nextRouteIdx !== null && (
              <button type="button" className="animeSourceBtn active"
                onClick={() => { handleRouteSwitch(nextRouteIdx); setPlayerError(null); }}>
                尝试下一个线路 →
              </button>
            )}
          </div>
        ) : (
          <video ref={videoRef} className="animePlayerPageVideoEl" controls playsInline autoPlay />
        )}
      </div>

      <div className="animePlayerPageScroll">
        {routes.length > 0 && (
          <div className="animeSourceBar">
            <span className="animeSourceBarLabel">线路：</span>
            {routes.map((r, i) => (
              <button key={i} type="button"
                className={`animeSourceBtn${i === currentRouteIdx ? " active" : ""}`}
                onClick={() => handleRouteSwitch(i)}>
                {r.site} {r.route}
              </button>
            ))}
            {!searchLoading && (
              <button type="button" className="animeSourceBtn animeSourceRefreshBtn"
                title="重新搜索播放源" onClick={handleRefreshSources}>
                ↻ 刷新源
              </button>
            )}
          </div>
        )}
        {!searchLoading && routes.length === 0 && !playerError && (
          <div className="animeSourceBar">
            <button type="button" className="animeSourceBtn animeSourceRefreshBtn"
              onClick={handleRefreshSources}>
              ↻ 重新搜索
            </button>
          </div>
        )}

        {cmsEpisodes.length > 0 && (
          <div className="animePlayerPageEps">
            <div className="animePlayerPageEpsTitle">剧集（共 {cmsEpisodes.length} 集）</div>
            <div className="animePlayerPageEpList">
              {cmsEpisodes.map((ep) => (
                <button key={ep.ep} type="button"
                  className={`animePlayerEpBtn${ep.ep === currentEpisode?.ep ? " active" : ""}`}
                  onClick={() => setCurrentEp(ep.ep)}>
                  EP{ep.ep}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
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
    apiRequest(`/api/anime/mikan?q=${encodeURIComponent(keyword)}`, { token: authToken })
      .then((data) => setItems(data.items || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [keyword, authToken]);

  return (
    <div className="mikanPicker">
      <div className="mikanPickerHeader">
        <span className="mikanPickerTitle">蜜柑搜索：{keyword}</span>
        <button type="button" className="animeDetailClose" onClick={onClose}><DismissRegular /></button>
      </div>
      {loading && <div className="animePageCenter"><Spinner size="small" label="搜索中…" /></div>}
      {error && <div className="animePageCenter animePageError">搜索失败：{error}</div>}
      {!loading && items.length === 0 && !error && (
        <div className="animePageCenter animePageEmpty">蜜柑未找到相关种子</div>
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
  const [mikanQuery, setMikanQuery] = useState(null);
  const [copiedInfo, setCopiedInfo] = useState(null);

  useEffect(() => {
    if (!subjectId) return;
    setLoading(true);
    setError(null);
    setDetail(null);
    setEpisodes(null);
    setEpisodesExpanded(false);
    setMikanQuery(null);
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

  // Navigate to player page — player fetches its own episode list from CMS
  function handlePlayEpisode(epSort, animeName, animeNameJa) {
    onPlay({ animeName, animeNameJa, hintEp: epSort });
  }

  function handlePickMagnet(item) {
    const magnet = item.magnet || item.link;
    if (!magnet) return;
    navigator.clipboard?.writeText(magnet).catch(() => {});
    setCopiedInfo({ magnet, title: item.title });
    setMikanQuery(null);
  }

  function handleOpenTorrentBot(magnet) {
    const chatText = `@torrent ${magnet}`;
    window.dispatchEvent(new CustomEvent("anime:fill-chat", { detail: { text: chatText } }));
    setCopiedInfo(null);
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

      {copiedInfo && (
        <div className="mikanCopiedBanner">
          <div className="mikanCopiedTitle" title={copiedInfo.title}>已复制：{copiedInfo.title}</div>
          <div className="mikanCopiedActions">
            <button
              type="button"
              className="mikanCopiedBtn primary"
              onClick={() => handleOpenTorrentBot(copiedInfo.magnet)}
            >
              发送给 torrent bot 下载
            </button>
            <button type="button" className="mikanCopiedBtn" onClick={() => setCopiedInfo(null)}>
              关闭
            </button>
          </div>
        </div>
      )}

      {mikanQuery && (
        <MikanPicker
          keyword={mikanQuery.keyword}
          authToken={authToken}
          onPickMagnet={handlePickMagnet}
          onClose={() => setMikanQuery(null)}
        />
      )}

      {detail && !loading && !mikanQuery && (
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
            <Button
              appearance="outline"
              icon={<ArrowDownloadRegular />}
              className="animeDownloadBtn"
              onClick={() => setMikanQuery({ keyword: animeName })}
            >
              蜜柑下载
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
                  const searchKw = `${animeName} ${ep.sort}`;
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
                      <button
                        type="button"
                        className="animeEpDownload"
                        title={`蜜柑搜索 ${searchKw}`}
                        onClick={() => setMikanQuery({ keyword: searchKw })}
                      >
                        <ArrowDownloadRegular />
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
  { id: "search", label: "搜索番剧" },
];

export default function AnimePage({ authToken }) {
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
