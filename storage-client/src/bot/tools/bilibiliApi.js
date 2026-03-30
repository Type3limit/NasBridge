import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BILIBILI_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BILIBILI_API_BASE = "https://api.bilibili.com";
const BILIBILI_PASSPORT_BASE = "https://passport.bilibili.com";
const DEFAULT_BILIBILI_COOKIE_FILE_NAME = "bilibili-cookies.json";
const DEFAULT_BILIBILI_AUTH_STATE_FILE_NAME = "bilibili-auth.json";
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];
const WBI_KEYS_TTL_MS = 12 * 60 * 60 * 1000;

let cachedWbiKeys = null;
let cachedWbiKeysAt = 0;
let generatedBuvid3 = "";

const BILIBILI_QUALITY_PRESETS = [
  { qn: 127, label: "8k", aliases: ["8k", "4320p", "uhd"] },
  { qn: 126, label: "dolby", aliases: ["dolby", "dolbyvision", "杜比视界"] },
  { qn: 125, label: "hdr", aliases: ["hdr"] },
  { qn: 120, label: "4k", aliases: ["4k", "2160p", "uhd4k"] },
  { qn: 116, label: "1080p60", aliases: ["1080p60", "108060", "fhd60"] },
  { qn: 112, label: "1080p+", aliases: ["1080p+", "1080plus"] },
  { qn: 80, label: "1080p", aliases: ["1080p", "1080", "fhd"] },
  { qn: 74, label: "720p60", aliases: ["720p60", "72060", "hd60"] },
  { qn: 64, label: "720p", aliases: ["720p", "720", "hd"] },
  { qn: 32, label: "480p", aliases: ["480p", "480", "sd"] },
  { qn: 16, label: "360p", aliases: ["360p", "360", "ld"] }
];

export function extractBilibiliVideoId(value = "") {
  const match = String(value || "").match(/\b(BV[0-9A-Za-z]+)\b/i);
  const raw = String(match?.[1] || "").trim();
  if (!raw) {
    return "";
  }
  return `BV${raw.slice(2)}`;
}

