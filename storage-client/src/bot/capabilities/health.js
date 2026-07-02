import fs from "node:fs";
import path from "node:path";
import { getEffectiveMultimodalModel, getEffectiveTextModel } from "../plugins/ai-chat/services/modelSettings.js";
import { listAvailableModels, parseModelRef } from "../tools/llmClient.js";
import { loadLibrarySnapshot } from "../tools/libraryFiles.js";

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
  checks.push(await checkAiModels(options.modelSettings || {}, options.signal || api.signal || null));
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
