import test from "node:test";
import assert from "node:assert/strict";

import {
  executeDelegatedBotToolCall,
  getDelegatedBotToolDefinitions,
  isDelegatedBotToolName
} from "../../src/bot/tools/botToolAdapter.js";
import {
  executeAiToolCall,
  getAiToolDefinitions
} from "../../src/bot/tools/aiToolRuntime.js";

function createFakeApi(overrides = {}) {
  const invoked = [];
  const progress = [];
  return {
    botId: "ai.chat",
    jobId: "botjob_parent",
    signal: null,
    invoked,
    progress,
    emitProgress: async (event) => progress.push(event),
    invokeBot: async (payload) => {
      invoked.push(payload);
      return { jobId: "botjob_child", status: "queued" };
    },
    throwIfCancelled: () => {},
    ...overrides
  };
}

test("delegated bot tool definitions expose download adapters to aiToolRuntime", () => {
  const delegatedNames = getDelegatedBotToolDefinitions().map((tool) => tool.name).sort();
  assert.deepEqual(delegatedNames, [
    "invoke_aria2_downloader",
    "invoke_bilibili_downloader",
    "invoke_torrent_downloader",
    "invoke_ytdlp_downloader"
  ]);
  for (const name of delegatedNames) {
    assert.equal(isDelegatedBotToolName(name), true);
  }

  const runtimeNames = new Set(getAiToolDefinitions().map((tool) => tool.name));
  for (const name of delegatedNames) {
    assert.equal(runtimeNames.has(name), true);
  }
});

test("executeAiToolCall delegates yt-dlp downloads with job status hints", async () => {
  const api = createFakeApi();
  const raw = await executeAiToolCall(
    {
      name: "invoke_ytdlp_downloader",
      input: {
        url: "https://example.com/watch?v=abc",
        targetFolder: "downloads/youtube",
        quality: "720p"
      }
    },
    { chat: {}, attachments: [] },
    api
  );
  const result = JSON.parse(raw);

  assert.equal(result.delegated, true);
  assert.equal(result.botId, "ytdlp.downloader");
  assert.equal(result.jobId, "botjob_child");
  assert.match(result.logHint, /get_bot_job_status/);
  assert.match(result.logHint, /@ai \/job botjob_child/);
  assert.equal(result.tracking.statusCommand, "@ai /job botjob_child");
  assert.equal(result.tracking.logCommand, "@ai /log botjob_child");
  assert.equal(result.tracking.traceCommand, "@ai /trace botjob_child");
  assert.equal(api.progress[0].phase, "tool-ytdlp-downloader");
  assert.equal(api.invoked[0].botId, "ytdlp.downloader");
  assert.deepEqual(api.invoked[0].trigger.parsedArgs, {
    url: "https://example.com/watch?v=abc",
    targetFolder: "downloads/youtube",
    quality: "720p",
    source: "https://example.com/watch?v=abc",
    sourceUrl: "https://example.com/watch?v=abc"
  });
  assert.deepEqual(api.invoked[0].options, {
    delegatedBy: "ai.chat",
    parentJobId: "botjob_parent",
    toolName: "invoke_ytdlp_downloader"
  });
});