function generateBuvid3() {
  if (generatedBuvid3) {
    return generatedBuvid3;
  }
  const seed = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  generatedBuvid3 = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-${seed.slice(12, 16)}-${seed.slice(16, 20)}-${seed.slice(20, 32)}infoc`;
  return generatedBuvid3;
}

function buildCookieObject(name, value, options = {}) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    return null;
  }
  return {
    name: normalizedName,
    value: String(value || ""),
    domain: String(options.domain || ".bilibili.com").trim() || ".bilibili.com",
    path: String(options.path || "/").trim() || "/",
    secure: options.secure !== false,
    expires: Number.isFinite(options.expires) ? Number(options.expires) : -1,
    httpOnly: options.httpOnly === true,
    sameSite: String(options.sameSite || "Lax").trim() || "Lax"
  };
}

function parseCookieHeader(value = "") {
  return String(value || "")
    .split(/;\s*/)
    .map((segment) => {
      const separator = segment.indexOf("=");
      if (separator <= 0) {
        return null;
      }
      return buildCookieObject(segment.slice(0, separator), segment.slice(separator + 1));
    })
    .filter(Boolean);
}

function matchCookieDomain(hostname = "", domain = "", includeSubdomains = false) {
  const normalizedHost = String(hostname || "").toLowerCase();
  const normalizedDomain = String(domain || "").toLowerCase();
  if (!normalizedHost || !normalizedDomain) {
    return false;
  }
  if (normalizedDomain.startsWith(".")) {
    return normalizedHost === normalizedDomain.slice(1) || normalizedHost.endsWith(normalizedDomain);
  }
  return normalizedHost === normalizedDomain || (includeSubdomains && normalizedHost.endsWith(`.${normalizedDomain}`));
}

function dedupeCookies(cookies = []) {
  const map = new Map();
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (!cookie?.name) {
      continue;
    }
    const key = `${String(cookie.domain || "").toLowerCase()}|${String(cookie.path || "/")}|${String(cookie.name || "").toLowerCase()}`;
    map.set(key, cookie);
  }
  return [...map.values()];
}

export function getDefaultBilibiliCookieFilePath(baseDir = process.cwd()) {
  const appDataDirName = String(process.env.BOT_APP_DATA_DIR_NAME || ".nas-bot").trim() || ".nas-bot";
  return path.resolve(String(baseDir || process.cwd()), appDataDirName, DEFAULT_BILIBILI_COOKIE_FILE_NAME);
}

export function getDefaultBilibiliAuthStatePath(baseDir = process.cwd()) {
  const appDataDirName = String(process.env.BOT_APP_DATA_DIR_NAME || ".nas-bot").trim() || ".nas-bot";
  return path.resolve(String(baseDir || process.cwd()), appDataDirName, DEFAULT_BILIBILI_AUTH_STATE_FILE_NAME);
}

export function getPreferredBilibiliCookieFilePath(baseDir = process.cwd()) {
  const cookieFile = String(process.env.BOT_BILIBILI_COOKIE_FILE || "").trim();
  return cookieFile ? path.resolve(cookieFile) : getDefaultBilibiliCookieFilePath(baseDir);
}

function parseSetCookieHeaders(setCookieHeaders = []) {
  const cookies = [];
  for (const header of Array.isArray(setCookieHeaders) ? setCookieHeaders : []) {
    const raw = String(header || "").trim();
    if (!raw) {
      continue;
    }
    const parts = raw.split(/;\s*/);
    const [nameValue, ...attrs] = parts;
    const separator = nameValue.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const options = { domain: ".bilibili.com", path: "/", secure: true, httpOnly: false, sameSite: "Lax", expires: -1 };
    for (const attr of attrs) {
      const attrSeparator = attr.indexOf("=");
      const key = String(attrSeparator >= 0 ? attr.slice(0, attrSeparator) : attr).trim().toLowerCase();
      const value = String(attrSeparator >= 0 ? attr.slice(attrSeparator + 1) : "").trim();
      if (key === "domain" && value) options.domain = value;
      else if (key === "path" && value) options.path = value;
      else if (key === "secure") options.secure = true;
      else if (key === "httponly") options.httpOnly = true;
      else if (key === "samesite" && value) options.sameSite = value;
      else if (key === "expires" && value) {
        const expiresAt = Date.parse(value);
        if (Number.isFinite(expiresAt)) {
          options.expires = Math.floor(expiresAt / 1000);
        }
      }
    }
    cookies.push(buildCookieObject(nameValue.slice(0, separator), nameValue.slice(separator + 1), options));
  }
  return cookies.filter(Boolean);
}

async function readCookieFile(targetUrl = "https://www.bilibili.com/") {
  const cookieFile = getPreferredBilibiliCookieFilePath(process.cwd());
  if (!cookieFile) {
    return [];
  }
  const raw = await fs.promises.readFile(cookieFile, "utf-8");
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    const cookies = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : [];
    return cookies.map((item) => buildCookieObject(item?.name, item?.value, item || {})).filter(Boolean);
  }

  const pageUrl = new URL(targetUrl);
  const cookies = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const next = String(line || "").trim();
    if (!next || next.startsWith("#")) {
      continue;
    }
    const parts = next.split("\t");
    if (parts.length < 7) {
      continue;
    }
    const [domain, includeSubdomains, cookiePath, secureFlag, expiresRaw, name, value] = parts;
    if (!matchCookieDomain(pageUrl.hostname, domain, String(includeSubdomains || "").toUpperCase() === "TRUE")) {
      continue;
    }
    cookies.push(buildCookieObject(name, value, {
      domain,
      path: cookiePath,
      secure: String(secureFlag || "").toUpperCase() === "TRUE",
      expires: Number(expiresRaw || 0) > 0 ? Number(expiresRaw) : -1
    }));
  }
  return cookies.filter(Boolean);
}

export async function loadConfiguredBilibiliCookies(targetUrl = "https://www.bilibili.com/") {
  const envCookies = [];
  const rawCookieHeader = String(process.env.BOT_BILIBILI_COOKIE_HEADER || "").trim();
  if (rawCookieHeader) {
    envCookies.push(...parseCookieHeader(rawCookieHeader));
  }
  for (const [name, value] of [
    ["SESSDATA", process.env.BOT_BILIBILI_SESSDATA],
    ["buvid3", process.env.BOT_BILIBILI_BUVID3],
    ["DedeUserID", process.env.BOT_BILIBILI_DEDEUSERID],
    ["bili_jct", process.env.BOT_BILIBILI_BILI_JCT]
  ]) {
    if (String(value || "").trim()) {
      envCookies.push(buildCookieObject(name, value));
    }
  }
  if (!envCookies.some((cookie) => String(cookie?.name || "").toLowerCase() === "buvid3")) {
    envCookies.push(buildCookieObject("buvid3", generateBuvid3()));
  }

  let fileCookies = [];
  try {
    fileCookies = await readCookieFile(targetUrl);
  } catch {
    fileCookies = [];
  }
  return dedupeCookies([...envCookies, ...fileCookies]);
}

export async function getConfiguredBilibiliCookieHeader(targetUrl = "https://www.bilibili.com/") {
  const cookies = await loadConfiguredBilibiliCookies(targetUrl);
  return cookies.map((cookie) => `${cookie.name}=${cookie.value || ""}`).join("; ");
}

function getBilibiliPassportAnonymousCookieHeader() {
  const buvid3 = String(process.env.BOT_BILIBILI_BUVID3 || "").trim() || generateBuvid3();
  return `buvid3=${buvid3}`;
}

async function fetchBilibiliPassport(endpointPath, { params = {}, signal, cookieHeader = "" } = {}) {
  const headers = {
    Referer: "https://www.bilibili.com/",
    Origin: "https://www.bilibili.com",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "User-Agent": BILIBILI_USER_AGENT
  };
  const normalizedCookieHeader = String(cookieHeader || "").trim();
  if (normalizedCookieHeader) {
    headers.Cookie = normalizedCookieHeader;
  }
  const url = new URL(endpointPath, BILIBILI_PASSPORT_BASE);
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method: "GET",
    headers,
    redirect: "follow",
    signal
  });
  if (!response.ok) {
    throw new Error(`bilibili passport request failed: ${response.status} ${response.statusText}`.trim());
  }
  const json = await response.json();
  if (Number(json?.code || 0) !== 0) {
    throw new Error(`bilibili passport error ${json?.code}: ${json?.message || "request failed"}`.trim());
  }
  return { data: json?.data || {}, response };
}

function getResponseSetCookieHeaders(response) {
  if (!response?.headers) {
    return [];
  }
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

export async function generateBilibiliLoginQr(options = {}) {
  const baseCookieHeader = String(
    options.cookieHeader || getBilibiliPassportAnonymousCookieHeader()
  ).trim();
  const { data, response } = await fetchBilibiliPassport("/x/passport-login/web/qrcode/generate", {
    signal: options.signal,
    cookieHeader: baseCookieHeader
  });
  const loginUrl = String(data?.url || "").trim();
  const qrcodeKey = String(data?.qrcode_key || "").trim();
  if (!loginUrl || !qrcodeKey) {
    throw new Error("failed to generate bilibili login qr code");
  }
  const sessionCookies = dedupeCookies(parseSetCookieHeaders(getResponseSetCookieHeaders(response)));
  const responseCookieHeader = sessionCookies.map((cookie) => `${cookie.name}=${cookie.value || ""}`).join("; ");
  const cookieHeader = [baseCookieHeader, responseCookieHeader].filter(Boolean).join("; ");
  return {
    loginUrl,
    qrcodeKey,
    imageUrl: `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(loginUrl)}&size=420x420&margin=24&qzone=2&format=png`,
    cookieHeader
  };
}

export async function pollBilibiliLoginQr(qrcodeKey = "", options = {}) {
  const normalizedKey = String(qrcodeKey || "").trim();
  if (!normalizedKey) {
    throw new Error("qrcodeKey is required");
  }
  const { data, response } = await fetchBilibiliPassport("/x/passport-login/web/qrcode/poll", {
    params: { qrcode_key: normalizedKey },
    signal: options.signal,
    cookieHeader: options.cookieHeader
  });
  const rawPollCode = Object.prototype.hasOwnProperty.call(data || {}, "code") ? data.code : -1;
  const pollCode = Number(rawPollCode);
  const setCookieHeaders = getResponseSetCookieHeaders(response);
  const normalizedPollCode = Number.isFinite(pollCode) ? pollCode : -1;
  const cookies = normalizedPollCode === 0 ? dedupeCookies(parseSetCookieHeaders(setCookieHeaders)) : [];
  return {
    code: normalizedPollCode,
    message: String(data?.message || "").trim(),
    cookies,
    cookieHeader: cookies.map((cookie) => `${cookie.name}=${cookie.value || ""}`).join("; "),
    debug: {
      keys: data && typeof data === "object" ? Object.keys(data) : [],
      hasCode: Object.prototype.hasOwnProperty.call(data || {}, "code"),
      rawCode: rawPollCode
    }
  };
}

export async function getBilibiliLoggedInUser(options = {}) {
  try {
    const data = await fetchBilibiliJson("/x/web-interface/nav", {
      signal: options.signal,
      sourceUrl: "https://www.bilibili.com/",
      includeCookies: options.includeCookies !== false,
      allowAnonymousRetry: false
    });
    if (data?.isLogin !== true) {
      return null;
    }
    return {
      mid: Number(data?.mid || 0),
      uname: String(data?.uname || "").trim(),
      face: String(data?.face || "").trim(),
      level: Number(data?.level_info?.current_level || 0)
    };
  } catch {
    return null;
  }
}

export async function getBilibiliRequestHeaders({ sourceUrl = "https://www.bilibili.com/", userAgent = "", cookieHeader = "", includeCookies = true } = {}) {
  const referer = String(sourceUrl || "https://www.bilibili.com/").trim() || "https://www.bilibili.com/";
  const configuredCookieHeader = includeCookies ? await getConfiguredBilibiliCookieHeader(referer) : "";
  const mergedCookieHeader = [configuredCookieHeader, String(cookieHeader || "").trim()].filter(Boolean).join("; ");
  const headers = {
    Referer: referer,
    Origin: "https://www.bilibili.com",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "User-Agent": String(userAgent || BILIBILI_USER_AGENT).trim() || BILIBILI_USER_AGENT
  };
  if (mergedCookieHeader) {
    headers.Cookie = mergedCookieHeader;
  }
  return headers;
}

function getMixinKey(imgKey = "", subKey = "") {
  return MIXIN_KEY_ENC_TAB.map((index) => `${imgKey}${subKey}`[index] || "").join("").slice(0, 32);
}

function createMd5(input = "") {
  return crypto.createHash("md5").update(String(input || "")).digest("hex");
}

function signWbi(params = {}, imgKey = "", subKey = "") {
  const wts = Math.floor(Date.now() / 1000);
  const mixinKey = getMixinKey(imgKey, subKey);
  const filtered = { ...params, wts };
  const query = Object.keys(filtered)
    .sort()
    .map((key) => {
      const value = String(filtered[key] ?? "").replace(/[!'()*]/g, "");
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join("&");
  return {
    ...filtered,
    w_rid: createMd5(`${query}${mixinKey}`)
  };
}

async function getWbiKeys(signal) {
  if (cachedWbiKeys && Date.now() - cachedWbiKeysAt < WBI_KEYS_TTL_MS) {
    return cachedWbiKeys;
  }
  const data = await fetchBilibiliJson("/x/web-interface/nav", {
    signal,
    sourceUrl: "https://www.bilibili.com/",
    includeCookies: false,
    allowAnonymousRetry: false
  });
  const imgUrl = String(data?.wbi_img?.img_url || "").trim();
  const subUrl = String(data?.wbi_img?.sub_url || "").trim();
  if (!imgUrl || !subUrl) {
    throw new Error("failed to get bilibili wbi keys");
  }
  const imgKey = imgUrl.split("/").pop()?.replace(/\.\w+$/, "") || "";
  const subKey = subUrl.split("/").pop()?.replace(/\.\w+$/, "") || "";
  if (!imgKey || !subKey) {
    throw new Error("invalid bilibili wbi keys");
  }
  cachedWbiKeys = { imgKey, subKey };
  cachedWbiKeysAt = Date.now();
  return cachedWbiKeys;
}

async function fetchBilibiliJson(endpointPath, { params = {}, signal, sourceUrl = "https://www.bilibili.com/", useWbi = false, includeCookies = true, allowAnonymousRetry = true } = {}) {
  const headers = await getBilibiliRequestHeaders({ sourceUrl, includeCookies });
  const url = new URL(endpointPath, BILIBILI_API_BASE);
  let finalParams = { ...params };
  if (useWbi) {
    const { imgKey, subKey } = await getWbiKeys(signal);
    finalParams = signWbi(finalParams, imgKey, subKey);
  }
  for (const [key, value] of Object.entries(finalParams)) {
    if (value == null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method: "GET",
    headers,
    redirect: "follow",
    signal
  });
  if (!response.ok) {
    throw new Error(`bilibili api request failed: ${response.status} ${response.statusText}`.trim());
  }
  const json = await response.json();
  if (Number(json?.code || 0) === -101 && includeCookies && allowAnonymousRetry) {
    return fetchBilibiliJson(endpointPath, {
      params,
      signal,
      sourceUrl,
      useWbi,
      includeCookies: false,
      allowAnonymousRetry: false
    });
  }
  if (Number(json?.code || 0) !== 0) {
    throw new Error(`bilibili api error ${json?.code}: ${json?.message || "request failed"}`.trim());
  }
  return json?.data;
}

async function resolveShortUrl(targetUrl, signal) {
  try {
    const headers = await getBilibiliRequestHeaders({ sourceUrl: targetUrl });
    const response = await fetch(targetUrl, {
      method: "GET",
      headers,
      redirect: "follow",
      signal
    });
    return String(response.url || targetUrl).trim() || targetUrl;
  } catch {
    return targetUrl;
  }
}

export async function resolveBilibiliVideoIdFromSource(source = "", signal) {
  const directId = extractBilibiliVideoId(source);
  if (directId) {
    return directId;
  }
  try {
    const parsed = new URL(String(source || "").trim());
    if (String(parsed.hostname || "").toLowerCase() === "b23.tv") {
      const resolved = await resolveShortUrl(source, signal);
      return extractBilibiliVideoId(resolved);
    }
  } catch {
  }
  return "";
}

function parseDurationToSeconds(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return 0;
  }
  const parts = raw.split(":").map((item) => Number(item));
  if (parts.some((item) => !Number.isFinite(item))) {
    return 0;
  }
  return parts.reduce((total, current) => total * 60 + current, 0);
}

function clampPositiveInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function buildQualityLookupMap() {
  const map = new Map();
  for (const preset of BILIBILI_QUALITY_PRESETS) {
    map.set(String(preset.qn), preset);
    map.set(String(preset.label).toLowerCase(), preset);
    for (const alias of preset.aliases || []) {
      map.set(String(alias).toLowerCase(), preset);
    }
  }
  return map;
}

const BILIBILI_QUALITY_LOOKUP = buildQualityLookupMap();

export function normalizeBilibiliQuality(value, fallbackQn = 127) {
  if (value == null || value === "") {
    const fallback = BILIBILI_QUALITY_PRESETS.find((item) => item.qn === fallbackQn) || BILIBILI_QUALITY_PRESETS[0];
    return { qn: fallback.qn, label: fallback.label, explicit: false };
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const preset = BILIBILI_QUALITY_PRESETS.find((item) => item.qn === Math.floor(value));
    if (preset) {
      return { qn: preset.qn, label: preset.label, explicit: true };
    }
  }

  const raw = String(value || "").trim().toLowerCase();
  if (!raw || ["max", "best", "最高", "默认", "auto", "source"].includes(raw)) {
    const fallback = BILIBILI_QUALITY_PRESETS.find((item) => item.qn === fallbackQn) || BILIBILI_QUALITY_PRESETS[0];
    return { qn: fallback.qn, label: fallback.label, explicit: false };
  }

  const directHit = BILIBILI_QUALITY_LOOKUP.get(raw);
  if (directHit) {
    return { qn: directHit.qn, label: directHit.label, explicit: true };
  }

  const numeric = clampPositiveInteger(raw, 0);
  if (numeric) {
    const byQn = BILIBILI_QUALITY_PRESETS.find((item) => item.qn === numeric);
    if (byQn) {
      return { qn: byQn.qn, label: byQn.label, explicit: true };
    }
    const byHeight = new Map([
      [4320, 127],
      [2160, 120],
      [1080, 80],
      [720, 64],
      [480, 32],
      [360, 16]
    ]);
    const mappedQn = byHeight.get(numeric);
    const mappedPreset = BILIBILI_QUALITY_PRESETS.find((item) => item.qn === mappedQn);
    if (mappedPreset) {
      return { qn: mappedPreset.qn, label: mappedPreset.label, explicit: true };
    }
  }

  const fallback = BILIBILI_QUALITY_PRESETS.find((item) => item.qn === fallbackQn) || BILIBILI_QUALITY_PRESETS[0];
  return { qn: fallback.qn, label: fallback.label, explicit: true, requested: raw };
}

function resolveActualQuality(playData = {}, requestedQuality = { qn: 127, label: "8k", explicit: false }) {
  const currentQn = clampPositiveInteger(playData?.quality, 0);
  const dashQns = Array.isArray(playData?.dash?.video)
    ? playData.dash.video.map((item) => clampPositiveInteger(item?.id || item?.video_quality, 0)).filter(Boolean)
    : [];
  const availableQns = [...new Set([currentQn, ...dashQns].filter(Boolean))].sort((left, right) => right - left);
  const actualQn = currentQn
    || availableQns.find((item) => item === requestedQuality.qn)
    || availableQns.find((item) => item <= requestedQuality.qn)
    || availableQns[0]
    || requestedQuality.qn;
  const acceptQuality = Array.isArray(playData?.accept_quality) ? playData.accept_quality.map((item) => clampPositiveInteger(item, 0)) : [];
  const acceptDescription = Array.isArray(playData?.accept_description) ? playData.accept_description.map((item) => String(item || "").trim()) : [];
  const acceptIndex = acceptQuality.findIndex((item) => item === actualQn);
  const preset = normalizeBilibiliQuality(actualQn);
  const actualLabel = String(acceptDescription[acceptIndex] || preset.label || requestedQuality.label).trim();
  return {
    qn: actualQn,
    label: actualLabel,
    explicit: requestedQuality.explicit === true,
    requestedQn: requestedQuality.qn,
    requestedLabel: requestedQuality.label,
    downgraded: actualQn !== requestedQuality.qn
  };
}

function normalizeRequestedPage(options = {}, pages = []) {
  const requestedCid = clampPositiveInteger(options.cid || options.pageCid, 0);
  if (requestedCid) {
    const hit = pages.find((item) => Number(item?.cid || 0) === requestedCid);
    if (hit) {
      return { cid: requestedCid, page: clampPositiveInteger(hit.page, 1), explicit: true };
    }
  }
  const requestedPage = clampPositiveInteger(options.page || options.p, 0);
  if (requestedPage > 0) {
    return {
      page: Math.min(requestedPage, Math.max(pages.length, 1)),
      cid: 0,
      explicit: true
    };
  }
  return { page: 1, cid: 0, explicit: false };
}

export async function searchBilibiliVideoCandidates(query = "", options = {}) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    throw new Error("query is required");
  }
  const limit = Math.max(1, Math.min(Number(options.maxResults || 5), 10));
  let data = null;
  try {
    data = await fetchBilibiliJson("/x/web-interface/wbi/search/type", {
      params: {
        keyword: normalizedQuery,
        search_type: "video",
        page: 1,
        page_size: Math.max(limit * 2, 10)
      },
      signal: options.signal,
      sourceUrl: "https://www.bilibili.com/",
      useWbi: true
    });
  } catch {
    data = await fetchBilibiliJson("/x/web-interface/search/type", {
      params: {
        keyword: normalizedQuery,
        search_type: "video",
        page: 1,
        page_size: Math.max(limit * 2, 10)
      },
      signal: options.signal,
      sourceUrl: "https://www.bilibili.com/"
    });
  }
  const results = Array.isArray(data?.result) ? data.result : [];
  const videos = results
    .filter((item) => item?.bvid && item?.title)
    .map((item) => ({
      bvid: String(item.bvid || "").trim(),
      aid: Number(item.aid || item.id || 0),
      title: String(item.title || "").replace(/<[^>]+>/g, "").trim(),
      url: `https://www.bilibili.com/video/${String(item.bvid || "").trim()}`,
      snippet: String(item.description || item.desc || "").replace(/<[^>]+>/g, "").trim(),
      matchedQuery: normalizedQuery,
      owner: {
        name: String(item.author || item?.owner?.name || "").trim()
      },
      duration: parseDurationToSeconds(item.duration || ""),
      thumbnail: item.pic ? (String(item.pic).startsWith("//") ? `https:${String(item.pic).trim()}` : String(item.pic).trim()) : ""
    }))
    .slice(0, limit);
  return {
    query: normalizedQuery,
    searchedAt: new Date().toISOString(),
    resultCount: videos.length,
    results: videos,
    recommendedSource: videos[0]?.url || ""
  };
}

