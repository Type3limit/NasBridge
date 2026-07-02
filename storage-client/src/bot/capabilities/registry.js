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
  "video.analyze": ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root", "bot-queue"],
  "video.tag": ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root", "bot-queue"],
  "bilibili.downloader": ["yt-dlp", "storage-root", "bilibili-auth", "bot-queue"],
  "ytdlp.downloader": ["yt-dlp", "storage-root", "bot-queue"],
  "torrent.downloader": ["storage-root", "bot-queue"],
  "aria2.downloader": ["storage-root", "bot-queue"]
};

const BOT_PERMISSIONS = {
  "ai.chat": ["agent:execute", "tool:invoke", "chat:reply"],
  "ai.multimodal-image": ["ai:model:invoke", "storage:content:read"],
  "music.control": ["music:control"],
  "video.analyze": ["bot:invoke", "ai:model:invoke", "storage:content:read", "storage:metadata:write"],
  "video.tag": ["bot:invoke", "ai:model:invoke", "storage:metadata:write"],
  "bilibili.downloader": ["bot:invoke", "network:download", "storage:file:write"],
  "ytdlp.downloader": ["bot:invoke", "network:download", "storage:file:write"],
  "torrent.downloader": ["bot:invoke", "network:download", "storage:file:write"],
  "aria2.downloader": ["bot:invoke", "network:download", "storage:file:write"]
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

const TOOL_CAPABILITY_TAGS = {
  list_storage_files: ["file-index", "file-search"],
  search_library_files: ["file-index", "file-search"],
  read_file_metadata: ["file-metadata", "file-access"],
  diagnose_file_access: ["file-access", "dependency-diagnostic"],
  read_text_excerpt: ["file-excerpt", "document-text"],
  read_media_summary: ["media-metadata", "derived-content"],
  analyze_file_content: ["file-analysis", "model-inference"],
  update_file_metadata: ["metadata-write"],
  organize_files: ["file-mutation"],
  explain_file_access: ["file-access", "policy-explanation"],
  get_storage_file_details: ["file-metadata", "derived-content"],
  invoke_video_analyze: ["media-analysis", "bot-delegation"],
  analyze_storage_video: ["media-analysis", "bot-delegation"],
  invoke_video_tag: ["media-tagging", "metadata-write", "bot-delegation"],
  tag_storage_video: ["media-tagging", "metadata-write", "bot-delegation"],
  invoke_music_control: ["music-control", "bot-delegation"],
  invoke_bilibili_downloader: ["download", "bot-delegation"],
  invoke_ytdlp_downloader: ["download", "bot-delegation"],
  invoke_torrent_downloader: ["download", "bot-delegation"],
  invoke_aria2_downloader: ["download", "bot-delegation"],
  import_bilibili_video: ["download", "bot-delegation"],
  search_bilibili_video: ["web-search", "bilibili-search"],
  search_web: ["web-search"],
  read_chat_history: ["chat-history"],
  get_bot_job_status: ["job-diagnostic"],
  read_agent_trace: ["agent-trace"],
  read_bot_job_log: ["job-log"],
  describe_image: ["image-analysis", "model-inference"],
  search_yyets_show: ["web-search", "resource-search"],
  download_yyets_episodes: ["download", "bot-delegation"]
};

const TOOL_PERMISSIONS = {
  list_storage_files: ["storage:index:read"],
  search_library_files: ["storage:index:read"],
  read_file_metadata: ["storage:metadata:read"],
  diagnose_file_access: ["storage:metadata:read"],
  read_text_excerpt: ["storage:content:read"],
  read_media_summary: ["storage:derived:read"],
  analyze_file_content: ["ai:model:invoke", "storage:content:read", "bot:invoke"],
  update_file_metadata: ["storage:metadata:write"],
  organize_files: ["storage:file:move", "storage:file:rename"],
  explain_file_access: ["storage:policy:read"],
  get_storage_file_details: ["storage:metadata:read", "storage:derived:read"],
  invoke_video_analyze: ["bot:invoke", "ai:model:invoke", "storage:content:read", "storage:metadata:write"],
  analyze_storage_video: ["bot:invoke", "ai:model:invoke", "storage:content:read", "storage:metadata:write"],
  invoke_video_tag: ["bot:invoke", "ai:model:invoke", "storage:metadata:write"],
  tag_storage_video: ["bot:invoke", "ai:model:invoke", "storage:metadata:write"],
  invoke_music_control: ["bot:invoke", "music:control"],
  invoke_bilibili_downloader: ["bot:invoke", "network:download", "storage:file:write"],
  invoke_ytdlp_downloader: ["bot:invoke", "network:download", "storage:file:write"],
  invoke_torrent_downloader: ["bot:invoke", "network:download", "storage:file:write"],
  invoke_aria2_downloader: ["bot:invoke", "network:download", "storage:file:write"],
  import_bilibili_video: ["bot:invoke", "network:download", "storage:file:write"],
  search_bilibili_video: ["network:search"],
  search_web: ["network:search"],
  read_chat_history: ["chat:history:read"],
  get_bot_job_status: ["job:status:read"],
  read_agent_trace: ["job:trace:read"],
  read_bot_job_log: ["job:log:read"],
  describe_image: ["ai:model:invoke", "storage:content:read"],
  search_yyets_show: ["network:search"],
  download_yyets_episodes: ["bot:invoke", "network:download", "storage:file:write"]
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
  invoke_video_analyze: ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root", "bot-queue"],
  analyze_storage_video: ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root", "bot-queue"],
  invoke_video_tag: ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root", "bot-queue"],
  tag_storage_video: ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root", "bot-queue"],
  invoke_music_control: ["music-bridge", "qq-music-cookie"],
  invoke_bilibili_downloader: ["storage-root", "yt-dlp", "bilibili-auth", "bot-queue"],
  invoke_ytdlp_downloader: ["storage-root", "yt-dlp", "bot-queue"],
  invoke_torrent_downloader: ["storage-root", "bot-queue"],
  invoke_aria2_downloader: ["storage-root", "bot-queue"],
  import_bilibili_video: ["storage-root", "yt-dlp", "bilibili-auth", "bot-queue"],
  search_bilibili_video: ["ai-model"],
  search_web: ["ai-model"],
  read_chat_history: ["storage-root"],
  get_bot_job_status: ["storage-root"],
  read_agent_trace: ["storage-root"],
  read_bot_job_log: ["storage-root"],
  describe_image: ["ai-model", "storage-root"],
  search_yyets_show: ["ai-model"],
  download_yyets_episodes: ["storage-root", "bot-queue"]
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
  "list_storage_files",
  "search_library_files",
  "read_file_metadata",
  "get_storage_file_details",
  "read_media_summary",
  "read_text_excerpt",
  "diagnose_file_access",
  "explain_file_access",
  "analyze_file_content",
  "invoke_video_analyze",
  "analyze_storage_video",
  "invoke_video_tag",
  "tag_storage_video",
  "invoke_music_control",
  "search_web",
  "search_bilibili_video",
  "invoke_bilibili_downloader",
  "invoke_ytdlp_downloader",
  "invoke_torrent_downloader",
  "invoke_aria2_downloader",
  "search_yyets_show",
  "download_yyets_episodes",
  "organize_files",
  "get_bot_job_status",
  "read_agent_trace",
  "read_bot_job_log"
];

const CAPABILITY_WORKFLOWS = [
  {
    id: "media-summary",
    title: "Summarize NAS video/audio",
    tools: ["search_library_files", "read_media_summary", "invoke_video_analyze", "get_bot_job_status"],
    guidance: "先定位 fileId；用户说没总结/无摘要时 search_library_files 带 hasAiSummary=false，没字幕/未转写时带 hasSubtitle=false；再复用已有 aiSummary/subtitle，没有摘要时启动 invoke_video_analyze；长任务可用 waitUntilPhase=transcribe/running 等到可见阶段后返回 jobId/status/phase/trace 命令。"
  },
  {
    id: "document-read",
    title: "Read or summarize documents",
    tools: ["search_library_files", "diagnose_file_access", "read_text_excerpt", "analyze_file_content"],
    guidance: "先诊断可读层级，再分页读取文本/PDF/Office 片段；需要综合分析时调用 analyze_file_content。"
  },
  {
    id: "file-access-diagnostic",
    title: "Explain file access",
    tools: ["explain_file_access", "search_library_files", "diagnose_file_access"],
    guidance: "用户问能否访问/读取时先说明边界；针对具体文件先搜索再诊断 blockers、layers 和 nextActions。"
  },
  {
    id: "organize-files",
    title: "Organize NAS files",
    tools: ["search_library_files", "read_file_metadata", "organize_files"],
    guidance: "先搜索和读取 metadata，organize_files 默认 dry-run；移动/重命名必须取得明确确认后才 confirmed=true。"
  },
  {
    id: "music-playback",
    title: "Control music",
    tools: ["invoke_music_control"],
    guidance: "点歌、暂停、切歌和队列直接调用 invoke_music_control；QQ cookie 降级时说明播放限制和恢复方式。"
  },
  {
    id: "download-into-library",
    title: "Download into NAS library",
    tools: ["search_bilibili_video", "invoke_bilibili_downloader", "invoke_ytdlp_downloader", "invoke_torrent_downloader", "invoke_aria2_downloader", "search_yyets_show", "download_yyets_episodes"],
    guidance: "B 站先 search_bilibili_video 再 invoke_bilibili_downloader；明确 URL 选 invoke_ytdlp_downloader/aria2，magnet/torrent 选 invoke_torrent_downloader 或 invoke_aria2_downloader；下载类长任务可用 waitUntilPhase=download/running 等到开始下载后返回；剧集资源先 search_yyets_show 再 download_yyets_episodes。"
  },
  {
    id: "failure-diagnostic",
    title: "Diagnose bot or agent failure",
    tools: ["get_bot_job_status", "read_agent_trace", "read_bot_job_log"],
    guidance: "先读状态，再按需要读 trace/log；回答失败阶段、tool/bot、jobId、错误原因和可恢复动作。"
  }
];

function normalizeRiskLevel(value = "low") {
  return ["low", "medium", "high"].includes(value) ? value : "low";
}

function uniqueStrings(items = []) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function buildCapabilityDescriptors(api = {}) {
  const bots = typeof api.listBots === "function" ? api.listBots() : [];
  const botCapabilities = bots.map((bot) => ({
    id: String(bot.botId || "").trim(),
    kind: "bot",
    displayName: String(bot.displayName || bot.botId || "").trim(),
    description: String(bot.description || "").trim(),
    inputSchema: bot.inputSchema && typeof bot.inputSchema === "object" ? bot.inputSchema : { type: "object", properties: {} },
    capabilities: uniqueStrings(bot.capabilities),
    permissions: uniqueStrings(Array.isArray(bot.permissions) && bot.permissions.length ? bot.permissions : BOT_PERMISSIONS[bot.botId]),
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
    capabilities: uniqueStrings(TOOL_CAPABILITY_TAGS[tool.name]),
    permissions: uniqueStrings(TOOL_PERMISSIONS[tool.name]),
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

function summarizeStorageAccessForPrompt(checks = []) {
  const storageCheck = (Array.isArray(checks) ? checks : []).find((check) => check?.id === "storage-root");
  if (!storageCheck) {
    return "";
  }
  const fileAccess = storageCheck.fileAccess && typeof storageCheck.fileAccess === "object"
    ? storageCheck.fileAccess
    : {};
  const policy = storageCheck.policy && typeof storageCheck.policy === "object"
    ? storageCheck.policy
    : {};
  const parts = [
    `status=${String(storageCheck.status || "unknown").trim() || "unknown"}`
  ];
  for (const [key, label] of [
    ["rootConfigured", "rootConfigured"],
    ["exists", "exists"],
    ["readable", "readable"],
    ["writable", "writable"]
  ]) {
    if (typeof fileAccess[key] === "boolean") {
      parts.push(`${label}=${fileAccess[key]}`);
    }
  }
  if (Number.isFinite(Number(fileAccess.files))) {
    parts.push(`indexedFiles=${Number(fileAccess.files)}`);
  }
  if (Number.isFinite(Number(fileAccess.directories))) {
    parts.push(`dirs=${Number(fileAccess.directories)}`);
  }
  if (String(fileAccess.indexSource || "").trim()) {
    parts.push(`indexSource=${String(fileAccess.indexSource).trim()}`);
  }
  if (String(fileAccess.indexedAt || "").trim()) {
    parts.push(`indexedAt=${String(fileAccess.indexedAt).trim()}`);
  }
  if (Number.isFinite(Number(fileAccess.hiddenDirsExcluded))) {
    parts.push(`hiddenDirsExcluded=${Number(fileAccess.hiddenDirsExcluded)}`);
  }
  if (Number.isFinite(Number(fileAccess.skippedDirectories)) && Number(fileAccess.skippedDirectories) > 0) {
    parts.push(`skippedDirs=${Number(fileAccess.skippedDirectories)}`);
  }
  const policyBits = [
    `storageRootOnly=${fileAccess.storageRootOnly ?? policy.storageRootOnly ?? "unknown"}`,
    `allowBinaryRead=${fileAccess.allowBinaryRead ?? policy.allowBinaryRead ?? "unknown"}`,
    `rawAbsolutePathExposed=${fileAccess.rawAbsolutePathExposed ?? policy.rawAbsolutePathExposed ?? "unknown"}`,
    `writeRequiresConfirmation=${fileAccess.writeRequiresConfirmation ?? policy.writeRequiresConfirmation ?? "unknown"}`
  ];
  return `NAS file access snapshot: ${parts.join(", ")}; policy ${policyBits.join(", ")}.`;
}

function selectCapabilityWorkflows(descriptors = [], maxWorkflows = 7) {
  const byId = new Map((Array.isArray(descriptors) ? descriptors : []).map((item) => [item.id, item]));
  return CAPABILITY_WORKFLOWS
    .filter((workflow) => workflow.tools.some((toolId) => byId.has(toolId)))
    .slice(0, maxWorkflows)
    .map((workflow) => ({
      ...workflow,
      availableTools: workflow.tools.filter((toolId) => byId.has(toolId))
    }));
}

function formatWorkflowToolStatuses(workflow = {}, descriptors = [], health = {}) {
  const byId = new Map((Array.isArray(descriptors) ? descriptors : []).map((item) => [item.id, item]));
  return (Array.isArray(workflow.availableTools) ? workflow.availableTools : [])
    .map((toolId) => {
      const descriptor = byId.get(toolId);
      if (!descriptor) {
        return "";
      }
      const availability = summarizeCapabilityAvailability(descriptor, health);
      return `${toolId}:${availability.status}`;
    })
    .filter(Boolean);
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

function formatCapabilityListValue(items = [], { maxItems = 4, separator = "/" } = {}) {
  const values = uniqueStrings(items);
  if (!values.length) {
    return "";
  }
  const visible = values.slice(0, maxItems);
  const suffix = values.length > visible.length ? `${separator}+${values.length - visible.length}` : "";
  return `${visible.join(separator)}${suffix}`;
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
      const caps = formatCapabilityListValue(item.capabilities, { maxItems: 4, separator: ", " });
      const permissions = formatCapabilityListValue(item.permissions, { maxItems: 4, separator: ", " });
      const metadata = [
        `risk=${item.riskLevel}`,
        `mode=${item.executionMode}`,
        caps ? `caps=${caps}` : "",
        permissions ? `perms=${permissions}` : ""
      ].filter(Boolean).join(" · ");
      lines.push(`- [${statusLabel[availability.status] || availability.status}] ${item.id} · ${item.displayName || item.id} · ${metadata}`);
      if (availability.status !== "ok") {
        lines.push(`  - ${availability.detail}`);
        for (const hint of (Array.isArray(availability.repairHints) ? availability.repairHints : []).slice(0, 3)) {
          lines.push(`  - 建议(${hint.label || hint.id}): ${hint.hint}`);
        }
      }
    }
  }
  const workflows = selectCapabilityWorkflows(descriptors, 7);
  if (workflows.length) {
    lines.push("", "常用工作流:");
    for (const workflow of workflows) {
      const toolChain = workflow.availableTools.join(" -> ");
      const statuses = formatWorkflowToolStatuses(workflow, descriptors, health);
      lines.push(`- ${workflow.id} · ${workflow.title}: ${toolChain}`);
      if (statuses.length) {
        lines.push(`  - 状态: ${statuses.join(", ")}`);
      }
      lines.push(`  - ${workflow.guidance}`);
    }
  }
  return lines.join("\n");
}

export function formatCapabilityPromptSummary(descriptors = [], health = {}, options = {}) {
  const maxItems = Math.max(4, Math.min(28, Number(options.maxItems || PROMPT_CORE_CAPABILITY_IDS.length) || PROMPT_CORE_CAPABILITY_IDS.length));
  const maxWorkflows = Math.max(0, Math.min(8, Number(options.maxWorkflows || 7) || 7));
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
  const storageAccessSummary = summarizeStorageAccessForPrompt(checks);
  if (storageAccessSummary) {
    lines.push(storageAccessSummary);
  }

  if (selected.length) {
    lines.push("Core capabilities available to consider:");
    for (const item of selected) {
      const availability = summarizeCapabilityAvailability(item, health);
      const caps = formatCapabilityListValue(item.capabilities, { maxItems: 3 });
      const permissions = formatCapabilityListValue(item.permissions, { maxItems: 3 });
      const examples = Array.isArray(item.examples) && item.examples.length ? ` examples=${item.examples.slice(0, 2).join(" / ")}` : "";
      lines.push(`- ${item.id}: status=${availability.status}, risk=${item.riskLevel}, mode=${item.executionMode}${caps ? `, caps=${caps}` : ""}${permissions ? `, perms=${permissions}` : ""}.${examples}`);
    }
  }
  const workflows = selectCapabilityWorkflows(descriptors, maxWorkflows);
  if (workflows.length) {
    lines.push("Recommended task workflows:");
    for (const workflow of workflows) {
      const toolStatuses = formatWorkflowToolStatuses(workflow, descriptors, health);
      lines.push(`- ${workflow.id}: ${workflow.availableTools.join(" -> ")}. status=${toolStatuses.join(", ")}. ${workflow.guidance}`);
    }
  }
  lines.push("Use unavailable/degraded capability details to explain blockers before starting dependent jobs. High risk actions require explicit confirmation.");
  return lines.join("\n");
}
