import test from "node:test";
import assert from "node:assert/strict";

import {
  executeAiToolCall,
  getAiToolDefinitions
} from "../../src/bot/tools/aiToolRuntime.js";
import { buildLibraryMetadataResult } from "../../src/bot/tools/libraryFiles.js";
import { buildCapabilityDescriptors } from "../../src/bot/capabilities/registry.js";

function createFakeApi(overrides = {}) {
  const invoked = [];
  const progress = [];
  const files = [
    {
      id: "client:Videos/demo.mp4",
      clientId: "client",
      path: "Videos/demo.mp4",
      name: "demo.mp4",
      size: 1024,
      mimeType: "video/mp4",
      updatedAt: "2026-07-01T00:00:00.000Z",
      tags: ["demo"],
      aiSummary: ""
    }
  ];
  return {
    botId: "ai.chat",
    jobId: "botjob_parent",
    storageRoot: "D:/NAS",
    clientId: "client",
    signal: null,
    invoked,
    progress,
    dependencies: {
      listLibraryFiles: async () => ({
        clientId: "client",
        directories: [],
        files
      }),
      probeMediaFile: async () => ({
        durationSeconds: 125,
        durationLabel: "2:05",
        resolution: "1920x1080",
        width: 1920,
        height: 1080,
        videoTrackCount: 1,
        audioTrackCount: 1,
        subtitleTrackCount: 0,
        formatName: "mov,mp4,m4a,3gp,3g2,mj2",
        bitRate: 1200000
      })
    },
    emitProgress: async (event) => progress.push(event),
    invokeBot: async (payload) => {
      invoked.push(payload);
      return { jobId: "botjob_child", status: "queued" };
    },
    throwIfCancelled: () => {},
    ...overrides
  };
}

test("standard video bot tool names are exposed and registered as async medium-risk tools", () => {
  const toolNames = new Set(getAiToolDefinitions().map((tool) => tool.name));
  assert.equal(toolNames.has("invoke_video_analyze"), true);
  assert.equal(toolNames.has("invoke_video_tag"), true);
  assert.equal(toolNames.has("analyze_storage_video"), true);
  assert.equal(toolNames.has("tag_storage_video"), true);

  const videoAnalyzeTool = getAiToolDefinitions().find((tool) => tool.name === "invoke_video_analyze");
  assert.ok(videoAnalyzeTool.inputSchema.properties.source);
  assert.ok(videoAnalyzeTool.inputSchema.properties.url);
  const videoTagTool = getAiToolDefinitions().find((tool) => tool.name === "invoke_video_tag");
  assert.ok(videoTagTool.inputSchema.properties.fileIds);
  assert.ok(videoTagTool.inputSchema.properties.paths);

  const descriptors = new Map(buildCapabilityDescriptors({ listBots: () => [] }).map((item) => [item.id, item]));
  assert.equal(descriptors.get("invoke_video_analyze").riskLevel, "medium");
  assert.equal(descriptors.get("invoke_video_analyze").executionMode, "async-job");
  assert.equal(descriptors.get("invoke_video_tag").riskLevel, "medium");
  assert.equal(descriptors.get("invoke_video_tag").executionMode, "async-job");
});

test("invoke_video_analyze delegates to video.analyze and returns a job id", async () => {
  const api = createFakeApi();
  const raw = await executeAiToolCall(
    {
      name: "invoke_video_analyze",
      input: {
        path: "Videos/demo.mp4"
      }
    },
    { chat: {}, attachments: [] },
    api
  );
  const result = JSON.parse(raw);

  assert.equal(result.delegated, true);
  assert.equal(result.botId, "video.analyze");
  assert.equal(result.jobId, "botjob_child");
  assert.match(result.logHint, /@ai \/job botjob_child/);
  assert.equal(result.tracking.logCommand, "@ai /log botjob_child");
  assert.equal(result.tracking.traceCommand, "@ai /trace botjob_child");
  assert.equal(api.invoked[0].botId, "video.analyze");
  assert.deepEqual(api.invoked[0].trigger.parsedArgs, {
    fileId: "client:Videos/demo.mp4",
    filePath: "Videos/demo.mp4"
  });
  assert.deepEqual(api.invoked[0].options, {
    delegatedBy: "ai.chat",
    parentJobId: "botjob_parent",
    toolName: "invoke_video_analyze"
  });
});

test("invoke_video_analyze delegates Bilibili sources through the tool adapter", async () => {
  const api = createFakeApi();
  api.dependencies.listLibraryFiles = async () => {
    throw new Error("source analysis should not require a NAS file lookup");
  };
  const raw = await executeAiToolCall(
    {
      name: "invoke_video_analyze",
      input: {
        source: "BV1xx411c7mD"
      }
    },
    { chat: {}, attachments: [] },
    api
  );
  const result = JSON.parse(raw);

  assert.equal(result.delegated, true);
  assert.equal(result.botId, "video.analyze");
  assert.equal(result.jobId, "botjob_child");
  assert.equal(result.source, "BV1xx411c7mD");
  assert.equal(result.tracking.statusCommand, "@ai /job botjob_child");
  assert.equal(api.invoked[0].botId, "video.analyze");
  assert.deepEqual(api.invoked[0].trigger.parsedArgs, {
    source: "BV1xx411c7mD"
  });
  assert.equal(api.invoked[0].trigger.rawText, "BV1xx411c7mD");
  assert.equal(api.invoked[0].options.toolName, "invoke_video_analyze");
});