export async function getBilibiliVideoDetailByBvid(bvid = "", options = {}) {
  const normalizedBvid = extractBilibiliVideoId(bvid);
  if (!normalizedBvid) {
    throw new Error("bvid is required");
  }
  return fetchBilibiliJson("/x/web-interface/view", {
    params: { bvid: normalizedBvid },
    signal: options.signal,
    sourceUrl: `https://www.bilibili.com/video/${normalizedBvid}`
  });
}

export async function getBilibiliPlayData({ bvid = "", cid = 0, qn = 127, signal } = {}) {
  const normalizedBvid = extractBilibiliVideoId(bvid);
  const normalizedCid = Number(cid || 0);
  const normalizedQuality = normalizeBilibiliQuality(qn);
  if (!normalizedBvid || !normalizedCid) {
    throw new Error("bvid and cid are required");
  }
  return fetchBilibiliJson("/x/player/playurl", {
    params: {
      bvid: normalizedBvid,
      cid: normalizedCid,
      qn: normalizedQuality.qn,
      fourk: 1,
      fnval: 16 | 64 | 128 | 256 | 1024
    },
    signal,
    sourceUrl: `https://www.bilibili.com/video/${normalizedBvid}`
  });
}

function buildMetadataFromViewData(source = "", viewData = {}, options = {}) {
  const pages = (Array.isArray(viewData?.pages) ? viewData.pages : []).map((item, index) => ({
    page: index + 1,
    cid: Number(item?.cid || 0),
    title: String(item?.part || "").trim(),
    duration: Number(item?.duration || 0)
  }));
  const pageSelection = normalizeRequestedPage(options, pages);
  const selectedPage = pageSelection.cid
    ? pages.find((item) => item.cid === pageSelection.cid)
    : pages[Math.max(0, Math.min(pages.length - 1, pageSelection.page - 1))] || pages[0] || {};
  const bvid = extractBilibiliVideoId(viewData?.bvid || source);
  const baseTitle = String(viewData?.title || "").trim();
  const selectedPageIndex = clampPositiveInteger(selectedPage?.page || pageSelection.page || 1, 1);
  const selectedPageTitle = String(selectedPage?.title || "").trim();
  const displayTitle = pages.length > 1 && selectedPageTitle
    ? `${baseTitle} - P${selectedPageIndex} ${selectedPageTitle}`.trim()
    : baseTitle;
  const webpageUrl = new URL(bvid ? `https://www.bilibili.com/video/${bvid}` : String(source || "").trim() || "https://www.bilibili.com/");
  if (pages.length > 1 && selectedPageIndex > 1) {
    webpageUrl.searchParams.set("p", String(selectedPageIndex));
  }
  return {
    id: bvid,
    aid: Number(viewData?.aid || 0),
    cid: Number(selectedPage?.cid || 0),
    title: displayTitle,
    videoTitle: baseTitle,
    webpage_url: webpageUrl.toString(),
    thumbnail: String(viewData?.pic || "").trim(),
    duration: Number(selectedPage?.duration || viewData?.duration || 0),
    owner: {
      name: String(viewData?.owner?.name || "").trim()
    },
    page: {
      index: selectedPageIndex,
      cid: Number(selectedPage?.cid || 0),
      title: selectedPageTitle,
      duration: Number(selectedPage?.duration || 0),
      explicit: pageSelection.explicit === true
    },
    pages
  };
}

