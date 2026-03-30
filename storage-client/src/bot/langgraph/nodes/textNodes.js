import { createBotJobMessageId } from "../../context.js";
import { createRecoveryContinuationMessage } from "../../plugins/ai-chat/recovery.js";
import { createAnswerCard } from "../../plugins/ai-chat/formatters/cards.js";
import { findBotInvocationInAnswer } from "../../plugins/ai-chat/selectors/botInvocations.js";
import { appendAiSessionTurn } from "../../plugins/ai-chat/services/aiSessions.js";
import { delegateBotInvocation } from "../../plugins/ai-chat/delegation.js";
import { streamFinalAnswer } from "../../plugins/ai-chat/streaming.js";
import { createToolAwarePlanningMessages, executePendingToolCallsRound, invokeToolAwarePlanningRound } from "../../plugins/ai-chat/toolConversation.js";
import { MAX_TOOL_ROUNDS } from "../../plugins/ai-chat/constants.js";

async function finalizeAiChatTextRoute({ prepared = {}, planningMessages = [], modelResult = null }) {
  const api = prepared.api;
  const context = prepared.context;
  const emitReplyProgress = prepared.emitReplyProgress;
  const replyApi = prepared.replyApi;
  const toolAwarePrompt = prepared.toolAwarePrompt || "";
  const modelOverride = prepared.modelOverride || "";
  const defaultTextModel = prepared.defaultTextModel || "";
  const catalog = Array.isArray(prepared.catalog) ? prepared.catalog : [];
  let activeSession = prepared.activeSession || null;

  api.throwIfCancelled();
  const replyMessageId = createBotJobMessageId(context.jobId);
  await emitReplyProgress({ phase: "prepare-stream-reply", label: "整理回复草稿", percent: 74 });
  await emitReplyProgress({ phase: "wait-first-token", label: "等待模型返回首个片段", percent: 82 });
  const streamed = await streamFinalAnswer({
    planningMessages,
    api: replyApi,
    replyMessageId,
    mode: "text",
    modelOverride,
    defaultTextModel
  });
  const answer = String(streamed.answer || modelResult?.text || "").trim() || "模型没有返回可显示的内容。";
  const delegatedFromAnswer = findBotInvocationInAnswer(answer, catalog);
  if (delegatedFromAnswer) {
    const delegated = await delegateBotInvocation(api, context, delegatedFromAnswer, activeSession, {
      replyMessageId,
      triggerType: "delegated-from-ai-answer",
      subtitle: streamed.model || modelResult?.model
        ? `模型: ${streamed.model || modelResult?.model} · 已委派给 ${delegatedFromAnswer.target.displayName}`
        : `已委派给 ${delegatedFromAnswer.target.displayName}`
    });
    if (activeSession) {
      activeSession = await appendAiSessionTurn(api.appDataRoot, activeSession, toolAwarePrompt, delegated.reply);
    }
    return {
      result: {
        chatReply: delegated.chatReply,
        importedFiles: [],
        artifacts: delegated.artifacts
      }
    };
  }

  if (activeSession) {
    activeSession = await appendAiSessionTurn(api.appDataRoot, activeSession, toolAwarePrompt, answer);
  }
  await emitReplyProgress({ phase: "append-chat-reply", label: "写入最终回复", percent: 96 });
  return {
    result: {
      chatReply: await api.publishChatReply({
        id: replyMessageId,
        text: answer,
        card: createAnswerCard(answer, streamed.model || modelResult?.model, "text", activeSession)
      }),
      importedFiles: [],
      artifacts: [{ type: "answer", model: streamed.model || modelResult?.model || "", historyMessages: Array.isArray(prepared.combinedHistoryMessages) ? prepared.combinedHistoryMessages.length : 0, streamed: true, sessionId: activeSession?.id || null }]
    }
  };
}

export async function handleAiChatTextPlanRoute(state = {}) {
  const prepared = state.prepared || {};
  const toolRound = Number.isInteger(state.toolRound) ? state.toolRound : 0;
  const planningMessages = Array.isArray(state.planningMessages) && state.planningMessages.length
    ? state.planningMessages
    : createToolAwarePlanningMessages({
        systemPrompt: prepared.systemPrompt || "",
        effectivePrompt: prepared.toolAwarePrompt || "",
        historyMessages: Array.isArray(prepared.combinedHistoryMessages) ? prepared.combinedHistoryMessages : []
      });

  const planned = await invokeToolAwarePlanningRound({
    messages: planningMessages,
    recentMessages: Array.isArray(prepared.recentMessages) ? prepared.recentMessages : [],
    context: prepared.context,
    api: prepared.replyApi,
    modelOverride: prepared.modelOverride || "",
    defaultTextModel: prepared.defaultTextModel || "",
    round: toolRound,
    maxToolRounds: MAX_TOOL_ROUNDS
  });

  return {
    planningMessages: planned.planningMessages,
    pendingToolCalls: planned.pendingToolCalls,
    modelResult: planned.result,
    toolRound: planned.pendingToolCalls.length ? toolRound + 1 : toolRound
  };
}

export async function handleAiChatTextToolsRoute(state = {}) {
  const prepared = state.prepared || {};
  const currentRound = Number.isInteger(state.toolRound) ? Math.max(0, state.toolRound - 1) : 0;
  let nextPlanningMessages = await executePendingToolCallsRound({
    pendingToolCalls: Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : [],
    planningMessages: Array.isArray(state.planningMessages) ? state.planningMessages : [],
    recentMessages: Array.isArray(prepared.recentMessages) ? prepared.recentMessages : [],
    context: prepared.context,
    api: prepared.replyApi,
    round: currentRound
  });

  const recoveryAction = prepared.recoveryGuidance?.recoveryAction || null;
  if (recoveryAction?.mode === "text-retry-tools" && currentRound === Math.max(0, Number(recoveryAction.recoveredToolRound || 0) - 1)) {
    const continuationMessage = createRecoveryContinuationMessage(prepared.effectivePrompt || "");
    if (continuationMessage) {
      nextPlanningMessages = nextPlanningMessages.concat([continuationMessage]);
    }
  }

  return {
    planningMessages: nextPlanningMessages,
    pendingToolCalls: []
  };
}

export async function handleAiChatTextAnswerRoute(state = {}) {
  return finalizeAiChatTextRoute({
    prepared: state.prepared || {},
    planningMessages: Array.isArray(state.planningMessages) ? state.planningMessages : [],
    modelResult: state.modelResult || null
  });
}