test("delegated bot tool can wait for completion when requested", async () => {
  const api = createFakeApi({
    getJob: async (jobId) => ({
      jobId,
      status: "succeeded",
      result: { importedFiles: [{ path: "downloads/file.mp4" }] }
    })
  });

  const result = await executeDelegatedBotToolCall("invoke_aria2_downloader", api, {
    source: "https://example.com/file.iso",
    targetFolder: "downloads/iso",
    waitForCompletion: true,
    timeoutSeconds: 5
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.nextAction, "waited-for-completion");
  assert.equal(result.tracking.statusCommand, "@ai /job botjob_child");
  assert.deepEqual(result.result.importedFiles, [{ path: "downloads/file.mp4" }]);
});

test("delegated bot tool can wait until a phase without leaking control args", async () => {
  const api = createFakeApi({
    getJob: async (jobId) => ({
      jobId,
      botId: "ytdlp.downloader",
      status: "running",
      phase: "download",
      progress: { label: "Downloading", percent: 12 }
    })
  });

  const result = await executeDelegatedBotToolCall("invoke_ytdlp_downloader", api, {
    url: "https://example.com/watch?v=abc",
    targetFolder: "downloads/youtube",
    waitUntilPhase: "download",
    timeoutSeconds: 5
  });

  assert.equal(result.status, "running");
  assert.equal(result.phase, "download");
  assert.equal(result.waitUntilPhase, "download");
  assert.equal(result.phaseReached, true);
  assert.equal(result.waitTimedOut, false);
  assert.equal(result.nextAction, "waited-until-phase:download");
  assert.equal(result.job.progress.percent, 12);
  assert.equal(result.tracking.statusCommand, "@ai /job botjob_child");
  assert.deepEqual(api.invoked[0].trigger.parsedArgs, {
    url: "https://example.com/watch?v=abc",
    targetFolder: "downloads/youtube",
    source: "https://example.com/watch?v=abc",
    sourceUrl: "https://example.com/watch?v=abc"
  });
});

test("delegated bot tool rejects missing sources and unsafe target folders", async () => {
  const api = createFakeApi();
  await assert.rejects(
    () => executeDelegatedBotToolCall("invoke_torrent_downloader", api, {
      targetFolder: "downloads"
    }),
    /requires source/
  );
  await assert.rejects(
    () => executeDelegatedBotToolCall("invoke_aria2_downloader", api, {
      source: "https://example.com/file.iso",
      targetFolder: "../outside"
    }),
    /invalid path segment/
  );
  await assert.rejects(
    () => executeDelegatedBotToolCall("invoke_aria2_downloader", api, {
      source: "https://example.com/file.iso",
      targetFolder: ".nas-bot/cache"
    }),
    /hidden\/system/
  );
  await assert.rejects(
    () => executeDelegatedBotToolCall("invoke_ytdlp_downloader", api, {
      url: "ftp://example.com/file.mp4"
    }),
    /unsupported source/
  );
});

test("bilibili adapter allows login/status actions without a source", async () => {
  const api = createFakeApi();
  const result = await executeDelegatedBotToolCall("invoke_bilibili_downloader", api, {
    action: "status"
  });

  assert.equal(result.botId, "bilibili.downloader");
  assert.equal(api.invoked[0].trigger.rawText, "status");
  assert.equal(api.invoked[0].trigger.parsedArgs.action, "status");
});

test("import_bilibili_video reuses safe target folder validation", async () => {
  const api = createFakeApi();
  await assert.rejects(
    () => executeAiToolCall(
      {
        name: "import_bilibili_video",
        input: {
          source: "BV1abc123456",
          targetFolder: "../outside"
        }
      },
      { chat: {}, attachments: [] },
      api
    ),
    /invalid path segment/
  );
  await assert.rejects(
    () => executeAiToolCall(
      {
        name: "import_bilibili_video",
        input: {
          source: "BV1abc123456",
          targetFolder: ".nas-bot/cache"
        }
      },
      { chat: {}, attachments: [] },
      api
    ),
    /hidden\/system/
  );

  const raw = await executeAiToolCall(
    {
      name: "import_bilibili_video",
      input: {
        sources: ["BV1abc123456", "https://www.bilibili.com/video/BV2def123456"],
        targetFolder: "/downloads//bilibili/教程"
      }
    },
    { chat: {}, attachments: [] },
    api
  );
  const result = JSON.parse(raw);

  assert.equal(result.delegated, true);
  assert.equal(result.botId, "bilibili.downloader");
  assert.deepEqual(result.sources, ["BV1abc123456", "https://www.bilibili.com/video/BV2def123456"]);
  assert.equal(result.tracking.statusCommand, "@ai /job botjob_child");
  assert.equal(api.invoked.at(-1).trigger.rawText, "BV1abc123456 https://www.bilibili.com/video/BV2def123456");
  assert.deepEqual(api.invoked.at(-1).trigger.parsedArgs, {
    targetFolder: "downloads/bilibili/教程"
  });
});
