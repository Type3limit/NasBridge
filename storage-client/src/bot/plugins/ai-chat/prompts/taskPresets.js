function normalizeText(value = "") {
  return String(value || "").trim().toLowerCase();
}

function matchesAny(text = "", patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function redactPromptExampleText(value = "", limit = 120) {
  return String(value || "")
    .replace(/[A-Za-z]:[\\/][^\s；,，]+/g, "[local-path]")
    .replace(/\\\\[^\s；,，]+/g, "[network-path]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, "sk-[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function buildMatchedCapabilityExampleLines(presets = [], descriptors = [], options = {}) {
  const maxCapabilities = Math.max(0, Math.min(12, Number(options.maxCapabilityExamples || 8) || 8));
  const maxExamplesPerCapability = Math.max(1, Math.min(3, Number(options.maxExamplesPerCapability || 2) || 2));
  if (!maxCapabilities || !Array.isArray(descriptors) || !descriptors.length) {
    return [];
  }
  const presetText = (Array.isArray(presets) ? presets : [])
    .flatMap((preset) => [preset?.id, preset?.title, ...(Array.isArray(preset?.lines) ? preset.lines : [])])
    .join("\n")
    .toLowerCase();
  const lines = [];
  const seen = new Set();
  for (const descriptor of descriptors) {
    const id = String(descriptor?.id || "").trim();
    if (!id || seen.has(id) || !presetText.includes(id.toLowerCase())) {
      continue;
    }
    const examples = (Array.isArray(descriptor.examples) ? descriptor.examples : [])
      .map((item) => redactPromptExampleText(item))
      .filter(Boolean)
      .slice(0, maxExamplesPerCapability);
    if (!examples.length) {
      continue;
    }
    seen.add(id);
    lines.push(`- ${id}: ${examples.join(" / ")}`);
    if (lines.length >= maxCapabilities) {
      break;
    }
  }
  return lines;
}

const ALWAYS_ON_GUIDANCE = {
  id: "agent-operating-rules",
  title: "Agent operating rules",
  triggers: [],
  lines: [
    "先用最小只读工具确认事实，再选择写入、下载或长任务工具。",
    "需要文件内容时先拿 fileId/relativePath；不要编造绝对路径或声称读取了未通过工具读取的内容。",
    "具体文件能否读取/分析不确定时，先调用 diagnose_file_access，根据 layers、blockers 和 nextActions 选择下一步工具。",
    "长任务优先用 waitUntilPhase 等到 running/transcribe/download 等可见阶段后再回答；回答里必须给出 botId、jobId、当前 status/phase 和下一步可用的 get_bot_job_status/read_agent_trace/read_bot_job_log。",
    "工具不可用或 health degraded 时，先解释具体依赖项，再给可恢复步骤。"
  ]
};

const TASK_PRESETS = [
  {
    id: "file-search",
    title: "Find NAS files",
    triggers: [/找|查|搜索|最近|文件|目录|file|search|recent/i],
    lines: [
      "调用 search_library_files/list_storage_files 定位候选文件，优先使用 kind/pathPrefix/tags/hasAiSummary/hasSubtitle 过滤。",
      "多个候选时先列出候选和选择依据；只有目标明确后再读 metadata、摘要或正文片段。",
      "读取详情用 read_file_metadata/read_media_summary/get_storage_file_details；正文、PDF、Office 文档片段用 read_text_excerpt。"
    ]
  },
  {
    id: "document-read",
    title: "Read NAS documents or text excerpts",
    triggers: [/文档|正文|文本|前\s*\d+\s*字|读取|阅读|摘录|pdf|markdown|\.md|\.txt|read|document|excerpt/i],
    lines: [
      "先用 search_library_files/list_storage_files 定位 fileId，再调用 diagnose_file_access 确认 text/PDF/Office/字幕片段的可读层级。",
      "用户要求读取、摘录、前 N 字、按正文回答或总结文档时，优先调用 read_text_excerpt；根据需要设置 maxChars、startChar 和 source，片段截断时继续分页读取。",
      "只有需要跨多个片段综合分析、生成正式摘要，或 diagnose_file_access/actionPlan 明确建议时，才调用 analyze_file_content；不要跳过片段读取就声称已读完整文档。"
    ]
  },
  {
    id: "video-analysis",
    title: "Analyze or summarize media",
    triggers: [/视频|音频|字幕|转写|tag|标签|video|audio|subtitle/i],
    lines: [
      "先用 search_library_files 搜索文件，再用 read_media_summary 检查 aiSummary/subtitle 是否已有，并读取时长、分辨率、音轨等 probe 信息。用户说“没总结/没有摘要”时搜索参数要带 hasAiSummary=false；用户说“没字幕/未转写”时带 hasSubtitle=false。",
      "没有摘要时调用 invoke_video_analyze；长视频默认 waitForCompletion=false，可设置 waitUntilPhase=transcribe 或 running 等到任务真正开始后返回 jobId/status/phase。",
      "打标签用 invoke_video_tag；批量标签必须先说明影响范围并取得 confirmed=true。"
    ]
  },
  {
    id: "content-analysis",
    title: "Analyze a NAS file",
    triggers: [/分析|总结|摘要|阅读|读取|文档|图片|截图|看图|视觉|pdf|markdown|内容|analy[sz]e|summari[sz]e|summary|read|document|image|vision/i],
    lines: [
      "当前消息附件或最近聊天图片需要看图时，优先调用 describe_image；NAS 图片文件则先 search_library_files kind=image 定位 fileId，再调用 analyze_file_content mode=image。",
      "目标文件明确后优先调用 analyze_file_content；它会按文本、PDF/Office 文档、图片、媒体类型选择受控分析路径。",
      "如果文件类型、字幕/摘要状态或所需依赖不确定，先调用 diagnose_file_access，再决定读片段、复用摘要或启动 video.analyze。",
      "大文本和文档只读取抽取片段，必要时分页/抽样；图片走视觉模型；视频/音频优先复用字幕/摘要。"
    ]
  },
  {
    id: "metadata-and-organization",
    title: "Update metadata or organize files",
    triggers: [/标签|整理|移动|重命名|归类|删除|清理|metadata|organize|move|rename|delete|trash/i],
    lines: [
      "单文件 tags/aiSummary/notes 使用 update_file_metadata，并记录审计结果。",
      "批量 metadata 写入前说明文件数量、字段变化和影响范围，取得 confirmed=true。",
      "移动/重命名只能用 organize_files；删除/清理只能用 trash_files 移入隐藏回收站，不做永久删除；都要先 dryRun=true 展示预览，用户确认后才 dryRun=false confirmed=true。"
    ]
  },
  {
    id: "music-control",
    title: "Control music playback",
    triggers: [/音乐|播放|点歌|暂停|下一首|上一首|队列|qq音乐|music|song|play|pause|queue/i],
    lines: [
      "播放、搜歌、暂停、切歌、队列、切换音源都优先调用 invoke_music_control。",
      "默认 source=qq；如果 QQ cookie degraded，可尝试公开结果并提示会员/灰色歌曲可能失败。"
    ]
  },
  {
    id: "downloads",
    title: "Download into library",
    triggers: [/下载|入库|b站|bilibili|youtube|磁力|torrent|aria2|ed2k|剧集|电影|download|magnet/i],
    lines: [
      "Bilibili 搜索下载：先 search_bilibili_video，再 invoke_bilibili_downloader；已有明确 BV/URL 可直接调用 invoke_bilibili_downloader。",
      "YouTube/X/普通视频页用 invoke_ytdlp_downloader；magnet/.torrent 用 invoke_torrent_downloader 或 invoke_aria2_downloader；HTTP/ed2k 优先 invoke_aria2_downloader。",
      "下载类长任务可设置 waitUntilPhase=download 或 running 等到任务开始下载后返回；回答里给 jobId、status/phase、保存目录和追踪命令。",
      "剧集/电影资源搜索用 search_yyets_show，再 download_yyets_episodes；下载任务通常后台执行，回答里给 jobId 和保存目录。"
    ]
  },
  {
    id: "diagnostics",
    title: "Diagnose bot or agent failures",
    triggers: [/失败|报错|卡住|进度|状态|job|trace|日志|为什么|failed|error|status|progress|log/i],
    lines: [
      "先调用 get_bot_job_status；用户明确问日志、终端输出、报错细节或 /log <jobId> 时调用 read_bot_job_log；涉及 agent 步骤、工具调用、上次执行路径时调用 read_agent_trace。",
      "回答必须指出失败阶段、botId/tool、jobId、错误原因和下一步修复/重试建议。"
    ]
  },
  {
    id: "file-access",
    title: "Explain NAS access",
    triggers: [/访问|权限|能看到|能读取|边界|隐私|access|permission/i],
    lines: [
      "用户询问你能访问什么时调用 explain_file_access。",
      "强调只能访问 STORAGE_ROOT 内索引、metadata、摘要、字幕和受控片段；不能读任意本机路径或二进制原文。"
    ]
  }
];

export function selectNasAgentTaskPresets(prompt = "", options = {}) {
  if (options.includeAll === true) {
    return [ALWAYS_ON_GUIDANCE, ...TASK_PRESETS];
  }
  const text = normalizeText(prompt);
  const selected = TASK_PRESETS.filter((preset) => matchesAny(text, preset.triggers));
  return [ALWAYS_ON_GUIDANCE, ...selected.slice(0, 4)];
}

export function buildNasAgentTaskPresetPrompt({ prompt = "", includeAll = false, descriptors = [], maxCapabilityExamples = 8 } = {}) {
  const presets = selectNasAgentTaskPresets(prompt, { includeAll });
  const exampleLines = buildMatchedCapabilityExampleLines(presets, descriptors, { maxCapabilityExamples });
  const sections = [
    "NAS agent task playbooks:",
    ...presets.map((preset) => [
      `- ${preset.title} (${preset.id}):`,
      ...preset.lines.map((line) => `  - ${line}`)
    ].join("\n")),
    exampleLines.length
      ? [
          "Capability examples matched to this task:",
          ...exampleLines
        ].join("\n")
      : ""
  ];
  return sections.filter(Boolean).join("\n");
}
