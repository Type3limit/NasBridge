import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BotJobStore } from "../../src/bot/jobStore.js";
import { buildAgentTraceResult, buildBotJobLogBundle, buildBotJobStatusResult } from "../../src/bot/tools/botJobStatus.js";
import { executeAiToolCall } from "../../src/bot/tools/aiToolRuntime.js";

async function createTempAppDataRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-job-status-"));
}

function createJob(jobId, overrides = {}) {
  return {
    jobId,
    botId: overrides.botId || "ai.chat",
    status: overrides.status || "running",
    phase: overrides.phase || "running",
    progress: overrides.progress || {
      label: "Running",
      percent: 25,
      details: null
    },
    requester: {
      userId: "u1",
      displayName: "Tester",
      role: "admin"
    },
    chat: {},
    input: {
      triggerType: "chat-mention",
      rawText: "@ai do work",
      parsedArgs: overrides.parsedArgs || {}
    },
    attachments: [],
    options: overrides.options || {},
    result: {
      replyMessageId: "",
      importedFiles: [],
      artifacts: overrides.artifacts || []
    },
    error: overrides.error || null,
    audit: overrides.audit || {
      permissionsUsed: [],
      toolCalls: []
    },
    createdAt: "2026-07-02T00:00:00.000Z",
    startedAt: "2026-07-02T00:00:01.000Z",
    finishedAt: "",
    updatedAt: "2026-07-02T00:00:01.000Z"
  };
}

