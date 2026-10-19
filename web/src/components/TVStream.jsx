import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { getMediaToken } from "../media/streamToken";
import { EquipmentVisual } from "../ui/OperationsDisplay";
import { Spinner } from "@fluentui/react-components";
import {
  AddRegular,
  ChevronLeftRegular,
  ChevronRightRegular,
  DeleteRegular,
} from "@fluentui/react-icons";

// ─── LocalStorage fallback cache ───────────────────────────
const TV_SOURCES_KEY = "tv_sources_v2";
const TV_ACTIVE_SOURCE_KEY = "tv_active_source";

// Channel list the server builds from community playlists and re-checks every few hours
const BUILTIN_SOURCE = { id: "builtin", label: "社区精选（自动更新）", builtin: true };

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

// Same name in the same group = one channel with several lines to fall back between
function mergeLines(flat) {
  const map = new Map();
  for (const c of flat) {
    const key = `${c.group}::${c.name}`;
    if (!map.has(key)) map.set(key, { ...c, key, lines: [] });
    map.get(key).lines.push({ url: c.url });
  }
  return [...map.values()];
}

function parsePlaylist(text) {
  const channels = mergeLines(text.includes("#EXTINF") ? parseM3U(text) : parseTxt(text));
  const groups = [...new Set(channels.map((c) => c.group))];
  return { channels, groups };
}

