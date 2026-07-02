import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BotJobStore } from "../../src/bot/jobStore.js";
import { buildAgentTraceResult, buildBotJobLogBundle } from "../../src/bot/tools/botJobStatus.js";

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
    audit: {
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
  const traceDir = path.join(appDataRoot, "ai-chat-graph", "traces");
  await fs.mkdir(traceDir, { recursive: true });
  await fs.writeFile(
    path.join(traceDir, "botjob_parent.jsonl"),
    `${JSON.stringify({
      kind: "tool",
      tool: "invoke_video_analyze",
      status: "succeeded",
      input: { apiKey: "sk-should-not-leak-1234567890", fileId: "file_1" },
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
        ]
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
  assert.equal(bundle.childJobs.length, 1);
  assert.equal(bundle.childJobs[0].jobId, "botjob_child");
  assert.equal(bundle.childJobs[0].botId, "video.analyze");
  assert.equal(bundle.agentTrace.events.length, 1);
  assert.equal(bundle.agentTrace.events[0].input.apiKey, "***");
  assert.equal(bundle.agentTrace.events[0].input.fileId, "file_1");
  assert.equal(bundle.agentTrace.events[0].resultSummary.jobId, "botjob_child");
  assert.equal(bundle.agentTrace.events[0].resultSummary.jobRefs[0].botId, "video.analyze");
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
  assert.equal(trace.events[0].input.apiKey, "***");
});
