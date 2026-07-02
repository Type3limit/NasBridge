import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BotJobStore } from "../../src/bot/jobStore.js";
import {
  formatBotJobLogReport,
  formatBotJobStatusReport,
  formatAgentTraceReport,
  handleAiChatCommandRoute
} from "../../src/bot/langgraph/nodes/commandNodes.js";
import { readAiModelSettings } from "../../src/bot/plugins/ai-chat/services/modelSettings.js";

async function withEnv(vars, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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
      nextAction: "直接重试未完成的只读工具：read_media_summary",
      suggestedAction: {
        tool: "read_media_summary",
        reason: "已有媒体派生信息可读取。"
      },
      suggestedActions: [
        {
          tool: "read_media_summary",
          reason: "已有媒体派生信息可读取。"
        },
        {
          tool: "invoke_video_analyze",
          riskLevel: "medium"
        }
      ]
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
        jobRefs: [{ botId: "video.analyze", jobId: "botjob_child" }],
        fileAccess: {
          found: true,
          contentAccess: {
            analyzeMode: "media"
          },
          layers: [
            { id: "metadata", available: true },
            { id: "excerpt", available: false },
            { id: "analysis", available: false }
          ],
          blockers: [
            { id: "dependency-whisper", message: "Whisper 未配置" }
          ],
          actionPlan: [
            { tool: "read_file_metadata" },
            { tool: "invoke_video_analyze" }
          ],
          nextActions: ["配置 WHISPER_MODEL_PATH 后重试"]
        },
        log: {
          jobId: "botjob_parent",
          length: 2048,
          truncated: true
        },
        agentTrace: {
          eventCount: 4,
          childJobCount: 1
        },
        nextAction: "查看 @ai /log botjob_parent"
      }
    }]
  });

  assert.match(body, /Agent job: botjob_parent/);
  assert.match(body, /恢复建议/);
  assert.match(body, /suggested tools: read_media_summary, invoke_video_analyze/);
  assert.match(body, /suggested reason: 已有媒体派生信息可读取。/);
  assert.match(body, /Agent 计划/);
  assert.match(body, /tools=invoke_video_analyze/);
  assert.match(body, /子任务: failed 1/);
  assert.match(body, /video\.analyze · botjob_child · failed/);
  assert.match(body, /invoke_video_analyze: 1 次/);
  assert.match(body, /video\.analyze:botjob_child/);
  assert.match(body, /最近步骤/);
  assert.match(body, /access: found=true · mode=media · layers=metadata · blockers=dependency-whisper · actions=read_file_metadata,invoke_video_analyze/);
  assert.match(body, /log: job=botjob_parent · chars=2048 · truncated/);
  assert.match(body, /trace: events=4 · childJobs=1/);
  assert.match(body, /next: 查看 @ai \/log botjob_parent/);
  assert.doesNotMatch(body, /D:[/\\]NAS/);
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
        snapshot: {
          sessionId: 7
        },
        recoveryHint: {
          nextAction: "修复 Whisper 后重试",
          canContinueDirectly: true,
          requiresUserConfirmation: false,
          suggestedActions: [
            { tool: "read_media_summary" },
            { tool: "read_text_excerpt" }
          ]
        }
      }
    }]
  });

  assert.match(body, /Bot 任务状态：1/);
  assert.match(body, /ai\.chat · botjob_parent · failed/);
  assert.match(body, /子任务：1 · failed 1/);
  assert.match(body, /video\.analyze · botjob_child · failed/);
  assert.match(body, /恢复建议：修复 Whisper 后重试/);
  assert.match(body, /建议工具：read_media_summary、read_text_excerpt/);
  assert.match(body, /可继续：@ai #7 继续/);
  assert.match(body, /@ai \/trace <jobId>/);
});

