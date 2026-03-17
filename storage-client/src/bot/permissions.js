export const BOT_PERMISSION_NAMES = [
  "readChatHistory",
  "readChatAttachments",
  "readLibrary",
  "writeLibrary",
  "outboundHttp",
  "spawnProcess",
  "llm",
  "multimodal",
  "replyChat",
  "publishJobEvents"
];

export function normalizePluginPermissions(permissions = {}) {
  const normalized = Object.fromEntries(BOT_PERMISSION_NAMES.map((name) => [name, false]));
  for (const [key, value] of Object.entries(permissions || {})) {
    if (BOT_PERMISSION_NAMES.includes(key)) {
      normalized[key] = value === true;
    }
  }
  return normalized;
}

export function validatePluginPermissions(plugin) {
  const normalized = normalizePluginPermissions(plugin?.permissions || {});
  return {
    ok: true,
    permissions: normalized,
    denied: []
  };
}
