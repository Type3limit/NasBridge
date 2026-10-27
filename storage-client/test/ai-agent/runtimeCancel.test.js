import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createBotRuntime } from "../../src/bot/runtime.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-runtime-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("job cancelled"), { name: "AbortError" }));
      return;
    }
    signal?.addEventListener("abort", () => {
      reject(Object.assign(new Error("job cancelled"), { name: "AbortError" }));
    }, { once: true });
  });
}

async function waitForJob(runtime, predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = [...runtime.activeJobs.values()].find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for job");
}

async function waitForJobLog(runtime, jobId, predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await runtime.store.waitForPendingLog(jobId);
    const log = await runtime.getJobLog(jobId);
    if (predicate(log.content || "")) {
      return log.content;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for job log");
}

test("cancelJob cascades cancellation to child bot jobs", async () => {
  await withTempDir(async (root) => {
    const plugins = {
      parent: {
        botId: "parent",
        displayName: "Parent",
        description: "Parent bot",
        inputSchema: { type: "object", properties: {} },
        permissions: {},
        execute: async (context, api) => {
          await api.invokeBot({
            botId: "child",
            trigger: { type: "manual", rawText: "child" },
            options: { parentJobId: api.jobId }
          });
          await waitForAbort(api.signal);
        }
      },
      child: {
        botId: "child",
        displayName: "Child",
        description: "Child bot",
        inputSchema: { type: "object", properties: {} },
        permissions: {},
        execute: async (context, api) => {
          await waitForAbort(api.signal);
        }
      }
    };
    const registry = {
      resolve: (botId) => plugins[botId] || null,
      toPublicCatalog: () => Object.values(plugins).map((plugin) => ({
        botId: plugin.botId,
        displayName: plugin.displayName,
        description: plugin.description,
        inputSchema: plugin.inputSchema,
        capabilities: []
      }))
    };
    const runtime = await createBotRuntime({
      clientId: "client",
      storageRoot: root,
      appDataRoot: path.join(root, ".nas-bot"),
      registry,
      concurrency: 2
    }).init();

    const parent = await runtime.invoke({
      botId: "parent",
      chat: { hostClientId: "client", dayKey: "2026-07-02", historyPath: ".nas-chat-room/history/2026-07-02.jsonl" },
      requester: { userId: "user", displayName: "User", role: "user" }
    });
    const child = await waitForJob(runtime, (job) => job.botId === "child" && job.options?.parentJobId === parent.jobId);

    await runtime.cancelJob(parent.jobId);

    const parentAfter = await runtime.getJob(parent.jobId);
    const childAfter = await runtime.getJob(child.jobId);
    assert.equal(parentAfter.status, "cancelled");
    assert.equal(childAfter.status, "cancelled");
  });
});

test("runtime persists tool audit events without leaking local paths or secrets", async () => {
  await withTempDir(async (root) => {
    const plugins = {
      auditor: {
        botId: "auditor",
        displayName: "Auditor",
        description: "Audit bot",
        inputSchema: { type: "object", properties: {} },
        permissions: { readLibrary: true, writeLibrary: true, llm: true },
        execute: async (context, api) => {
          await api.recordAuditEvent({
            name: "update_file_metadata",
            status: "completed",
            round: 0,
            startedAt: "2026-07-03T00:00:00.000Z",
            finishedAt: "2026-07-03T00:00:00.050Z",
            durationMs: 50,
            inputSummary: {
              tool: "update_file_metadata",
              identifiers: ["client:Docs/a.txt"],
              apiKey: "sk-should-redact-123456789012"
            },
            resultSummary: {
              capability: {
                id: "update_file_metadata",
                riskLevel: "medium",
                permissions: ["storage:metadata:write"]
              },
              file: {
                path: "D:\\NAS\\Docs\\a.txt"
              },
              token: "should-redact"
            }
          });
          return { artifacts: [{ type: "text", title: "done" }] };
        }
      }
    };
    const registry = {
      resolve: (botId) => plugins[botId] || null,
      toPublicCatalog: () => Object.values(plugins).map((plugin) => ({
        botId: plugin.botId,
        displayName: plugin.displayName,
        description: plugin.description,
        inputSchema: plugin.inputSchema,
        capabilities: []
      }))
    };
    const runtime = await createBotRuntime({
      clientId: "client",
      storageRoot: root,
      appDataRoot: path.join(root, ".nas-bot"),
      registry,
      concurrency: 1
    }).init();

    const job = await runtime.invoke({
      botId: "auditor",
      chat: { hostClientId: "client", dayKey: "2026-07-03", historyPath: ".nas-chat-room/history/2026-07-03.jsonl" },
      requester: { userId: "user", displayName: "User", role: "user" }
    });
    const completed = await waitForJob(runtime, (item) => item.jobId === job.jobId && item.status === "succeeded");

    assert.ok(completed.audit.permissionsUsed.includes("readLibrary"));
    assert.ok(completed.audit.permissionsUsed.includes("writeLibrary"));
    assert.ok(completed.audit.permissionsUsed.includes("llm"));
    assert.ok(completed.audit.permissionsUsed.includes("storage:metadata:write"));
    assert.equal(completed.audit.toolCalls.length, 1);
    assert.equal(completed.audit.toolCalls[0].name, "update_file_metadata");
    assert.equal(completed.audit.toolCalls[0].riskLevel, "medium");
    assert.deepEqual(completed.audit.toolCalls[0].permissions, ["storage:metadata:write"]);
    assert.equal(completed.audit.toolCalls[0].inputSummary.apiKey, "[redacted]");
    assert.equal(completed.audit.toolCalls[0].resultSummary.token, "[redacted]");
    const auditJson = JSON.stringify(completed.audit);
    assert.doesNotMatch(auditJson, /D:\\NAS/);
    assert.doesNotMatch(auditJson, /sk-should-redact/);
  });
});

test("runtime writes structured lifecycle entries into job logs", async () => {
  await withTempDir(async (root) => {
    const plugins = {
      lifecycle: {
        botId: "lifecycle",
        displayName: "Lifecycle",
        description: "Lifecycle bot",
        inputSchema: { type: "object", properties: {} },
        permissions: {},
        execute: async (context, api) => {
          await api.emitProgress({
            phase: "tool-plan",
            label: "Planning tools",
            percent: 35,
            graphState: {
              activeNode: "textPlan",
              agentPhase: "Plan"
            }
          });
          return { artifacts: [{ type: "text", title: "done" }] };
        }
      }
    };
    const registry = {
      resolve: (botId) => plugins[botId] || null,
      toPublicCatalog: () => Object.values(plugins).map((plugin) => ({
        botId: plugin.botId,
        displayName: plugin.displayName,
        description: plugin.description,
        inputSchema: plugin.inputSchema,
        capabilities: []
      }))
    };
    const runtime = await createBotRuntime({
      clientId: "client",
      storageRoot: root,
      appDataRoot: path.join(root, ".nas-bot"),
      registry,
      concurrency: 1
    }).init();

    const job = await runtime.invoke({
      botId: "lifecycle",
      trigger: { type: "manual", rawText: "OPENAI_API_KEY=sk-should-not-leak-1234567890" },
      chat: { hostClientId: "client", dayKey: "2026-07-03", historyPath: ".nas-chat-room/history/2026-07-03.jsonl" },
      requester: { userId: "user", displayName: "User", role: "user" }
    });
    await waitForJob(runtime, (item) => item.jobId === job.jobId && item.status === "succeeded");

    const log = await waitForJobLog(runtime, job.jobId, (content) => content.includes('"status":"succeeded"'));
    assert.match(log, /job-lifecycle .*"status":"queued"/);
    assert.match(log, /job-lifecycle .*"status":"running"/);
    assert.match(log, /job-lifecycle .*"phase":"tool-plan"/);
    assert.match(log, /job-lifecycle .*"agentPhase":"Plan"/);
    assert.match(log, /job-lifecycle .*"status":"succeeded"/);
    assert.doesNotMatch(log, /sk-should-not-leak/);
  });
});

function createSingleBotRuntime(root, plugin) {
  const registry = {
    resolve: (botId) => (botId === plugin.botId ? plugin : null),
    toPublicCatalog: () => [{
      botId: plugin.botId,
      displayName: plugin.displayName,
      description: plugin.description,
      inputSchema: plugin.inputSchema,
      capabilities: []
    }]
  };
  return createBotRuntime({
    clientId: "client",
    storageRoot: root,
    appDataRoot: path.join(root, ".nas-bot"),
    registry,
    concurrency: 1
  }).init();
}

const testChat = { hostClientId: "client", dayKey: "2026-07-03", historyPath: ".nas-chat-room/history/2026-07-03.jsonl" };
const testRequester = { userId: "user", displayName: "User", role: "user" };

test("a cancelled job stays cancelled when the plugin finishes anyway", async () => {
  await withTempDir(async (root) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const runtime = await createSingleBotRuntime(root, {
      botId: "stubborn",
      displayName: "Stubborn",
      description: "Ignores the abort signal",
      inputSchema: { type: "object", properties: {} },
      permissions: {},
      execute: async () => {
        await gate;
        return { importedFiles: [{ relativePath: "late.mp4" }], artifacts: [] };
      }
    });

    const job = await runtime.invoke({ botId: "stubborn", chat: testChat, requester: testRequester });
    await waitForJob(runtime, (item) => item.jobId === job.jobId && item.status === "running");
    await runtime.cancelJob(job.jobId);
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const after = await runtime.getJob(job.jobId);
    assert.equal(after.status, "cancelled");
    assert.equal(after.phase, "cancelled");
    assert.deepEqual(after.result.importedFiles.map((file) => file.relativePath), ["late.mp4"]);
  });
});