test("invoke_video_analyze can wait until a delegated job phase", async () => {
  const api = createFakeApi({
    getJob: async (jobId) => ({
      jobId,
      botId: "video.analyze",
      status: "running",
      phase: "transcribe",
      progress: { label: "Whisper 转字幕", percent: 35 }
    })
  });
  const raw = await executeAiToolCall(
    {
      name: "invoke_video_analyze",
      input: {
        path: "Videos/demo.mp4",
        waitUntilPhase: "transcribe",
        timeoutSeconds: 5
      }
    },
    { chat: {}, attachments: [] },
    api
  );
  const result = JSON.parse(raw);

  assert.equal(result.delegated, true);
  assert.equal(result.status, "running");
  assert.equal(result.phase, "transcribe");
  assert.equal(result.waitUntilPhase, "transcribe");
  assert.equal(result.phaseReached, true);
  assert.equal(result.nextAction, "waited-until-phase:transcribe");
  assert.equal(result.job.progress.percent, 35);
  assert.equal(result.tracking.statusCommand, "@ai /job botjob_child");
});

test("analyze_file_content reports needs-analysis before starting media job", async () => {
  const api = createFakeApi();
  const raw = await executeAiToolCall(
    {
      name: "analyze_file_content",
      input: {
        path: "Videos/demo.mp4"
      }
    },
    { chat: {}, attachments: [] },
    api
  );
  const result = JSON.parse(raw);

  assert.equal(result.status, "needs-analysis");
  assert.equal(result.mode, "media-summary");
  assert.equal(result.file.fileId, "client:Videos/demo.mp4");
  assert.equal(result.media.probeAvailable, true);
  assert.equal(result.media.durationLabel, "2:05");
  assert.match(result.nextAction, /startAnalysis=true/);
  assert.ok(result.actionPlan.some((action) => action.tool === "invoke_video_analyze"));
  assert.equal(api.invoked.length, 0);
});

test("analyze_file_content delegates media analysis with job tracking", async () => {
  const api = createFakeApi();
  const raw = await executeAiToolCall(
    {
      name: "analyze_file_content",
      input: {
        fileId: "client:Videos/demo.mp4",
        startAnalysis: true
      }
    },
    { chat: {}, attachments: [] },
    api
  );
  const result = JSON.parse(raw);

  assert.equal(result.mode, "media-analysis-job");
  assert.equal(result.delegated, true);
  assert.equal(result.botId, "video.analyze");
  assert.equal(result.status, "queued");
  assert.equal(result.jobId, "botjob_child");
  assert.equal(result.tracking.statusCommand, "@ai /job botjob_child");
  assert.equal(result.tracking.logCommand, "@ai /log botjob_child");
  assert.equal(result.tracking.traceCommand, "@ai /trace botjob_child");
  assert.equal(api.invoked[0].botId, "video.analyze");
  assert.deepEqual(api.invoked[0].trigger.parsedArgs, {
    fileId: "client:Videos/demo.mp4",
    filePath: "Videos/demo.mp4"
  });
  assert.deepEqual(api.invoked[0].options, {
    delegatedBy: "ai.chat",
    parentJobId: "botjob_parent",
    toolName: "analyze_file_content"
  });
});

test("invoke_video_tag delegates to video.tag with summary context", async () => {
  const api = createFakeApi();
  const raw = await executeAiToolCall(
    {
      name: "invoke_video_tag",
      input: {
        fileId: "client:Videos/demo.mp4",
        force: true,
        aiSummary: "A demo summary"
      }
    },
    { chat: {}, attachments: [] },
    api
  );
  const result = JSON.parse(raw);

  assert.equal(result.delegated, true);
  assert.equal(result.botId, "video.tag");
  assert.equal(result.jobId, "botjob_child");
  assert.match(result.logHint, /get_bot_job_status/);
  assert.equal(result.tracking.statusCommand, "@ai /job botjob_child");
  assert.equal(api.invoked[0].botId, "video.tag");
  assert.deepEqual(api.invoked[0].trigger.parsedArgs, {
    fileId: "client:Videos/demo.mp4",
    force: true,
    aiSummary: "A demo summary"
  });
  assert.equal(api.invoked[0].options.toolName, "invoke_video_tag");
});

