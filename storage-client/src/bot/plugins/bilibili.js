import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setMaxListeners } from "node:events";
import { createBotJobMessageId } from "../context.js";
import {
  BILIBILI_USER_AGENT,
  extractBilibiliVideoId,
  generateBilibiliLoginQr,
  getBilibiliLoggedInUser,
  getBilibiliRequestHeaders,
  getBilibiliVideoBundleFromSource,
  normalizeBilibiliQuality,
  pollBilibiliLoginQr
} from "../tools/bilibiliApi.js";
import { readChatHistoryDay } from "../tools/chatHistory.js";
import { importFileIntoLibrary, triggerLibraryRescan } from "../tools/libraryImport.js";
import { launchPlaywrightBrowser, loadPlaywrightChromium } from "../tools/playwright.js";
import { createBotPlugin } from "./base.js";

const ytDlpPath = process.env.YT_DLP_PATH || "yt-dlp";
const bilibiliImportDir = process.env.BOT_BILIBILI_IMPORT_DIR ?? "";
const bilibiliDownloadBackend = String(process.env.BOT_BILIBILI_DOWNLOAD_BACKEND || "playwright").trim().toLowerCase();
const BILIBILI_AUTH_FILE_NAME = "bilibili-auth.json";
const BILIBILI_COOKIE_FILE_NAME = "bilibili-cookies.json";
const BILIBILI_QR_POLL_INTERVAL_MS = 2000;
const BILIBILI_QR_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function canonicalizeBilibiliVideoId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  return `bvid:${raw.toLowerCase()}`;
}

function normalizeBilibiliSource(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  const videoId = extractBilibiliVideoId(raw);
  if (videoId) {
    return `https://www.bilibili.com/video/${videoId}`;
  }
  return raw;
}

function resolveBilibiliAction(context = {}) {
  const parsedAction = String(context?.trigger?.parsedArgs?.action || "").trim().toLowerCase();
  const mappedParsedAction = new Map([
    ["login", "login"],
    ["登录", "login"],
    ["relogin", "relogin"],
    ["重新登录", "relogin"],
    ["logout", "logout"],
    ["退出", "logout"],
    ["status", "status"],
    ["状态", "status"]
  ]).get(parsedAction);
  if (mappedParsedAction) {
    return mappedParsedAction;
  }
  const rawText = String(context?.trigger?.rawText || "");
  const match = rawText.match(/(?:^|\s)@\s*(?:bili|bilibili)\s+(login|logout|status|登录|退出|状态|relogin|重新登录)(?=\s|$)/i);
  if (!match?.[1]) {
    return "download";
  }
  return new Map([
    ["login", "login"],
    ["登录", "login"],
    ["relogin", "relogin"],
    ["重新登录", "relogin"],
    ["logout", "logout"],
    ["退出", "logout"],
    ["status", "status"],
    ["状态", "status"]
  ]).get(String(match[1]).toLowerCase()) || "download";
}

function resolveCardActionLabel(context = {}) {
  return String(context?.trigger?.parsedArgs?.__actionLabel || "").trim();
}

function shouldReplaceCurrentChatMessage(context = {}) {
  return String(context?.chat?.replyMode || "").trim() === "replace-chat-message"
    && String(context?.chat?.messageId || "").trim() !== "";
}

function getBilibiliReplyMessageId(context = {}) {
  if (shouldReplaceCurrentChatMessage(context)) {
    return String(context?.chat?.messageId || "").trim();
  }
  return createBotJobMessageId(context.jobId);
}

function hasMeaningfulTriggerPayload(context = {}) {
  const rawText = String(context?.trigger?.rawText || "").trim();
  if (rawText) {
    return true;
  }
  const parsedArgs = context?.trigger?.parsedArgs && typeof context.trigger.parsedArgs === "object"
    ? context.trigger.parsedArgs
    : {};
  return Object.keys(parsedArgs).some((key) => key !== "__actionLabel");
}

function getBilibiliCookieStorePath(appDataRoot = "") {
  const explicit = String(process.env.BOT_BILIBILI_COOKIE_FILE || "").trim();
  return explicit || path.join(String(appDataRoot || ""), BILIBILI_COOKIE_FILE_NAME);
}

function getBilibiliAuthStatePath(appDataRoot = "") {
  return path.join(String(appDataRoot || ""), BILIBILI_AUTH_FILE_NAME);
}

