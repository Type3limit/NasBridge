// Built-in TV channel list made from community-maintained IPTV playlists.
// Each feed is refreshed on a timer, every line is health-checked from the server,
// and channels with the same name are merged so the player can fall back between lines.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { dataDir } from "./db.js";

const cachePath = path.join(dataDir, "tv-feeds.json");
const REFRESH_MS = Math.max(1, Number(process.env.TV_FEED_REFRESH_HOURS) || 6) * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 6_000;
const PROBE_CONCURRENCY = 24;
const MAX_LINES_PER_CHANNEL = 8;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// raw.githubusercontent.com is unreliable from mainland servers, so each GitHub file
// also lists jsDelivr and gh-proxy mirrors. The first one that returns channels wins.
function github(repo, branch, file) {
  const raw = `https://raw.githubusercontent.com/${repo}/${branch}/${file}`;
  return [raw, `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${file}`, `https://gh-proxy.com/${raw}`];
}

const DEFAULT_FEEDS = [
  { id: "vbskycn", label: "vbskycn/iptv", urls: ["https://live.zbds.top/tv/iptv4.m3u", ...github("vbskycn/iptv", "master", "tv/iptv4.m3u")] },
  { id: "guovin", label: "Guovin/iptv-api", urls: github("Guovin/iptv-api", "gd", "output/result.m3u") },
  { id: "fanmingming", label: "fanmingming/live", urls: github("fanmingming/live", "main", "tv/m3u/ipv6.m3u") },
  { id: "iptv-org", label: "iptv-org/iptv", urls: ["https://iptv-org.github.io/iptv/countries/cn.m3u"] },
];

// TV_FEED_URLS="名称|https://a.m3u,名称2|https://b.txt" replaces the default list.
function configuredFeeds() {
  const raw = String(process.env.TV_FEED_URLS || "").trim();
  if (!raw) {
    return DEFAULT_FEEDS;
  }
  return raw.split(",").map((item, index) => {
    const [label, url] = item.includes("|") ? item.split("|") : [`feed-${index + 1}`, item];
    return { id: `custom-${index + 1}`, label: label.trim(), urls: [url.trim()] };
  }).filter((feed) => /^https?:\/\//i.test(feed.urls[0]));
}

function parseM3u(text) {
  const channels = [];
  let pending = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    if (t.startsWith("#EXTINF")) {
      pending = {
        name: (t.match(/,([^,]+)$/)?.[1] || "").trim(),
        group: (t.match(/group-title="([^"]*)"/)?.[1] || "").trim(),
        logo: (t.match(/tvg-logo="([^"]*)"/)?.[1] || "").trim(),
      };
    } else if (pending && !t.startsWith("#")) {
      channels.push({ ...pending, url: t });
      pending = null;
    }
  }
  return channels;
}

function parseTxt(text) {
  const channels = [];
  let group = "";
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    const comma = t.indexOf(",");
    if (!t || t.startsWith("#") || comma < 0) {
      continue;
    }
    const left = t.slice(0, comma).trim();
    const right = t.slice(comma + 1).trim();
    if (right === "#genre#") {
      group = left;
    } else {
      // "url1#url2" is a common way to list backup lines in TXT feeds
      for (const url of right.split("#")) {
        if (/^https?:\/\//i.test(url)) {
          channels.push({ name: left, group, logo: "", url });
        }
      }
    }
  }
  return channels;
}

// "CCTV-1 综合", "CCTV1高清" and "CCTV1" are the same channel.
function channelKey(name) {
  const upper = String(name || "").toUpperCase().replace(/[\s\-_·]/g, "");
  const cctv = upper.match(/^CCTV(\d{1,2}\+?|5\+)/);
  if (cctv) {
    return `CCTV${cctv[1]}`;
  }
  return upper.replace(/(超高清|高清|标清|超清|FHD|UHD|HD|SD|4K|频道|\(.*?\)|（.*?）|\[.*?\])+$/g, "") || upper;
}

// Strip decorative emoji from group names ("📡卫视频道" → "卫视频道").
function cleanGroup(group) {
  return String(group || "").replace(/^[^\p{L}\p{N}]+/u, "").trim() || "其他";
}

function isMetaChannel(channel) {
  return /更新时间|update/i.test(channel.group) || /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(channel.name);
}

async function fetchFeed(feed) {
  let lastError = "no url";
  for (const url of feed.urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": UA } });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const text = await response.text();
      const channels = (text.includes("#EXTINF") ? parseM3u(text) : parseTxt(text))
        .filter((channel) => channel.name && /^https?:\/\//i.test(channel.url) && !isMetaChannel(channel));
      if (channels.length > 0) {
        return { channels, from: url };
      }
      lastError = "no channels";
    } catch (error) {
      lastError = error.message;
    }
  }
  throw new Error(lastError);
}