test("bot job log bundle includes redacted log, agent trace, and delegated child jobs", async () => {
  const appDataRoot = await createTempAppDataRoot();
  const store = new BotJobStore({ rootDir: appDataRoot });
  await store.save(createJob("botjob_parent", {
    parsedArgs: { apiKey: "sk-should-not-leak-1234567890" },
    audit: {
      permissionsUsed: ["readLibrary", "storage:metadata:write"],
      toolCalls: [{
        name: "update_file_metadata",
        status: "completed",
        riskLevel: "medium",
        permissions: ["storage:metadata:write"],
        durationMs: 42,
        inputSummary: {
          identifiers: ["client:Docs/a.txt"],
          apiKey: "sk-should-not-leak-1234567890"
        },
        resultSummary: {
          file: { path: "D:\\NAS\\Docs\\a.txt" },
          token: "should-not-leak"
        }
      }]
    }
  }));
  await store.save(createJob("botjob_child", {
    botId: "video.analyze",
    status: "queued",
    phase: "queued",
    progress: { label: "Queued", percent: 0, details: null },
    options: {
      delegatedBy: "ai.chat",
      parentJobId: "botjob_parent",
      toolName: "invoke_video_analyze"
    }
  }));
  await store.appendLog("botjob_parent", "OPENAI_API_KEY=sk-should-not-leak-1234567890");
  const traceDir = path.join(appDataRoot, "ai-chat-graph", "traces");
  await fs.mkdir(traceDir, { recursive: true });
  await fs.writeFile(
    path.join(traceDir, "botjob_parent.jsonl"),
    `${JSON.stringify({
      kind: "tool",
      tool: "invoke_video_analyze",
      status: "succeeded",
      startedAt: "2026-07-02T00:00:02.000Z",
      finishedAt: "2026-07-02T00:00:03.250Z",
      durationMs: 1250,
      input: { apiKey: "sk-should-not-leak-1234567890", fileId: "file_1" },
      inputSummary: {
        tool: "invoke_video_analyze",
        identifiers: ["file_1"],
        options: { waitForCompletion: false }
      },
      outputPreview: "jobId=botjob_child",
      resultSummary: {
        delegated: true,
        botId: "video.analyze",
        jobId: "botjob_child",
        jobRefs: [
          {
            jobId: "botjob_child",
            botId: "video.analyze",
            status: "queued",
            delegated: true
          }
        ],
        capability: {
          id: "invoke_video_analyze",
          kind: "tool",
          riskLevel: "medium",
          executionMode: "async-job",
          requiresConfirmation: false,
          capabilities: ["media-analysis", "bot-delegation"],
          permissions: ["bot:invoke", "ai:model:invoke", "storage:content:read", "storage:metadata:write"],
          output: {
            required: ["status", "botId", "jobId"],
            fields: ["status", "phase", "botId", "jobId", "tracking"]
          }
        }
      }
    })}\n`,
    "utf8"
  );

  const bundle = await buildBotJobLogBundle({
    appDataRoot,
    getJob: (jobId) => store.get(jobId)
  }, {
    jobId: "botjob_parent",
    includeTrace: true,
    includeChildJobs: true,
    store
  });

  assert.equal(bundle.job.jobId, "botjob_parent");
  assert.equal(bundle.log.content.includes("sk-should-not-leak"), false);
  assert.match(bundle.log.content, /OPENAI_API_KEY=\*\*\*/);
  assert.ok(bundle.lifecycle.count >= 1);
  assert.equal(bundle.lifecycle.last.status, "running");
  assert.ok(bundle.lifecycle.phases.includes("running"));
  assert.ok(bundle.lifecycle.statuses.includes("running"));
  assert.equal(bundle.childJobs.length, 1);
  assert.equal(bundle.childJobs[0].jobId, "botjob_child");
  assert.equal(bundle.childJobs[0].botId, "video.analyze");
  assert.equal(bundle.childJobs[0].tracking.logCommand, "@ai /log botjob_child");
  assert.deepEqual(bundle.job.audit.permissionsUsed, ["readLibrary", "storage:metadata:write"]);
  assert.equal(bundle.job.audit.toolCallCount, 1);
  assert.equal(bundle.job.audit.recentToolCalls[0].name, "update_file_metadata");
  assert.equal(bundle.job.audit.recentToolCalls[0].riskLevel, "medium");
  assert.deepEqual(bundle.job.audit.recentToolCalls[0].identifiers, ["client:Docs/a.txt"]);
  assert.equal(JSON.stringify(bundle.job.audit).includes("D:\\NAS"), false);
  assert.equal(JSON.stringify(bundle.job.audit).includes("sk-should-not-leak"), false);
  assert.equal(bundle.agentTrace.events.length, 1);
  assert.equal(bundle.agentTrace.events[0].input.apiKey, "***");
  assert.equal(bundle.agentTrace.events[0].input.fileId, "file_1");
  assert.equal(bundle.agentTrace.events[0].resultSummary.jobId, "botjob_child");
  assert.equal(bundle.agentTrace.events[0].resultSummary.jobRefs[0].botId, "video.analyze");
  assert.equal(bundle.agentTrace.timeline[0].label, "invoke_video_analyze (succeeded)");
  assert.equal(bundle.agentTrace.timeline[0].durationMs, 1250);
  assert.deepEqual(bundle.agentTrace.timeline[0].inputSummary.identifiers, ["file_1"]);
  assert.equal(bundle.agentTrace.timeline[0].resultSummary.jobRefs[0].jobId, "botjob_child");
  assert.equal(bundle.agentTrace.timeline[0].resultSummary.capability.id, "invoke_video_analyze");
  assert.equal(bundle.agentTrace.timeline[0].resultSummary.capability.riskLevel, "medium");
  assert.equal(bundle.agentTrace.timeline[0].resultSummary.capability.executionMode, "async-job");
  assert.ok(bundle.agentTrace.timeline[0].resultSummary.capability.permissions.includes("storage:metadata:write"));
  assert.deepEqual(bundle.agentTrace.timeline[0].resultSummary.capability.output.required, ["status", "botId", "jobId"]);
  assert.equal(bundle.agentTrace.toolStats.count, 1);
  assert.equal(bundle.agentTrace.toolStats.totalDurationMs, 1250);
  assert.equal(bundle.agentTrace.toolStats.tools[0].tool, "invoke_video_analyze");
  assert.equal(bundle.agentTrace.toolStats.tools[0].averageDurationMs, 1250);
  assert.equal(bundle.agentTrace.toolStats.tools[0].jobRefs[0].jobId, "botjob_child");
  assert.equal(bundle.agentTrace.childJobCount, 1);
  assert.equal(bundle.agentTrace.childJobs[0].jobId, "botjob_child");
  assert.equal(bundle.agentTrace.childJobs[0].botId, "video.analyze");
  assert.equal(bundle.agentTrace.childJobs[0].tracking.traceCommand, "@ai /trace botjob_child");
  assert.equal(bundle.agentTrace.childJobStatusCounts.queued, 1);
});

