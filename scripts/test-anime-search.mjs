// Test script for anime search logic
// Run with: node scripts/test-anime-search.mjs

function stripSeason(title) {
  return title
    .replace(/\s*第[一二三四五六七八九十百\d]+[季期]\s*$/, "")
    .replace(/\s*Season\s*\d+\s*$/i, "")
    .replace(/\s*第\d+期\s*$/, "")
    .trim();
}

function normTitle(s) {
  return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function titleScore(cmsTitle, expected) {
  const a = normTitle(cmsTitle), b = normTitle(expected);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 80;
  const setA = new Set([...a]);
  const common = [...b].filter(c => setA.has(c)).length;
  return Math.floor(common / b.length * 60);
}

function pickBestHit(hits, fullName) {
  if (!hits.length) return null;
  const stripped = stripSeason(fullName);
  let best = null, bestScore = -1;
  for (const h of hits) {
    const s = Math.max(titleScore(h.vod_name, fullName), titleScore(h.vod_name, stripped));
    if (s > bestScore) { bestScore = s; best = h; }
  }
  console.log(`  best score: ${bestScore}, winner: ${best?.vod_name}`);
  return bestScore >= 40 ? best : null;
}

function parseAllRoutes(vodPlayUrl, vodPlayFrom) {
  if (!vodPlayUrl) return [];
  const routes = [];
  const urlRoutes = vodPlayUrl.split("$$$");
  const fromRoutes = vodPlayFrom ? vodPlayFrom.split("$$$") : [];
  urlRoutes.forEach((routeStr, ri) => {
    const routeName = fromRoutes[ri]?.trim() || `线路${ri + 1}`;
    const eps = routeStr.split("|");
    const episodes = [];
    eps.forEach((epEntry, ei) => {
      if (!epEntry.trim()) return;
      const parts = epEntry.split("$");
      const url = parts[parts.length - 1]?.trim();
      if (url && /^https?:\/\//i.test(url)) {
        const type = /\.(mp4|flv|mkv)(\?|$)/i.test(url) ? "mp4" : "hls";
        const playUrl = `/api/tv/stream?url=${encodeURIComponent(url)}`;
        episodes.push({ ep: ei + 1, url, playUrl, type });
      }
    });
    if (episodes.length > 0) routes.push({ route: routeName, episodes });
  });
  return routes;
}

// ── Tests ──────────────────────────────────────────────────────────────────

console.log("=== stripSeason ===");
console.log(stripSeason("葬送的芙莉蓮 第二季"), "-> expect: 葬送的芙莉蓮");
console.log(stripSeason("进击的巨人 第三季"), "-> expect: 进击的巨人");
console.log(stripSeason("鬼灭之刃 第三期"), "-> expect: 鬼灭之刃");
console.log(stripSeason("进击的巨人"), "-> expect: 进击的巨人");

console.log("\n=== titleScore ===");
console.log(titleScore("葬送的芙莉蓮第二季", "葬送的芙莉蓮"), "-> expect ≥80");
console.log(titleScore("葬送的芙莉莲", "葬送的芙莉蓮"), "-> expect ~60 (variant chars 莲 vs 蓮)");
console.log(titleScore("进击的巨人最终季", "进击的巨人"), "-> expect ≥80");
console.log(titleScore("完全不相关的动漫标题", "葬送的芙莉蓮"), "-> expect <40");
console.log(titleScore("葬送的芙莉蓮", "葬送的芙莉蓮 第二季"), "-> expect ≥80 (reverse match)");

console.log("\n=== pickBestHit ===");
const mockHits = [
  { vod_id: 1, vod_name: "葬送的芙莉蓮第一季" },
  { vod_id: 2, vod_name: "葬送的芙莉蓮第二季" },
  { vod_id: 3, vod_name: "完全不同的动漫" },
];
const hit = pickBestHit(mockHits, "葬送的芙莉蓮 第二季");
console.log("Best hit:", hit?.vod_name, "-> expect: 葬送的芙莉蓮第二季");

// Test with only S1 available (common case where S2 doesn't exist separately)
console.log("\n=== pickBestHit (only S1 in CMS) ===");
const hits2 = [
  { vod_id: 1, vod_name: "葬送的芙莉蓮" },  // CMS has full series as single entry
];
const hit2 = pickBestHit(hits2, "葬送的芙莉蓮 第二季");
console.log("Best hit:", hit2?.vod_name, "-> expect: 葬送的芙莉蓮 (single series entry)");

console.log("\n=== parseAllRoutes ===");
const mockVodUrl = [
  "第01集$https://cdn1.example.com/ep1.m3u8",
  "第02集$https://cdn1.example.com/ep2.m3u8",
  "第13集$https://cdn1.example.com/ep13.m3u8",
].join("|") + "$$$" + [
  "第01集$https://cdn2.example.com/ep1.mp4",
  "第02集$https://cdn2.example.com/ep2.mp4",
].join("|");
const mockVodFrom = "dyttm3u8$$$modum3u8";
const routes = parseAllRoutes(mockVodUrl, mockVodFrom);
console.log("Routes:", routes.length, "-> expect: 2");
routes.forEach(r => {
  console.log(`  ${r.route}: ${r.episodes.length} eps, first type: ${r.episodes[0].type}`);
});

// Test tryResolveEpisodeUrl
function tryResolveEpisodeUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    // If the path itself is a direct video file, return as-is
    if (/\.(m3u8|mp4|flv|ts|mkv)(\/|$)/i.test(path)) return url;
    // Check if it looks like a player/VIP wrapper URL
    const looksLikePlayer = /\/(jx|player|vip|play)\b/i.test(path)
      || /^(jx|vip)\./i.test(u.hostname)
      || u.search.includes("url=")
      || u.search.includes("&v=") || u.search.startsWith("?v=");
    if (!looksLikePlayer) return url;
    for (const p of ["url", "v", "src", "video", "link", "play"]) {
      const val = u.searchParams.get(p);
      if (!val) continue;
      let decoded = val;
      try { decoded = decodeURIComponent(val); } catch {}
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }
  } catch {}
  return url;
}

