export const MAX_RECENT_MESSAGES = 24;
export const MAX_CONTEXT_MESSAGES = 16;
export const MAX_VISION_IMAGES = 3;
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CARD_BODY_LENGTH = 1800;
export const MAX_TOOL_ROUNDS = 4;
export const AI_MODEL_SETTINGS_FILE_NAME = "ai-model-settings.json";
export const AI_SESSION_DIR_NAME = "ai-chat-sessions";
export const AI_SESSION_INDEX_FILE_NAME = "index.json";
export const MAX_SESSION_CONTEXT_MESSAGES = 12;

export const SEARCH_PREFERENCE_ALIASES = {
  official: ["official", "官网", "官方", "site"],
  github: ["github", "gh"],
  docs: ["docs", "doc", "documentation", "文档", "手册"],
  news: ["news", "新闻", "资讯", "最新"]
};