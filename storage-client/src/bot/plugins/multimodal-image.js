import { createBotPlugin } from "./base.js";
import { createAnswerCard } from "./ai-chat/formatters/cards.js";
import { MAX_INLINE_IMAGE_BYTES, MAX_VISION_IMAGES } from "./ai-chat/constants.js";
import { attachmentToDataUrl } from "./ai-chat/utils/imageData.js";
import { listReferencedChatAttachments } from "../tools/chatAssets.js";
import { readRecentChatHistory } from "../tools/chatHistory.js";
import { invokeMultimodalModel } from "../tools/llmClient.js";

function extractPrompt(context = {}) {
  const parsedPrompt = String(context?.trigger?.parsedArgs?.prompt || "").trim();
  if (parsedPrompt) {
    return parsedPrompt;
  }
  const rawText = String(context?.trigger?.rawText || "").trim();
  return rawText || "请分析这张图片，说明主体、场景、可见文字、风险点和不确定性。";
}

function clampMaxTokens(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1000;
  }
  return Math.max(200, Math.min(2000, Math.floor(numeric)));
}

function normalizeDetail(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["low", "high", "auto"].includes(normalized) ? normalized : "auto";
}

async function readRecentMessages(api = {}, context = {}) {
  if (!api.storageRoot || !context?.chat?.historyPath) {
    return [];
  }
  try {
    return await readRecentChatHistory({
      storageRoot: api.storageRoot,
      historyPath: context.chat.historyPath,
      limit: 8,
      includeBots: false,
      lookbackDays: 1
    });
  } catch (error) {
    await api.appendLog?.(`multimodal recent history unavailable: ${String(error?.message || error || "unknown error").trim()}`);
    return [];
  }
}

async function collectImageAttachments(api = {}, context = {}) {
  const recentMessages = await readRecentMessages(api, context);
  return listReferencedChatAttachments({
    storageRoot: api.storageRoot,
    hostClientId: context?.chat?.hostClientId || "",
    attachments: context?.attachments || [],
    messages: recentMessages,
    limit: MAX_VISION_IMAGES,
    mimePrefix: "image/"
  });
}

async function buildImageInputs(attachments = [], detail = "auto") {
  const imageInputs = [];
  for (const attachment of attachments) {
    const imageData = await attachmentToDataUrl(attachment, {
      maxInlineBytes: MAX_INLINE_IMAGE_BYTES,
      errorPrefix: "聊天图片"
    });
    imageInputs.push({
      name: attachment.name,
      mimeType: imageData.mimeType,
      byteLength: imageData.byteLength,
      detail,
      dataUrl: imageData.dataUrl
    });
  }
  return imageInputs;
}

function buildVisionPrompt(prompt = "", imageInputs = []) {
  const imageLines = imageInputs
    .map((image, index) => `${index + 1}. ${image.name || "image"} (${image.mimeType || "image"})`)
    .join("\n");
  return [
    String(prompt || "").trim(),
    "",
    "请优先分析当前消息附件；如果图片来自最近聊天记录，请说明这是基于最近图片附件。",
    imageLines ? `图片列表：\n${imageLines}` : ""
  ].filter(Boolean).join("\n");
}

export function createMultimodalImagePlugin() {
  return createBotPlugin({
    botId: "ai.multimodal-image",
    displayName: "Multimodal Image",
    aliases: ["vision", "imagebot"],
    description: "Analyze referenced chat images through a multimodal model.",
    capabilities: ["llm.multimodal", "reply.chat"],
    permissions: {
      readChatAttachments: true,
      multimodal: true,
      replyChat: true,
      publishJobEvents: true
    },
    limits: {
      maxConcurrentJobs: 1,
      timeoutMs: 15 * 60 * 1000
    },
    async execute(context, api) {
      const prompt = extractPrompt(context);
      const parsedArgs = context?.trigger?.parsedArgs && typeof context.trigger.parsedArgs === "object"
        ? context.trigger.parsedArgs
        : {};
      const detail = normalizeDetail(parsedArgs.detail);
      const maxTokens = clampMaxTokens(parsedArgs.maxTokens);
      const modelOverride = String(parsedArgs.model || parsedArgs.modelOverride || "").trim();

      await api.appendLog(`multimodal image invocation: ${prompt}`);
      await api.emitProgress({ phase: "collect-images", label: "读取聊天图片附件", percent: 18 });
      const attachments = await collectImageAttachments(api, context);
      if (!attachments.length) {
        throw new Error("没有找到可供分析的聊天图片，请附带图片后再调用 @vision 或 @ai 看图。");
      }

      api.throwIfCancelled?.();
      await api.emitProgress({ phase: "prepare-images", label: `准备 ${attachments.length} 张图片`, percent: 36 });
      const imageInputs = await buildImageInputs(attachments, detail);
      await api.emitProgress({ phase: "analyze", label: "调用多模态模型分析图片", percent: 62 });
      const invokeVision = typeof api.dependencies?.invokeMultimodalModel === "function"
        ? api.dependencies.invokeMultimodalModel
        : invokeMultimodalModel;
      const modelResult = await invokeVision({
        model: modelOverride || undefined,
        systemPrompt: [
          "你是 NasBridge 的多模态图片分析 bot。",
          "输出简体中文，结构清晰，基于实际图片内容回答。",
          "覆盖主体、场景、可见文字、可能风险和不确定性；不要声称读取了图片外的本地文件。"
        ].join("\n"),
        userPrompt: buildVisionPrompt(prompt, imageInputs),
        imageInputs,
        signal: api.signal,
        maxTokens
      });
      const answer = String(modelResult?.text || modelResult?.answer || "").trim() || "模型没有返回可显示的图片分析结果。";
      const model = String(modelResult?.model || modelOverride || "").trim();
      await api.emitProgress({ phase: "reply", label: "写入图片分析结果", percent: 94 });
      return {
        chatReply: api.createChatReply({
          text: answer,
          card: createAnswerCard(answer, model, "multimodal", null, null)
        }),
        importedFiles: [],
        artifacts: [{
          type: "vision",
          imageCount: imageInputs.length,
          model,
          images: imageInputs.map((image) => ({
            name: image.name,
            mimeType: image.mimeType,
            byteLength: image.byteLength
          }))
        }]
      };
    }
  });
}
