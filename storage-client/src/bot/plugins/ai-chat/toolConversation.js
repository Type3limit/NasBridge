import { executeAiToolCall, getAiToolDefinitions } from "../../tools/aiToolRuntime.js";
import { invokeTextModel } from "../../tools/llmClient.js";

const MAX_TOOL_ROUND_OFFSET = 8;

export function getAiToolProgress(toolName = "", round = 0) {
  const safeRound = Math.max(0, Number(round) || 0);
  const offset = Math.min(MAX_TOOL_ROUND_OFFSET, safeRound * 5);
  const normalized = String(toolName || "").trim();
  if (normalized === "search_web") {
    return {
      phase: "tool-search-web",
      label: safeRound > 0 ? `继续联网搜索并整理资料（第 ${safeRound + 1} 轮）` : "联网搜索并整理资料",
      percent: 44 + offset
    };
  }
  if (normalized === "search_bilibili_video") {
    return {
      phase: "tool-search-bilibili-video",
      label: safeRound > 0 ? `继续搜索 B 站候选视频（第 ${safeRound + 1} 轮）` : "搜索 B 站候选视频",
      percent: 46 + offset
    };
  }
  if (normalized === "read_chat_history") {
    return {
      phase: "tool-read-chat-history",
      label: safeRound > 0 ? `继续补充聊天上下文（第 ${safeRound + 1} 轮）` : "补充聊天上下文",
      percent: 40 + offset
    };
  }
  if (normalized === "get_bot_job_status") {
    return {
      phase: "tool-get-bot-job-status",
      label: safeRound > 0 ? `继续读取任务状态（第 ${safeRound + 1} 轮）` : "读取 bot 任务状态",
      percent: 42 + offset
    };
  }
  if (normalized === "read_agent_trace") {
    return {
      phase: "tool-read-agent-trace",
      label: safeRound > 0 ? `继续读取 agent trace（第 ${safeRound + 1} 轮）` : "读取 AI agent trace",
      percent: 42 + offset
    };
  }
  if (normalized === "describe_image") {
    return {
      phase: "tool-describe-image",
      label: safeRound > 0 ? `继续分析图片内容（第 ${safeRound + 1} 轮）` : "分析图片内容",
      percent: 46 + offset
    };
  }
  if (normalized === "list_storage_files") {
    return {
      phase: "tool-list-storage-files",
      label: safeRound > 0 ? `继续检索存储文件（第 ${safeRound + 1} 轮）` : "检索存储文件列表",
      percent: 42 + offset
    };
  }
  if (normalized === "search_library_files") {
    return {
      phase: "tool-search-library-files",
      label: safeRound > 0 ? `继续搜索 NAS 文件（第 ${safeRound + 1} 轮）` : "搜索 NAS 文件库",
      percent: 42 + offset
    };
  }
  if (normalized === "read_file_metadata") {
    return {
      phase: "tool-read-file-metadata",
      label: safeRound > 0 ? `继续读取文件元数据（第 ${safeRound + 1} 轮）` : "读取 NAS 文件元数据",
      percent: 43 + offset
    };
  }
  if (normalized === "read_text_excerpt") {
    return {
      phase: "tool-read-text-excerpt",
      label: safeRound > 0 ? `继续读取文本片段（第 ${safeRound + 1} 轮）` : "读取受控文本片段",
      percent: 45 + offset
    };
  }
  if (normalized === "read_media_summary") {
    return {
      phase: "tool-read-media-summary",
      label: safeRound > 0 ? `继续读取媒体摘要（第 ${safeRound + 1} 轮）` : "读取媒体派生摘要",
      percent: 45 + offset
    };
  }
  if (normalized === "update_file_metadata") {
    return {
      phase: "tool-update-file-metadata",
      label: safeRound > 0 ? `继续写入文件 metadata（第 ${safeRound + 1} 轮）` : "写入 NAS 文件 metadata",
      percent: 48 + offset
    };
  }
  if (normalized === "explain_file_access") {
    return {
      phase: "tool-explain-file-access",
      label: "说明 NAS 文件访问边界",
      percent: 42 + offset
    };
  }
  if (normalized === "get_storage_file_details") {
    return {
      phase: "tool-get-storage-file-details",
      label: safeRound > 0 ? `继续读取文件详情（第 ${safeRound + 1} 轮）` : "读取存储文件详情",
      percent: 44 + offset
    };
  }
  if (normalized === "analyze_storage_video") {
    return {
      phase: "tool-analyze-storage-video",
      label: safeRound > 0 ? `继续提交视频总结任务（第 ${safeRound + 1} 轮）` : "提交视频转录与总结任务",
      percent: 48 + offset
    };
  }
  if (normalized === "tag_storage_video") {
    return {
      phase: "tool-tag-storage-video",
      label: safeRound > 0 ? `继续提交视频打标签任务（第 ${safeRound + 1} 轮）` : "提交视频打标签任务",
      percent: 48 + offset
    };
  }
  if (normalized === "invoke_music_control") {
    return {
      phase: "tool-invoke-music-control",
      label: safeRound > 0 ? `继续委派音乐助手（第 ${safeRound + 1} 轮）` : "委派音乐助手",
      percent: 46 + offset
    };
  }
  if (normalized === "import_bilibili_video") {
    return {
      phase: "tool-import-bilibili-video",
      label: "委派 B 站下载任务",
      percent: 48 + offset
    };
  }
  return {
    phase: "tool-call",
    label: safeRound > 0 ? `继续调用工具（第 ${safeRound + 1} 轮）` : "调用辅助工具",
    percent: 42 + offset
  };
}