test("invoke_video_tag batch returns confirmation preview before delegation", async () => {
  const api = createFakeApi();
  const raw = await executeAiToolCall(
    {
      name: "invoke_video_tag",
      input: {
        batch: true,
        force: true
      }
    },
    { chat: {}, attachments: [] },
    api
  );
  const preview = JSON.parse(raw);

  assert.equal(preview.status, "confirmation_required");
  assert.equal(preview.delegated, false);
  assert.equal(preview.requiresConfirmation, true);
  assert.equal(preview.blocked, true);
  assert.equal(preview.confirmation.operation, "invoke_video_tag");
  assert.equal(preview.confirmation.impact.targetFileCount, 1);
  assert.deepEqual(preview.confirmation.impact.changedFields, ["tags"]);
  assert.equal(preview.confirmation.impact.force, true);
  assert.equal(preview.confirmation.confirmWith.confirmed, true);
  assert.equal(api.invoked.length, 0);

  const confirmedRaw = await executeAiToolCall(
    {
      name: "invoke_video_tag",
      input: {
        batch: true,
        confirmed: true
      }
    },
    { chat: {}, attachments: [] },
    api
  );
  const confirmed = JSON.parse(confirmedRaw);
  assert.equal(confirmed.delegated, true);
  assert.equal(confirmed.botId, "video.tag");
  assert.equal(confirmed.tracking.traceCommand, "@ai /trace botjob_child");
  assert.equal(api.invoked.length, 1);
  assert.deepEqual(api.invoked[0].trigger.parsedArgs, {
    batch: true,
    force: false
  });
});

test("invoke_video_tag selected fileIds confirms scope then delegates individual jobs", async () => {
  const selectedFiles = [
    {
      id: "client:Videos/a.mp4",
      clientId: "client",
      path: "Videos/a.mp4",
      name: "a.mp4",
      size: 2048,
      mimeType: "video/mp4",
      updatedAt: "2026-07-01T01:00:00.000Z",
      aiSummary: "A summary"
    },
    {
      id: "client:Videos/b.mkv",
      clientId: "client",
      path: "Videos/b.mkv",
      name: "b.mkv",
      size: 4096,
      mimeType: "video/x-matroska",
      updatedAt: "2026-07-01T02:00:00.000Z"
    }
  ];
  const api = createFakeApi({
    dependencies: {
      listLibraryFiles: async () => ({
        clientId: "client",
        directories: [],
        files: selectedFiles
      })
    }
  });
  api.invokeBot = async (payload) => {
    api.invoked.push(payload);
    return { jobId: `botjob_child_${api.invoked.length}`, status: "queued" };
  };

  const previewRaw = await executeAiToolCall(
    {
      name: "invoke_video_tag",
      input: {
        fileIds: ["client:Videos/a.mp4", "client:Videos/b.mkv"],
        force: true
      }
    },
    { chat: {}, attachments: [] },
    api
  );
  const preview = JSON.parse(previewRaw);

  assert.equal(preview.status, "confirmation_required");
  assert.equal(preview.selected, true);
  assert.equal(preview.confirmation.impact.targetFileCount, 2);
  assert.deepEqual(preview.confirmation.confirmWith.fileIds, ["client:Videos/a.mp4", "client:Videos/b.mkv"]);
  assert.equal(preview.confirmation.confirmWith.batch, undefined);
  assert.equal(preview.confirmation.confirmWith.force, true);
  assert.equal(api.invoked.length, 0);

  const confirmedRaw = await executeAiToolCall(
    {
      name: "invoke_video_tag",
      input: {
        fileIds: ["client:Videos/a.mp4", "client:Videos/b.mkv"],
        force: true,
        confirmed: true
      }
    },
    { chat: {}, attachments: [] },
    api
  );
  const confirmed = JSON.parse(confirmedRaw);

  assert.equal(confirmed.delegated, true);
  assert.equal(confirmed.selected, true);
  assert.equal(confirmed.total, 2);
  assert.deepEqual(confirmed.jobs.map((job) => job.jobId), ["botjob_child_1", "botjob_child_2"]);
  assert.deepEqual(api.invoked.map((payload) => payload.trigger.parsedArgs.fileId), ["client:Videos/a.mp4", "client:Videos/b.mkv"]);
  assert.deepEqual(api.invoked[0].trigger.parsedArgs, {
    fileId: "client:Videos/a.mp4",
    force: true,
    aiSummary: "A summary"
  });
  assert.deepEqual(api.invoked[1].trigger.parsedArgs, {
    fileId: "client:Videos/b.mkv",
    force: true,
    aiSummary: ""
  });
  assert.equal(api.invoked[0].options.toolName, "invoke_video_tag");
  assert.equal(confirmed.tracking.jobsCommand, "@ai /jobs");
});

test("NAS metadata recommends standard invoke_video_analyze for unanalyzed media", async () => {
  const api = createFakeApi();
  const result = await buildLibraryMetadataResult(api, {
    path: "Videos/demo.mp4"
  });
  const tools = result.files[0].contentAccess.recommendedTools;
  assert.equal(tools.includes("invoke_video_analyze"), true);
  assert.equal(tools.includes("analyze_storage_video"), false);
});
