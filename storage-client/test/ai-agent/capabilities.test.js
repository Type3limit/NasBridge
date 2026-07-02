import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  buildCapabilityArtifactSummary,
  buildCapabilityDescriptors,
  formatCapabilityReport,
  formatCapabilityPromptSummary
} from "../../src/bot/capabilities/registry.js";
import {
  collectAiAgentHealthCached,
  formatHealthReport,
  getHealthRepairHint
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
    const musicBridgeWorkDir = path.join(root, "music-lib-bridge");
    const appDataRoot = path.join(root, ".nas-bot");
    await fs.mkdir(musicBridgeWorkDir, { recursive: true });
    await fs.mkdir(path.join(appDataRoot, "jobs"), { recursive: true });
    await fs.writeFile(path.join(musicBridgeWorkDir, ".env"), "QQ_COOKIE=uin=o123456; skey=fake\nQQ_COOKIE_AUTO_REFRESH=1\nQQ_COOKIE_REFRESH_INTERVAL_MINUTES=60\n", "utf8");
    await fs.writeFile(path.join(appDataRoot, "bilibili-cookies.json"), JSON.stringify({ cookies: [{ name: "SESSDATA" }] }), "utf8");

    const music = await createMusicHealthServer();
    try {
      await withEnv({
        WHISPER_CPP_PATH: paths.whisper,
        WHISPER_MODEL_PATH: paths.whisperModel,
        YT_DLP_PATH: paths.ytdlp,
        MUSIC_LIB_BRIDGE_URL: music.url,
        MUSIC_LIB_BRIDGE_WORKDIR: musicBridgeWorkDir,
        QQ_COOKIE_AUTO_REFRESH: "1",
        QQ_COOKIE_REFRESH_INTERVAL_MINUTES: "60",
        BOT_BILIBILI_COOKIE_FILE: "",
        BOT_BILIBILI_COOKIE_HEADER: "",
        PLAYWRIGHT_BROWSERS_PATH: path.join(root, "ms-playwright")
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
          appDataRoot,
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
        const checks = new Map(first.checks.map((check) => [check.id, check]));
        const storageCheck = checks.get("storage-root");
        assert.equal(storageCheck.status, "ok");
        assert.match(storageCheck.detail, /indexSource=dependency/);
        assert.match(storageCheck.detail, /latestFile=2026-07-01T00:00:00\.000Z/);
        assert.equal(storageCheck.policy.allowBinaryRead, false);
        assert.equal(storageCheck.policy.storageRootOnly, true);
        assert.equal(storageCheck.policy.acceptsStorageRootAbsolutePath, true);
        assert.equal(storageCheck.policy.absolutePathInputScope, "storage-root-only");
        assert.ok(storageCheck.policy.hiddenDirs.includes(".nas-bot"));
        assert.deepEqual({
          rootConfigured: storageCheck.fileAccess.rootConfigured,
          exists: storageCheck.fileAccess.exists,
          readable: storageCheck.fileAccess.readable,
          writable: storageCheck.fileAccess.writable,
          files: storageCheck.fileAccess.files,
          directories: storageCheck.fileAccess.directories,
          indexSource: storageCheck.fileAccess.indexSource,
          latestFileUpdatedAt: storageCheck.fileAccess.latestFileUpdatedAt
        }, {
          rootConfigured: true,
          exists: true,
          readable: true,
          writable: true,
          files: 1,
          directories: 0,
          indexSource: "dependency",
          latestFileUpdatedAt: "2026-07-01T00:00:00.000Z"
        });
        assert.equal(storageCheck.fileAccess.fileIdResolution.ok, true);
        assert.equal(storageCheck.fileAccess.fileIdResolution.checked, 1);
        assert.equal(storageCheck.fileAccess.fileIdResolution.resolved, 1);
        assert.equal(checks.get("ai-tool-call").status, "ok");
        assert.match(checks.get("ai-tool-call").detail, /JSON plan fallback/);
        assert.equal(checks.get("document-text").status, "ok");
        assert.match(checks.get("document-text").detail, /Office Open XML/);
        assert.equal(checks.get("qq-music-cookie").status, "ok");
        assert.match(checks.get("qq-music-cookie").detail, /refreshed=\d{4}-\d{2}-\d{2}T/);
        assert.match(checks.get("qq-music-cookie").detail, /age=\d+[smhd]/);
        assert.doesNotMatch(checks.get("qq-music-cookie").detail, /uin=o123456|skey=fake/);
        assert.equal(checks.get("bilibili-auth").status, "ok");
        assert.equal(checks.get("bot-queue").status, "ok");
        const firstReport = formatHealthReport(first);
        assert.match(firstReport, /AI Agent/);
        assert.match(firstReport, /NAS 文件访问: STORAGE_ROOT；可读写；/);
        assert.match(firstReport, /文件访问：root=STORAGE_ROOT · exists=true · readable=true · writable=true · indexedFiles=1 · dirs=0 · indexSource=dependency/);
        assert.match(firstReport, /fileIdResolution=ok · resolutionChecked=1\/1/);
        assert.match(firstReport, /访问边界：storageRootOnly=true · allowRawTextRead=true · allowBinaryRead=false · absolutePathInput=storage-root-only · rawAbsolutePathExposed=false · writeRequiresConfirmation=true/);
        assert.equal(firstReport.includes(root), false);
      });
    } finally {
      await music.close();
    }
  });
});

