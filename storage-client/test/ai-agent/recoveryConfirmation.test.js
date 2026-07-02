import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readAiSessionCheckpoint } from "../../src/bot/langgraph/checkpoints/aiSessionCheckpointer.js";
import { prepareAiChatGraphState } from "../../src/bot/langgraph/nodes/prepareInputNodes.js";
import {
  buildConfirmedToolRecoveryState,
  buildSessionRecoveryGuidance,
  isConfirmationPrompt
} from "../../src/bot/langgraph/nodes/recoveryNodes.js";
import { createAiSession } from "../../src/bot/plugins/ai-chat/services/aiSessions.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-confirm-recovery-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writePendingConfirmationCheckpoint(appDataRoot, sessionId = 1) {
  const graphRoot = path.join(appDataRoot, "ai-chat-graph");
  const jobId = "botjob_confirm_preview";
  await fs.mkdir(path.join(graphRoot, "sessions"), { recursive: true });
  await fs.mkdir(path.join(graphRoot, "executions"), { recursive: true });
  await fs.mkdir(path.join(graphRoot, "traces"), { recursive: true });
  await fs.writeFile(path.join(graphRoot, "sessions", `${sessionId}.json`), `${JSON.stringify({
    savedAt: "2026-07-02T00:00:00.000Z",
    sessionId,
    latestExecution: {
      jobId,
      status: "succeeded",
      route: "text",
      traceCount: 4,
      lastNode: "textAnswer",
      historyPath: "",
      replyPreview: "需要确认批量打标签。",
      snapshotPath: path.join(graphRoot, "executions", `${jobId}.json`),
      tracePath: path.join(graphRoot, "traces", `${jobId}.jsonl`)
    }
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(graphRoot, "executions", `${jobId}.json`), `${JSON.stringify({
    savedAt: "2026-07-02T00:00:00.000Z",
    jobId,
    botId: "ai.chat",
    sessionId,
    status: "succeeded",
    route: "text",
    traceSummary: {
      count: 4,
      kinds: ["node"],
      nodes: ["prepareInput", "prepareContext", "textPlan", "textAnswer"],
      lastNode: "textAnswer",
      lastStatus: "completed",
      lastAt: "2026-07-02T00:00:00.000Z"
    },
    result: {
      reply: {
        textPreview: "批量打标签会影响 2 个文件，请确认。"
      }
    },
    recoveryState: {
      toolRound: 1,
      pendingToolNames: [],
      planningMessages: [],
      pendingToolCalls: []
    }
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(graphRoot, "traces", `${jobId}.jsonl`), `${JSON.stringify({
    sequence: 3,
    at: "2026-07-02T00:00:00.000Z",
    jobId,
    kind: "tool",
    tool: "invoke_video_tag",
    round: 0,
    status: "completed",
    input: {
      batch: true,
      force: true
    },
    outputPreview: "{\"status\":\"confirmation_required\"}",
    resultSummary: {
      status: "confirmation_required",
      delegated: false,
      botId: "video.tag",
      requiresConfirmation: true,
      blocked: true,
      blockedReason: "批量视频打标签会写入多个文件的 metadata；本次只返回影响范围预览，未创建子任务。",
      confirmation: {
        required: true,
        operation: "invoke_video_tag",
        riskLevel: "medium",
        reason: "批量视频打标签会为多个视频/音频文件生成并写入 metadata tags。",
        impact: {
          targetFileCount: 2,
          changedFields: ["tags"],
          files: [
            { fileId: "client:a.mp4", path: "a.mp4", name: "a.mp4", mimeType: "video/mp4" },
            { fileId: "client:b.mp4", path: "b.mp4", name: "b.mp4", mimeType: "video/mp4" }
          ]
        },
        recoverability: "标签写入后可再次用 update_file_metadata 调整。",
        estimatedDuration: "< 1 分钟",
        confirmWith: {
          confirmed: true,
          batch: true
        }
      }
    }
  })}\n`, "utf8");
}

test("session checkpoint exposes pending confirmation from tool trace", async () => {
  await withTempDir(async (appDataRoot) => {
    await writePendingConfirmationCheckpoint(appDataRoot, 1);
    const checkpoint = await readAiSessionCheckpoint(appDataRoot, 1);
    assert.equal(checkpoint.pendingConfirmation.tool, "invoke_video_tag");
    assert.equal(checkpoint.pendingConfirmation.input.force, true);
    assert.equal(checkpoint.pendingConfirmation.confirmInput.confirmed, true);
    assert.equal(checkpoint.pendingConfirmation.confirmInput.batch, true);
    assert.equal(checkpoint.pendingConfirmation.confirmation.impact.targetFileCount, 2);

    const guidance = buildSessionRecoveryGuidance(checkpoint);
    assert.equal(guidance.recoveryAction.mode, "awaiting-confirmation");
    assert.equal(guidance.recoveryAction.pendingConfirmation.tool, "invoke_video_tag");
    assert.match(guidance.strategy, /等待用户确认|明确确认/);

    assert.equal(isConfirmationPrompt("确认，继续执行"), true);
    const recovered = buildConfirmedToolRecoveryState(checkpoint.pendingConfirmation, "确认，继续执行");
    assert.equal(recovered.mode, "confirmed-tool-call");
    assert.equal(recovered.route, "textTools");
    assert.equal(recovered.recoveredPendingToolCalls[0].name, "invoke_video_tag");
    assert.deepEqual(recovered.recoveredPendingToolCalls[0].input, {
      batch: true,
      force: true,
      confirmed: true
    });
    assert.equal(recovered.recoveredPlanningMessages.at(-1).tool_calls[0].function.name, "invoke_video_tag");
  });
});

test("prepare input routes explicit session confirmation to textTools", async () => {
  await withTempDir(async (appDataRoot) => {
    const session = await createAiSession(appDataRoot, "confirm flow");
    await writePendingConfirmationCheckpoint(appDataRoot, session.id);
    const logs = [];
    const progress = [];
    const state = await prepareAiChatGraphState({
      context: {
        jobId: "botjob_next",
        trigger: {
          rawText: `@ai #${session.id} 确认`
        },
        attachments: []
      },
      api: {
        appDataRoot,
        throwIfCancelled: () => {},
        appendLog: async (line) => logs.push(line),
        emitProgress: async (event) => progress.push(event),
        listBots: () => []
      },
      hooks: {}
    });

    assert.equal(state.route, "textTools");
    assert.equal(state.pendingToolCalls.length, 1);
    assert.equal(state.pendingToolCalls[0].name, "invoke_video_tag");
    assert.equal(state.pendingToolCalls[0].input.confirmed, true);
    assert.equal(state.pendingToolCalls[0].input.force, true);
    assert.equal(state.prepared.recoveryGuidance.recoveryAction.mode, "confirmed-tool-call");
    assert.match(logs.join("\n"), /recovery scheduling: mode=confirmed-tool-call/);
  });
});
