import { END, START, StateGraph } from "@langchain/langgraph";
import { AiChatGraphState } from "./state.js";

const ROUTE_NAMES = new Set(["command", "delegate", "vision", "text", "textTools", "recovery"]);
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
      const update = await handler(state);
      const nextTrace = (Array.isArray(state?.trace) ? state.trace : []).concat(createTraceEntry({ ...state, ...(update && typeof update === "object" ? update : {}) }, nodeName));
      await api?.appendLog?.(`langgraph node exit: ${nodeName}`);
      await hooks?.recordNodeEvent?.({
        node: nodeName,
        event: "exit",
        route: update?.route ?? state?.route,
        status: "completed"
      });
      await hooks?.captureState?.({
        route: update?.route ?? state?.route,
        prepared: update?.prepared ?? state?.prepared,
        trace: nextTrace,
        planningMessages: Array.isArray(update?.planningMessages) ? update.planningMessages : Array.isArray(state?.planningMessages) ? state.planningMessages : [],
        pendingToolCalls: Array.isArray(update?.pendingToolCalls) ? update.pendingToolCalls : Array.isArray(state?.pendingToolCalls) ? state.pendingToolCalls : [],
        modelResult: update?.modelResult ?? state?.modelResult ?? null,
        toolRound: Number.isInteger(update?.toolRound) ? update.toolRound : Number.isInteger(state?.toolRound) ? state.toolRound : 0
      });
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