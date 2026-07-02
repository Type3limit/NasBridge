import { createRecoveryArtifact, createRecoveryCard, createRecoveryReplyText, resolveTextToolsRecoveryPolicy } from "../../plugins/ai-chat/recovery.js";
import { appendAiSessionTurn } from "../../plugins/ai-chat/services/aiSessions.js";

export function isConfirmationPrompt(prompt = "") {
  const normalized = String(prompt || "").normalize("NFKC").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return /^(确认|同意|可以|继续|执行|开始|确定|yes|ok|okay|confirm|go ahead|proceed)([，。,.!！\s]*(执行|继续|开始|吧|即可|这个|以上|操作|任务)*)?$/.test(normalized);
}

export function buildConfirmedToolRecoveryState(pendingConfirmation = null, prompt = "") {
  const toolName = String(pendingConfirmation?.tool || "").trim();
  const input = pendingConfirmation?.confirmInput && typeof pendingConfirmation.confirmInput === "object"
    ? pendingConfirmation.confirmInput
    : null;
  if (!toolName || !input) {
    return null;
  }
  const toolCallId = `confirmed_${toolName.replace(/[^a-z0-9_:-]/gi, "_")}_${Date.now().toString(36)}`;
  const pendingToolCall = {
    id: toolCallId,
    name: toolName,
    input,
    reason: "用户已确认上一轮需要确认的操作"
  };
  return {
    mode: "confirmed-tool-call",
    route: "textTools",
    directRetryAllowed: true,
    nextStep: `用户已确认，继续执行工具：${toolName}`,
    recoveredToolRound: 0,
    recoveredPendingToolCalls: [pendingToolCall],
    recoveredPlanningMessages: [
      {
        role: "system",
        content: "你正在继续一个已由用户确认的 NAS agent 操作。先执行待确认工具；工具返回后，用简体中文简要说明执行结果、jobId/状态或失败原因。"
      },
      {
        role: "user",
        content: [
          "用户已确认上一轮操作。",
          prompt ? `本轮确认文本：${String(prompt || "").trim()}` : "",
          pendingConfirmation?.confirmation?.reason ? `确认事项：${pendingConfirmation.confirmation.reason}` : ""
        ].filter(Boolean).join("\n")
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: toolCallId,
            type: "function",
            function: {
              name: toolName,
              arguments: JSON.stringify(input)
            }
          }
        ]
      }
    ]
  };
}