async function readBilibiliAuthState(appDataRoot = "") {
  try {
    const raw = await fs.promises.readFile(getBilibiliAuthStatePath(appDataRoot), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeBilibiliAuthState(appDataRoot = "", payload = {}) {
  await fs.promises.mkdir(String(appDataRoot || ""), { recursive: true });
  await fs.promises.writeFile(getBilibiliAuthStatePath(appDataRoot), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function persistBilibiliAuth(api, cookies = [], user = null) {
  const cookieFilePath = getBilibiliCookieStorePath(api.appDataRoot);
  await fs.promises.mkdir(path.dirname(cookieFilePath), { recursive: true });
  await fs.promises.writeFile(cookieFilePath, `${JSON.stringify(cookies, null, 2)}\n`, "utf8");
  const cookieMap = new Map(cookies.map((item) => [String(item?.name || ""), String(item?.value || "")]));
  process.env.BOT_BILIBILI_COOKIE_FILE = cookieFilePath;
  process.env.BOT_BILIBILI_COOKIE_HEADER = "";
  process.env.BOT_BILIBILI_SESSDATA = cookieMap.get("SESSDATA") || "";
  process.env.BOT_BILIBILI_BUVID3 = cookieMap.get("buvid3") || process.env.BOT_BILIBILI_BUVID3 || "";
  process.env.BOT_BILIBILI_DEDEUSERID = cookieMap.get("DedeUserID") || "";
  process.env.BOT_BILIBILI_BILI_JCT = cookieMap.get("bili_jct") || "";
  await writeBilibiliAuthState(api.appDataRoot, {
    isLoggedIn: true,
    updatedAt: new Date().toISOString(),
    cookieFilePath,
    user: user && typeof user === "object" ? user : null
  });
  return cookieFilePath;
}

async function clearBilibiliAuth(api) {
  const cookieFilePath = getBilibiliCookieStorePath(api.appDataRoot);
  await Promise.all([
    fs.promises.rm(cookieFilePath, { force: true }).catch(() => {}),
    fs.promises.rm(getBilibiliAuthStatePath(api.appDataRoot), { force: true }).catch(() => {})
  ]);
  process.env.BOT_BILIBILI_COOKIE_FILE = "";
  process.env.BOT_BILIBILI_COOKIE_HEADER = "";
  process.env.BOT_BILIBILI_SESSDATA = "";
  process.env.BOT_BILIBILI_BUVID3 = "";
  process.env.BOT_BILIBILI_DEDEUSERID = "";
  process.env.BOT_BILIBILI_BILI_JCT = "";
}

async function resolveBilibiliUserProfile(api) {
  const remote = await getBilibiliLoggedInUser({ signal: api.signal });
  if (remote) {
    await writeBilibiliAuthState(api.appDataRoot, {
      ...(await readBilibiliAuthState(api.appDataRoot)),
      isLoggedIn: true,
      updatedAt: new Date().toISOString(),
      cookieFilePath: getBilibiliCookieStorePath(api.appDataRoot),
      user: remote
    });
    return remote;
  }
  const cached = await readBilibiliAuthState(api.appDataRoot);
  if (cached?.isLoggedIn) {
    // Cookie has expired: remote check returned null despite local state saying logged-in.
    // Mark the state as logged-out so future callers don't get a stale cached identity.
    await writeBilibiliAuthState(api.appDataRoot, {
      ...cached,
      isLoggedIn: false,
      updatedAt: new Date().toISOString()
    }).catch(() => {});
  }
  return null;
}

function buildBilibiliAuthAction(label = "", action = "status", extraArgs = {}) {
  return {
    type: "invoke-bot",
    label: String(label || "").trim(),
    botId: "bilibili.downloader",
    rawText: `@bili ${action}`,
    parsedArgs: {
      action,
      __chatReplyMode: "replace-chat-message",
      ...(extraArgs && typeof extraArgs === "object" ? extraArgs : {})
    }
  };
}

function buildBilibiliAuthCard({ status = "info", title = "Bilibili 登录", subtitle = "", body = "", imageUrl = "", imageFit = "cover", sourceUrl = "", actions = [] } = {}) {
  return {
    type: "media-result",
    status,
    title: String(title || "Bilibili 登录").trim(),
    subtitle: String(subtitle || "").trim(),
    body: String(body || "").trim(),
    progress: null,
    imageUrl: String(imageUrl || "").trim(),
    imageFit: String(imageFit || "cover").trim(),
    imageAlt: String(title || "Bilibili 登录").trim(),
    mediaAttachmentId: "",
    sourceLabel: sourceUrl ? "打开登录链接" : "",
    sourceUrl: String(sourceUrl || "").trim(),
    actions: Array.isArray(actions) ? actions : []
  };
}

function buildBilibiliUserSummary(user = null, { includeStorageHint = false } = {}) {
  if (!user || typeof user !== "object") {
    return includeStorageHint ? "登录后无需再手动配置 Cookie。" : "";
  }
  const lines = [
    `当前账号：${String(user.uname || "未命名账号").trim() || "未命名账号"}`,
    `账号等级：Lv.${clampPositiveInteger(user.level, 0) || 0}`
  ];
  if (includeStorageHint) {
    lines.push("登录态已保存到本地，后续下载和搜索会自动复用。")
  }
  return lines.join("\n");
}

function buildBilibiliLoginGuideCard({ source = "", metadata = {}, targetFolder = "", downloadOptions = {}, maxAvailableQuality = null } = {}) {
  const videoTitle = String(metadata?.videoTitle || metadata?.title || "Bilibili 下载").trim();
  const requestedQuality = normalizeBilibiliQuality(downloadOptions?.quality || metadata?.selectedQuality?.requestedLabel || "", maxAvailableQuality?.qn || 127);
  const fallbackQuality = maxAvailableQuality && maxAvailableQuality.qn
    ? { qn: maxAvailableQuality.qn, label: String(maxAvailableQuality.label || `QN ${maxAvailableQuality.qn}`).trim() }
    : null;
  const bodyLines = [
    `你当前请求的是 ${requestedQuality.label}，但这个清晰度通常需要先登录 Bilibili 才能获取。`
  ];
  if (fallbackQuality) {
    bodyLines.push(`未登录时当前最多可直接下载：${fallbackQuality.label}`);
  }
  bodyLines.push("完成扫码后，重新发起当前下载即可直接复用登录态。");
  const actions = [buildBilibiliAuthAction("扫码登录", "login", {
    source,
    sourceUrl: source,
    targetFolder,
    page: metadata?.page?.index || downloadOptions?.page || undefined,
    quality: downloadOptions?.quality || undefined
  })];
  return buildBilibiliAuthCard({
    status: "info",
    title: "需要登录后再获取更高清晰度",
    subtitle: [videoTitle, requestedQuality.label].filter(Boolean).join(" · "),
    body: bodyLines.join("\n"),
    imageUrl: String(metadata?.thumbnail || metadata?.pic || "").trim(),
    sourceUrl: String(metadata?.webpage_url || source || "").trim(),
    actions
  });
}

async function waitWithSignal(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      reject(Object.assign(new Error("job cancelled"), { name: "AbortError" }));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function handleBilibiliStatus(context, api) {
  const user = await resolveBilibiliUserProfile(api);
  const card = user
    ? buildBilibiliAuthCard({
      status: "succeeded",
      title: "Bilibili 已登录",
      subtitle: [user.uname || "已登录", user.level ? `Lv.${user.level}` : ""].filter(Boolean).join(" · "),
      body: buildBilibiliUserSummary(user, { includeStorageHint: true }),
      imageUrl: String(user.face || "").trim(),
      actions: [buildBilibiliAuthAction("重新登录", "relogin"), buildBilibiliAuthAction("退出登录", "logout")]
    })
    : buildBilibiliAuthCard({
      status: "info",
      title: "Bilibili 未登录",
      body: "当前没有可用的 Bilibili 登录态。登录后无需再手动配置 Cookie。",
      actions: [buildBilibiliAuthAction("扫码登录", "login")]
    });
  const chatReply = await api.publishChatReply({
    id: getBilibiliReplyMessageId(context),
    createdAt: context.createdAt,
    text: "",
    attachments: [],
    card
  });
  return { chatReply, importedFiles: [], artifacts: [] };
}

async function handleBilibiliLogout(context, api) {
  await clearBilibiliAuth(api);
  const chatReply = await api.publishChatReply({
    id: getBilibiliReplyMessageId(context),
    createdAt: context.createdAt,
    text: "",
    attachments: [],
    card: buildBilibiliAuthCard({
      status: "succeeded",
      title: "Bilibili 已退出登录",
      body: "本地保存的登录态已经清除。",
      actions: [buildBilibiliAuthAction("重新登录", "login")]
    })
  });
  return { chatReply, importedFiles: [], artifacts: [] };
}

async function handleBilibiliLogin(context, api, { force = false } = {}) {
  if (!force) {
    const currentUser = await resolveBilibiliUserProfile(api);
    if (currentUser) {
      return handleBilibiliStatus(context, api);
    }
  }

  if (api.signal) {
    setMaxListeners(0, api.signal);
  }
  const qr = await generateBilibiliLoginQr({ signal: api.signal });
  const qrPollCookieHeader = String(qr?.cookieHeader || "").trim();
  const messageId = getBilibiliReplyMessageId(context);
  const resumeSource = normalizeBilibiliSource(String(
    context?.trigger?.parsedArgs?.source
    || context?.trigger?.parsedArgs?.sourceUrl
    || ""
  ).trim());
  const resumeTargetFolder = String(context?.trigger?.parsedArgs?.targetFolder || "").trim();
  const resumePage = clampPositiveInteger(context?.trigger?.parsedArgs?.page || context?.trigger?.parsedArgs?.p, 0);
  const resumeQuality = String(context?.trigger?.parsedArgs?.quality || context?.trigger?.parsedArgs?.qn || "").trim();
  const resumeAction = resumeSource
    ? buildBilibiliInvokeAction(
      `继续下载 ${normalizeBilibiliQuality(resumeQuality || "64", 127).label}`,
      {
        source: resumeSource,
        targetFolder: resumeTargetFolder,
        page: resumePage,
        quality: resumeQuality
      }
    )
    : null;
  const waitingCard = buildBilibiliAuthCard({
    status: "info",
    title: "Bilibili 扫码登录",
    subtitle: "等待扫码",
    body: "请使用哔哩哔哩 App 扫描二维码。二维码有效期约 10 分钟。",
    imageUrl: qr.imageUrl,
    imageFit: "contain",
    sourceUrl: qr.loginUrl,
    actions: [
      { type: "open-url", label: "打开二维码链接", url: qr.loginUrl },
      { type: "cancel-bot-job", label: "停止轮询" }
    ]
  });
  await api.publishChatReply({
    id: messageId,
    createdAt: context.createdAt,
    text: "",
    attachments: [],
    card: waitingCard
  });

  const startedAt = Date.now();
  let hasScanned = false;
  while (Date.now() - startedAt < BILIBILI_QR_LOGIN_TIMEOUT_MS) {
    api.throwIfCancelled?.();
    const result = await pollBilibiliLoginQr(qr.qrcodeKey, {
      signal: api.signal,
      cookieHeader: qrPollCookieHeader
    });
    if (result.code === 86101) {
      await waitWithSignal(BILIBILI_QR_POLL_INTERVAL_MS, api.signal);
      continue;
    }
    if (result.code === 86090) {
      hasScanned = true;
      await api.publishTransientChatReply({
        id: messageId,
        createdAt: context.createdAt,
        text: "",
        attachments: [],
        card: buildBilibiliAuthCard({
          status: "info",
          title: "Bilibili 扫码登录",
          subtitle: "已扫码，等待手机确认",
          body: "二维码已被扫描，请在手机上的哔哩哔哩 App 内确认登录。",
          imageUrl: qr.imageUrl,
          imageFit: "contain",
          sourceUrl: qr.loginUrl,
          actions: [{ type: "open-url", label: "打开二维码链接", url: qr.loginUrl }]
        })
      });
      await waitWithSignal(BILIBILI_QR_POLL_INTERVAL_MS, api.signal);
      continue;
    }
    if (result.code === 86038) {
      const chatReply = await api.publishChatReply({
        id: messageId,
        createdAt: context.createdAt,
        text: "",
        attachments: [],
        card: buildBilibiliAuthCard({
          status: "failed",
          title: "Bilibili 登录二维码已过期",
          body: "二维码已失效，请重新生成并扫码。",
          actions: [buildBilibiliAuthAction("重新生成二维码", "login")]
        })
      });
      return { chatReply, importedFiles: [], artifacts: [] };
    }
    if (result.code === 0 && Array.isArray(result.cookies) && result.cookies.length) {
      const cookieFilePath = await persistBilibiliAuth(api, result.cookies, null);
      await api.appendLog(`bilibili login saved: ${cookieFilePath}`);
      const user = await resolveBilibiliUserProfile(api);
      const chatReply = await api.publishChatReply({
        id: messageId,
        createdAt: context.createdAt,
        text: "",
        attachments: [],
        card: buildBilibiliAuthCard({
          status: "succeeded",
          title: "Bilibili 登录成功",
          subtitle: [user?.uname || "已登录", user?.level ? `Lv.${user.level}` : ""].filter(Boolean).join(" · "),
          body: buildBilibiliUserSummary(user, { includeStorageHint: true }),
          imageUrl: String(user?.face || "").trim(),
          actions: [
            ...(resumeAction ? [resumeAction] : []),
            buildBilibiliAuthAction("一键重新登录", "relogin", resumeSource ? {
              source: resumeSource,
              sourceUrl: resumeSource,
              targetFolder: resumeTargetFolder,
              page: resumePage || undefined,
              quality: resumeQuality || undefined
            } : {}),
            buildBilibiliAuthAction("查看状态", "status"),
            buildBilibiliAuthAction("退出登录", "logout")
          ]
        })
      });
      return { chatReply, importedFiles: [], artifacts: [] };
    }
    await api.appendLog(`bilibili login poll code: ${result.code}; rawCode=${String(result.debug?.rawCode ?? "")}; message=${result.message || ""}; keys=${Array.isArray(result.debug?.keys) ? result.debug.keys.join(",") : ""}; hasCode=${result.debug?.hasCode === true}`);
    await waitWithSignal(BILIBILI_QR_POLL_INTERVAL_MS, api.signal);
  }

  const chatReply = await api.publishChatReply({
    id: messageId,
    createdAt: context.createdAt,
    text: "",
    attachments: [],
    card: buildBilibiliAuthCard({
      status: "failed",
      title: "Bilibili 登录超时",
      body: "二维码等待超时，请重新生成后再试。",
      actions: [buildBilibiliAuthAction("重新生成二维码", "login")]
    })
  });
  return { chatReply, importedFiles: [], artifacts: [] };
}

function isSupportedBilibiliSource(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return false;
  }
  if (/^BV[0-9A-Za-z]+$/i.test(raw)) {
    return true;
  }
  try {
    const url = new URL(raw);
    const hostname = String(url.hostname || "").toLowerCase();
    return hostname === "b23.tv" || hostname === "bilibili.com" || hostname === "www.bilibili.com" || hostname.endsWith(".bilibili.com");
  } catch {
    return false;
  }
}

function sanitizeImportFolder(value = "") {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.\./g, "").replace(/\/+/g, "/");
}

function sanitizeTempName(value = "", fallback = "bilibili") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "");
  return cleaned || fallback;
}

function clampPositiveInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function guessFileExtension(url = "", fallback = ".bin") {
  try {
    const pathname = new URL(url).pathname || "";
    return path.extname(pathname) || fallback;
  } catch {
    return fallback;
  }
}

function formatDurationLabel(durationSeconds = 0) {
  const seconds = Math.max(0, Math.floor(Number(durationSeconds || 0)));
  if (!seconds) {
    return "";
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainSeconds = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainSeconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainSeconds).padStart(2, "0")}`;
}

function normalizeQualityText(value = "") {
  return String(value || "").trim().toLowerCase();
}

function parseInlineDownloadOptions(rawText = "") {
  const text = String(rawText || "");
  const pageMatch = text.match(/(?:^|\s)(?:p|page|分p)\s*[=:]?\s*(\d{1,3})(?=\s|$)/i)
    || text.match(/(?:^|\s)P(\d{1,3})(?=\s|$)/);
  const qualityMatch = text.match(/(?:^|\s)(?:quality|qn|清晰度)\s*[=:]?\s*([^\s]+)/i);
  const folderMatch = text.match(/(?:^|\s)(?:folder|dir|保存到|路径)\s*[=:]?\s*([^\s]+)/i);
  return {
    page: clampPositiveInteger(pageMatch?.[1], 0),
    quality: String(qualityMatch?.[1] || "").trim(),
    targetFolder: String(folderMatch?.[1] || "").trim()
  };
}

function resolveDownloadOptions(context = {}) {
  const parsedArgs = context?.trigger?.parsedArgs && typeof context.trigger.parsedArgs === "object"
    ? context.trigger.parsedArgs
    : {};
  const inlineOptions = parseInlineDownloadOptions(context?.trigger?.rawText || "");
  const page = clampPositiveInteger(parsedArgs.page || parsedArgs.p || inlineOptions.page, 0);
  const quality = String(parsedArgs.quality || parsedArgs.qn || inlineOptions.quality || "").trim();
  const targetFolder = String(parsedArgs.targetFolder || inlineOptions.targetFolder || "").trim();
  return {
    page,
    quality,
    targetFolder,
    hasExplicitPage: page > 0,
    hasExplicitQuality: Boolean(quality)
  };
}

function resolveSelectionViewOptions(context = {}) {
  const parsedArgs = context?.trigger?.parsedArgs && typeof context.trigger.parsedArgs === "object"
    ? context.trigger.parsedArgs
    : {};
  return {
    pageWindowStart: clampPositiveInteger(parsedArgs.pageWindowStart || parsedArgs.pageGroupStart, 1) || 1
  };
}

function buildSelectionLabel(metadata = {}, downloadOptions = {}) {
  const parts = [];
  const pageIndex = Number(metadata?.page?.index || downloadOptions?.page || 0);
  if (pageIndex > 0) {
    parts.push(`P${pageIndex}`);
  }
  const actualQualityLabel = String(metadata?.selectedQuality?.label || "").trim();
  const requestedQualityLabel = String(metadata?.selectedQuality?.requestedLabel || downloadOptions?.quality || "").trim();
  const qualityLabel = actualQualityLabel || requestedQualityLabel;
  if (qualityLabel) {
    parts.push(metadata?.selectedQuality?.downgraded && requestedQualityLabel && requestedQualityLabel !== qualityLabel
      ? `${qualityLabel} (请求 ${requestedQualityLabel})`
      : qualityLabel);
  }
  return parts.join(" · ");
}

function hasSpecificSelection(downloadOptions = {}) {
  return downloadOptions?.hasExplicitPage === true || downloadOptions?.hasExplicitQuality === true;
}

function buildBilibiliInvokeAction(label = "", { source = "", sourceUrl = "", targetFolder = "", page = 0, quality = "", pageWindowStart = 0 } = {}) {
  const resolvedSource = String(source || sourceUrl || "").trim();
  const parsedArgs = {
    __chatReplyMode: "replace-chat-message",
    source: resolvedSource,
    sourceUrl: resolvedSource || undefined,
    targetFolder: String(targetFolder || "").trim(),
    page: clampPositiveInteger(page, 0) || undefined,
    quality: String(quality || "").trim() || undefined,
    pageWindowStart: clampPositiveInteger(pageWindowStart, 0) || undefined
  };
  return {
    type: "invoke-bot",
    label: String(label || "").trim(),
    botId: "bilibili.downloader",
    rawText: resolvedSource,
    parsedArgs
  };
}

function listAvailableQualities(metadata = {}) {
  const playData = metadata?.__bilibiliApi?.playData || {};
  const qualities = Array.isArray(playData?.accept_quality) ? playData.accept_quality : [];
  const descriptions = Array.isArray(playData?.accept_description) ? playData.accept_description : [];
  const items = [];
  for (let index = 0; index < qualities.length; index += 1) {
    const qn = clampPositiveInteger(qualities[index], 0);
    if (!qn) {
      continue;
    }
    items.push({
      qn,
      label: String(descriptions[index] || `QN ${qn}`).trim(),
      value: String(qn)
    });
  }
  const unique = new Map();
  for (const item of items) {
    if (!unique.has(String(item.qn))) {
      unique.set(String(item.qn), item);
    }
  }
  return [...unique.values()];
}

function summarizePages(pages = []) {
  const lines = [];
  for (const page of pages) {
    const duration = formatDurationLabel(page?.duration || 0);
    lines.push(`${page.page}. ${String(page?.title || `P${page.page}`).trim()}${duration ? ` · ${duration}` : ""}`);
  }
  return lines;
}

function buildBilibiliSelectionCard({ stage = "page", source = "", metadata = {}, targetFolder = "", downloadOptions = {}, viewOptions = {} } = {}) {
  const baseTitle = String(metadata?.videoTitle || metadata?.title || "Bilibili 下载").trim();
  const uploader = String(metadata?.owner?.name || "").trim();
  const durationLabel = formatDurationLabel(metadata?.duration || 0);
  const imageUrl = String(metadata?.thumbnail || metadata?.pic || "").trim();
  const actionSource = String(source || metadata?.webpage_url || "").trim();
  const bodyLines = [];
  const actions = [];

  if (stage === "page") {
    const pages = Array.isArray(metadata?.pages) ? metadata.pages : [];
    const pageWindowSize = 8;
    const maxStart = Math.max(1, pages.length - pageWindowSize + 1);
    const windowStart = Math.min(Math.max(1, clampPositiveInteger(viewOptions.pageWindowStart, 1)), maxStart);
    const windowEnd = Math.min(pages.length, windowStart + pageWindowSize - 1);
    const visiblePages = pages.slice(windowStart - 1, windowEnd);
    bodyLines.push(`检测到 ${pages.length} 个分P，请先选择要下载的分P。`);
    bodyLines.push("");
    bodyLines.push(`当前显示：第 ${windowStart}-${windowEnd} 个分P`);
    bodyLines.push("");
    bodyLines.push("当前页分P：");
    bodyLines.push(...summarizePages(visiblePages));
    for (const page of visiblePages) {
      actions.push(buildBilibiliInvokeAction(`P${page.page}`, {
        source: actionSource,
        targetFolder,
        page: page.page,
        quality: downloadOptions.quality
      }));
    }
    if (windowStart > 1) {
      actions.push(buildBilibiliInvokeAction("上一组", {
        source: actionSource,
        targetFolder,
        quality: downloadOptions.quality,
        pageWindowStart: Math.max(1, windowStart - pageWindowSize)
      }));
    }
    if (windowEnd < pages.length) {
      actions.push(buildBilibiliInvokeAction("下一组", {
        source: actionSource,
        targetFolder,
        quality: downloadOptions.quality,
        pageWindowStart: windowStart + pageWindowSize
      }));
    }
    if (pages.length > pageWindowSize) {
      bodyLines.push("");
      bodyLines.push(`也可以直接发送：@bili ${actionSource} p=11`);
    }
    return {
      type: "media-result",
      status: "info",
      title: `${baseTitle}`,
      subtitle: [uploader, durationLabel, `${pages.length} 个分P`, `${windowStart}-${windowEnd}`].filter(Boolean).join(" · "),
      body: bodyLines.join("\n"),
      progress: null,
      imageUrl,
      imageAlt: baseTitle,
      mediaAttachmentId: "",
      sourceLabel: String(metadata?.webpage_url || actionSource || "").trim(),
      sourceUrl: String(metadata?.webpage_url || actionSource || "").trim(),
      actions
    };
  }

  const pageLabel = Number(metadata?.page?.index || 0) > 0
    ? `P${Number(metadata.page.index)} ${String(metadata?.page?.title || "").trim()}`.trim()
    : "";
  const qualities = listAvailableQualities(metadata);
  bodyLines.push("请再选择清晰度，然后开始下载。\n");
  bodyLines.push(`当前分P：${pageLabel || "P1"}`);
  bodyLines.push("");
  bodyLines.push("可用清晰度：");
  for (const item of qualities) {
    bodyLines.push(`- ${item.label}`);
    actions.push(buildBilibiliInvokeAction(item.label, {
      source: actionSource,
      targetFolder,
      page: metadata?.page?.index,
      quality: item.value
    }));
  }
  return {
    type: "media-result",
    status: "info",
    title: `${baseTitle}`,
    subtitle: [uploader, durationLabel, pageLabel].filter(Boolean).join(" · "),
    body: bodyLines.join("\n"),
    progress: null,
    imageUrl,
    imageAlt: baseTitle,
    mediaAttachmentId: "",
    sourceLabel: String(metadata?.webpage_url || actionSource || "").trim(),
    sourceUrl: String(metadata?.webpage_url || actionSource || "").trim(),
    actions
  };
}

async function buildMediaHeaders(sourceUrl, userAgent = "", cookieHeader = "") {
  const headers = await getBilibiliRequestHeaders({
    sourceUrl,
    userAgent: userAgent || BILIBILI_USER_AGENT,
    cookieHeader
  });
  headers.Accept = "*/*";
  return headers;
}

function buildCookieHeader(cookies = []) {
  return cookies.filter((cookie) => cookie?.name).map((cookie) => `${cookie.name}=${cookie.value || ""}`).join("; ");
}

function buildSourceKeys(source, metadata = {}, downloadOptions = {}) {
  const keys = new Set();
  const sourceText = String(source || "").trim();
  const webpageUrl = String(metadata?.webpage_url || "").trim();
  const originalUrl = String(metadata?.original_url || "").trim();
  const videoId = String(metadata?.id || extractBilibiliVideoId(sourceText) || extractBilibiliVideoId(webpageUrl) || extractBilibiliVideoId(originalUrl)).trim();
  const pageIndex = clampPositiveInteger(metadata?.page?.index || downloadOptions?.page, 0);
  const cid = clampPositiveInteger(metadata?.cid || 0, 0);
  const qualityKey = normalizeQualityText(metadata?.selectedQuality?.label || metadata?.selectedQuality?.qn || downloadOptions?.quality || "");
  const selectionKeyBase = videoId || sourceText || webpageUrl || originalUrl;

  if (selectionKeyBase) {
    if (pageIndex > 0) {
      keys.add(`variant:${selectionKeyBase}:page:${pageIndex}`);
    }
    if (cid > 0) {
      keys.add(`variant:${selectionKeyBase}:cid:${cid}`);
    }
    if (qualityKey) {
      keys.add(`variant:${selectionKeyBase}:quality:${qualityKey}`);
    }
    if ((pageIndex > 0 || cid > 0) && qualityKey) {
      keys.add(`variant:${selectionKeyBase}:${cid || pageIndex}:${qualityKey}`);
    }
  }

  if (sourceText) {
    keys.add(`source:${sourceText}`);
  }
  if (webpageUrl) {
    keys.add(`url:${webpageUrl}`);
  }
  if (originalUrl) {
    keys.add(`url:${originalUrl}`);
  }
  if (videoId) {
    keys.add(canonicalizeBilibiliVideoId(videoId));
  }
  return [...keys];
}

async function readReuseIndex(appDataRoot) {
  const indexPath = path.join(appDataRoot, "bilibili-cache.json");
  try {
    const raw = await fs.promises.readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeReuseIndex(appDataRoot, index) {
  const indexPath = path.join(appDataRoot, "bilibili-cache.json");
  await fs.promises.mkdir(appDataRoot, { recursive: true });
  await fs.promises.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
}

async function findReusableImport({ appDataRoot, storageRoot, targetFolder, source, metadata, downloadOptions }) {
  const allKeys = buildSourceKeys(source, metadata, downloadOptions);
  const keys = hasSpecificSelection(downloadOptions)
    ? allKeys.filter((key) => key.startsWith("variant:"))
    : allKeys;
  const index = await readReuseIndex(appDataRoot);
  for (const key of keys) {
    const hit = index?.[key];
    const relativePath = String(hit?.relativePath || "").trim();
    if (!relativePath) {
      continue;
    }
    const absolutePath = path.join(storageRoot, relativePath.replace(/\//g, path.sep));
    try {
      const stat = await fs.promises.stat(absolutePath);
      return {
        absolutePath,
        relativePath,
        fileName: path.basename(absolutePath),
        size: Number(stat.size || 0),
        mimeType: String(hit?.mimeType || "application/octet-stream")
      };
    } catch {
    }
  }

  const videoId = String(metadata?.id || "").trim() || extractBilibiliVideoId(source);
  if (!videoId || hasSpecificSelection(downloadOptions)) {
    return null;
  }
  const targetDir = path.join(storageRoot, sanitizeImportFolder(targetFolder || bilibiliImportDir));
  try {
    const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.includes(`[${videoId}]`)) {
        continue;
      }
      const absolutePath = path.join(targetDir, entry.name);
      const stat = await fs.promises.stat(absolutePath);
      return {
        absolutePath,
        relativePath: path.relative(storageRoot, absolutePath).split(path.sep).join("/"),
        fileName: entry.name,
        size: Number(stat.size || 0),
        mimeType: "application/octet-stream"
      };
    }
  } catch {
  }
  return null;
}

async function rememberImportedResult({ appDataRoot, source, metadata, imported, downloadOptions }) {
  const allKeys = buildSourceKeys(source, metadata, downloadOptions);
  const keys = hasSpecificSelection(downloadOptions)
    ? allKeys.filter((key) => key.startsWith("variant:"))
    : allKeys;
  if (!keys.length || !imported?.relativePath) {
    return;
  }
  const index = await readReuseIndex(appDataRoot);
  for (const key of keys) {
    index[key] = {
      relativePath: String(imported.relativePath || ""),
      mimeType: String(imported.mimeType || "application/octet-stream"),
      updatedAt: new Date().toISOString()
    };
  }
  await writeReuseIndex(appDataRoot, index);
}

async function resolveSourceFromChatMessage(context, api) {
  const historyPath = String(context?.chat?.historyPath || "").trim();
  const messageId = String(context?.chat?.messageId || "").trim();
  const actionLabel = resolveCardActionLabel(context);
  if (!historyPath || !messageId) {
    return "";
  }
  try {
    const history = await readChatHistoryDay({
      storageRoot: api.storageRoot,
      historyPath
    });
    const matchingMessages = Array.isArray(history?.messages)
      ? history.messages.filter((message) => String(message?.id || "").trim() === messageId)
      : [];
    const targetMessage = [...matchingMessages].reverse().find((message) => {
      const card = message?.card;
      if (!card || typeof card !== "object") {
        return false;
      }
      if (String(card?.sourceUrl || card?.sourceLabel || "").trim()) {
        return true;
      }
      return Array.isArray(card?.actions) && card.actions.some((action) => String(
        action?.rawText
        || action?.parsedArgs?.source
        || action?.parsedArgs?.sourceUrl
        || ""
      ).trim());
    }) || matchingMessages[matchingMessages.length - 1] || null;
    const matchedAction = actionLabel && Array.isArray(targetMessage?.card?.actions)
      ? targetMessage.card.actions.find((action) => String(action?.label || "").trim() === actionLabel)
      : null;
    const matchedActionSource = String(
      matchedAction?.rawText
      || matchedAction?.parsedArgs?.source
      || matchedAction?.parsedArgs?.sourceUrl
      || ""
    ).trim();
    if (matchedActionSource) {
      return normalizeBilibiliSource(matchedActionSource);
    }
    const cardSource = String(targetMessage?.card?.sourceUrl || targetMessage?.card?.sourceLabel || "").trim();
    if (cardSource) {
      return normalizeBilibiliSource(cardSource);
    }
    const actionSource = Array.isArray(targetMessage?.card?.actions)
      ? targetMessage.card.actions
        .map((action) => String(action?.rawText || action?.parsedArgs?.source || action?.parsedArgs?.sourceUrl || "").trim())
        .find(Boolean)
      : "";
    return actionSource ? normalizeBilibiliSource(actionSource) : "";
  } catch (error) {
    await api.appendLog(`resolve source from chat message failed: ${error?.message || error}`);
    return "";
  }
}

async function resolveDownloadOptionsFromChatMessage(context, api) {
  const historyPath = String(context?.chat?.historyPath || "").trim();
  const messageId = String(context?.chat?.messageId || "").trim();
  const actionLabel = resolveCardActionLabel(context);
  if (!historyPath || !messageId || !actionLabel) {
    return null;
  }
  try {
    const history = await readChatHistoryDay({
      storageRoot: api.storageRoot,
      historyPath
    });
    const matchingMessages = Array.isArray(history?.messages)
      ? history.messages.filter((message) => String(message?.id || "").trim() === messageId)
      : [];
    const targetMessage = [...matchingMessages].reverse().find((message) => {
      const actions = Array.isArray(message?.card?.actions) ? message.card.actions : [];
      return actions.some((action) => String(action?.label || "").trim() === actionLabel);
    }) || [...matchingMessages].reverse().find((message) => Array.isArray(message?.card?.actions) && message.card.actions.length > 0) || null;
    const matchedAction = Array.isArray(targetMessage?.card?.actions)
      ? targetMessage.card.actions.find((action) => String(action?.label || "").trim() === actionLabel)
      : null;
    if (!matchedAction?.parsedArgs || typeof matchedAction.parsedArgs !== "object") {
      return null;
    }
    const page = clampPositiveInteger(matchedAction.parsedArgs.page || matchedAction.parsedArgs.p, 0);
    const quality = String(matchedAction.parsedArgs.quality || matchedAction.parsedArgs.qn || "").trim();
    return {
      page,
      quality,
      hasExplicitPage: page > 0,
      hasExplicitQuality: Boolean(quality)
    };
  } catch (error) {
    await api.appendLog(`resolve download options from chat message failed: ${error?.message || error}`);
    return null;
  }
}

async function resolveActionFromChatMessage(context, api) {
  const historyPath = String(context?.chat?.historyPath || "").trim();
  const messageId = String(context?.chat?.messageId || "").trim();
  const actionLabel = resolveCardActionLabel(context);
  if (!historyPath || !messageId) {
    return "";
  }
  try {
    const history = await readChatHistoryDay({
      storageRoot: api.storageRoot,
      historyPath
    });
    const matchingMessages = Array.isArray(history?.messages)
      ? history.messages.filter((message) => String(message?.id || "").trim() === messageId)
      : [];
    const targetMessage = [...matchingMessages].reverse().find((message) => {
      const actions = Array.isArray(message?.card?.actions) ? message.card.actions : [];
      return actionLabel
        ? actions.some((action) => String(action?.label || "").trim() === actionLabel)
        : actions.length > 0;
    }) || [...matchingMessages].reverse().find((message) => Array.isArray(message?.card?.actions) && message.card.actions.length > 0) || null;
    const actions = Array.isArray(targetMessage?.card?.actions) ? targetMessage.card.actions : [];
    if (actionLabel) {
      const matchedAction = actions.find((action) => String(action?.label || "").trim() === actionLabel);
      const actionName = String(matchedAction?.parsedArgs?.action || "").trim().toLowerCase();
      if (actionName) {
        return actionName;
      }
    }
    return "";
  } catch (error) {
    await api.appendLog(`resolve action from chat message failed: ${error?.message || error}`);
    return "";
  }
}

async function extractSourceFromContext(context, api) {
  const explicit = String(
    context?.trigger?.parsedArgs?.source
    || context?.trigger?.parsedArgs?.sourceUrl
    || context?.trigger?.parsedArgs?.url
    || ""
  ).trim();
  if (explicit) {
    return normalizeBilibiliSource(explicit);
  }
  const rawText = String(context?.trigger?.rawText || "");
  const urlMatch = rawText.match(/https?:\/\/\S+/i);
  if (urlMatch?.[0]) {
    return normalizeBilibiliSource(urlMatch[0]);
  }
  const bvMatch = rawText.match(/\bBV[0-9A-Za-z]+\b/i);
  if (bvMatch?.[0]) {
    return normalizeBilibiliSource(bvMatch[0]);
  }
  return resolveSourceFromChatMessage(context, api);
}

function buildBilibiliCard({ metadata, imported, source, attachmentId, status = "succeeded", reusable = false }) {
  const title = String(metadata?.title || imported?.fileName || "Bilibili download").trim();
  const uploader = String(metadata?.owner?.name || metadata?.uploader || metadata?.channel || "").trim();
  const durationLabel = formatDurationLabel(metadata?.duration || 0);
  const selectionLabel = buildSelectionLabel(metadata);
  const sourceLabel = String(metadata?.webpage_url || source || "").trim();
  const imageUrl = String(metadata?.thumbnail || metadata?.pic || "").trim();
  const subtitle = [uploader, durationLabel, selectionLabel, imported?.relativePath || imported?.fileName || ""].filter(Boolean).join(" · ");
  const actions = [];
  if (attachmentId && String(imported?.mimeType || "").startsWith("video/")) {
    actions.push({ type: "open-attachment", label: "打开资源", attachmentId });
  }
  if (sourceLabel) {
    actions.push({ type: "open-url", label: "打开来源", url: sourceLabel });
  }
  return {
    type: "media-result",
    status,
    title,
    subtitle,
    body: reusable ? "已复用已入库资源" : `已入库到 ${imported?.relativePath || imported?.fileName || "资源库"}`,
    progress: null,
    imageUrl,
    imageAlt: title,
    mediaAttachmentId: attachmentId || "",
    sourceLabel,
    sourceUrl: sourceLabel,
    actions
  };
}

function readYtDlpProgress(text = "") {
  const matches = [...String(text || "").matchAll(/\[download\]\s+(\d+(?:\.\d+)?)%/gi)];
  const rawValue = matches.length ? matches[matches.length - 1]?.[1] : "";
  const percent = Number(rawValue);
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;
}

function detectYtDlpPhase(text = "") {
  const value = String(text || "");
  if (/\[download\].*Destination:/i.test(value)) {
    return { phase: "download-remote", label: "下载视频中", percent: 12 };
  }
  if (/\[Merger\]|Merging formats/i.test(value)) {
    return { phase: "postprocess", label: "合并中", percent: 88 };
  }
  if (/\[ExtractAudio\]|Extracting audio/i.test(value)) {
    return { phase: "download-remote", label: "下载音频中", percent: 78 };
  }
  if (/\[Metadata\]|Adding metadata/i.test(value)) {
    return { phase: "postprocess", label: "整理元数据中", percent: 92 };
  }
  if (/\[MoveFiles\]|after_move:filepath/i.test(value)) {
    return { phase: "postprocess", label: "收尾处理中", percent: 94 };
  }
  return null;
}

async function runYtDlp(args, { cwd, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onOutput?.(text, "stdout");
    });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onOutput?.(text, "stderr");
    });
    proc.on("error", (error) => {
      reject(new Error(`failed to start yt-dlp (${ytDlpPath}): ${error.message || error}`));
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}: ${(stderr || stdout).trim() || "unknown error"}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function loadPlaywrightCookies(targetUrl) {
  const bilibiliCookieFile = String(process.env.BOT_BILIBILI_COOKIE_FILE || "").trim();
  if (!bilibiliCookieFile) {
    return [];
  }
  const raw = await fs.promises.readFile(bilibiliCookieFile, "utf-8");
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  const pageUrl = new URL(targetUrl);
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    const cookies = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : [];
    return cookies.filter((item) => item?.name && item?.value);
  }
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
    const normalizedDomain = String(domain || "").trim();
    const normalizedPath = String(cookiePath || "/").trim() || "/";
    const host = pageUrl.hostname;
    const domainMatches = normalizedDomain.startsWith(".")
      ? host === normalizedDomain.slice(1) || host.endsWith(normalizedDomain)
      : host === normalizedDomain || (includeSubdomains === "TRUE" && host.endsWith(`.${normalizedDomain}`));
    if (!domainMatches || !name) {
      continue;
    }
    cookies.push({
      name: String(name || "").trim(),
      value: String(value || ""),
      domain: normalizedDomain,
      path: normalizedPath,
      secure: String(secureFlag || "").toUpperCase() === "TRUE",
      expires: Number(expiresRaw || 0) > 0 ? Number(expiresRaw) : -1,
      httpOnly: false,
      sameSite: "Lax"
    });
  }
  return cookies;
}

async function extractPlaywrightPageData(source) {
  const chromium = await loadPlaywrightChromium();
  if (!chromium) {
    throw new Error("playwright chromium is unavailable");
  }
  const browser = await launchPlaywrightBrowser({ chromium, scope: "BOT_BILIBILI_PLAYWRIGHT" });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const cookies = await loadPlaywrightCookies(source).catch(() => []);
    if (cookies.length) {
      await context.addCookies(cookies);
    }
    const page = await context.newPage();
    await page.goto(source, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);
    await page.waitForFunction(() => Boolean(window.__INITIAL_STATE__ || window.__playinfo__), null, { timeout: 8000 }).catch(() => {});
    const extracted = await page.evaluate(() => {
      function extractJsonObject(text, marker) {
        const index = text.indexOf(marker);
        if (index < 0) return null;
        const start = text.indexOf("{", index + marker.length);
        if (start < 0) return null;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let pos = start; pos < text.length; pos += 1) {
          const char = text[pos];
          if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
          }
          if (char === '"') {
            inString = true;
            continue;
          }
          if (char === "{") {
            depth += 1;
            continue;
          }
          if (char === "}") {
            depth -= 1;
            if (depth === 0) {
              try {
                return JSON.parse(text.slice(start, pos + 1));
              } catch {
                return null;
              }
            }
          }
        }
        return null;
      }
      function parseInlineWindowObject(name) {
        for (const script of Array.from(document.scripts || [])) {
          const text = script.textContent || "";
          const parsed = extractJsonObject(text, `window.${name}=`);
          if (parsed) {
            return parsed;
          }
        }
        return null;
      }
      const state = window.__INITIAL_STATE__ || parseInlineWindowObject("__INITIAL_STATE__") || {};
      const playinfo = window.__playinfo__ || parseInlineWindowObject("__playinfo__") || {};
      const videoData = state?.videoData || {};
      const owner = videoData?.owner || state?.upData || {};
      const playData = playinfo?.data || playinfo?.result || {};
      return {
        title: String(videoData?.title || document.title || "").trim(),
        webpage_url: location.href,
        id: String(videoData?.bvid || videoData?.bvidStr || "").trim(),
        thumbnail: String(videoData?.pic || "").trim(),
        duration: Number(videoData?.duration || 0),
        owner: { name: String(owner?.name || "").trim() },
        playData: playData && typeof playData === "object" ? playData : {}
      };
    });
    const currentUrl = page.url();
    const contextCookies = await context.cookies(currentUrl);
    return {
      metadata: {
        title: extracted?.title || "",
        webpage_url: extracted?.webpage_url || currentUrl,
        id: extracted?.id || extractBilibiliVideoId(currentUrl),
        thumbnail: extracted?.thumbnail || "",
        owner: extracted?.owner || {},
        duration: Number(extracted?.duration || 0)
      },
      playData: extracted?.playData || {},
      userAgent: await page.evaluate(() => navigator.userAgent),
      cookieHeader: buildCookieHeader(contextCookies)
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

function chooseBestDashVideo(videos = []) {
  return [...(videos || [])]
    .filter((item) => item?.baseUrl || item?.base_url)
    .sort((left, right) => {
      const leftAvc = /avc|h264/i.test(String(left?.codecs || "")) ? 1 : 0;
      const rightAvc = /avc|h264/i.test(String(right?.codecs || "")) ? 1 : 0;
      if (leftAvc !== rightAvc) {
        return rightAvc - leftAvc;
      }
      return Number(right?.bandwidth || right?.bandWidth || 0) - Number(left?.bandwidth || left?.bandWidth || 0);
    })[0] || null;
}

function chooseBestDashAudio(audios = []) {
  return [...(audios || [])]
    .filter((item) => item?.baseUrl || item?.base_url)
    .sort((left, right) => Number(right?.bandwidth || right?.bandWidth || 0) - Number(left?.bandwidth || left?.bandWidth || 0))[0] || null;
}

async function downloadUrlToFile(url, targetPath, options = {}) {
  const response = await fetch(url, { method: "GET", headers: options.headers || {}, redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`.trim());
  }
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const totalBytes = Number(response.headers.get("content-length") || 0) || 0;
  const handle = await fs.promises.open(targetPath, options.append ? "a" : "w");
  let transferredBytes = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      await handle.write(chunk, 0, chunk.length);
      transferredBytes += chunk.length;
      options.onProgress?.({ transferredBytes, totalBytes });
    }
  } finally {
    await handle.close();
  }
  return { totalBytes: Math.max(totalBytes, transferredBytes), transferredBytes };
}

