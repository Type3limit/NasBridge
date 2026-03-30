import { formatAiSessionLabel } from "../services/aiSessions.js";

export function parseAiSessionDirective(rawPrompt = "") {
  const prompt = String(rawPrompt || "").trim();
  if (!prompt) {
    return { prompt: "", sessionId: null, command: null };
  }
  if (/^\/sessions\s*$/i.test(prompt)) {
    return {
      prompt: "",
      sessionId: null,
      command: {
        type: "list-sessions"
      }
    };
  }
  const newSessionMatch = prompt.match(/^\/new(?:\s+([\s\S]*))?$/i);
  if (newSessionMatch) {
    return {
      prompt: "",
      sessionId: null,
      command: {
        type: "new-session",
        name: String(newSessionMatch[1] || "").trim()
      }
    };
  }
  const renameSessionMatch = prompt.match(/^\/rename\s+#(\d+)\s+([\s\S]+)$/i);
  if (renameSessionMatch?.[1]) {
    return {
      prompt: "",
      sessionId: Number.parseInt(renameSessionMatch[1], 10),
      command: {
        type: "rename-session",
        name: String(renameSessionMatch[2] || "").trim()
      }
    };
  }
  const deleteSessionMatch = prompt.match(/^\/delete\s+#(\d+)\s*$/i);
  if (deleteSessionMatch?.[1]) {
    return {
      prompt: "",
      sessionId: Number.parseInt(deleteSessionMatch[1], 10),
      command: {
        type: "delete-session"
      }
    };
  }
  const sessionPromptMatch = prompt.match(/^#(\d+)(?:\s+([\s\S]*))?$/);
  if (sessionPromptMatch?.[1]) {
    return {
      prompt: String(sessionPromptMatch[2] || "").trim(),
      sessionId: Number.parseInt(sessionPromptMatch[1], 10),
      command: null
    };
  }
  return { prompt, sessionId: null, command: null };
}

export function withSessionSubtitle(baseSubtitle = "", session = null) {
  const parts = [];
  if (session?.id) {
    parts.push(`会话 ${formatAiSessionLabel(session)}`);
  }
  if (String(baseSubtitle || "").trim()) {
    parts.push(String(baseSubtitle || "").trim());
  }
  return parts.join(" · ");
}