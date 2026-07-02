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