function buildWeightedProgressReporter(api, ranges = []) {
  const totals = new Map();
  const loaded = new Map();
  return async (key, payload = {}) => {
    const range = ranges.find((item) => item.key === key) || { min: 10, max: 80, label: "下载中", phase: "download-remote" };
    if (Number.isFinite(payload.totalBytes) && payload.totalBytes > 0) totals.set(key, Number(payload.totalBytes));
    if (Number.isFinite(payload.transferredBytes) && payload.transferredBytes >= 0) loaded.set(key, Number(payload.transferredBytes));
    const min = Number(range.min || 0);
    const max = Number(range.max || 100);
    const total = totals.get(key) || 0;
    const current = loaded.get(key) || 0;
    let percent = min;
    if (total > 0) {
      percent = min + Math.round(Math.max(0, Math.min(1, current / total)) * Math.max(0, max - min));
    } else if (current > 0) {
      percent = Math.min(max - 2, min + Math.floor(current / (5 * 1024 * 1024)) * 4);
    }
    await api.emitProgress({ phase: String(range.phase || "download-remote"), label: String(payload.label || range.label || "下载中"), percent: Math.max(min, Math.min(max, percent)) });
  };
}

async function mergeStreamsWithFfmpeg(videoPath, audioPath, outputPath, api) {
  const ffmpegBin = String(api.dependencies?.ffmpegPath || "ffmpeg").trim() || "ffmpeg";
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, ["-y", "-i", videoPath, "-i", audioPath, "-c", "copy", outputPath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => reject(new Error(`failed to start ffmpeg (${ffmpegBin}): ${error.message || error}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim() || "unknown error"}`));
        return;
      }
      resolve(outputPath);
    });
  });
}

