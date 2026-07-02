import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMultimodalImagePlugin } from "../../src/bot/plugins/multimodal-image.js";

async function withTempStorage(fn) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-vision-bot-"));
  try {
    return await fn(storageRoot);
  } finally {
    await fs.rm(storageRoot, { recursive: true, force: true });
  }
}

async function writeAttachment(storageRoot, relativePath = ".nas-chat-room/attachments/demo.png") {
  const absolutePath = path.join(storageRoot, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, Buffer.from("fake-png-content"));
  return {
    id: `client:${relativePath}`,
    name: path.basename(relativePath),
    mimeType: "image/png",
    size: 16,
    path: relativePath,
    clientId: "client",
    kind: "image"
  };
}

function createFakeApi(storageRoot, overrides = {}) {
  const progress = [];
  const logs = [];
  const visionCalls = [];
  return {
    storageRoot,
    appDataRoot: path.join(storageRoot, ".nas-bot"),
    signal: null,
    progress,
    logs,
    visionCalls,
    appendLog: async (line) => logs.push(line),
    emitProgress: async (event) => progress.push(event),
    throwIfCancelled: () => {},
    createChatReply: (payload = {}) => ({
      id: "bot-status:vision",
      text: payload.text || "",
      card: payload.card || null
    }),
    dependencies: {
      invokeMultimodalModel: async (options) => {
        visionCalls.push(options);
        return {
          text: "这张图里有一个测试对象。",
          model: "openai::vision-test"
        };
      }
    },
    ...overrides
  };
}

test("multimodal image bot analyzes current chat image attachments", async () => {
  await withTempStorage(async (storageRoot) => {
    const attachment = await writeAttachment(storageRoot);
    const plugin = createMultimodalImagePlugin();
    const api = createFakeApi(storageRoot);

    const result = await plugin.execute({
      trigger: {
        rawText: "@vision 看看这张图有什么",
        parsedArgs: {
          prompt: "看看这张图有什么",
          detail: "high",
          maxTokens: 600
        }
      },
      chat: {
        hostClientId: "client",
        historyPath: ".nas-chat-room/history/2026-07-03.jsonl"
      },
      attachments: [attachment]
    }, api);

    assert.equal(result.chatReply.text, "这张图里有一个测试对象。");
    assert.equal(result.chatReply.card.type, "image-analysis");
    assert.equal(result.chatReply.card.title, "AI 看图结果");
    assert.equal(result.artifacts[0].type, "vision");
    assert.equal(result.artifacts[0].imageCount, 1);
    assert.equal(result.artifacts[0].model, "openai::vision-test");
    assert.equal(result.artifacts[0].images[0].name, "demo.png");
    assert.equal(api.visionCalls.length, 1);
    assert.equal(api.visionCalls[0].imageInputs.length, 1);
    assert.equal(api.visionCalls[0].imageInputs[0].detail, "high");
    assert.match(api.visionCalls[0].imageInputs[0].dataUrl, /^data:image\/png;base64,/);
    assert.match(api.visionCalls[0].userPrompt, /看看这张图有什么/);
    assert.match(api.visionCalls[0].systemPrompt, /NasBridge 的多模态图片分析 bot/);
    assert.equal(api.visionCalls[0].maxTokens, 600);
    assert.ok(api.progress.some((event) => event.phase === "analyze"));
    assert.doesNotMatch(JSON.stringify(result.artifacts), new RegExp(storageRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("multimodal image bot can use a recent chat image when current message has none", async () => {
  await withTempStorage(async (storageRoot) => {
    const attachment = await writeAttachment(storageRoot, ".nas-chat-room/attachments/recent.png");
    const historyPath = ".nas-chat-room/history/2026-07-03.jsonl";
    const absoluteHistoryPath = path.join(storageRoot, ...historyPath.split("/"));
    await fs.mkdir(path.dirname(absoluteHistoryPath), { recursive: true });
    await fs.writeFile(absoluteHistoryPath, `${JSON.stringify({
      id: "msg_recent_image",
      text: "上一张图片",
      hostClientId: "client",
      createdAt: new Date().toISOString(),
      attachments: [attachment]
    })}\n`, "utf8");

    const plugin = createMultimodalImagePlugin();
    const api = createFakeApi(storageRoot);
    const result = await plugin.execute({
      trigger: {
        rawText: "@vision 继续分析刚才那张图",
        parsedArgs: {}
      },
      chat: {
        hostClientId: "client",
        historyPath
      },
      attachments: []
    }, api);

    assert.equal(result.artifacts[0].imageCount, 1);
    assert.equal(result.artifacts[0].images[0].name, "recent.png");
    assert.match(api.visionCalls[0].userPrompt, /基于最近图片附件/);
  });
});

test("multimodal image bot fails clearly when no image is available", async () => {
  await withTempStorage(async (storageRoot) => {
    const plugin = createMultimodalImagePlugin();
    const api = createFakeApi(storageRoot);

    await assert.rejects(
      () => plugin.execute({
        trigger: {
          rawText: "@vision 分析图片",
          parsedArgs: {}
        },
        chat: {
          hostClientId: "client",
          historyPath: ""
        },
        attachments: []
      }, api),
      /没有找到可供分析的聊天图片/
    );
    assert.equal(api.visionCalls.length, 0);
  });
});