export function buildSessionRecoveryGuidance(sessionRecovery = null) {
  const latestExecution = sessionRecovery?.latestExecution || null;
  const latestSnapshot = sessionRecovery?.latestSnapshot || null;
  if (!latestExecution?.jobId) {
    return null;
  }

  const status = String(latestExecution.status || latestSnapshot?.status || "unknown").trim() || "unknown";
  const route = String(latestExecution.route || latestSnapshot?.route || "unknown").trim() || "unknown";
  const lastNode = String(latestExecution.lastNode || latestSnapshot?.traceSummary?.lastNode || "").trim();
  const replyPreview = String(latestExecution.replyPreview || latestSnapshot?.result?.reply?.textPreview || "").trim();
  const recoveryState = latestSnapshot?.recoveryState || null;
  const pendingConfirmation = latestSnapshot?.pendingConfirmation || sessionRecovery?.pendingConfirmation || null;
  const summary = `该会话最近一次 LangGraph 执行：job=${latestExecution.jobId}，状态=${status}，路由=${route}，最后节点=${lastNode || "未知"}，上一条回复摘要：${replyPreview || "无"}。`;
  const recoveryAction = {
    mode: "resume-default",
    route: route === "vision" ? "vision" : "text",
    shortCircuitReply: "",
    requiresAttachment: false,
    nextStep: "延续当前会话并重新组织上下文。",
    directRetryAllowed: false,
    retryPolicy: {
      pendingToolNames: [],
      retryableToolNames: [],
      blockedRetryToolNames: []
    },
    recoveredPlanningMessages: [],
    recoveredPendingToolCalls: [],
    recoveredToolRound: 0,
    pendingConfirmation
  };

  let strategy = "延续这个会话时，应把上一次执行结果当作恢复线索，而不是盲目重复整个流程。";
  if (lastNode === "textTools") {
    const retryPolicy = resolveTextToolsRecoveryPolicy(recoveryState);
    recoveryAction.retryPolicy = retryPolicy;
    recoveryAction.directRetryAllowed = retryPolicy.directRetryAllowed;
    if (retryPolicy.directRetryAllowed) {
      strategy = status === "cancelled"
        ? `上次中断在 textTools，且待执行工具仅包含 ${retryPolicy.retryableToolNames.join("、")}。这类工具是可安全重试的本地上下文读取，可先直接补跑工具结果，再衔接新的恢复请求。`
        : `上次失败在 textTools，且待执行工具仅包含 ${retryPolicy.retryableToolNames.join("、")}。这类工具不会产生外部副作用，可直接重试并在拿到结果后继续回答。`;
      recoveryAction.mode = "text-retry-tools";
      recoveryAction.route = "textTools";
      recoveryAction.nextStep = `直接重试未完成的工具调用：${retryPolicy.retryableToolNames.join("、")}`;
      recoveryAction.recoveredPlanningMessages = Array.isArray(recoveryState?.planningMessages) ? recoveryState.planningMessages : [];
      recoveryAction.recoveredPendingToolCalls = Array.isArray(recoveryState?.pendingToolCalls) ? recoveryState.pendingToolCalls : [];
      recoveryAction.recoveredToolRound = Number.isInteger(recoveryState?.toolRound) ? recoveryState.toolRound : 0;
    } else {
      strategy = status === "cancelled"
        ? "上次中断在 textTools。若用户是在继续同一问题，先简短说明上次停在工具执行阶段；只有在用户确认继续、且外部资料仍然需要刷新时才重新调用工具。"
        : "上次失败在 textTools。优先根据已有聊天上下文和已知工具目标缩小问题范围；除非当前问题明确要求刷新外部资料，否则不要立刻重复同一批工具调用。";
      recoveryAction.mode = "text-replan";
      recoveryAction.route = "text";
      recoveryAction.nextStep = retryPolicy.blockedRetryToolNames.length
        ? `重新规划，并避免直接重试这些工具：${retryPolicy.blockedRetryToolNames.join("、")}`
        : "重新规划文本链路。";
    }
  } else if (lastNode === "visionBuild") {
    strategy = status === "cancelled"
      ? "上次中断在 visionBuild。若用户继续同一张图的问题，先确认当前会话里是否还有可用图片；如果没有，应提示用户重新上传，而不是假设旧附件仍可读取。"
      : "上次失败在 visionBuild。优先检查图片附件是否仍然可访问、格式是否支持；若图片上下文已经缺失，应要求用户重新附图再继续。";
    recoveryAction.mode = "vision-require-attachment";
    recoveryAction.route = "recovery";
    recoveryAction.requiresAttachment = true;
    recoveryAction.nextStep = "请用户重新上传图片后再继续。";
    recoveryAction.shortCircuitReply = "上一次会话在图片输入构造阶段中断。当前没有可继续使用的图片，请重新上传图片后再让我继续分析。";
  } else if (lastNode === "textAnswer" || lastNode === "visionAnswer") {
    strategy = status === "cancelled"
      ? "上次在最终回答阶段被取消。继续时不要直接续写被截断的句子，应先给出一行恢复说明，再重新组织完整答案。"
      : "上次在最终回答阶段失败。继续时优先复用前面已经准备好的上下文，避免重复跑整条链路。";
    recoveryAction.mode = "answer-rebuild";
    recoveryAction.route = route === "vision" ? "vision" : "text";
    recoveryAction.nextStep = "复用已有上下文并重建完整回答。";
  } else if (status === "cancelled") {
    strategy = "上次执行被用户取消。继续时应先确认是否延续之前任务，再决定是否重跑工具、看图或委派。";
    recoveryAction.mode = "cancelled-replan";
    recoveryAction.nextStep = "按当前请求重新规划。";
  } else if (status === "failed") {
    strategy = "上次执行失败。继续时应参考上一次的路由和最后节点，避免不加区分地重复整个流程。";
    recoveryAction.mode = "failed-replan";
    recoveryAction.nextStep = "结合失败节点重新规划。";
  }

  if (pendingConfirmation?.tool && pendingConfirmation?.confirmation) {
    const confirmation = pendingConfirmation.confirmation;
    const impact = confirmation.impact || {};
    strategy = [
      `上次执行已停在需要用户确认的工具：${pendingConfirmation.tool}。`,
      `风险级别=${confirmation.riskLevel || "unknown"}，影响文件数=${impact.targetFileCount ?? "未知"}。`,
      "如果用户本轮明确确认，应继续执行同一个工具并合并 confirmation.confirmWith 参数；如果用户没有明确确认，先复述影响范围并等待确认。"
    ].join("");
    recoveryAction.mode = "awaiting-confirmation";
    recoveryAction.route = "text";
    recoveryAction.nextStep = `等待用户确认后继续执行 ${pendingConfirmation.tool}`;
  }

  return {
    status,
    route,
    lastNode,
    summary,
    strategy,
    recoveryAction
  };
}

export async function handleAiChatRecoveryRoute(state = {}) {
  const prepared = state.prepared || {};
  const api = prepared.api;
  const effectivePrompt = prepared.effectivePrompt || "";
  const activeSession = prepared.activeSession || null;
  const recoveryGuidance = prepared.recoveryGuidance || null;
  const reply = createRecoveryReplyText(recoveryGuidance);

  if (activeSession) {
    await appendAiSessionTurn(api.appDataRoot, activeSession, effectivePrompt, reply);
  }

  return {
    result: {
      chatReply: await api.publishChatReply({
        text: reply,
        card: createRecoveryCard(reply, recoveryGuidance, activeSession)
      }),
      importedFiles: [],
      artifacts: [createRecoveryArtifact(recoveryGuidance, activeSession)]
    }
  };
}