async function readMetadata(source, tempDir, api, downloadOptions = {}) {
  try {
    const bundle = await getBilibiliVideoBundleFromSource(source, {
      signal: api?.signal,
      page: downloadOptions.page,
      quality: downloadOptions.quality
    });
    if (bundle?.metadata) {
      return {
        ...bundle.metadata,
        __bilibiliApi: bundle
      };
    }
  } catch (error) {
    await api?.appendLog?.(`bilibili api metadata failed: ${error.message || error}`);
  }

  if (bilibiliDownloadBackend !== "yt-dlp") {
    try {
      const extracted = await extractPlaywrightPageData(source);
      return { ...extracted.metadata, __playwright: extracted };
    } catch (error) {
      await api?.appendLog?.(`playwright metadata failed: ${error.message || error}`);
      if (bilibiliDownloadBackend === "playwright-only") {
        throw error;
      }
    }
  }
  const args = ["--dump-single-json", "--no-warnings", "--skip-download"];
  const bilibiliCookieFile = String(process.env.BOT_BILIBILI_COOKIE_FILE || "").trim();
  if (bilibiliCookieFile) {
    args.push("--cookies", bilibiliCookieFile);
  }
  args.push(source);
  const result = await runYtDlp(args, { cwd: tempDir });
  const lines = result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const rawJson = lines.find((line) => line.startsWith("{")) || "{}";
  try {
    return JSON.parse(rawJson);
  } catch {
    return {};
  }
}

