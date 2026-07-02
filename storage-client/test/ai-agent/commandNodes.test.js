import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BotJobStore } from "../../src/bot/jobStore.js";
import {
  formatBotJobStatusReport,
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
    planSummary: {
      count: 2,
      rounds: [{
        round: 0,
        plans: [{
          status: "tool-requested",
          model: "openai::deepseek-v4-pro",
          fallback: "json-plan",
          pendingTools: [{
            name: "invoke_video_analyze",
            reason: "需要生成视频摘要"
          }]
        }],
        observations: [{
          status: "observed",
          tool: "invoke_video_analyze",
          observationLength: 256
        }]
      }]
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
    childJobCount: 1,
    childJobStatusCounts: { failed: 1 },
    childJobs: [{
      jobId: "botjob_child",
      botId: "video.analyze",
      status: "failed",
      phase: "failed",
      progress: {
        label: "Whisper failed",
        percent: 12
      },
      error: {
        message: "WHISPER_MODEL_PATH missing"
      }
    }],
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
  assert.match(body, /Agent 计划/);
  assert.match(body, /tools=invoke_video_analyze/);
  assert.match(body, /子任务: failed 1/);
  assert.match(body, /video\.analyze · botjob_child · failed/);
  assert.match(body, /invoke_video_analyze: 1 次/);
  assert.match(body, /video\.analyze:botjob_child/);
  assert.match(body, /最近步骤/);
});

test("formatBotJobStatusReport summarizes jobs, child jobs, and recovery hints", () => {
  const body = formatBotJobStatusReport({
    recent: false,
    count: 1,
    missing: [],
    jobs: [{
      jobId: "botjob_parent",
      botId: "ai.chat",
      status: "failed",
      phase: "textTools",
      progress: {
        label: "Running",
        percent: 50
      },
      childJobCount: 1,
      childJobStatusCounts: { failed: 1 },
      childJobs: [{
        jobId: "botjob_child",
        botId: "video.analyze",
        status: "failed",
        phase: "failed",
        progress: { label: "Whisper failed", percent: 12 }
      }],
      agentTrace: {
        recoveryHint: {
          nextAction: "修复 Whisper 后重试"
        }
      }
    }]
  });

  assert.match(body, /Bot 任务状态：1/);
  assert.match(body, /ai\.chat · botjob_parent · failed/);
  assert.match(body, /子任务：1 · failed 1/);
  assert.match(body, /video\.analyze · botjob_child · failed/);
  assert.match(body, /恢复建议：修复 Whisper 后重试/);
  assert.match(body, /@ai \/trace <jobId>/);
});

test("trace command route publishes latest agent trace report", async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-trace-command-"));
  const jobId = "botjob_trace_command";
  try {
    const graphRoot = path.join(appDataRoot, "ai-chat-graph");
    await fs.mkdir(path.join(graphRoot, "executions"), { recursive: true });
    await fs.mkdir(path.join(graphRoot, "traces"), { recursive: true });
    await fs.mkdir(path.join(appDataRoot, "jobs"), { recursive: true });
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
      kind: "agent",
      phase: "plan_next_step",
      round: 0,
      status: "tool-requested",
      detail: {
        model: "openai::deepseek-v4-pro",
        pendingTools: [{ id: "call_trace", name: "read_agent_trace", reason: "用户要求查看 trace" }]
      },
      outputPreview: "call read_agent_trace"
    })}\n${JSON.stringify({
      kind: "tool",
      tool: "read_agent_trace",
      status: "succeeded",
      durationMs: 42,
      inputSummary: { tool: "read_agent_trace" },
      resultSummary: { status: "succeeded" }
    })}\n`, "utf8");
    await fs.writeFile(path.join(appDataRoot, "jobs", "botjob_trace_child.json"), JSON.stringify({
      jobId: "botjob_trace_child",
      botId: "video.analyze",
      status: "failed",
      phase: "failed",
      progress: {
        label: "Whisper failed",
        percent: 10
      },
      options: {
        parentJobId: jobId,
        delegatedBy: "ai.chat",
        toolName: "invoke_video_analyze"
      },
      error: {
        message: "WHISPER_MODEL_PATH missing"
      },
      input: {},
      result: {},
      audit: {}
    }), "utf8");

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
    assert.match(result.result.chatReply.text, /Agent 计划/);
    assert.match(result.result.chatReply.text, /子任务: failed 1/);
    assert.equal(result.result.artifacts[0].type, "agent-trace");
    assert.equal(result.result.artifacts[0].jobId, jobId);
    assert.equal(result.result.artifacts[0].planSummary.rounds[0].plans[0].pendingTools[0].name, "read_agent_trace");
    assert.equal(result.result.artifacts[0].childJobCount, 1);
    assert.equal(result.result.artifacts[0].childJobs[0].jobId, "botjob_trace_child");
  } finally {
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test("jobs command route publishes bot job status with child jobs", async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-jobs-command-"));
  try {
    const store = new BotJobStore({ rootDir: appDataRoot });
    await store.save({
      jobId: "botjob_parent",
      botId: "ai.chat",
      status: "running",
      phase: "textTools",
      progress: { label: "Agent running", percent: 40, details: null },
      input: {},
      options: {},
      result: {},
      audit: {},
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:01.000Z"
    });
    await store.save({
      jobId: "botjob_child",
      botId: "video.analyze",
      status: "queued",
      phase: "queued",
      progress: { label: "Queued", percent: 0, details: null },
      input: {},
      options: {
        parentJobId: "botjob_parent",
        delegatedBy: "ai.chat",
        toolName: "invoke_video_analyze"
      },
      result: {},
      audit: {},
      createdAt: "2026-07-02T00:00:02.000Z",
      updatedAt: "2026-07-02T00:00:02.000Z"
    });
    await store.waitForPendingWrite("botjob_parent");
    await store.waitForPendingWrite("botjob_child");

    const replies = [];
    const api = {
      appDataRoot,
      signal: null,
      throwIfCancelled() {},
      getJob: (jobId) => store.get(jobId),
      async publishChatReply(payload) {
        replies.push(payload);
        return {
          id: "reply_jobs",
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
            type: "jobs",
            jobId: "botjob_parent",
            limit: 1
          }
        },
        modelSettings: {}
      }
    });

    assert.equal(replies[0].card.title, "Bot 任务状态");
    assert.equal(replies[0].card.status, "succeeded");
    assert.match(result.result.chatReply.text, /ai\.chat · botjob_parent · running/);
    assert.match(result.result.chatReply.text, /子任务：1 · queued 1/);
    assert.equal(result.result.artifacts[0].type, "bot-job-status");
    assert.equal(result.result.artifacts[0].jobs[0].childJobs[0].jobId, "botjob_child");
  } finally {
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});
