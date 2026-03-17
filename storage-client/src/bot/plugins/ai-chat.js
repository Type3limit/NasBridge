import fs from "node:fs";
import { readRecentChatHistory } from "../tools/chatHistory.js";
import { listReferencedChatAttachments } from "../tools/chatAssets.js";
import { getDefaultMultimodalModelName, getDefaultTextModelName, invokeTextModel, invokeTextModelStream, invokeMultimodalModelStream, listAvailableModels } from "../tools/llmClient.js";
import { executeAiToolCall, getAiToolDefinitions } from "../tools/aiToolRuntime.js";
import { createBotPlugin } from "./base.js";
import { createBotJobMessageId } from "../context.js";

const MAX_RECENT_MESSAGES = 24;
const MAX_CONTEXT_MESSAGES = 16;
const MAX_VISION_IMAGES = 3;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CARD_BODY_LENGTH = 1800;
const MAX_TOOL_ROUNDS = 4;
const AI_MODEL_SETTINGS_FILE_NAME = "ai-model-settings.json";

function createEmptyModelCatalogState() {
  return {
    lastListedModels: [],
    lastListFilter: "all"
  };
}

function stripSelfMention(rawText = "") {
  return String(rawText || "").replace(/^\s*@(?:ai|assistant)\b\s*/i, "").trim();
}

function isImageAttachment(attachment) {
  return /^image\//i.test(String(attachment?.mimeType || ""));
}

function wantsSummary(prompt = "") {
  return /总结|摘要|summary|summari[sz]e/i.test(String(prompt || ""));
}

function wantsVision(prompt = "", attachments = []) {
  if (attachments.some((item) => isImageAttachment(item))) {
    return true;
  }
  return /看图|识图|describe image|analy[sz]e image|图片|image|截图|照片|photo/i.test(String(prompt || ""));
}

function toRole(message = {}) {
  if (String(message?.author?.id || "").startsWith("bot:ai.chat")) {
    return "assistant";
  }
  return "user";
}

function summarizeAttachments(attachments = []) {
  return attachments.map((item) => `${item.name} (${item.mimeType || item.kind || "file"})`).join(", ");
}

function compactMessageText(message = {}) {
  const author = String(message?.author?.displayName || "用户").trim();
  const text = String(message?.text || "").trim();
  const cardText = String(message?.card?.body || message?.card?.title || "").trim();
  const parts = [text || cardText];
  if (Array.isArray(message?.attachments) && message.attachments.length) {
    parts.push(`附件: ${summarizeAttachments(message.attachments)}`);
  }
  return `${author}: ${parts.filter(Boolean).join(" | ")}`.trim();
}

function buildHistoryMessages(messages = []) {
  return messages
    .filter((message) => message?.text || message?.card?.body || (Array.isArray(message?.attachments) && message.attachments.length))
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message) => ({
      role: toRole(message),
      content: compactMessageText(message)
    }));
}

function findNestedBotInvocation(prompt = "", catalog = []) {
  const matched = /^@([a-z0-9._-]+)\b/i.exec(String(prompt || "").trim());
  if (!matched?.[1]) {
    return null;
  }
  const alias = matched[1].toLowerCase();
  const target = catalog.find((item) => item.botId !== "ai.chat" && ([item.botId, ...(item.aliases || [])].map((value) => String(value || "").toLowerCase()).includes(alias)));
  if (!target) {
    return null;
  }
  const remainingPrompt = String(prompt || "").trim().replace(/^@[a-z0-9._-]+\b\s*/i, "").trim();
  const bilibiliSourceMatch = remainingPrompt.match(/https?:\/\/\S+|\bBV[0-9A-Za-z]+\b/i);
  return {
    target,
    rawText: remainingPrompt,
    parsedArgs: bilibiliSourceMatch?.[0] ? { source: bilibiliSourceMatch[0] } : {}
  };
}

