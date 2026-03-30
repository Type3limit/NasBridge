import { createBotJobMessageId } from "../../context.js";
import { createAnswerCard } from "../../plugins/ai-chat/formatters/cards.js";
import { appendAiSessionTurn } from "../../plugins/ai-chat/services/aiSessions.js";
import { streamVisionAnswer } from "../../plugins/ai-chat/streaming.js";
import { attachmentToDataUrl } from "../../plugins/ai-chat/utils/imageData.js";
import { MAX_VISION_IMAGES } from "../../plugins/ai-chat/constants.js";
import { listReferencedChatAttachments } from "../../tools/chatAssets.js";

async function collectVisionAttachments({ prepared = {} }) {
  const api = prepared.api;
  const context = prepared.context;
  const emitReplyProgress = prepared.emitReplyProgress;
  const recentMessages = Array.isArray(prepared.recentMessages) ? prepared.recentMessages : [];

  api.throwIfCancelled();
  await emitReplyProgress({ phase: "vision", label: "读取图片并分析", percent: 32 });
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
  return imageAttachments;
}

async function buildVisionInputs(imageAttachments = []) {
  const imageInputs = [];
  for (const attachment of imageAttachments) {
    const imageData = await attachmentToDataUrl(attachment);
    imageInputs.push({
      name: attachment.name,
      mimeType: attachment.mimeType,
      dataUrl: imageData.dataUrl
    });
  }
  return imageInputs;
}

function createVisionPrompt(effectivePrompt = "") {
  return `${effectivePrompt}\n\n请优先分析当前消息附件；若没有明确附件，则分析最近聊天中的图片。`;
}

async function finalizeAiChatVisionRoute({ prepared = {}, imageInputs = [], visionPrompt = "" }) {
  const api = prepared.api;
  const context = prepared.context;
  const emitReplyProgress = prepared.emitReplyProgress;
  const replyApi = prepared.replyApi;
  const effectivePrompt = prepared.effectivePrompt || "";
  const modelOverride = prepared.modelOverride || "";
  const defaultMultimodalModel = prepared.defaultMultimodalModel || "";
  const systemPrompt = prepared.systemPrompt || "";
  const combinedHistoryMessages = Array.isArray(prepared.combinedHistoryMessages) ? prepared.combinedHistoryMessages : [];
  let activeSession = prepared.activeSession || null;

  api.throwIfCancelled();
  const replyMessageId = createBotJobMessageId(context.jobId);
  await emitReplyProgress({ phase: "prepare-stream-reply", label: "整理看图分析结果", percent: 74 });
  await emitReplyProgress({ phase: "wait-first-token", label: "等待模型返回首个片段", percent: 82 });
  const modelResult = await streamVisionAnswer({
    modelOverride,
    defaultMultimodalModel,
    systemPrompt,
    historyMessages: combinedHistoryMessages,
    visionPrompt,
    imageInputs,
    api: replyApi,
    replyMessageId
  });
  const answer = String(modelResult.answer || "").trim() || "模型没有返回可显示的内容。";
  if (activeSession) {
    activeSession = await appendAiSessionTurn(api.appDataRoot, activeSession, effectivePrompt, answer);
  }
  await emitReplyProgress({ phase: "append-chat-reply", label: "写入最终回复", percent: 96 });
  return {
    result: {
      chatReply: await api.publishChatReply({
        id: replyMessageId,
        text: answer,
        card: createAnswerCard(answer, modelResult.model, "multimodal", activeSession)
      }),
      importedFiles: [],
      artifacts: [{ type: "vision", imageCount: imageInputs.length, model: modelResult.model || "", sessionId: activeSession?.id || null }]
    }
  };
}

export async function handleAiChatVisionCollectRoute(state = {}) {
  return {
    visionAttachments: await collectVisionAttachments({ prepared: state.prepared || {} })
  };
}

export async function handleAiChatVisionBuildRoute(state = {}) {
  const prepared = state.prepared || {};
  return {
    visionInputs: await buildVisionInputs(Array.isArray(state.visionAttachments) ? state.visionAttachments : []),
    visionPrompt: createVisionPrompt(prepared.effectivePrompt || "")
  };
}

export async function handleAiChatVisionAnswerRoute(state = {}) {
  return finalizeAiChatVisionRoute({
    prepared: state.prepared || {},
    imageInputs: Array.isArray(state.visionInputs) ? state.visionInputs : [],
    visionPrompt: String(state.visionPrompt || "")
  });
}