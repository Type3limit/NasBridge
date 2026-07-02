import { getAiToolDefinitions } from "../tools/aiToolRuntime.js";

const BOT_RISK_LEVELS = {
  "ai.chat": "low",
  "ai.multimodal-image": "low",
  "music.control": "low",
  "video.analyze": "medium",
  "video.tag": "medium",
  "bilibili.downloader": "medium",
  "ytdlp.downloader": "medium",
  "torrent.downloader": "medium",
  "aria2.downloader": "medium"
};

const BOT_EXECUTION_MODES = {
  "ai.chat": "sync",
  "ai.multimodal-image": "sync",
  "music.control": "sync",
  "video.analyze": "async-job",
  "video.tag": "async-job",
  "bilibili.downloader": "async-job",
  "ytdlp.downloader": "async-job",
  "torrent.downloader": "async-job",
  "aria2.downloader": "async-job"
};

const BOT_HEALTH_CHECKS = {
  "ai.chat": ["ai-model", "ai-tool-call", "storage-root"],
  "ai.multimodal-image": ["ai-model", "storage-root"],
  "music.control": ["music-bridge", "qq-music-cookie"],
  "video.analyze": ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root"],
  "video.tag": ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root"],
  "bilibili.downloader": ["yt-dlp", "storage-root", "bilibili-auth"],
  "ytdlp.downloader": ["yt-dlp", "storage-root"],
  "torrent.downloader": ["storage-root"],
  "aria2.downloader": ["storage-root"]
};

const TOOL_RISK_LEVELS = {
  list_storage_files: "low",
  search_library_files: "low",
  read_file_metadata: "low",
  diagnose_file_access: "low",
  read_text_excerpt: "low",
  read_media_summary: "low",
  analyze_file_content: "medium",
  update_file_metadata: "medium",
  organize_files: "high",
  explain_file_access: "low",
  get_storage_file_details: "low",
  invoke_video_analyze: "medium",
  analyze_storage_video: "medium",
  invoke_video_tag: "medium",
  tag_storage_video: "medium",
  invoke_music_control: "low",
  invoke_bilibili_downloader: "medium",
  invoke_ytdlp_downloader: "medium",
  invoke_torrent_downloader: "medium",
  invoke_aria2_downloader: "medium",
  import_bilibili_video: "medium",
  search_bilibili_video: "low",
  search_web: "low",
  read_chat_history: "low",
  get_bot_job_status: "low",
  read_agent_trace: "low",
  read_bot_job_log: "low",
  describe_image: "low",
  search_yyets_show: "low",
  download_yyets_episodes: "medium"
};

const TOOL_HEALTH_CHECKS = {
  list_storage_files: ["storage-root"],
  search_library_files: ["storage-root"],
  read_file_metadata: ["storage-root"],
  diagnose_file_access: ["storage-root"],
  read_text_excerpt: ["storage-root", "document-text"],
  read_media_summary: ["storage-root", "ffprobe"],
  analyze_file_content: ["ai-model", "storage-root", "document-text"],
  update_file_metadata: ["storage-root"],
  organize_files: ["storage-root"],
  explain_file_access: ["storage-root"],
  get_storage_file_details: ["storage-root"],
  invoke_video_analyze: ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root"],
  analyze_storage_video: ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root"],
  invoke_video_tag: ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root"],
  tag_storage_video: ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root"],
  invoke_music_control: ["music-bridge", "qq-music-cookie"],
  invoke_bilibili_downloader: ["storage-root", "yt-dlp", "bilibili-auth"],
  invoke_ytdlp_downloader: ["storage-root", "yt-dlp"],
  invoke_torrent_downloader: ["storage-root"],
  invoke_aria2_downloader: ["storage-root"],
  import_bilibili_video: ["storage-root", "yt-dlp", "bilibili-auth"],
  search_bilibili_video: ["ai-model"],
  search_web: ["ai-model"],
  read_chat_history: ["storage-root"],
  get_bot_job_status: ["storage-root"],
  read_agent_trace: ["storage-root"],
  read_bot_job_log: ["storage-root"],
  describe_image: ["ai-model", "storage-root"],
  search_yyets_show: ["ai-model"],
  download_yyets_episodes: ["storage-root"]
};

