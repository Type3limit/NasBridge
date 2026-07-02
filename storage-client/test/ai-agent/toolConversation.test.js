import test from "node:test";
import assert from "node:assert/strict";

import {
  createToolAwarePlanningMessages,
  executePendingToolCallsRound,
  invokeToolAwarePlanningRound,
  parseJsonToolPlan,
  shouldUseJsonToolFallback
} from "../../src/bot/plugins/ai-chat/toolConversation.js";

function createFakeApi() {
  const logs = [];
  const progress = [];
  const agentEvents = [];
  const toolEvents = [];
  return {
    storageRoot: "D:/NAS",
    clientId: "client",
    signal: null,
    logs,
    progress,
    agentEvents,
    toolEvents,
    dependencies: {
      listLibraryFiles: async () => ({
        clientId: "client",
        directories: [{ path: "Videos", name: "Videos" }],
        files: [
          {
            id: "client:Videos/demo.mp4",
            clientId: "client",
            path: "Videos/demo.mp4",
            name: "demo.mp4",
            size: 1024,
            mimeType: "video/mp4",
            updatedAt: "2026-07-01T12:00:00.000Z",
            tags: ["demo"]
          }
        ]
      })
    },
    appendLog: async (line) => logs.push(line),
    emitProgress: async (event) => progress.push(event),
    traceHooks: {
      recordAgentEvent: async (event) => agentEvents.push(event),
      recordToolEvent: async (event) => toolEvents.push(event)
    }
  };
}

test("JSON fallback plans, executes, observes, and finishes through tool messages", async () => {
  const api = createFakeApi();
  const modelSettings = {
    textModel: "openai::deepseek-v4-pro",
    lastListedModels: [
      {
        id: "openai::deepseek-v4-pro",
        modelId: "deepseek-v4-pro",
        provider: "openai",
        name: "DeepSeek V4 Pro",
        toolCalls: false
      }
    ]
  };
  const messages = createToolAwarePlanningMessages({
    systemPrompt: "You are a NAS assistant.",
    effectivePrompt: "Find recent videos.",
    historyMessages: []
  });
  const modelOutputs = [
    JSON.stringify({
      action: "call_tool",
      tool: "search_library_files",
      arguments: { kind: "video", limit: 5 },
      reason: "Need the NAS index before answering."
    }),
    JSON.stringify({
      action: "final_answer",
      answer: "Found demo.mp4 in Videos."
    })
  ];
  const modelCalls = [];
  const modelInvoker = async (request) => {
    modelCalls.push(request);
    return {
      text: modelOutputs.shift(),
      model: request.model,
      finishReason: "stop"
    };
  };

  assert.equal(shouldUseJsonToolFallback({ model: "openai::deepseek-v4-pro", modelSettings }), true);

  const planned = await invokeToolAwarePlanningRound({
    messages,
    recentMessages: [],
    context: { chat: {}, attachments: [] },
    api,
    defaultTextModel: "openai::deepseek-v4-pro",
    modelSettings,
    modelInvoker,
    round: 0,
    maxToolRounds: 4
  });

  assert.equal(planned.result.fallback, "json-plan");
  assert.equal(planned.pendingToolCalls.length, 1);
  assert.equal(planned.pendingToolCalls[0].name, "search_library_files");
  assert.equal(planned.pendingToolCalls[0].fallbackJsonPlan, true);

  const observedMessages = await executePendingToolCallsRound({
    pendingToolCalls: planned.pendingToolCalls,
    planningMessages: planned.planningMessages,
    recentMessages: [],
    context: { chat: {}, attachments: [] },
    api,
    round: 0
  });

  const observation = observedMessages.at(-1);
  assert.equal(observation.role, "user");
  assert.match(observation.content, /工具 search_library_files 已执行/);
  assert.match(observation.content, /demo\.mp4/);

  const finished = await invokeToolAwarePlanningRound({
    messages: observedMessages,
    recentMessages: [],
    context: { chat: {}, attachments: [] },
    api,
    defaultTextModel: "openai::deepseek-v4-pro",
    modelSettings,
    modelInvoker,
    round: 1,
    maxToolRounds: 4
  });

  assert.equal(finished.pendingToolCalls.length, 0);
  assert.equal(finished.result.text, "Found demo.mp4 in Videos.");
  assert.equal(modelCalls.length, 2);
  assert.deepEqual(
    api.agentEvents.map((event) => event.phase),
    ["plan_next_step", "observe_result", "plan_next_step"]
  );
  assert.equal(api.toolEvents[0].name, "search_library_files");
  assert.equal(api.toolEvents[0].input.__fallback, "json-plan");
});