test("a job that only asks the user to choose ends in the awaiting-input phase", async () => {
  await withTempDir(async (root) => {
    const runtime = await createSingleBotRuntime(root, {
      botId: "picker",
      displayName: "Picker",
      description: "Replies with a selection card",
      inputSchema: { type: "object", properties: {} },
      permissions: {},
      execute: async () => ({ importedFiles: [], artifacts: [], awaitingInput: { reason: "selection", label: "等待选择画质" } })
    });

    const job = await runtime.invoke({ botId: "picker", chat: testChat, requester: testRequester });
    const done = await waitForJob(runtime, (item) => item.jobId === job.jobId && item.status === "succeeded");

    assert.equal(done.phase, "awaiting-input");
    assert.equal(done.progress.label, "等待选择画质");
    assert.deepEqual(done.result.awaitingInput, { reason: "selection", label: "等待选择画质" });
  });
});

test("a normal job still ends in the completed phase", async () => {
  await withTempDir(async (root) => {
    const runtime = await createSingleBotRuntime(root, {
      botId: "plain",
      displayName: "Plain",
      description: "Finishes normally",
      inputSchema: { type: "object", properties: {} },
      permissions: {},
      execute: async () => ({ importedFiles: [{ relativePath: "a.mp4" }], artifacts: [] })
    });

    const job = await runtime.invoke({ botId: "plain", chat: testChat, requester: testRequester });
    const done = await waitForJob(runtime, (item) => item.jobId === job.jobId && item.status === "succeeded");

    assert.equal(done.phase, "completed");
    assert.equal(done.progress.label, "Completed");
    assert.equal(done.result.awaitingInput, undefined);
  });
});
