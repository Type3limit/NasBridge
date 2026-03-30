import { parseAiSessionDirective } from "../../plugins/ai-chat/parsers/sessionDirectives.js";
import { stripSelfMention } from "../../plugins/ai-chat/selectors/intents.js";
import { appendAiSessionTurn } from "../../plugins/ai-chat/services/aiSessions.js";
import { delegateBotInvocation } from "../../plugins/ai-chat/delegation.js";
import { createAiSessionCheckpointer, readAiSessionCheckpoint } from "../checkpoints/aiSessionCheckpointer.js";
import { handleAiChatCommandRoute } from "./commandNodes.js";
import { handleAiChatPrepareContextRoute } from "./prepareContextNodes.js";
import { prepareAiChatGraphState } from "./prepareInputNodes.js";
import { handleAiChatRecoveryRoute } from "./recoveryNodes.js";
import { handleAiChatTextAnswerRoute, handleAiChatTextPlanRoute, handleAiChatTextToolsRoute } from "./textNodes.js";
import { handleAiChatVisionAnswerRoute, handleAiChatVisionBuildRoute, handleAiChatVisionCollectRoute } from "./visionNodes.js";

async function handleAiChatDelegateResolveRoute(state = {}) {
  const prepared = state.prepared || {};
  const api = prepared.api;
  const delegatedInvocation = prepared.delegatedInvocation || null;

  api.throwIfCancelled();
  if (!delegatedInvocation?.invocation) {
    throw new Error("AI chat graph reached delegate route without a delegation target");
  }

  await api.appendLog(`delegate target resolved: ${delegatedInvocation.invocation.target?.botId || delegatedInvocation.invocation.target?.id || delegatedInvocation.invocation.target?.displayName || "unknown"}`);
  return {
    prepared: {
      ...prepared,
      delegatedInvocation
    }
  };
}

async function handleAiChatDelegateExecuteRoute(state = {}) {
  const prepared = state.prepared || {};
  const api = prepared.api;
  const context = prepared.context;
  const effectivePrompt = prepared.effectivePrompt || "";
  let activeSession = prepared.activeSession || null;
  const delegatedInvocation = prepared.delegatedInvocation || null;

  api.throwIfCancelled();
  if (!delegatedInvocation?.invocation) {
    throw new Error("AI chat graph reached delegate execute route without a delegation target");
  }

  const delegated = await delegateBotInvocation(api, context, delegatedInvocation.invocation, activeSession, delegatedInvocation.options || {});
  if (delegatedInvocation.kind === "natural-music" && activeSession) {
    activeSession = await appendAiSessionTurn(api.appDataRoot, activeSession, effectivePrompt, delegated.reply);
  }
  return {
    result: {
      chatReply: delegated.chatReply,
      importedFiles: [],
      artifacts: delegated.artifacts
    }
  };
}

export function createAiChatGraphHandlers() {
  return {
    handlePrepareInput: prepareAiChatGraphState,
    handlePrepareContext: handleAiChatPrepareContextRoute,
    handleRecovery: handleAiChatRecoveryRoute,
    handleCommand: handleAiChatCommandRoute,
    handleDelegateResolve: handleAiChatDelegateResolveRoute,
    handleDelegateExecute: handleAiChatDelegateExecuteRoute,
    handleVisionCollect: handleAiChatVisionCollectRoute,
    handleVisionBuild: handleAiChatVisionBuildRoute,
    handleVisionAnswer: handleAiChatVisionAnswerRoute,
    handleTextPlan: handleAiChatTextPlanRoute,
    handleTextTools: handleAiChatTextToolsRoute,
    handleTextAnswer: handleAiChatTextAnswerRoute
  };
}

export function createAiChatGraphExecution({ context, api }) {
  const sessionDirective = parseAiSessionDirective(stripSelfMention(context.trigger.rawText || ""));
  const hooks = createAiSessionCheckpointer({
    appDataRoot: api.appDataRoot,
    jobId: context.jobId,
    botId: "ai.chat",
    chat: context.chat,
    sessionId: sessionDirective.sessionId
  });
  return {
    context,
    api,
    handlers: createAiChatGraphHandlers(),
    hooks
  };
}