test("native tool-call unsupported errors recover into JSON fallback", async () => {
  const api = createFakeApi();
  const modelSettings = {
    textModel: "openai::tool-model",
    lastListedModels: [
      {
        id: "openai::tool-model",
        modelId: "tool-model",
        provider: "openai",
        name: "Tool Model",
        toolCalls: true
      }
    ]
  };
  const messages = createToolAwarePlanningMessages({
    systemPrompt: "You are a NAS assistant.",
    effectivePrompt: "Find a document.",
    historyMessages: []
  });
  let callCount = 0;
  const modelInvoker = async (request) => {
    callCount += 1;
    if (request.toolChoice === "auto") {
      throw new Error("tools are not supported by this model");
    }
    return {
      text: JSON.stringify({
        action: "call_tool",
        tool: "search_library_files",
        arguments: { kind: "document", limit: 3 }
      }),
      model: request.model,
      finishReason: "stop"
    };
  };

  const planned = await invokeToolAwarePlanningRound({
    messages,
    recentMessages: [],
    context: { chat: {}, attachments: [] },
    api,
    defaultTextModel: "openai::tool-model",
    modelSettings,
    modelInvoker,
    round: 0,
    maxToolRounds: 4
  });

  assert.equal(callCount, 2);
  assert.equal(planned.result.fallback, "json-plan");
  assert.equal(planned.pendingToolCalls.length, 1);
  assert.equal(planned.pendingToolCalls[0].name, "search_library_files");
  assert.match(api.logs.join("\n"), /json-tool-fallback round=0/);
});

test("tool execution preflight blocks unavailable hard dependencies without creating child jobs", async () => {
  const api = createFakeApi();
  let invoked = false;
  api.invokeBot = async () => {
    invoked = true;
    throw new Error("invokeBot should not be called when preflight blocks the tool");
  };
  const observedMessages = await executePendingToolCallsRound({
    pendingToolCalls: [
      {
        id: "call_1",
        name: "invoke_video_analyze",
        input: { fileId: "client:Videos/demo.mp4" }
      }
    ],
    planningMessages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "invoke_video_analyze",
              arguments: JSON.stringify({ fileId: "client:Videos/demo.mp4" })
            }
          }
        ]
      }
    ],
    recentMessages: [],
    context: { chat: {}, attachments: [] },
    api,
    round: 0,
    healthSnapshot: {
      overall: "warn",
      checks: [
        { id: "ai-model", label: "AI 模型", status: "ok", detail: "文本模型可用" },
        { id: "ffmpeg", label: "ffmpeg", status: "ok", detail: "ffmpeg.exe" },
        { id: "ffprobe", label: "ffprobe", status: "ok", detail: "ffprobe.exe" },
        { id: "storage-root", label: "NAS 文件访问", status: "ok", detail: "D:\\NAS；可读写" },
        { id: "whisper", label: "Whisper", status: "warn", detail: "WHISPER_CPP_PATH 或 WHISPER_MODEL_PATH 未配置" }
      ]
    }
  });

  assert.equal(invoked, false);
  const observation = observedMessages.at(-1);
  assert.equal(observation.role, "tool");
  assert.equal(observation.tool_call_id, "call_1");
  assert.match(observation.content, /"status": "blocked"/);
  assert.match(observation.content, /"id": "whisper"/);
  assert.match(observation.content, /WHISPER_CPP_PATH/);
  assert.doesNotMatch(observation.content, /D:\\NAS/);
  assert.equal(api.toolEvents[0].status, "blocked");
  assert.equal(api.toolEvents[0].inputSummary.tool, "invoke_video_analyze");
  assert.deepEqual(api.toolEvents[0].inputSummary.identifiers, ["client:Videos/demo.mp4"]);
  assert.match(api.toolEvents[0].startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(api.toolEvents[0].finishedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(api.toolEvents[0].durationMs >= 0);
  assert.match(api.logs.join("\n"), /tool-call-blocked invoke_video_analyze/);
});

