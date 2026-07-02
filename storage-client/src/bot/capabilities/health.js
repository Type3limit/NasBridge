import fs from "node:fs";
import path from "node:path";
import { getEffectiveMultimodalModel, getEffectiveTextModel } from "../plugins/ai-chat/services/modelSettings.js";
import { listAvailableModels, parseModelRef } from "../tools/llmClient.js";
import { loadLibrarySnapshot } from "../tools/libraryFiles.js";

const healthCache = new Map();
const DEFAULT_HEALTH_CACHE_TTL_MS = 60_000;

function clampInteger(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function getHealthCacheTtlMs(options = {}) {
  if (Number.isFinite(Number(options.ttlMs))) {
    return clampInteger(options.ttlMs, 0, 10 * 60_000);
  }
  return clampInteger(process.env.AI_AGENT_HEALTH_CACHE_TTL_MS || DEFAULT_HEALTH_CACHE_TTL_MS, 0, 10 * 60_000);
}

function buildHealthCacheKey(api = {}, options = {}) {
  const modelSettings = options.modelSettings || {};
  return [
    options.lightweight === true ? "lightweight" : "full",
    String(api.storageRoot || "").trim(),
    String(api.clientId || "").trim(),
    getEffectiveTextModel(modelSettings),
    getEffectiveMultimodalModel(modelSettings),
    String(process.env.MUSIC_LIB_BRIDGE_URL || "").trim(),
    String(process.env.WHISPER_CPP_PATH || "").trim(),
    String(process.env.WHISPER_MODEL_PATH || "").trim(),
    String(process.env.YT_DLP_PATH || "").trim()
  ].join("|");
}

function isPathLike(value = "") {
  return /[\\/]/.test(String(value || "")) || path.isAbsolute(String(value || ""));
}

async function fileExists(filePath = "") {
  const normalized = String(filePath || "").trim();
  if (!normalized) {
    return false;
  }
  try {
    const stat = await fs.promises.stat(normalized);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function directoryAccess(dirPath = "") {
  const normalized = String(dirPath || "").trim();
  const result = { exists: false, readable: false, writable: false, detail: "" };
  if (!normalized) {
    result.detail = "未配置";
    return result;
  }
  try {
    const stat = await fs.promises.stat(normalized);
    result.exists = stat.isDirectory();
    if (!result.exists) {
      result.detail = "路径不是目录";
      return result;
    }
  } catch (error) {
    result.detail = error?.code === "ENOENT" ? "目录不存在" : String(error?.message || error);
    return result;
  }
  try {
    await fs.promises.access(normalized, fs.constants.R_OK);
    result.readable = true;
  } catch {
  }
  try {
    await fs.promises.access(normalized, fs.constants.W_OK);
    result.writable = true;
  } catch {
  }
  result.detail = result.readable && result.writable ? "可读写" : `read=${result.readable} write=${result.writable}`;
  return result;
}

async function checkCommandOrPath(id, label, configuredPath = "") {
  const value = String(configuredPath || "").trim();
  if (!value) {
    return { id, label, status: "warn", detail: "未配置" };
  }
  if (!isPathLike(value)) {
    return { id, label, status: "warn", detail: `使用 PATH 命令：${value}，未做文件存在校验` };
  }
  const exists = await fileExists(value);
  return {
    id,
    label,
    status: exists ? "ok" : "error",
    detail: exists ? value : `文件不存在：${value}`
  };
}

async function checkMusicBridge() {
  const baseUrl = String(process.env.MUSIC_LIB_BRIDGE_URL || "http://127.0.0.1:46231").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    return { id: "music-bridge", label: "music-lib-bridge", status: "warn", detail: "未配置 MUSIC_LIB_BRIDGE_URL" };
  }
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) {
      return { id: "music-bridge", label: "music-lib-bridge", status: "error", detail: `${response.status} ${response.statusText}` };
    }
    const payload = await response.json().catch(() => ({}));
    const sources = Array.isArray(payload?.sources) ? payload.sources.join(", ") : "";
    return { id: "music-bridge", label: "music-lib-bridge", status: "ok", detail: sources ? `在线；sources=${sources}` : "在线" };
  } catch (error) {
    return { id: "music-bridge", label: "music-lib-bridge", status: "warn", detail: `不可达：${error?.message || error}` };
  }
}

