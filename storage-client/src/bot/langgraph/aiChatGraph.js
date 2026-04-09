import { END, START, StateGraph } from "@langchain/langgraph";
import { AiChatGraphState } from "./state.js";

const ROUTE_NAMES = new Set(["command", "delegate", "vision", "text", "textTools", "recovery"]);

const ROUTE_LABELS = {
  text: "文本回复",
  textTools: "工具调用",
  vision: "视觉分析",
  delegate: "委派 Bot",
  command: "命令处理",
  recovery: "会话恢复"
};

function buildNodeExitDetails(nodeName, state, update) {
  const prepared = (update?.prepared && typeof update.prepared === "object" ? update.prepared : null)
    || (state?.prepared && typeof state.prepared === "object" ? state.prepared : {});
  const details = { type: "ai-chat-graph" };
  const route = (update?.route ?? state?.route) || "text";
  const routeLabel = ROUTE_LABELS[route];
  if (routeLabel) details.route = `${routeLabel} (${route})`;

  switch (nodeName) {
    case "prepareInput": {
      const prompt = prepared.effectivePrompt || "";
      if (prompt) details.intent = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
      if (prepared.modelOverride) details.model = prepared.modelOverride;
      const delegated = prepared.delegatedInvocation?.invocation?.target;
      if (delegated) details.delegated = delegated.displayName || delegated.botId || "未知";
      const session = prepared.activeSession;
      if (session) details.session = session.name || `#${session.id}`;
      break;
    }
    case "prepareContext": {
      const historyCount = Array.isArray(prepared.combinedHistoryMessages)
        ? prepared.combinedHistoryMessages.length : 0;
      details.historyCount = historyCount;
      const systemPromptLen = typeof prepared.systemPrompt === "string"
        ? prepared.systemPrompt.length : 0;
      details.systemPromptLen = systemPromptLen;
      const intent = prepared.effectivePrompt || "";
      if (intent) details.intent = intent.length > 80 ? `${intent.slice(0, 80)}…` : intent;
      break;
    }
    case "textPlan": {
      const pendingToolCalls = Array.isArray(update?.pendingToolCalls) ? update.pendingToolCalls
        : Array.isArray(state?.pendingToolCalls) ? state.pendingToolCalls : [];
      const modelResult = update?.modelResult || state?.modelResult;
      if (modelResult?.model) details.model = modelResult.model;
      if (pendingToolCalls.length) {
        details.tools = pendingToolCalls.map((tc) => tc.name || tc.type || "tool");
        details.toolRound = Number.isInteger(update?.toolRound) ? update.toolRound
          : Number.isInteger(state?.toolRound) ? state.toolRound : 1;
      } else {
        details.directReply = true;
      }
      const intent2 = prepared.effectivePrompt || "";
      if (intent2 && !details.intent) details.intent = intent2.length > 80 ? `${intent2.slice(0, 80)}…` : intent2;
      break;
    }
    case "textTools": {
      const prevPending = Array.isArray(state?.pendingToolCalls) ? state.pendingToolCalls : [];
      if (prevPending.length) {
        details.executedTools = prevPending.map((tc) => tc.name || tc.type || "tool");
      }
      break;
    }
    case "textAnswer": {
      details.directReply = true;
      const intent3 = prepared.effectivePrompt || "";
      if (intent3) details.intent = intent3.length > 80 ? `${intent3.slice(0, 80)}…` : intent3;
      break;
    }
    case "delegateResolve": {
      const invocation = ((update?.prepared || prepared)?.delegatedInvocation?.invocation);
      const target = invocation?.target;
      if (target) details.delegated = target.displayName || target.botId || "未知";
      const intent4 = prepared.effectivePrompt || "";
      if (intent4) details.intent = intent4.length > 80 ? `${intent4.slice(0, 80)}…` : intent4;
      break;
    }
    case "delegateExecute": {
      const invocation2 = prepared?.delegatedInvocation?.invocation;
      const target2 = invocation2?.target;
      if (target2) details.delegated = target2.displayName || target2.botId || "未知";
      details.intent = `已委派至 ${details.delegated || "Bot"}`;
      break;
    }
    case "visionCollect":
    case "visionBuild":
      details.intent = "收集与处理视觉输入";
      break;
    case "visionAnswer":
      details.intent = "视觉内容分析与回复";
      break;
    default:
      break;
  }
  return details;
}

