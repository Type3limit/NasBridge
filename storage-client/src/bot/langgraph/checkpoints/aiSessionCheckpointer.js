import fs from "node:fs";
import path from "node:path";

const AI_CHAT_GRAPH_DIR = "ai-chat-graph";

function normalizeSessionId(sessionId) {
  const value = Number.parseInt(String(sessionId || 0), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function getAiChatGraphRoot(appDataRoot = "") {
  return path.join(String(appDataRoot || ""), AI_CHAT_GRAPH_DIR);
}

function getExecutionTracePath(appDataRoot = "", jobId = "") {
  return path.join(getAiChatGraphRoot(appDataRoot), "traces", `${String(jobId || "unknown")}.jsonl`);
}

function getExecutionSnapshotPath(appDataRoot = "", jobId = "") {
  return path.join(getAiChatGraphRoot(appDataRoot), "executions", `${String(jobId || "unknown")}.json`);
}

function getSessionCheckpointPath(appDataRoot = "", sessionId = 0) {
  return path.join(getAiChatGraphRoot(appDataRoot), "sessions", `${Number(sessionId) || 0}.json`);
}

async function readJsonFile(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return String(content).slice(0, 4000);
  }
  if (!Array.isArray(content)) {
    return null;
  }
  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      if (item.type === "text") {
        return {
          type: "text",
          text: String(item.text || "").slice(0, 1200)
        };
      }
      if (item.type === "image_url") {
        return {
          type: "image_url",
          image_url: {
            url: String(item.image_url?.url || "").slice(0, 512)
          }
        };
      }
      return {
        type: String(item.type || "unknown").trim() || "unknown"
      };
    })
    .filter(Boolean);
}

function normalizeToolCallDefinition(item = {}) {
  const functionName = String(item?.function?.name || item?.name || "").trim();
  const functionArguments = item?.function?.arguments;
  return {
    id: String(item?.id || "").trim(),
    type: String(item?.type || "function").trim() || "function",
    function: {
      name: functionName,
      arguments: typeof functionArguments === "string"
        ? functionArguments.slice(0, 4000)
        : JSON.stringify(functionArguments && typeof functionArguments === "object" ? functionArguments : {})
    }
  };
}

function normalizePlanningMessage(message = {}) {
  return {
    role: String(message?.role || "").trim(),
    content: normalizeMessageContent(message?.content),
    name: String(message?.name || "").trim(),
    tool_call_id: String(message?.tool_call_id || "").trim(),
    tool_calls: Array.isArray(message?.tool_calls)
      ? message.tool_calls.map((item) => normalizeToolCallDefinition(item)).filter((item) => item.function.name)
      : []
  };
}

function normalizePendingToolCall(item = {}) {
  return {
    id: String(item?.id || "").trim(),
    name: String(item?.name || item?.function?.name || "").trim(),
    input: item?.input && typeof item.input === "object" ? item.input : {}
  };
}

function summarizeRecoveryState(recoveryState = null) {
  const planningMessages = Array.isArray(recoveryState?.planningMessages)
    ? recoveryState.planningMessages.map((item) => normalizePlanningMessage(item)).filter((item) => item.role)
    : [];
  const pendingToolCalls = Array.isArray(recoveryState?.pendingToolCalls)
    ? recoveryState.pendingToolCalls.map((item) => normalizePendingToolCall(item)).filter((item) => item.name)
    : [];
  return {
    toolRound: Number.isInteger(recoveryState?.toolRound) ? recoveryState.toolRound : 0,
    pendingToolNames: [...new Set(pendingToolCalls.map((item) => item.name).filter(Boolean))],
    planningMessages,
    pendingToolCalls,
    modelResult: recoveryState?.modelResult && typeof recoveryState.modelResult === "object"
      ? {
          model: String(recoveryState.modelResult.model || "").trim(),
          finishReason: String(recoveryState.modelResult.finishReason || "").trim()
        }
      : null
  };
}

