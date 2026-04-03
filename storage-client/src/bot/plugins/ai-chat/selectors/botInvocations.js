export function findNestedBotInvocation(prompt = "", catalog = []) {
  const matched = /^@([a-z0-9._-]+)\b/i.exec(String(prompt || "").trim());
  if (!matched?.[1]) {
    return null;
  }
  const alias = matched[1].toLowerCase();
  const target = catalog.find((item) => item.botId !== "ai.chat" && ([item.botId, ...(item.aliases || [])].map((value) => String(value || "").toLowerCase()).includes(alias)));
  if (!target) {
    return null;
  }
  const remainingPrompt = String(prompt || "").trim().replace(/^@[a-z0-9._-]+\b\s*/i, "").trim();
  const bilibiliSourceMatch = remainingPrompt.match(/https?:\/\/\S+|\bBV[0-9A-Za-z]+\b/i);
  return {
    target,
    rawText: remainingPrompt,
    parsedArgs: bilibiliSourceMatch?.[0] ? { source: bilibiliSourceMatch[0] } : {}
  };
}

export function findBotInvocationInAnswer(answer = "", catalog = []) {
  const lines = String(answer || "")
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  if (!lines.length) {
    return null;
  }
  return findNestedBotInvocation(lines[0], catalog);
}