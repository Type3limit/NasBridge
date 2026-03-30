import { MAX_CONTEXT_MESSAGES } from "../constants.js";

export function toRole(message = {}) {
  if (String(message?.author?.id || "").startsWith("bot:ai.chat")) {
    return "assistant";
  }
  return "user";
}

export function summarizeAttachments(attachments = []) {
  return attachments.map((item) => `${item.name} (${item.mimeType || item.kind || "file"})`).join(", ");
}

export function compactMessageText(message = {}) {
  const author = String(message?.author?.displayName || "用户").trim();
  const text = String(message?.text || "").trim();
  const cardText = String(message?.card?.body || message?.card?.title || "").trim();
  const parts = [text || cardText];
  if (Array.isArray(message?.attachments) && message.attachments.length) {
    parts.push(`附件: ${summarizeAttachments(message.attachments)}`);
  }
  return `${author}: ${parts.filter(Boolean).join(" | ")}`.trim();
}

export function buildHistoryMessages(messages = []) {
  return messages
    .filter((message) => message?.text || message?.card?.body || (Array.isArray(message?.attachments) && message.attachments.length))
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message) => ({
      role: toRole(message),
      content: compactMessageText(message)
    }));
}