function normalizeArtifact(item = {}) {
  return {
    type: String(item?.type || "").trim(),
    refs: {
      sessionId: item?.sessionId ?? null,
      jobId: String(item?.jobId || "").trim(),
      botId: String(item?.botId || "").trim(),
      model: String(item?.model || "").trim()
    },
    metrics: {
      count: Number.isFinite(item?.count) ? Number(item.count) : null,
      imageCount: Number.isFinite(item?.imageCount) ? Number(item.imageCount) : null,
      historyMessages: Number.isFinite(item?.historyMessages) ? Number(item.historyMessages) : null
    },
    flags: {
      streamed: item?.streamed === true,
      requiresAttachment: item?.requiresAttachment === true,
      directRetryAllowed: item?.directRetryAllowed === true
    },
    detail: {
      name: String(item?.name || "").trim(),
      filter: String(item?.filter || "").trim(),
      textModel: String(item?.textModel || "").trim(),
      multimodalModel: String(item?.multimodalModel || "").trim(),
      route: String(item?.route || "").trim(),
      mode: String(item?.mode || "").trim(),
      lastNode: String(item?.lastNode || "").trim(),
      nextStep: String(item?.nextStep || "").trim(),
      pendingTools: Array.isArray(item?.pendingTools) ? item.pendingTools.map((value) => String(value || "").trim()).filter(Boolean) : [],
      retryableTools: Array.isArray(item?.retryableTools) ? item.retryableTools.map((value) => String(value || "").trim()).filter(Boolean) : [],
      blockedRetryTools: Array.isArray(item?.blockedRetryTools) ? item.blockedRetryTools.map((value) => String(value || "").trim()).filter(Boolean) : []
    }
  };
}

function summarizeArtifacts(result = null) {
  const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
  return artifacts.map((item) => normalizeArtifact(item));
}

function buildArtifactSummary(artifacts = []) {
  const types = [];
  const countsByType = {};
  const delegatedJobIds = [];
  const sessionIds = [];
  const models = [];

  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    if (artifact.type) {
      types.push(artifact.type);
      countsByType[artifact.type] = (countsByType[artifact.type] || 0) + 1;
    }
    if (artifact.refs?.jobId) {
      delegatedJobIds.push(artifact.refs.jobId);
    }
    if (artifact.refs?.sessionId != null) {
      sessionIds.push(artifact.refs.sessionId);
    }
    if (artifact.refs?.model) {
      models.push(artifact.refs.model);
    }
  }

  return {
    types: [...new Set(types)],
    countsByType,
    delegatedJobIds: [...new Set(delegatedJobIds)],
    sessionIds: [...new Set(sessionIds)],
    models: [...new Set(models)]
  };
}

function summarizeResult(result = null) {
  const artifacts = summarizeArtifacts(result);
  const chatReply = result?.chatReply && typeof result.chatReply === "object"
    ? {
        id: String(result.chatReply.id || "").trim(),
        messageId: String(result.chatReply.messageId || "").trim(),
        historyPath: String(result.chatReply.historyPath || "").trim(),
        textPreview: String(result.chatReply.text || "").slice(0, 240),
        cardType: String(result.chatReply.card?.type || "").trim(),
        cardStatus: String(result.chatReply.card?.status || "").trim()
      }
    : null;

  return {
    reply: chatReply,
    importedFiles: {
      count: Array.isArray(result?.importedFiles) ? result.importedFiles.length : 0,
      items: Array.isArray(result?.importedFiles) ? result.importedFiles : []
    },
    artifactSummary: buildArtifactSummary(artifacts),
    artifacts
  };
}

function buildTraceSummary(trace = []) {
  const items = Array.isArray(trace) ? trace : [];
  const last = items.length ? items[items.length - 1] : null;
  return {
    count: items.length,
    nodes: [...new Set(items.map((item) => String(item?.node || "").trim()).filter(Boolean))],
    lastNode: String(last?.node || "").trim(),
    lastStatus: String(last?.status || "").trim(),
    lastAt: String(last?.at || "").trim()
  };
}

