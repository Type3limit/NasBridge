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
  if (normalized === "describe_image") {
    return {
      phase: "tool-describe-image",
      label: safeRound > 0 ? `继续分析图片内容（第 ${safeRound + 1} 轮）` : "分析图片内容",
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