test("delegated tool results write structured job refs into tool trace events", async () => {
  const api = createFakeApi();
  api.botId = "ai.chat";
  api.jobId = "botjob_parent";
  api.invokeBot = async (request) => {
    assert.equal(request.botId, "video.analyze");
    assert.equal(request.options.parentJobId, "botjob_parent");
    return { jobId: "botjob_child", status: "queued" };
  };

  const observedMessages = await executePendingToolCallsRound({
    pendingToolCalls: [
      {
        id: "call_2",
        name: "invoke_video_analyze",
        input: { fileId: "client:Videos/demo.mp4" }
      }
    ],
    planningMessages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: {
              name: "invoke_video_analyze",
              arguments: JSON.stringify({ fileId: "client:Videos/demo.mp4" })
            }
          }
        ]
      }
    ],
    recentMessages: [],
    context: { chat: {}, attachments: [] },
    api,
    round: 0
  });

  const observation = observedMessages.at(-1);
  assert.equal(observation.role, "tool");
  assert.match(observation.content, /botjob_child/);
  assert.equal(api.toolEvents[0].status, "completed");
  assert.equal(api.toolEvents[0].inputSummary.tool, "invoke_video_analyze");
  assert.deepEqual(api.toolEvents[0].inputSummary.identifiers, ["client:Videos/demo.mp4"]);
  assert.ok(api.toolEvents[0].durationMs >= 0);
  assert.equal(api.toolEvents[0].resultSummary.jobId, "botjob_child");
  assert.equal(api.toolEvents[0].resultSummary.botId, "video.analyze");
  assert.equal(api.toolEvents[0].resultSummary.delegated, true);
  assert.deepEqual(api.toolEvents[0].resultSummary.jobRefs, [
    {
      jobId: "botjob_child",
      botId: "video.analyze",
      status: "queued",
      delegated: true
    }
  ]);
  assert.equal(api.toolEvents[0].resultSummary.file.path, "Videos/demo.mp4");
});

test("tool trace records structured confirmation previews", async () => {
  const api = createFakeApi();
  let invoked = false;
  api.invokeBot = async () => {
    invoked = true;
    throw new Error("batch preview should not delegate before confirmation");
  };

  const observedMessages = await executePendingToolCallsRound({
    pendingToolCalls: [
      {
        id: "call_3",
        name: "invoke_video_tag",
        input: { batch: true, force: true }
      }
    ],
    planningMessages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_3",
            type: "function",
            function: {
              name: "invoke_video_tag",
              arguments: JSON.stringify({ batch: true, force: true })
            }
          }
        ]
      }
    ],
    recentMessages: [],
    context: { chat: {}, attachments: [] },
    api,
    round: 0
  });

  assert.equal(invoked, false);
  const observation = observedMessages.at(-1);
  assert.equal(observation.role, "tool");
  assert.match(observation.content, /confirmation_required/);
  assert.equal(api.toolEvents[0].status, "completed");
  assert.equal(api.toolEvents[0].resultSummary.requiresConfirmation, true);
  assert.equal(api.toolEvents[0].resultSummary.blocked, true);
  assert.equal(api.toolEvents[0].resultSummary.confirmation.operation, "invoke_video_tag");
  assert.equal(api.toolEvents[0].resultSummary.confirmation.riskLevel, "medium");
  assert.equal(api.toolEvents[0].resultSummary.confirmation.impact.targetFileCount, 1);
  assert.deepEqual(api.toolEvents[0].resultSummary.confirmation.impact.changedFields, ["tags"]);
  assert.equal(api.toolEvents[0].resultSummary.confirmation.confirmWith.confirmed, true);
});

test("parseJsonToolPlan rejects unknown tools and accepts final answers", () => {
  const tools = [{ name: "search_library_files", inputSchema: { type: "object" } }];

  const unknown = parseJsonToolPlan(
    JSON.stringify({ action: "call_tool", tool: "run_local_script", arguments: {} }),
    tools
  );
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown tool/);

  const final = parseJsonToolPlan(
    JSON.stringify({ action: "final_answer", answer: "Done." }),
    tools
  );
  assert.equal(final.ok, true);
  assert.equal(final.action, "final_answer");
  assert.equal(final.finalAnswer, "Done.");
});
