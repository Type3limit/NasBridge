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
  "ai.chat": ["ai-model", "storage-root"],
  "ai.multimodal-image": ["ai-model", "storage-root"],
  "music.control": ["music-bridge"],
  "video.analyze": ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root"],
  "video.tag": ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root"],
  "bilibili.downloader": ["yt-dlp", "storage-root"],
  "ytdlp.downloader": ["yt-dlp", "storage-root"],
  "torrent.downloader": ["storage-root"],
  "aria2.downloader": ["storage-root"]
};

const TOOL_RISK_LEVELS = {
  list_storage_files: "low",
  search_library_files: "low",
  read_file_metadata: "low",
  read_text_excerpt: "low",
  read_media_summary: "low",
  analyze_file_content: "medium",
  update_file_metadata: "medium",
  explain_file_access: "low",
  get_storage_file_details: "low",
  analyze_storage_video: "medium",
  tag_storage_video: "medium",
  invoke_music_control: "low",
  import_bilibili_video: "medium",
  search_bilibili_video: "low",
  search_web: "low",
  read_chat_history: "low",
  get_bot_job_status: "low",
  read_agent_trace: "low",
  describe_image: "low",
  search_yyets_show: "low",
  download_yyets_episodes: "medium"
};

const TOOL_HEALTH_CHECKS = {
  list_storage_files: ["storage-root"],
  search_library_files: ["storage-root"],
  read_file_metadata: ["storage-root"],
  read_text_excerpt: ["storage-root"],
  read_media_summary: ["storage-root"],
  analyze_file_content: ["ai-model", "storage-root"],
  update_file_metadata: ["storage-root"],
  explain_file_access: ["storage-root"],
  get_storage_file_details: ["storage-root"],
  analyze_storage_video: ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root"],
  tag_storage_video: ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root"],
  invoke_music_control: ["music-bridge"],
  import_bilibili_video: ["storage-root", "yt-dlp"],
  search_bilibili_video: ["ai-model"],
  search_web: ["ai-model"],
  read_chat_history: ["storage-root"],
  get_bot_job_status: ["storage-root"],
  read_agent_trace: ["storage-root"],
  describe_image: ["ai-model", "storage-root"],
  search_yyets_show: ["ai-model"],
  download_yyets_episodes: ["storage-root"]
};

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
    examples: []
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
    executionMode: ["analyze_file_content", "analyze_storage_video", "import_bilibili_video", "download_yyets_episodes"].includes(tool.name) ? "async-job" : "sync",
    requiresConfirmation: TOOL_RISK_LEVELS[tool.name] === "high",
    healthChecks: TOOL_HEALTH_CHECKS[tool.name] || [],
    examples: []
  })).filter((item) => item.id);

  return [...botCapabilities, ...toolCapabilities];
}

export function summarizeCapabilityAvailability(descriptor = {}, health = {}) {
  const checks = new Map((Array.isArray(health.checks) ? health.checks : []).map((check) => [check.id, check]));
  const related = (Array.isArray(descriptor.healthChecks) ? descriptor.healthChecks : [])
    .map((id) => checks.get(id))
    .filter(Boolean);
  if (!related.length) {
    return { status: "unknown", detail: "未绑定健康检查" };
  }
  const failing = related.find((check) => check.status === "error");
  if (failing) {
    return { status: "error", detail: `${failing.label}: ${failing.detail}` };
  }
  const warning = related.find((check) => check.status === "warn");
  if (warning) {
    return { status: "warn", detail: `${warning.label}: ${warning.detail}` };
  }
  return { status: "ok", detail: "依赖就绪" };
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
      }
    }
  }
  return lines.join("\n");
}