function pickDashVideoByQuality(videos = [], requestedQn = 0) {
  const candidates = [...(videos || [])].filter((item) => item?.baseUrl || item?.base_url);
  if (!candidates.length) {
    return null;
  }
  const normalizedRequestedQn = clampPositiveInteger(requestedQn, 0);
  const pickBest = (items) => [...items].sort((left, right) => {
    const leftAvc = /avc|h264/i.test(String(left?.codecs || "")) ? 1 : 0;
    const rightAvc = /avc|h264/i.test(String(right?.codecs || "")) ? 1 : 0;
    if (leftAvc !== rightAvc) {
      return rightAvc - leftAvc;
    }
    return Number(right?.bandwidth || right?.bandWidth || 0) - Number(left?.bandwidth || left?.bandWidth || 0);
  })[0] || null;

  if (!normalizedRequestedQn) {
    return pickBest(candidates);
  }

  const exact = candidates.filter((item) => Number(item?.id || item?.video_quality || 0) === normalizedRequestedQn);
  if (exact.length) {
    return pickBest(exact);
  }

  const lowerOrEqual = candidates.filter((item) => Number(item?.id || item?.video_quality || 0) <= normalizedRequestedQn);
  if (lowerOrEqual.length) {
    return pickBest(lowerOrEqual);
  }

  return pickBest(candidates);
}