// A line is usable when it answers with a playlist or a media stream. `direct` means a
// browser can load it without our proxy: https (no mixed content) plus CORS for hls.js.
async function probeLine(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "User-Agent": UA, Origin: "https://nas-bridge.invalid" },
    });
    const type = (response.headers.get("content-type") || "").toLowerCase();
    let ok = response.ok;
    if (ok) {
      // Read only the first chunk: live FLV/TS lines never end.
      const reader = response.body.getReader();
      const { value } = await reader.read();
      reader.cancel().catch(() => {});
      const head = Buffer.from(value || []).subarray(0, 16).toString("utf8");
      ok = head.startsWith("#EXTM3U") || /video|mp2t|flv|octet-stream/.test(type);
    }
    const cors = Boolean(response.headers.get("access-control-allow-origin"));
    return { ok, direct: ok && cors && response.url.startsWith("https:"), ms: Date.now() - started };
  } catch {
    return { ok: false, direct: false, ms: Date.now() - started };
  }
}

async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

let state = loadCache();
let refreshing = null;

function loadCache() {
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    return { ...data, gzip: zlib.gzipSync(JSON.stringify(publicView(data))) };
  } catch {
    return null;
  }
}

function publicView(data) {
  return { updatedAt: data.updatedAt, feeds: data.feeds, groups: data.groups, channels: data.channels };
}

async function buildChannelList() {
  const feeds = configuredFeeds();
  const feedReports = [];
  const merged = new Map();
  for (const feed of feeds) {
    try {
      const { channels, from } = await fetchFeed(feed);
      feedReports.push({ id: feed.id, label: feed.label, from, channelCount: channels.length });
      for (const channel of channels) {
        const key = channelKey(channel.name);
        if (!merged.has(key)) {
          merged.set(key, { key, name: channel.name, group: cleanGroup(channel.group), logo: channel.logo, lines: [] });
        }
        const entry = merged.get(key);
        if (!entry.logo && channel.logo) {
          entry.logo = channel.logo;
        }
        if (!entry.lines.some((line) => line.url === channel.url)) {
          entry.lines.push({ url: channel.url, feed: feed.id });
        }
      }
    } catch (error) {
      feedReports.push({ id: feed.id, label: feed.label, error: error.message, channelCount: 0 });
    }
  }

  const allLines = [...merged.values()].flatMap((channel) => channel.lines);
  const probes = await mapWithLimit(allLines, PROBE_CONCURRENCY, (line) => probeLine(line.url));
  allLines.forEach((line, index) => Object.assign(line, probes[index]));

  // Keep working lines only, best first: direct (no server bandwidth) before proxied, then faster.
  const channels = [];
  for (const channel of merged.values()) {
    const lines = channel.lines
      .filter((line) => line.ok)
      .sort((a, b) => (b.direct - a.direct) || (a.ms - b.ms))
      .slice(0, MAX_LINES_PER_CHANNEL)
      .map(({ url, direct, ms, feed }) => ({ url, direct, ms, feed }));
    if (lines.length > 0) {
      channels.push({ ...channel, lines });
    }
  }
  const groups = [...new Set(channels.map((channel) => channel.group))];
  return {
    updatedAt: new Date().toISOString(),
    feeds: feedReports,
    groups,
    channels,
    stats: { probedLines: allLines.length, aliveLines: probes.filter((p) => p.ok).length },
  };
}

export function refreshTvFeeds() {
  if (!refreshing) {
    const started = Date.now();
    refreshing = buildChannelList()
      .then((data) => {
        if (data.channels.length === 0 && state) {
          console.warn("[tv-feeds] refresh found no working channels, keeping previous list");
          return state;
        }
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(data), "utf-8");
        state = { ...data, gzip: zlib.gzipSync(JSON.stringify(publicView(data))) };
        console.log(`[tv-feeds] ${data.channels.length} channels, ${data.stats.aliveLines}/${data.stats.probedLines} lines alive (${Math.round((Date.now() - started) / 1000)}s)`);
        return state;
      })
      .catch((error) => {
        console.warn(`[tv-feeds] refresh failed: ${error.message}`);
        return state;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export function startTvFeedRefresher() {
  const age = state ? Date.now() - Date.parse(state.updatedAt) : Infinity;
  setTimeout(refreshTvFeeds, age > REFRESH_MS ? 10_000 : REFRESH_MS - age).unref();
  setInterval(refreshTvFeeds, REFRESH_MS).unref();
}

// Sends the cached list, gzipped when the browser accepts it (about 5x smaller, which
// matters on the 2 Mbps public server).
export async function sendTvFeeds(req, res) {
  const current = state || await refreshTvFeeds();
  if (!current) {
    return res.status(503).json({ error: "直播源正在首次更新，请稍后再试" });
  }
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    return res.end(current.gzip);
  }
  return res.json(publicView(current));
}

export function tvFeedStatus() {
  return {
    updatedAt: state?.updatedAt || null,
    refreshing: Boolean(refreshing),
    feeds: state?.feeds || [],
    stats: state?.stats || null,
  };
}