export async function getBilibiliVideoMetadataFromSource(source = "", options = {}) {
  const bvid = await resolveBilibiliVideoIdFromSource(source, options.signal);
  if (!bvid) {
    throw new Error("could not resolve bilibili video id from source");
  }
  const viewData = await getBilibiliVideoDetailByBvid(bvid, { signal: options.signal });
  return buildMetadataFromViewData(source, viewData, options);
}

export async function getBilibiliVideoBundleFromSource(source = "", options = {}) {
  const bvid = await resolveBilibiliVideoIdFromSource(source, options.signal);
  if (!bvid) {
    throw new Error("could not resolve bilibili video id from source");
  }
  const viewData = await getBilibiliVideoDetailByBvid(bvid, { signal: options.signal });
  const requestedQuality = normalizeBilibiliQuality(options.quality ?? options.qn);
  const metadata = buildMetadataFromViewData(source, viewData, options);
  const playData = metadata.cid
    ? await getBilibiliPlayData({ bvid, cid: metadata.cid, qn: requestedQuality.qn, signal: options.signal })
    : null;
  metadata.selectedQuality = resolveActualQuality(playData, requestedQuality);
  return {
    metadata,
    playData,
    viewData,
    request: {
      page: Number(metadata?.page?.index || 1),
      cid: Number(metadata?.cid || 0),
      qn: requestedQuality.qn,
      quality: requestedQuality.label,
      explicitPage: metadata?.page?.explicit === true,
      explicitQuality: requestedQuality.explicit === true
    }
  };
}