async function findNewestDownloadedFile(rootDir) {
  const candidates = [];
  async function walk(currentDir) {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (/\.(part|ytdl|temp|tmp)$/i.test(entry.name)) {
        continue;
      }
      try {
        const stat = await fs.promises.stat(absolutePath);
        if (!stat.isFile() || stat.size <= 0) continue;
        candidates.push({ absolutePath, mtimeMs: Number(stat.mtimeMs || 0) });
      } catch {
      }
    }
  }
  try {
    await walk(rootDir);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.absolutePath || "";
}

function detectPrintedFilePath(lines, tempDir) {
  const normalizedTempDir = path.resolve(tempDir);
  for (const line of [...lines].reverse()) {
    const value = String(line || "").trim().replace(/^"|"$/g, "");
    if (!value) continue;
    if (fs.existsSync(value)) return path.resolve(value);
    const destinationMatch = value.match(/Destination:\s+(.+)$/i);
    const mergerMatch = value.match(/Merging formats into\s+"(.+)"/i);
    const movedMatch = value.match(/into\s+"(.+)"/i);
    const candidate = String(destinationMatch?.[1] || mergerMatch?.[1] || movedMatch?.[1] || "").trim().replace(/^"|"$/g, "");
    if (!candidate) continue;
    const resolved = path.isAbsolute(candidate) ? candidate : path.join(normalizedTempDir, candidate);
    if (fs.existsSync(resolved)) return path.resolve(resolved);
  }
  return "";
}