test("storage health scans NAS root and reports hidden directory exclusions", async () => {
  await withTempDir(async (baseDir) => {
    const storageRoot = path.join(baseDir, "storage");
    const toolDir = path.join(baseDir, "tools");
    const musicBridgeWorkDir = path.join(baseDir, "music-lib-bridge");
    const appDataRoot = path.join(storageRoot, ".nas-bot");
    await fs.mkdir(storageRoot, { recursive: true });
    await fs.mkdir(toolDir, { recursive: true });
    await fs.mkdir(musicBridgeWorkDir, { recursive: true });
    await fs.mkdir(path.join(appDataRoot, "jobs"), { recursive: true });
    await fs.mkdir(path.join(storageRoot, ".nas-preview-cache"), { recursive: true });
    await fs.writeFile(path.join(storageRoot, "visible.txt"), "hello", "utf8");
    await fs.writeFile(path.join(storageRoot, ".nas-preview-cache", "thumb.txt"), "hidden", "utf8");
    await fs.writeFile(path.join(appDataRoot, "job-log.txt"), "hidden", "utf8");
    await fs.writeFile(path.join(musicBridgeWorkDir, ".env"), "QQ_COOKIE=uin=o123456; skey=fake\nQQ_COOKIE_AUTO_REFRESH=1\nQQ_COOKIE_REFRESH_INTERVAL_MINUTES=60\n", "utf8");
    await fs.writeFile(path.join(appDataRoot, "bilibili-cookies.json"), JSON.stringify({ cookies: [{ name: "SESSDATA" }] }), "utf8");
    const paths = {
      ffmpeg: path.join(toolDir, "ffmpeg.exe"),
      ffprobe: path.join(toolDir, "ffprobe.exe"),
      whisper: path.join(toolDir, "whisper.exe"),
      whisperModel: path.join(toolDir, "ggml-model.bin"),
      ytdlp: path.join(toolDir, "yt-dlp.exe")
    };
    await Promise.all(Object.values(paths).map((filePath) => fs.writeFile(filePath, "stub")));

    const music = await createMusicHealthServer();
    try {
      await withEnv({
        WHISPER_CPP_PATH: paths.whisper,
        WHISPER_MODEL_PATH: paths.whisperModel,
        YT_DLP_PATH: paths.ytdlp,
        MUSIC_LIB_BRIDGE_URL: music.url,
        MUSIC_LIB_BRIDGE_WORKDIR: musicBridgeWorkDir,
        QQ_COOKIE_AUTO_REFRESH: "1",
        QQ_COOKIE_REFRESH_INTERVAL_MINUTES: "60",
        BOT_BILIBILI_COOKIE_FILE: "",
        BOT_BILIBILI_COOKIE_HEADER: "",
        PLAYWRIGHT_BROWSERS_PATH: path.join(baseDir, "ms-playwright")
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
        const health = await collectAiAgentHealthCached({
          storageRoot,
          appDataRoot,
          clientId: "client",
          dependencies: {
            ffmpegPath: paths.ffmpeg,
            ffprobePath: paths.ffprobe
          }
        }, {
          lightweight: true,
          modelSettings,
          ttlMs: 0
        });

        assert.equal(health.overall, "ok");
        const storageCheck = new Map(health.checks.map((check) => [check.id, check])).get("storage-root");
        assert.equal(storageCheck.status, "ok");
        assert.match(storageCheck.detail, /files=1\b/);
        assert.match(storageCheck.detail, /dirs=0\b/);
        assert.match(storageCheck.detail, /indexSource=scan/);
        assert.match(storageCheck.detail, /hiddenDirsExcluded=\d+/);
        assert.match(storageCheck.detail, /skipped=2\b/);
        assert.equal(storageCheck.policy.rawAbsolutePathExposed, false);
        assert.equal(storageCheck.policy.allowBinaryRead, false);
        assert.ok(storageCheck.policy.hiddenDirs.includes(".nas-preview-cache"));
        assert.equal(storageCheck.fileAccess.files, 1);
        assert.equal(storageCheck.fileAccess.directories, 0);
        assert.equal(storageCheck.fileAccess.indexSource, "scan");
        assert.equal(storageCheck.fileAccess.skippedDirectories, 2);
        assert.equal(storageCheck.fileAccess.allowBinaryRead, false);
        assert.equal(storageCheck.fileAccess.rawAbsolutePathExposed, false);
        assert.equal(storageCheck.fileAccess.fileIdResolution.ok, true);
        assert.equal(storageCheck.fileAccess.fileIdResolution.checked, 1);
        assert.match(storageCheck.detail, /^STORAGE_ROOT；可读写；/);
        assert.match(storageCheck.detail, /fileIdResolution=ok/);
        assert.equal(storageCheck.detail.includes(storageRoot), false);
        const report = formatHealthReport(health);
        assert.match(report, /文件访问：root=STORAGE_ROOT · exists=true · readable=true · writable=true · indexedFiles=1 · dirs=0 · indexSource=scan/);
        assert.match(report, /hiddenDirsExcluded=\d+ · skippedDirs=2/);
        assert.match(report, /fileIdResolution=ok · resolutionChecked=1\/1/);
        assert.equal(report.includes(storageRoot), false);
      });
    } finally {
      await music.close();
    }
  });
});

