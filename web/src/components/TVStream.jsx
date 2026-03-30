import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { Spinner } from "@fluentui/react-components";
import {
  AddRegular,
  ChevronLeftRegular,
  ChevronRightRegular,
  DeleteRegular,
} from "@fluentui/react-icons";

// ─── LocalStorage fallback cache ───────────────────────────
const TV_SOURCES_KEY = "tv_sources_v2";

function cacheLoad() {
  try { return JSON.parse(localStorage.getItem(TV_SOURCES_KEY) || "[]"); } catch { return []; }
}
function cacheSave(sources) {
  try { localStorage.setItem(TV_SOURCES_KEY, JSON.stringify(sources.slice(0, 50))); } catch {}
}

// ─── M3U parser ─────────────────────────────────────────────
function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let pending = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#EXTINF")) {
      const nameMatch = t.match(/,(.+)$/);
      const logoMatch = t.match(/tvg-logo="([^"]*)"/);
      const groupMatch = t.match(/group-title="([^"]*)"/);
      const tvgNameMatch = t.match(/tvg-name="([^"]*)"/);
      pending = {
        name: nameMatch ? nameMatch[1].trim() : "未知频道",
        logo: logoMatch ? logoMatch[1].trim() : "",
        group: groupMatch && groupMatch[1].trim() ? groupMatch[1].trim() : "未分类",
        tvgName: tvgNameMatch ? tvgNameMatch[1].trim() : "",
        url: "",
      };
    } else if (pending && !t.startsWith("#")) {
      pending.url = t;
      channels.push(pending);
      pending = null;
    }
  }
  return channels;
}

// ─── TXT format: "频道名,url" or "分组名,#genre#" ────────────
function parseTxt(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let currentGroup = "未分类";
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const commaIdx = t.indexOf(",");
    if (commaIdx === -1) continue;
    const left = t.slice(0, commaIdx).trim();
    const right = t.slice(commaIdx + 1).trim();
    if (right === "#genre#" || right === "") {
      currentGroup = left || "未分类";
      continue;
    }
    if (/^https?:\/\//i.test(right)) {
      channels.push({ name: left, url: right, logo: "", group: currentGroup, tvgName: left });
    }
  }
  return channels;
}

function parsePlaylist(text) {
  const channels = text.includes("#EXTINF") ? parseM3U(text) : parseTxt(text);
  const groups = [...new Set(channels.map((c) => c.group))];
  return { channels, groups };
}

// ─── Aggregation format {"urls":[{name, url}]} ───────────────
function detectContentType(text) {
  const t = text.trimStart();
  if (t.startsWith("#EXTM3U") || t.includes("#EXTINF")) return "m3u";
  if (t.startsWith("{")) {
    try {
      const json = JSON.parse(t);
      if (Array.isArray(json.urls)) return "aggregation";
      if (json.spider !== undefined || Array.isArray(json.sites)) return "tvbox";
    } catch {}
  }
  return /https?:\/\//i.test(t) ? "txt" : "unknown";
}

function parseAggregation(text) {
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json.urls)) return json.urls; // [{name, url}]
  } catch {}
  return [];
}