async function downloadMediaWithPlaywright(source, tempDir, api, metadata = {}, downloadOptions = {}) {
  const extracted = metadata?.__playwright || null;
  const apiBundle = metadata?.__bilibiliApi || null;
  const bundle = extracted
    || apiBundle
    || await getBilibiliVideoBundleFromSource(source, {
      signal: api?.signal,
      page: downloadOptions.page,
      quality: downloadOptions.quality
    }).catch(() => null)
    || await extractPlaywrightPageData(source);
  const playData = bundle?.playData || {};
  const pageUrl = String(metadata?.webpage_url || bundle?.metadata?.webpage_url || source).trim();
  const mediaHeaders = await buildMediaHeaders(pageUrl, bundle?.userAgent || BILIBILI_USER_AGENT, bundle?.cookieHeader || "");
  const identifier = String(metadata?.id || bundle?.metadata?.id || extractBilibiliVideoId(source) || "video").trim();
  const pageSuffix = Number(metadata?.page?.index || bundle?.metadata?.page?.index || 0) > 1
    ? ` [P${Number(metadata?.page?.index || bundle?.metadata?.page?.index || 0)}]`
    : "";
  const qualityValue = String(metadata?.selectedQuality?.label || bundle?.metadata?.selectedQuality?.label || downloadOptions?.quality || "").trim();
  const qualitySuffix = qualityValue ? ` [${qualityValue}]` : "";
  const baseStem = sanitizeTempName(`${metadata?.title || bundle?.metadata?.title || "Bilibili"}${pageSuffix}${qualitySuffix} [${identifier}]`, `Bilibili [${identifier}]`);

  if (Array.isArray(playData?.durl) && playData.durl.length) {
    const progressiveUrl = String(playData.durl[0]?.url || "").trim();
    if (!progressiveUrl) {
      throw new Error("playwright extracted empty progressive url");
    }
    const targetPath = path.join(tempDir, `${baseStem}${guessFileExtension(progressiveUrl, ".mp4")}`);
    const reportProgress = buildWeightedProgressReporter(api, [{ key: "progressive", min: 12, max: 88, label: "下载视频中", phase: "download-remote" }]);
    await downloadUrlToFile(progressiveUrl, targetPath, { headers: mediaHeaders, onProgress: (payload) => reportProgress("progressive", payload) });
    await api.appendLog(`playwright downloaded progressive media: ${targetPath}`);
    return path.resolve(targetPath);
  }

  const dashVideo = pickDashVideoByQuality(playData?.dash?.video || [], bundle?.request?.qn || metadata?.selectedQuality?.qn || 0);
  const dashAudio = chooseBestDashAudio(playData?.dash?.audio || []);
  if (!dashVideo) {
    throw new Error("playwright could not resolve bilibili media streams");
  }

  const videoUrl = String(dashVideo.baseUrl || dashVideo.base_url || "").trim();
  const audioUrl = String(dashAudio?.baseUrl || dashAudio?.base_url || "").trim();
  const videoPath = path.join(tempDir, `${baseStem}.video${guessFileExtension(videoUrl, ".m4s")}`);
  const audioPath = audioUrl ? path.join(tempDir, `${baseStem}.audio${guessFileExtension(audioUrl, ".m4s")}`) : "";
  const outputPath = path.join(tempDir, `${baseStem}.mp4`);
  const reportProgress = buildWeightedProgressReporter(api, [
    { key: "video", min: 12, max: audioUrl ? 62 : 84, label: "下载视频中", phase: "download-remote" },
    { key: "audio", min: 64, max: 84, label: "下载音频中", phase: "download-remote" }
  ]);

  await downloadUrlToFile(videoUrl, videoPath, { headers: mediaHeaders, onProgress: (payload) => reportProgress("video", payload) });
  if (audioUrl && audioPath) {
    await downloadUrlToFile(audioUrl, audioPath, { headers: mediaHeaders, onProgress: (payload) => reportProgress("audio", payload) });
    await api.emitProgress({ phase: "postprocess", label: "合并中", percent: 90 });
    await mergeStreamsWithFfmpeg(videoPath, audioPath, outputPath, api);
    await api.appendLog(`playwright merged media: ${outputPath}`);
    return path.resolve(outputPath);
  }
  await api.appendLog(`playwright downloaded video-only media: ${videoPath}`);
  return path.resolve(videoPath);
}

function buildYtDlpFormatSelector(quality = "") {
  const normalized = normalizeQualityText(quality);
  if (!normalized || ["max", "best", "最高", "默认"].includes(normalized)) {
    return "bv*+ba/b";
  }
  const heightMap = new Map([
    ["8k", 4320],
    ["2160p", 2160],
    ["4k", 2160],
    ["1080p60", 1080],
    ["1080p+", 1080],
    ["1080p", 1080],
    ["720p60", 720],
    ["720p", 720],
    ["480p", 480],
    ["360p", 360]
  ]);
  const numeric = clampPositiveInteger(normalized.replace(/[^\d]/g, ""), 0);
  const maxHeight = heightMap.get(normalized) || (numeric >= 2160 ? 2160 : numeric >= 1080 ? 1080 : numeric >= 720 ? 720 : numeric >= 480 ? 480 : numeric >= 360 ? 360 : 0);
  if (!maxHeight) {
    return "bv*+ba/b";
  }
  return `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/b`;
}

async function downloadMediaWithYtDlp(source, tempDir, api, metadata = {}, downloadOptions = {}) {
  const outputTemplate = path.join(tempDir, "%(title).120B [%(id)s].%(ext)s");
  const args = ["--newline", "--print", "after_move:filepath", "-o", outputTemplate];
  const bilibiliCookieFile = String(process.env.BOT_BILIBILI_COOKIE_FILE || "").trim();
  if (bilibiliCookieFile) {
    args.push("--cookies", bilibiliCookieFile);
  }
  if (api.dependencies?.ffmpegPath && /[\\/]/.test(String(api.dependencies.ffmpegPath))) {
    args.push("--ffmpeg-location", path.dirname(String(api.dependencies.ffmpegPath)));
  }
  if (downloadOptions?.quality) {
    args.push("-f", buildYtDlpFormatSelector(downloadOptions.quality));
  }
  args.push(String(metadata?.webpage_url || source).trim() || source);
  let currentPercent = 10;
  let currentPhasePercent = 10;
  const result = await runYtDlp(args, {
    cwd: tempDir,
    onOutput: async (text) => {
      const nextPercent = readYtDlpProgress(text);
      if (nextPercent !== null && nextPercent !== currentPercent) {
        currentPercent = nextPercent;
        await api.emitProgress({ phase: "download-remote", label: `下载视频中`, percent: Math.max(12, Math.min(86, 12 + Math.round(nextPercent * 0.74))) });
        return;
      }
      const phaseUpdate = detectYtDlpPhase(text);
      if (phaseUpdate && phaseUpdate.percent > currentPhasePercent) {
        currentPhasePercent = phaseUpdate.percent;
        await api.emitProgress(phaseUpdate);
      }
    }
  });
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const downloadedPath = detectPrintedFilePath(lines, tempDir) || await findNewestDownloadedFile(tempDir);
  if (!downloadedPath) {
    throw new Error("yt-dlp completed but downloaded file path was not detected");
  }
  await api.appendLog(`downloaded file: ${downloadedPath}`);
  return path.resolve(downloadedPath);
}

