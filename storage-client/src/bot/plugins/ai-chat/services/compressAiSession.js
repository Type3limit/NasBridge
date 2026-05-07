import { invokeTextModel } from "../../../tools/llmClient.js";
import { readAiSessionMessages, replaceAiSessionMessages } from "./aiSessions.js";

const COMPRESS_MIN_MESSAGES = 4;

export async function compressAiSessionContext({ appDataRoot, session, textModel, signal } = {}) {
  if (!appDataRoot || !session?.id) {
    return null;
  }
  const messages = await readAiSessionMessages(appDataRoot, session.id, 64);
  if (messages.length < COMPRESS_MIN_MESSAGES) {
    return null;
  }
  const summaryMessages = [
    ...messages.map((m) => ({ role: m.role, content: m.content })),
    {
      role: "user",
      content: "请根据以上对话内容，生成一段精炼的上下文摘要。要求：\n1. 涵盖所有关键信息点、决策和结论\n2. 保留重要数据、文件名、操作步骤\n3. 语言简洁，不超过500字\n4. 直接输出摘要内容，不要前缀和标题"
    }
  ];
  const result = await invokeTextModel({
    model: textModel || undefined,
    messages: summaryMessages,
    signal,
    maxTokens: 700
  });
  const summary = String(result.text || "").trim();
  if (!summary) {
    return null;
  }
  await replaceAiSessionMessages(appDataRoot, session.id, [
    { role: "assistant", content: `[对话摘要]\n\n${summary}` }
  ]);
  return summary;
}
