export function createBotPlugin(definition = {}) {
  if (!definition.botId) {
    throw new Error("botId is required");
  }
  return {
    version: "0.1.0",
    aliases: [],
    description: "",
    kind: "task",
    capabilities: [],
    permissions: {},
    limits: {
      maxConcurrentJobs: 1,
      timeoutMs: 15 * 60 * 1000
    },
    async execute() {
      throw new Error(`plugin ${definition.botId} execute() is not implemented`);
    },
    ...definition
  };
}
