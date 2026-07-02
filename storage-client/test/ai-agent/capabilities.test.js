import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  buildCapabilityDescriptors,
  formatCapabilityPromptSummary
} from "../../src/bot/capabilities/registry.js";
import {
  collectAiAgentHealthCached,
  formatHealthReport
} from "../../src/bot/capabilities/health.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-capabilities-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

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

async function createMusicHealthServer() {
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, sources: ["qq"] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("health cache uses isolated local dependencies and caches the second snapshot", async () => {
  await withTempDir(async (root) => {
    const toolDir = path.join(root, "tools");
    await fs.mkdir(toolDir, { recursive: true });
    const paths = {
      ffmpeg: path.join(toolDir, "ffmpeg.exe"),
      ffprobe: path.join(toolDir, "ffprobe.exe"),
      whisper: path.join(toolDir, "whisper.exe"),
      whisperModel: path.join(toolDir, "ggml-model.bin"),
      ytdlp: path.join(toolDir, "yt-dlp.exe")
    };
    await Promise.all(Object.values(paths).map((filePath) => fs.writeFile(filePath, "stub")));
    await fs.writeFile(path.join(root, "demo.txt"), "hello");

    const music = await createMusicHealthServer();
    try {
      await withEnv({
        WHISPER_CPP_PATH: paths.whisper,
        WHISPER_MODEL_PATH: paths.whisperModel,
        YT_DLP_PATH: paths.ytdlp,
        MUSIC_LIB_BRIDGE_URL: music.url
      }, async () => {
        const modelSettings = {
          textModel: "openai::deepseek-v4-pro",
          multimodalModel: "openai::deepseek-v4-pro",
          lastListedModels: [
            {
              id: "openai::deepseek-v4-pro",
              modelId: "deepseek-v4-pro",
              provider: "openai",
              name: "DeepSeek V4 Pro",
              toolCalls: false,
              vision: true
            }
          ]
        };
        const api = {
          storageRoot: root,
          clientId: "client",
          dependencies: {
            ffmpegPath: paths.ffmpeg,
            ffprobePath: paths.ffprobe,
            listLibraryFiles: async () => ({
              clientId: "client",
              directories: [],
              files: [
                {
                  id: "client:demo.txt",
                  clientId: "client",
                  path: "demo.txt",
                  name: "demo.txt",
                  size: 5,
                  mimeType: "text/plain",
                  updatedAt: "2026-07-01T00:00:00.000Z"
                }
              ]
            })
          }
        };

        const first = await collectAiAgentHealthCached(api, {
          lightweight: true,
          modelSettings,
          ttlMs: 60_000
        });
        const second = await collectAiAgentHealthCached(api, {
          lightweight: true,
          modelSettings,
          ttlMs: 60_000
        });

        assert.equal(first.cached, false);
        assert.equal(second.cached, true);
        assert.equal(first.overall, "ok");
        assert.equal(first.checks.find((check) => check.id === "storage-root").status, "ok");
        assert.match(formatHealthReport(first), /AI Agent/);
      });
    } finally {
      await music.close();
    }
  });
});

test("capability descriptors expose core NAS tools, risk, and redacted prompt health", () => {
  const descriptors = buildCapabilityDescriptors({
    listBots: () => [
      {
        botId: "video.analyze",
        displayName: "Video Analyze",
        description: "Analyze NAS media",
        inputSchema: { type: "object", properties: {} },
        capabilities: ["media-analysis"]
      }
    ]
  });

  const byId = new Map(descriptors.map((item) => [item.id, item]));
  assert.equal(byId.get("video.analyze").executionMode, "async-job");
  assert.equal(byId.get("search_library_files").riskLevel, "low");
  assert.equal(byId.get("analyze_file_content").riskLevel, "medium");
  assert.equal(byId.get("organize_files").riskLevel, "high");
  assert.equal(byId.get("organize_files").requiresConfirmation, true);

  const summary = formatCapabilityPromptSummary(descriptors, {
    overall: "warn",
    checks: [
      {
        id: "storage-root",
        label: "NAS",
        status: "warn",
        detail: "C:\\Secret\\nas-data is read only"
      }
    ]
  }, { maxItems: 16 });

  assert.match(summary, /search_library_files/);
  assert.match(summary, /organize_files/);
  assert.match(summary, /\[local-path\]/);
  assert.doesNotMatch(summary, /C:\\Secret/);
});
