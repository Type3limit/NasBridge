import { launchPlaywrightBrowser } from "./playwright.js";

const DEFAULT_USER_AGENT = "NAS-Bot/1.0 (+https://local.nas)";
const DEFAULT_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.7";
const DEFAULT_TIMEOUT_MS = 12_000;
const DDG_SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const BING_SEARCH_ENDPOINT = "https://www.bing.com/search";
const METASO_SEARCH_HOME = "https://metaso.cn/";
const VERIFICATION_REQUIRED_ERROR_PREFIX = "BOT_VERIFICATION_REQUIRED::";
const WEB_SEARCH_BACKEND = String(process.env.BOT_WEB_SEARCH_BACKEND || "auto").trim().toLowerCase();
const WEB_SEARCH_PROVIDER = String(process.env.BOT_WEB_SEARCH_PROVIDER || "auto").trim().toLowerCase();
const WEB_SEARCH_API_BACKEND = String(process.env.BOT_WEB_SEARCH_API_BACKEND || "").trim().toLowerCase();
const WEB_SEARCH_API_KEY = String(process.env.BOT_WEB_SEARCH_API_KEY || "").trim();
const WEB_SEARCH_API_BASE_URL = String(process.env.BOT_WEB_SEARCH_API_BASE_URL || "").trim();

const SOURCE_PREFERENCE_ALIASES = {
  official: ["official", "官网", "官方", "official-site", "site"],
  github: ["github", "gh"],
  docs: ["docs", "doc", "documentation", "文档", "手册"],
  news: ["news", "新闻", "资讯", "最新"]
};

function normalizeBackend(value = "") {
  const normalized = String(value || WEB_SEARCH_BACKEND || "auto").trim().toLowerCase();
  if (["playwright", "fetch", "api", "auto"].includes(normalized)) {
    return normalized;
  }
  return "auto";
}

function normalizeSearchProvider(value = "") {
  const normalized = String(value || WEB_SEARCH_PROVIDER || "auto").trim().toLowerCase();
  if (["auto", "builtin", "metaso"].includes(normalized)) {
    return normalized;
  }
  return "auto";
}