const BLOCKING_WARN_HEALTH_CHECKS = {
  "video.analyze": ["whisper"],
  "video.tag": ["whisper"],
  "music.control": ["music-bridge"],
  invoke_video_analyze: ["whisper"],
  analyze_storage_video: ["whisper"],
  invoke_video_tag: ["whisper"],
  tag_storage_video: ["whisper"],
  invoke_music_control: ["music-bridge"]
};

const CAPABILITY_EXAMPLES = {
  "video.analyze": ["总结这个视频并保存摘要"],
  "video.tag": ["给这个视频生成标签"],
  "music.control": ["播放周杰伦的晴天", "暂停音乐", "查看队列"],
  "bilibili.downloader": ["去 B 站找教程并下载入库"],
  search_library_files: ["找最近下载的视频", "查 Movies 目录里没有摘要的 mp4"],
  diagnose_file_access: ["这个文件 AI 能读什么", "诊断这个视频为什么还不能总结"],
  read_text_excerpt: ["读取这个 PDF 的前 2000 字"],
  analyze_file_content: ["分析这个 NAS 文件", "总结这个 PDF 文档"],
  explain_file_access: ["我能访问哪些 NAS 文件", "说明你的文件访问边界"],
  invoke_video_analyze: ["总结这个视频并保存摘要"],
  analyze_storage_video: ["总结这个视频"],
  invoke_video_tag: ["给这个视频生成标签"],
  read_media_summary: ["读取这个视频已有摘要、字幕状态、时长和分辨率"],
  update_file_metadata: ["给这个文件添加标签"],
  organize_files: ["把这几个文件移动到整理目录"],
  invoke_music_control: ["点歌 晴天", "下一首"],
  invoke_bilibili_downloader: ["下载这个 B 站视频"],
  invoke_ytdlp_downloader: ["下载这个 YouTube 视频"],
  invoke_torrent_downloader: ["下载这个 magnet 链接"],
  invoke_aria2_downloader: ["用 aria2 下载这个文件"],
  search_web: ["联网查询最新资料"],
  get_bot_job_status: ["刚才任务为什么失败了"],
  read_bot_job_log: ["查看这个 job 的日志", "刚才失败的详细日志是什么"]
};

const PROMPT_CORE_CAPABILITY_IDS = [
  "search_library_files",
  "diagnose_file_access",
  "explain_file_access",
  "analyze_file_content",
  "invoke_video_analyze",
  "analyze_storage_video",
  "invoke_video_tag",
  "tag_storage_video",
  "invoke_music_control",
  "search_web",
  "import_bilibili_video",
  "invoke_ytdlp_downloader",
  "invoke_aria2_downloader",
  "download_yyets_episodes",
  "organize_files",
  "get_bot_job_status",
  "read_agent_trace",
  "read_bot_job_log"
];

function normalizeRiskLevel(value = "low") {
  return ["low", "medium", "high"].includes(value) ? value : "low";
}

