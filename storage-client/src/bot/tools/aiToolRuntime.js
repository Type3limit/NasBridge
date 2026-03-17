import fs from "node:fs";
import { readRecentChatHistory } from "./chatHistory.js";
import { listReferencedChatAttachments } from "./chatAssets.js";
import { invokeMultimodalModel } from "./llmClient.js";

const MAX_HISTORY_LIMIT = 60;
const MAX_IMAGE_TOOL_LIMIT = 3;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function compactMessageText(message = {}) {
  const author = String(message?.author?.displayName || "用户").trim();
  const text = String(message?.text || "").trim();
  const cardText = [message?.card?.title, message?.card?.body].filter(Boolean).join(" · ");
  const attachmentText = Array.isArray(message?.attachments) && message.attachments.length
    ? `附件: ${message.attachments.map((item) => item.name).join(", ")}`
    : "";
  return [author, [text || cardText, attachmentText].filter(Boolean).join(" | ")].filter(Boolean).join(": ");
}

async function toDataUrl(attachment) {
  const stat = await fs.promises.stat(attachment.absolutePath);
  if (Number(stat.size || 0) > MAX_INLINE_IMAGE_BYTES) {
    throw new Error(`图片 ${attachment.name} 超过 ${(MAX_INLINE_IMAGE_BYTES / (1024 * 1024)).toFixed(0)}MB，暂不支持 describe_image`);
  }
  const content = await fs.promises.readFile(attachment.absolutePath);
  const mimeType = String(attachment?.mimeType || "image/jpeg").trim() || "image/jpeg";
  return `data:${mimeType};base64,${content.toString("base64")}`;
}

function safeJson(value) {
  return JSON.stringify(value, null, 2);
}

export function getAiToolDefinitions() {
  return [
    {
      name: "read_chat_history",
      description: "读取当前聊天室最近消息，用于问答、总结和补足上下文。",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: MAX_HISTORY_LIMIT },
          includeBots: { type: "boolean" },
          lookbackDays: { type: "integer", minimum: 0, maximum: 7 }
        }
      }
    },
    {
      name: "describe_image",
      description: "读取当前消息附件或最近聊天中的图片，并调用多模态模型分析。",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: MAX_IMAGE_TOOL_LIMIT }
        }
      }
    },
    {
      name: "import_bilibili_video",
      description: "把 bilibili 链接或 BV 号交给 bilibili.downloader 处理并入库。",
      inputSchema: {
        type: "object",
        required: ["source"],
        properties: {
          source: { type: "string" },
          targetFolder: { type: "string" }
        }
      }
    }
  ];
}

export async function executeAiToolCall(toolCall, context, api, helpers = {}) {
  const name = String(toolCall?.name || "").trim();
  const input = toolCall?.input && typeof toolCall.input === "object" ? toolCall.input : {};
  const recentMessages = Array.isArray(helpers.recentMessages) ? helpers.recentMessages : [];

  if (name === "read_chat_history") {
    const messages = await readRecentChatHistory({
      storageRoot: api.storageRoot,
      historyPath: context.chat.historyPath,
      limit: clamp(input.limit || 20, 1, MAX_HISTORY_LIMIT),
      includeBots: input.includeBots !== false,
      lookbackDays: clamp(input.lookbackDays || 2, 0, 7)
    });
    return safeJson({
      count: messages.length,
      messages: messages.map((message) => ({
        id: message.id,
        createdAt: message.createdAt,
        author: message.author?.displayName || "用户",
        text: compactMessageText(message)
      }))
    });
  }

  if (name === "describe_image") {
    const attachments = await listReferencedChatAttachments({
      storageRoot: api.storageRoot,
      hostClientId: context.chat.hostClientId,
      attachments: context.attachments,
      messages: recentMessages,
      limit: clamp(input.limit || 2, 1, MAX_IMAGE_TOOL_LIMIT),
      mimePrefix: "image/"
    });
    if (!attachments.length) {
      throw new Error("当前上下文里没有可分析的图片");
    }
    const imageInputs = [];
    for (const attachment of attachments) {
      imageInputs.push({
        name: attachment.name,
        mimeType: attachment.mimeType,
        dataUrl: await toDataUrl(attachment)
      });
    }
    const result = await invokeMultimodalModel({
      systemPrompt: [
        "你在执行 describe_image 工具。",
        "请输出精炼、结构化的中文图片分析结果。",
        "需要覆盖主体、场景、可见文字、潜在风险和不确定性。"
      ].join("\n"),
      userPrompt: String(input.prompt || "请描述图片内容并提炼关键信息。"),
      imageInputs,
      maxTokens: 900,
      temperature: 0.2
    });
    return safeJson({
      imageCount: imageInputs.length,
      model: result.model || "",
      analysis: String(result.text || "").trim()
    });
  }

  if (name === "import_bilibili_video") {
    const source = String(input.source || "").trim();
    if (!source) {
      throw new Error("source is required");
    }
    const delegatedJob = await api.invokeBot({
      botId: "bilibili.downloader",
      trigger: {
        type: "tool-call",
        rawText: source,
        parsedArgs: {
          source,
          targetFolder: String(input.targetFolder || "").trim()
        }
      },
      options: {
        delegatedBy: api.botId,
        parentJobId: api.jobId,
        toolName: name
      }
    });
    return safeJson({
      delegated: true,
      botId: "bilibili.downloader",
      jobId: delegatedJob.jobId || "",
      status: delegatedJob.status || "queued",
      source
    });
  }

  throw new Error(`unsupported AI tool: ${name}`);
}