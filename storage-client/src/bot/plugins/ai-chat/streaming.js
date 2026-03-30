import { invokeMultimodalModelStream, invokeTextModelStream } from "../../tools/llmClient.js";

async function flushStreamingDraft({ latestText, latestPublishedAt, minPublishIntervalMs, force = false, api, replyMessageId, card }) {
  if (!String(latestText || "").trim()) {
    return latestPublishedAt;
  }
  const now = Date.now();
  if (!force && now - latestPublishedAt < minPublishIntervalMs) {
    return latestPublishedAt;
  }
  await api.publishTransientChatReply({
    id: replyMessageId,
    text: latestText,
    card
  });
  return now;
}

export async function streamFinalAnswer({ planningMessages, api, replyMessageId, mode = "text", modelOverride = "", defaultTextModel = "" }) {
  let latestText = "";
  let latestPublishedAt = 0;
  let firstChunkReceived = false;
  const minPublishIntervalMs = 120;
  const runningCard = {
    type: mode === "multimodal" ? "image-analysis" : "ai-answer",
    status: "running",
    title: mode === "multimodal" ? "AI 看图中" : "AI 正在回复",
    subtitle: "流式生成中",
    actions: [{ type: "cancel-bot-job", label: "停止生成" }]
  };

  const streamResult = await invokeTextModelStream({
    model: modelOverride || defaultTextModel || undefined,
    messages: planningMessages,
    signal: api.signal,
    maxTokens: 1200,
    temperature: 0.35
  }, {
    onText: async ({ text }) => {
      latestText = text;
      if (!firstChunkReceived) {
        firstChunkReceived = true;
        await api.emitProgress({ phase: "stream-reply", label: "正在流式生成回复", percent: 90 });
      }
      latestPublishedAt = await flushStreamingDraft({
        latestText,
        latestPublishedAt,
        minPublishIntervalMs,
        api,
        replyMessageId,
        card: runningCard
      });
    }
  });

  await flushStreamingDraft({
    latestText,
    latestPublishedAt,
    minPublishIntervalMs,
    force: true,
    api,
    replyMessageId,
    card: runningCard
  });
  return {
    answer: String(streamResult.text || latestText || "").trim(),
    model: streamResult.model || ""
  };
}

export async function streamVisionAnswer({ systemPrompt, visionPrompt, historyMessages, imageInputs, api, replyMessageId, modelOverride = "", defaultMultimodalModel = "" }) {
  let latestText = "";
  let latestPublishedAt = 0;
  let firstChunkReceived = false;
  const minPublishIntervalMs = 120;
  const runningCard = {
    type: "image-analysis",
    status: "running",
    title: "AI 看图中",
    subtitle: "流式生成中",
    actions: [{ type: "cancel-bot-job", label: "停止生成" }]
  };

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
      if (!firstChunkReceived) {
        firstChunkReceived = true;
        await api.emitProgress({ phase: "stream-reply", label: "正在流式输出看图结果", percent: 90 });
      }
      latestPublishedAt = await flushStreamingDraft({
        latestText,
        latestPublishedAt,
        minPublishIntervalMs,
        api,
        replyMessageId,
        card: runningCard
      });
    }
  });

  await flushStreamingDraft({
    latestText,
    latestPublishedAt,
    minPublishIntervalMs,
    force: true,
    api,
    replyMessageId,
    card: runningCard
  });
  return {
    answer: String(streamResult.text || latestText || "").trim(),
    model: streamResult.model || ""
  };
}