test("read_bot_job_log tool returns redacted job log bundle", async () => {
  const appDataRoot = await createTempAppDataRoot();
  const store = new BotJobStore({ rootDir: appDataRoot });
  await store.save(createJob("botjob_parent", {
    parsedArgs: { apiKey: "sk-should-not-leak-1234567890" }
  }));
  await store.save(createJob("botjob_child", {
    botId: "video.analyze",
    status: "queued",
    phase: "queued",
    progress: { label: "Queued", percent: 0, details: null },
    options: {
      delegatedBy: "ai.chat",
      parentJobId: "botjob_parent",
      toolName: "invoke_video_analyze"
    }
  }));
  await store.appendLog("botjob_parent", "OPENAI_API_KEY=sk-should-not-leak-1234567890");
  await store.waitForPendingWrite("botjob_parent");
  await store.waitForPendingWrite("botjob_child");

  const progress = [];
  const raw = await executeAiToolCall({
    name: "read_bot_job_log",
    input: {
      jobId: "botjob_parent",
      includeTrace: false,
      includeChildJobs: true
    }
  }, { chat: {}, attachments: [] }, {
    appDataRoot,
    getJob: (jobId) => store.get(jobId),
    emitProgress: async (event) => progress.push(event),
    throwIfCancelled() {}
  });
  const result = JSON.parse(raw);

  assert.equal(result.job.jobId, "botjob_parent");
  assert.equal(result.log.content.includes("sk-should-not-leak"), false);
  assert.match(result.log.content, /OPENAI_API_KEY=\*\*\*/);
  assert.ok(result.lifecycle.count >= 1);
  assert.equal(result.lifecycle.last.status, "running");
  assert.ok(result.lifecycle.phases.includes("running"));
  assert.equal(result.childJobs.length, 1);
  assert.equal(result.childJobs[0].jobId, "botjob_child");
  assert.equal(result.agentTrace, null);
  assert.equal(progress[0].phase, "tool-read-bot-job-log");
});

test("bot job status includes delegated child jobs for an explicit parent job", async () => {
  const appDataRoot = await createTempAppDataRoot();
  const store = new BotJobStore({ rootDir: appDataRoot });
  await store.save(createJob("botjob_parent", {
    status: "running",
    phase: "textTools",
    audit: {
      permissionsUsed: ["readLibrary", "storage:content:read", "storage:metadata:write"],
      toolCalls: [{
        name: "invoke_video_analyze",
        status: "completed",
        resultSummary: {
          capability: {
            riskLevel: "medium",
            permissions: ["bot:invoke", "storage:metadata:write"]
          },
          jobRefs: [{ jobId: "botjob_child", botId: "video.analyze", status: "running" }]
        },
        inputSummary: {
          identifiers: ["client:Videos/demo.mp4"]
        },
        durationMs: 1250
      }]
    }
  }));
  await store.save(createJob("botjob_child", {
    botId: "video.analyze",
    status: "running",
    phase: "transcribe",
    progress: {
      label: "Whisper transcribing",
      percent: 38,
      details: null
    },
    options: {
      delegatedBy: "ai.chat",
      parentJobId: "botjob_parent",
      toolName: "invoke_video_analyze"
    }
  }));
  await store.waitForPendingWrite("botjob_parent");
  await store.waitForPendingWrite("botjob_child");

  const status = await buildBotJobStatusResult({
    appDataRoot,
    getJob: (jobId) => store.get(jobId)
  }, {
    jobId: "botjob_parent",
    includeLog: true
  });

  assert.equal(status.count, 1);
  assert.equal(status.jobs[0].jobId, "botjob_parent");
  assert.equal(status.jobs[0].childJobCount, 1);
  assert.equal(status.jobs[0].childJobStatusCounts.running, 1);
  assert.equal(status.jobs[0].childJobs[0].jobId, "botjob_child");
  assert.equal(status.jobs[0].childJobs[0].botId, "video.analyze");
  assert.equal(status.jobs[0].childJobs[0].progress.label, "Whisper transcribing");
  assert.equal(status.jobs[0].childJobs[0].tracking.logCommand, "@ai /log botjob_child");
  assert.equal(status.jobs[0].audit.toolCallCount, 1);
  assert.equal(status.jobs[0].audit.recentToolCalls[0].name, "invoke_video_analyze");
  assert.equal(status.jobs[0].audit.recentToolCalls[0].riskLevel, "medium");
  assert.deepEqual(status.jobs[0].audit.recentToolCalls[0].permissions, ["bot:invoke", "storage:metadata:write"]);
  assert.deepEqual(status.jobs[0].audit.recentToolCalls[0].jobRefs[0], { jobId: "botjob_child", botId: "video.analyze", status: "running" });
  assert.ok(status.jobs[0].lifecycle.count >= 1);
  assert.equal(status.jobs[0].lifecycle.last.phase, "textTools");
  assert.ok(status.jobs[0].lifecycle.phases.includes("textTools"));
});

