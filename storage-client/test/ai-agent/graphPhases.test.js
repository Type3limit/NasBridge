import test from "node:test";
import assert from "node:assert/strict";

import { runAiChatGraph } from "../../src/bot/langgraph/aiChatGraph.js";

test("ai chat graph progress and saved trace expose agent phase labels", async () => {
  const progress = [];
  const savedExecutions = [];

  const result = await runAiChatGraph({
    context: { jobId: "botjob_graph_phase" },
    api: {
      appendLog: async () => {},
      emitProgress: async (event) => progress.push(event)
    },
    handlers: {
      handlePrepareInput: async () => ({
        route: "command",
        prepared: {
          effectivePrompt: "/tools"
        }
      }),
      handleCommand: async () => ({
        result: {
          ok: true
        }
      })
    },
    hooks: {
      recordNodeEvent: async () => {},
      saveExecution: async (payload) => savedExecutions.push(payload)
    }
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(savedExecutions.length, 1);
  assert.ok(savedExecutions[0].trace.some((entry) => entry.node === "prepareInput" && entry.agentPhase === "PrepareInput"));
  assert.ok(savedExecutions[0].trace.some((entry) => entry.node === "command" && entry.agentPhase === "Command"));
  assert.ok(progress.some((event) => event.graphState?.activeNode === "prepareInput" && event.graphState?.agentPhase === "PrepareInput"));
  assert.ok(progress.some((event) => event.graphState?.activeNode === "command" && event.graphState?.agentPhase === "Command"));
});

test("ai chat graph progress exposes agent plan and executed tool summaries", async () => {
  const progress = [];
  let planCalls = 0;

  const result = await runAiChatGraph({
    context: { jobId: "botjob_graph_plan" },
    api: {
      appendLog: async () => {},
      emitProgress: async (event) => progress.push(event)
    },
    handlers: {
      handlePrepareInput: async () => ({
        route: "text",
        prepared: {
          effectivePrompt: "总结这个视频"
        }
      }),
      handlePrepareContext: async (state) => ({
        route: "text",
        prepared: state.prepared
      }),
      handleTextPlan: async () => {
        planCalls += 1;
        if (planCalls === 1) {
          return {
            pendingToolCalls: [
              {
                name: "read_media_summary",
                reason: "读取已有媒体摘要"
              },
              {
                name: "invoke_video_analyze",
                reason: "没有摘要时启动分析",
                fallbackJsonPlan: true
              }
            ],
            modelResult: {
              model: "openai::deepseek-v4-pro",
              fallback: "json-plan",
              finishReason: "tool_calls"
            },
            toolRound: 1
          };
        }
        return {
          pendingToolCalls: [],
          modelResult: {
            model: "openai::deepseek-v4-pro",
            finishReason: "stop"
          }
        };
      },
      handleTextTools: async () => ({
        pendingToolCalls: []
      }),
      handleTextAnswer: async () => ({
        result: {
          ok: true
        }
      })
    },
    hooks: {
      recordNodeEvent: async () => {},
      saveExecution: async () => {}
    }
  });

  assert.deepEqual(result, { ok: true });
  const planProgress = progress.find((event) => event.graphState?.activeNode === "textPlan" && Array.isArray(event.graphState.details?.tools));
  assert.ok(planProgress);
  assert.deepEqual(planProgress.graphState.details.tools, [
    "read_media_summary：读取已有媒体摘要",
    "invoke_video_analyze：没有摘要时启动分析 · json"
  ]);
  assert.equal(planProgress.graphState.details.plannedToolCount, 2);
  assert.equal(planProgress.graphState.details.toolRound, 1);
  assert.equal(planProgress.graphState.details.model, "openai::deepseek-v4-pro");
  assert.equal(planProgress.graphState.details.fallback, "json-plan");
  assert.equal(planProgress.graphState.details.finishReason, "tool_calls");

  const toolsProgress = progress.find((event) => event.graphState?.activeNode === "textTools" && Array.isArray(event.graphState.details?.executedTools));
  assert.ok(toolsProgress);
  assert.deepEqual(toolsProgress.graphState.details.executedTools, [
    "read_media_summary：读取已有媒体摘要",
    "invoke_video_analyze：没有摘要时启动分析 · json"
  ]);
  assert.equal(toolsProgress.graphState.details.executedToolCount, 2);
  assert.equal(toolsProgress.graphState.details.toolRound, 1);
});
