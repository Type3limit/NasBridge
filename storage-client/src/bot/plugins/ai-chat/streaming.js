import { invokeMultimodalModelStream, invokeTextModelStream } from "../../tools/llmClient.js";

const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

function estimateTextTokens(value = "") {
  const text = String(value || "");
  if (!text) {
    return 0;
  }
  const cjkCount = (text.match(CJK_PATTERN) || []).length;
  const nonCjkText = text.replace(CJK_PATTERN, "");
  return Math.max(1, Math.ceil(cjkCount + nonCjkText.length / 4));
}

function estimateContentTokens(content) {
  if (typeof content === "string") {
    return estimateTextTokens(content);
  }
  if (Array.isArray(content)) {
    return content.reduce((sum, item) => {
      if (typeof item === "string") {
        return sum + estimateTextTokens(item);
      }
      if (item?.type === "text") {
        return sum + estimateTextTokens(item.text || "");
      }
      if (item?.type === "image_url") {
        return sum + 256;
      }
      return sum + estimateTextTokens(JSON.stringify(item || ""));
    }, 0);
  }
  if (content && typeof content === "object") {
    return estimateTextTokens(JSON.stringify(content));
  }
  return 0;
}

function estimateMessagesTokens(messages = []) {
  const total = (Array.isArray(messages) ? messages : []).reduce((sum, message) => {
    if (!message?.role) {
      return sum;
    }
    const toolCallTokens = Array.isArray(message.tool_calls)
      ? estimateTextTokens(JSON.stringify(message.tool_calls))
      : 0;
    return sum + 4 + estimateContentTokens(message.content) + toolCallTokens;
  }, 2);
  return Math.max(0, Math.ceil(total));
}

function buildUsageStats({ usage, messages, outputText, elapsedSec }) {
  const hasPromptTokens = usage?.prompt_tokens != null;
  const hasCompletionTokens = usage?.completion_tokens != null;
  const promptTokens = hasPromptTokens ? usage.prompt_tokens : estimateMessagesTokens(messages);
  const completionTokens = hasCompletionTokens ? usage.completion_tokens : estimateTextTokens(outputText);
  const tokensPerSecond = elapsedSec > 0.5 && completionTokens > 0 ? Math.round(completionTokens / elapsedSec) : null;
  return {
    promptTokens,
    promptTokensEstimated: !hasPromptTokens,
    tokensPerSecond,
    tokensPerSecondEstimated: tokensPerSecond != null && !hasCompletionTokens
  };
}

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
  let firstChunkAt = 0;
  let firstChunkReceived = false;
  const minPublishIntervalMs = 120;
  const runningCard = {
    type: mode === "multimodal" ? "image-analysis" : "ai-answer",
    status: "running",
    title: mode === "multimodal" ? "AI 看图中" : "AI 正在回复",
    subtitle: "流式生成中",
    actions: [{ type: "cancel-bot-job", label: "停止生成" }]
  };

  // 如果对话中包含工具调用结果，追加合成指令以确保模型基于实际结果作答
  const hasToolResults = planningMessages.some(m => m.role === "tool");
  const messagesForAnswer = hasToolResults
    ? [
        ...planningMessages.filter(m => !(m.role === "assistant" && !m.tool_calls?.length && m.content)),
        { role: "user", content: "基于上方工具返回的结果，直接给出最终回答。要求：只输出一段完整回答，包含关键事实/标题/数据/来源链接；不要重复、不要分两段、不要描述搜索过程。" }
      ]
    : planningMessages;

  const streamResult = await invokeTextModelStream({
    model: modelOverride || defaultTextModel || undefined,
    messages: messagesForAnswer,
    signal: api.signal,
    maxTokens: 1200,
    temperature: 0.35
  }, {
    onText: async ({ text }) => {
      latestText = text;
      if (!firstChunkAt) firstChunkAt = Date.now();
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
  const genElapsedSec = firstChunkAt > 0 ? (Date.now() - firstChunkAt) / 1000 : 0;
  const usageStats = buildUsageStats({
    usage: streamResult.usage,
    messages: messagesForAnswer,
    outputText: streamResult.text || latestText,
    elapsedSec: genElapsedSec
  });
  return {
    answer: String(streamResult.text || latestText || "").trim(),
    model: streamResult.model || "",
    usage: streamResult.usage || null,
    ...usageStats
  };
}

export async function streamVisionAnswer({ systemPrompt, visionPrompt, historyMessages, imageInputs, api, replyMessageId, modelOverride = "", defaultMultimodalModel = "" }) {
  let latestText = "";
  let latestPublishedAt = 0;
  let firstChunkAt = 0;
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
      if (!firstChunkAt) firstChunkAt = Date.now();
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
  const genElapsedSec = firstChunkAt > 0 ? (Date.now() - firstChunkAt) / 1000 : 0;
  const estimatedMessages = [
    ...(systemPrompt ? [{ role: "system", content: String(systemPrompt) }] : []),
    ...(Array.isArray(historyMessages) ? historyMessages.filter((message) => message?.role && message?.content) : []),
    {
      role: "user",
      content: [
        { type: "text", text: String(visionPrompt || "") },
        ...(Array.isArray(imageInputs) ? imageInputs : []).map((image) => ({ type: "image_url", image_url: { url: image?.dataUrl || "", detail: image?.detail || "auto" } }))
      ]
    }
  ];
  const usageStats = buildUsageStats({
    usage: streamResult.usage,
    messages: estimatedMessages,
    outputText: streamResult.text || latestText,
    elapsedSec: genElapsedSec
  });
  return {
    answer: String(streamResult.text || latestText || "").trim(),
    model: streamResult.model || "",
    usage: streamResult.usage || null,
    ...usageStats
  };
}