// 这些节点内部会调用 publishChatReply 作为最终动作，
// 节点退出后不应再发 bot-status graphState 更新，否则会覆盖已发出的 ai-answer 卡片
const ANSWER_NODE_NAMES = new Set(["textAnswer", "visionAnswer", "recovery", "command", "delegateExecute"]);

const TEXT_CONTINUATION_NAMES = new Set(["textTools", "textAnswer"]);

function createTraceEntry(state, node, status = "completed") {
  return [{
    jobId: String(state?.context?.jobId || "").trim(),
    sessionId: state?.prepared?.activeSession?.id ?? null,
    route: String(state?.route || "").trim(),
    node,
    status,
    at: new Date().toISOString()
  }];
}

function resolveRoute(state) {
  const route = String(state?.route || "text").trim();
  return ROUTE_NAMES.has(route) ? route : "text";
}

function resolveTextContinuation(state) {
  const next = Array.isArray(state?.pendingToolCalls) && state.pendingToolCalls.length ? "textTools" : "textAnswer";
  return TEXT_CONTINUATION_NAMES.has(next) ? next : "textAnswer";
}

function createTrackedNode(nodeName, handlerName) {
  return async (state) => {
    const api = state?.api;
    const hooks = state?.hooks;
    const handler = state?.handlers?.[handlerName];
    if (typeof handler !== "function") {
      throw new Error(`AI chat graph handler is missing: ${handlerName}`);
    }
    await api?.appendLog?.(`langgraph node enter: ${nodeName}`);
    await hooks?.captureState?.({
      route: state?.route,
      prepared: state?.prepared,
      trace: Array.isArray(state?.trace) ? state.trace : [],
      planningMessages: Array.isArray(state?.planningMessages) ? state.planningMessages : [],
      pendingToolCalls: Array.isArray(state?.pendingToolCalls) ? state.pendingToolCalls : [],
      modelResult: state?.modelResult ?? null,
      toolRound: Number.isInteger(state?.toolRound) ? state.toolRound : 0
    });
    await hooks?.recordNodeEvent?.({
      node: nodeName,
      event: "enter",
      route: state?.route,
      status: "running"
    });
    try {
      await api?.emitProgress?.({
        phase: String(state?.phase || "running"),
        label: String(state?.progress?.label || nodeName),
        percent: Number.isFinite(state?.progress?.percent) ? state.progress.percent : undefined,
        graphState: {
          activeNode: nodeName,
          route: String(state?.route || "text").trim(),
          nodeHistory: Array.isArray(state?.trace) ? state.trace : [],
          toolRound: Number.isInteger(state?.toolRound) ? state.toolRound : 0
        }
      });
    } catch {
      // emitProgress 失败不中断节点执行
    }
    try {
      const update = await handler(state);
      const nextRoute = update?.route ?? state?.route;
      const nextTrace = (Array.isArray(state?.trace) ? state.trace : []).concat(createTraceEntry({ ...state, ...(update && typeof update === "object" ? update : {}) }, nodeName));
      await api?.appendLog?.(`langgraph node exit: ${nodeName}`);
      await hooks?.recordNodeEvent?.({
        node: nodeName,
        event: "exit",
        route: nextRoute,
        status: "completed"
      });
      await hooks?.captureState?.({
        route: nextRoute,
        prepared: update?.prepared ?? state?.prepared,
        trace: nextTrace,
        planningMessages: Array.isArray(update?.planningMessages) ? update.planningMessages : Array.isArray(state?.planningMessages) ? state.planningMessages : [],
        pendingToolCalls: Array.isArray(update?.pendingToolCalls) ? update.pendingToolCalls : Array.isArray(state?.pendingToolCalls) ? state.pendingToolCalls : [],
        modelResult: update?.modelResult ?? state?.modelResult ?? null,
        toolRound: Number.isInteger(update?.toolRound) ? update.toolRound : Number.isInteger(state?.toolRound) ? state.toolRound : 0
      });
      // Emit exit-time progress with richer node-specific details so the card can display them.
      // Skip for answer nodes: they already called publishChatReply, and a subsequent bot-status
      // graphState update to the same messageId would overwrite the ai-answer card with the star map.
      if (!ANSWER_NODE_NAMES.has(nodeName)) {
        try {
          await api?.emitProgress?.({
            phase: nodeName,
            label: String(state?.progress?.label || nodeName),
            percent: Number.isFinite(state?.progress?.percent) ? state.progress.percent : undefined,
            graphState: {
              activeNode: nodeName,
              route: String(nextRoute || "text").trim(),
              nodeHistory: nextTrace,
              toolRound: Number.isInteger(update?.toolRound) ? update.toolRound : Number.isInteger(state?.toolRound) ? state.toolRound : 0
            },
            details: buildNodeExitDetails(nodeName, state, update)
          });
        } catch {
          // non-critical
        }
      }
      return {
        ...(update && typeof update === "object" ? update : {}),
        trace: createTraceEntry({ ...state, ...(update && typeof update === "object" ? update : {}) }, nodeName)
      };
    } catch (error) {
      const cancelled = error?.name === "AbortError" || /job cancelled/i.test(String(error?.message || ""));
      const failedTrace = (Array.isArray(state?.trace) ? state.trace : []).concat(createTraceEntry(state, nodeName, cancelled ? "cancelled" : "failed"));
      await api?.appendLog?.(`langgraph node failed: ${nodeName}: ${String(error?.message || error || "unknown error").trim()}`);
      await hooks?.recordNodeEvent?.({
        node: nodeName,
        event: "failed",
        route: state?.route,
        detail: String(error?.message || error || "unknown error").trim(),
        status: cancelled ? "cancelled" : "failed"
      });
      await hooks?.captureState?.({
        route: state?.route,
        prepared: state?.prepared,
        trace: failedTrace,
        planningMessages: Array.isArray(state?.planningMessages) ? state.planningMessages : [],
        pendingToolCalls: Array.isArray(state?.pendingToolCalls) ? state.pendingToolCalls : [],
        modelResult: state?.modelResult ?? null,
        toolRound: Number.isInteger(state?.toolRound) ? state.toolRound : 0
      });
      throw error;
    }
  };
}

