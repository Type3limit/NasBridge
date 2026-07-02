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

async function writeRecoverableAgentTraceFixture(appDataRoot, {
  jobId = "botjob_recover",
  sessionId = 7,
  toolName = "read_media_summary"
} = {}) {
  const graphRoot = path.join(appDataRoot, "ai-chat-graph");
  await fs.mkdir(path.join(graphRoot, "executions"), { recursive: true });
  await fs.mkdir(path.join(graphRoot, "traces"), { recursive: true });
  await fs.writeFile(path.join(graphRoot, "executions", `${jobId}.json`), JSON.stringify({
    jobId,
    botId: "ai.chat",
    sessionId,
    status: "failed",
    route: "textTools",
    savedAt: "2026-07-02T08:30:00.000Z",
    traceSummary: {
      count: 2,
      lastNode: "textTools",
      lastStatus: "failed"
    },
    result: {},
    recoveryState: {
      toolRound: 2,
      pendingToolNames: [toolName],
      pendingToolCalls: [{
        id: "call_retry_tool",
        name: toolName,
        input: {
          fileId: "client:movie.mp4",
          includeSummary: true
        }
      }],
      planningMessages: [{
        role: "user",
        content: "总结这个视频"
      }]
    }
  }), "utf8");
  await fs.writeFile(path.join(graphRoot, "traces", `${jobId}.jsonl`), `${JSON.stringify({
    kind: "agent",
    phase: "plan_next_step",
    round: 1,
    status: "tool-requested",
    detail: {
      model: "openai::deepseek-v4-pro",
      pendingTools: [{ id: "call_retry_tool", name: toolName, reason: "读取已有媒体摘要" }]
    },
    outputPreview: `call ${toolName}`
  })}\n`, "utf8");
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
        lastNode: "textTools",
        lastAgentPhase: "ToolExecute/Observe"
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
          step: 2,
          status: "tool-requested",
          model: "openai::deepseek-v4-pro",
          fallback: "json-plan",
          maxToolRounds: 4,
          allowMoreToolCalls: true,
          pendingTools: [{
            name: "invoke_video_analyze",
            reason: "需要生成视频摘要"
          }]
        }],
        observations: [{
          step: 4,
          status: "observed",
          tool: "invoke_video_analyze",
          observationLength: 256
        }],
        decisions: [{
          step: 3,
          status: "continue",
          decision: "continue",
          planStatus: "tool-requested",
          pendingToolCount: 1,
          pendingTools: [{ name: "invoke_video_analyze" }]
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
        steps: [1],
        lastStep: 1,
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
      agentPhase: "ToolExecute/Observe",
      durationMs: 1250,
      inputSummary: { tool: "invoke_video_analyze", fileId: "client:movie.mp4" },
      resultSummary: {
        jobRefs: [{ botId: "video.analyze", jobId: "botjob_child" }],
        capability: {
          id: "invoke_video_analyze",
          riskLevel: "medium",
          executionMode: "async-job",
          capabilities: ["media-analysis", "bot-delegation"],
          permissions: ["bot:invoke", "ai:model:invoke", "storage:content:read", "storage:metadata:write"],
          output: {
            required: ["status", "botId", "jobId"],
            fields: ["status", "phase", "botId", "jobId", "tracking"]
          }
        },
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
        fallbackActions: [
          { tool: "read_media_summary" },
          { tool: "diagnose_file_access" }
        ],
        repairCommands: ["@ai /health", "@ai /tools"],
        agentTrace: {
          eventCount: 4,
          childJobCount: 1
        },
        nextAction: "查看 @ai /log botjob_parent"
      }
    }]
  });

  assert.match(body, /Agent job: botjob_parent/);
  assert.match(body, /最后阶段: ToolExecute\/Observe/);
  assert.match(body, /恢复建议/);
  assert.match(body, /suggested tools: read_media_summary, invoke_video_analyze/);
  assert.match(body, /suggested reason: 已有媒体派生信息可读取。/);
  assert.match(body, /Agent 计划/);
  assert.match(body, /plan: step=2 · tool-requested/);
  assert.match(body, /limit=4/);
  assert.match(body, /toolsAllowed=yes/);
  assert.match(body, /tools=invoke_video_analyze/);
  assert.match(body, /decide: step=3 · continue · decision=continue · plan=tool-requested · pending=1 · tools=invoke_video_analyze/);
  assert.match(body, /子任务: failed 1/);
  assert.match(body, /video\.analyze · botjob_child · failed/);
  assert.match(body, /命令：@ai \/job botjob_child · @ai \/log botjob_child · @ai \/trace botjob_child/);
  assert.match(body, /invoke_video_analyze: 1 次/);
  assert.match(body, /steps 1/);
  assert.match(body, /video\.analyze:botjob_child/);
  assert.match(body, /最近步骤/);
  assert.match(body, /phase=ToolExecute\/Observe/);
  assert.match(body, /capability: id=invoke_video_analyze · risk=medium · mode=async-job · perms=bot:invoke,ai:model:invoke,storage:content:read,storage:metadata:write · caps=media-analysis,bot-delegation · returns=status,botId,jobId/);
  assert.match(body, /access: found=true · mode=media · layers=metadata · blockers=dependency-whisper · actions=read_file_metadata,invoke_video_analyze/);
  assert.match(body, /log: job=botjob_parent · chars=2048 · truncated/);
  assert.match(body, /trace: events=4 · childJobs=1/);
  assert.match(body, /fallback: read_media_summary,diagnose_file_access/);
  assert.match(body, /repair: @ai \/health, @ai \/tools/);
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
      audit: {
        permissionsUsed: ["readLibrary", "storage:metadata:write"],
        toolCallCount: 1,
        recentToolCalls: [{
          name: "update_file_metadata",
          status: "completed",
          riskLevel: "medium",
          permissions: ["storage:metadata:write"],
          identifiers: ["client:Docs/a.txt"]
        }]
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
  assert.match(body, /审计：工具调用 1 · 权限 readLibrary、storage:metadata:write/);
  assert.match(body, /update_file_metadata · completed · risk=medium · ids=client:Docs\/a\.txt · perm=storage:metadata:write/);
  assert.match(body, /子任务：1 · failed 1/);
  assert.match(body, /video\.analyze · botjob_child · failed/);
  assert.match(body, /命令：@ai \/job botjob_child · @ai \/log botjob_child · @ai \/trace botjob_child/);
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
      progress: { label: "Failed", percent: 99 },
      audit: {
        permissionsUsed: ["readLibrary", "bot:invoke", "storage:content:read"],
        toolCallCount: 2,
        recentToolCalls: [{
          name: "invoke_video_analyze",
          status: "blocked",
          riskLevel: "medium",
          permissions: ["bot:invoke", "storage:content:read"],
          identifiers: ["client:Videos/demo.mp4"],
          jobRefs: [{ jobId: "botjob_child", botId: "video.analyze" }]
        }]
      }
    },
    log: {
      jobId: "botjob_parent",
      content: "[2026-07-02T00:00:00.000Z] OPENAI_API_KEY=***\n[2026-07-02T00:00:01.000Z] failed\n",
      truncated: false
    },
    lifecycle: {
      count: 3,
      last: {
        status: "failed",
        phase: "failed",
        label: "Failed",
        percent: 99,
        agentPhase: "ToolExecute/Observe"
      },
      phases: ["parse-input", "running", "failed"],
      agentPhases: ["PrepareInput", "ToolExecute/Observe"],
      statuses: ["queued", "running", "failed"],
      events: []
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
  assert.match(body, /审计：工具调用 2 · 权限 readLibrary、bot:invoke、storage:content:read/);
  assert.match(body, /invoke_video_analyze · blocked · risk=medium · ids=client:Videos\/demo\.mp4 · perm=bot:invoke, storage:content:read · jobs=video\.analyze:botjob_child/);
  assert.match(body, /生命周期：events=3 · last=failed\/failed · 99%/);
  assert.match(body, /阶段链：parse-input -> running -> failed/);
  assert.match(body, /Agent 阶段：PrepareInput -> ToolExecute\/Observe/);
  assert.match(body, /video\.analyze · botjob_child · failed/);
  assert.match(body, /命令：@ai \/job botjob_child · @ai \/log botjob_child · @ai \/trace botjob_child/);
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
              filter: "all",
              refresh: true
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
      assert.equal(result.result.artifacts[0].refreshed, true);
      assert.equal(replies[0].card.title, "AI 模型列表已刷新");
      assert.match(replies[0].card.subtitle, /刷新/);
      assert.match(replies[0].text, /已刷新模型列表/);
      assert.equal(replies[0].card.status, "succeeded");
    });
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test("model command rejects non-vision models for vision defaults", async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-model-vision-command-"));
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
            capabilities: { supports: { tool_calls: false } }
          },
          {
            id: "gpt-4.1-2025-04-14",
            name: "GPT 4.1",
            capabilities: { supports: { tool_calls: true, vision: true } }
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
      const api = {
        appDataRoot,
        signal: null,
        throwIfCancelled() {},
        async publishChatReply(payload) {
          return {
            id: "reply_model_settings",
            text: payload.text,
            card: payload.card
          };
        }
      };
      const modelSettings = {
        textModel: "openai::deepseek-v4-pro",
        multimodalModel: "",
        lastListedModels: [
          {
            id: "openai::deepseek-v4-pro",
            modelId: "deepseek-v4-pro",
            provider: "openai",
            name: "DeepSeek V4 Pro",
            toolCalls: false,
            vision: false
          },
          {
            id: "openai::gpt-4.1-2025-04-14",
            modelId: "gpt-4.1-2025-04-14",
            provider: "openai",
            name: "GPT 4.1",
            toolCalls: true,
            vision: true
          }
        ]
      };

      await assert.rejects(
        () => handleAiChatCommandRoute({
          prepared: {
            api,
            modelDirective: {
              command: {
                type: "set-vision",
                model: "DeepSeek V4 Pro"
              }
            },
            modelSettings
          }
        }),
        /无法设置看图模型：openai::deepseek-v4-pro 未声明 vision 能力/
      );

      await assert.rejects(
        () => handleAiChatCommandRoute({
          prepared: {
            api,
            modelDirective: {
              command: {
                type: "set-all",
                model: "DeepSeek V4 Pro"
              }
            },
            modelSettings
          }
        }),
        /无法设置文本和看图模型：openai::deepseek-v4-pro 未声明 vision 能力/
      );

      await handleAiChatCommandRoute({
        prepared: {
          api,
          modelDirective: {
            command: {
              type: "set-vision",
              model: "GPT 4.1"
            }
          },
          modelSettings
        }
      });
      const settings = await readAiModelSettings(appDataRoot);
      assert.equal(settings.textModel, "openai::deepseek-v4-pro");
      assert.equal(settings.multimodalModel, "openai::gpt-4.1-2025-04-14");
    });
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test("health command route publishes status badges", async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-health-command-"));
  const storageRoot = path.join(appDataRoot, "storage");
  const originalFetch = globalThis.fetch;
  try {
    await fs.mkdir(storageRoot, { recursive: true });
    globalThis.fetch = async (url) => {
      const text = String(url || "");
      if (text.includes("/models")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({
            data: [{
              id: "deepseek-v4-pro",
              name: "DeepSeek V4 Pro",
              capabilities: { supports: { tool_calls: false } }
            }]
          }),
          json: async () => ({})
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "{}",
        json: async () => ({ sources: ["qq"] })
      };
    };

    await withEnv({
      AI_PROVIDER: "openai",
      OPENAI_BASE_URL: "https://example.invalid/v1",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "deepseek-v4-pro",
      MUSIC_LIB_BRIDGE_URL: "http://music.invalid"
    }, async () => {
      const replies = [];
      const api = {
        appDataRoot,
        storageRoot,
        signal: null,
        throwIfCancelled() {},
        async publishChatReply(payload) {
          replies.push(payload);
          return {
            id: "reply_health",
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
              type: "health"
            }
          },
          modelSettings: {
            textModel: "openai::deepseek-v4-pro",
            lastListedModels: []
          }
        }
      });

      assert.equal(replies[0].card.title, "AI Agent 健康检查");
      assert.ok(Array.isArray(replies[0].card.badges));
      assert.ok(replies[0].card.badges.length > 0);
      assert.ok(replies[0].card.badges.some((badge) => /^错误|^警告|^可用|^未知/.test(badge.label)));
      assert.equal(result.result.artifacts[0].type, "agent-health");
    });
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test("tools command route publishes structured capability artifact", async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-tools-command-"));
  const storageRoot = path.join(appDataRoot, "storage");
  const originalFetch = globalThis.fetch;
  try {
    await fs.mkdir(storageRoot, { recursive: true });
    globalThis.fetch = async (url) => {
      const text = String(url || "");
      if (text.includes("/models")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({
            data: [{
              id: "deepseek-v4-pro",
              name: "DeepSeek V4 Pro",
              capabilities: { supports: { tool_calls: false } }
            }]
          }),
          json: async () => ({})
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "{}",
        json: async () => ({ sources: ["qq"] })
      };
    };

    await withEnv({
      AI_PROVIDER: "openai",
      OPENAI_BASE_URL: "https://example.invalid/v1",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "deepseek-v4-pro",
      MUSIC_LIB_BRIDGE_URL: "http://music.invalid",
      BOT_BILIBILI_COOKIE_HEADER: undefined,
      BOT_BILIBILI_COOKIE_FILE: undefined
    }, async () => {
      const replies = [];
      const api = {
        appDataRoot,
        storageRoot,
        signal: null,
        throwIfCancelled() {},
        async publishChatReply(payload) {
          replies.push(payload);
          return {
            id: "reply_tools",
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
              type: "list-tools"
            }
          },
          modelSettings: {
            textModel: "openai::deepseek-v4-pro",
            lastListedModels: []
          }
        }
      });

      const artifact = result.result.artifacts[0];
      assert.equal(replies[0].card.title, "AI Agent 工具列表");
      assert.ok(replies[0].card.badges.some((badge) => /^能力 \d+/.test(badge.label)));
      assert.ok(replies[0].card.badges.some((badge) => /^阻断|^错误|^警告|^可用|^未知/.test(badge.label)));
      assert.equal(artifact.type, "agent-tools");
      assert.equal(artifact.count, artifact.capabilities.length);
      assert.ok(artifact.health);
      assert.ok(Array.isArray(artifact.workflows));
      assert.ok(artifact.workflows.some((workflow) => workflow.id === "media-summary"));
      const videoCapability = artifact.capabilities.find((item) => item.id === "invoke_video_analyze");
      assert.equal(videoCapability.kind, "tool");
      assert.ok(["blocked", "warn", "ok", "error", "unknown"].includes(videoCapability.status));
      assert.equal(typeof videoCapability.readiness.ready, "boolean");
      assert.ok(videoCapability.output.required.includes("status"));
      assert.ok(videoCapability.permissions.includes("bot:invoke"));
      const mediaWorkflow = artifact.workflows.find((workflow) => workflow.id === "media-summary");
      assert.ok(mediaWorkflow.steps.some((step) => step.id === "invoke_video_analyze"));
    });
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test("workflows command route publishes agent task routes with readiness", async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-workflows-command-"));
  const storageRoot = path.join(appDataRoot, "storage");
  const originalFetch = globalThis.fetch;
  try {
    await fs.mkdir(storageRoot, { recursive: true });
    globalThis.fetch = async (url) => {
      const text = String(url || "");
      if (text.includes("/models")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({
            data: [{
              id: "deepseek-v4-pro",
              name: "DeepSeek V4 Pro",
              capabilities: { supports: { tool_calls: false } }
            }]
          }),
          json: async () => ({})
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "{}",
        json: async () => ({ sources: ["qq"] })
      };
    };

    await withEnv({
      AI_PROVIDER: "openai",
      OPENAI_BASE_URL: "https://example.invalid/v1",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "deepseek-v4-pro",
      MUSIC_LIB_BRIDGE_URL: "http://music.invalid",
      BOT_BILIBILI_COOKIE_HEADER: undefined,
      BOT_BILIBILI_COOKIE_FILE: undefined,
      WHISPER_CPP_PATH: undefined,
      WHISPER_MODEL_PATH: undefined
    }, async () => {
      const replies = [];
      const api = {
        appDataRoot,
        storageRoot,
        signal: null,
        throwIfCancelled() {},
        async publishChatReply(payload) {
          replies.push(payload);
          return {
            id: "reply_workflows",
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
              type: "workflows"
            }
          },
          modelSettings: {
            textModel: "openai::deepseek-v4-pro",
            lastListedModels: []
          }
        }
      });

      const artifact = result.result.artifacts[0];
      assert.equal(replies[0].card.title, "AI Agent 工作流");
      assert.ok(replies[0].card.badges.some((badge) => /^工作流 \d+/.test(badge.label)));
      assert.ok(replies[0].card.badges.some((badge) => /^阻断|^警告|^可用|^未知/.test(badge.label)));
      assert.equal(artifact.type, "agent-workflows");
      assert.ok(artifact.health);
      assert.ok(Array.isArray(artifact.workflows));
      assert.ok(artifact.workflows.some((workflow) => workflow.id === "media-summary"));
      assert.ok(artifact.workflows.some((workflow) => workflow.id === "download-into-library"));
      assert.ok(artifact.workflows.some((workflow) => workflow.id === "failure-diagnostic"));
      const mediaWorkflow = artifact.workflows.find((workflow) => workflow.id === "media-summary");
      assert.ok(mediaWorkflow.steps.some((step) => step.id === "invoke_video_analyze"));
      assert.match(replies[0].text, /AI Agent 工作流/);
      assert.match(replies[0].text, /media-summary/);
      assert.match(replies[0].text, /search_library_files -> read_media_summary -> invoke_video_analyze/);
      assert.match(replies[0].text, /download-into-library/);
      assert.match(replies[0].text, /failure-diagnostic/);
      assert.match(replies[0].text, /@ai \/health/);
      assert.doesNotMatch(JSON.stringify(artifact), /sk-test/);
    });
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test("file access command route publishes NAS access policy without local paths", async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-access-command-"));
  const storageRoot = path.join(appDataRoot, "storage");
  try {
    await fs.mkdir(path.join(storageRoot, "Docs"), { recursive: true });
    await fs.writeFile(path.join(storageRoot, "Docs", "readme.txt"), "hello nas agent", "utf8");

    const replies = [];
    const api = {
      appDataRoot,
      storageRoot,
      signal: null,
      throwIfCancelled() {},
      async publishChatReply(payload) {
        replies.push(payload);
        return {
          id: "reply_file_access",
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
            type: "file-access",
            kind: "summary"
          }
        },
        modelSettings: {}
      }
    });

    const artifact = result.result.artifacts[0];
    const escapedStorageRoot = storageRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.equal(replies[0].card.title, "AI Agent NAS 文件访问");
    assert.ok(Array.isArray(replies[0].card.badges));
    assert.equal(artifact.type, "agent-file-access");
    assert.equal(artifact.storageRoot, "STORAGE_ROOT");
    assert.equal(artifact.storageRootConfigured, true);
    assert.ok(Number(artifact.visibleFiles) >= 1);
    assert.equal(artifact.policy.storageRootOnly, true);
    assert.equal(artifact.policy.allowBinaryRead, false);
    assert.equal(artifact.policy.rawAbsolutePathExposed, false);
    assert.equal(artifact.canAccess.arbitraryLocalPaths, false);
    assert.equal(artifact.canAccess.storageRootAbsolutePathInput, true);
    assert.ok(artifact.recommendedFirstSteps.some((step) => step.includes("search_library_files")));
    assert.match(replies[0].text, /AI Agent NAS 文件访问/);
    assert.match(replies[0].text, /storageRootOnly=true/);
    assert.match(replies[0].text, /禁止|二进制|allowBinaryRead=false/);
    assert.doesNotMatch(JSON.stringify(artifact), new RegExp(escapedStorageRoot));
    assert.doesNotMatch(replies[0].text, new RegExp(escapedStorageRoot));
  } finally {
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test("file access diagnose command route publishes concrete layers without local paths", async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-access-diagnose-command-"));
  const storageRoot = path.join(appDataRoot, "storage");
  try {
    await fs.mkdir(path.join(storageRoot, "Docs"), { recursive: true });
    await fs.writeFile(path.join(storageRoot, "Docs", "readme.txt"), "# NAS\nhello nas agent", "utf8");

    const replies = [];
    const api = {
      appDataRoot,
      storageRoot,
      signal: null,
      throwIfCancelled() {},
      async publishChatReply(payload) {
        replies.push(payload);
        return {
          id: "reply_file_access_diagnosis",
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
            type: "file-access-diagnose",
            identifier: "Docs/readme.txt"
          }
        },
        modelSettings: {}
      }
    });

    const artifact = result.result.artifacts[0];
    const escapedStorageRoot = storageRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.equal(replies[0].card.title, "AI Agent NAS 文件访问诊断");
    assert.equal(artifact.type, "agent-file-access-diagnosis");
    assert.equal(artifact.found, true);
    assert.equal(artifact.file.path, "Docs/readme.txt");
    assert.equal(artifact.safety.storageRootOnly, true);
    assert.equal(artifact.safety.absolutePathExposed, false);
    assert.equal(artifact.safety.binaryRawContentAllowed, false);
    assert.ok(artifact.layers.some((layer) => layer.id === "excerpt" && layer.available === true));
    assert.ok(artifact.recommendedTools.includes("read_text_excerpt"));
    assert.match(replies[0].text, /NAS 文件访问诊断/);
    assert.match(replies[0].text, /Docs\/readme\.txt/);
    assert.match(replies[0].text, /read_text_excerpt/);
    assert.match(replies[0].text, /absolutePathExposed=false/);
    assert.doesNotMatch(JSON.stringify(artifact), new RegExp(escapedStorageRoot));
    assert.doesNotMatch(replies[0].text, new RegExp(escapedStorageRoot));
  } finally {
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test("smoke command route publishes local agent smoke checklist", async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-smoke-command-"));
  const storageRoot = path.join(appDataRoot, "storage");
  const originalFetch = globalThis.fetch;
  try {
    await fs.mkdir(storageRoot, { recursive: true });
    globalThis.fetch = async (url) => {
      const text = String(url || "");
      if (text.includes("/models")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({
            data: [{
              id: "deepseek-v4-pro",
              name: "DeepSeek V4 Pro",
              capabilities: { supports: { tool_calls: false } }
            }]
          }),
          json: async () => ({})
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "{}",
        json: async () => ({ sources: ["qq"] })
      };
    };

    await withEnv({
      AI_PROVIDER: "openai",
      OPENAI_BASE_URL: "https://example.invalid/v1",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "deepseek-v4-pro",
      MUSIC_LIB_BRIDGE_URL: "http://music.invalid",
      BOT_BILIBILI_COOKIE_HEADER: undefined,
      BOT_BILIBILI_COOKIE_FILE: undefined
    }, async () => {
      const replies = [];
      const api = {
        appDataRoot,
        storageRoot,
        signal: null,
        throwIfCancelled() {},
        async publishChatReply(payload) {
          replies.push(payload);
          return {
            id: "reply_smoke",
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
              type: "smoke"
            }
          },
          modelSettings: {
            textModel: "openai::deepseek-v4-pro",
            lastListedModels: [{
              id: "openai::deepseek-v4-pro",
              modelId: "deepseek-v4-pro",
              provider: "openai",
              name: "DeepSeek V4 Pro"
            }]
          }
        }
      });

      const artifact = result.result.artifacts[0];
      assert.equal(replies[0].card.title, "AI Agent Smoke Checklist");
      assert.ok(Array.isArray(replies[0].card.badges));
      assert.equal(artifact.type, "agent-smoke-checklist");
      assert.ok(["ok", "warn", "blocked"].includes(artifact.overall));
      assert.ok(artifact.steps.some((step) => step.id === "health" && step.command === "@ai /health"));
      assert.ok(artifact.steps.some((step) => step.id === "models" && step.command === "@ai /models refresh"));
      assert.ok(artifact.steps.some((step) => step.id === "file-search" && step.requiredCapabilities.includes("search_library_files")));
      assert.ok(artifact.steps.some((step) => step.id === "image-analysis" && step.requiredCapabilities.includes("describe_image")));
      assert.ok(artifact.steps.some((step) => step.id === "video-summary" && step.requiredCapabilities.includes("invoke_video_analyze")));
      assert.ok(artifact.steps.some((step) => step.id === "music-playback" && step.command.includes("播放")));
      assert.match(replies[0].text, /AI Agent Smoke Checklist/);
      assert.match(replies[0].text, /图片分析/);
      assert.match(replies[0].text, /@ai \/jobs/);
      assert.doesNotMatch(JSON.stringify(artifact), new RegExp(storageRoot.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
      assert.doesNotMatch(JSON.stringify(artifact), /sk-test/);
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
    assert.deepEqual(replies[0].card.actions, [
      { type: "open-bot-log", label: "查看日志", jobId },
      { type: "open-bot-log", label: "子任务日志: video.analyze", jobId: "botjob_trace_child" }
    ]);
    assert.match(result.result.chatReply.text, /read_agent_trace/);
    assert.match(result.result.chatReply.text, /Agent 计划/);
    assert.match(result.result.chatReply.text, /子任务: failed 1/);
    assert.equal(result.result.artifacts[0].type, "agent-trace");
    assert.equal(result.result.artifacts[0].jobId, jobId);
    assert.equal(result.result.artifacts[0].planSummary.rounds[0].plans[0].pendingTools[0].name, "read_agent_trace");
    assert.equal(result.result.artifacts[0].childJobCount, 1);
    assert.equal(result.result.artifacts[0].childJobs[0].jobId, "botjob_trace_child");
    assert.equal(result.result.artifacts[0].childJobs[0].tracking.logCommand, "@ai /log botjob_trace_child");
  } finally {
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test("trace command route offers direct retry for recoverable file access tools", async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-trace-recovery-"));
  const jobId = "botjob_trace_recoverable";
  try {
    const graphRoot = path.join(appDataRoot, "ai-chat-graph");
    await fs.mkdir(path.join(graphRoot, "executions"), { recursive: true });
    await fs.mkdir(path.join(graphRoot, "traces"), { recursive: true });
    await fs.writeFile(path.join(graphRoot, "executions", `${jobId}.json`), JSON.stringify({
      jobId,
      botId: "ai.chat",
      sessionId: 7,
      status: "failed",
      route: "textTools",
      savedAt: "2026-07-02T08:30:00.000Z",
      traceSummary: {
        count: 2,
        lastNode: "textTools",
        lastStatus: "failed"
      },
      result: {},
      recoveryState: {
        toolRound: 2,
        pendingToolNames: ["read_media_summary"],
        pendingToolCalls: [{
          id: "call_retry_summary",
          name: "read_media_summary",
          input: {
            fileId: "client:movie.mp4",
            includeSummary: true
          }
        }],
        planningMessages: [{
          role: "user",
          content: "总结这个视频"
        }]
      }
    }), "utf8");
    await fs.writeFile(path.join(graphRoot, "traces", `${jobId}.jsonl`), `${JSON.stringify({
      kind: "agent",
      phase: "plan_next_step",
      round: 1,
      status: "tool-requested",
      detail: {
        model: "openai::deepseek-v4-pro",
        pendingTools: [{ id: "call_retry_summary", name: "read_media_summary", reason: "读取已有媒体摘要" }]
      },
      outputPreview: "call read_media_summary"
    })}\n`, "utf8");

    const replies = [];
    const api = {
      appDataRoot,
      signal: null,
      throwIfCancelled() {},
      async publishChatReply(payload) {
        replies.push(payload);
        return {
          id: "reply_trace_recoverable",
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
    assert.deepEqual(replies[0].card.actions, [
      {
        type: "invoke-bot",
        label: "重试失败步骤",
        botId: "ai.chat",
        rawText: "#7 继续",
        parsedArgs: {
          __chatReplyMode: "replace-chat-message"
        }
      },
      { type: "open-bot-log", label: "查看日志", jobId },
      { type: "retry-bot-job", label: "重新生成", jobId }
    ]);
    assert.equal(result.result.artifacts[0].recoveryHint.mode, "text-retry-tools");
    assert.equal(result.result.artifacts[0].recoveryHint.canContinueDirectly, true);
  } finally {
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test("job and log command cards expose recoverable agent retry action", async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-recovery-card-actions-"));
  const jobId = "botjob_recovery_card";
  try {
    const store = new BotJobStore({ rootDir: appDataRoot });
    await store.save({
      jobId,
      botId: "ai.chat",
      status: "failed",
      phase: "textTools",
      progress: { label: "Tool failed", percent: 80, details: null },
      input: {},
      options: {},
      result: {},
      audit: {},
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:01.000Z"
    });
    await store.appendLog(jobId, "read_media_summary failed once");
    await store.waitForPendingWrite(jobId);
    await store.waitForPendingLog(jobId);
    await writeRecoverableAgentTraceFixture(appDataRoot, {
      jobId,
      sessionId: 13
    });

    const replies = [];
    const api = {
      appDataRoot,
      signal: null,
      throwIfCancelled() {},
      getJob: (targetJobId) => store.get(targetJobId),
      async publishChatReply(payload) {
        replies.push(payload);
        return {
          id: `reply_${replies.length}`,
          text: payload.text,
          card: payload.card
        };
      }
    };

    const jobResult = await handleAiChatCommandRoute({
      prepared: {
        api,
        modelDirective: {
          command: {
            type: "jobs",
            jobId,
            limit: 1
          }
        },
        modelSettings: {}
      }
    });

    const expectedActions = [
      {
        type: "invoke-bot",
        label: "重试失败步骤",
        botId: "ai.chat",
        rawText: "#13 继续",
        parsedArgs: {
          __chatReplyMode: "replace-chat-message"
        }
      },
      { type: "open-bot-log", label: "查看日志", jobId },
      { type: "invoke-bot", label: "查看 Trace", botId: "ai.chat", rawText: `/trace ${jobId}` },
      { type: "retry-bot-job", label: "重新生成", jobId }
    ];
    assert.deepEqual(replies[0].card.actions, expectedActions);
    assert.match(jobResult.result.chatReply.text, /可继续：@ai #13 继续/);
    assert.equal(jobResult.result.artifacts[0].jobs[0].agentTrace.recoveryHint.mode, "text-retry-tools");

    const logResult = await handleAiChatCommandRoute({
      prepared: {
        api,
        modelDirective: {
          command: {
            type: "log",
            jobId
          }
        },
        modelSettings: {}
      }
    });

    assert.deepEqual(replies[1].card.actions, expectedActions);
    assert.match(logResult.result.chatReply.text, /可继续：@ai #13 继续/);
    assert.equal(logResult.result.artifacts[0].agentTrace.recoveryHint.mode, "text-retry-tools");
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
    assert.deepEqual(replies[0].card.actions, [
      { type: "open-bot-log", label: "查看日志", jobId: "botjob_parent" },
      { type: "invoke-bot", label: "查看 Trace", botId: "ai.chat", rawText: "/trace botjob_parent" },
      { type: "retry-bot-job", label: "重新生成", jobId: "botjob_parent" },
      { type: "open-bot-log", label: "子任务日志: video.analyze", jobId: "botjob_child" }
    ]);
    assert.match(result.result.chatReply.text, /Bot 日志：botjob_parent/);
    assert.match(result.result.chatReply.text, /OPENAI_API_KEY=\*\*\*/);
    assert.doesNotMatch(result.result.chatReply.text, /sk-should-not-leak/);
    assert.match(result.result.chatReply.text, /生命周期：events=/);
    assert.match(result.result.chatReply.text, /last=failed\/failed/);
    assert.match(result.result.chatReply.text, /video\.analyze · botjob_child · failed/);
    assert.equal(result.result.artifacts[0].type, "bot-job-log");
    assert.ok(result.result.artifacts[0].lifecycle.count >= 1);
    assert.equal(result.result.artifacts[0].lifecycle.last.status, "failed");
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
    assert.deepEqual(replies[0].card.actions, [
      { type: "continue-bot-job", label: "继续等待", jobId: "botjob_parent" },
      { type: "invoke-bot", label: "查看 Trace", botId: "ai.chat", rawText: "/trace botjob_parent" },
      { type: "open-bot-log", label: "查看日志", jobId: "botjob_parent" },
      { type: "cancel-bot-job", label: "停止生成", jobId: "botjob_parent" },
      { type: "open-bot-log", label: "子任务日志: video.analyze", jobId: "botjob_child" }
    ]);
    assert.match(result.result.chatReply.text, /ai\.chat · botjob_parent · running/);
    assert.match(result.result.chatReply.text, /生命周期：events=/);
    assert.match(result.result.chatReply.text, /last=running\/textTools/);
    assert.match(result.result.chatReply.text, /子任务：1 · queued 1/);
    assert.equal(result.result.artifacts[0].type, "bot-job-status");
    assert.ok(result.result.artifacts[0].jobs[0].lifecycle.count >= 1);
    assert.equal(result.result.artifacts[0].jobs[0].lifecycle.last.phase, "textTools");
    assert.equal(result.result.artifacts[0].jobs[0].logTail, undefined);
    assert.equal(result.result.artifacts[0].jobs[0].childJobs[0].jobId, "botjob_child");
  } finally {
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});
