import { parseModelDirective } from "../../plugins/ai-chat/parsers/modelDirectives.js";
import { parseAiSessionDirective } from "../../plugins/ai-chat/parsers/sessionDirectives.js";
import { findNestedBotInvocation } from "../../plugins/ai-chat/selectors/botInvocations.js";
import { isImageAttachment, stripSelfMention, wantsBatchTagging, wantsVideoAnalysis, wantsVision } from "../../plugins/ai-chat/selectors/intents.js";
import { formatAiSessionLabel, getAiSession } from "../../plugins/ai-chat/services/aiSessions.js";
import { getEffectiveMultimodalModel, getEffectiveTextModel, readAiModelSettings } from "../../plugins/ai-chat/services/modelSettings.js";
import { readAiSessionCheckpoint } from "../checkpoints/aiSessionCheckpointer.js";
import { buildSessionRecoveryGuidance } from "./recoveryNodes.js";

export async function prepareAiChatGraphState(state = {}) {
  const context = state.context;
  const api = state.api;
  api.throwIfCancelled();

  const strippedPrompt = stripSelfMention(context.trigger.rawText || "");
  const sessionDirective = parseAiSessionDirective(strippedPrompt);
  const modelDirective = parseModelDirective(sessionDirective.prompt);
  const modelSettings = await readAiModelSettings(api.appDataRoot);
  const effectivePrompt = modelDirective.prompt || (context.attachments?.some((item) => isImageAttachment(item))
    ? "请描述这张图片并给出关键信息。"
    : "请结合最近聊天上下文回答。");
  const modelOverride = String(modelDirective.modelOverride || "").trim();
  const visionRequest = wantsVision(effectivePrompt, context.attachments || []);
  const explicitSearchCommand = modelDirective.command?.type === "explicit-search" ? modelDirective.command : null;
  const explicitSearchQuery = String(explicitSearchCommand?.query || "").trim();
  if (explicitSearchCommand && !explicitSearchQuery) {
    throw new Error("请在 /search 后面提供要搜索的问题，例如：@ai /search OpenAI 最新模型");
  }

  const toolAwarePrompt = explicitSearchCommand ? explicitSearchQuery : effectivePrompt;
  const suppressReplyProgress = !visionRequest;
  const traceHooks = state.hooks || {};
  const hasImageAttachment = (context.attachments || []).some((item) => isImageAttachment(item));
  const emitReplyProgress = suppressReplyProgress
    ? async () => {}
    : async (payload) => api.emitProgress(payload);
  const replyApi = suppressReplyProgress
    ? { ...api, emitProgress: async () => {}, traceHooks }
    : { ...api, traceHooks };
  const defaultTextModel = getEffectiveTextModel(modelSettings);
  const defaultMultimodalModel = getEffectiveMultimodalModel(modelSettings);
  let activeSession = null;
  let route = "text";
  let delegatedInvocation = null;
  let catalog = [];
  let sessionRecovery = null;
  let recoveryGuidance = null;

  await api.appendLog(`ai invocation: ${effectivePrompt}`);
  if (modelOverride) {
    await api.appendLog(`ai model override: ${modelOverride}`);
  }
  await emitReplyProgress({ phase: "load-context", label: "读取聊天上下文", percent: 12 });

  if (sessionDirective.command?.type) {
    route = "command";
  }

  if (route !== "command" && sessionDirective.sessionId) {
    activeSession = await getAiSession(api.appDataRoot, sessionDirective.sessionId);
    if (!activeSession) {
      throw new Error(`AI 会话 #${sessionDirective.sessionId} 不存在，请先执行 @ai /new 会话名字`);
    }
    sessionRecovery = await readAiSessionCheckpoint(api.appDataRoot, activeSession.id);
    recoveryGuidance = buildSessionRecoveryGuidance(sessionRecovery);
    await api.appendLog(`ai session bound: ${formatAiSessionLabel(activeSession)}`);
    if (sessionRecovery?.latestExecution?.jobId) {
      await api.appendLog(`ai session checkpoint restored: job=${sessionRecovery.latestExecution.jobId} status=${sessionRecovery.latestExecution.status || "unknown"} route=${sessionRecovery.latestExecution.route || "unknown"}`);
    }
    if (recoveryGuidance?.strategy) {
      await api.appendLog(`ai session recovery strategy: ${recoveryGuidance.strategy}`);
    }
    if (!String(sessionDirective.prompt || "").trim() && !(context.attachments || []).some((item) => isImageAttachment(item))) {
      throw new Error(`请在 #${activeSession.id} 后输入消息，例如：@ai #${activeSession.id} 继续刚才的话题`);
    }
  }

  if (route !== "command" && (modelDirective.inspectOnly || (modelDirective.command && modelDirective.command.type !== "explicit-search"))) {
    route = "command";
  }

  catalog = api.listBots();
  if (route !== "command") {
    const nestedInvocation = findNestedBotInvocation(effectivePrompt, catalog);
    if (nestedInvocation) {
      route = "delegate";
      delegatedInvocation = {
        kind: "nested",
        invocation: nestedInvocation,
        options: {
          subtitle: modelOverride
            ? `模型: ${modelOverride} · 已委派给 ${nestedInvocation.target.displayName}`
            : `已委派给 ${nestedInvocation.target.displayName}`
        }
      };
    }
  }

  if (route !== "command" && route !== "delegate" && wantsVideoAnalysis(effectivePrompt)) {
    const videoAnalyzeTarget = catalog.find((item) => item.botId === "video.analyze");
    if (videoAnalyzeTarget) {
      const bilibiliMatch = effectivePrompt.match(/https?:\/\/\S+|\bBV[0-9A-Za-z]{10}\b/i);
      const source = bilibiliMatch ? bilibiliMatch[0] : "";
      route = "delegate";
      delegatedInvocation = {
        kind: "nested",
        invocation: {
          target: videoAnalyzeTarget,
          rawText: effectivePrompt,
          parsedArgs: source ? { source } : {}
        },
        options: {
          subtitle: modelOverride
            ? `模型: ${modelOverride} · 已委派给 ${videoAnalyzeTarget.displayName}`
            : `已委派给 ${videoAnalyzeTarget.displayName}`
        }
      };
    }
  }

  if (route !== "command" && route !== "delegate" && wantsBatchTagging(effectivePrompt)) {
    const videoTagTarget = catalog.find((item) => item.botId === "video.tag");
    if (videoTagTarget) {
      route = "delegate";
      delegatedInvocation = {
        kind: "nested",
        invocation: {
          target: videoTagTarget,
          rawText: effectivePrompt,
          parsedArgs: { batch: true }
        },
        options: {
          subtitle: modelOverride
            ? `模型: ${modelOverride} · 已委派给 ${videoTagTarget.displayName}`
            : `已委派给 ${videoTagTarget.displayName}`
        }
      };
    }
  }

  if (route !== "command" && route !== "delegate") {
    const recoveryAction = recoveryGuidance?.recoveryAction || null;
    if (recoveryAction?.requiresAttachment && !hasImageAttachment) {
      route = recoveryAction.route || "recovery";
    } else if (recoveryAction?.mode === "text-retry-tools" && Array.isArray(recoveryAction?.recoveredPendingToolCalls) && recoveryAction.recoveredPendingToolCalls.length) {
      route = "textTools";
    } else if (recoveryAction?.mode === "text-replan") {
      route = "text";
    } else {
      route = visionRequest ? "vision" : "text";
    }
    if (recoveryAction?.mode) {
      await api.appendLog(`ai session recovery scheduling: mode=${recoveryAction.mode} route=${route}`);
    }
  }

  return {
    route,
    planningMessages: route === "textTools"
      ? (Array.isArray(recoveryGuidance?.recoveryAction?.recoveredPlanningMessages) ? recoveryGuidance.recoveryAction.recoveredPlanningMessages : [])
      : [],
    pendingToolCalls: route === "textTools"
      ? (Array.isArray(recoveryGuidance?.recoveryAction?.recoveredPendingToolCalls) ? recoveryGuidance.recoveryAction.recoveredPendingToolCalls : [])
      : [],
    toolRound: route === "textTools"
      ? (Number.isInteger(recoveryGuidance?.recoveryAction?.recoveredToolRound) ? recoveryGuidance.recoveryAction.recoveredToolRound : 0)
      : 0,
    prepared: {
      context,
      api,
      sessionDirective,
      modelDirective,
      modelSettings,
      effectivePrompt,
      toolAwarePrompt,
      modelOverride,
      visionRequest,
      explicitSearchCommand,
      defaultTextModel,
      defaultMultimodalModel,
      suppressReplyProgress,
      emitReplyProgress,
      replyApi,
      traceHooks,
      activeSession,
      sessionRecovery,
      recoveryGuidance,
      catalog,
      delegatedInvocation,
      resumeRoute: route,
      recentMessages: [],
      combinedHistoryMessages: [],
      systemPrompt: ""
    }
  };
}