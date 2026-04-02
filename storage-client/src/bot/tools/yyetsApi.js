import { fetchWithBotPolicy } from "./httpFetch.js";

const YYETS_BASE = "https://yyets.click";

// way="2" means magnet link in the YYeTs API
const MAGNET_WAY = "2";

// Format preference order for quality selection (highest preferred first)
const FORMAT_PREFERENCE = ["HR-HDTV", "WEB-DL", "BDREMUX", "MP4", "RMVB", "APP"];

// ──────────────────────────────────────
// Sanitize helpers
// ──────────────────────────────────────

export function sanitizeShowName(name = "") {
  return String(name || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ──────────────────────────────────────
// API calls
// ──────────────────────────────────────

export async function searchYYeTsShows(keyword, signal) {
  const url = new URL(`${YYETS_BASE}/api/resource`);
  url.searchParams.set("keyword", String(keyword || "").trim());
  const response = await fetchWithBotPolicy(url.toString(), {
    signal,
    timeoutMs: 15_000
  });
  if (!response.ok) {
    throw new Error(`YYeTs 搜索失败：HTTP ${response.status}`);
  }
  const json = await response.json();
  const data = Array.isArray(json?.data) ? json.data : [];
  return data.slice(0, 10).map((item) => ({
    id: item.id,
    cnname: String(item.cnname || "").trim(),
    enname: String(item.enname || "").trim(),
    aliasname: String(item.aliasname || "").trim(),
    channel_cn: String(item.channel_cn || "").trim(),
    area: String(item.area || "").trim(),
    year: Array.isArray(item.year) ? item.year : []
  }));
}

export async function getYYeTsResource(resourceId, signal) {
  const url = new URL(`${YYETS_BASE}/api/resource`);
  url.searchParams.set("id", String(resourceId || ""));
  const response = await fetchWithBotPolicy(url.toString(), {
    signal,
    timeoutMs: 20_000
  });
  if (!response.ok) {
    throw new Error(`YYeTs 资源获取失败：HTTP ${response.status} (id=${resourceId})`);
  }
  const json = await response.json();
  if (!json?.data?.info) {
    throw new Error(`YYeTs 未找到资源：id=${resourceId}`);
  }
  return json.data;
}

// ──────────────────────────────────────
// Extract best magnet per episode
// ──────────────────────────────────────

/**
 * @param {object} resourceData - data field from getYYeTsResource
 * @param {object} opts
 * @param {string}   [opts.seasonNum] - filter to a specific season_num (e.g. "1", "101")
 * @param {Array}    [opts.episodes]  - filter to specific episode numbers (numbers or strings)
 * @param {number}   [opts.maxEpisodes] - cap total results (default 50)
 * @returns {Array<{season_num, season_cn, episode, name, size, magnet}>}
 */
export function extractEpisodeMagnets(resourceData, opts = {}) {
  const { seasonNum, episodes, maxEpisodes = 50 } = opts;
  const list = Array.isArray(resourceData?.list) ? resourceData.list : [];

  // Season filter
  const seasons = seasonNum
    ? list.filter((s) => String(s.season_num || "").trim() === String(seasonNum).trim())
    : list;

  const results = [];

  for (const season of seasons) {
    const items = season.items && typeof season.items === "object" ? season.items : {};

    // Collect all episode numbers across all formats
    const episodeNums = new Set();
    for (const format of Object.values(items)) {
      if (Array.isArray(format)) {
        for (const item of format) {
          if (item.episode != null) {
            episodeNums.add(String(item.episode));
          }
        }
      }
    }

    // Apply episodes filter if provided
    const episodeFilter = Array.isArray(episodes) && episodes.length
      ? new Set(episodes.map((ep) => String(ep)))
      : null;

    const targetEpisodes = episodeFilter
      ? [...episodeNums].filter((ep) => episodeFilter.has(ep))
      : [...episodeNums];

    // Natural sort: episodes like "1", "2", ..., "SP", "SP2"
    targetEpisodes.sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) {
        return na - nb;
      }
      return String(a).localeCompare(String(b), "zh-CN");
    });

    for (const ep of targetEpisodes) {
      if (results.length >= maxEpisodes) {
        break;
      }

      let bestMagnet = null;
      let bestName = "";
      let bestSize = "";
      let bestFormat = "";

      // Try formats in preference order, then remaining formats
      const allFormats = Object.keys(items);
      const orderedFormats = [
        ...FORMAT_PREFERENCE.filter((f) => allFormats.includes(f)),
        ...allFormats.filter((f) => !FORMAT_PREFERENCE.includes(f))
      ];

      for (const fmt of orderedFormats) {
        const fmtItems = Array.isArray(items[fmt]) ? items[fmt] : [];
        const matching = fmtItems.filter((item) => String(item.episode) === ep);
        for (const item of matching) {
          const magnetFile = Array.isArray(item.files)
            ? item.files.find((f) => String(f.way) === MAGNET_WAY && f.address)
            : null;
          if (magnetFile?.address) {
            bestMagnet = magnetFile.address;
            bestName = String(item.name || "").trim();
            bestSize = String(item.size || "").trim();
            bestFormat = fmt;
            break;
          }
        }
        if (bestMagnet) {
          break;
        }
      }

      if (bestMagnet) {
        results.push({
          season_num: String(season.season_num || ""),
          season_cn: String(season.season_cn || ""),
          episode: ep,
          name: bestName,
          size: bestSize,
          format: bestFormat,
          magnet: bestMagnet
        });
      }
    }
  }

  return results;
}
