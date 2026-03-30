import { MAX_CARD_BODY_LENGTH } from "./constants.js";
import { withSessionSubtitle } from "./parsers/sessionDirectives.js";

const DIRECT_RETRY_TEXT_TOOLS = new Set(["read_chat_history"]);

function getPendingToolNames(toolCalls = []) {
  return [...new Set(
    (Array.isArray(toolCalls) ? toolCalls : [])
      .map((item) => String(item?.name || item?.function?.name || "").trim())
      .filter(Boolean)
  )];
}

function getRecoveryModeLabel(mode = "") {
  if (mode === "text-retry-tools") {
    return "直连工具重试";
  }
  if (mode === "text-replan") {
    return "重新规划文本链路";
  }
  if (mode === "vision-require-attachment") {
    return "等待重新附图";
  }
  if (mode === "answer-rebuild") {
    return "重建最终回答";
  }
  if (mode === "cancelled-replan") {
    return "取消后重规划";
  }
  if (mode === "failed-replan") {
    return "失败后重规划";
  }
  return "恢复流程";
}

export function createRecoveryReplyText(recoveryGuidance = null) {
  const recoveryAction = recoveryGuidance?.recoveryAction || {};
  const lines = [String(recoveryAction.shortCircuitReply || recoveryGuidance?.strategy || "当前会话需要额外恢复信息后才能继续。").trim()];
  if (recoveryAction.nextStep) {
    lines.push(`建议动作：${recoveryAction.nextStep}`);
  }
  if (Array.isArray(recoveryAction?.retryPolicy?.blockedRetryToolNames) && recoveryAction.retryPolicy.blockedRetryToolNames.length) {
    lines.push(`本次不直接重试的工具：${recoveryAction.retryPolicy.blockedRetryToolNames.join("、")}`);
  }
  return lines.filter(Boolean).join("\n");
}

export function createRecoveryCard(reply, recoveryGuidance = null, session = null) {
  const recoveryAction = recoveryGuidance?.recoveryAction || {};
  return {
    type: "ai-recovery",
    status: recoveryAction.requiresAttachment ? "needs-input" : "succeeded",
    title: "AI 会话恢复",
    subtitle: withSessionSubtitle(getRecoveryModeLabel(recoveryAction.mode || "resume-default"), session),
    body: String(reply || "").slice(0, MAX_CARD_BODY_LENGTH)
  };
}

export function createRecoveryArtifact(recoveryGuidance = null, session = null) {
  const recoveryAction = recoveryGuidance?.recoveryAction || {};
  return {
    type: "recovery-route",
    sessionId: session?.id || null,
    route: recoveryAction.route || "recovery",
    mode: recoveryAction.mode || "resume-default",
    lastNode: recoveryGuidance?.lastNode || "",
    nextStep: recoveryAction.nextStep || "",
    requiresAttachment: recoveryAction.requiresAttachment === true,
    directRetryAllowed: recoveryAction.directRetryAllowed === true,
    pendingTools: Array.isArray(recoveryAction?.retryPolicy?.pendingToolNames) ? recoveryAction.retryPolicy.pendingToolNames : [],
    retryableTools: Array.isArray(recoveryAction?.retryPolicy?.retryableToolNames) ? recoveryAction.retryPolicy.retryableToolNames : [],
    blockedRetryTools: Array.isArray(recoveryAction?.retryPolicy?.blockedRetryToolNames) ? recoveryAction.retryPolicy.blockedRetryToolNames : []
  };
}

export function createRecoveryContinuationMessage(prompt = "") {
  const normalized = String(prompt || "").trim();
  if (!normalized) {
    return null;
  }
  return {
    role: "user",
    content: `恢复请求补充：${normalized}`
  };
}

export function resolveTextToolsRecoveryPolicy(recoveryState = null) {
  const pendingToolCalls = Array.isArray(recoveryState?.pendingToolCalls) ? recoveryState.pendingToolCalls : [];
  const pendingToolNames = getPendingToolNames(pendingToolCalls);
  const retryableToolNames = pendingToolNames.filter((name) => DIRECT_RETRY_TEXT_TOOLS.has(name));
  const blockedRetryToolNames = pendingToolNames.filter((name) => !DIRECT_RETRY_TEXT_TOOLS.has(name));
  const hasRecoverableState = pendingToolCalls.length > 0 && Array.isArray(recoveryState?.planningMessages) && recoveryState.planningMessages.length > 0;
  return {
    hasRecoverableState,
    pendingToolNames,
    retryableToolNames,
    blockedRetryToolNames,
    directRetryAllowed: hasRecoverableState && pendingToolNames.length > 0 && blockedRetryToolNames.length === 0
  };
}