async function toDataUrl(attachment) {
  const mimeType = String(attachment?.mimeType || "image/jpeg").trim() || "image/jpeg";
  const stat = await fs.promises.stat(attachment.absolutePath);
  if (Number(stat.size || 0) > MAX_INLINE_IMAGE_BYTES) {
    throw new Error(`图片 ${attachment.name} 超过 ${(MAX_INLINE_IMAGE_BYTES / (1024 * 1024)).toFixed(0)}MB，暂不发送给多模态模型`);
  }
  const content = await fs.promises.readFile(attachment.absolutePath);
  return `data:${mimeType};base64,${content.toString("base64")}`;
}

function createAnswerCard(answer, model, mode = "text") {
  return {
    type: mode === "multimodal" ? "image-analysis" : "ai-answer",
    status: "succeeded",
    title: mode === "multimodal" ? "AI 看图结果" : "AI 回答",
    subtitle: model ? `模型: ${model}` : "",
    body: String(answer || "").slice(0, MAX_CARD_BODY_LENGTH)
  };
}

function getAiModelSettingsPath(appDataRoot = "") {
  return `${String(appDataRoot || "").replace(/[\\/]+$/, "")}/${AI_MODEL_SETTINGS_FILE_NAME}`;
}

async function readAiModelSettings(appDataRoot = "") {
  try {
    const raw = await fs.promises.readFile(getAiModelSettingsPath(appDataRoot), "utf8");
    const parsed = JSON.parse(raw);
    return {
      textModel: String(parsed?.textModel || "").trim(),
      multimodalModel: String(parsed?.multimodalModel || "").trim(),
      lastListedModels: Array.isArray(parsed?.lastListedModels)
        ? parsed.lastListedModels.map((item) => ({
            id: String(item?.id || "").trim(),
            name: String(item?.name || item?.id || "").trim(),
            vendor: String(item?.vendor || "").trim(),
            preview: item?.preview === true,
            toolCalls: item?.toolCalls === true,
            vision: item?.vision === true
          })).filter((item) => item.id)
        : [],
      lastListFilter: String(parsed?.lastListFilter || "all").trim() || "all"
    };
  } catch {
    return {
      textModel: "",
      multimodalModel: "",
      ...createEmptyModelCatalogState()
    };
  }
}

async function writeAiModelSettings(appDataRoot = "", settings = {}) {
  await fs.promises.mkdir(String(appDataRoot || ""), { recursive: true });
  await fs.promises.writeFile(
    getAiModelSettingsPath(appDataRoot),
    `${JSON.stringify({
      textModel: String(settings?.textModel || "").trim(),
      multimodalModel: String(settings?.multimodalModel || "").trim(),
      lastListedModels: Array.isArray(settings?.lastListedModels)
        ? settings.lastListedModels.map((item) => ({
            id: String(item?.id || "").trim(),
            name: String(item?.name || item?.id || "").trim(),
            vendor: String(item?.vendor || "").trim(),
            preview: item?.preview === true,
            toolCalls: item?.toolCalls === true,
            vision: item?.vision === true
          })).filter((item) => item.id)
        : [],
      lastListFilter: String(settings?.lastListFilter || "all").trim() || "all"
    }, null, 2)}\n`,
    "utf8"
  );
}

function getEffectiveTextModel(settings = {}) {
  return String(settings?.textModel || "").trim() || getDefaultTextModelName() || "";
}

function getEffectiveMultimodalModel(settings = {}) {
  return String(settings?.multimodalModel || "").trim()
    || String(settings?.textModel || "").trim()
    || getDefaultMultimodalModelName()
    || getDefaultTextModelName()
    || "";
}

function normalizeModelFilter(rawValue = "") {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value || value === "all" || value === "全部") {
    return "all";
  }
  if (["tool", "tools", "tool-call", "tool-calls", "function", "functions", "工具", "工具调用"].includes(value)) {
    return "tool-calls";
  }
  if (["vision", "image", "multimodal", "看图", "视觉", "图片"].includes(value)) {
    return "vision";
  }
  return "all";
}

