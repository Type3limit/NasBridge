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