test("agent trace result includes delegated child job summaries by default", async () => {
  const appDataRoot = await createTempAppDataRoot();
  const store = new BotJobStore({ rootDir: appDataRoot });
  const jobId = "botjob_trace_parent";
  await store.save(createJob(jobId, {
    status: "running",
    phase: "textTools"
  }));
  await store.save(createJob("botjob_trace_child", {
    botId: "video.analyze",
    status: "failed",
    phase: "failed",
    progress: { label: "Whisper failed", percent: 12, details: null },
    options: {
      delegatedBy: "ai.chat",
      parentJobId: jobId,
      toolName: "invoke_video_analyze"
    },
    error: {
      message: "WHISPER_MODEL_PATH missing"
    }
  }));
  await store.waitForPendingWrite(jobId);
  await store.waitForPendingWrite("botjob_trace_child");

  const trace = await buildAgentTraceResult({
    appDataRoot,
    getJob: (targetJobId) => store.get(targetJobId)
  }, {
    jobId,
    store
  });

  assert.equal(trace.childJobCount, 1);
  assert.equal(trace.childJobStatusCounts.failed, 1);
  assert.equal(trace.childJobs[0].jobId, "botjob_trace_child");
  assert.equal(trace.childJobs[0].botId, "video.analyze");
  assert.equal(trace.childJobs[0].status, "failed");
  assert.equal(trace.childJobs[0].progress.label, "Whisper failed");
  assert.equal(trace.childJobs[0].tracking.statusCommand, "@ai /job botjob_trace_child");
  assert.match(trace.childJobs[0].error.message, /WHISPER_MODEL_PATH/);
});

test("agent trace result summarizes plan and observation events", async () => {
  const appDataRoot = await createTempAppDataRoot();
  const jobId = "botjob_plan_summary";
  const graphRoot = path.join(appDataRoot, "ai-chat-graph");
  await fs.mkdir(path.join(graphRoot, "traces"), { recursive: true });
  await fs.writeFile(
    path.join(graphRoot, "traces", `${jobId}.jsonl`),
    [
      JSON.stringify({
        kind: "node",
        node: "textPlan",
        agentPhase: "Plan",
        event: "exit",
        status: "completed"
      }),
      JSON.stringify({
        kind: "agent",
        phase: "plan_next_step",
        round: 0,
        status: "tool-requested",
        detail: {
          model: "openai::deepseek-v4-pro",
          fallback: "json-plan",
          maxToolRounds: 4,
          allowMoreToolCalls: true,
          pendingTools: [
            {
              id: "call_search",
              name: "search_library_files",
              fallbackJsonPlan: true,
              reason: "需要先定位 NAS 文件，apiKey=sk-should-not-leak-1234567890"
            }
          ]
        },
        outputPreview: "{\"action\":\"call_tool\"}"
      }),
      JSON.stringify({
        kind: "agent",
        phase: "decide_continue_or_finish",
        round: 0,
        status: "continue",
        detail: {
          decision: "continue",
          planStatus: "tool-requested",
          pendingToolCount: 1,
          pendingTools: [
            {
              name: "search_library_files",
              reason: "继续读取 NAS 文件"
            }
          ],
          maxToolRounds: 4,
          allowMoreToolCalls: true
        },
        outputPreview: "search_library_files"
      }),
      JSON.stringify({
        kind: "agent",
        phase: "observe_result",
        round: 0,
        status: "observed",
        detail: {
          tool: "search_library_files",
          fallback: "json-plan",
          observationLength: 512
        },
        outputPreview: "工具返回 demo.mp4"
      })
    ].join("\n"),
    "utf8"
  );

  const trace = await buildAgentTraceResult({ appDataRoot }, { jobId });

  assert.equal(trace.planSummary.count, 3);
  assert.equal(trace.planSummary.rounds[0].round, 0);
  assert.equal(trace.planSummary.rounds[0].plans[0].fallback, "json-plan");
  assert.equal(trace.planSummary.rounds[0].plans[0].maxToolRounds, 4);
  assert.equal(trace.planSummary.rounds[0].plans[0].allowMoreToolCalls, true);
  assert.equal(trace.planSummary.rounds[0].plans[0].pendingTools[0].name, "search_library_files");
  assert.doesNotMatch(trace.planSummary.rounds[0].plans[0].pendingTools[0].reason, /sk-should-not-leak/);
  assert.equal(trace.planSummary.rounds[0].observations[0].tool, "search_library_files");
  assert.equal(trace.planSummary.rounds[0].observations[0].observationLength, 512);
  assert.equal(trace.planSummary.rounds[0].decisions[0].decision, "continue");
  assert.equal(trace.planSummary.rounds[0].decisions[0].pendingToolCount, 1);
  assert.equal(trace.timeline[0].agentPhase, "Plan");
  assert.equal(trace.timeline[0].label, "textPlan:exit");
  assert.equal(trace.timeline[1].detailSummary.maxToolRounds, 4);
  assert.equal(trace.timeline[1].detailSummary.allowMoreToolCalls, true);
  assert.equal(trace.timeline[1].detailSummary.pendingTools[0].name, "search_library_files");
  assert.equal(trace.timeline[2].detailSummary.decision, "continue");
  assert.equal(trace.timeline[3].detailSummary.tool, "search_library_files");
});