function normalizeSearchApiBackend(value = "") {
  const normalized = String(value || WEB_SEARCH_API_BACKEND || "").trim().toLowerCase();
  if (["brave"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function normalizeWhitespace(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripHtml(value = "") {
  return normalizeWhitespace(decodeHtmlEntities(String(value || "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")));
}

function isPrivateIpv4(hostname = "") {
  const matched = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(hostname || ""));
  if (!matched) {
    return false;
  }
  const parts = matched.slice(1).map((item) => Number(item));
  if (parts.some((item) => item < 0 || item > 255)) {
    return true;
  }
  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) {
    return true;
  }
  if (parts[0] === 192 && parts[1] === 168) {
    return true;
  }
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }
  if (parts[0] === 169 && parts[1] === 254) {
    return true;
  }
  return false;
}

function isBlockedHostname(hostname = "") {
  const value = String(hostname || "").trim().toLowerCase();
  if (!value) {
    return true;
  }
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(value)) {
    return true;
  }
  if (value.endsWith(".local") || value.endsWith(".internal")) {
    return true;
  }
  if (value.startsWith("[") && value.includes(":")) {
    return /\[::1\]|\[fc|\[fd/i.test(value);
  }
  return isPrivateIpv4(value);
}

function assertAllowedUrl(rawUrl = "") {
  let parsed = null;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    throw new Error(`invalid url: ${rawUrl}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`unsupported protocol: ${parsed.protocol}`);
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error(`blocked host: ${parsed.hostname}`);
  }
  return parsed;
}

function withTimeout(signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (signal?.aborted) {
    return signal;
  }
  const timeoutSignal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
    : null;
  if (!signal) {
    return timeoutSignal || undefined;
  }
  if (!timeoutSignal || typeof AbortSignal === "undefined" || typeof AbortSignal.any !== "function") {
    return signal;
  }
  return AbortSignal.any([signal, timeoutSignal]);
}

function getRequestHeaders(extraHeaders = {}) {
  return {
    "User-Agent": DEFAULT_USER_AGENT,
    "Accept-Language": DEFAULT_ACCEPT_LANGUAGE,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
    ...extraHeaders
  };
}

function readSearchEndpoints() {
  const configured = String(process.env.BOT_WEB_SEARCH_ENDPOINTS || process.env.BOT_WEB_SEARCH_ENDPOINT || "").trim();
  const configuredList = configured
    .split(",")
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (configuredList.length) {
    return configuredList;
  }
  return [DDG_SEARCH_ENDPOINT, BING_SEARCH_ENDPOINT];
}

function getSearchApiConfig() {
  const backend = normalizeSearchApiBackend();
  if (!backend || !WEB_SEARCH_API_KEY) {
    return null;
  }
  if (backend === "brave") {
    return {
      backend,
      apiKey: WEB_SEARCH_API_KEY,
      baseUrl: WEB_SEARCH_API_BASE_URL || "https://api.search.brave.com"
    };
  }
  return null;
}

function hasSearchApiBackend() {
  return Boolean(getSearchApiConfig());
}

export function normalizeSourcePreference(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  for (const [key, aliases] of Object.entries(SOURCE_PREFERENCE_ALIASES)) {
    if (aliases.includes(normalized)) {
      return key;
    }
  }
  return "";
}

export function getSourcePreferenceLabel(value = "") {
  const normalized = normalizeSourcePreference(value);
  if (normalized === "official") {
    return "官网优先";
  }
  if (normalized === "github") {
    return "GitHub 优先";
  }
  if (normalized === "docs") {
    return "文档站优先";
  }
  if (normalized === "news") {
    return "新闻站优先";
  }
  return "默认";
}

function getPreferenceQueryHints(preference = "") {
  const normalized = normalizeSourcePreference(preference);
  if (normalized === "official") {
    return ["官网", "official site"];
  }
  if (normalized === "github") {
    return ["site:github.com", "GitHub"];
  }
  if (normalized === "docs") {
    return ["文档", "documentation"];
  }
  if (normalized === "news") {
    return ["新闻", "最新"];
  }
  return [];
}

function buildSearchQueryVariants(query = "", preference = "") {
  const base = normalizeWhitespace(query);
  const variants = [base];
  for (const hint of getPreferenceQueryHints(preference)) {
    variants.push(normalizeWhitespace(`${base} ${hint}`));
  }
  return [...new Set(variants.filter(Boolean))];
}

function inferSourceType(url = "", title = "", snippet = "") {
  const combined = `${url} ${title} ${snippet}`.toLowerCase();
  if (combined.includes("github.com")) {
    return "github";
  }
  if (/(docs\.|documentation|readthedocs|developer|manual|guide|文档|手册)/i.test(combined)) {
    return "docs";
  }
  if (/(news|新闻|资讯|blog|press|媒体|headline)/i.test(combined)) {
    return "news";
  }
  if (/(official|官网|官方|\.org|\.io|\.dev)/i.test(combined)) {
    return "official";
  }
  return "generic";
}

function scoreSearchResult(result = {}, preference = "") {
  const inferred = inferSourceType(result.url, result.title, result.snippet);
  let score = 0;
  const normalizedPreference = normalizeSourcePreference(preference);
  if (normalizedPreference && inferred === normalizedPreference) {
    score += 12;
  }
  if (inferred === "official") {
    score += 4;
  }
  if (String(result.url || "").startsWith("https://")) {
    score += 2;
  }
  if (String(result.title || "").length > 10) {
    score += 1;
  }
  return score;
}

function parseDuckDuckGoResults(html = "", limit = 5) {
  const results = [];
  const anchorRegex = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let matched = null;
  while ((matched = anchorRegex.exec(html)) && results.length < limit) {
    const url = resolveSearchResultUrl(matched[1] || "");
    const title = stripHtml(matched[2] || "");
    if (!url || !title) {
      continue;
    }
    const contextHtml = html.slice(Math.max(0, matched.index - 260), Math.min(html.length, matched.index + 1200));
    const snippetMatch = contextHtml.match(/<(?:a|div)[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    const snippet = stripHtml(snippetMatch?.[1] || "");
    results.push({ title, url, snippet });
  }
  return results;
}

function parseBingResults(html = "", limit = 5) {
  const results = [];
  const blockRegex = /<li[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let matched = null;
  while ((matched = blockRegex.exec(html)) && results.length < limit) {
    const block = matched[1] || "";
    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
    const url = resolveSearchResultUrl(titleMatch?.[1] || "");
    const title = stripHtml(titleMatch?.[2] || "");
    if (!url || !title) {
      continue;
    }
    const snippetMatch = block.match(/<div[^>]*class=["'][^"']*b_caption[^"']*["'][^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = stripHtml(snippetMatch?.[1] || "");
    results.push({ title, url, snippet });
  }
  return results;
}

function pickSearchParser(endpoint = "") {
  const hostname = (() => {
    try {
      return new URL(endpoint).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (hostname.includes("duckduckgo")) {
    return parseDuckDuckGoResults;
  }
  if (hostname.includes("bing.com")) {
    return parseBingResults;
  }
  return parseDuckDuckGoResults;
}

function isSearchEngineInternalUrl(url = "", currentHostname = "") {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const href = parsed.toString().toLowerCase();
    if (currentHostname.includes("duckduckgo")) {
      if (hostname.includes("duckduckgo.com") || hostname === "duck.ai" || hostname.endsWith(".duck.ai")) {
        return true;
      }
      if (hostname === "play.google.com" && (pathname.includes("duckduckgo") || href.includes("duckduckgo"))) {
        return true;
      }
    }
    if (currentHostname.includes("bing.com")) {
      if (hostname.includes("bing.com")) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

function isSearchChallengePage(title = "", bodyText = "") {
  const combined = `${String(title || "")} ${String(bodyText || "")}`.toLowerCase();
  return [
    "please complete the following challenge",
    "bots use duckduckgo too",
    "select all squares containing a duck",
    "请解决以下难题以继续",
    "验证你是真人",
    "unusual traffic"
  ].some((item) => combined.includes(item));
}

function normalizeSearchResultShape(results = [], limit = 5, currentHostname = "") {
  const seen = new Set();
  const normalized = [];
  for (const item of Array.isArray(results) ? results : []) {
    const title = normalizeWhitespace(item?.title || item?.name || "");
    const rawUrl = String(item?.url || item?.href || "").trim();
    const url = resolveSearchResultUrl(rawUrl);
    const snippet = normalizeWhitespace(item?.snippet || item?.description || item?.body || "");
    if (!title || !url || seen.has(url)) {
      continue;
    }
    try {
      const parsed = assertAllowedUrl(url);
      if (currentHostname && parsed.hostname.toLowerCase().includes(currentHostname)) {
        continue;
      }
    } catch {
      continue;
    }
    if (isSearchEngineInternalUrl(url, currentHostname)) {
      continue;
    }
    if (/^(javascript:|mailto:)/i.test(url)) {
      continue;
    }
    if (!snippet && title.length < 10) {
      continue;
    }
    seen.add(url);
    normalized.push({ title, url, snippet });
    if (normalized.length >= limit) {
      break;
    }
  }
  return normalized;
}

function toPlaywrightSearchUrl(rawUrl = "") {
  const parsed = new URL(rawUrl);
  if (parsed.hostname.includes("duckduckgo")) {
    const browserUrl = new URL("https://duckduckgo.com/");
    const query = parsed.searchParams.get("q") || "";
    if (query) {
      browserUrl.searchParams.set("q", query);
    }
    const region = parsed.searchParams.get("kl") || parsed.searchParams.get("region") || "cn-zh";
    if (region) {
      browserUrl.searchParams.set("kl", region);
    }
    return browserUrl.toString();
  }
  return parsed.toString();
}

async function searchWebWithApi(query, options = {}) {
  const config = getSearchApiConfig();
  if (!config) {
    throw new Error("search api backend is not configured");
  }
  const limit = Math.max(1, Math.min(Number(options.limit || 5), 10));

  if (config.backend === "brave") {
    const endpoint = new URL("/res/v1/web/search", config.baseUrl);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("count", String(limit));
    endpoint.searchParams.set("search_lang", "zh-hans");
    endpoint.searchParams.set("country", String(options.country || "cn"));
    if (normalizeSourcePreference(options.preferredSource) === "news") {
      endpoint.searchParams.set("freshness", "pw");
    }
    const response = await fetchWithBotPolicy(endpoint.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": config.apiKey
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const apiError = normalizeWhitespace(payload?.error?.message || payload?.message || "");
      throw new Error(`search api failed: ${response.status} ${response.statusText}${apiError ? ` - ${apiError}` : ""}`);
    }
    const results = normalizeSearchResultShape(payload?.web?.results || [], limit);
    return {
      results,
      backend: "api",
      url: endpoint.origin,
      provider: config.backend
    };
  }

  throw new Error(`unsupported search api backend: ${config.backend}`);
}

function resolveSearchResultUrl(rawUrl = "") {
  const value = decodeHtmlEntities(String(rawUrl || "").trim());
  if (!value) {
    return "";
  }
  try {
    const parsed = new URL(value, readSearchEndpoints()[0] || DDG_SEARCH_ENDPOINT);
    const wrapped = parsed.searchParams.get("uddg") || parsed.searchParams.get("u");
    if (wrapped) {
      if (parsed.hostname.includes("bing.com") && /^a1[a-z0-9+/=]+$/i.test(wrapped)) {
        try {
          return Buffer.from(wrapped.slice(2), "base64").toString("utf8");
        } catch {
        }
      }
      return wrapped;
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function extractHtmlTitle(html = "") {
  const matched = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return stripHtml(matched?.[1] || "");
}

function extractMetaDescription(html = "") {
  const matched = String(html || "").match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i)
    || String(html || "").match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i);
  return stripHtml(matched?.[1] || "");
}

function getHostnameFromUrl(url = "") {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isRankingLikeUrl(url = "") {
  const normalized = String(url || "").toLowerCase();
  return ["/hot", "/trending", "/popular/rank", "/top/summary", "hot", "热榜", "热搜", "rank", "trending"].some((item) => normalized.includes(item));
}

function extractRegexGroups(pattern, html = "", mapper = null, limit = 10) {
  const results = [];
  let matched = null;
  while ((matched = pattern.exec(html)) && results.length < limit) {
    const item = mapper ? mapper(matched) : matched.slice(1);
    if (item) {
      results.push(item);
    }
  }
  return results;
}

function finalizeRankingSummary(siteLabel = "榜单页", entries = []) {
  const cleaned = (Array.isArray(entries) ? entries : [])
    .map((item) => ({
      rank: Number(item?.rank || 0) || undefined,
      title: normalizeWhitespace(item?.title || ""),
      extra: normalizeWhitespace(item?.extra || "")
    }))
    .filter((item) => item.title)
    .slice(0, 10);
  if (!cleaned.length) {
    return null;
  }
  const excerpt = [
    `${siteLabel} Top ${cleaned.length}：`,
    ...cleaned.map((item, index) => `${item.rank || index + 1}. ${item.title}${item.extra ? ` (${item.extra})` : ""}`)
  ].join(" ");
  return {
    siteLabel,
    entries: cleaned,
    excerpt
  };
}

function extractGitHubTrendingSummary(html = "") {
  const entries = extractRegexGroups(/<article[^>]*class=["'][^"']*Box-row[^"']*["'][^>]*>[\s\S]*?<h2[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*class=["'][^"']*col-9[^"']*["'][^>]*>([\s\S]*?)<\/p>)?[\s\S]*?(?:([0-9][0-9,]*)\s*stars today)?[\s\S]*?<\/article>/gi, html, (match) => {
    const repoPath = normalizeWhitespace(stripHtml(match[2] || "")).replace(/\s*\/\s*/g, "/");
    const description = normalizeWhitespace(stripHtml(match[3] || ""));
    const starsToday = normalizeWhitespace(match[4] || "");
    return {
      title: repoPath || String(match[1] || "").replace(/^\//, ""),
      extra: [description, starsToday ? `${starsToday} stars today` : ""].filter(Boolean).join(" | ")
    };
  }, 8);
  return finalizeRankingSummary("GitHub Trending", entries);
}

function extractWeiboHotSummary(html = "") {
  const entries = extractRegexGroups(/<tr[^>]*>\s*<td[^>]*class=["'][^"']*td-01[^"']*["'][^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]*class=["'][^"']*td-02[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>(?:[\s\S]*?<span>([\s\S]*?)<\/span>)?[\s\S]*?<\/td>/gi, html, (match) => ({
    rank: Number.parseInt(stripHtml(match[1] || ""), 10) || undefined,
    title: stripHtml(match[2] || ""),
    extra: stripHtml(match[3] || "")
  }), 10);
  return finalizeRankingSummary("微博热搜", entries);
}

function extractZhihuHotSummary(html = "") {
  const jsonMatch = String(html || "").match(/"hotList"\s*:\s*(\[[\s\S]*?\])\s*,\s*"guest"/i);
  if (jsonMatch?.[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const entries = parsed.slice(0, 10).map((item, index) => ({
        rank: index + 1,
        title: normalizeWhitespace(item?.target?.titleArea?.text || item?.target?.title || ""),
        extra: normalizeWhitespace(item?.target?.excerptArea?.text || item?.feedSpecific?.answerCount || item?.detailText?.text || "")
      }));
      const summary = finalizeRankingSummary("知乎热榜", entries);
      if (summary) {
        return summary;
      }
    } catch {
    }
  }
  const entries = extractRegexGroups(/<a[^>]*href=["'][^"']*question\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi, html, (match) => ({
    title: stripHtml(match[1] || "")
  }), 10);
  return finalizeRankingSummary("知乎热榜", entries);
}

function extractBilibiliRankingSummary(html = "") {
  const stateMatch = String(html || "").match(/(?:window\.__INITIAL_STATE__|__INITIAL_STATE__)\s*=\s*({[\s\S]*?})\s*;/i);
  if (stateMatch?.[1]) {
    try {
      const parsed = JSON.parse(stateMatch[1]);
      const list = parsed?.rankList || parsed?.list || parsed?.data?.list || parsed?.data || [];
      const entries = (Array.isArray(list) ? list : []).slice(0, 10).map((item, index) => ({
        rank: index + 1,
        title: normalizeWhitespace(item?.title || item?.name || ""),
        extra: normalizeWhitespace([item?.owner?.name || item?.author || "", item?.stat?.view ? `${item.stat.view} 播放` : item?.pts ? `${item.pts} 热度` : ""].filter(Boolean).join(" | "))
      }));
      const summary = finalizeRankingSummary("B 站热榜", entries);
      if (summary) {
        return summary;
      }
    } catch {
    }
  }
  const entries = extractRegexGroups(/<a[^>]*class=["'][^"']*(?:rank-item|video-name|title)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi, html, (match) => ({
    title: stripHtml(match[1] || "")
  }), 10);
  return finalizeRankingSummary("B 站热榜", entries);
}

function extractRankingSummary(url = "", html = "") {
  const hostname = getHostnameFromUrl(url);
  if (hostname.includes("github.com") && String(url || "").toLowerCase().includes("/trending")) {
    return extractGitHubTrendingSummary(html);
  }
  if (hostname.includes("zhihu.com") && String(url || "").toLowerCase().includes("/hot")) {
    return extractZhihuHotSummary(html);
  }
  if (hostname.includes("weibo.com") && String(url || "").toLowerCase().includes("/top/summary")) {
    return extractWeiboHotSummary(html);
  }
  if (hostname.includes("bilibili.com") && String(url || "").toLowerCase().includes("/popular/rank")) {
    return extractBilibiliRankingSummary(html);
  }
  return null;
}

function shouldRetryRankingWithPlaywright(url = "", summary = null, responseBackend = "") {
  if (!isRankingLikeUrl(url)) {
    return false;
  }
  if (String(responseBackend || "") === "playwright") {
    return false;
  }
  return !summary || !Array.isArray(summary.entries) || summary.entries.length < 3;
}

function extractBodyExcerpt(html = "", maxLength = 680) {
  const paragraphMatches = [...String(html || "").matchAll(/<(p|article|main|section)[^>]*>([\s\S]*?)<\/\1>/gi)];
  const combined = paragraphMatches
    .map((match) => stripHtml(match[2] || ""))
    .filter(Boolean)
    .join(" ");
  return normalizeWhitespace(combined).slice(0, maxLength);
}

function createVerificationRequiredError({ provider = "", url = "", message = "" } = {}) {
  const payload = {
    provider: String(provider || "").trim(),
    url: String(url || "").trim(),
    message: String(message || "需要先完成网页验证，然后再重试。").trim()
  };
  return new Error(`${VERIFICATION_REQUIRED_ERROR_PREFIX}${JSON.stringify(payload)}`);
}

function parseVerificationRequiredError(error) {
  const text = String(error?.message || error || "").trim();
  if (!text.startsWith(VERIFICATION_REQUIRED_ERROR_PREFIX)) {
    return null;
  }
  try {
    return JSON.parse(text.slice(VERIFICATION_REQUIRED_ERROR_PREFIX.length));
  } catch {
    return { provider: "", url: "", message: "需要先完成网页验证，然后再重试。" };
  }
}

function isVerificationRequiredError(error) {
  return Boolean(parseVerificationRequiredError(error));
}

function isMetasoSearchUrl(url = "") {
  const normalized = String(url || "").trim().toLowerCase();
  return normalized.startsWith("https://metaso.cn/search-v2/") || normalized === METASO_SEARCH_HOME;
}

function hasMetasoVerificationChallenge(text = "") {
  const combined = normalizeWhitespace(text).toLowerCase();
  return [
    "请完成下方拼图验证后继续",
    "拖动滑块完成拼图",
    "频繁使用，需要验证",
    "网络故障，请稍后重试"
  ].some((item) => combined.includes(item.toLowerCase()));
}

function extractMetasoAnswerText(text = "", query = "") {
  const normalized = normalizeWhitespace(text);
  if (!normalized || hasMetasoVerificationChallenge(normalized)) {
    return "";
  }
  const trimmedQuery = normalizeWhitespace(query);
  let answer = normalized;
  const queryIndex = trimmedQuery ? answer.indexOf(trimmedQuery) : -1;
  if (queryIndex >= 0) {
    answer = answer.slice(queryIndex + trimmedQuery.length);
  }
  answer = answer
    .replace(/^.*?思考了[0-9.]+s/, "")
    .replace(/^.*?正在加载\.\.\./, "")
    .replace(/^.*?更多文本好看/, "")
    .trim();

  const stopMarkers = [
    "生成幻灯片",
    "展示海报",
    "来源",
    "脑图",
    "大纲",
    "深度研究",
    "互动网页",
    "内容由AI生成",
    "以上内容均由AI大模型生成",
    "请遵守《用户协议》",
    "提出后续问题",
    "修改于",
    "复制下载保存"
  ];
  let stopIndex = answer.length;
  for (const marker of stopMarkers) {
    const markerIndex = answer.indexOf(marker);
    if (markerIndex >= 0 && markerIndex < stopIndex) {
      stopIndex = markerIndex;
    }
  }
  answer = answer.slice(0, stopIndex).trim();
  return normalizeWhitespace(answer).slice(0, 1200);
}

async function searchWebWithMetaso(query, options = {}) {
  const browser = await launchPlaywrightBrowser({ scope: "BOT_WEB_PLAYWRIGHT" });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: DEFAULT_USER_AGENT,
      locale: "zh-CN",
      extraHTTPHeaders: {
        "Accept-Language": DEFAULT_ACCEPT_LANGUAGE
      }
    });
    const page = await context.newPage();
    await page.goto(METASO_SEARCH_HOME, {
      waitUntil: options.waitUntil || "domcontentloaded",
      timeout: Math.max(3000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)
    });
    const input = page.locator("textarea, input[type='search'], input[placeholder*='问'], input[placeholder*='搜索']").first();
    await input.waitFor({ timeout: 10_000 });
    await input.click();
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Meta+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await input.pressSequentially(query, { delay: 40 });
    const sendButton = page.locator("button.send-arrow-button:not([disabled])").first();
    if (await sendButton.count().catch(() => 0)) {
      await sendButton.click().catch(() => {});
    } else {
      await input.press("Enter").catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
    }
    try {
      await page.waitForURL(/search-v2\//, { timeout: 15_000 });
    } catch {
    }
    await page.waitForTimeout(Number(options.postLoadDelayMs || 10_000));
    const payload = await page.evaluate(() => ({
      title: String(document.title || "").trim(),
      url: String(location.href || "").trim(),
      bodyText: String(document.body?.innerText || "").replace(/\s+/g, " ").trim()
    }));
    await context.close();
    if (!payload.url || payload.url === METASO_SEARCH_HOME) {
      throw new Error("metaso search did not navigate to a result page");
    }
    if (hasMetasoVerificationChallenge(payload.bodyText)) {
      throw createVerificationRequiredError({
        provider: "metaso",
        url: payload.url || METASO_SEARCH_HOME,
        message: "秘塔触发了滑块或拼图验证，请先完成验证，再点击“完成后重试”。"
      });
    }
    const snippet = extractMetasoAnswerText(payload.bodyText, query);
    if (!snippet) {
      throw new Error("metaso result page does not contain a usable answer excerpt");
    }
    return {
      results: [{
        title: `秘塔AI搜索：${query}`,
        url: payload.url,
        snippet
      }],
      backend: "playwright",
      url: payload.url,
      provider: "metaso"
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function fetchMetasoSummary(url, options = {}) {
  const browser = await launchPlaywrightBrowser({ scope: "BOT_WEB_PLAYWRIGHT" });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: DEFAULT_USER_AGENT,
      locale: "zh-CN",
      extraHTTPHeaders: {
        "Accept-Language": DEFAULT_ACCEPT_LANGUAGE
      }
    });
    const page = await context.newPage();
    await page.goto(url, {
      waitUntil: options.waitUntil || "domcontentloaded",
      timeout: Math.max(3000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)
    });
    await page.waitForTimeout(Number(options.postLoadDelayMs || 8_000));
    const payload = await page.evaluate(() => ({
      title: String(document.title || "").trim(),
      url: String(location.href || "").trim(),
      bodyText: String(document.body?.innerText || "").replace(/\s+/g, " ").trim()
    }));
    await context.close();
    if (hasMetasoVerificationChallenge(payload.bodyText)) {
      throw createVerificationRequiredError({
        provider: "metaso",
        url: payload.url || url || METASO_SEARCH_HOME,
        message: "秘塔结果页要求先完成滑块或拼图验证，验证完成后再重试。"
      });
    }
    const excerpt = extractMetasoAnswerText(payload.bodyText) || normalizeWhitespace(payload.bodyText).slice(0, 680);
    return {
      url: payload.url || url,
      title: payload.title,
      description: "",
      excerpt,
      contentType: "text/html; charset=utf-8",
      backend: "playwright"
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function fetchWithBotPolicy(url, options = {}) {
  const parsedUrl = assertAllowedUrl(url);
  const response = await fetch(parsedUrl, {
    method: String(options.method || "GET").toUpperCase(),
    headers: getRequestHeaders(options.headers || {}),
    signal: withTimeout(options.signal, options.timeoutMs),
    redirect: "follow",
    body: options.body
  });
  return response;
}

async function fetchPageWithPlaywright(url, options = {}) {
  const parsedUrl = assertAllowedUrl(url).toString();
  const browser = await launchPlaywrightBrowser({ scope: "BOT_WEB_PLAYWRIGHT" });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: DEFAULT_USER_AGENT,
      locale: "zh-CN",
      extraHTTPHeaders: {
        "Accept-Language": DEFAULT_ACCEPT_LANGUAGE
      }
    });
    const page = await context.newPage();
    await page.goto(parsedUrl, {
      waitUntil: options.waitUntil || "domcontentloaded",
      timeout: Math.max(3000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)
    });
    if (Number(options.postLoadDelayMs || 0) > 0) {
      await page.waitForTimeout(Number(options.postLoadDelayMs));
    }
    const content = await page.content();
    const finalUrl = page.url();
    await context.close();
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      url: finalUrl,
      text: content,
      contentType: "text/html; charset=utf-8",
      backend: "playwright"
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function searchEndpointWithPlaywright(url, options = {}) {
  const parsedUrl = assertAllowedUrl(url).toString();
  const browserUrl = toPlaywrightSearchUrl(parsedUrl);
  const browser = await launchPlaywrightBrowser({ scope: "BOT_WEB_PLAYWRIGHT" });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: DEFAULT_USER_AGENT,
      locale: "zh-CN",
      extraHTTPHeaders: {
        "Accept-Language": DEFAULT_ACCEPT_LANGUAGE
      }
    });
    const page = await context.newPage();
    await page.goto(browserUrl, {
      waitUntil: options.waitUntil || "domcontentloaded",
      timeout: Math.max(3000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)
    });
    const hostname = new URL(browserUrl).hostname.toLowerCase();
    const waitSelectors = hostname.includes("bing.com")
      ? ["li.b_algo", "#b_results", "main"]
      : ["article[data-testid='result']", "a.result__a", ".results--main", "main"];
    for (const selector of waitSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 2500 });
        break;
      } catch {
      }
    }
    await page.waitForTimeout(Number(options.postLoadDelayMs || 1200));
    const challengeProbe = await page.evaluate(() => ({
      title: String(document.title || ""),
      bodyText: String(document.body?.innerText || "").slice(0, 1200)
    }));
    if (isSearchChallengePage(challengeProbe.title, challengeProbe.bodyText)) {
      throw new Error("search engine challenge page detected");
    }
    const limit = Math.max(1, Math.min(Number(options.limit || 5), 12));
    let results = await page.evaluate(({ pageLimit, currentHostname }) => {
      function textOf(node) {
        return String(node?.textContent || "").replace(/\s+/g, " ").trim();
      }
      function hrefOf(node) {
        return String(node?.href || node?.getAttribute?.("href") || "").trim();
      }
      function pushResult(list, item) {
        if (!item || !item.title || !item.url) {
          return;
        }
        list.push(item);
      }
      function collectBing() {
        const items = [];
        for (const node of [...document.querySelectorAll("#b_results > li.b_algo, li.b_algo, .b_algo")]) {
          const link = node.querySelector("h2 a, .b_algoheader a, a[href]");
          const titleNode = node.querySelector("h2, .b_algoheader") || link;
          const snippetNode = node.querySelector(".b_caption p, .b_snippet, .b_lineclamp2, p");
          pushResult(items, {
            title: textOf(link) || textOf(titleNode),
            url: hrefOf(link),
            snippet: textOf(snippetNode)
          });
          if (items.length >= pageLimit) {
            break;
          }
        }
        return items;
      }
      function collectDuckDuckGo() {
        const containers = [
          ...document.querySelectorAll("article[data-testid='result'], .result.results_links, .result, [data-layout='organic']")
        ];
        const items = [];
        for (const node of containers) {
          const link = node.querySelector("[data-testid='result-title-a'], h2 a, a.result__a, a[href]");
          const snippetNode = node.querySelector("[data-result='snippet'], [data-testid='result-snippet'], .result__snippet");
          pushResult(items, {
            title: textOf(link) || textOf(node.querySelector("h2")),
            url: hrefOf(link),
            snippet: textOf(snippetNode)
          });
          if (items.length >= pageLimit) {
            break;
          }
        }
        if (items.length) {
          return items;
        }
        for (const link of [...document.querySelectorAll("a.result__a, [data-testid='result-title-a'], main a[href]")]) {
          const container = link.closest("article, .result, li, div") || link.parentElement || document.body;
          const snippetNode = container.querySelector("[data-result='snippet'], [data-testid='result-snippet'], .result__snippet, .VrBPSncUavA1d7C9kAc5");
          pushResult(items, {
            title: textOf(link),
            url: hrefOf(link),
            snippet: textOf(snippetNode) || textOf(container).replace(textOf(link), "").trim()
          });
          if (items.length >= pageLimit) {
            break;
          }
        }
        return items;
      }
      if (currentHostname.includes("bing.com")) {
        return collectBing();
      }
      if (currentHostname.includes("duckduckgo")) {
        return collectDuckDuckGo();
      }
      return collectDuckDuckGo();
    }, { pageLimit: limit, currentHostname: hostname });
    results = normalizeSearchResultShape(results, limit, hostname);
    if (!results.length) {
      const html = await page.content();
      results = normalizeSearchResultShape(pickSearchParser(parsedUrl)(html, limit * 2), limit, hostname);
    }
    if (!results.length) {
      results = await page.evaluate(({ pageLimit }) => {
        function textOf(node) {
          return String(node?.textContent || "").replace(/\s+/g, " ").trim();
        }
        const items = [];
        for (const anchor of [...document.querySelectorAll("a[href]")]) {
          const title = textOf(anchor);
          const rawUrl = String(anchor.getAttribute("href") || "").trim();
          if (!rawUrl || !title || title.length < 6 || title.length > 180) {
            continue;
          }
          const container = anchor.closest("li, article, div") || anchor.parentElement || document.body;
          const snippet = textOf(container).replace(title, "").trim();
          items.push({
            title,
            url: rawUrl,
            snippet: snippet.slice(0, 260)
          });
          if (items.length >= pageLimit * 8) {
            break;
          }
        }
        return items;
      }, { pageLimit: limit });
      results = normalizeSearchResultShape(results, limit, hostname);
    }
    await context.close();
    return {
      results,
      backend: "playwright",
      url: page.url()
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function fetchPageWithBackend(url, options = {}) {
  const backend = normalizeBackend(options.backend);
  const triedBackends = [];

  const tryFetch = async () => {
    triedBackends.push("fetch");
    const response = await fetchWithBotPolicy(url, options);
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url || String(url || ""),
      text,
      contentType: String(response.headers.get("content-type") || "").toLowerCase(),
      backend: "fetch"
    };
  };

  const tryPlaywright = async () => {
    triedBackends.push("playwright");
    return fetchPageWithPlaywright(url, {
      ...options,
      postLoadDelayMs: options.postLoadDelayMs ?? 1200
    });
  };

  if (backend === "fetch") {
    return { ...(await tryFetch()), triedBackends };
  }
  if (backend === "playwright") {
    return { ...(await tryPlaywright()), triedBackends };
  }
  if (backend === "api") {
    throw new Error("api backend only supports search requests");
  }

  let lastError = null;
  try {
    const result = await tryFetch();
    if (result.ok && result.text) {
      return { ...result, triedBackends };
    }
    lastError = new Error(`${result.status} ${result.statusText}`.trim());
  } catch (error) {
    lastError = error;
  }
  try {
    return { ...(await tryPlaywright()), triedBackends };
  } catch (error) {
    const primary = String(lastError?.message || lastError || "fetch failed").trim();
    const secondary = String(error?.message || error || "playwright failed").trim();
    throw new Error(`page fetch failed via fetch/playwright: ${primary}; ${secondary}`);
  }
}

export async function searchWeb(query, options = {}) {
  const trimmedQuery = normalizeWhitespace(query);
  if (!trimmedQuery) {
    throw new Error("search query is required");
  }

  const limit = Math.max(1, Math.min(Number(options.limit || 5), 8));
  const preference = normalizeSourcePreference(options.preferredSource || "");
  const backendMode = normalizeBackend(options.backend);
  const providerMode = normalizeSearchProvider(options.provider);
  const combined = [];
  const seenUrls = new Set();
  const executedQueries = [];
  const attemptedEndpoints = [];
  const apiEnabled = hasSearchApiBackend();

  for (const variant of buildSearchQueryVariants(trimmedQuery, preference)) {
    executedQueries.push(variant);
    let batchResults = [];
    let endpointUsed = "";
    let lastError = null;

    if (providerMode === "metaso") {
      attemptedEndpoints.push("metaso-playwright");
      try {
        const metasoResult = await searchWebWithMetaso(variant, {
          signal: options.signal,
          timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
          waitUntil: "domcontentloaded",
          postLoadDelayMs: 10_000
        });
        batchResults = metasoResult.results;
        endpointUsed = `${metasoResult.provider} (${metasoResult.backend})`;
      } catch (error) {
        lastError = error;
        if (!isVerificationRequiredError(error)) {
          throw new Error(`web search failed via metaso-playwright: ${String(lastError?.message || lastError || "unknown error").trim()}`);
        }
      }
    }

    if (!batchResults.length && (backendMode === "api" || (backendMode === "auto" && apiEnabled && providerMode !== "metaso"))) {
      attemptedEndpoints.push(apiEnabled ? `${normalizeSearchApiBackend()}-api` : "api");
      try {
        const apiResult = await searchWebWithApi(variant, {
          signal: options.signal,
          timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
          limit: limit * 2,
          preferredSource: preference
        });
        batchResults = apiResult.results;
        endpointUsed = `${apiResult.provider} (${apiResult.backend})`;
      } catch (error) {
        lastError = error;
        if (backendMode === "api") {
          throw error;
        }
      }
    }

    if (batchResults.length) {
      for (const result of batchResults) {
        const url = String(result.url || "").trim();
        const title = String(result.title || "").trim();
        const snippet = String(result.snippet || "").trim();
        if (!url || !title || seenUrls.has(url)) {
          continue;
        }
        try {
          assertAllowedUrl(url);
        } catch {
          continue;
        }
        seenUrls.add(url);
        combined.push({
          title,
          url,
          snippet,
          matchedSource: inferSourceType(url, title, snippet),
          matchedQuery: variant,
          endpoint: endpointUsed,
          score: scoreSearchResult({ url, title, snippet }, preference)
        });
      }
      if (combined.length >= limit * 2) {
        break;
      }
      continue;
    }

    const builtinFallbackEnabled = providerMode !== "metaso" || isVerificationRequiredError(lastError);
    for (const endpointValue of builtinFallbackEnabled ? readSearchEndpoints() : []) {
      const endpoint = new URL(endpointValue);
      endpoint.searchParams.set("q", variant);
      if (endpoint.hostname.includes("duckduckgo")) {
        endpoint.searchParams.set("kl", String(options.region || "cn-zh"));
      }
      attemptedEndpoints.push(endpoint.origin);
      try {
        if (backendMode === "playwright") {
          try {
            const playwrightResult = await searchEndpointWithPlaywright(endpoint.toString(), {
              timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
              limit: limit * 2,
              waitUntil: "domcontentloaded",
              postLoadDelayMs: 1200
            });
            batchResults = playwrightResult.results;
            endpointUsed = `${endpoint.origin} (${playwrightResult.backend})`;
          } catch (playwrightError) {
            const response = await fetchWithBotPolicy(endpoint.toString(), {
              signal: options.signal,
              timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS
            });
            const html = await response.text();
            if (!response.ok) {
              throw playwrightError;
            }
            batchResults = pickSearchParser(endpoint.toString())(html, limit * 2);
            endpointUsed = `${endpoint.origin} (fetch-fallback)`;
            lastError = playwrightError;
          }
        } else {
          const response = await fetchPageWithBackend(endpoint.toString(), {
            signal: options.signal,
            timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
            backend: options.backend,
            waitUntil: "domcontentloaded",
            postLoadDelayMs: 1200
          });
          const html = response.text;
          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`.trim());
          }
          batchResults = response.backend === "playwright"
            ? (await searchEndpointWithPlaywright(endpoint.toString(), {
                timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
                limit: limit * 2,
                waitUntil: "domcontentloaded",
                postLoadDelayMs: 1200
              })).results
            : pickSearchParser(endpoint.toString())(html, limit * 2);
          endpointUsed = `${endpoint.origin} (${response.backend})`;
        }
        if (batchResults.length) {
          break;
        }
        lastError = new Error("no parsable search results");
      } catch (error) {
        lastError = error;
      }
    }

    if (!batchResults.length && lastError) {
      throw new Error(`web search failed via ${[...new Set(attemptedEndpoints)].join(", ")}: ${String(lastError?.message || lastError || "unknown error").trim()}`);
    }

    for (const result of batchResults) {
      const url = String(result.url || "").trim();
      const title = String(result.title || "").trim();
      const snippet = String(result.snippet || "").trim();
      if (!url || !title || seenUrls.has(url)) {
        continue;
      }
      try {
        assertAllowedUrl(url);
      } catch {
        continue;
      }
      seenUrls.add(url);
      combined.push({
        title,
        url,
        snippet,
        matchedSource: inferSourceType(url, title, snippet),
        matchedQuery: variant,
        endpoint: endpointUsed,
        score: scoreSearchResult({ url, title, snippet }, preference)
      });
    }

    if (combined.length >= limit * 2) {
      break;
    }
  }

  const results = combined
    .sort((left, right) => right.score - left.score || String(left.title || "").localeCompare(String(right.title || ""), "zh-Hans-CN", { sensitivity: "base" }))
    .slice(0, limit)
    .map(({ score, ...item }) => item);

  return {
    query: trimmedQuery,
    preferredSource: preference,
    executedQueries,
    attemptedEndpoints: [...new Set(attemptedEndpoints)],
    results
  };
}