async function downloadMedia(source, tempDir, api, metadata = {}, downloadOptions = {}) {
  if (bilibiliDownloadBackend !== "yt-dlp") {
    try {
      await api.emitProgress({ phase: "download-remote", label: "解析中", percent: 10 });
      return await downloadMediaWithPlaywright(source, tempDir, api, metadata, downloadOptions);
    } catch (error) {
      await api.appendLog(`playwright download failed: ${error.message || error}`);
      if (bilibiliDownloadBackend === "playwright-only") {
        throw error;
      }
      await api.emitProgress({ phase: "download-remote", label: "Playwright 失败，切换 yt-dlp", percent: 10 });
    }
  }
  await api.emitProgress({ phase: "download-remote", label: "解析中", percent: 10 });
  return downloadMediaWithYtDlp(source, tempDir, api, metadata, downloadOptions);
}

export function createBilibiliDownloaderPlugin() {
  return createBotPlugin({
    botId: "bilibili.downloader",
    displayName: "Bilibili Downloader",
    aliases: ["bili", "bilibili"],
    description: "Download a Bilibili video by BV id or URL, or manage Bilibili QR-code login for local downloads.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "可选: login/status/logout/relogin" },
        source: { type: "string" },
        targetFolder: { type: "string" },
        page: { type: "integer", minimum: 1 },
        quality: { type: "string", description: "例如 1080p、720p、4k、80、64" }
      }
    },
    capabilities: ["download.remote-media", "import.library", "reply.chat"],
    permissions: {
      writeLibrary: true,
      outboundHttp: true,
      spawnProcess: true,
      replyChat: true,
      publishJobEvents: true
    },
    limits: {
      maxConcurrentJobs: 1,
      timeoutMs: 60 * 60 * 1000,
      maxDownloadBytes: 20 * 1024 * 1024 * 1024
    },
    async execute(context, api) {
      let action = resolveBilibiliAction(context);
      const hasTriggerPayload = hasMeaningfulTriggerPayload(context);
      if (action === "download" && !hasTriggerPayload) {
        const inferredAction = await resolveActionFromChatMessage(context, api);
        if (inferredAction) {
          action = inferredAction;
        }
      }
      if (action === "status") {
        return handleBilibiliStatus(context, api);
      }
      if (action === "logout") {
        return handleBilibiliLogout(context, api);
      }
      if (action === "login" || action === "relogin") {
        return handleBilibiliLogin(context, api, { force: action === "relogin" });
      }

      const inferredDownloadOptions = !hasTriggerPayload
        ? await resolveDownloadOptionsFromChatMessage(context, api)
        : null;
      const source = await extractSourceFromContext(context, api);
      if (!source) {
        throw new Error("bilibili source is required: provide a BV id or Bilibili URL");
      }
      if (!isSupportedBilibiliSource(source)) {
        throw new Error("@bili 目前只支持 bilibili 链接、b23.tv 短链或 BV 号");
      }

      const tempDir = path.join(api.appDataRoot, "temp", context.jobId);
      await fs.promises.mkdir(tempDir, { recursive: true });
      const downloadOptions = inferredDownloadOptions || resolveDownloadOptions(context);
      const viewOptions = resolveSelectionViewOptions(context);
      await api.appendLog(`bilibili source: ${source}`);
      if (downloadOptions.hasExplicitPage || downloadOptions.hasExplicitQuality) {
        await api.appendLog(`download options: ${JSON.stringify({ page: downloadOptions.page || undefined, quality: downloadOptions.quality || undefined })}`);
      }
      await api.emitProgress({ phase: "parse-input", label: "解析中", percent: 5 });

      let metadata = {};
      try {
        metadata = await readMetadata(source, tempDir, api, downloadOptions);
        await api.appendLog(`metadata title: ${metadata?.title || "unknown"}`);
      } catch (error) {
        await api.appendLog(`metadata probe failed: ${error.message || error}`);
      }

      const targetFolder = sanitizeImportFolder(context?.trigger?.parsedArgs?.targetFolder || downloadOptions.targetFolder || bilibiliImportDir);
      const availableQualities = listAvailableQualities(metadata);
      const user = downloadOptions.hasExplicitQuality ? await resolveBilibiliUserProfile(api) : null;
      const normalizedRequestedQuality = downloadOptions.hasExplicitQuality
        ? normalizeBilibiliQuality(downloadOptions.quality, metadata?.selectedQuality?.qn || 127)
        : null;
      const maxAvailableQuality = availableQualities.reduce((best, item) => {
        if (!item?.qn) {
          return best;
        }
        if (!best || item.qn > best.qn) {
          return item;
        }
        return best;
      }, null);
      const actualSelectedQuality = metadata?.selectedQuality && typeof metadata.selectedQuality === "object"
        ? metadata.selectedQuality
        : null;
      // qn=64 is 720p — the typical ceiling for anonymous/expired sessions.
      // Even if the API returns 4K in the quality list, actual streams above 720p require login.
      const LOGIN_REQUIRED_QN_THRESHOLD = 64;
      const shouldPromptLoginForQuality = !user
        && downloadOptions.hasExplicitQuality
        && normalizedRequestedQuality?.explicit === true
        && (
          (actualSelectedQuality?.downgraded === true
            && Number(actualSelectedQuality?.requestedQn || 0) > Number(actualSelectedQuality?.qn || 0))
          || (maxAvailableQuality?.qn && normalizedRequestedQuality.qn > maxAvailableQuality.qn)
          || normalizedRequestedQuality.qn > LOGIN_REQUIRED_QN_THRESHOLD
        );
      const requiresPageSelection = downloadOptions.hasExplicitPage !== true && Array.isArray(metadata?.pages) && metadata.pages.length > 1;
      const requiresQualitySelection = downloadOptions.hasExplicitQuality !== true && availableQualities.length > 1;

      if (shouldPromptLoginForQuality) {
        const card = buildBilibiliLoginGuideCard({
          source,
          metadata,
          targetFolder,
          downloadOptions,
          maxAvailableQuality
        });
        const chatReply = await api.publishChatReply({
          id: getBilibiliReplyMessageId(context),
          createdAt: context.createdAt,
          text: "",
          attachments: [],
          card
        });
        return { chatReply, importedFiles: [], artifacts: [] };
      }

      if (requiresPageSelection || requiresQualitySelection) {
        const card = buildBilibiliSelectionCard({
          stage: requiresPageSelection ? "page" : "quality",
          source,
          metadata,
          targetFolder,
          downloadOptions,
          viewOptions
        });
        const chatReply = await api.publishChatReply({
          id: getBilibiliReplyMessageId(context),
          createdAt: context.createdAt,
          text: "",
          attachments: [],
          card
        });
        return { chatReply, importedFiles: [], artifacts: [] };
      }

      const reusable = await findReusableImport({ appDataRoot: api.appDataRoot, storageRoot: api.storageRoot, targetFolder, source, metadata, downloadOptions });
      if (reusable) {
        await api.appendLog(`reuse imported file: ${reusable.relativePath}`);
        await api.emitProgress({ phase: "reuse-existing", label: "已复用已入库资源", percent: 100 });
        const attachmentId = `bot-asset:${context.jobId}`;
        const chatReply = await api.publishChatReply({
          id: getBilibiliReplyMessageId(context),
          createdAt: context.createdAt,
          text: "",
          attachments: [{ id: attachmentId, name: reusable.fileName, mimeType: reusable.mimeType, size: reusable.size, path: reusable.relativePath, clientId: context.chat.hostClientId, kind: String(reusable.mimeType || "").startsWith("video/") ? "video" : "file" }],
          card: buildBilibiliCard({ metadata, imported: reusable, source, attachmentId, reusable: true })
        });
        return { chatReply, importedFiles: [reusable], artifacts: [] };
      }

      const downloadedPath = await downloadMedia(source, tempDir, api, metadata, downloadOptions);
      await api.emitProgress({ phase: "import-library", label: "入库中", percent: 88 });
      const imported = await importFileIntoLibrary({ sourcePath: downloadedPath, storageRoot: api.storageRoot, targetFolder, fileName: path.basename(downloadedPath) });
      await api.appendLog(`imported file: ${imported.relativePath}`);
      await rememberImportedResult({ appDataRoot: api.appDataRoot, source, metadata, imported, downloadOptions });
      await triggerLibraryRescan({ syncFiles: api.dependencies?.syncFiles });
      await api.emitProgress({ phase: "append-chat-reply", label: "生成结果卡片", percent: 95 });

      const attachmentId = `bot-asset:${context.jobId}`;
      const chatReply = await api.publishChatReply({
        id: getBilibiliReplyMessageId(context),
        createdAt: context.createdAt,
        text: "",
        attachments: [{ id: attachmentId, name: imported.fileName, mimeType: imported.mimeType, size: imported.size, path: imported.relativePath, clientId: context.chat.hostClientId, kind: String(imported.mimeType || "").startsWith("video/") ? "video" : "file" }],
        card: buildBilibiliCard({ metadata, imported, source, attachmentId })
      });

      return { chatReply, importedFiles: [imported], artifacts: [] };
    }
  });
}
