import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readAiSessionCheckpoint } from "../../src/bot/langgraph/checkpoints/aiSessionCheckpointer.js";
import { prepareAiChatGraphState } from "../../src/bot/langgraph/nodes/prepareInputNodes.js";
import {
  buildConfirmedToolRecoveryState,
  buildFileAccessSuggestedToolRecoveryState,
  buildSessionRecoveryGuidance,
  isConfirmationPrompt,
  isContinuationPrompt
} from "../../src/bot/langgraph/nodes/recoveryNodes.js";
import { createRecoveryArtifact, createRecoveryCard, createRecoveryReplyText } from "../../src/bot/plugins/ai-chat/recovery.js";
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

async function writeFileAccessSuggestedActionCheckpoint(appDataRoot, sessionId = 1) {
  const graphRoot = path.join(appDataRoot, "ai-chat-graph");
  const jobId = "botjob_file_access_suggestion";
  await fs.mkdir(path.join(graphRoot, "sessions"), { recursive: true });
  await fs.mkdir(path.join(graphRoot, "executions"), { recursive: true });
  await fs.mkdir(path.join(graphRoot, "traces"), { recursive: true });
  await fs.writeFile(path.join(graphRoot, "sessions", `${sessionId}.json`), `${JSON.stringify({
    savedAt: "2026-07-02T00:00:00.000Z",
    sessionId,
    latestExecution: {
      jobId,
      status: "failed",
      route: "text",
      traceCount: 5,
      lastNode: "textAnswer",
      historyPath: "",
      replyPreview: "上次已经诊断过这个视频的可访问层。",
      snapshotPath: path.join(graphRoot, "executions", `${jobId}.json`),
      tracePath: path.join(graphRoot, "traces", `${jobId}.jsonl`)
    }
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(graphRoot, "executions", `${jobId}.json`), `${JSON.stringify({
    savedAt: "2026-07-02T00:00:00.000Z",
    jobId,
    botId: "ai.chat",
    sessionId,
    status: "failed",
    route: "text",
    traceSummary: {
      count: 5,
      kinds: ["node", "tool"],
      nodes: ["prepareInput", "prepareContext", "textAnswer"],
      lastNode: "textAnswer",
      lastStatus: "failed",
      lastAt: "2026-07-02T00:00:00.000Z"
    },
    result: {
      reply: {
        textPreview: "上次已经诊断过这个视频的可访问层。"
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
    sequence: 4,
    at: "2026-07-02T00:00:00.000Z",
    jobId,
    kind: "tool",
    tool: "diagnose_file_access",
    round: 0,
    status: "completed",
    resultSummary: {
      status: "ok",
      fileAccess: {
        found: true,
        contentAccess: { analyzeMode: "media" },
        actionPlan: [
          {
            id: "read-media-summary",
            tool: "read_media_summary",
            input: {
              fileId: "client:Videos/demo.mp4",
              includeSummary: true,
              includeProbe: true
            },
            contentLayer: "derived-media",
            riskLevel: "low",
            reason: "已有摘要或媒体派生信息，先读取 media summary。"
          },
          {
            id: "start-media-analysis",
            tool: "invoke_video_analyze",
            input: {
              fileId: "client:Videos/demo.mp4",
              waitForCompletion: false
            },
            contentLayer: "analysis",
            riskLevel: "medium",
            reason: "没有摘要时启动后台分析任务。"
          },
          {
            id: "repair-analysis-dependencies",
            tool: "diagnose_file_access",
            blocked: true,
            blockerIds: ["dependency-whisper"],
            reason: "Whisper 未就绪。"
          }
        ]
      }
    }
  })}\n`, "utf8");
}

async function writeBlockedFallbackActionCheckpoint(appDataRoot, sessionId = 1) {
  const graphRoot = path.join(appDataRoot, "ai-chat-graph");
  const jobId = "botjob_blocked_fallback_suggestion";
  await fs.mkdir(path.join(graphRoot, "sessions"), { recursive: true });
  await fs.mkdir(path.join(graphRoot, "executions"), { recursive: true });
  await fs.mkdir(path.join(graphRoot, "traces"), { recursive: true });
  await fs.writeFile(path.join(graphRoot, "sessions", `${sessionId}.json`), `${JSON.stringify({
    savedAt: "2026-07-02T00:00:00.000Z",
    sessionId,
    latestExecution: {
      jobId,
      status: "failed",
      route: "text",
      traceCount: 3,
      lastNode: "textTools",
      historyPath: "",
      replyPreview: "视频分析依赖未就绪。",
      snapshotPath: path.join(graphRoot, "executions", `${jobId}.json`),
      tracePath: path.join(graphRoot, "traces", `${jobId}.jsonl`)
    }
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(graphRoot, "executions", `${jobId}.json`), `${JSON.stringify({
    savedAt: "2026-07-02T00:00:00.000Z",
    jobId,
    botId: "ai.chat",
    sessionId,
    status: "failed",
    route: "text",
    traceSummary: {
      count: 3,
      kinds: ["node", "tool"],
      nodes: ["prepareInput", "prepareContext", "textTools"],
      lastNode: "textTools",
      lastStatus: "blocked",
      lastAt: "2026-07-02T00:00:00.000Z"
    },
    result: {
      reply: {
        textPreview: "Whisper 未就绪，已阻止启动视频分析。"
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
    sequence: 2,
    at: "2026-07-02T00:00:00.000Z",
    jobId,
    kind: "tool",
    tool: "invoke_video_analyze",
    round: 0,
    status: "blocked",
    resultSummary: {
      status: "blocked",
      botId: "video.analyze",
      blocker: {
        id: "whisper",
        label: "Whisper",
        status: "warn"
      },
      fallbackActions: [
        {
          tool: "read_media_summary",
          input: {
            fileId: "client:Videos/demo.mp4",
            includeSummary: true,
            includeProbe: true,
            includeTranscriptExcerpt: true,
            maxChars: 4000
          },
          contentLayer: "derived-media",
          riskLevel: "low",
          reason: "先复用已有摘要、字幕和媒体派生信息。"
        },
        {
          tool: "diagnose_file_access",
          input: {
            fileId: "client:Videos/demo.mp4"
          },
          contentLayer: "metadata",
          riskLevel: "low",
          reason: "确认该 NAS 文件当前可读层级。"
        }
      ]
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
    const card = createRecoveryCard(createRecoveryReplyText(guidance), guidance, { id: 1 });
    assert.deepEqual(card.actions, []);

    assert.equal(isConfirmationPrompt("确认，继续执行"), true);
    const recovered = buildConfirmedToolRecoveryState(checkpoint.pendingConfirmation, "确认，继续执行");
    assert.equal(recovered.mode, "confirmed-tool-call");
    assert.equal(recovered.route, "textTools");
    assert.equal(recovered.recoveredPendingToolCalls[0].name, "invoke_video_tag");
    assert.equal(recovered.recoveredPendingToolCalls[0].confirmationAuthorized, true);
    assert.deepEqual(recovered.recoveredPendingToolCalls[0].input, {
      batch: true,
      force: true,
      confirmed: true
    });
    assert.equal(recovered.recoveredPlanningMessages.at(-1).tool_calls[0].function.name, "invoke_video_tag");
  });
});

test("session recovery guidance includes file access suggested actions from trace", async () => {
  await withTempDir(async (appDataRoot) => {
    await writeFileAccessSuggestedActionCheckpoint(appDataRoot, 1);
    const checkpoint = await readAiSessionCheckpoint(appDataRoot, 1);

    assert.deepEqual(checkpoint.fileAccessSuggestedActions.map((action) => action.tool), ["read_media_summary", "invoke_video_analyze"]);
    assert.equal(checkpoint.latestSnapshot.fileAccessSuggestedActions[0].contentLayer, "derived-media");
    assert.deepEqual(checkpoint.fileAccessSuggestedActions[0].input, {
      fileId: "client:Videos/demo.mp4",
      includeSummary: true,
      includeProbe: true
    });

    const guidance = buildSessionRecoveryGuidance(checkpoint);
    assert.equal(guidance.recoveryAction.mode, "answer-rebuild");
    assert.deepEqual(guidance.recoveryAction.fileAccessSuggestedActions.map((action) => action.tool), ["read_media_summary", "invoke_video_analyze"]);
    assert.match(guidance.recoveryAction.suggestedNextStep, /read_media_summary、invoke_video_analyze/);
    assert.match(guidance.strategy, /文件访问诊断建议/);

    const reply = createRecoveryReplyText(guidance);
    assert.equal((reply.match(/文件访问诊断建议/g) || []).length, 1);
    assert.match(reply, /read_media_summary、invoke_video_analyze/);

    const artifact = createRecoveryArtifact(guidance, { id: 1 });
    assert.deepEqual(artifact.fileAccessSuggestedActions.map((action) => action.tool), ["read_media_summary", "invoke_video_analyze"]);
    assert.match(artifact.suggestedNextStep, /read_media_summary/);

    const card = createRecoveryCard(reply, guidance, { id: 1, name: "file access recovery" });
    assert.equal(card.actions.length, 1);
    assert.equal(card.actions[0].type, "invoke-bot");
    assert.equal(card.actions[0].botId, "ai.chat");
    assert.equal(card.actions[0].label, "重试失败步骤");
    assert.equal(card.actions[0].rawText, "#1 继续");
    assert.equal(card.actions[0].parsedArgs.__chatReplyMode, "replace-chat-message");

    assert.equal(isContinuationPrompt("继续"), true);
    assert.equal(isContinuationPrompt("继续刚才的任务"), true);
    const recovered = buildFileAccessSuggestedToolRecoveryState(checkpoint.fileAccessSuggestedActions, "继续");
    assert.equal(recovered.mode, "file-access-retry-tools");
    assert.deepEqual(recovered.recoveredPendingToolCalls.map((item) => item.name), ["read_media_summary"]);
    assert.deepEqual(recovered.recoveredPendingToolCalls[0].input, {
      fileId: "client:Videos/demo.mp4",
      includeSummary: true,
      includeProbe: true
    });
    assert.equal(recovered.recoveredPlanningMessages.at(-1).tool_calls[0].function.name, "read_media_summary");
  });
});

test("session recovery guidance includes blocked tool fallback actions from trace", async () => {
  await withTempDir(async (appDataRoot) => {
    await writeBlockedFallbackActionCheckpoint(appDataRoot, 1);
    const checkpoint = await readAiSessionCheckpoint(appDataRoot, 1);

    assert.deepEqual(checkpoint.fileAccessSuggestedActions.map((action) => action.tool), ["read_media_summary", "diagnose_file_access"]);
    assert.deepEqual(checkpoint.fileAccessSuggestedActions[0].input, {
      fileId: "client:Videos/demo.mp4",
      includeSummary: true,
      includeProbe: true,
      includeTranscriptExcerpt: true,
      maxChars: 4000
    });

    const guidance = buildSessionRecoveryGuidance(checkpoint);
    assert.equal(guidance.recoveryAction.mode, "text-replan");
    assert.deepEqual(guidance.recoveryAction.fileAccessSuggestedActions.map((action) => action.tool), ["read_media_summary", "diagnose_file_access"]);
    assert.match(guidance.recoveryAction.suggestedNextStep, /read_media_summary、diagnose_file_access/);
    assert.match(guidance.strategy, /文件访问诊断建议/);

    const recovered = buildFileAccessSuggestedToolRecoveryState(checkpoint.fileAccessSuggestedActions, "继续");
    assert.equal(recovered.mode, "file-access-retry-tools");
    assert.deepEqual(recovered.recoveredPendingToolCalls.map((item) => item.name), ["read_media_summary", "diagnose_file_access"]);
    assert.deepEqual(recovered.recoveredPendingToolCalls[1].input, {
      fileId: "client:Videos/demo.mp4"
    });
  });
});

test("prepare input routes continuation to safe file access suggested tools", async () => {
  await withTempDir(async (appDataRoot) => {
    const session = await createAiSession(appDataRoot, "file access recovery");
    await writeFileAccessSuggestedActionCheckpoint(appDataRoot, session.id);
    const logs = [];
    const state = await prepareAiChatGraphState({
      context: {
        jobId: "botjob_next_file_access",
        trigger: {
          rawText: `@ai #${session.id} 继续`
        },
        attachments: []
      },
      api: {
        appDataRoot,
        throwIfCancelled: () => {},
        appendLog: async (line) => logs.push(line),
        emitProgress: async () => {},
        listBots: () => []
      },
      hooks: {}
    });

    assert.equal(state.route, "textTools");
    assert.equal(state.pendingToolCalls.length, 1);
    assert.equal(state.pendingToolCalls[0].name, "read_media_summary");
    assert.equal(state.pendingToolCalls[0].input.fileId, "client:Videos/demo.mp4");
    assert.equal(state.prepared.recoveryGuidance.recoveryAction.mode, "file-access-retry-tools");
    assert.match(logs.join("\n"), /recovery scheduling: mode=file-access-retry-tools/);
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

test("textTools recovery directly retries local read-only diagnostic tools", () => {
  const pendingToolCalls = [
    {
      id: "call_status",
      name: "get_bot_job_status",
      input: { jobId: "botjob_parent" }
    },
    {
      id: "call_media",
      name: "read_media_summary",
      input: { fileId: "client:movie.mp4" }
    },
    {
      id: "call_log",
      name: "read_bot_job_log",
      input: { jobId: "botjob_parent" }
    }
  ];
  const guidance = buildSessionRecoveryGuidance({
    latestExecution: {
      jobId: "botjob_recover_reads",
      status: "failed",
      route: "text",
      lastNode: "textTools",
      replyPreview: ""
    },
    latestSnapshot: {
      status: "failed",
      route: "text",
      traceSummary: {
        lastNode: "textTools"
      },
      recoveryState: {
        toolRound: 2,
        planningMessages: [{ role: "user", content: "刚才任务怎么样" }],
        pendingToolCalls
      }
    }
  });

  assert.equal(guidance.recoveryAction.mode, "text-retry-tools");
  assert.equal(guidance.recoveryAction.directRetryAllowed, true);
  assert.deepEqual(guidance.recoveryAction.retryPolicy.retryableToolNames, ["get_bot_job_status", "read_media_summary", "read_bot_job_log"]);
  assert.deepEqual(guidance.recoveryAction.retryPolicy.blockedRetryToolNames, []);
  assert.equal(guidance.recoveryAction.recoveredPendingToolCalls.length, 3);
  assert.equal(guidance.recoveryAction.recoveredToolRound, 2);
});

test("textTools recovery still replans for side-effecting delegated tools", () => {
  const guidance = buildSessionRecoveryGuidance({
    latestExecution: {
      jobId: "botjob_recover_blocked",
      status: "failed",
      route: "text",
      lastNode: "textTools",
      replyPreview: ""
    },
    latestSnapshot: {
      status: "failed",
      route: "text",
      traceSummary: {
        lastNode: "textTools"
      },
      recoveryState: {
        toolRound: 1,
        planningMessages: [{ role: "user", content: "总结这个视频" }],
        pendingToolCalls: [
          {
            id: "call_video",
            name: "invoke_video_analyze",
            input: { fileId: "client:movie.mp4" }
          }
        ]
      }
    }
  });

  assert.equal(guidance.recoveryAction.mode, "text-replan");
  assert.equal(guidance.recoveryAction.directRetryAllowed, false);
  assert.deepEqual(guidance.recoveryAction.retryPolicy.retryableToolNames, []);
  assert.deepEqual(guidance.recoveryAction.retryPolicy.blockedRetryToolNames, ["invoke_video_analyze"]);
  assert.match(guidance.recoveryAction.nextStep, /避免直接重试/);
});
