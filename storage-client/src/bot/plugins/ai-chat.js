import { runAiChatGraph } from "../langgraph/aiChatGraph.js";
import { createAiChatGraphExecution } from "../langgraph/nodes/aiChatNodes.js";
import { createBotPlugin } from "./base.js";

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
      return runAiChatGraph(createAiChatGraphExecution({ context, api }));
    }
  });
}