test("formatBotJobLogReport summarizes redacted log and child jobs", () => {
  const body = formatBotJobLogReport({
    jobId: "botjob_parent",
    job: {
      jobId: "botjob_parent",
      botId: "ai.chat",
      status: "failed",
      phase: "failed",
      progress: { label: "Failed", percent: 99 }
    },
    log: {
      jobId: "botjob_parent",
      content: "[2026-07-02T00:00:00.000Z] OPENAI_API_KEY=***\n[2026-07-02T00:00:01.000Z] failed\n",
      truncated: false
    },
    childJobs: [{
      jobId: "botjob_child",
      botId: "video.analyze",
      status: "failed",
      phase: "failed"
    }],
    agentTrace: {
      recoveryHint: {
        nextAction: "等待用户确认后继续执行 update_file_metadata",
        requiresUserConfirmation: true,
        tool: "update_file_metadata",
        targetFileCount: 2,
        suggestedActions: [
          { tool: "update_file_metadata" }
        ]
      }
    }
  });

  assert.match(body, /Bot 日志：botjob_parent/);
  assert.match(body, /ai\.chat · botjob_parent · failed/);
  assert.match(body, /video\.analyze · botjob_child · failed/);
  assert.match(body, /OPENAI_API_KEY=\*\*\*/);
  assert.match(body, /恢复建议：等待用户确认后继续执行 update_file_metadata/);
  assert.match(body, /建议工具：update_file_metadata/);
  assert.match(body, /需要确认：update_file_metadata 影响文件数 2/);
  assert.match(body, /@ai \/job botjob_parent/);
});

test("models command refresh migrates display names to executable model refs", async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-model-command-"));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        data: [
          {
            id: "deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            vendor: "OpenAI Compatible",
            capabilities: { supports: { tool_calls: false } }
          },
          {
            id: "gpt-4.1-2025-04-14",
            name: "GPT 4.1",
            vendor: "OpenAI Compatible",
            capabilities: { supports: { tool_calls: true } }
          }
        ]
      })
    });
    await withEnv({
      AI_PROVIDER: "openai",
      OPENAI_BASE_URL: "https://example.invalid/v1",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "deepseek-v4-pro"
    }, async () => {
      const replies = [];
      const api = {
        appDataRoot,
        signal: null,
        throwIfCancelled() {},
        async publishChatReply(payload) {
          replies.push(payload);
          return {
            id: "reply_models",
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
              type: "list-models",
              filter: "all"
            }
          },
          modelSettings: {
            textModel: "DeepSeek V4 Pro",
            multimodalModel: "GPT 4.1",
            lastListedModels: []
          }
        }
      });

      const settings = await readAiModelSettings(appDataRoot);
      assert.equal(settings.textModel, "openai::deepseek-v4-pro");
      assert.equal(settings.multimodalModel, "openai::gpt-4.1-2025-04-14");
      assert.equal(settings.lastListedModels.length, 2);
      assert.equal(result.result.artifacts[0].type, "model-list");
      assert.equal(replies[0].card.title, "AI 可用模型列表");
      assert.equal(replies[0].card.status, "succeeded");
    });
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
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

test("log command route publishes redacted bot job log bundle", async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-log-command-"));
  try {
    const store = new BotJobStore({ rootDir: appDataRoot });
    await store.save({
      jobId: "botjob_parent",
      botId: "ai.chat",
      status: "failed",
      phase: "failed",
      progress: { label: "Failed", percent: 99, details: null },
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
      status: "failed",
      phase: "failed",
      progress: { label: "Whisper failed", percent: 12, details: null },
      input: {},
      options: {
        parentJobId: "botjob_parent",
        delegatedBy: "ai.chat",
        toolName: "invoke_video_analyze"
      },
      result: {},
      audit: {},
      error: { message: "WHISPER_MODEL_PATH missing" },
      createdAt: "2026-07-02T00:00:02.000Z",
      updatedAt: "2026-07-02T00:00:03.000Z"
    });
    await store.appendLog("botjob_parent", "OPENAI_API_KEY=sk-should-not-leak-1234567890");
    await store.appendLog("botjob_parent", "video analyze failed");
    await store.waitForPendingWrite("botjob_parent");
    await store.waitForPendingWrite("botjob_child");
    await store.waitForPendingLog("botjob_parent");

    const replies = [];
    const api = {
      appDataRoot,
      signal: null,
      throwIfCancelled() {},
      getJob: (jobId) => store.get(jobId),
      async publishChatReply(payload) {
        replies.push(payload);
        return {
          id: "reply_log",
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
            type: "log",
            jobId: "botjob_parent"
          }
        },
        modelSettings: {}
      }
    });

    assert.equal(replies[0].card.title, "Bot 任务日志");
    assert.equal(replies[0].card.status, "succeeded");
    assert.match(result.result.chatReply.text, /Bot 日志：botjob_parent/);
    assert.match(result.result.chatReply.text, /OPENAI_API_KEY=\*\*\*/);
    assert.doesNotMatch(result.result.chatReply.text, /sk-should-not-leak/);
    assert.match(result.result.chatReply.text, /video\.analyze · botjob_child · failed/);
    assert.equal(result.result.artifacts[0].type, "bot-job-log");
    assert.equal(result.result.artifacts[0].childJobs[0].jobId, "botjob_child");
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