const compiledAiChatGraph = new StateGraph(AiChatGraphState)
  .addNode("prepareInput", createTrackedNode("prepareInput", "handlePrepareInput"))
  .addNode("prepareContext", createTrackedNode("prepareContext", "handlePrepareContext"))
  .addNode("recovery", createTrackedNode("recovery", "handleRecovery"))
  .addNode("command", createTrackedNode("command", "handleCommand"))
  .addNode("delegateResolve", createTrackedNode("delegateResolve", "handleDelegateResolve"))
  .addNode("delegateExecute", createTrackedNode("delegateExecute", "handleDelegateExecute"))
  .addNode("visionCollect", createTrackedNode("visionCollect", "handleVisionCollect"))
  .addNode("visionBuild", createTrackedNode("visionBuild", "handleVisionBuild"))
  .addNode("visionAnswer", createTrackedNode("visionAnswer", "handleVisionAnswer"))
  .addNode("textPlan", createTrackedNode("textPlan", "handleTextPlan"))
  .addNode("textTools", createTrackedNode("textTools", "handleTextTools"))
  .addNode("textAnswer", createTrackedNode("textAnswer", "handleTextAnswer"))
  .addEdge(START, "prepareInput")
  .addConditionalEdges("prepareInput", resolveRoute, {
    command: "command",
    delegate: "delegateResolve",
    recovery: "recovery",
    vision: "prepareContext",
    text: "prepareContext",
    textTools: "prepareContext"
  })
  .addConditionalEdges("prepareContext", resolveRoute, {
    vision: "visionCollect",
    text: "textPlan",
    textTools: "textTools"
  })
  .addConditionalEdges("textPlan", resolveTextContinuation, {
    textTools: "textTools",
    textAnswer: "textAnswer"
  })
  .addEdge("delegateResolve", "delegateExecute")
  .addEdge("visionCollect", "visionBuild")
  .addEdge("visionBuild", "visionAnswer")
  .addEdge("textTools", "textPlan")
  .addEdge("command", END)
  .addEdge("recovery", END)
  .addEdge("delegateExecute", END)
  .addEdge("visionAnswer", END)
  .addEdge("textAnswer", END)
  .compile();

