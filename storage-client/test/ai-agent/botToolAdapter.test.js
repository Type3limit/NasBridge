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

test("executeAiToolCall delegates music control with tracking when waiting by default", async () => {
  const api = createFakeApi({
    getJob: async (jobId) => ({
      jobId,
      botId: "music.control",
      status: "succeeded",
      phase: "done",
      result: {
        artifacts: [{ type: "music-enqueue", trackId: "track_1" }],
        chatReply: { id: "msg_music" }
      }
    })
  });
  const raw = await executeAiToolCall(
    {
      name: "invoke_music_control",
      input: {
        action: "enqueue",
        keyword: "晴天",
        source: "qq"
      }
    },
    { chat: {}, attachments: [] },
    api
  );
  const result = JSON.parse(raw);

  assert.equal(result.delegated, true);
  assert.equal(result.botId, "music.control");
  assert.equal(result.jobId, "botjob_child");
  assert.equal(result.status, "succeeded");
  assert.equal(result.phase, "done");
  assert.equal(result.prompt, "点歌 晴天 --source=qq");
  assert.equal(result.nextAction, "waited-for-completion");
  assert.match(result.logHint, /get_bot_job_status/);
  assert.equal(result.tracking.statusCommand, "@ai /job botjob_child");
  assert.equal(result.tracking.logCommand, "@ai /log botjob_child");
  assert.equal(result.tracking.traceCommand, "@ai /trace botjob_child");
  assert.deepEqual(result.result.artifacts, [{ type: "music-enqueue", trackId: "track_1" }]);
  assert.equal(api.progress[0].phase, "tool-invoke-music-control");
  assert.equal(api.progress[1].label, "等待音乐助手返回");
  assert.equal(api.invoked[0].botId, "music.control");
  assert.deepEqual(api.invoked[0].trigger, {
    type: "tool-call",
    rawText: "点歌 晴天 --source=qq",
    parsedArgs: {
      prompt: "点歌 晴天 --source=qq"
    }
  });
  assert.deepEqual(api.invoked[0].options, {
    delegatedBy: "ai.chat",
    parentJobId: "botjob_parent",
    toolName: "invoke_music_control"
  });
});

test("executeAiToolCall can wait for a music control phase without waiting for completion", async () => {
  const api = createFakeApi({
    getJob: async (jobId) => ({
      jobId,
      botId: "music.control",
      status: "running",
      phase: "search",
      progress: { label: "Searching", percent: 46 }
    })
  });
  const raw = await executeAiToolCall(
    {
      name: "invoke_music_control",
      input: {
        action: "search",
        query: "夜曲",
        waitForCompletion: false,
        waitUntilPhase: "search",
        timeoutSeconds: 5
      }
    },
    { chat: {}, attachments: [] },
    api
  );
  const result = JSON.parse(raw);

  assert.equal(result.delegated, true);
  assert.equal(result.botId, "music.control");
  assert.equal(result.jobId, "botjob_child");
  assert.equal(result.status, "running");
  assert.equal(result.phase, "search");
  assert.equal(result.prompt, "搜歌 夜曲");
  assert.equal(result.waitUntilPhase, "search");
  assert.equal(result.phaseReached, true);
  assert.equal(result.waitTimedOut, false);
  assert.equal(result.nextAction, "waited-until-phase:search");
  assert.equal(result.job.progress.percent, 46);
  assert.equal(result.tracking.statusCommand, "@ai /job botjob_child");
  assert.equal(api.progress[1].label, "等待音乐任务进入 search");
  assert.deepEqual(api.invoked[0].trigger.parsedArgs, {
    prompt: "搜歌 夜曲"
  });
});

test("delegated bot tool can wait for completion when requested", async () => {
  const api = createFakeApi({
    clientId: "client",
    getJob: async (jobId) => ({
      jobId,
      status: "succeeded",
      result: {
        importedFiles: [{
          absolutePath: "D:\\NAS\\downloads\\file.mp4",
          relativePath: "downloads/file.mp4",
          fileName: "file.mp4",
          size: 1024,
          mimeType: "video/mp4"
        }]
      }
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
  assert.equal(result.importedFileCount, 1);
  assert.deepEqual(result.importedFiles, [{
    fileId: "client:downloads/file.mp4",
    path: "downloads/file.mp4",
    name: "file.mp4",
    size: 1024,
    mimeType: "video/mp4"
  }]);
  assert.deepEqual(result.files, result.importedFiles);
  assert.deepEqual(result.result.importedFiles, result.importedFiles);
  assert.equal(JSON.stringify(result).includes("D:\\NAS"), false);
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