console.log("\n=== tryResolveEpisodeUrl ===");
// Case 1: VIP player with url= param
const vipUrl1 = "https://jx.aidouer.net/?url=https://cdn.example.com/video.m3u8";
console.log(tryResolveEpisodeUrl(vipUrl1), "-> expect: https://cdn.example.com/video.m3u8");

// Case 2: Direct stream URL (should not be modified)
const directUrl = "https://cdn.example.com/video.m3u8";
console.log(tryResolveEpisodeUrl(directUrl), "-> expect unchanged");

// Case 3: Player URL with v= param
const vipUrl2 = "https://player.videocc.net/blended-player/player.html?v=https://cdn.qq.com/ep1.mp4";
console.log(tryResolveEpisodeUrl(vipUrl2), "-> expect: https://cdn.qq.com/ep1.mp4");

// Case 4: Direct mp4 URL (should not be modified)
const mp4url = "https://video.cdn.com/path/ep1.mp4?token=abc";
console.log(tryResolveEpisodeUrl(mp4url), "-> expect unchanged");

// Case 5: Player URL without extractable URL
const vipUrl3 = "https://jx.some-player.com/?code=abc123&type=hls";
console.log(tryResolveEpisodeUrl(vipUrl3), "-> expect unchanged (no direct URL)");


const CMS_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json, text/plain, */*",
};

async function testSite(base, name, keyword) {
  try {
    const url = `${base}/api.php/provide/vod/?ac=videolist&wd=${encodeURIComponent(keyword)}`;
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { ...CMS_HEADERS, Referer: base }
    });
    if (!r.ok) { console.log(`  [${name}] HTTP ${r.status}`); return; }
    const data = await r.json();
    const hits = data?.list ?? [];
    if (hits.length) {
      console.log(`  [HIT] ${name}: ${hits.slice(0,3).map(h => h.vod_name).join(", ")}`);
      // Check best hit
      const best = pickBestHit(hits, "葬送的芙莉蓮 第二季");
      if (best) {
        // Fetch detail
        const dUrl = `${base}/api.php/provide/vod/?ac=detail&ids=${best.vod_id}`;
        const dr = await fetch(dUrl, { signal: AbortSignal.timeout(5000), headers: { ...CMS_HEADERS, Referer: base } });
        const dd = await dr.json();
        const d = dd?.list?.[0];
        if (d?.vod_play_url) {
          const allRoutes = parseAllRoutes(d.vod_play_url, d.vod_play_from);
          console.log(`  [DETAIL] "${d.vod_name}": ${allRoutes.map(r => `${r.route}(${r.episodes.length}ep)`).join(", ")}`);
        }
      }
    } else {
      console.log(`  [MISS] ${name}: 0 results`);
    }
  } catch(e) {
    console.log(`  [ERR] ${name}: ${e.message.slice(0, 60)}`);
  }
}

const SITES = [
  ["https://m.xyku.com", "新优酷"],
  ["https://www.hongniuzy2.com", "红牛资源"],
  ["https://www.qiqidm.com", "奇奇动漫"],
  ["https://www.yhdm.tv", "樱花动漫"],
  ["https://www.qianfanzyw.com", "千帆资源"],
  ["https://api.jyzyapi.com", "精英资源"],
  ["https://www.manavod.com", "Mana资源"],
];

Promise.all(SITES.map(([base, name]) => testSite(base, name, "葬送的芙莉蓮")))
  .then(() => console.log("\nDone!"));