export function createToolAwarePlanningMessages({ systemPrompt, effectivePrompt, historyMessages }) {
  return [
    { role: "system", content: systemPrompt },
    ...(Array.isArray(historyMessages) ? historyMessages : []),
    { role: "user", content: effectivePrompt }
  ];
}

export function createToolCallAssistantMessage(result = {}) {
  return {
    role: "assistant",
    content: result.message?.content || "",
    tool_calls: result.message?.tool_calls || (Array.isArray(result.toolCalls) ? result.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.input || {})
      }
    })) : [])
  };
}

export async function invokeToolAwarePlanningRound({ messages, recentMessages, context, api, modelOverride = "", defaultTextModel = "", round = 0, maxToolRounds = 4 }) {
  if (round > maxToolRounds) {
    throw new Error("AI tool-call exceeded max rounds");
  }
  const allowMoreToolCalls = round < maxToolRounds;
  const tools = allowMoreToolCalls ? getAiToolDefinitions() : [];
  const planningMessages = Array.isArray(messages) ? [...messages] : [];
  await api.emitProgress({
    phase: "plan-reply",
    label: allowMoreToolCalls
      ? (round > 0 ? `整理工具结果并继续推理（第 ${round + 1} 轮）` : "分析问题并判断是否需要工具")
      : "已达到工具上限，基于现有结果生成最终回答",
    percent: Math.min(52, 34 + round * 6)
  });
  const result = await invokeTextModel({
    model: modelOverride || defaultTextModel || undefined,
    messages: planningMessages,
    tools,
    toolChoice: allowMoreToolCalls ? "auto" : "none",
    maxTokens: 1000,
    temperature: 0.25
  });
  const pendingToolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  if (pendingToolCalls.length) {
    planningMessages.push(createToolCallAssistantMessage(result));
  }
  return {
    planningMessages,
    pendingToolCalls,
    result,
    recentMessages,
    context
  };
}

export async function executePendingToolCallsRound({ pendingToolCalls, planningMessages, recentMessages, context, api, round = 0 }) {
  const nextMessages = Array.isArray(planningMessages) ? [...planningMessages] : [];
  const traceHooks = api?.traceHooks;
  for (const toolCall of Array.isArray(pendingToolCalls) ? pendingToolCalls : []) {
    await api.appendLog(`tool-call ${toolCall.name}: ${JSON.stringify(toolCall.input || {})}`);
    await api.emitProgress(getAiToolProgress(toolCall.name, round));
    let toolResult = "";
    try {
      toolResult = await executeAiToolCall(toolCall, context, api, { recentMessages });
      await traceHooks?.recordToolEvent?.({
        name: toolCall.name,
        round,
        status: "completed",
        input: toolCall.input || {},
        outputPreview: String(toolResult || "")
      });
    } catch (error) {
      const cancelled = error?.name === "AbortError" || /job cancelled/i.test(String(error?.message || ""));
      await traceHooks?.recordToolEvent?.({
        name: toolCall.name,
        round,
        status: cancelled ? "cancelled" : "failed",
        input: toolCall.input || {},
        outputPreview: String(error?.message || error || "")
      });
      throw error;
    }
    nextMessages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: toolResult
    });
  }
  return nextMessages;
}

export async function runToolAwareConversation({ systemPrompt, effectivePrompt, historyMessages, recentMessages, context, api, modelOverride = "", defaultTextModel = "", maxToolRounds = 4 }) {
  const messages = createToolAwarePlanningMessages({
    systemPrompt,
    effectivePrompt,
    historyMessages
  });

  for (let round = 0; round <= maxToolRounds; round += 1) {
    const planned = await invokeToolAwarePlanningRound({
      messages,
      recentMessages,
      context,
      api,
      modelOverride,
      defaultTextModel,
      round,
      maxToolRounds
    });

    if (!planned.pendingToolCalls.length) {
      return {
        planningMessages: planned.planningMessages,
        result: planned.result
      };
    }

    const nextMessages = await executePendingToolCallsRound({
      pendingToolCalls: planned.pendingToolCalls,
      planningMessages: planned.planningMessages,
      recentMessages,
      context,
      api,
      round
    });
    messages.splice(0, messages.length, ...nextMessages);
  }

  throw new Error("AI tool-call exceeded max rounds");
}
