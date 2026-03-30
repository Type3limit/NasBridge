import fs from "node:fs";
import path from "node:path";
import { createBotPlugin } from "./base.js";

const MUSIC_SEARCH_MEMORY_DIR = "music-bot";
const MUSIC_SEARCH_MEMORY_FILE = "search-memory.json";
const MUSIC_SEARCH_MEMORY_MAX_AGE_MS = 30 * 60 * 1000;
const MUSIC_SEARCH_MEMORY_MAX_ENTRIES = 120;

function formatDuration(seconds = 0) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${minutes}:${String(remain).padStart(2, "0")}`;
}

function formatTrackLine(track = {}, index = -1, options = {}) {
  const prefix = options.current ? "正在播放" : Number.isInteger(index) && index >= 0 ? `${index + 1}.` : "-";
  const title = String(track?.title || "未命名曲目").trim();
  const artist = String(track?.artist || "未知艺术家").trim();
  const duration = Number(track?.duration || 0) > 0 ? ` · ${formatDuration(track.duration)}` : "";
  const status = String(track?.status || "").trim();
  const statusText = status && status !== "ready" ? ` · ${status}` : "";
  return `${prefix} ${title} - ${artist}${duration}${statusText}`.trim();
}

function extractPrompt(context = {}) {
  const prompt = context?.trigger?.parsedArgs?.prompt;
  if (typeof prompt === "string" && prompt.trim()) {
    return prompt.trim();
  }
  return String(context?.trigger?.rawText || "").trim();
}

function normalizeSourceList(snapshot = null) {
  return Array.isArray(snapshot?.supportedSources)
    ? snapshot.supportedSources
        .map((item) => ({
          value: String(item?.value || "").trim(),
          label: String(item?.label || item?.value || "").trim()
        }))
        .filter((item) => item.value)
    : [];
}

function pickSourceLabel(source = "", sourceList = []) {
  const target = sourceList.find((item) => item.value === source);
  return target?.label || source || "未知音源";
}

function normalizeKeyword(text = "") {
  return String(text || "").replace(/^[:：\s-]+/, "").trim();
}

function extractSourceHint(text = "", supportedSources = []) {
  const sourceValues = supportedSources.map((item) => String(item.value || "").toLowerCase());
  const raw = String(text || "").trim();
  if (!raw || !sourceValues.length) {
    return { source: "", text: raw };
  }

  const sourceFlagMatch = raw.match(/(?:--source=|(?:source|音源)\s+)([a-z0-9_-]+)/i);
  const candidate = String(sourceFlagMatch?.[1] || "").toLowerCase();
  if (candidate && sourceValues.includes(candidate)) {
    const cleaned = raw.replace(sourceFlagMatch[0], " ").replace(/\s+/g, " ").trim();
    return { source: candidate, text: cleaned };
  }
  return { source: "", text: raw };
}

function parseMusicCommand(rawPrompt = "", supportedSources = []) {
  const trimmed = String(rawPrompt || "").trim();
  if (!trimmed) {
    return { type: "status" };
  }

  const sourceList = normalizeSourceList({ supportedSources });
  const sourceValues = sourceList.map((item) => item.value);
  const sourceOnlyMatch = trimmed.match(/^\/?(?:source|音源)\s+([a-z0-9_-]+)$/i);
  if (sourceOnlyMatch?.[1]) {
    return { type: "source", source: String(sourceOnlyMatch[1]).toLowerCase() };
  }

  if (/^\/?(?:status|state|now|current|当前|状态|播放状态)$/i.test(trimmed)) {
    return { type: "status" };
  }
  if (/^\/?(?:queue|list|playlist|队列|列表)$/i.test(trimmed)) {
    return { type: "queue" };
  }
  const pickMatch = trimmed.match(/^\/?(?:pick|select|choose|选)\s*(?:第)?\s*(\d+)\s*(?:首|个)?$/i)
    || trimmed.match(/^第\s*(\d+)\s*首$/i);
  if (pickMatch?.[1]) {
    return { type: "pick", index: Math.max(1, Number(pickMatch[1] || 0)) };
  }
  if (/^\/?(?:pause|stop|暂停|停止)$/i.test(trimmed)) {
    return { type: "control", action: "pause" };
  }
  if (/^\/?(?:play|resume|继续|恢复)$/i.test(trimmed)) {
    return { type: "control", action: "play" };
  }
  if (/^\/?(?:next|skip|下一首|下一曲|切歌)$/i.test(trimmed)) {
    return { type: "control", action: "next" };
  }
  if (/^\/?(?:previous|prev|上一首|上一曲)$/i.test(trimmed)) {
    return { type: "control", action: "previous" };
  }

  const searchMatch = trimmed.match(/^\/?(?:search|find|搜歌|搜索)\s+(.+)$/i);
  if (searchMatch?.[1]) {
    const parsed = extractSourceHint(searchMatch[1], sourceList);
    return { type: "search", keyword: normalizeKeyword(parsed.text), source: parsed.source };
  }

  const addMatch = trimmed.match(/^\/?(?:add|enqueue|点歌)\s+(.+)$/i);
  if (addMatch?.[1]) {
    const parsed = extractSourceHint(addMatch[1], sourceList);
    return { type: "enqueue", keyword: normalizeKeyword(parsed.text), source: parsed.source };
  }

  const playKeywordMatch = trimmed.match(/^\/?(?:play|播放)\s+(.+)$/i);
  if (playKeywordMatch?.[1]) {
    const parsed = extractSourceHint(playKeywordMatch[1], sourceList);
    return { type: "enqueue", keyword: normalizeKeyword(parsed.text), source: parsed.source };
  }

  const naturalSearchMatch = trimmed.match(/^(?:搜歌|搜索)\s*(.+)$/i);
  if (naturalSearchMatch?.[1]) {
    const parsed = extractSourceHint(naturalSearchMatch[1], sourceList);
    return { type: "search", keyword: normalizeKeyword(parsed.text), source: parsed.source };
  }

  const naturalAddMatch = trimmed.match(/^(?:点歌|播放)\s*(.+)$/i);
  if (naturalAddMatch?.[1]) {
    const parsed = extractSourceHint(naturalAddMatch[1], sourceList);
    return { type: "enqueue", keyword: normalizeKeyword(parsed.text), source: parsed.source };
  }

  const sourceAsFirstToken = trimmed.match(/^([a-z0-9_-]+)\s+(.+)$/i);
  if (sourceAsFirstToken?.[1] && sourceValues.includes(String(sourceAsFirstToken[1]).toLowerCase())) {
    return {
      type: "enqueue",
      source: String(sourceAsFirstToken[1]).toLowerCase(),
      keyword: normalizeKeyword(sourceAsFirstToken[2])
    };
  }

  return { type: "enqueue", keyword: trimmed };
}

function buildStatusBody(snapshot = null, sourceList = []) {
  const queue = Array.isArray(snapshot?.queue) ? snapshot.queue : [];
  const currentTrack = snapshot?.currentTrack || null;
  const lines = [
    `状态：${snapshot?.isPlaying ? "播放中" : currentTrack ? "已暂停" : "空闲"}`,
    `音源：${pickSourceLabel(String(snapshot?.source || ""), sourceList)}`,
    `队列：${queue.length} 首`
  ];
  if (currentTrack) {
    lines.push(`当前：${formatTrackLine(currentTrack, -1, { current: true })}`);
  }
  if (queue.length > 1) {
    const rest = queue
      .filter((item) => String(item?.id || "") !== String(currentTrack?.id || ""))
      .slice(0, 3)
      .map((item, index) => formatTrackLine(item, index));
    if (rest.length) {
      lines.push("后续队列：");
      lines.push(...rest);
    }
  }
  return lines.join("\n");
}

function buildQueueBody(snapshot = null) {
  const queue = Array.isArray(snapshot?.queue) ? snapshot.queue : [];
  if (!queue.length) {
    return "当前队列为空，可以直接发送 `@music 点歌 夜曲`。";
  }
  return queue
    .slice(0, 8)
    .map((item, index) => {
      const marker = index === Number(snapshot?.currentIndex ?? -1) ? "▶" : `${index + 1}.`;
      const title = String(item?.title || "未命名曲目").trim();
      const artist = String(item?.artist || "未知艺术家").trim();
      const duration = Number(item?.duration || 0) > 0 ? ` · ${formatDuration(item.duration)}` : "";
      return `${marker} ${title} - ${artist}${duration}`;
    })
    .join("\n");
}

function buildSearchBody(keyword = "", candidates = [], sourceLabel = "") {
  if (!candidates.length) {
    return `没有找到“${keyword}”的可用结果。`;
  }
  const lines = [`已找到 ${candidates.length} 首候选${sourceLabel ? `，当前音源：${sourceLabel}` : ""}：`];
  lines.push(...candidates.map((item, index) => {
    const title = String(item?.title || "未命名曲目").trim();
    const artist = String(item?.artist || "未知艺术家").trim();
    const album = String(item?.album || item?.sourceLabel || item?.source || "").trim();
    const duration = Number(item?.duration || 0) > 0 ? ` · ${formatDuration(item.duration)}` : "";
    return `${index + 1}. ${title} - ${artist}${album ? ` · ${album}` : ""}${duration}`;
  }));
  lines.push("");
  lines.push("可继续发送：@music 选第 2 首");
  lines.push(`也可以直接点歌：@music 点歌 ${keyword}`);
  return lines.join("\n");
}

function buildCard({ title, body, subtitle = "", imageUrl = "", status = "succeeded", actions = [] } = {}) {
  return {
    type: "music-player",
    status,
    title: title || "音乐助手",
    subtitle,
    body,
    imageUrl: imageUrl || "",
    imageAlt: title || "音乐封面",
    actions: Array.isArray(actions) ? actions : []
  };
}

function buildInvokeBotAction(label = "", rawText = "", botId = "music.control") {
  return {
    type: "invoke-bot",
    label: String(label || "").trim(),
    botId,
    rawText: String(rawText || "").trim()
  };
}

function buildCommonMusicActions(snapshot = null) {
  const currentTrack = snapshot?.currentTrack || null;
  const queue = Array.isArray(snapshot?.queue) ? snapshot.queue : [];
  const actions = [buildInvokeBotAction("查看队列", "队列")];
  if (currentTrack) {
    actions.unshift(buildInvokeBotAction(snapshot?.isPlaying ? "一键暂停" : "一键播放", snapshot?.isPlaying ? "暂停" : "继续"));
    if (queue.length > 1) {
      actions.push(buildInvokeBotAction("下一曲", "下一曲"));
    }
  }
  return actions;
}

function buildSearchActions(candidates = [], snapshot = null) {
  const actions = [];
  for (let index = 0; index < Math.min(3, candidates.length); index += 1) {
    actions.push(buildInvokeBotAction(`选第 ${index + 1} 首`, `选第 ${index + 1} 首`));
  }
  return [...actions, ...buildCommonMusicActions(snapshot)];
}

function getSearchMemoryPath(appDataRoot = "") {
  return path.join(String(appDataRoot || ""), MUSIC_SEARCH_MEMORY_DIR, MUSIC_SEARCH_MEMORY_FILE);
}

function createSearchMemoryKey(context = {}) {
  return [
    String(context?.chat?.hostClientId || "").trim(),
    String(context?.chat?.historyPath || "").trim(),
    String(context?.requester?.userId || context?.requester?.displayName || "anonymous").trim()
  ].join("::");
}

async function readSearchMemory(appDataRoot = "") {
  try {
    const raw = await fs.promises.readFile(getSearchMemoryPath(appDataRoot), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSearchMemory(appDataRoot = "", value = {}) {
  const filePath = getSearchMemoryPath(appDataRoot);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pruneSearchMemoryEntries(memory = {}) {
  const now = Date.now();
  const entries = Object.entries(memory || {})
    .filter(([, item]) => {
      const updatedAt = Date.parse(String(item?.updatedAt || ""));
      return Number.isFinite(updatedAt) && now - updatedAt <= MUSIC_SEARCH_MEMORY_MAX_AGE_MS;
    })
    .sort((left, right) => {
      const leftTime = Date.parse(String(left[1]?.updatedAt || "")) || 0;
      const rightTime = Date.parse(String(right[1]?.updatedAt || "")) || 0;
      return rightTime - leftTime;
    })
    .slice(0, MUSIC_SEARCH_MEMORY_MAX_ENTRIES);
  return Object.fromEntries(entries);
}

async function rememberSearchResult(appDataRoot = "", context = {}, payload = {}) {
  const key = createSearchMemoryKey(context);
  if (!key) {
    return;
  }
  const current = pruneSearchMemoryEntries(await readSearchMemory(appDataRoot));
  current[key] = {
    updatedAt: new Date().toISOString(),
    keyword: String(payload.keyword || "").trim(),
    source: String(payload.source || "").trim(),
    candidates: Array.isArray(payload.candidates) ? payload.candidates : []
  };
  await writeSearchMemory(appDataRoot, pruneSearchMemoryEntries(current));
}

async function readRememberedSearch(appDataRoot = "", context = {}) {
  const key = createSearchMemoryKey(context);
  if (!key) {
    return null;
  }
  const current = pruneSearchMemoryEntries(await readSearchMemory(appDataRoot));
  const hit = current[key];
  if (!hit) {
    return null;
  }
  await writeSearchMemory(appDataRoot, current);
  return hit;
}

async function publishMusicReply(api, payload = {}) {
  return api.publishChatReply({
    text: String(payload.text || payload.card?.body || "").trim(),
    card: payload.card
  });
}

export function createMusicControlPlugin() {
  return createBotPlugin({
    botId: "music.control",
    displayName: "音乐助手",
    aliases: ["music", "song", "dj", "player"],
    description: "控制网页上的共享音乐播放器，支持搜歌、点歌、切歌、暂停和查看队列。",
    capabilities: ["music.control", "music.search", "reply.chat"],
    permissions: {
      replyChat: true,
      publishJobEvents: true
    },
    limits: {
      maxConcurrentJobs: 2,
      timeoutMs: 5 * 60 * 1000
    },
    async execute(context, api) {
      const getMusicPlayer = api.dependencies?.getMusicPlayer;
      if (typeof getMusicPlayer !== "function") {
        throw new Error("music player runtime is unavailable");
      }
      const player = await getMusicPlayer();
      const initialSnapshot = player.snapshot();
      const sourceList = normalizeSourceList(initialSnapshot);
      const command = parseMusicCommand(extractPrompt(context), sourceList);

      await api.appendLog(`music command: ${JSON.stringify(command)}`);
      await api.emitProgress({ phase: "parse-input", label: "解析音乐指令", percent: 12 });

      if (command.type === "status") {
        const snapshot = player.snapshot();
        const body = buildStatusBody(snapshot, sourceList);
        return {
          chatReply: await publishMusicReply(api, {
            card: buildCard({
              title: "音乐播放状态",
              subtitle: snapshot?.currentTrack ? `${snapshot.isPlaying ? "播放中" : "已暂停"} · ${pickSourceLabel(snapshot.source, sourceList)}` : `当前音源：${pickSourceLabel(snapshot.source, sourceList)}`,
              body,
              imageUrl: snapshot?.currentTrack?.coverUrl || "",
              status: snapshot?.currentTrack ? "succeeded" : "info",
              actions: buildCommonMusicActions(snapshot)
            })
          }),
          importedFiles: [],
          artifacts: [{ type: "music-status", queueSize: Array.isArray(snapshot?.queue) ? snapshot.queue.length : 0 }]
        };
      }

      if (command.type === "queue") {
        const snapshot = player.snapshot();
        const body = buildQueueBody(snapshot);
        return {
          chatReply: await publishMusicReply(api, {
            card: buildCard({
              title: "当前播放队列",
              subtitle: `共 ${Array.isArray(snapshot?.queue) ? snapshot.queue.length : 0} 首`,
              body,
              imageUrl: snapshot?.currentTrack?.coverUrl || "",
              status: "info",
              actions: buildCommonMusicActions(snapshot)
            })
          }),
          importedFiles: [],
          artifacts: [{ type: "music-queue", queueSize: Array.isArray(snapshot?.queue) ? snapshot.queue.length : 0 }]
        };
      }

      if (command.type === "source") {
        const target = sourceList.find((item) => item.value === command.source);
        if (!target) {
          throw new Error(`不支持音源 ${command.source || ""}，可用音源：${sourceList.map((item) => item.value).join(", ")}`);
        }
        await api.emitProgress({ phase: "set-source", label: `切换音源到 ${target.label}`, percent: 56 });
        await player.control("set-source", { source: target.value });
        const snapshot = player.snapshot();
        const body = `默认音源已切换为 ${target.label}。\n之后可以直接发送：@music 点歌 歌名`;
        return {
          chatReply: await publishMusicReply(api, {
            card: buildCard({
              title: "音乐音源已更新",
              subtitle: `当前默认音源：${target.label}`,
              body,
              imageUrl: snapshot?.currentTrack?.coverUrl || "",
              status: "succeeded",
              actions: buildCommonMusicActions(snapshot)
            })
          }),
          importedFiles: [],
          artifacts: [{ type: "music-source", source: target.value }]
        };
      }

      if (command.type === "search") {
        if (!command.keyword) {
          throw new Error("请给出要搜索的歌名，例如 @music 搜歌 夜曲");
        }
        const searchSource = command.source || String(initialSnapshot?.source || "") || "bilibili";
        await api.emitProgress({ phase: "search", label: `搜索 ${command.keyword}`, percent: 46 });
        const candidates = await player.searchCandidates({ keyword: command.keyword, source: searchSource, limit: 6 });
        await rememberSearchResult(api.appDataRoot, context, {
          keyword: command.keyword,
          source: searchSource,
          candidates
        });
        const body = buildSearchBody(command.keyword, candidates, pickSourceLabel(searchSource, sourceList));
        const snapshot = player.snapshot();
        return {
          chatReply: await publishMusicReply(api, {
            card: buildCard({
              title: `搜歌：${command.keyword}`,
              subtitle: `${pickSourceLabel(searchSource, sourceList)} · ${candidates.length} 条结果`,
              body,
              imageUrl: candidates[0]?.coverUrl || initialSnapshot?.currentTrack?.coverUrl || "",
              status: candidates.length ? "succeeded" : "info",
              actions: buildSearchActions(candidates, snapshot)
            })
          }),
          importedFiles: [],
          artifacts: [{ type: "music-search", keyword: command.keyword, count: candidates.length, source: searchSource }]
        };
      }

      if (command.type === "pick") {
        const remembered = await readRememberedSearch(api.appDataRoot, context);
        if (!remembered?.candidates?.length) {
          throw new Error("还没有可选的搜索结果，请先发送 @music 搜歌 歌名");
        }
        const candidateIndex = Math.max(0, Number(command.index || 1) - 1);
        const candidate = remembered.candidates[candidateIndex] || null;
        if (!candidate) {
          throw new Error(`最近一次搜索只有 ${remembered.candidates.length} 首候选，无法选择第 ${command.index} 首`);
        }
        await api.emitProgress({ phase: "enqueue-pick", label: `加入第 ${command.index} 首候选`, percent: 54 });
        const track = await player.enqueueSelection({
          source: candidate.source || remembered.source || String(initialSnapshot?.source || "") || "bilibili",
          candidate,
          submittedBy: context?.requester?.displayName || context?.requester?.userId || "bot"
        });
        const snapshot = player.snapshot();
        const body = [
          `已将最近搜索结果中的第 ${command.index} 首加入播放队列。`,
          formatTrackLine(track, candidateIndex),
          remembered.keyword ? `来源搜索：${remembered.keyword}` : "",
          `当前队列：${Array.isArray(snapshot?.queue) ? snapshot.queue.length : 0} 首`
        ].filter(Boolean).join("\n");
        return {
          chatReply: await publishMusicReply(api, {
            card: buildCard({
              title: `已加入第 ${command.index} 首`,
              subtitle: `${pickSourceLabel(track.source, normalizeSourceList(snapshot))} · 队列 ${Array.isArray(snapshot?.queue) ? snapshot.queue.length : 0}`,
              body,
              imageUrl: track?.coverUrl || snapshot?.currentTrack?.coverUrl || "",
              status: "succeeded",
              actions: buildCommonMusicActions(snapshot)
            })
          }),
          importedFiles: [],
          artifacts: [{ type: "music-pick", selectedIndex: command.index, trackId: String(track?.id || "") }]
        };
      }

      if (command.type === "enqueue") {
        if (!command.keyword) {
          throw new Error("请给出要点播的歌名，例如 @music 点歌 晴天");
        }
        const enqueueSource = command.source || String(initialSnapshot?.source || "") || "bilibili";
        await api.emitProgress({ phase: "enqueue", label: `加入队列：${command.keyword}`, percent: 52 });
        const track = await player.enqueueTrack({
          keyword: command.keyword,
          source: enqueueSource,
          submittedBy: context?.requester?.displayName || context?.requester?.userId || "bot"
        });
        const snapshot = player.snapshot();
        const body = [
          `已加入全局播放队列。`,
          formatTrackLine(track, -1, { current: false }),
          `当前队列：${Array.isArray(snapshot?.queue) ? snapshot.queue.length : 0} 首`
        ].join("\n");
        return {
          chatReply: await publishMusicReply(api, {
            card: buildCard({
              title: "已加入播放队列",
              subtitle: `${pickSourceLabel(track.source, sourceList)} · 队列 ${Array.isArray(snapshot?.queue) ? snapshot.queue.length : 0}`,
              body,
              imageUrl: track?.coverUrl || snapshot?.currentTrack?.coverUrl || "",
              status: "succeeded",
              actions: buildCommonMusicActions(snapshot)
            })
          }),
          importedFiles: [],
          artifacts: [{ type: "music-enqueue", trackId: String(track?.id || ""), source: track?.source || enqueueSource }]
        };
      }

      if (command.type === "control") {
        const snapshotBefore = player.snapshot();
        if (!snapshotBefore?.currentTrack && command.action === "play") {
          throw new Error("当前没有可播放的曲目，请先点歌");
        }
        await api.emitProgress({ phase: "control", label: `执行 ${command.action} 指令`, percent: 44 });
        await player.control(command.action, {
          currentTrackId: String(snapshotBefore?.currentTrack?.id || "")
        });
        const snapshot = player.snapshot();
        const actionTextMap = {
          play: "已开始播放",
          pause: "已暂停播放",
          next: "已切到下一首",
          previous: "已切回上一首"
        };
        const body = buildStatusBody(snapshot, normalizeSourceList(snapshot));
        return {
          chatReply: await publishMusicReply(api, {
            card: buildCard({
              title: actionTextMap[command.action] || "音乐控制已执行",
              subtitle: snapshot?.currentTrack ? formatTrackLine(snapshot.currentTrack, -1, { current: true }) : "当前没有曲目",
              body,
              imageUrl: snapshot?.currentTrack?.coverUrl || "",
              status: "succeeded",
              actions: buildCommonMusicActions(snapshot)
            })
          }),
          importedFiles: [],
          artifacts: [{ type: "music-control", action: command.action }]
        };
      }

      throw new Error("无法识别音乐指令");
    }
  });
}