test("storage health warns when indexed file ids cannot resolve inside storage root", async () => {
  await withTempDir(async (baseDir) => {
    const storageRoot = path.join(baseDir, "storage");
    await fs.mkdir(storageRoot, { recursive: true });
    const music = await createMusicHealthServer();
    try {
      await withEnv({
        MUSIC_LIB_BRIDGE_URL: music.url
      }, async () => {
        const health = await collectAiAgentHealthCached({
          storageRoot,
          appDataRoot: path.join(storageRoot, ".nas-bot"),
          clientId: "client",
          dependencies: {
            listLibraryFiles: async () => ({
              clientId: "client",
              directories: [],
              files: [
                {
                  id: "client:../outside.txt",
                  clientId: "client",
                  path: "../outside.txt",
                  name: "outside.txt",
                  size: 7,
                  mimeType: "text/plain",
                  updatedAt: "2026-07-01T00:00:00.000Z"
                }
              ]
            })
          }
        }, {
          lightweight: true,
          modelSettings: {
            textModel: "openai::deepseek-v4-pro",
            lastListedModels: [
              {
                id: "openai::deepseek-v4-pro",
                modelId: "deepseek-v4-pro",
                provider: "openai",
                name: "DeepSeek V4 Pro"
              }
            ]
          },
          ttlMs: 0
        });

        const storageCheck = new Map(health.checks.map((check) => [check.id, check])).get("storage-root");
        assert.equal(storageCheck.status, "warn");
        assert.equal(storageCheck.fileAccess.fileIdResolution.ok, false);
        assert.equal(storageCheck.fileAccess.fileIdResolution.checked, 1);
        assert.equal(storageCheck.fileAccess.fileIdResolution.missingIds, 0);
        assert.equal(storageCheck.fileAccess.fileIdResolution.duplicateIds, 0);
        assert.equal(storageCheck.fileAccess.fileIdResolution.unsafePaths, 1);
        assert.match(storageCheck.detail, /fileIdResolution=warn checked=1 missingIds=0 duplicateIds=0 unsafePaths=1/);
        const report = formatHealthReport(health);
        assert.match(report, /fileIdResolution=warn · resolutionChecked=1\/1 · missingIds=0 · duplicateIds=0 · unsafePaths=1/);
        assert.equal(report.includes(storageRoot), false);
        assert.equal(report.includes("outside.txt"), false);
      });
    } finally {
      await music.close();
    }
  });
});