function getModelFilterLabel(filter = "all") {
  if (filter === "tool-calls") {
    return "仅支持 tool-calls";
  }
  if (filter === "vision") {
    return "仅支持视觉";
  }
  return "全部模型";
}

function filterModelsByCapability(models = [], filter = "all") {
  if (filter === "tool-calls") {
    return models.filter((model) => model.toolCalls);
  }
  if (filter === "vision") {
    return models.filter((model) => model.vision);
  }
  return models;
}

function sortModelsForDisplay(models = []) {
  return [...models].sort((left, right) => {
    const vendorCompare = String(left.vendor || "未标记 vendor").localeCompare(String(right.vendor || "未标记 vendor"), "zh-Hans-CN", { sensitivity: "base" });
    if (vendorCompare !== 0) {
      return vendorCompare;
    }
    return String(left.id || "").localeCompare(String(right.id || ""), "zh-Hans-CN", { sensitivity: "base" });
  });
}

function groupModelsByVendor(models = []) {
  const groups = new Map();
  for (const model of sortModelsForDisplay(models)) {
    const vendor = String(model.vendor || "未标记 vendor").trim() || "未标记 vendor";
    if (!groups.has(vendor)) {
      groups.set(vendor, []);
    }
    groups.get(vendor).push(model);
  }
  return groups;
}

function parseModelDirective(rawPrompt = "") {
  const prompt = String(rawPrompt || "").trim();
  if (!prompt) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: null
    };
  }

  if (/^\/model\s*$/i.test(prompt)) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: true,
      command: null
    };
  }

  const useCommand = prompt.match(/^\/model\s+use\s+(\d+)\s*$/i);
  if (useCommand?.[1]) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: {
        type: "use-listed-model",
        index: Number.parseInt(useCommand[1], 10)
      }
    };
  }

  const listCommand = prompt.match(/^\/(?:models|model\s+list)(?:\s+([^\s]+))?\s*$/i);
  if (listCommand) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: {
        type: "list-models",
        filter: normalizeModelFilter(listCommand[1] || "")
      }
    };
  }

  const setAllCommand = prompt.match(/^\/model\s+set-all\s+([^\s]+)\s*$/i);
  if (setAllCommand?.[1]) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: {
        type: "set-all",
        model: String(setAllCommand[1] || "").trim()
      }
    };
  }

  const setVisionCommand = prompt.match(/^\/model\s+set-vision\s+([^\s]+)\s*$/i);
  if (setVisionCommand?.[1]) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: {
        type: "set-vision",
        model: String(setVisionCommand[1] || "").trim()
      }
    };
  }

  const setCommand = prompt.match(/^\/model\s+set\s+([^\s]+)\s*$/i);
  if (setCommand?.[1]) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: {
        type: "set",
        model: String(setCommand[1] || "").trim()
      }
    };
  }

  if (/^\/model\s+reset-vision\s*$/i.test(prompt)) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: {
        type: "reset-vision"
      }
    };
  }

  if (/^\/model\s+reset\s*$/i.test(prompt)) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: {
        type: "reset"
      }
    };
  }

  const inlineOption = prompt.match(/^--model(?:=|\s+)([^\s]+)(?:\s+([\s\S]*))?$/i);
  if (inlineOption?.[1]) {
    return {
      prompt: String(inlineOption[2] || "").trim(),
      modelOverride: String(inlineOption[1] || "").trim(),
      inspectOnly: false,
      command: null
    };
  }

  const slashCommand = prompt.match(/^\/(?:model|use-model)\s+([^\s]+)(?:\s+([\s\S]*))?$/i);
  if (slashCommand?.[1]) {
    return {
      prompt: String(slashCommand[2] || "").trim(),
      modelOverride: String(slashCommand[1] || "").trim(),
      inspectOnly: false,
      command: null
    };
  }

  return {
    prompt,
    modelOverride: "",
    inspectOnly: false,
    command: null
  };
}

