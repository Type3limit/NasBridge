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
  // Extract all Bilibili sources from rawText; for single source set parsedArgs.source, for multiple leave parsedArgs empty so bilibili bot uses batch mode.
  const allSourceMatches = [...remainingPrompt.matchAll(/https?:\/\/\S+|\bBV[0-9A-Za-z]+\b/gi)].map((m) => m[0]);
  const uniqueSources = [...new Set(allSourceMatches)];
  return {
    target,
    rawText: remainingPrompt,
    parsedArgs: uniqueSources.length === 1 ? { source: uniqueSources[0] } : {}
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