test("agent trace result exposes pending confirmation summary", async () => {
  const appDataRoot = await createTempAppDataRoot();
  const jobId = "botjob_pending_confirmation";
  const graphRoot = path.join(appDataRoot, "ai-chat-graph");
  await fs.mkdir(path.join(graphRoot, "traces"), { recursive: true });
  await fs.writeFile(
    path.join(graphRoot, "traces", `${jobId}.jsonl`),
    `${JSON.stringify({
      kind: "tool",
      jobId,
      tool: "update_file_metadata",
      round: 0,
      status: "completed",
      input: {
        fileIds: ["client:a.md", "client:b.md"],
        addTags: ["reviewed"],
        apiKey: "sk-should-not-leak-1234567890"
      },
      resultSummary: {
        status: "",
        requiresConfirmation: true,
        blocked: true,
        blockedReason: "批量写入 metadata 需要用户确认；本次只返回预览，未写入任何文件。",
        confirmation: {
          required: true,
          operation: "update_file_metadata",
          riskLevel: "medium",
          reason: "批量写入 tags/aiSummary 会修改多个文件的 NAS metadata。",
          impact: {
            targetFileCount: 2,
            changedFields: ["tags"],
            files: [
              { fileId: "client:a.md", path: "a.md", name: "a.md", status: "dry-run" },
              { fileId: "client:b.md", path: "b.md", name: "b.md", status: "dry-run" }
            ]
          },
          recoverability: "metadata 写入会覆盖对应字段。",
          estimatedDuration: "< 1 分钟",
          confirmWith: {
            confirmed: true,
            dryRun: false
          }
        }
      }
    })}\n`,
    "utf8"
  );

  const trace = await buildAgentTraceResult({ appDataRoot }, { jobId });

  assert.equal(trace.pendingConfirmation.tool, "update_file_metadata");
  assert.deepEqual(trace.pendingConfirmation.confirmInput.fileIds, ["client:a.md", "client:b.md"]);
  assert.equal(trace.pendingConfirmation.confirmInput.confirmed, true);
  assert.equal(trace.pendingConfirmation.confirmInput.dryRun, false);
  assert.equal(trace.pendingConfirmation.confirmInput.apiKey, "***");
  assert.equal(trace.pendingConfirmation.confirmation.impact.targetFileCount, 2);
  assert.equal(trace.recoveryHint.mode, "awaiting-confirmation");
  assert.equal(trace.recoveryHint.requiresUserConfirmation, true);
  assert.equal(trace.recoveryHint.tool, "update_file_metadata");
  assert.equal(trace.recoveryHint.riskLevel, "medium");
  assert.equal(trace.recoveryHint.targetFileCount, 2);
  assert.equal(trace.events[0].input.apiKey, "***");
});