function buildModelUsageText(settings = {}) {
  const envTextModel = getDefaultTextModelName() || "未配置";
  const envMultimodalModel = getDefaultMultimodalModelName() || envTextModel;
  const textModel = getEffectiveTextModel(settings) || "未配置";
  const multimodalModel = getEffectiveMultimodalModel(settings) || textModel;
  return [
    `当前文本模型：${textModel}`,
    `当前看图模型：${multimodalModel}`,
    `环境默认文本模型：${envTextModel}`,
    `环境默认看图模型：${envMultimodalModel}`,
    "全局切换方法：",
    "- @ai /model set <模型名>",
    "- @ai /model set-all <模型名>",
    "- @ai /model set-vision <模型名>",
    "- @ai /model reset",
    "- @ai /model use <列表序号>",
    "查看模型列表：",
    "- @ai /models",
    "- @ai /models tool-calls",
    "- @ai /models vision",
    "临时切换方法：",
    "- @ai /model <模型名> 你的问题",
    "- @ai --model=<模型名> 你的问题"
  ].join("\n");
}

function buildAvailableModelsText(models = [], settings = {}, filter = "all") {
  const currentTextModel = getEffectiveTextModel(settings) || "";
  const currentMultimodalModel = getEffectiveMultimodalModel(settings) || "";
  if (!models.length) {
    return [
      `当前 provider 在“${getModelFilterLabel(filter)}”下没有返回任何模型。`,
      "你可以直接访问 /v1/models 检查代理是否正常。"
    ].join("\n");
  }
  const lines = [
    `筛选: ${getModelFilterLabel(filter)}`,
    "使用方式: @ai /model use <列表序号>",
    ""
  ];
  let globalIndex = 0;
  for (const [vendor, vendorModels] of groupModelsByVendor(models)) {
    lines.push(`【${vendor}】`);
    for (const model of vendorModels) {
      globalIndex += 1;
      const tags = [];
      if (model.id === currentTextModel) {
        tags.push("当前文本默认");
      }
      if (model.id === currentMultimodalModel) {
        tags.push("当前看图默认");
      }
      if (model.toolCalls) {
        tags.push("tool-calls");
      }
      if (model.vision) {
        tags.push("vision");
      }
      if (model.preview) {
        tags.push("preview");
      }
      const modelLabel = model.name && model.name !== model.id ? `${model.id} (${model.name})` : model.id;
      lines.push(`${globalIndex}. ${modelLabel}${tags.length ? ` [${tags.join(" | ")}]` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function buildUseListedModelText(selectedModel = {}, nextSettings = {}, filter = "all") {
  return [
    `已切换默认文本模型：${getEffectiveTextModel(nextSettings) || "未配置"}`,
    `当前默认看图模型：${getEffectiveMultimodalModel(nextSettings) || "未配置"}`,
    `来自最近一次模型列表：${getModelFilterLabel(filter)}`,
    selectedModel.vision ? "该模型支持视觉，已在不覆盖独立看图设置的前提下联动更新。" : "该模型未标记为视觉模型，仅更新文本默认模型。"
  ].join("\n");
}

async function runToolAwareConversation({ systemPrompt, effectivePrompt, historyMessages, recentMessages, context, api, modelOverride = "", defaultTextModel = "" }) {
  const tools = getAiToolDefinitions();
  const messages = [
    { role: "system", content: systemPrompt },
    ...historyMessages,
    { role: "user", content: effectivePrompt }
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const result = await invokeTextModel({
      model: modelOverride || defaultTextModel || undefined,
      messages,
      tools,
      toolChoice: "auto",
      maxTokens: 1000,
      temperature: 0.25
    });

    if (!Array.isArray(result.toolCalls) || !result.toolCalls.length) {
      return {
        planningMessages: messages,
        result
      };
    }

    messages.push({
      role: "assistant",
      content: result.message?.content || "",
      tool_calls: result.message?.tool_calls || result.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.input || {})
        }
      }))
    });

    for (const toolCall of result.toolCalls) {
      await api.appendLog(`tool-call ${toolCall.name}: ${JSON.stringify(toolCall.input || {})}`);
      const toolResult = await executeAiToolCall(toolCall, context, api, { recentMessages });
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult
      });
    }
  }

  throw new Error("AI tool-call exceeded max rounds");
}

async function streamFinalAnswer({ planningMessages, api, replyMessageId, mode = "text", modelOverride = "", defaultTextModel = "" }) {
  let latestText = "";
  let latestPublishedAt = 0;
  const minPublishIntervalMs = 120;

  async function flushDraft(force = false) {
    if (!latestText.trim()) {
      return;
    }
    const now = Date.now();
    if (!force && now - latestPublishedAt < minPublishIntervalMs) {
      return;
    }
    latestPublishedAt = now;
    await api.publishTransientChatReply({
      id: replyMessageId,
      text: latestText,
      card: {
        type: mode === "multimodal" ? "image-analysis" : "ai-answer",
        status: "running",
        title: mode === "multimodal" ? "AI 看图中" : "AI 正在回复",
        subtitle: "流式生成中",
        actions: [{ type: "cancel-bot-job", label: "停止生成" }]
      }
    });
  }

  const streamResult = await invokeTextModelStream({
    model: modelOverride || defaultTextModel || undefined,
    messages: planningMessages,
    signal: api.signal,
    maxTokens: 1200,
    temperature: 0.35
  }, {
    onText: async ({ text }) => {
      latestText = text;
      await flushDraft(false);
    }
  });

  await flushDraft(true);
  return {
    answer: String(streamResult.text || latestText || "").trim(),
    model: streamResult.model || ""
  };
}

async function streamVisionAnswer({ systemPrompt, visionPrompt, historyMessages, imageInputs, api, replyMessageId, modelOverride = "", defaultMultimodalModel = "" }) {
  let latestText = "";
  let latestPublishedAt = 0;
  const minPublishIntervalMs = 120;

  async function flushDraft(force = false) {
    if (!latestText.trim()) {
      return;
    }
    const now = Date.now();
    if (!force && now - latestPublishedAt < minPublishIntervalMs) {
      return;
    }
    latestPublishedAt = now;
    await api.publishTransientChatReply({
      id: replyMessageId,
      text: latestText,
      card: {
        type: "image-analysis",
        status: "running",
        title: "AI 看图中",
        subtitle: "流式生成中",
        actions: [{ type: "cancel-bot-job", label: "停止生成" }]
      }
    });
  }

  const streamResult = await invokeMultimodalModelStream({
    model: modelOverride || defaultMultimodalModel || undefined,
    systemPrompt,
    userPrompt: visionPrompt,
    historyMessages,
    imageInputs,
    signal: api.signal,
    maxTokens: 1100
  }, {
    onText: async ({ text }) => {
      latestText = text;
      await flushDraft(false);
    }
  });

  await flushDraft(true);
  return {
    answer: String(streamResult.text || latestText || "").trim(),
    model: streamResult.model || ""
  };
}

export function createAiChatPlugin() {
  return createBotPlugin({
    botId: "ai.chat",
    displayName: "AI Chat",
    aliases: ["ai", "assistant"],
    description: "Read compact room context, answer questions, summarize chat, analyze images, and delegate to other bots.",
    capabilities: ["reply.chat", "llm.text", "llm.multimodal", "tool-call", "delegate.bot"],
    permissions: {
      readChatHistory: true,
      readChatAttachments: true,
      llm: true,
      multimodal: true,
      replyChat: true,
      publishJobEvents: true
    },
    limits: {
      maxConcurrentJobs: 1,
      timeoutMs: 15 * 60 * 1000
    },
    async execute(context, api) {
      api.throwIfCancelled();
      const prompt = stripSelfMention(context.trigger.rawText || "");
      const modelDirective = parseModelDirective(prompt);
      const modelSettings = await readAiModelSettings(api.appDataRoot);
      const effectivePrompt = modelDirective.prompt || (context.attachments?.some((item) => isImageAttachment(item)) ? "请描述这张图片并给出关键信息。" : "请结合最近聊天上下文回答。" );
      const modelOverride = String(modelDirective.modelOverride || "").trim();
      const defaultTextModel = getEffectiveTextModel(modelSettings);
      const defaultMultimodalModel = getEffectiveMultimodalModel(modelSettings);
      await api.appendLog(`ai invocation: ${effectivePrompt}`);
      if (modelOverride) {
        await api.appendLog(`ai model override: ${modelOverride}`);
      }
      await api.emitProgress({ phase: "load-context", label: "读取聊天上下文", percent: 12 });

      if (modelDirective.inspectOnly) {
        const usageText = buildModelUsageText(modelSettings);
        return {
          chatReply: await api.publishChatReply({
            text: usageText,
            card: {
              type: "ai-answer",
              status: "succeeded",
              title: "AI 模型信息",
              subtitle: modelOverride ? `临时模型: ${modelOverride}` : "可在消息内临时切换",
              body: usageText
            }
          }),
          importedFiles: [],
          artifacts: [{ type: "model-info", textModel: defaultTextModel, multimodalModel: defaultMultimodalModel }]
        };
      }

      if (modelDirective.command) {
        if (modelDirective.command.type === "list-models") {
          const filter = normalizeModelFilter(modelDirective.command.filter || "all");
          const result = await listAvailableModels({ signal: api.signal });
          const displayedModels = sortModelsForDisplay(filterModelsByCapability(result.models, filter));
          const nextSettings = {
            ...modelSettings,
            lastListedModels: displayedModels,
            lastListFilter: filter
          };
          await writeAiModelSettings(api.appDataRoot, nextSettings);
          const body = buildAvailableModelsText(displayedModels, nextSettings, filter);
          return {
            chatReply: await api.publishChatReply({
              text: body,
              card: {
                type: "ai-answer",
                status: "succeeded",
                title: "AI 可用模型列表",
                subtitle: `${getModelFilterLabel(filter)} · 共 ${displayedModels.length} 个模型`,
                body
              }
            }),
            importedFiles: [],
            artifacts: [{ type: "model-list", count: displayedModels.length, filter }]
          };
        }

        if (modelDirective.command.type === "use-listed-model") {
          const listedModels = Array.isArray(modelSettings.lastListedModels) ? modelSettings.lastListedModels : [];
          const selectedIndex = Number(modelDirective.command.index || 0);
          if (!listedModels.length) {
            throw new Error("还没有可用的模型列表，请先执行 @ai /models、@ai /models tool-calls 或 @ai /models vision。");
          }
          if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > listedModels.length) {
            throw new Error(`列表序号超出范围，请输入 1 到 ${listedModels.length} 之间的数字。`);
          }
          const selectedModel = listedModels[selectedIndex - 1];
          const previousTextModel = String(modelSettings.textModel || "").trim() || getDefaultTextModelName() || "";
          const nextSettings = {
            ...modelSettings,
            textModel: selectedModel.id,
            multimodalModel: String(modelSettings.multimodalModel || "").trim()
          };
          const hasIndependentVisionModel = nextSettings.multimodalModel && nextSettings.multimodalModel !== previousTextModel;
          if (selectedModel.vision && !hasIndependentVisionModel) {
            nextSettings.multimodalModel = selectedModel.id;
          }
          await writeAiModelSettings(api.appDataRoot, nextSettings);
          const body = buildUseListedModelText(selectedModel, nextSettings, String(modelSettings.lastListFilter || "all").trim() || "all");
          return {
            chatReply: await api.publishChatReply({
              text: body,
              card: {
                type: "ai-answer",
                status: "succeeded",
                title: "AI 默认模型已更新",
                subtitle: `${selectedIndex}. ${selectedModel.id}`,
                body
              }
            }),
            importedFiles: [],
            artifacts: [{ type: "model-settings-updated", textModel: nextSettings.textModel || "", multimodalModel: nextSettings.multimodalModel || "" }]
          };
        }

        const nextSettings = {
          textModel: String(modelSettings.textModel || "").trim(),
          multimodalModel: String(modelSettings.multimodalModel || "").trim(),
          lastListedModels: Array.isArray(modelSettings.lastListedModels) ? modelSettings.lastListedModels : [],
          lastListFilter: String(modelSettings.lastListFilter || "all").trim() || "all"
        };
        if (modelDirective.command.type === "set") {
          nextSettings.textModel = String(modelDirective.command.model || "").trim();
        } else if (modelDirective.command.type === "set-vision") {
          nextSettings.multimodalModel = String(modelDirective.command.model || "").trim();
        } else if (modelDirective.command.type === "set-all") {
          nextSettings.textModel = String(modelDirective.command.model || "").trim();
          nextSettings.multimodalModel = String(modelDirective.command.model || "").trim();
        } else if (modelDirective.command.type === "reset") {
          nextSettings.textModel = "";
          nextSettings.multimodalModel = "";
        } else if (modelDirective.command.type === "reset-vision") {
          nextSettings.multimodalModel = "";
        }

        await writeAiModelSettings(api.appDataRoot, nextSettings);
        const usageText = buildModelUsageText(nextSettings);
        return {
          chatReply: await api.publishChatReply({
            text: usageText,
            card: {
              type: "ai-answer",
              status: "succeeded",
              title: "AI 默认模型已更新",
              subtitle: `文本: ${getEffectiveTextModel(nextSettings) || "未配置"} · 看图: ${getEffectiveMultimodalModel(nextSettings) || "未配置"}`,
              body: usageText
            }
          }),
          importedFiles: [],
          artifacts: [{ type: "model-settings-updated", textModel: nextSettings.textModel || "", multimodalModel: nextSettings.multimodalModel || "" }]
        };
      }

      const catalog = api.listBots();
      const nestedInvocation = findNestedBotInvocation(effectivePrompt, catalog);
      if (nestedInvocation) {
        await api.emitProgress({ phase: "delegate-bot", label: `委派给 ${nestedInvocation.target.displayName}`, percent: 35 });
        const delegatedJob = await api.invokeBot({
          botId: nestedInvocation.target.botId,
          trigger: {
            type: "delegated-by-ai",
            rawText: nestedInvocation.rawText,
            parsedArgs: nestedInvocation.parsedArgs
          },
          options: {
            delegatedBy: api.botId,
            parentJobId: api.jobId
          }
        });
        const reply = `已转交给 ${nestedInvocation.target.displayName}，任务 ${String(delegatedJob.jobId || "").slice(0, 12)} 已创建。`;
        return {
          chatReply: await api.publishChatReply({
            text: reply,
            card: {
              type: "ai-answer",
              status: "succeeded",
              title: "AI 调度完成",
              subtitle: modelOverride ? `模型: ${modelOverride} · 已委派给 ${nestedInvocation.target.displayName}` : `已委派给 ${nestedInvocation.target.displayName}`,
              body: reply
            }
          }),
          importedFiles: [],
          artifacts: [{ type: "delegated-job", jobId: delegatedJob.jobId || "", botId: nestedInvocation.target.botId }]
        };
      }

      const recentMessages = await readRecentChatHistory({
        storageRoot: api.storageRoot,
        historyPath: context.chat.historyPath,
        limit: MAX_RECENT_MESSAGES,
        includeBots: true,
        lookbackDays: wantsSummary(effectivePrompt) ? 3 : 1
      });
      await api.appendLog(`loaded recent messages: ${recentMessages.length}`);

      const historyMessages = buildHistoryMessages(recentMessages);
      const systemPrompt = [
        "你是 NAS 聊天室里的 AI 助手。",
        "你的回答默认使用简体中文，直接、简洁、可信。",
        "优先结合最近聊天上下文回答；如果信息不足，要明确指出。",
        "如果用户要求总结，先给结论，再给要点。",
        "如果是在看图，描述主体、场景、文字、风险点和不确定性。",
        "你可以通过受控工具读取更多聊天、分析图片、或把 bilibili 导入任务交给专门 bot。",
        "只有在确实需要更多上下文、图片分析或导入视频时才调用工具。",
        "不要编造不存在的文件、用户或聊天记录。"
      ].join("\n");

      if (wantsVision(effectivePrompt, context.attachments || [])) {
        await api.emitProgress({ phase: "vision", label: "读取图片并分析", percent: 45 });
        const imageAttachments = await listReferencedChatAttachments({
          storageRoot: api.storageRoot,
          hostClientId: context.chat.hostClientId,
          attachments: context.attachments,
          messages: recentMessages,
          limit: MAX_VISION_IMAGES,
          mimePrefix: "image/"
        });
        if (!imageAttachments.length) {
          throw new Error("没有找到可供分析的聊天图片，请附带图片后再 @ai");
        }
        const imageInputs = [];
        for (const attachment of imageAttachments) {
          imageInputs.push({
            name: attachment.name,
            mimeType: attachment.mimeType,
            dataUrl: await toDataUrl(attachment)
          });
        }
        const visionPrompt = `${effectivePrompt}\n\n请优先分析当前消息附件；若没有明确附件，则分析最近聊天中的图片。`;
        const replyMessageId = createBotJobMessageId(context.jobId);
        await api.emitProgress({ phase: "stream-reply", label: "流式看图回复", percent: 78 });
        const modelResult = await streamVisionAnswer({
          modelOverride,
          defaultMultimodalModel,
          systemPrompt,
          historyMessages,
          visionPrompt,
          imageInputs,
          api,
          replyMessageId
        });
        const answer = String(modelResult.answer || "").trim() || "模型没有返回可显示的内容。";
        await api.emitProgress({ phase: "append-chat-reply", label: "生成回复", percent: 92 });
        return {
          chatReply: await api.publishChatReply({
            id: replyMessageId,
            text: answer,
            card: createAnswerCard(answer, modelResult.model, "multimodal")
          }),
          importedFiles: [],
          artifacts: [{ type: "vision", imageCount: imageInputs.length, model: modelResult.model || "" }]
        };
      }

      await api.emitProgress({ phase: "llm", label: wantsSummary(effectivePrompt) ? "总结聊天中" : "思考中", percent: 55 });
      const replyMessageId = createBotJobMessageId(context.jobId);
      const planned = await runToolAwareConversation({
        systemPrompt,
        effectivePrompt,
        historyMessages,
        recentMessages,
        context,
        api,
        modelOverride,
        defaultTextModel
      });
      await api.emitProgress({ phase: "stream-reply", label: "流式生成回复", percent: 78 });
      const streamed = await streamFinalAnswer({
        planningMessages: planned.planningMessages,
        api,
        replyMessageId,
        mode: "text",
        modelOverride,
        defaultTextModel
      });
      const answer = String(streamed.answer || planned.result?.text || "").trim() || "模型没有返回可显示的内容。";
      await api.emitProgress({ phase: "append-chat-reply", label: "生成回复", percent: 92 });
      return {
        chatReply: await api.publishChatReply({
          id: replyMessageId,
          text: answer,
          card: createAnswerCard(answer, streamed.model || planned.result?.model, "text")
        }),
        importedFiles: [],
        artifacts: [{ type: "answer", model: streamed.model || planned.result?.model || "", historyMessages: historyMessages.length, streamed: true }]
      };
    }
  });
}