export function buildCapabilityDescriptors(api = {}) {
  const bots = typeof api.listBots === "function" ? api.listBots() : [];
  const botCapabilities = bots.map((bot) => ({
    id: String(bot.botId || "").trim(),
    kind: "bot",
    displayName: String(bot.displayName || bot.botId || "").trim(),
    description: String(bot.description || "").trim(),
    inputSchema: bot.inputSchema && typeof bot.inputSchema === "object" ? bot.inputSchema : { type: "object", properties: {} },
    capabilities: Array.isArray(bot.capabilities) ? bot.capabilities.map((item) => String(item || "").trim()).filter(Boolean) : [],
    permissions: Array.isArray(bot.permissions) ? bot.permissions : [],
    riskLevel: normalizeRiskLevel(BOT_RISK_LEVELS[bot.botId] || "low"),
    executionMode: BOT_EXECUTION_MODES[bot.botId] || "async-job",
    requiresConfirmation: BOT_RISK_LEVELS[bot.botId] === "high",
    healthChecks: BOT_HEALTH_CHECKS[bot.botId] || ["storage-root"],
    examples: CAPABILITY_EXAMPLES[bot.botId] || []
  })).filter((item) => item.id);

  const toolCapabilities = getAiToolDefinitions().map((tool) => ({
    id: String(tool.name || "").trim(),
    kind: "tool",
    displayName: String(tool.name || "").trim(),
    description: String(tool.description || "").trim(),
    inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
    capabilities: [],
    permissions: [],
    riskLevel: normalizeRiskLevel(TOOL_RISK_LEVELS[tool.name] || "low"),
    executionMode: [
      "analyze_file_content",
      "invoke_video_analyze",
      "analyze_storage_video",
      "invoke_video_tag",
      "tag_storage_video",
      "import_bilibili_video",
      "invoke_bilibili_downloader",
      "invoke_ytdlp_downloader",
      "invoke_torrent_downloader",
      "invoke_aria2_downloader",
      "download_yyets_episodes"
    ].includes(tool.name) ? "async-job" : "sync",
    requiresConfirmation: TOOL_RISK_LEVELS[tool.name] === "high",
    healthChecks: TOOL_HEALTH_CHECKS[tool.name] || [],
    examples: CAPABILITY_EXAMPLES[tool.name] || []
  })).filter((item) => item.id);

  return [...botCapabilities, ...toolCapabilities];
}

