import { buildHistoryMessages } from "../../plugins/ai-chat/formatters/messages.js";
import { wantsSummary } from "../../plugins/ai-chat/selectors/intents.js";
import { buildSessionHistoryMessages, formatAiSessionLabel, readAiSessionMessages } from "../../plugins/ai-chat/services/aiSessions.js";
import { MAX_CONTEXT_MESSAGES, MAX_RECENT_MESSAGES, MAX_SESSION_CONTEXT_MESSAGES } from "../../plugins/ai-chat/constants.js";
import { readRecentChatHistory } from "../../tools/chatHistory.js";
import { buildRealtimeContextText } from "../../tools/realtimeContext.js";
import { collectAiAgentHealthCached } from "../../capabilities/health.js";
import { buildCapabilityDescriptors, formatCapabilityPromptSummary } from "../../capabilities/registry.js";
import { buildNasAgentTaskPresetPrompt } from "../../plugins/ai-chat/prompts/taskPresets.js";

export async function handleAiChatPrepareContextRoute(state = {}) {
  const prepared = state.prepared || {};
  const api = prepared.api;
  const context = prepared.context;
  const emitReplyProgress = prepared.emitReplyProgress;
  const toolAwarePrompt = prepared.toolAwarePrompt || "";
  const explicitSearchCommand = prepared.explicitSearchCommand || null;
  const activeSession = prepared.activeSession || null;
  const sessionRecovery = prepared.sessionRecovery || null;
  const recoveryGuidance = prepared.recoveryGuidance || null;

  api.throwIfCancelled();
  let healthSnapshot = null;
  let capabilityPromptSummary = "";
  let descriptors = [];
  try {
    healthSnapshot = await collectAiAgentHealthCached(api, {
      modelSettings: prepared.modelSettings || {},
      lightweight: true,
      signal: api.signal
    });
    descriptors = buildCapabilityDescriptors(api);
    capabilityPromptSummary = formatCapabilityPromptSummary(descriptors, healthSnapshot);
    await api.appendLog(`agent health snapshot: overall=${healthSnapshot.overall || "unknown"} cached=${healthSnapshot.cached === true}`);
  } catch (error) {
    await api.appendLog(`agent health snapshot failed: ${String(error?.message || error || "unknown error").trim()}`);
    capabilityPromptSummary = "Agent health snapshot unavailable; if a tool fails, explain the dependency error from the tool result instead of guessing.";
  }
  const recentMessages = await readRecentChatHistory({
    storageRoot: api.storageRoot,
    historyPath: context.chat.historyPath,
    limit: MAX_RECENT_MESSAGES,
    includeBots: true,
    lookbackDays: wantsSummary(toolAwarePrompt) ? 3 : 1
  });
  await api.appendLog(`loaded recent messages: ${recentMessages.length}`);
  await emitReplyProgress({ phase: "prepare-context", label: `已读取 ${recentMessages.length} 条最近消息，正在整理上下文`, percent: 22 });

  const historyMessages = buildHistoryMessages(recentMessages);
  const sessionMessages = activeSession
    ? await readAiSessionMessages(api.appDataRoot, activeSession.id, MAX_SESSION_CONTEXT_MESSAGES)
    : [];
  if (activeSession) {
    await api.appendLog(`loaded ai session messages: ${sessionMessages.length}`);
  }
  const combinedHistoryMessages = [...buildSessionHistoryMessages(sessionMessages), ...historyMessages]
    .slice(-(MAX_CONTEXT_MESSAGES + MAX_SESSION_CONTEXT_MESSAGES));
  const taskPresetPrompt = buildNasAgentTaskPresetPrompt({ prompt: toolAwarePrompt, descriptors });
  const replyApi = prepared.replyApi && typeof prepared.replyApi === "object"
    ? { ...prepared.replyApi, healthSnapshot }
    : prepared.replyApi;
  const systemPrompt = [
    "你是 NAS 聊天室里的 AI 助手。",
    buildRealtimeContextText(),
    capabilityPromptSummary,
    taskPresetPrompt,
    "你的回答默认使用简体中文，直接、简洁、可信。",
    "优先结合最近聊天上下文回答；如果信息不足，要明确指出。",
    "如果用户要求总结，先给结论，再给要点。",
    "如果是在看图，描述主体、场景、文字、风险点和不确定性。",
    "你可以通过受控工具读取更多聊天、分析图片、联网搜索网页信息、下载内容入库，或把任务交给专门 bot。如果用户要求点歌、暂停、切歌、查看队列等音乐播放控制操作，优先调用 invoke_music_control；没有 tool-call 时才把回答第一行写成 @music 指令委派给音乐助手，例如：`@music 点歌 晴天` / `@music 暂停` / `@music 下一曲` / `@music 队列`。",
    "如果用户明确要求联网搜索、查询最新动态、价格、新闻、官网说明或外部资料，应优先调用 search_web 工具。",
    "如果用户强调优先官网、GitHub、文档站或新闻站，应把这个偏好传给 search_web 的 preferredSource 参数。",
    "如果用户询问 bot 任务状态、刚才任务进度、jobId、失败原因、日志、终端输出、调用了哪些工具或 agent 卡在哪一步，必须先调用 get_bot_job_status、read_bot_job_log 或 read_agent_trace，不要凭记忆猜。",
    "如果用户询问 storage-client 文件库里有什么文件、某个文件的详情、已有 AI 总结、字幕/SRT，必须优先调用 list_storage_files/search_library_files，再用 fileId 调 read_file_metadata/get_storage_file_details/read_media_summary，不要凭聊天记录猜。",
    "NAS 文件访问必须走索引、fileId 和受控工具；不要编造本地绝对路径，不要声称自己已经读取了未通过工具读取的文件内容。",
    "如果用户询问某个 NAS 文件能不能读取、为什么不能总结/分析、该用哪个工具，先定位 fileId，再调用 diagnose_file_access，按返回的 layers/blockers/nextActions 说明。",
    "如果用户询问你能不能访问 NAS 文件，调用 explain_file_access；如果要读取正文，只能用 read_text_excerpt 读取可控长度片段，文本、字幕、PDF、Office Open XML 文档都走这个受控入口，视频/音频优先读取 read_media_summary 或字幕片段。",
    "如果用户笼统要求分析某个 NAS 文件，先用 list_storage_files/search_library_files 定位 fileId，再调用 analyze_file_content；它会按文本、图片、视频/音频自动选择受控分析路径。",
    "对多个候选文件，先列出候选并说明选择依据；只有用户指向明确文件或搜索结果足够明确时，才继续读取详情、字幕或启动分析。",
    "移动、重命名、删除/清理、覆盖大量标签等高风险文件操作必须先请求用户确认；只读 metadata、读取摘要/字幕、启动单个视频总结属于可直接执行的受控操作。写入单文件 tags/aiSummary 使用 update_file_metadata；批量写 metadata 前必须说明影响范围并取得用户确认。移动/重命名文件只能使用 organize_files；删除/清理只能使用 trash_files 移入隐藏回收站，不做永久删除；都要先 dry-run 预览影响范围，用户确认后才允许传 confirmed=true 和 dryRun=false。",
    "如果用户要求总结文件库里的某个视频/音频：先用 list_storage_files/search_library_files 定位文件；若已有 aiSummary，用 get_storage_file_details/read_media_summary 直接读取；若没有总结，调用 invoke_video_analyze 启动提取音频、转字幕和 AI 总结任务；对多个明确候选，传 fileIds/paths 预览影响范围，用户确认后逐个创建 video.analyze 子任务。长视频默认不要等完成；可设置 waitUntilPhase=transcribe 或 running 等任务进入可见阶段后返回，并说明 jobId/status/phase。",
    "如果用户要求给视频打标签，单文件使用 invoke_video_tag；对 search_library_files 找到的多个候选，传 fileIds/paths 只处理这些文件，只有用户明确要求全库时才传 batch=true；批量写标签前必须先说明影响范围并取得用户确认。",
    '重要：当你决定调用任何工具（如 search_web）时，必须等工具返回结果后，基于实际获取到的内容给出具体、有实质信息的回答（标题、数据、要点、来源等）。绝不要仅描述"我去搜索…稍等"就结束——那不算有效回答。如果工具调用结果不够充分，应继续调用工具补充信息，直到能给出有价值的具体内容。',
    explicitSearchCommand ? `当前请求来自 /search。你必须先调用 search_web 工具再回答。最终答复不要描述“我先搜索/调用工具/继续检索”这类过程话术，直接给结论、要点和来源；是否需要继续进入网页由你根据工具结果自行判断。当前站点偏好：${String(explicitSearchCommand.preferredSource || "").trim() || "无"}。` : "",
    activeSession ? `当前请求绑定了 AI 会话 ${formatAiSessionLabel(activeSession)}，请优先延续这个会话已有的话题和上下文。` : "",
    recoveryGuidance?.summary || (sessionRecovery?.latestExecution?.jobId ? `该会话最近一次 LangGraph 执行：job=${sessionRecovery.latestExecution.jobId}。` : ""),
    recoveryGuidance?.strategy ? `恢复策略：${recoveryGuidance.strategy}` : "",
    "只有在确实需要更多上下文、图片分析、联网资料、导入视频或控制音乐播放器时才调用工具或委派 bot。",
    "如果用户要求去 B 站找某个视频、教程并下载到库里，应该先调用 search_bilibili_video 找到具体视频链接，再调用 invoke_bilibili_downloader 创建下载任务，而不是只做网页搜索或只给出建议。已有明确 BV/URL 时可直接调用 invoke_bilibili_downloader；如果用户没有指定保存目录则不传 targetFolder（默认保存到对应 bot 的默认目录）；如果用户指定了目录（如：保存到 movies 文件夹），则把目录路径传入 targetFolder。下载类长任务可设置 waitUntilPhase=download 或 running，等任务开始后返回 jobId/status/phase。",
    "如果用户要求下载某部剧集、电影（包括自动下载离线剧集），应使用 search_yyets_show 在 YYeTs 搜索资源，找到 id 后再调用 download_yyets_episodes 下载磁力链接；下载内容会自动保存在以剧集名称命名的专属文件夹下（TV shows/<剧名>/）。如需下载整季，传入 season_num；如需特定集，传入 episodes 数组。调用 download_yyets_episodes 后，下载任务会在后台执行，直接向用户说明已提交哪些集的下载任务即可。",
    "如果你决定把任务交给其他 bot，不要在最终回答里只是写出类似 @music ... 的命令文本；应直接给出简短说明。若你的最终回答第一行仍然是 @bot 指令，系统会把它当作真实委派执行。",
    "不要编造不存在的文件、用户或聊天记录。"
  ].filter(Boolean).join("\n");

  return {
    route: prepared.resumeRoute === "textTools" ? "textTools" : prepared.visionRequest ? "vision" : "text",
    prepared: {
      ...prepared,
      recentMessages,
      combinedHistoryMessages,
      healthSnapshot,
      replyApi,
      capabilityPromptSummary,
      taskPresetPrompt,
      systemPrompt
    }
  };
}
