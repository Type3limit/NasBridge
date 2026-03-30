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

export function findNaturalLanguageMusicInvocation(prompt = "", catalog = []) {
  const raw = String(prompt || "").trim();
  if (!raw) {
    return null;
  }
  const target = catalog.find((item) => item.botId === "music.control") || null;
  if (!target) {
    return null;
  }

  const normalized = raw.replace(/[。！？!?,，；;]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || /^@/i.test(normalized)) {
    return null;
  }

  const statusMatch = /(?:播放)?状态|队列|歌单|当前在放什么|现在在放什么|现在播到哪/i.test(normalized);
  if (statusMatch) {
    const command = /队列|歌单/i.test(normalized) ? "队列" : "状态";
    return {
      target,
      rawText: command,
      parsedArgs: { prompt: command }
    };
  }

  if (/(?:暂停|停一下|先停|停止播放)/i.test(normalized)) {
    return {
      target,
      rawText: "暂停",
      parsedArgs: { prompt: "暂停" }
    };
  }

  if (/(?:下一首|下一曲|切歌|换一首)/i.test(normalized)) {
    return {
      target,
      rawText: "下一曲",
      parsedArgs: { prompt: "下一曲" }
    };
  }

  if (/(?:上一首|上一曲)/i.test(normalized)) {
    return {
      target,
      rawText: "上一曲",
      parsedArgs: { prompt: "上一曲" }
    };
  }

  const songRequestMatch = normalized.match(/(?:帮我|请|麻烦你|给我)?(?:点一首|点首|来一首|放一首|播一首|播放|想听|听一首|听|放)(.+)$/i);
  if (songRequestMatch?.[1]) {
    let songPrompt = String(songRequestMatch[1] || "").trim();
    songPrompt = songPrompt.replace(/(?:吧|啊|呀|呗)$/i, "").trim();
    songPrompt = songPrompt.replace(/^(?:一首|首)/i, "").trim();
    if (!songPrompt) {
      return null;
    }
    const command = `点歌 ${songPrompt}`;
    return {
      target,
      rawText: command,
      parsedArgs: { prompt: command }
    };
  }

  return null;
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