test("agent trace result includes direct retry recovery hints for read-only tools", async () => {
  const appDataRoot = await createTempAppDataRoot();
  const jobId = "botjob_recover_readonly";
  const graphRoot = path.join(appDataRoot, "ai-chat-graph");
  await fs.mkdir(path.join(graphRoot, "executions"), { recursive: true });
  await fs.mkdir(path.join(graphRoot, "traces"), { recursive: true });
  await fs.writeFile(
    path.join(graphRoot, "executions", `${jobId}.json`),
    `${JSON.stringify({
      savedAt: "2026-07-02T00:00:00.000Z",
      jobId,
      botId: "ai.chat",
      status: "failed",
      route: "text",
      traceSummary: {
        count: 3,
        nodes: ["prepareInput", "prepareContext", "textTools"],
        lastNode: "textTools",
        lastStatus: "failed",
        lastAt: "2026-07-02T00:00:00.000Z"
      },
      recoveryState: {
        toolRound: 2,
        planningMessages: [{ role: "user", content: "刚才任务怎么样" }],
        pendingToolCalls: [
          {
            id: "call_status",
            name: "get_bot_job_status",
            input: { jobId: "botjob_parent" }
          },
          {
            id: "call_summary",
            name: "read_media_summary",
            input: { fileId: "client:movie.mp4" }
          },
          {
            id: "call_log",
            name: "read_bot_job_log",
            input: { jobId: "botjob_parent" }
          }
        ]
      }
    }, null, 2)}\n`,
    "utf8"
  );

  const trace = await buildAgentTraceResult({ appDataRoot }, { jobId });

  assert.equal(trace.recoveryHint.mode, "text-retry-tools");
  assert.equal(trace.recoveryHint.route, "textTools");
  assert.equal(trace.recoveryHint.canContinueDirectly, true);
  assert.deepEqual(trace.recoveryHint.retryPolicy.retryableToolNames, ["get_bot_job_status", "read_media_summary", "read_bot_job_log"]);
  assert.deepEqual(trace.recoveryHint.retryPolicy.blockedRetryToolNames, []);
  assert.match(trace.recoveryHint.nextAction, /直接重试/);
});

