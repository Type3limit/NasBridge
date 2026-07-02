import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildAvailableModelChoices,
  buildUseListedModelText,
  filterModelsByCapability
} from "../../src/bot/plugins/ai-chat/formatters/models.js";
import {
  migrateStoredModelRef,
  readAiModelSettings
} from "../../src/bot/plugins/ai-chat/services/modelSettings.js";
import {
  normalizeModelFilter,
  parseModelDirective
} from "../../src/bot/plugins/ai-chat/parsers/modelDirectives.js";
import {
  encodeModelRef,
  invokeTextModel,
  invokeTextModelStream,
  parseModelRef,
  resolveModelReference
} from "../../src/bot/tools/llmClient.js";

const cachedModels = [
  {
    id: "openai::deepseek-v4-pro",
    modelId: "deepseek-v4-pro",
    provider: "openai",
    name: "DeepSeek V4 Pro",
    vendor: "OpenAI Compatible",
    toolCalls: false,
    vision: false
  },
  {
    id: "openai::gpt-4.1-2025-04-14",
    modelId: "gpt-4.1-2025-04-14",
    provider: "openai",
    name: "GPT 4.1",
    vendor: "OpenAI Compatible",
    toolCalls: true,
    vision: true
  }
];

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

test("model directive parser recognizes model commands and filters", () => {
  assert.deepEqual(parseModelDirective("/model use 2").command, {
    type: "use-listed-model",
    index: 2
  });
  assert.deepEqual(parseModelDirective("/models tool-calls").command, {
    type: "list-models",
    filter: "tool-calls"
  });
  assert.deepEqual(parseModelDirective("/models refresh").command, {
    type: "list-models",
    filter: "all",
    refresh: true
  });
  assert.deepEqual(parseModelDirective("/models tool-calls refresh").command, {
    type: "list-models",
    filter: "tool-calls",
    refresh: true
  });
  assert.deepEqual(parseModelDirective("/model list 刷新 vision").command, {
    type: "list-models",
    filter: "vision",
    refresh: true
  });
  assert.deepEqual(parseModelDirective("/smoke").command, {
    type: "smoke"
  });
  assert.deepEqual(parseModelDirective("/agent smoke").command, {
    type: "smoke"
  });
  assert.deepEqual(parseModelDirective("/access").command, {
    type: "file-access",
    kind: "summary"
  });
  assert.deepEqual(parseModelDirective("/file-access tools").command, {
    type: "file-access",
    kind: "tools"
  });
  assert.deepEqual(parseModelDirective("/trace botjob_demo").command, {
    type: "trace",
    jobId: "botjob_demo"
  });
  assert.deepEqual(parseModelDirective("/agent trace").command, {
    type: "trace",
    jobId: ""
  });
  assert.deepEqual(parseModelDirective("/jobs 3").command, {
    type: "jobs",
    jobId: "",
    limit: 3
  });
  assert.deepEqual(parseModelDirective("/job botjob_demo").command, {
    type: "jobs",
    jobId: "botjob_demo",
    limit: 1
  });
  assert.deepEqual(parseModelDirective("/log botjob_demo").command, {
    type: "log",
    jobId: "botjob_demo"
  });
  assert.deepEqual(parseModelDirective("/job log botjob_demo").command, {
    type: "log",
    jobId: "botjob_demo"
  });
  assert.deepEqual(parseModelDirective("/model set DeepSeek V4 Pro").command, {
    type: "set",
    model: "DeepSeek V4 Pro"
  });
  assert.deepEqual(parseModelDirective("/model set-all openai::deepseek-v4-pro").command, {
    type: "set-all",
    model: "openai::deepseek-v4-pro"
  });
  assert.deepEqual(parseModelDirective("--model=openai::deepseek-v4-pro summarize this"), {
    prompt: "summarize this",
    modelOverride: "openai::deepseek-v4-pro",
    inspectOnly: false,
    command: null
  });
  assert.equal(normalizeModelFilter("vision"), "vision");
  assert.equal(normalizeModelFilter("工具调用"), "tool-calls");
});

test("model references preserve provider-qualified execution ids", () => {
  assert.equal(encodeModelRef("openai", "deepseek-v4-pro"), "openai::deepseek-v4-pro");
  assert.deepEqual(parseModelRef("openai::deepseek-v4-pro"), {
    provider: "openai",
    modelId: "deepseek-v4-pro",
    qualified: true
  });
  assert.deepEqual(parseModelRef("DeepSeek V4 Pro"), {
    provider: "",
    modelId: "DeepSeek V4 Pro",
    qualified: false
  });
});