// Ordered ways to play a channel. https lines play straight from the source; http lines
// (blocked as mixed content) and lines without CORS go through /api/tv/stream, which
// costs bandwidth on the public server, so they come after direct attempts of the same line.
// `direct` is known for built-in lines (the server checked them); user lines try both.
function buildAttempts(channel) {
  if (!channel) return [];
  const attempts = [];
  channel.lines.forEach((line, lineIdx) => {
    if (!/^https?:\/\//i.test(line.url)) return;
    const https = line.url.startsWith("https:");
    if (https && line.direct !== false) attempts.push({ url: line.url, lineIdx, proxy: false });
    if (!https || line.direct !== true) attempts.push({ url: line.url, lineIdx, proxy: true });
  });
  return attempts;
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
  const [attemptIdx, setAttemptIdx] = useState(0);
  const [builtinMeta, setBuiltinMeta] = useState(null); // { updatedAt, channelCount }
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
          applySource(rememberedSource(serverSources));
          return;
        }
      } catch {}
      const cached = cacheLoad();
      setSources(cached);
      applySource(rememberedSource(cached));
    }
    loadHistory();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function rememberedSource(list) {
    let id = null;
    try { id = localStorage.getItem(TV_ACTIVE_SOURCE_KEY); } catch {}
    return list.find((s) => s.id === id) || BUILTIN_SOURCE;
  }

  function selectChannel(channel) {
    setSelectedChannel(channel);
    setAttemptIdx(0);
  }

  // ── Sidebar auto-collapse/expand + track failed channels ──
  useEffect(() => {
    if (playState === "playing") setSidebarCollapsed(true);
    else if (playState !== "loading") setSidebarCollapsed(false);
    if (playState === "error" && selectedChannel) {
      setFailedChannels((prev) => new Set([...prev, selectedChannel.key]));
    }
  }, [playState]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── HLS / native video player ──
  // Plays attempts[attemptIdx]; on error or a 12s stall it moves to the next attempt,
  // and only shows the error state once every line of the channel has failed.
  const attempts = useMemo(() => buildAttempts(selectedChannel), [selectedChannel]);
  const currentAttempt = attempts[attemptIdx] ?? null;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !selectedChannel) return;
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    const attempt = attempts[attemptIdx];
    if (!attempt) {
      setPlayState("error");
      return;
    }
    setPlayState("loading");
    let done = false;
    const fail = () => {
      if (done) return;
      done = true;
      if (attemptIdx + 1 < attempts.length) setAttemptIdx(attemptIdx + 1);
      else setPlayState("error");
    };
    const stallTimer = setTimeout(fail, 12_000);
    const onPlaying = () => clearTimeout(stallTimer);
    video.addEventListener("playing", onPlaying);

    (async () => {
      let src = attempt.url;
      if (attempt.proxy) {
        const st = await getMediaToken(authToken).catch(() => null);
        if (!st) return fail();
        src = `/api/tv/stream?url=${encodeURIComponent(attempt.url)}&st=${encodeURIComponent(st)}`;
      }
      if (done) return;
      const looksLikeHls = /m3u8/i.test(attempt.url);
      if (looksLikeHls && Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1 });
        hlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => setPlayState("paused")); });
        hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) fail(); });
      } else {
        // Safari native HLS, or a non-HLS stream (FLV, MP4, TS, etc.)
        video.onerror = fail;
        video.src = src;
        video.play().catch(() => setPlayState("paused"));
      }
    })();

    return () => {
      done = true;
      clearTimeout(stallTimer);
      video.removeEventListener("playing", onPlaying);
      video.onerror = null;
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      video.removeAttribute("src");
    };
  }, [selectedChannel, attemptIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  function switchLine() {
    if (!currentAttempt) return;
    const next = attempts.findIndex((a, i) => i > attemptIdx && a.lineIdx !== currentAttempt.lineIdx);
    setAttemptIdx(next >= 0 ? next : 0);
  }

  // Cleanup HLS on unmount
  useEffect(() => {
    return () => { if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; } };
  }, []);

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
    setBuiltinMeta(null);
    try { localStorage.setItem(TV_ACTIVE_SOURCE_KEY, source.id); } catch {}
    try {
      if (source.builtin) {
        const res = await fetch("/api/tv/builtin", { headers: { Authorization: `Bearer ${authToken}` } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setMessage?.(data.error || "社区直播源加载失败", "error");
          return;
        }
        setChannels(data.channels);
        setGroups(data.groups);
        setExpandedGroups(new Set(data.groups.slice(0, 2)));
        setBuiltinMeta({ updatedAt: data.updatedAt, channelCount: data.channels.length });
        return;
      }
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
      applySource(next[0] ?? BUILTIN_SOURCE);
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
    <section className="workspacePage tvWorkspacePage"><header className="moduleHeading"><div><span className="industrialEyebrow">07 / LIVE SIGNAL</span><h2>TV 直播</h2><p>选择信号，打开你的实时视界。</p></div><span className="monoLabel">LIVE BROADCAST TERMINAL</span></header>
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
                    const src = e.target.value === BUILTIN_SOURCE.id
                      ? BUILTIN_SOURCE
                      : sources.find((s) => s.id === e.target.value);
                    if (src) applySource(src);
                  }}
                  disabled={fetchingPlaylist || loadingHistory}
                >
                  <option value={BUILTIN_SOURCE.id}>{BUILTIN_SOURCE.label}</option>
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
                {activeSourceId && activeSourceId !== BUILTIN_SOURCE.id && (
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

              {builtinMeta && !fetchingPlaylist && (
                <div className="tvFetchingBar" title="来源：vbskycn/iptv、Guovin/iptv-api、fanmingming/live、iptv-org">
                  <span>{builtinMeta.channelCount} 个频道 · 服务器每 6 小时重新检测，更新于 {new Date(builtinMeta.updatedAt).toLocaleString()}</span>
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
                            key={channel.key}
                            type="button"
                            className={[
                              "tvChannelItem",
                              selectedChannel?.key === channel.key ? "tvChannelItemActive" : "",
                              failedChannels.has(channel.key) ? "tvChannelItemFailed" : "",
                            ].filter(Boolean).join(" ")}
                            onClick={() => selectChannel(channel)}
                            title={failedChannels.has(channel.key) ? `${channel.name}（上次所有线路都失败了，可再试）` : channel.name}
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
                            {channel.lines.length > 1 && <span className="tvGroupCount">{channel.lines.length}</span>}
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
            <EquipmentVisual kind="media" className="tvStandbyArtwork"/>
            <span>选择频道开始观看</span>
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
              onEnded={() => setPlayState("idle")}
            />
            {playState === "loading" && (
              <div className="tvOverlay">
                <Spinner size="large" label="加载中…" />
              </div>
            )}
            {playState === "error" && (
              <div className="tvOverlay tvOverlayError">
                <span>{selectedChannel.lines.length > 1 ? `${selectedChannel.lines.length} 条线路都无法播放，请换个频道` : "加载失败，请尝试其他频道"}</span>
              </div>
            )}
          </div>
        )}
        {selectedChannel && (
          <div className="tvNowPlaying">
            <span className="tvNowPlayingName">{selectedChannel.name}</span>
            {playState === "playing" && <span className="tvLiveBadge">LIVE</span>}
            {currentAttempt && selectedChannel.lines.length > 1 && (
              <button type="button" className="tvBtn" onClick={switchLine} title={currentAttempt.proxy ? "经服务器中转" : "直连"}>
                线路 {currentAttempt.lineIdx + 1}/{selectedChannel.lines.length} · 换线路
              </button>
            )}
          </div>
        )}
      </div>
    </div>
    </section>
  );
}
