import {
  summarizeCapabilityAvailability,
  summarizeCapabilityExecutionReadiness
} from "../../../capabilities/registry.js";
import { getEffectiveTextModel } from "../services/modelSettings.js";

function redactSmokeText(value = "", limit = 240) {
  return String(value || "")
    .replace(/[A-Za-z]:[\\/][^\s；,，]+/g, "[local-path]")
    .replace(/\\\\[^\s；,，]+/g, "[network-path]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, "sk-[redacted]")
    .slice(0, limit);
}

function getHealthCheck(health = {}, id = "") {
  return (Array.isArray(health.checks) ? health.checks : []).find((check) => check?.id === id) || null;
}

function getDescriptor(descriptors = [], id = "") {
  return (Array.isArray(descriptors) ? descriptors : []).find((item) => item?.id === id) || null;
}

function normalizeSmokeStatus(status = "") {
  const normalized = String(status || "").trim().toLowerCase();
  if (["ok", "warn", "error", "blocked", "unknown"].includes(normalized)) {
    return normalized;
  }
  return "unknown";
}

function buildStep({
  id = "",
  title = "",
  command = "",
  status = "unknown",
  expected = "",
  detail = "",
  repairHint = "",
  requiredCapabilities = []
} = {}) {
  return {
    id,
    title,
    command,
    status: normalizeSmokeStatus(status),
    expected: redactSmokeText(expected, 360),
    detail: redactSmokeText(detail, 360),
    repairHint: redactSmokeText(repairHint, 360),
    requiredCapabilities: Array.isArray(requiredCapabilities)
      ? requiredCapabilities.map((item) => String(item || "").trim()).filter(Boolean)
      : []
  };
}

function capabilityStepStatus(descriptor = null, health = {}) {
  if (!descriptor) {
    return {
      status: "unknown",
      detail: "能力未注册",
      repairHint: "运行 @ai /tools 查看当前能力注册表。"
    };
  }
  const availability = summarizeCapabilityAvailability(descriptor, health);
  const readiness = summarizeCapabilityExecutionReadiness(descriptor, health);
  if (readiness.ready === false) {
    const blocker = readiness.blocker || {};
    return {
      status: "blocked",
      detail: `${blocker.label || blocker.id || descriptor.id}: ${blocker.detail || readiness.detail || "不可用"}`,
      repairHint: blocker.repairHint || availability.repairHints?.[0]?.hint || "运行 @ai /health 查看阻断原因。"
    };
  }
  return {
    status: availability.status || "unknown",
    detail: availability.detail || readiness.detail || "",
    repairHint: availability.repairHints?.[0]?.hint || ""
  };
}

function healthStepStatus(health = {}) {
  const overall = normalizeSmokeStatus(health.overall || "unknown");
  return {
    status: overall,
    detail: `overall=${overall}`,
    repairHint: overall === "ok" ? "" : "先处理 @ai /health 中的 error/warn，再运行依赖对应能力的 smoke 项。"
  };
}

function modelStepStatus(health = {}, modelSettings = {}) {
  const check = getHealthCheck(health, "ai-model");
  const textModel = getEffectiveTextModel(modelSettings);
  if (!check) {
    return {
      status: textModel ? "warn" : "error",
      detail: textModel ? `当前文本模型=${textModel}` : "未配置文本模型",
      repairHint: "运行 @ai /models refresh，再用 @ai /model use <序号> 选择模型。"
    };
  }
  return {
    status: normalizeSmokeStatus(check.status),
    detail: check.detail || "",
    repairHint: check.repairHint || ""
  };
}

function modelUseStepStatus(modelSettings = {}) {
  const cachedModels = Array.isArray(modelSettings.lastListedModels) ? modelSettings.lastListedModels : [];
  if (!cachedModels.length) {
    return {
      status: "warn",
      detail: "还没有最近 /models 缓存，无法给出可用序号。",
      repairHint: "先运行 @ai /models refresh，然后选择列表中的序号。"
    };
  }
  return {
    status: "ok",
    detail: `可从最近 ${cachedModels.length} 个模型中选择。`,
    repairHint: ""
  };
}

function buildCapabilitySmokeStep(descriptors = [], health = {}, {
  id = "",
  title = "",
  command = "",
  expected = "",
  requiredCapabilities = []
} = {}) {
  const descriptor = getDescriptor(descriptors, requiredCapabilities[0] || id);
  const status = capabilityStepStatus(descriptor, health);
  return buildStep({
    id,
    title,
    command,
    status: status.status,
    expected,
    detail: status.detail,
    repairHint: status.repairHint,
    requiredCapabilities
  });
}

function countSmokeStatuses(steps = []) {
  const counts = {};
  for (const step of Array.isArray(steps) ? steps : []) {
    const status = normalizeSmokeStatus(step?.status || "unknown");
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function computeSmokeOverall(counts = {}) {
  if (counts.error || counts.blocked) {
    return "blocked";
  }
  if (counts.warn || counts.unknown) {
    return "warn";
  }
  return "ok";
}

export function buildAiAgentSmokeChecklist({ health = {}, descriptors = [], modelSettings = {} } = {}) {
  const healthStatus = healthStepStatus(health);
  const modelStatus = modelStepStatus(health, modelSettings);
  const modelUseStatus = modelUseStepStatus(modelSettings);
  const steps = [
    buildStep({
      id: "health",
      title: "基础健康检查",
      command: "@ai /health",
      status: healthStatus.status,
      expected: "确认 AI 模型、storage root、ffmpeg/ffprobe、Whisper、music bridge、cookie、队列状态。",
      detail: healthStatus.detail,
      repairHint: healthStatus.repairHint
    }),
    buildStep({
      id: "tools",
      title: "能力注册表",
      command: "@ai /tools",
      status: Array.isArray(descriptors) && descriptors.length ? healthStatus.status : "error",
      expected: "确认核心 NAS 文件、视频、音乐、下载、诊断工具都在列表里，并能看到阻断原因。",
      detail: Array.isArray(descriptors) && descriptors.length ? `capabilities=${descriptors.length}` : "能力注册表为空",
      repairHint: Array.isArray(descriptors) && descriptors.length ? "" : "检查 capability registry 和 aiToolRuntime 是否加载成功。"
    }),
    buildStep({
      id: "models",
      title: "模型列表与真实模型 ID",
      command: "@ai /models refresh",
      status: modelStatus.status,
      expected: "刷新 provider /models，确认列表项对应真实可请求 model id。",
      detail: modelStatus.detail,
      repairHint: modelStatus.repairHint
    }),
    buildStep({
      id: "model-use",
      title: "模型切换",
      command: "@ai /model use 1",
      status: modelUseStatus.status,
      expected: "选择列表中的真实 model id，避免把展示名写入执行路径。",
      detail: modelUseStatus.detail,
      repairHint: modelUseStatus.repairHint
    }),
    buildCapabilitySmokeStep(descriptors, health, {
      id: "file-search",
      title: "NAS 文件搜索",
      command: "@ai 找最近下载的 5 个视频",
      expected: "先调用 search_library_files/list_storage_files，返回候选、fileId 和下一步 actionPlan。",
      requiredCapabilities: ["search_library_files"]
    }),
    buildCapabilitySmokeStep(descriptors, health, {
      id: "document-read",
      title: "文档片段读取",
      command: "@ai 读取这个文档的前 2000 字并总结",
      expected: "先定位文件，再 diagnose_file_access/read_text_excerpt，不暴露本机绝对路径。",
      requiredCapabilities: ["read_text_excerpt"]
    }),
    buildCapabilitySmokeStep(descriptors, health, {
      id: "video-summary",
      title: "视频/音频总结",
      command: "@ai 总结这个视频",
      expected: "优先复用已有摘要/字幕；没有时委派 video.analyze，并返回子任务 jobId/status/trace 命令。",
      requiredCapabilities: ["invoke_video_analyze"]
    }),
    buildCapabilitySmokeStep(descriptors, health, {
      id: "music-playback",
      title: "音乐控制",
      command: "@ai 播放一首歌",
      expected: "调用 invoke_music_control；QQ cookie/bridge 不可用时给出明确降级或修复提示。",
      requiredCapabilities: ["invoke_music_control"]
    }),
    buildCapabilitySmokeStep(descriptors, health, {
      id: "failure-diagnostic",
      title: "任务诊断链路",
      command: "@ai /jobs",
      expected: "能查看最近任务、子任务、trace/log 操作，并显示继续等待/取消/重试动作。",
      requiredCapabilities: ["get_bot_job_status"]
    })
  ];
  const counts = countSmokeStatuses(steps);
  return {
    generatedAt: new Date().toISOString(),
    overall: computeSmokeOverall(counts),
    statusCounts: counts,
    steps
  };
}

export function formatAiAgentSmokeReport(checklist = {}) {
  const steps = Array.isArray(checklist.steps) ? checklist.steps : [];
  const lines = [
    `AI Agent Smoke Checklist：${checklist.overall || "unknown"}`,
    "",
    "建议按顺序执行；blocked/error 先修复，warn 可以尝试但可能降级。"
  ];
  for (const step of steps) {
    lines.push("");
    lines.push(`- [${step.status || "unknown"}] ${step.title}`);
    lines.push(`  命令：${step.command}`);
    if (step.expected) {
      lines.push(`  预期：${step.expected}`);
    }
    if (step.detail) {
      lines.push(`  当前：${step.detail}`);
    }
    if (step.repairHint) {
      lines.push(`  修复：${step.repairHint}`);
    }
  }
  return lines.join("\n");
}