test("resolveModelReference maps display names to real cached model ids without remote fetch", async () => {
  const byDisplayName = await resolveModelReference("DeepSeek V4 Pro", {
    cachedModels,
    fetchModels: false
  });
  assert.equal(byDisplayName.ok, true);
  assert.equal(byDisplayName.modelRef, "openai::deepseek-v4-pro");
  assert.equal(byDisplayName.model.modelId, "deepseek-v4-pro");

  const byLooseName = await resolveModelReference("deepseek v4 pro", {
    cachedModels,
    fetchModels: false
  });
  assert.equal(byLooseName.ok, true);
  assert.equal(byLooseName.modelRef, "openai::deepseek-v4-pro");

  const missing = await resolveModelReference("DeepSeek V4 Plus", {
    cachedModels,
    fetchModels: false
  });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /没有找到匹配模型/);
});

test("stored model settings migrate display names to executable model refs", async () => {
  assert.equal(migrateStoredModelRef("DeepSeek V4 Pro", cachedModels), "openai::deepseek-v4-pro");
  assert.equal(migrateStoredModelRef("deepseek-v4-pro", cachedModels), "openai::deepseek-v4-pro");
  assert.equal(migrateStoredModelRef("openai::gpt-4.1-2025-04-14", cachedModels), "openai::gpt-4.1-2025-04-14");

  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-model-settings-"));
  try {
    await fs.writeFile(path.join(appDataRoot, "ai-model-settings.json"), JSON.stringify({
      textModel: "DeepSeek V4 Pro",
      multimodalModel: "GPT 4.1",
      lastListedModels: cachedModels
    }), "utf8");
    const settings = await readAiModelSettings(appDataRoot);
    assert.equal(settings.textModel, "openai::deepseek-v4-pro");
    assert.equal(settings.multimodalModel, "openai::gpt-4.1-2025-04-14");
  } finally {
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test("model choices use list indexes while preserving actual model ids in state text", () => {
  const settings = {
    textModel: "openai::deepseek-v4-pro",
    multimodalModel: "openai::gpt-4.1-2025-04-14"
  };

  const choices = buildAvailableModelChoices(cachedModels, settings);
  assert.deepEqual(choices.map((choice) => choice.command), [
    "@ai /model use 1",
    "@ai /model use 2"
  ]);
  assert.equal(choices[0].modelId, "deepseek-v4-pro");
  assert.equal(choices[0].isTextDefault, true);
  assert.equal(choices[1].isVisionDefault, true);

  const usage = buildUseListedModelText(cachedModels[0], {
    textModel: cachedModels[0].id,
    multimodalModel: settings.multimodalModel
  }, "all");
  assert.match(usage, /openai::deepseek-v4-pro/);
  assert.doesNotMatch(usage, /DeepSeek V4 Pro 被保存/);
});

test("model capability filters separate tool-call and vision models", () => {
  assert.deepEqual(filterModelsByCapability(cachedModels, "tool-calls").map((model) => model.id), [
    "openai::gpt-4.1-2025-04-14"
  ]);
  assert.deepEqual(filterModelsByCapability(cachedModels, "vision").map((model) => model.id), [
    "openai::gpt-4.1-2025-04-14"
  ]);
  assert.equal(filterModelsByCapability(cachedModels, "all").length, 2);
});

test("stream model errors include actionable model repair hints", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    body: null,
    text: async () => JSON.stringify({
      error: {
        message: "Model DeepSeek V4 Pro is not supported"
      }
    })
  });
  try {
    await withEnv({
      AI_PROVIDER: "openai",
      OPENAI_BASE_URL: "https://example.invalid/v1",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "DeepSeek V4 Pro"
    }, async () => {
      await assert.rejects(
        () => invokeTextModelStream({
          model: "openai::DeepSeek V4 Pro",
          messages: [{ role: "user", content: "hello" }]
        }),
        (error) => {
          const message = String(error?.message || "");
          assert.match(message, /AI model stream failed/);
          assert.match(message, /当前请求模型=openai::DeepSeek V4 Pro/);
          assert.match(message, /provider=OpenAI Compatible/);
          assert.match(message, /疑似展示名|可能是展示名/);
          assert.match(message, /@ai \/models refresh/);
          assert.match(message, /@ai \/model use <序号>/);
          assert.match(message, /provider::modelId/);
          return true;
        }
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-stream model errors include display-name repair hints", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    statusText: "Not Found",
    text: async () => JSON.stringify({
      error: {
        message: "model does not exist: DeepSeek V4 Pro"
      }
    })
  });
  try {
    await withEnv({
      AI_PROVIDER: "openai",
      OPENAI_BASE_URL: "https://example.invalid/v1",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "DeepSeek V4 Pro"
    }, async () => {
      await assert.rejects(
        () => invokeTextModel({
          model: "openai::DeepSeek V4 Pro",
          messages: [{ role: "user", content: "hello" }]
        }),
        (error) => {
          const message = String(error?.message || "");
          assert.match(message, /AI model request failed/);
          assert.match(message, /当前请求模型=openai::DeepSeek V4 Pro/);
          assert.match(message, /模型不存在|未出现在当前 provider/);
          assert.match(message, /可能是展示名/);
          assert.match(message, /@ai \/models refresh/);
          assert.match(message, /@ai \/model set provider::modelId/);
          assert.doesNotMatch(message, /sk-test/);
          return true;
        }
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
