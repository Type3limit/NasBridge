import { createAiChatPlugin } from "./plugins/ai-chat.js";
import { createBilibiliDownloaderPlugin } from "./plugins/bilibili.js";
import { createMusicControlPlugin } from "./plugins/music.js";
import { createMultimodalImagePlugin } from "./plugins/multimodal-image.js";

export class BotRegistry {
  constructor() {
    this.plugins = new Map();
    this.aliases = new Map();
  }

  register(plugin) {
    if (!plugin?.botId) {
      throw new Error("plugin botId is required");
    }
    if (this.plugins.has(plugin.botId)) {
      throw new Error(`duplicate botId: ${plugin.botId}`);
    }
    this.plugins.set(plugin.botId, plugin);
    for (const alias of plugin.aliases || []) {
      const key = String(alias || "").trim().toLowerCase();
      if (!key) {
        continue;
      }
      if (this.aliases.has(key)) {
        throw new Error(`duplicate bot alias: ${key}`);
      }
      this.aliases.set(key, plugin.botId);
    }
    return plugin;
  }

  registerDefaults() {
    this.register(createBilibiliDownloaderPlugin());
    this.register(createMusicControlPlugin());
    this.register(createAiChatPlugin());
    this.register(createMultimodalImagePlugin());
    return this;
  }

  getById(botId) {
    return this.plugins.get(String(botId || "")) || null;
  }

  resolve(identifier) {
    const raw = String(identifier || "").trim();
    if (!raw) {
      return null;
    }
    const direct = this.getById(raw);
    if (direct) {
      return direct;
    }
    const aliasTarget = this.aliases.get(raw.toLowerCase());
    return aliasTarget ? this.getById(aliasTarget) : null;
  }

  list() {
    return [...this.plugins.values()];
  }

  toPublicCatalog() {
    return this.list().map((plugin) => ({
      botId: plugin.botId,
      version: plugin.version,
      displayName: plugin.displayName,
      aliases: [...(plugin.aliases || [])],
      description: plugin.description,
      kind: plugin.kind,
      capabilities: [...(plugin.capabilities || [])]
    }));
  }
}