test("health report includes repair hints for degraded checks", () => {
  const health = {
    overall: "warn",
    generatedAt: "2026-07-02T00:00:00.000Z",
    checks: [
      {
        id: "ai-model",
        label: "AI 模型",
        status: "warn",
        detail: "文本模型未出现在 /models：openai::bad-model"
      },
      {
        id: "whisper",
        label: "Whisper",
        status: "warn",
        detail: "WHISPER_CPP_PATH 或 WHISPER_MODEL_PATH 未配置"
      },
      {
        id: "music-bridge",
        label: "music-lib-bridge",
        status: "error",
        detail: "不可达：fetch failed"
      },
      {
        id: "storage-root",
        label: "NAS 文件访问",
        status: "ok",
        detail: "可读写"
      }
    ]
  };

  const report = formatHealthReport(health);
  assert.match(report, /建议：运行 @ai \/models 刷新模型列表/);
  assert.match(report, /建议：配置 WHISPER_CPP_PATH 和 WHISPER_MODEL_PATH/);
  assert.match(report, /建议：启动 music-lib-bridge/);
  assert.doesNotMatch(report, /NAS 文件访问: 可读写\n  建议/);
  assert.match(getHealthRepairHint("qq-music-cookie"), /QQ_COOKIE/);
});

test("capability descriptors expose core NAS tools, risk, and redacted prompt health", () => {
  const descriptors = buildCapabilityDescriptors({
    listBots: () => [
      {
        botId: "ai.chat",
        displayName: "AI Chat",
        description: "NAS agent",
        inputSchema: { type: "object", properties: {} },
        capabilities: ["agent"]
      },
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
  assert.equal(byId.get("diagnose_file_access").riskLevel, "low");
  assert.equal(byId.get("read_bot_job_log").riskLevel, "low");
  assert.equal(byId.get("analyze_file_content").riskLevel, "medium");
  assert.equal(byId.get("organize_files").riskLevel, "high");
  assert.equal(byId.get("organize_files").requiresConfirmation, true);
  assert.equal(byId.get("trash_files").riskLevel, "high");
  assert.equal(byId.get("trash_files").requiresConfirmation, true);
  assert.ok(byId.get("ai.chat").healthChecks.includes("ai-tool-call"));
  assert.ok(byId.get("video.analyze").healthChecks.includes("bot-queue"));
  assert.ok(byId.get("read_text_excerpt").healthChecks.includes("document-text"));
  assert.deepEqual(byId.get("diagnose_file_access").healthChecks, ["storage-root"]);
  assert.deepEqual(byId.get("read_bot_job_log").healthChecks, ["storage-root"]);
  assert.ok(byId.get("invoke_video_analyze").healthChecks.includes("bot-queue"));
  assert.ok(byId.get("analyze_file_content").healthChecks.includes("document-text"));
  assert.deepEqual(byId.get("invoke_music_control").healthChecks, ["music-bridge", "qq-music-cookie"]);
  assert.ok(byId.get("invoke_bilibili_downloader").healthChecks.includes("bilibili-auth"));
  assert.ok(byId.get("video.analyze").permissions.includes("storage:metadata:write"));
  assert.ok(byId.get("read_text_excerpt").capabilities.includes("file-excerpt"));
  assert.ok(byId.get("read_text_excerpt").permissions.includes("storage:content:read"));
  assert.ok(byId.get("update_file_metadata").permissions.includes("storage:metadata:write"));
  assert.ok(byId.get("organize_files").capabilities.includes("file-mutation"));
  assert.ok(byId.get("organize_files").permissions.includes("storage:file:move"));
  assert.ok(byId.get("trash_files").capabilities.includes("trash"));
  assert.ok(byId.get("trash_files").permissions.includes("storage:file:trash"));
  assert.ok(byId.get("invoke_bilibili_downloader").permissions.includes("network:download"));
  assert.deepEqual(byId.get("search_library_files").outputSchema.required, ["total", "files"]);
  assert.ok(byId.get("search_library_files").outputSchema.properties.actionPlan);
  assert.deepEqual(byId.get("diagnose_file_access").outputSchema.required, ["status", "found"]);
  assert.ok(byId.get("diagnose_file_access").outputSchema.properties.found);
  assert.deepEqual(byId.get("explain_file_access").outputSchema.required, ["policy", "summary", "tools"]);
  assert.equal(byId.get("explain_file_access").outputSchema.properties.summary.type, "string");
  assert.ok(byId.get("explain_file_access").outputSchema.properties.toolIds);
  assert.deepEqual(byId.get("update_file_metadata").outputSchema.required, ["operation", "results"]);
  assert.ok(byId.get("update_file_metadata").outputSchema.properties.confirmation);
  assert.deepEqual(byId.get("trash_files").outputSchema.required, ["operation", "actions"]);
  assert.ok(byId.get("trash_files").outputSchema.properties.audit);
  assert.deepEqual(byId.get("invoke_music_control").outputSchema.required, ["status", "botId", "jobId"]);
  assert.ok(byId.get("invoke_music_control").outputSchema.properties.tracking);
  assert.ok(byId.get("invoke_music_control").outputSchema.properties.prompt);
  assert.deepEqual(byId.get("invoke_bilibili_downloader").outputSchema.required, ["status", "botId", "jobId"]);
  assert.ok(byId.get("invoke_bilibili_downloader").outputSchema.properties.tracking);
  assert.ok(byId.get("video.analyze").outputSchema.properties.jobId);

  const summary = formatCapabilityPromptSummary(descriptors, {
    overall: "warn",
    checks: [
      {
        id: "storage-root",
        label: "NAS",
        status: "warn",
        detail: "C:\\Secret\\nas-data is read only",
        repairHint: "检查 C:\\Secret\\nas-data 的读写权限",
        policy: {
          storageRootOnly: true,
          allowBinaryRead: false,
          rawAbsolutePathExposed: false,
          writeRequiresConfirmation: true
        },
        fileAccess: {
          rootConfigured: true,
          exists: true,
          readable: true,
          writable: false,
          files: 42,
          directories: 7,
          indexSource: "dependency",
          indexedAt: "2026-07-02T00:00:00.000Z",
          hiddenDirsExcluded: 4,
          skippedDirectories: 2,
          storageRootOnly: true,
          allowBinaryRead: false,
          rawAbsolutePathExposed: false,
          writeRequiresConfirmation: true
        }
      }
    ]
  }, { maxItems: 28 });
  const report = formatCapabilityReport(descriptors, {
    overall: "warn",
    checks: [
      {
        id: "whisper",
        label: "Whisper",
        status: "warn",
        detail: "WHISPER_MODEL_PATH 未配置",
        repairHint: "配置 WHISPER_CPP_PATH 和 WHISPER_MODEL_PATH 后重启 storage-client"
      }
    ]
  });
  const blockedSummary = formatCapabilityPromptSummary(descriptors, {
    overall: "warn",
    checks: [
      {
        id: "whisper",
        label: "Whisper",
        status: "warn",
        detail: "WHISPER_MODEL_PATH 未配置",
        repairHint: "配置 WHISPER_CPP_PATH 和 WHISPER_MODEL_PATH 后重启 storage-client"
      }
    ]
  }, { maxItems: 28 });
  const artifact = buildCapabilityArtifactSummary(descriptors, {
    overall: "warn",
    generatedAt: "2026-07-02T00:00:00.000Z",
    checks: [
      {
        id: "whisper",
        label: "Whisper",
        status: "warn",
        detail: "D:\\Secret\\whisper model missing",
        repairHint: "配置 D:\\Secret\\whisper.exe 和 WHISPER_MODEL_PATH=sk-should-not-leak-1234567890"
      }
    ]
  });

  assert.match(summary, /search_library_files/);
  assert.match(summary, /read_media_summary/);
  assert.match(summary, /read_text_excerpt/);
  assert.match(summary, /diagnose_file_access/);
  assert.match(summary, /explain_file_access/);
  assert.match(summary, /read_bot_job_log/);
  assert.match(summary, /organize_files/);
  assert.match(summary, /trash_files/);
  assert.match(summary, /invoke_bilibili_downloader/);
  assert.match(summary, /invoke_torrent_downloader/);
  assert.match(summary, /invoke_aria2_downloader/);
  assert.match(summary, /perms=storage:index:read/);
  assert.match(summary, /caps=file-mutation/);
  assert.match(summary, /perms=storage:file:move\/storage:file:rename/);
  assert.match(summary, /perms=storage:file:move\/storage:file:trash/);
  assert.match(summary, /perms=bot:invoke\/network:download\/storage:file:write/);
  assert.match(summary, /returns=total\/files/);
  assert.match(summary, /returns=operation\/actions/);
  assert.match(summary, /returns=status\/botId\/jobId/);
  assert.match(summary, /Recommended task workflows/);
  assert.match(summary, /media-summary: search_library_files -> read_media_summary -> invoke_video_analyze -> get_bot_job_status/);
  assert.match(summary, /hasAiSummary=false/);
  assert.match(summary, /hasSubtitle=false/);
  assert.match(summary, /waitUntilPhase=transcribe\/running/);
  assert.match(summary, /document-read: search_library_files -> diagnose_file_access -> read_text_excerpt -> analyze_file_content/);
  assert.match(summary, /file-access-diagnostic: explain_file_access -> search_library_files -> diagnose_file_access/);
  assert.match(summary, /organize-files: search_library_files -> read_file_metadata -> organize_files -> trash_files/);
  assert.match(summary, /隐藏回收站/);
  assert.match(summary, /download-into-library: search_bilibili_video -> invoke_bilibili_downloader -> invoke_ytdlp_downloader -> invoke_torrent_downloader -> invoke_aria2_downloader -> search_yyets_show -> download_yyets_episodes/);
  assert.match(summary, /waitUntilPhase=download\/running/);
  assert.match(summary, /magnet\/torrent 选 invoke_torrent_downloader/);
  assert.match(summary, /failure-diagnostic: get_bot_job_status -> read_agent_trace -> read_bot_job_log/);
  assert.match(summary, /NAS file access snapshot: status=warn, rootConfigured=true, exists=true, readable=true, writable=false, indexedFiles=42, dirs=7, indexSource=dependency/);
  assert.match(summary, /hiddenDirsExcluded=4, skippedDirs=2/);
  assert.match(summary, /policy storageRootOnly=true, allowBinaryRead=false, absolutePathInput=storage-root-only, rawAbsolutePathExposed=false, writeRequiresConfirmation=true/);
  assert.match(summary, /fix=检查 \[local-path\] 的读写权限/);
  assert.match(summary, /\[local-path\]/);
  assert.doesNotMatch(summary, /C:\\Secret/);
  assert.match(blockedSummary, /invoke_video_analyze: status=warn, ready=blocked, blocker=whisper/);
  assert.match(blockedSummary, /media-summary: .*invoke_video_analyze:blocked\(whisper\)/);
  const videoAnalyzeArtifact = artifact.capabilities.find((item) => item.id === "invoke_video_analyze");
  assert.equal(videoAnalyzeArtifact.status, "blocked");
  assert.equal(videoAnalyzeArtifact.readiness.ready, false);
  assert.equal(videoAnalyzeArtifact.readiness.blocker.id, "whisper");
  assert.match(videoAnalyzeArtifact.readiness.detail, /\[local-path\]/);
  assert.doesNotMatch(videoAnalyzeArtifact.readiness.detail, /D:\\Secret/);
  assert.doesNotMatch(JSON.stringify(videoAnalyzeArtifact), /sk-should-not-leak/);
  assert.ok(videoAnalyzeArtifact.output.required.includes("status"));
  const mediaWorkflow = artifact.workflows.find((item) => item.id === "media-summary");
  assert.equal(mediaWorkflow.blocked, true);
  assert.equal(mediaWorkflow.steps.find((step) => step.id === "invoke_video_analyze").status, "blocked");
  assert.equal(mediaWorkflow.steps.find((step) => step.id === "invoke_video_analyze").blockerId, "whisper");
  assert.match(report, /video\.analyze/);
  assert.match(report, /\[blocked\] video\.analyze/);
  assert.match(report, /invoke_video_analyze · .*ready=no · blockedBy=whisper/);
  assert.match(report, /阻断: Whisper: WHISPER_MODEL_PATH 未配置/);
  assert.match(report, /perms=storage:content:read/);
  assert.match(report, /caps=file-mutation/);
  assert.match(report, /perms=storage:file:move, storage:file:rename/);
  assert.match(report, /perms=storage:file:move, storage:file:trash/);
  assert.match(report, /returns=operation, actions/);
  assert.match(report, /returns=status, botId, jobId/);
  assert.match(report, /常用工作流/);
  assert.match(report, /media-summary · Summarize NAS video\/audio: search_library_files -> read_media_summary -> invoke_video_analyze -> get_bot_job_status/);
  assert.match(report, /状态: .*invoke_video_analyze:blocked\(whisper\)/);
  assert.match(report, /hasAiSummary=false/);
  assert.match(report, /waitUntilPhase=transcribe\/running/);
  assert.match(report, /download-into-library · Download into NAS library: search_bilibili_video -> invoke_bilibili_downloader -> invoke_ytdlp_downloader -> invoke_torrent_downloader -> invoke_aria2_downloader -> search_yyets_show -> download_yyets_episodes/);
  assert.match(report, /failure-diagnostic · Diagnose bot or agent failure: get_bot_job_status -> read_agent_trace -> read_bot_job_log/);
  assert.match(report, /建议\(Whisper\): 配置 WHISPER_CPP_PATH 和 WHISPER_MODEL_PATH/);

  const queueReport = formatCapabilityReport(descriptors, {
    overall: "warn",
    checks: [
      {
        id: "bot-queue",
        label: "Bot 队列",
        status: "warn",
        detail: "running=2 queued=1 failedLastHour=0 checked=3",
        repairHint: "运行 @ai /jobs 查看排队和失败任务"
      }
    ]
  });
  assert.match(queueReport, /invoke_video_analyze/);
  assert.match(queueReport, /\[warn\] invoke_video_analyze · .*ready=yes/);
  assert.match(queueReport, /建议\(Bot 队列\): 运行 @ai \/jobs 查看排队和失败任务/);
});