function summarizeCheckForPrompt(check = {}) {
  const label = String(check?.label || check?.id || "unknown").trim();
  const status = String(check?.status || "unknown").trim();
  const detail = String(check?.detail || "").trim();
  const repairHint = String(check?.repairHint || "").trim();
  if (!detail) {
    return repairHint ? `${label}=${status} fix=${repairHint.slice(0, 120)}` : `${label}=${status}`;
  }
  const compactDetail = detail
    .replace(/[A-Za-z]:[\\/][^\s；,，]+/g, "[local-path]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .slice(0, 120);
  const compactHint = repairHint
    .replace(/[A-Za-z]:[\\/][^\s；,，]+/g, "[local-path]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .slice(0, 120);
  return `${label}=${status} (${compactDetail})${compactHint ? ` fix=${compactHint}` : ""}`;
}

export function summarizeCapabilityAvailability(descriptor = {}, health = {}) {
  const checks = new Map((Array.isArray(health.checks) ? health.checks : []).map((check) => [check.id, check]));
  const related = (Array.isArray(descriptor.healthChecks) ? descriptor.healthChecks : [])
    .map((id) => checks.get(id))
    .filter(Boolean);
  const repairHints = related
    .filter((check) => check.status && check.status !== "ok" && String(check.repairHint || "").trim())
    .map((check) => ({
      id: String(check.id || "").trim(),
      label: String(check.label || check.id || "").trim(),
      hint: String(check.repairHint || "").trim()
    }));
  if (!related.length) {
    return { status: "unknown", detail: "未绑定健康检查", repairHints: [] };
  }
  const failing = related.find((check) => check.status === "error");
  if (failing) {
    return { status: "error", detail: `${failing.label}: ${failing.detail}`, repairHints };
  }
  const warning = related.find((check) => check.status === "warn");
  if (warning) {
    return { status: "warn", detail: `${warning.label}: ${warning.detail}`, repairHints };
  }
  return { status: "ok", detail: "依赖就绪", repairHints: [] };
}

export function summarizeCapabilityExecutionReadiness(descriptor = {}, health = {}) {
  const checks = new Map((Array.isArray(health.checks) ? health.checks : []).map((check) => [check.id, check]));
  const related = (Array.isArray(descriptor.healthChecks) ? descriptor.healthChecks : [])
    .map((id) => checks.get(id))
    .filter(Boolean);
  const blockingWarnIds = new Set(BLOCKING_WARN_HEALTH_CHECKS[descriptor.id] || []);
  const blocker = related.find((check) => (
    check.status === "error"
    || (check.status === "warn" && blockingWarnIds.has(check.id))
  ));
  if (!blocker) {
    return {
      ready: true,
      status: summarizeCapabilityAvailability(descriptor, health).status,
      detail: "依赖就绪"
    };
  }
  return {
    ready: false,
    status: blocker.status || "error",
    blocker,
    detail: `${blocker.label || blocker.id}: ${blocker.detail || blocker.status || "unavailable"}`
  };
}

export function formatCapabilityReport(descriptors = [], health = {}) {
  const statusLabel = {
    ok: "ok",
    warn: "warn",
    error: "error",
    unknown: "unknown"
  };
  const lines = ["AI Agent 工具与 Bot 能力："];
  for (const kind of ["bot", "tool"]) {
    const items = descriptors.filter((item) => item.kind === kind);
    if (!items.length) {
      continue;
    }
    lines.push("", kind === "bot" ? "Bot:" : "Tools:");
    for (const item of items) {
      const availability = summarizeCapabilityAvailability(item, health);
      const caps = item.capabilities.length ? ` · ${item.capabilities.join(", ")}` : "";
      lines.push(`- [${statusLabel[availability.status] || availability.status}] ${item.id} · ${item.displayName || item.id} · risk=${item.riskLevel} · mode=${item.executionMode}${caps}`);
      if (availability.status !== "ok") {
        lines.push(`  - ${availability.detail}`);
        for (const hint of (Array.isArray(availability.repairHints) ? availability.repairHints : []).slice(0, 3)) {
          lines.push(`  - 建议(${hint.label || hint.id}): ${hint.hint}`);
        }
      }
    }
  }
  return lines.join("\n");
}

export function formatCapabilityPromptSummary(descriptors = [], health = {}, options = {}) {
  const maxItems = Math.max(4, Math.min(24, Number(options.maxItems || PROMPT_CORE_CAPABILITY_IDS.length) || PROMPT_CORE_CAPABILITY_IDS.length));
  const checks = Array.isArray(health.checks) ? health.checks : [];
  const nonOkChecks = checks.filter((check) => check.status && check.status !== "ok");
  const byId = new Map((Array.isArray(descriptors) ? descriptors : []).map((item) => [item.id, item]));
  const selected = PROMPT_CORE_CAPABILITY_IDS
    .map((id) => byId.get(id))
    .filter(Boolean)
    .slice(0, maxItems);

  const lines = [
    `Agent health snapshot: overall=${health.overall || "unknown"}${health.cached === true ? " (cached)" : ""}.`
  ];
  if (nonOkChecks.length) {
    lines.push(`Unavailable or degraded checks: ${nonOkChecks.map(summarizeCheckForPrompt).join("; ")}.`);
  } else {
    lines.push("Core checks are ok; still verify tool results instead of assuming success.");
  }

  if (selected.length) {
    lines.push("Core capabilities available to consider:");
    for (const item of selected) {
      const availability = summarizeCapabilityAvailability(item, health);
      const examples = Array.isArray(item.examples) && item.examples.length ? ` examples=${item.examples.slice(0, 2).join(" / ")}` : "";
      lines.push(`- ${item.id}: status=${availability.status}, risk=${item.riskLevel}, mode=${item.executionMode}.${examples}`);
    }
  }
  lines.push("Use unavailable/degraded capability details to explain blockers before starting dependent jobs. High risk actions require explicit confirmation.");
  return lines.join("\n");
}
