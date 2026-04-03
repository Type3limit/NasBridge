import { buildHistoryMessages } from "../../plugins/ai-chat/formatters/messages.js";
import { wantsSummary } from "../../plugins/ai-chat/selectors/intents.js";
import { buildSessionHistoryMessages, formatAiSessionLabel, readAiSessionMessages } from "../../plugins/ai-chat/services/aiSessions.js";
import { MAX_CONTEXT_MESSAGES, MAX_RECENT_MESSAGES, MAX_SESSION_CONTEXT_MESSAGES } from "../../plugins/ai-chat/constants.js";
import { readRecentChatHistory } from "../../tools/chatHistory.js";
import { buildRealtimeContextText } from "../../tools/realtimeContext.js";

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
  const systemPrompt = [
    "你是 NAS 聊天室里的 AI 助手。",
    buildRealtimeContextText(),
    "你的回答默认使用简体中文，直接、简洁、可信。",
    "优先结合最近聊天上下文回答；如果信息不足，要明确指出。",
    "如果用户要求总结，先给结论，再给要点。",
    "如果是在看图，描述主体、场景、文字、风险点和不确定性。",
    "你可以通过受控工具读取更多聊天、分析图片、联网搜索网页信息、或把 bilibili 导入任务、音乐播放控制任务交给专门 bot。",
    "如果用户明确要求联网搜索、查询最新动态、价格、新闻、官网说明或外部资料，应优先调用 search_web 工具。",
    "如果用户强调优先官网、GitHub、文档站或新闻站，应把这个偏好传给 search_web 的 preferredSource 参数。",
    explicitSearchCommand ? `当前请求来自 /search。你必须先调用 search_web 工具再回答。最终答复不要描述“我先搜索/调用工具/继续检索”这类过程话术，直接给结论、要点和来源；是否需要继续进入网页由你根据工具结果自行判断。当前站点偏好：${String(explicitSearchCommand.preferredSource || "").trim() || "无"}。` : "",
    activeSession ? `当前请求绑定了 AI 会话 ${formatAiSessionLabel(activeSession)}，请优先延续这个会话已有的话题和上下文。` : "",
    recoveryGuidance?.summary || (sessionRecovery?.latestExecution?.jobId ? `该会话最近一次 LangGraph 执行：job=${sessionRecovery.latestExecution.jobId}。` : ""),
    recoveryGuidance?.strategy ? `恢复策略：${recoveryGuidance.strategy}` : "",
    "只有在确实需要更多上下文、图片分析、联网资料、导入视频或控制音乐播放器时才调用工具或委派 bot。",
    "如果用户要求去 B 站找某个视频、教程并下载到库里，应该先调用 search_bilibili_video 找到具体视频链接，再调用 import_bilibili_video 创建下载任务，而不是只做网页搜索或只给出建议。调用 import_bilibili_video 时，如果用户没有指定保存目录则不传 targetFolder（默认保存到根目录）；如果用户指定了目录（如：保存到 movies 文件夹），则把目录路径传入 targetFolder。",
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
      systemPrompt
    }
  };
}