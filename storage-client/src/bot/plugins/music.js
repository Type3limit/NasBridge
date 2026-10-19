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
  // Buttons on the jukebox cards carry ids so whoever clicks acts on that exact song.
  const pickSearchMatch = trimmed.match(/^选\s+([a-z0-9]+)\s+(\d+)$/i);
  if (pickSearchMatch) {
    return { type: "pick-search", searchId: pickSearchMatch[1], index: Math.max(1, Number(pickSearchMatch[2])) };
  }
  const voteMatch = trimmed.match(/^(?:赞|like)\s+(\S+)$/i);
  if (voteMatch) {
    return { type: "vote", trackId: voteMatch[1] };
  }
  const skipMatch = trimmed.match(/^\/?(?:next|skip|下一首|下一曲|切歌|跳过)(?:\s+(\S+))?$/i);
  if (skipMatch) {
    return { type: "skip", trackId: String(skipMatch[1] || "") };
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

  // A bare song name shows candidates to pick from (`@点歌 晴天`).
  return { type: "search", keyword: trimmed };
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

// Card buttons that rewrite their own card instead of posting a new message.
function buildInPlaceAction(label = "", rawText = "") {
  return {
    ...buildInvokeBotAction(label, rawText),
    parsedArgs: { prompt: String(rawText || "").trim(), __chatReplyMode: "replace-chat-message" }
  };
}

function requesterActor(context = {}) {
  const id = String(context?.requester?.userId || "").trim();
  return id ? { id, name: String(context?.requester?.displayName || "").trim(), role: String(context?.requester?.role || "user") } : null;
}

function upcomingOf(snapshot = null) {
  const queue = Array.isArray(snapshot?.queue) ? snapshot.queue : [];
  return queue.slice(Number(snapshot?.currentIndex ?? -1) + 1);
}

function buildCandidateCard(keyword = "", searchId = "", candidates = []) {
  const shown = candidates.slice(0, 5);
  return buildCard({
    title: `点歌：${keyword}`,
    subtitle: shown.length ? `QQ 音乐 · ${shown.length} 首候选，点一下入队` : "QQ 音乐",
    body: shown.length
      ? shown.map((item, index) => `${index + 1}. ${item.title} - ${item.artist || "未知艺术家"}${item.duration ? ` · ${formatDuration(item.duration)}` : ""}`).join("\n")
      : `没有找到“${keyword}”。`,
    imageUrl: shown[0]?.coverUrl || "",
    status: shown.length ? "info" : "failed",
    actions: shown.map((item, index) => buildInPlaceAction(`${index + 1}. ${item.title}`.slice(0, 24), `选 ${searchId} ${index + 1}`))
  });
}

// "XX 点了《…》，排第 N"; becomes "正在播放" / "已播放" once the song's turn comes.
function buildRequestCard(trackId = "", snapshot = null) {
  const queue = Array.isArray(snapshot?.queue) ? snapshot.queue : [];
  const track = queue.find((item) => item.id === trackId);
  if (!track) {
    return buildCard({ title: "这首歌已经不在队列里了", body: "可能被撤回或移除了。", status: "info" });
  }
  const upcoming = upcomingOf(snapshot);
  const position = upcoming.findIndex((item) => item.id === trackId);
  const playing = snapshot?.currentTrack?.id === trackId;
  const who = track.submittedBy || "有人";
  const state = playing ? "正在播放" : position >= 0 ? `排第 ${position + 1}` : "已播放，在循环列表里";
  return buildCard({
    title: `${who} 点了《${track.title}》`,
    subtitle: `${track.artist} · ${state}${track.votes ? ` · ${track.votes} 赞` : ""}`,
    body: `${who} 点了《${track.title}》，${state}。`,
    imageUrl: track.coverUrl || "",
    status: "succeeded",
    actions: position >= 0
      ? [buildInPlaceAction(`👍 点赞 ${track.votes || ""}`.trim(), `赞 ${trackId}`)]
      : playing ? [buildInPlaceAction("投票切歌", `跳过 ${trackId}`)] : []
  });
}

function buildSkipCard(snapshot = null, skippedTitle = "") {
  const current = snapshot?.currentTrack || null;
  if (skippedTitle) {
    const reason = snapshot?.lastSkip?.reason;
    const why = reason === "vote" ? `${snapshot.lastSkip.votes} 人投票` : reason === "admin" ? "管理员操作" : reason === "requester" ? "点歌人自己" : "";
    return buildCard({
      title: `已跳过《${skippedTitle}》`,
      subtitle: current ? `现在播放：${current.title} - ${current.artist}` : "",
      body: `${why ? `${why}跳过了` : "跳过了"}《${skippedTitle}》。`,
      imageUrl: current?.coverUrl || "",
      status: "succeeded"
    });
  }
  const skip = snapshot?.skip || { votes: 0, needed: 1 };
  return buildCard({
    title: `投票切歌 ${skip.votes}/${skip.needed}`,
    subtitle: current ? `${current.title} - ${current.artist}` : "",
    body: `再有 ${Math.max(0, skip.needed - skip.votes)} 人投票就切掉《${current?.title || ""}》（在线 ${skip.listeners} 人的一半）。`,
    imageUrl: current?.coverUrl || "",
    status: "info",
    actions: current ? [buildInPlaceAction("我也投", `跳过 ${current.id}`)] : []
  });
}

function createSearchId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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

async function rememberSearchResult(appDataRoot = "", context = {}, payload = {}, searchId = "") {
  const key = searchId ? `search:${searchId}` : createSearchMemoryKey(context);
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

async function readRememberedSearch(appDataRoot = "", context = {}, searchId = "") {
  const key = searchId ? `search:${searchId}` : createSearchMemoryKey(context);
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
    aliases: ["music", "song", "dj", "player", "点歌"],
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
        const searchSource = command.source || String(initialSnapshot?.source || "") || "qq";
        await api.emitProgress({ phase: "search", label: `搜索 ${command.keyword}`, percent: 46 });
        const candidates = await player.searchCandidates({ keyword: command.keyword, source: searchSource, limit: 6 });
        const remembered = { keyword: command.keyword, source: searchSource, candidates };
        const searchId = createSearchId();
        // Kept per person for typed "选第 2 首", and per search for the card's buttons.
        await rememberSearchResult(api.appDataRoot, context, remembered);
        await rememberSearchResult(api.appDataRoot, context, remembered, searchId);
        return {
          chatReply: await publishMusicReply(api, {
            card: buildCandidateCard(command.keyword, searchId, candidates)
          }),
          importedFiles: [],
          artifacts: [{ type: "music-search", keyword: command.keyword, count: candidates.length, source: searchSource }]
        };
      }

      if (command.type === "pick-search") {
        const remembered = await readRememberedSearch(api.appDataRoot, context, command.searchId);
        const candidate = remembered?.candidates?.[command.index - 1] || null;
        if (!candidate) {
          throw new Error("这组候选已经过期了，请重新 @点歌 歌名");
        }
        await api.emitProgress({ phase: "enqueue-pick", label: `点歌：${candidate.title}`, percent: 54 });
        const track = await player.enqueueSelection({
          source: candidate.source || remembered.source || "qq",
          candidate,
          submittedBy: context?.requester?.displayName || context?.requester?.userId || "bot",
          requester: requesterActor(context)
        });
        return {
          chatReply: await publishMusicReply(api, { card: buildRequestCard(String(track?.id || ""), player.snapshot()) }),
          importedFiles: [],
          artifacts: [{ type: "music-pick", selectedIndex: command.index, trackId: String(track?.id || "") }]
        };
      }

      if (command.type === "vote") {
        await player.control("vote-track", { trackId: command.trackId, actor: requesterActor(context) });
        return {
          chatReply: await publishMusicReply(api, { card: buildRequestCard(command.trackId, player.snapshot()) }),
          importedFiles: [],
          artifacts: [{ type: "music-vote", trackId: command.trackId }]
        };
      }

      if (command.type === "skip") {
        const before = player.snapshot().currentTrack;
        if (!before) {
          throw new Error("现在没有在放的歌");
        }
        if (command.trackId && command.trackId !== before.id) {
          return {
            chatReply: await publishMusicReply(api, { card: buildCard({ title: "这首已经放完了", body: `现在放的是《${before.title}》。`, imageUrl: before.coverUrl || "", status: "info" }) }),
            importedFiles: [],
            artifacts: [{ type: "music-skip", skipped: false }]
          };
        }
        await player.control("skip-vote", { actor: requesterActor(context), currentTrackId: before.id });
        const snapshot = player.snapshot();
        const skipped = snapshot.currentTrack?.id !== before.id;
        return {
          chatReply: await publishMusicReply(api, { card: buildSkipCard(snapshot, skipped ? before.title : "") }),
          importedFiles: [],
          artifacts: [{ type: "music-skip", skipped }]
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
          source: candidate.source || remembered.source || String(initialSnapshot?.source || "") || "qq",
          candidate,
          submittedBy: context?.requester?.displayName || context?.requester?.userId || "bot",
          requester: requesterActor(context)
        });
        return {
          chatReply: await publishMusicReply(api, { card: buildRequestCard(String(track?.id || ""), player.snapshot()) }),
          importedFiles: [],
          artifacts: [{ type: "music-pick", selectedIndex: command.index, trackId: String(track?.id || "") }]
        };
      }

      if (command.type === "enqueue") {
        if (!command.keyword) {
          throw new Error("请给出要点播的歌名，例如 @music 点歌 晴天");
        }
        const enqueueSource = command.source || String(initialSnapshot?.source || "") || "qq";
        await api.emitProgress({ phase: "enqueue", label: `加入队列：${command.keyword}`, percent: 52 });
        const track = await player.enqueueTrack({
          keyword: command.keyword,
          source: enqueueSource,
          submittedBy: context?.requester?.displayName || context?.requester?.userId || "bot",
          requester: requesterActor(context)
        });
        return {
          chatReply: await publishMusicReply(api, { card: buildRequestCard(String(track?.id || ""), player.snapshot()) }),
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