async function checkStorage(api = {}) {
  const access = await directoryAccess(api.storageRoot || "");
  if (!access.exists || !access.readable) {
    return {
      id: "storage-root",
      label: "NAS 文件访问",
      status: "error",
      detail: `${api.storageRoot || "未配置"}；${access.detail}`
    };
  }
  let snapshotDetail = "";
  try {
    const snapshot = await loadLibrarySnapshot(api);
    snapshotDetail = `；files=${snapshot.files.length} dirs=${snapshot.directories.length}`;
  } catch (error) {
    return {
      id: "storage-root",
      label: "NAS 文件访问",
      status: "warn",
      detail: `${api.storageRoot}；${access.detail}；索引读取失败：${error?.message || error}`
    };
  }
  return {
    id: "storage-root",
    label: "NAS 文件访问",
    status: access.writable ? "ok" : "warn",
    detail: `${api.storageRoot}；${access.detail}${snapshotDetail}`
  };
}

async function checkAiModels(modelSettings = {}, signal = null) {
  const textModel = getEffectiveTextModel(modelSettings);
  const visionModel = getEffectiveMultimodalModel(modelSettings);
  if (!textModel) {
    return { id: "ai-model", label: "AI 模型", status: "error", detail: "未配置文本模型" };
  }
  try {
    const result = await listAvailableModels({ signal });
    const modelIds = new Set((result.models || []).map((item) => item.id));
    const textStatus = modelIds.has(textModel) ? "文本模型可用" : `文本模型未出现在 /models：${textModel}`;
    const visionStatus = !visionModel || visionModel === textModel
      ? ""
      : (modelIds.has(visionModel) ? `；看图模型可用：${visionModel}` : `；看图模型未出现在 /models：${visionModel}`);
    const status = modelIds.has(textModel) && (!visionModel || visionModel === textModel || modelIds.has(visionModel)) ? "ok" : "warn";
    const providers = [...new Set((result.models || []).map((item) => item.provider).filter(Boolean))].join(", ");
    return {
      id: "ai-model",
      label: "AI 模型",
      status,
      detail: `${textStatus}${visionStatus}；models=${(result.models || []).length}${providers ? ` providers=${providers}` : ""}`
    };
  } catch (error) {
    const parsed = parseModelRef(textModel);
    return {
      id: "ai-model",
      label: "AI 模型",
      status: "warn",
      detail: `无法刷新 /models：${error?.message || error}；当前文本模型=${parsed.modelId || textModel}`
    };
  }
}

async function checkAiModelsLightweight(modelSettings = {}) {
  const textModel = getEffectiveTextModel(modelSettings);
  const visionModel = getEffectiveMultimodalModel(modelSettings);
  if (!textModel) {
    return { id: "ai-model", label: "AI 模型", status: "error", detail: "未配置文本模型" };
  }
  const cachedModels = Array.isArray(modelSettings.lastListedModels) ? modelSettings.lastListedModels : [];
  if (!cachedModels.length) {
    return {
      id: "ai-model",
      label: "AI 模型",
      status: "warn",
      detail: `未缓存 /models 列表；当前文本模型=${parseModelRef(textModel).modelId || textModel}`
    };
  }
  const modelIds = new Set(cachedModels.map((item) => String(item?.id || "").trim()).filter(Boolean));
  const textOk = modelIds.has(textModel);
  const visionOk = !visionModel || visionModel === textModel || modelIds.has(visionModel);
  const textStatus = textOk ? "文本模型在最近 /models 缓存中" : `文本模型未出现在最近 /models 缓存：${textModel}`;
  const visionStatus = !visionModel || visionModel === textModel
    ? ""
    : (visionOk ? `；看图模型在缓存中：${visionModel}` : `；看图模型未出现在缓存：${visionModel}`);
  return {
    id: "ai-model",
    label: "AI 模型",
    status: textOk && visionOk ? "ok" : "warn",
    detail: `${textStatus}${visionStatus}；cachedModels=${cachedModels.length}`
  };
}