export async function readExecutionSnapshot(appDataRoot = "", jobId = "") {
  return readJsonFile(getExecutionSnapshotPath(appDataRoot, jobId));
}

export async function readAiSessionCheckpoint(appDataRoot = "", sessionId = 0) {
  const checkpoint = await readJsonFile(getSessionCheckpointPath(appDataRoot, sessionId));
  if (!checkpoint?.latestExecution?.jobId) {
    return checkpoint;
  }
  const latestSnapshot = await readExecutionSnapshot(appDataRoot, checkpoint.latestExecution.jobId);
  return {
    ...checkpoint,
    latestSnapshot
  };
}

async function appendJsonLine(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function writeJsonFile(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function createAiSessionCheckpointer({ appDataRoot = "", jobId = "", botId = "ai.chat", chat = {}, sessionId = null }) {
  const normalizedJobId = String(jobId || "").trim() || "unknown";
  const normalizedSessionId = normalizeSessionId(sessionId);
  let sequence = 0;

  function createBaseEvent() {
    sequence += 1;
    return {
      sequence,
      at: new Date().toISOString(),
      jobId: normalizedJobId,
      botId,
      sessionId: normalizedSessionId,
      hostClientId: String(chat?.hostClientId || "").trim(),
      historyPath: String(chat?.historyPath || "").trim(),
      dayKey: String(chat?.dayKey || "").trim()
    };
  }

  return {
    async recordNodeEvent({ node = "", event = "", route = "", detail = "", status = "" } = {}) {
      await appendJsonLine(getExecutionTracePath(appDataRoot, normalizedJobId), {
        ...createBaseEvent(),
        kind: "node",
        node: String(node || "").trim(),
        event: String(event || "").trim(),
        route: String(route || "").trim(),
        detail: String(detail || "").trim(),
        status: String(status || "").trim()
      });
    },
    async recordToolEvent({ name = "", round = 0, status = "", input = null, outputPreview = "" } = {}) {
      await appendJsonLine(getExecutionTracePath(appDataRoot, normalizedJobId), {
        ...createBaseEvent(),
        kind: "tool",
        tool: String(name || "").trim(),
        round: Number.isFinite(round) ? Number(round) : 0,
        status: String(status || "").trim(),
        input,
        outputPreview: String(outputPreview || "").slice(0, 320)
      });
    },
    async saveExecution({ status = "unknown", route = "", trace = [], result = null, error = null, recoveryState = null } = {}) {
      const snapshot = {
        savedAt: new Date().toISOString(),
        jobId: normalizedJobId,
        botId,
        sessionId: normalizedSessionId,
        status: String(status || "unknown").trim(),
        route: String(route || "").trim(),
        hostClientId: String(chat?.hostClientId || "").trim(),
        historyPath: String(chat?.historyPath || "").trim(),
        traceSummary: buildTraceSummary(trace),
        trace: Array.isArray(trace) ? trace : [],
        recoveryState: summarizeRecoveryState(recoveryState),
        result: summarizeResult(result),
        error: error
          ? {
              name: String(error?.name || "Error").trim(),
              message: String(error?.message || error || "unknown error").trim()
            }
          : null
      };
      await writeJsonFile(getExecutionSnapshotPath(appDataRoot, normalizedJobId), snapshot);

      if (normalizedSessionId) {
        await writeJsonFile(getSessionCheckpointPath(appDataRoot, normalizedSessionId), {
          savedAt: snapshot.savedAt,
          sessionId: normalizedSessionId,
          latestExecution: {
            jobId: normalizedJobId,
            status: snapshot.status,
            route: snapshot.route,
            traceCount: snapshot.traceSummary.count,
            lastNode: snapshot.traceSummary.lastNode,
            historyPath: snapshot.historyPath,
            replyPreview: String(snapshot.result?.reply?.textPreview || ""),
            snapshotPath: getExecutionSnapshotPath(appDataRoot, normalizedJobId),
            tracePath: getExecutionTracePath(appDataRoot, normalizedJobId)
          }
        });
      }

      return snapshot;
    }
  };
}