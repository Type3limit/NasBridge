import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAvailableModelChoices,
  buildUseListedModelText,
  filterModelsByCapability
} from "../../src/bot/plugins/ai-chat/formatters/models.js";
import {
  normalizeModelFilter,
  parseModelDirective
} from "../../src/bot/plugins/ai-chat/parsers/modelDirectives.js";
import {
  encodeModelRef,
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

test("model directive parser recognizes model commands and filters", () => {
  assert.deepEqual(parseModelDirective("/model use 2").command, {
    type: "use-listed-model",
    index: 2
  });
  assert.deepEqual(parseModelDirective("/models tool-calls").command, {
    type: "list-models",
    filter: "tool-calls"
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