async function checkWhisper() {
  const exePath = String(process.env.WHISPER_CPP_PATH || "").trim();
  const modelPath = String(process.env.WHISPER_MODEL_PATH || "").trim();
  const exeExists = exePath ? await fileExists(exePath) : false;
  const modelExists = modelPath ? await fileExists(modelPath) : false;
  if (!exePath || !modelPath) {
    return { id: "whisper", label: "Whisper", status: "warn", detail: "WHISPER_CPP_PATH 或 WHISPER_MODEL_PATH 未配置" };
  }
  if (!exeExists || !modelExists) {
    return { id: "whisper", label: "Whisper", status: "error", detail: `exe=${exeExists} model=${modelExists}` };
  }
  return { id: "whisper", label: "Whisper", status: "ok", detail: `language=${String(process.env.WHISPER_LANGUAGE || "auto").trim() || "auto"}` };
}

function computeOverallStatus(checks = []) {
  if (checks.some((check) => check.status === "error")) {
    return "error";
  }
  if (checks.some((check) => check.status === "warn")) {
    return "warn";
  }
  return "ok";
}

export async function collectAiAgentHealth(api = {}, options = {}) {
  const checks = [];
  checks.push(options.lightweight === true
    ? await checkAiModelsLightweight(options.modelSettings || {})
    : await checkAiModels(options.modelSettings || {}, options.signal || api.signal || null));
  checks.push(await checkStorage(api));
  checks.push(await checkCommandOrPath("ffmpeg", "ffmpeg", api.dependencies?.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg"));
  checks.push(await checkCommandOrPath("ffprobe", "ffprobe", api.dependencies?.ffprobePath || process.env.FFPROBE_PATH || "ffprobe"));
  checks.push(await checkWhisper());
  checks.push(await checkCommandOrPath("yt-dlp", "yt-dlp", process.env.YT_DLP_PATH || "yt-dlp"));
  checks.push(await checkMusicBridge());
  return {
    generatedAt: new Date().toISOString(),
    overall: computeOverallStatus(checks),
    checks
  };
}

export async function collectAiAgentHealthCached(api = {}, options = {}) {
  if (options.force === true) {
    return collectAiAgentHealth(api, options);
  }
  const ttlMs = getHealthCacheTtlMs(options);
  if (ttlMs <= 0) {
    return collectAiAgentHealth(api, options);
  }
  const cacheKey = buildHealthCacheKey(api, options);
  const cached = healthCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.cachedAt < ttlMs) {
    return {
      ...cached.health,
      cached: true,
      cacheAgeMs: now - cached.cachedAt
    };
  }
  const health = await collectAiAgentHealth(api, options);
  healthCache.set(cacheKey, { cachedAt: now, health });
  return {
    ...health,
    cached: false,
    cacheAgeMs: 0
  };
}

export function formatHealthReport(health = {}) {
  const lines = [
    `AI Agent 健康状态：${health.overall || "unknown"}`,
    `检查时间：${String(health.generatedAt || "").replace("T", " ").slice(0, 19)}`,
    ""
  ];
  for (const check of Array.isArray(health.checks) ? health.checks : []) {
    lines.push(`- [${check.status}] ${check.label}: ${check.detail}`);
  }
  lines.push("");
  lines.push("说明：error 会阻止相关能力；warn 表示可尝试但可能降级或失败。密钥和 cookie 不会显示在这里。");
  return lines.join("\n");
}