// ─── Component ──────────────────────────────────────────────
export default function TVStream({ authToken, setMessage }) {
  const [sources, setSources] = useState([]);
  const [activeSourceId, setActiveSourceId] = useState(null);
  const [channels, setChannels] = useState([]);
  const [groups, setGroups] = useState([]);
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [selectedChannel, setSelectedChannel] = useState(null);
  // "idle" | "loading" | "playing" | "paused" | "error"
  const [playState, setPlayState] = useState("idle");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  // "url" | "paste"
  const [addMode, setAddMode] = useState("url");
  const [draftLabel, setDraftLabel] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [fetchingPlaylist, setFetchingPlaylist] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  // URLs that failed to play — shown grayed-out
  const [failedChannels, setFailedChannels] = useState(new Set());
  // Aggregation ({"urls":[...]}) state
  const [aggregationList, setAggregationList] = useState(null); // [{name,url}] or null
  const [loadingSubSource, setLoadingSubSource] = useState(false);
  const [failedSubSources, setFailedSubSources] = useState(new Set());

  const videoRef = useRef(null);
  const hlsRef = useRef(null);

  // ── Load server history on mount ──
  useEffect(() => {
    async function loadHistory() {
      try {
        const res = await fetch("/api/tv/sources", {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (res.ok) {
          const { sources: serverSources } = await res.json();
          setSources(serverSources);
          cacheSave(serverSources);
          if (serverSources.length > 0) applySource(serverSources[0]);
          else setLoadingHistory(false);
          return;
        }
      } catch {}
      const cached = cacheLoad();
      setSources(cached);
      if (cached.length > 0) applySource(cached[0]);
      else setLoadingHistory(false);
    }
    loadHistory();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sidebar auto-collapse/expand + track failed channels ──
  useEffect(() => {
    if (playState === "playing") setSidebarCollapsed(true);
    else if (playState !== "loading") setSidebarCollapsed(false);
    if (playState === "error" && selectedChannel) {
      setFailedChannels((prev) => new Set([...prev, selectedChannel.url]));
    }
  }, [playState]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── HLS / native video player ──
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !selectedChannel) return;
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    setPlayState("loading");
    const { url } = selectedChannel;

    // Reject non-http(s) URLs immediately (e.g. javascript://, tvbox://, etc.)
    if (!/^https?:\/\//i.test(url)) {
      setPlayState("error");
      return;
    }

    // Only proxy http:// streams — browsers block mixed content (http resource on https page).
    // https:// streams are played directly to avoid CDN auth/CORS issues introduced by proxying.
    const needsProxy = /^http:\/\//i.test(url);
    const playUrl = needsProxy ? `/api/tv/stream?url=${encodeURIComponent(url)}` : url;
    const looksLikeHls = /\.m3u8($|\?)/i.test(url.split("?")[0]) || /m3u8/i.test(url);

    if (looksLikeHls && Hls.isSupported()) {
      const hlsCfg = { enableWorker: true, lowLatencyMode: true };
      // Only inject auth header for same-origin proxy requests (not external CDN URLs)
      if (needsProxy && authToken) {
        hlsCfg.xhrSetup = (xhr) => xhr.setRequestHeader("Authorization", `Bearer ${authToken}`);
      }
      const hls = new Hls(hlsCfg);
      hlsRef.current = hls;
      hls.loadSource(playUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => setPlayState("paused")); });
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) setPlayState("error"); });
    } else if (looksLikeHls && video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      video.src = playUrl;
      video.play().catch(() => setPlayState("paused"));
    } else {
      // Non-HLS stream (FLV, MP4, TS, etc.)
      video.src = playUrl;
      video.play().catch(() => setPlayState("paused"));
    }

    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      video.src = "";
    };
  }, [selectedChannel, authToken]);

  // Cleanup HLS on unmount
  useEffect(() => {
    return () => { if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; } };
  }, []);

  // Loading timeout: if stuck in "loading" for 15s without playback, mark as error
  useEffect(() => {
    if (playState !== "loading") return;
    const timer = setTimeout(() => setPlayState("error"), 15_000);
    return () => clearTimeout(timer);
  }, [playState]);

  // ── Apply a source: parse or fetch its content ──
  async function applySource(source) {
    if (!source) return;
    setFetchingPlaylist(true);
    setActiveSourceId(source.id);
    setSelectedChannel(null);
    setPlayState("idle");
    setFailedChannels(new Set());
    setAggregationList(null);
    setFailedSubSources(new Set());
    setChannels([]); setGroups([]);
    try {
      let text;
      if (source.content) {
        text = source.content;
      } else if (source.url) {
        const params = new URLSearchParams({ url: source.url });
        const res = await fetch(`/api/tv/playlist?${params}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setMessage?.(err.error || "加载失败", "error");
          return;
        }
        text = await res.text();
      } else {
        setMessage?.("该源无可用内容", "error");
        return;
      }
      const ctype = detectContentType(text);
      if (ctype === "aggregation") {
        const subs = parseAggregation(text);
        setAggregationList(subs);
      } else {
        const { channels: parsed, groups: parsedGroups } = parsePlaylist(text);
        setChannels(parsed);
        setGroups(parsedGroups);
        setExpandedGroups(new Set(parsedGroups.slice(0, 3)));
      }
    } catch (err) {
      setMessage?.(`加载失败：${err.message}`, "error");
    } finally {
      setFetchingPlaylist(false);
      setLoadingHistory(false);
    }
  }

  // ── Load a sub-source from aggregation ──
  async function applySubSource(name, url) {
    setLoadingSubSource(true);
    setChannels([]); setGroups([]);
    setSelectedChannel(null); setPlayState("idle");
    setFailedChannels(new Set());
    try {
      const params = new URLSearchParams({ url });
      const res = await fetch(`/api/tv/playlist?${params}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        setFailedSubSources((prev) => new Set([...prev, url]));
        setMessage?.(`「${name}」加载失败`, "warning");
        return;
      }
      const text = await res.text();
      const ctype = detectContentType(text);
      if (ctype === "aggregation") {
        // Drill down into nested aggregation
        setAggregationList(parseAggregation(text));
        setFailedSubSources(new Set());
      } else if (ctype === "tvbox") {
        setFailedSubSources((prev) => new Set([...prev, url]));
        setMessage?.(`「${name}」是 TVBox 点播配置，需要专用 App 播放，暂不支持在浏览器中直播`, "warning");
      } else {
        const { channels: parsed, groups: parsedGroups } = parsePlaylist(text);
        if (parsed.length === 0) {
          setFailedSubSources((prev) => new Set([...prev, url]));
          setMessage?.(`「${name}」未解析到频道`, "warning");
          return;
        }
        setChannels(parsed);
        setGroups(parsedGroups);
        setExpandedGroups(new Set(parsedGroups.slice(0, 3)));
      }
    } catch (err) {
      setFailedSubSources((prev) => new Set([...prev, url]));
      setMessage?.(`「${name}」加载出错：${err.message}`, "warning");
    } finally {
      setLoadingSubSource(false);
    }
  }

  // ── Save to server (only when channelCount > 0) ──
  async function persistToServer({ label, url, content, channelCount }) {
    try {
      const body = { label, channelCount };
      if (url) body.url = url;
      if (!url && content) body.content = content.slice(0, 512 * 1024);
      const res = await fetch("/api/tv/sources", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const { source: saved } = await res.json();
        return saved;
      }
    } catch {}
    return null;
  }

  // ── Add source from URL ──
  async function addSourceByUrl() {
    const url = draftUrl.trim();
    if (!url) return;
    const label = draftLabel.trim() || (() => {
      try { return new URL(url).hostname; } catch { return url.slice(0, 32); }
    })();
    setFetchingPlaylist(true);
    try {
      const params = new URLSearchParams({ url });
      const res = await fetch(`/api/tv/playlist?${params}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setMessage?.(err.error || "源地址无法加载", "error");
        return;
      }
      const text = await res.text();
      const ctype = detectContentType(text);
      // ── Aggregation index ──
      if (ctype === "aggregation") {
        const subs = parseAggregation(text);
        if (subs.length === 0) { setMessage?.("聚合列表为空", "warning"); return; }
        const saved = await persistToServer({ label, url, content: null, channelCount: subs.length });
        const entry = saved ?? { id: `local-${Date.now()}`, label, url, content: null, channelCount: subs.length, savedAt: new Date().toISOString() };
        const next = [entry, ...sources];
        setSources(next); cacheSave(next);
        setAggregationList(subs);
        setChannels([]); setGroups([]);
        setActiveSourceId(entry.id); setSelectedChannel(null); setPlayState("idle");
        setFailedSubSources(new Set());
        closeAddForm();
        setMessage?.(`已添加聚合源「${label}」（${subs.length} 个子源）`, "success");
        return;
      }
      // ── Normal playlist ──
      const { channels: parsed, groups: parsedGroups } = parsePlaylist(text);
      if (parsed.length === 0) {
        setMessage?.("未解析到有效频道，请检查源格式", "warning");
        return;
      }
      const saved = await persistToServer({ label, url, content: null, channelCount: parsed.length });
      const entry = saved ?? { id: `local-${Date.now()}`, label, url, content: null, channelCount: parsed.length, savedAt: new Date().toISOString() };
      const next = [entry, ...sources];
      setSources(next);
      cacheSave(next);
      setChannels(parsed);
      setGroups(parsedGroups);
      setExpandedGroups(new Set(parsedGroups.slice(0, 3)));
      setActiveSourceId(entry.id);
      setSelectedChannel(null);
      setPlayState("idle");
      setAggregationList(null);
      closeAddForm();
      setMessage?.(`已添加「${label}」（${parsed.length} 个频道）`, "success");
    } catch (err) {
      setMessage?.(`加载失败：${err.message}`, "error");
    } finally {
      setFetchingPlaylist(false);
    }
  }

  // ── Add source from pasted content ──
  async function addSourceByPaste() {
    const content = draftContent.trim();
    if (!content) return;
    const { channels: parsed, groups: parsedGroups } = parsePlaylist(content);
    if (parsed.length === 0) {
      setMessage?.("未解析到有效频道，请检查内容格式（M3U 或 TXT）", "warning");
      return;
    }
    const label = draftLabel.trim() || `自定义源 ${new Date().toLocaleDateString()}`;
    setFetchingPlaylist(true);
    try {
      const saved = await persistToServer({ label, url: null, content, channelCount: parsed.length });
      const entry = saved ?? { id: `local-${Date.now()}`, label, url: null, content, channelCount: parsed.length, savedAt: new Date().toISOString() };
      const next = [entry, ...sources];
      setSources(next);
      cacheSave(next);
      setChannels(parsed);
      setGroups(parsedGroups);
      setExpandedGroups(new Set(parsedGroups.slice(0, 3)));
      setActiveSourceId(entry.id);
      setSelectedChannel(null);
      setPlayState("idle");
      closeAddForm();
      setMessage?.(`已添加「${label}」（${parsed.length} 个频道）`, "success");
    } finally {
      setFetchingPlaylist(false);
    }
  }

  // ── Delete source ──
  async function deleteSource(id) {
    fetch(`/api/tv/sources/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
    }).catch(() => {});
    const next = sources.filter((s) => s.id !== id);
    setSources(next);
    cacheSave(next);
    if (activeSourceId === id) {
      const fallback = next[0] ?? null;
      if (fallback) applySource(fallback);
      else {
        setActiveSourceId(null);
        setChannels([]); setGroups([]);
        setSelectedChannel(null); setPlayState("idle");
      }
    }
  }

  function toggleGroup(group) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group); else next.add(group);
      return next;
    });
  }

  const groupCounts = useCallback(() => {
    const map = {};
    for (const c of channels) map[c.group] = (map[c.group] || 0) + 1;
    return map;
  }, [channels])();

  function closeAddForm() {
    setAddSourceOpen(false);
    setDraftLabel(""); setDraftUrl(""); setDraftContent("");
  }

  // ── Render ──────────────────────────────────────────────────
  return (
    <div className="tvStreamRoot">
      {/* Sidebar */}
      <aside className={`tvSidebar${sidebarCollapsed ? " tvSidebarCollapsed" : ""}`}>
        <button
          type="button"
          className="tvSidebarToggle"
          onClick={() => setSidebarCollapsed((v) => !v)}
          title={sidebarCollapsed ? "展开频道列表" : "折叠频道列表"}
        >
          {sidebarCollapsed ? <ChevronRightRegular /> : <ChevronLeftRegular />}
        </button>

        {!sidebarCollapsed && (
          <div className="tvSidebarInner">
            {/* Source bar */}
            <div className="tvSourceBar">
              <div className="tvSourceRow">
                <select
                  className="tvSourceSelect"
                  value={activeSourceId || ""}
                  onChange={(e) => {
                    const src = sources.find((s) => s.id === e.target.value);
                    if (src) applySource(src);
                  }}
                  disabled={fetchingPlaylist || loadingHistory}
                >
                  {sources.length === 0 && <option value="">暂无直播源</option>}
                  {sources.map((s) => (
                    <option key={s.id} value={s.id} title={s.savedAt ? new Date(s.savedAt).toLocaleString() : ""}>
                      {s.label}{s.channelCount ? ` (${s.channelCount})` : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="tvIconBtn"
                  title="添加直播源"
                  onClick={() => setAddSourceOpen((v) => !v)}
                >
                  <AddRegular />
                </button>
                {activeSourceId && (
                  <button
                    type="button"
                    className="tvIconBtn tvIconBtnDanger"
                    title="删除此直播源"
                    onClick={() => deleteSource(activeSourceId)}
                  >
                    <DeleteRegular />
                  </button>
                )}
              </div>

              {/* Add source form */}
              {addSourceOpen && (
                <div className="tvAddSourceForm">
                  <div className="tvModeTabs">
                    <button
                      type="button"
                      className={`tvModeTab${addMode === "url" ? " tvModeTabActive" : ""}`}
                      onClick={() => setAddMode("url")}
                    >URL 地址</button>
                    <button
                      type="button"
                      className={`tvModeTab${addMode === "paste" ? " tvModeTabActive" : ""}`}
                      onClick={() => setAddMode("paste")}
                    >粘贴内容</button>
                  </div>
                  <input
                    className="tvInput"
                    placeholder="源名称（选填）"
                    value={draftLabel}
                    onChange={(e) => setDraftLabel(e.target.value)}
                  />
                  {addMode === "url" ? (
                    <input
                      className="tvInput"
                      placeholder="M3U/TXT 地址（必填）"
                      value={draftUrl}
                      onChange={(e) => setDraftUrl(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") addSourceByUrl(); }}
                    />
                  ) : (
                    <textarea
                      className="tvInput tvContentArea"
                      placeholder={"粘贴 M3U 或 TXT 内容\n\n支持格式：\n#EXTM3U … 或\n频道名称,http://…"}
                      value={draftContent}
                      onChange={(e) => setDraftContent(e.target.value)}
                      rows={7}
                      spellCheck={false}
                    />
                  )}
                  <div className="tvAddSourceActions">
                    <button
                      type="button"
                      className="tvBtn tvBtnPrimary"
                      onClick={addMode === "url" ? addSourceByUrl : addSourceByPaste}
                      disabled={fetchingPlaylist || (addMode === "url" ? !draftUrl.trim() : !draftContent.trim())}
                    >
                      {fetchingPlaylist ? "解析中…" : "添加"}
                    </button>
                    <button type="button" className="tvBtn" onClick={closeAddForm}>取消</button>
                  </div>
                </div>
              )}

              {(fetchingPlaylist || loadingHistory) && (
                <div className="tvFetchingBar">
                  <Spinner size="tiny" />
                  <span>{loadingHistory ? "正在加载历史记录…" : "正在解析频道列表…"}</span>
                </div>
              )}
            </div>

            {/* Aggregation sub-source list */}
            {aggregationList !== null && channels.length === 0 && (
              <div className="tvAggregationList">
                <div className="tvAggregationHeader">
                  📋 聚合列表 · {aggregationList.length} 个子源
                  {loadingSubSource && <Spinner size="extra-tiny" style={{ marginLeft: 6 }} />}
                </div>
                {aggregationList.map(({ name, url: subUrl }) => (
                  <button
                    key={subUrl}
                    type="button"
                    className={["tvSubSourceItem", failedSubSources.has(subUrl) ? "tvSubSourceFailed" : ""].filter(Boolean).join(" ")}
                    onClick={() => { if (!failedSubSources.has(subUrl) && !loadingSubSource) applySubSource(name, subUrl); }}
                    title={failedSubSources.has(subUrl) ? `${name}（不支持/加载失败）` : name}
                  >
                    <span className="tvSubSourceName">{name}</span>
                    {failedSubSources.has(subUrl) && <span className="tvSubSourceBadge">✕</span>}
                  </button>
                ))}
              </div>
            )}

            {/* Channel list */}
            <div className="tvChannelList">
              {aggregationList !== null && channels.length > 0 && (
                <button
                  type="button"
                  className="tvAggregationBack"
                  onClick={() => { setChannels([]); setGroups([]); setSelectedChannel(null); setPlayState("idle"); }}
                >← 返回聚合列表</button>
              )}
              {channels.length === 0 && aggregationList === null && !fetchingPlaylist && !loadingHistory && (
                <div className="tvChannelEmpty">
                  {sources.length === 0 ? "请先添加直播源" : "暂无频道数据"}
                </div>
              )}
              {groups.map((group) => (
                <div key={group} className="tvChannelGroup">
                  <button
                    type="button"
                    className="tvGroupHeader"
                    onClick={() => toggleGroup(group)}
                  >
                    <ChevronRightRegular
                      className={`tvGroupChevron${expandedGroups.has(group) ? " tvGroupChevronOpen" : ""}`}
                    />
                    <span className="tvGroupName">{group}</span>
                    <span className="tvGroupCount">{groupCounts[group] || 0}</span>
                  </button>
                  {expandedGroups.has(group) && (
                    <div className="tvGroupChannels">
                      {channels
                        .filter((c) => c.group === group)
                        .map((channel) => (
                          <button
                            key={channel.url + channel.name}
                            type="button"
                            className={[
                              "tvChannelItem",
                              selectedChannel?.url === channel.url ? "tvChannelItemActive" : "",
                              failedChannels.has(channel.url) ? "tvChannelItemFailed" : "",
                            ].filter(Boolean).join(" ")}
                            onClick={() => { if (!failedChannels.has(channel.url)) setSelectedChannel(channel); }}
                            title={failedChannels.has(channel.url) ? `${channel.name}（无法播放）` : channel.name}
                          >
                            {channel.logo ? (
                              <img
                                src={channel.logo}
                                alt=""
                                className="tvChannelLogo"
                                onError={(e) => { e.currentTarget.style.display = "none"; }}
                              />
                            ) : (
                              <span className="tvChannelLogoPlaceholder" />
                            )}
                            <span className="tvChannelName">{channel.name}</span>
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>

      {/* Player area */}
      <div className="tvPlayerArea">
        {!selectedChannel ? (
          <div className="tvEmptyState">
            <span className="tvEmptyIcon">📺</span>
            <span>从左侧选择频道开始观看</span>
          </div>
        ) : (
          <div className="tvPlayerWrapper">
            <video
              ref={videoRef}
              className="tvVideo"
              controls
              playsInline
              onPlaying={() => setPlayState("playing")}
              onTimeUpdate={() => setPlayState((s) => s === "loading" ? "playing" : s)}
              onPause={() => setPlayState((s) => s !== "loading" ? "paused" : s)}
              onWaiting={() => setPlayState((s) => s === "playing" ? "loading" : s)}
              onError={() => setPlayState("error")}
              onEnded={() => setPlayState("idle")}
            />
            {playState === "loading" && (
              <div className="tvOverlay">
                <Spinner size="large" label="加载中…" />
              </div>
            )}
            {playState === "error" && (
              <div className="tvOverlay tvOverlayError">
                <span>加载失败，请尝试其他频道</span>
              </div>
            )}
          </div>
        )}
        {selectedChannel && (
          <div className="tvNowPlaying">
            <span className="tvNowPlayingName">{selectedChannel.name}</span>
            {playState === "playing" && <span className="tvLiveBadge">LIVE</span>}
          </div>
        )}
      </div>
    </div>
  );
}