export async function fetchWebPageSummary(url, options = {}) {
  if (isMetasoSearchUrl(url)) {
    return fetchMetasoSummary(url, options);
  }
  let response = await fetchPageWithBackend(url, {
    signal: options.signal,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    backend: options.backend,
    waitUntil: "domcontentloaded",
    postLoadDelayMs: 1000
  });
  let contentType = String(response.contentType || "").toLowerCase();
  let rawText = response.text;
  if (!response.ok) {
    throw new Error(`page fetch failed: ${response.status} ${response.statusText}`);
  }
  let isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml") || /<html\b/i.test(rawText);
  let rankingSummary = isHtml ? extractRankingSummary(url, rawText) : null;

  if (shouldRetryRankingWithPlaywright(url, rankingSummary, response.backend)) {
    response = await fetchPageWithBackend(url, {
      signal: options.signal,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      backend: "playwright",
      waitUntil: "domcontentloaded",
      postLoadDelayMs: 1500
    });
    contentType = String(response.contentType || "").toLowerCase();
    rawText = response.text;
    if (!response.ok) {
      throw new Error(`page fetch failed: ${response.status} ${response.statusText}`);
    }
    isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml") || /<html\b/i.test(rawText);
    rankingSummary = isHtml ? extractRankingSummary(url, rawText) : null;
  }

  const title = isHtml ? extractHtmlTitle(rawText) : "";
  const description = isHtml ? extractMetaDescription(rawText) : "";
  const excerpt = rankingSummary?.excerpt || (isHtml ? extractBodyExcerpt(rawText) : normalizeWhitespace(rawText).slice(0, 680));
  return {
    url,
    title,
    description,
    excerpt,
    ranking: rankingSummary || undefined,
    contentType,
    backend: response.backend || normalizeBackend(options.backend)
  };
}