test("agent trace result surfaces file access suggested actions from tool traces", async () => {
  const appDataRoot = await createTempAppDataRoot();
  const jobId = "botjob_file_access_actions";
  const graphRoot = path.join(appDataRoot, "ai-chat-graph");
  await fs.mkdir(path.join(graphRoot, "executions"), { recursive: true });
  await fs.mkdir(path.join(graphRoot, "traces"), { recursive: true });
  await fs.writeFile(
    path.join(graphRoot, "executions", `${jobId}.json`),
    `${JSON.stringify({
      savedAt: "2026-07-02T00:00:00.000Z",
      jobId,
      botId: "ai.chat",
      status: "failed",
      route: "text",
      traceSummary: {
        count: 3,
        nodes: ["prepareInput", "prepareContext", "textAnswer"],
        lastNode: "textAnswer",
        lastStatus: "failed",
        lastAt: "2026-07-02T00:00:00.000Z"
      }
    }, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(graphRoot, "traces", `${jobId}.jsonl`),
    `${JSON.stringify({
      sequence: 1,
      at: "2026-07-02T00:00:00.000Z",
      kind: "tool",
      tool: "diagnose_file_access",
      round: 0,
      status: "succeeded",
      resultSummary: {
        capability: {
          id: "diagnose_file_access",
          kind: "tool",
          riskLevel: "low",
          executionMode: "sync",
          capabilities: ["file-access", "file-diagnostics"],
          permissions: ["storage:metadata:read", "storage:content:read"],
          output: {
            required: ["found", "layers", "actionPlan"],
            fields: ["found", "contentAccess", "layers", "blockers", "actionPlan", "nextActions"]
          }
        },
        fileAccess: {
          found: true,
          contentAccess: { analyzeMode: "media" },
          layers: [{ id: "metadata", available: true }],
          actionPlan: [
            {
              id: "read-media-summary",
              tool: "read_media_summary",
              input: {
                fileId: "client:movie.mp4",
                includeSummary: true,
                includeProbe: true
              },
              contentLayer: "derived-media",
              riskLevel: "low",
              reason: "已有派生信息，先读取媒体摘要。"
            },
            {
              id: "write-metadata-if-requested",
              tool: "update_file_metadata",
              contentLayer: "write-metadata",
              riskLevel: "medium",
              requiresConfirmation: true,
              reason: "只有用户要求写标签时才执行。"
            },
            {
              id: "repair-analysis-dependencies",
              tool: "diagnose_file_access",
              blocked: true,
              blockerIds: ["dependency-whisper"],
              reason: "Whisper 未就绪。"
            }
          ],
          nextActions: ["调用 read_media_summary 读取已有摘要。"]
        }
      }
    })}\n`,
    "utf8"
  );

  const trace = await buildAgentTraceResult({ appDataRoot }, { jobId });

  assert.equal(trace.recoveryHint.mode, "answer-rebuild");
  assert.equal(trace.recoveryHint.suggestedAction.tool, "read_media_summary");
  assert.equal(trace.recoveryHint.suggestedAction.input.fileId, "client:movie.mp4");
  assert.deepEqual(trace.recoveryHint.suggestedActions.map((action) => action.tool), ["read_media_summary", "update_file_metadata"]);
  assert.equal(trace.recoveryHint.suggestedActions[1].requiresConfirmation, true);
  assert.match(trace.recoveryHint.suggestedNextAction, /read_media_summary/);
  assert.equal(trace.timeline[0].resultSummary.capability.id, "diagnose_file_access");
  assert.equal(trace.timeline[0].resultSummary.capability.riskLevel, "low");
  assert.ok(trace.timeline[0].resultSummary.capability.permissions.includes("storage:content:read"));
  assert.deepEqual(trace.timeline[0].resultSummary.capability.output.required, ["found", "layers", "actionPlan"]);
  assert.equal(trace.timeline[0].resultSummary.fileAccess.actionPlan[0].tool, "read_media_summary");
  assert.equal(trace.timeline[0].resultSummary.fileAccess.actionPlan[0].input.fileId, "client:movie.mp4");
  assert.equal(trace.timeline[0].resultSummary.fileAccess.actionPlan[2].blocked, true);
});

test("agent trace timeline preserves failed tool capability metadata", async () => {
  const appDataRoot = await createTempAppDataRoot();
  const jobId = "botjob_failed_capability";
  const graphRoot = path.join(appDataRoot, "ai-chat-graph");
  await fs.mkdir(path.join(graphRoot, "executions"), { recursive: true });
  await fs.mkdir(path.join(graphRoot, "traces"), { recursive: true });
  await fs.writeFile(
    path.join(graphRoot, "executions", `${jobId}.json`),
    `${JSON.stringify({
      savedAt: "2026-07-02T00:00:00.000Z",
      jobId,
      botId: "ai.chat",
      status: "failed",
      route: "text"
    }, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(graphRoot, "traces", `${jobId}.jsonl`),
    `${JSON.stringify({
      sequence: 1,
      at: "2026-07-02T00:00:00.000Z",
      kind: "tool",
      tool: "invoke_ytdlp_downloader",
      round: 0,
      status: "failed",
      errorSummary: {
        name: "Error",
        message: "download failed: OPENAI_API_KEY=sk-should-not-leak-1234567890",
        capability: {
          id: "invoke_ytdlp_downloader",
          kind: "tool",
          riskLevel: "medium",
          executionMode: "async-job",
          capabilities: ["download", "bot-delegation"],
          permissions: ["bot:invoke", "network:download", "storage:file:write"],
          output: {
            required: ["status", "botId", "jobId"],
            fields: ["status", "botId", "jobId", "tracking"]
          }
        }
      }
    })}\n`,
    "utf8"
  );

  const trace = await buildAgentTraceResult({ appDataRoot }, { jobId });

  assert.equal(trace.timeline[0].errorSummary.message.includes("sk-should-not-leak"), false);
  assert.match(trace.timeline[0].errorSummary.message, /OPENAI_API_KEY=\*\*\*/);
  assert.equal(trace.timeline[0].errorSummary.capability.id, "invoke_ytdlp_downloader");
  assert.equal(trace.timeline[0].errorSummary.capability.riskLevel, "medium");
  assert.ok(trace.timeline[0].errorSummary.capability.permissions.includes("storage:file:write"));
  assert.deepEqual(trace.timeline[0].errorSummary.capability.output.required, ["status", "botId", "jobId"]);
});