export async function runAiChatGraph({ context, api, handlers, hooks = {} }) {
  const runtimeState = {
    route: "text",
    prepared: {},
    trace: [],
    planningMessages: [],
    pendingToolCalls: [],
    modelResult: null,
    toolRound: 0
  };
  const graphHooks = {
    ...hooks,
    captureState(update = {}) {
      runtimeState.route = String(update?.route || runtimeState.route || "text").trim() || "text";
      runtimeState.prepared = update?.prepared && typeof update.prepared === "object" ? update.prepared : runtimeState.prepared;
      runtimeState.trace = Array.isArray(update?.trace) ? update.trace : runtimeState.trace;
      runtimeState.planningMessages = Array.isArray(update?.planningMessages) ? update.planningMessages : runtimeState.planningMessages;
      runtimeState.pendingToolCalls = Array.isArray(update?.pendingToolCalls) ? update.pendingToolCalls : runtimeState.pendingToolCalls;
      runtimeState.modelResult = update?.modelResult ?? runtimeState.modelResult;
      runtimeState.toolRound = Number.isInteger(update?.toolRound) ? update.toolRound : runtimeState.toolRound;
    }
  };
  const initialState = {
    context,
    api,
    handlers,
    hooks: graphHooks,
    route: "text",
    prepared: {},
    visionAttachments: [],
    visionInputs: [],
    visionPrompt: "",
    planningMessages: [],
    pendingToolCalls: [],
    modelResult: null,
    toolRound: 0,
    result: null,
    trace: []
  };

  graphHooks.captureState(initialState);

  await graphHooks?.recordNodeEvent?.({
    node: "graph",
    event: "start",
    route: "text",
    status: "running"
  });

  try {
    const output = await compiledAiChatGraph.invoke(initialState);
    if (!output?.result) {
      throw new Error("AI chat graph completed without a result");
    }
    graphHooks.captureState(output);
    await graphHooks?.recordNodeEvent?.({
      node: "graph",
      event: "finish",
      route: output?.route,
      status: "succeeded"
    });
    await graphHooks?.saveExecution?.({
      status: "succeeded",
      route: output?.route,
      trace: output?.trace,
      result: output?.result,
      recoveryState: {
        planningMessages: output?.planningMessages,
        pendingToolCalls: output?.pendingToolCalls,
        modelResult: output?.modelResult,
        toolRound: output?.toolRound
      }
    });
    return output.result;
  } catch (error) {
    const cancelled = error?.name === "AbortError" || /job cancelled/i.test(String(error?.message || ""));
    await graphHooks?.recordNodeEvent?.({
      node: "graph",
      event: "finish",
      route: runtimeState.route,
      detail: String(error?.message || error || "unknown error").trim(),
      status: cancelled ? "cancelled" : "failed"
    });
    await graphHooks?.saveExecution?.({
      status: cancelled ? "cancelled" : "failed",
      route: runtimeState.route,
      trace: runtimeState.trace,
      result: null,
      error,
      recoveryState: {
        planningMessages: runtimeState.planningMessages,
        pendingToolCalls: runtimeState.pendingToolCalls,
        modelResult: runtimeState.modelResult,
        toolRound: runtimeState.toolRound
      }
    });
    throw error;
  }
}