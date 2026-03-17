import { createBotPlugin } from "./base.js";

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
      await api.appendLog(`placeholder multimodal invocation: ${context.trigger.rawText}`);
      await api.emitProgress({ phase: "analyze", label: "Pending implementation", percent: 20 });
      return {
        chatReply: api.createChatReply({
          text: "Multimodal Image bot is scaffolded but not implemented yet."
        }),
        importedFiles: [],
        artifacts: []
      };
    }
  });
}
