import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  formatAgentTraceReport,
  handleAiChatCommandRoute
} from "../../src/bot/langgraph/nodes/commandNodes.js";

test("formatAgentTraceReport summarizes trace timeline, recovery, and child jobs", () => {
  const body = formatAgentTraceReport({
    jobId: "botjob_parent",
    latest: true,
    snapshot: {
      status: "failed",
      route: "textTools",
      savedAt: "2026-07-02T08:00:00.000Z",
      traceSummary: {
        lastNode: "textTools"
      }
    },
    recoveryHint: {
      mode: "text-retry-tools",
      nextAction: "直接重试未完成的只读工具：read_media_summary"
    },
    toolStats: {
      count: 1,
      statusCounts: { succeeded: 1 },
      tools: [{
        tool: "invoke_video_analyze",
        callCount: 1,
        statusCounts: { succeeded: 1 },
        averageDurationMs: 1250,
        jobRefs: [{ botId: "video.analyze", jobId: "botjob_child" }]
      }]
    },
    timeline: [{
      index: 1,
      label: "invoke_video_analyze (succeeded)",
      durationMs: 1250,
      inputSummary: { tool: "invoke_video_analyze", fileId: "client:movie.mp4" },
      resultSummary: {
        jobRefs: [{ botId: "video.analyze", jobId: "botjob_child" }]
      }
    }]
  });

  assert.match(body, /Agent job: botjob_parent/);
  assert.match(body, /恢复建议/);
  assert.match(body, /invoke_video_analyze: 1 次/);
  assert.match(body, /video\.analyze:botjob_child/);
  assert.match(body, /最近步骤/);
});

test("trace command route publishes latest agent trace report", async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-trace-command-"));
  const jobId = "botjob_trace_command";
  try {
    const graphRoot = path.join(appDataRoot, "ai-chat-graph");
    await fs.mkdir(path.join(graphRoot, "executions"), { recursive: true });
    await fs.mkdir(path.join(graphRoot, "traces"), { recursive: true });
    await fs.writeFile(path.join(graphRoot, "executions", `${jobId}.json`), JSON.stringify({
      jobId,
      botId: "ai.chat",
      status: "succeeded",
      route: "textTools",
      savedAt: "2026-07-02T08:00:00.000Z",
      traceSummary: {
        count: 1,
        lastNode: "textTools",
        lastStatus: "succeeded"
      },
      result: {},
      recoveryState: {
        toolRound: 1,
        pendingToolNames: []
      }
    }), "utf8");
    await fs.writeFile(path.join(graphRoot, "traces", `${jobId}.jsonl`), `${JSON.stringify({
      kind: "tool",
      tool: "read_agent_trace",
      status: "succeeded",
      durationMs: 42,
      inputSummary: { tool: "read_agent_trace" },
      resultSummary: { status: "succeeded" }
    })}\n`, "utf8");

    const replies = [];
    const api = {
      appDataRoot,
      signal: null,
      throwIfCancelled() {},
      async publishChatReply(payload) {
        replies.push(payload);
        return {
          id: "reply_trace",
          text: payload.text,
          card: payload.card
        };
      }
    };

    const result = await handleAiChatCommandRoute({
      prepared: {
        api,
        modelDirective: {
          command: {
            type: "trace",
            jobId
          }
        },
        modelSettings: {}
      }
    });

    assert.equal(replies[0].card.title, "AI Agent Trace");
    assert.equal(replies[0].card.status, "succeeded");
    assert.match(result.result.chatReply.text, /read_agent_trace/);
    assert.equal(result.result.artifacts[0].type, "agent-trace");
    assert.equal(result.result.artifacts[0].jobId, jobId);
  } finally {
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});
