import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createBotRuntime } from "../storage-client/src/bot/runtime.js";

const REPO_ROOT = process.cwd();
const TEMP_ROOT = path.join(REPO_ROOT, ".tmp", "ai-chat-integration");
const STORAGE_ROOT = path.join(TEMP_ROOT, "storage");
const APP_DATA_ROOT = path.join(TEMP_ROOT, "appdata");
const HISTORY_PATH = ".nas-chat-room/history/2026-03-19.jsonl";
const ATTACHMENT_PATH = ".nas-chat-room/attachments/2026-03-19/vision.svg";
const LARGE_ATTACHMENT_PATH = ".nas-chat-room/attachments/2026-03-19/vision-large.svg";
const HOST_CLIENT_ID = "integration-client";
const FINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "expired"]);
const SEARCH_QUERY = "LangGraph.js 最新更新";
const SEARCH_RESULT_URL = "https://docs.example.com/langgraph/releases/latest";
const SEARCH_NEWS_URL = "https://news.example.com/langgraph-2026";
const DIRECT_PAGE_PROMPT = `最新更新，结合这个网页看看呢：${SEARCH_RESULT_URL}`;
const CHECKPOINT_ROOT = path.join(APP_DATA_ROOT, "ai-chat-graph");
const FAIL_TOOL_QUERY = "FAIL_TOOL_CASE";
const CANCEL_TEXT_QUERY = "CANCEL_STREAM_CASE";

function readCliOption(name, fallback = "") {
  const prefix = `--${name}=`;
  const matched = process.argv.find((item) => item.startsWith(prefix));
  return matched ? matched.slice(prefix.length).trim() : fallback;
}

function parseConfig() {
  const providerMode = String(readCliOption("provider", process.env.AI_CHAT_INTEGRATION_PROVIDER || "mock") || "mock").trim().toLowerCase();
  const webMode = String(readCliOption("web", process.env.AI_CHAT_INTEGRATION_WEB || "mock") || "mock").trim().toLowerCase();
  if (!["mock", "real"].includes(providerMode)) {
    throw new Error(`unsupported provider mode: ${providerMode}`);
  }
  if (!["mock", "real"].includes(webMode)) {
    throw new Error(`unsupported web mode: ${webMode}`);
  }
  return { providerMode, webMode };
}

function ensureCleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createHistoryFixtures() {
  const absoluteHistoryPath = path.join(STORAGE_ROOT, HISTORY_PATH);
  appendJsonLine(absoluteHistoryPath, {
    id: "chat-1",
    text: "昨晚我们已经把 LangGraph 高层入口接进 ai.chat 了。",
    createdAt: "2026-03-19T08:00:00.000Z",
    dayKey: "2026-03-19",
    historyPath: HISTORY_PATH,
    hostClientId: HOST_CLIENT_ID,
    author: {
      id: "user:alice",
      displayName: "Alice"
    },
    attachments: []
  });
  appendJsonLine(absoluteHistoryPath, {
    id: "chat-2",
    text: "现在要分别验证 command、text、vision、delegate、search_web 工具回合。",
    createdAt: "2026-03-19T08:01:00.000Z",
    dayKey: "2026-03-19",
    historyPath: HISTORY_PATH,
    hostClientId: HOST_CLIENT_ID,
    author: {
      id: "user:bob",
      displayName: "Bob"
    },
    attachments: []
  });

  const absoluteAttachmentPath = path.join(STORAGE_ROOT, ATTACHMENT_PATH);
  fs.mkdirSync(path.dirname(absoluteAttachmentPath), { recursive: true });
  fs.writeFileSync(absoluteAttachmentPath, [
    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"640\" height=\"360\" viewBox=\"0 0 640 360\">",
    "  <rect width=\"640\" height=\"360\" fill=\"#f8f4ea\" />",
    "  <rect x=\"32\" y=\"42\" width=\"576\" height=\"276\" rx=\"24\" fill=\"#17324d\" />",
    "  <text x=\"320\" y=\"150\" text-anchor=\"middle\" font-size=\"34\" fill=\"#ffffff\" font-family=\"Segoe UI, Arial\">LangGraph Vision Smoke</text>",
    "  <text x=\"320\" y=\"205\" text-anchor=\"middle\" font-size=\"24\" fill=\"#d8edf8\" font-family=\"Segoe UI, Arial\">The card says: hello from image fixture</text>",
    "</svg>"
  ].join("\n"), "utf8");

  const absoluteLargeAttachmentPath = path.join(STORAGE_ROOT, LARGE_ATTACHMENT_PATH);
  fs.mkdirSync(path.dirname(absoluteLargeAttachmentPath), { recursive: true });
  fs.writeFileSync(absoluteLargeAttachmentPath, `<svg xmlns="http://www.w3.org/2000/svg"><desc>${"L".repeat(6 * 1024 * 1024)}</desc></svg>`, "utf8");
}

function createAttachmentPayload() {
  const absoluteAttachmentPath = path.join(STORAGE_ROOT, ATTACHMENT_PATH);
  const stat = fs.statSync(absoluteAttachmentPath);
  return [{
    id: `${HOST_CLIENT_ID}:${ATTACHMENT_PATH}`,
    name: "vision.svg",
    mimeType: "image/svg+xml",
    size: stat.size,
    path: ATTACHMENT_PATH,
    clientId: HOST_CLIENT_ID,
    kind: "file"
  }];
}

function createLargeAttachmentPayload() {
  const absoluteAttachmentPath = path.join(STORAGE_ROOT, LARGE_ATTACHMENT_PATH);
  const stat = fs.statSync(absoluteAttachmentPath);
  return [{
    id: `${HOST_CLIENT_ID}:${LARGE_ATTACHMENT_PATH}`,
    name: "vision-large.svg",
    mimeType: "image/svg+xml",
    size: stat.size,
    path: LARGE_ATTACHMENT_PATH,
    clientId: HOST_CLIENT_ID,
    kind: "file"
  }];
}

function buildInvocation(rawText, attachments = []) {
  return {
    botId: "ai.chat",
    trigger: {
      type: "manual",
      rawText,
      parsedArgs: {
        prompt: rawText.replace(/^\s*@\s*(?:ai|assistant)\b\s*/i, "").trim()
      }
    },
    requester: {
      userId: "integration-user",
      displayName: "Integration Runner",
      role: "admin"
    },
    chat: {
      hostClientId: HOST_CLIENT_ID,
      dayKey: "2026-03-19",
      historyPath: HISTORY_PATH,
      messageId: `message-${Date.now().toString(36)}`,
      replyMode: "append-chat-history"
    },
    attachments
  };
}

function extractLatestUserMessage(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      const textParts = message.content
        .filter((item) => item?.type === "text")
        .map((item) => String(item.text || "").trim())
        .filter(Boolean);
      if (textParts.length) {
        return textParts.join(" ");
      }
    }
  }
  return "";
}

function extractLatestToolPayload(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "tool") {
      continue;
    }
    const raw = String(message.content || "").trim();
    if (!raw) {
      continue;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return { _raw: raw };
    }
  }
  return null;
}

function tokenizeText(text = "") {
  return String(text || "")
    .split(/(\s+)/)
    .filter((part) => part.length > 0);
}

function writeSseChunk(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function createJsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}

function createHtmlResponse(html, status = 200, headers = {}) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...headers
    }
  });
}

function buildMockSearchHtml(query = "") {
  return [
    "<!doctype html>",
    "<html><head><title>Mock Search</title></head><body>",
    `<div class=\"results\"><a class=\"result__a\" href=\"${SEARCH_RESULT_URL}\">LangGraph.js release notes for ${query}</a></div>`,
    `<div class=\"result__snippet\">Official docs mention the latest LangGraph.js runtime updates and migration notes.</div>`,
    `<div class=\"results\"><a class=\"result__a\" href=\"${SEARCH_NEWS_URL}\">LangGraph.js 2026 update roundup</a></div>`,
    "<div class=\"result__snippet\">News recap covering the latest public LangGraph.js release highlights.</div>",
    "</body></html>"
  ].join("");
}

function buildMockPageHtml(url = "") {
  if (url === SEARCH_RESULT_URL) {
    return [
      "<!doctype html>",
      "<html><head><title>LangGraph.js Latest Release</title><meta name=\"description\" content=\"Latest LangGraph.js release summary\"></head><body>",
      "<main>",
      "<article>",
      "<p>LangGraph.js latest release adds graph-first orchestration tracing, improved state handling, and cleaner migration guidance for existing agent flows.</p>",
      "<p>The migration note highlights replacing high-level routing first, then gradually extracting helpers into dedicated nodes.</p>",
      "</article>",
      "</main>",
      "</body></html>"
    ].join("");
  }
  if (url === SEARCH_NEWS_URL) {
    return [
      "<!doctype html>",
      "<html><head><title>LangGraph.js News</title><meta name=\"description\" content=\"News summary\"></head><body>",
      "<main><p>News summary says the latest LangGraph.js update focused on diagnostics and graph routing.</p></main>",
      "</body></html>"
    ].join("");
  }
  return "<!doctype html><html><head><title>Unknown Mock Page</title></head><body><main><p>No content.</p></main></body></html>";
}

function installMockWebFetch() {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input?.url || "");
    if (/https:\/\/(?:html\.)?duckduckgo\.com\/html\//i.test(url) || /https:\/\/www\.bing\.com\/search/i.test(url)) {
      const parsed = new URL(url);
      const query = parsed.searchParams.get("q") || SEARCH_QUERY;
      return createHtmlResponse(buildMockSearchHtml(query));
    }
    if (url === SEARCH_RESULT_URL || url === SEARCH_NEWS_URL) {
      return createHtmlResponse(buildMockPageHtml(url));
    }
    return originalFetch(input, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMockAiServer() {
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && requestUrl.pathname === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        data: [
          {
            id: "mock-text",
            name: "mock-text",
            vendor: "integration",
            capabilities: { supports: { tool_calls: true } }
          },
          {
            id: "mock-vision",
            name: "mock-vision",
            vendor: "integration",
            capabilities: { supports: { vision: true } }
          }
        ]
      }));
      return;
    }

    if (request.method !== "POST" || requestUrl.pathname !== "/v1/chat/completions") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const model = String(body.model || "mock-text");
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userText = extractLatestUserMessage(messages);
    const toolPayload = extractLatestToolPayload(messages);
    const systemText = messages
      .filter((message) => message?.role === "system")
      .map((message) => typeof message.content === "string" ? message.content : "")
      .join("\n");
    const hasVisionInput = messages.some((message) => Array.isArray(message?.content) && message.content.some((item) => item?.type === "image_url"));
    const hasToolMessages = messages.some((message) => message?.role === "tool");
    const hasToolDefinitions = Array.isArray(body.tools) && body.tools.length > 0;
    const isFailToolCase = userText.includes(FAIL_TOOL_QUERY);
    const isCancelStreamCase = userText.includes(CANCEL_TEXT_QUERY);

    if (!body.stream) {
      if (systemText.includes("网页检索规划器")) {
        return response.end(JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          model,
          choices: [{
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                intent: SEARCH_QUERY,
                rationale: "需要联网查看最新公开资料。",
                strategy: ["先检索原始问题", "优先保留文档结果", "必要时抓取首条页面摘要"],
                searchTerms: [SEARCH_QUERY],
                preferredSource: "docs"
              })
            }
          }],
          usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 }
        }));
      }

      if (systemText.includes("网页检索二次决策器")) {
        return response.end(JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          model,
          choices: [{
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                needsPageFetch: true,
                answerableFromResults: false,
                reason: "需要进入第一条文档页确认最新更新摘要。",
                selectedIndexes: [1]
              })
            }
          }],
          usage: { prompt_tokens: 16, completion_tokens: 18, total_tokens: 34 }
        }));
      }

      if (hasToolDefinitions && !hasToolMessages && /\/search|最新|联网|release|更新/i.test(userText)) {
        const query = userText.includes(SEARCH_RESULT_URL) ? userText : SEARCH_QUERY;
        return response.end(JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          model,
          choices: [{
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "我先联网检索最新资料。",
              tool_calls: [{
                id: "toolcall-search-web-1",
                type: "function",
                function: {
                  name: "search_web",
                  arguments: JSON.stringify({
                    query,
                    preferredSource: "docs",
                    maxResults: 2,
                    fetchPages: 1
                  })
                }
              }]
            }
          }],
          usage: { prompt_tokens: 15, completion_tokens: 12, total_tokens: 27 }
        }));
      }

      if (hasToolDefinitions && !hasToolMessages && isFailToolCase) {
        return response.end(JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          model,
          choices: [{
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "我先尝试调用一个工具。",
              tool_calls: [{
                id: "toolcall-fail-unknown-1",
                type: "function",
                function: {
                  name: "unknown_tool_for_failure_test",
                  arguments: JSON.stringify({ query: FAIL_TOOL_QUERY })
                }
              }]
            }
          }],
          usage: { prompt_tokens: 12, completion_tokens: 12, total_tokens: 24 }
        }));
      }

      const content = hasToolMessages
        ? `SEARCH_PLAN_OK: tool result captured for ${toolPayload?.query || SEARCH_QUERY}`
        : `PLAN_OK for ${hasVisionInput ? "vision" : "text"}: ${userText || "(empty)"}`;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      }));
      return;
    }

    const content = hasVisionInput
      ? `VISION_OK: detected image input and prompt => ${userText || "(empty)"}`
      : toolPayload?.query
        ? `SEARCH_TOOL_OK: based on mocked web data, the latest LangGraph.js update adds better tracing, state handling, and migration guidance. Primary source: ${toolPayload.results?.[0]?.url || SEARCH_RESULT_URL}`
        : `TEXT_OK: ${userText || "(empty)"}`;

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    for (const token of tokenizeText(content)) {
      if (isCancelStreamCase) {
        await sleep(80);
      }
      writeSseChunk(response, {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: { content: token }, finish_reason: null }]
      });
      if (!isCancelStreamCase) {
        await sleep(3);
      }
    }
    writeSseChunk(response, {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    });
    response.end("data: [DONE]\n\n");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}/v1`
      });
    });
  });
}

function createMockMusicPlayer() {
  const state = {
    source: "qq",
    supportedSources: [
      { value: "qq", label: "QQ 音乐" },
      { value: "kugou", label: "酷狗" }
    ],
    queue: [{
      id: "mock-track-1",
      source: "qq",
      title: "Mock Song",
      artist: "Mock Artist",
      duration: 215,
      status: "ready"
    }],
    currentIndex: 0,
    isPlaying: true,
    currentTrack: {
      id: "mock-track-1",
      source: "qq",
      title: "Mock Song",
      artist: "Mock Artist",
      duration: 215,
      status: "ready"
    }
  };

  return {
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    },
    async control(action, payload = {}) {
      if (action === "pause") {
        state.isPlaying = false;
      }
      if (action === "play") {
        state.isPlaying = true;
      }
      if (action === "set-source" && payload.source) {
        state.source = String(payload.source);
      }
    },
    async searchCandidates({ keyword = "", source = "qq" } = {}) {
      return [{
        source,
        providerTrackId: `candidate-${keyword}`,
        title: `Result for ${keyword}`,
        artist: "Mock Artist",
        album: "Mock Album",
        duration: 200,
        coverUrl: ""
      }];
    },
    async enqueueSelection({ source = "qq", candidate = {} } = {}) {
      const track = {
        id: `queued-${Date.now()}`,
        source,
        title: String(candidate.title || "Queued Result"),
        artist: String(candidate.artist || "Mock Artist"),
        duration: Number(candidate.duration || 200),
        status: "ready"
      };
      state.queue.push(track);
      return track;
    },
    async enqueueTrack({ keyword = "", source = "qq" } = {}) {
      const track = {
        id: `queued-${Date.now()}`,
        source,
        title: keyword,
        artist: "Mock Artist",
        duration: 200,
        status: "ready"
      };
      state.queue.push(track);
      return track;
    }
  };
}

function hasRealProviderConfig() {
  const keys = [
    "AI_PROVIDER",
    "COPILOT_API_BASE_URL",
    "COPILOT_BASE_URL",
    "COPILOT_MODEL",
    "COPILOT_MULTIMODAL_MODEL",
    "COPILOT_API_KEY",
    "COPILOT_AUTH_TOKEN",
    "ARK_BASE_URL",
    "ARK_MODEL",
    "ARK_MULTIMODAL_MODEL",
    "ARK_ENDPOINT_ID",
    "ARK_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "OPENAI_MULTIMODAL_MODEL",
    "OPENAI_API_KEY"
  ];
  return keys.some((key) => String(process.env[key] || "").trim());
}

async function waitForJob(runtime, jobId) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const job = await runtime.getJob(jobId);
    if (job && FINAL_STATUSES.has(job.status)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job wait timeout: ${jobId}`);
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return filePath;
    }
    await sleep(25);
  }
  throw new Error(`file wait timeout: ${filePath}`);
}

function writeSyntheticTextToolsRecoveryCheckpoint(sessionId = 5) {
  const jobId = `synthetic-texttools-retry-${sessionId}`;
  const savedAt = new Date().toISOString();
  const executionPath = path.join(CHECKPOINT_ROOT, "executions", `${jobId}.json`);
  const tracePath = path.join(CHECKPOINT_ROOT, "traces", `${jobId}.jsonl`);
  const sessionPath = path.join(CHECKPOINT_ROOT, "sessions", `${sessionId}.json`);
  const toolInput = {
    limit: 6,
    includeBots: true,
    lookbackDays: 1
  };

  writeJsonFile(executionPath, {
    savedAt,
    jobId,
    botId: "ai.chat",
    sessionId,
    status: "failed",
    route: "text",
    hostClientId: HOST_CLIENT_ID,
    historyPath: HISTORY_PATH,
    traceSummary: {
      count: 3,
      nodes: ["prepareInput", "prepareContext", "textTools"],
      lastNode: "textTools",
      lastStatus: "failed",
      lastAt: savedAt
    },
    trace: [{ node: "textTools", status: "failed", at: savedAt, route: "text" }],
    recoveryState: {
      toolRound: 1,
      pendingToolNames: ["read_chat_history"],
      pendingToolCalls: [{
        id: "toolcall-history-retry-1",
        name: "read_chat_history",
        input: toolInput
      }],
      planningMessages: [
        { role: "system", content: "你是 NAS 聊天室里的 AI 助手。" },
        { role: "user", content: "请先补读最近聊天，再继续回答 LangGraph 联调情况。" },
        {
          role: "assistant",
          content: "我先读取最近聊天记录。",
          tool_calls: [{
            id: "toolcall-history-retry-1",
            type: "function",
            function: {
              name: "read_chat_history",
              arguments: JSON.stringify(toolInput)
            }
          }]
        }
      ],
      modelResult: null
    },
    result: {
      reply: null,
      importedFiles: { count: 0, items: [] },
      artifactSummary: { types: [], countsByType: {}, delegatedJobIds: [], sessionIds: [], models: [] },
      artifacts: []
    },
    error: {
      name: "Error",
      message: "synthetic recovery fixture for read_chat_history direct retry"
    }
  });

  appendJsonLine(tracePath, {
    sequence: 1,
    at: savedAt,
    jobId,
    botId: "ai.chat",
    sessionId,
    kind: "node",
    node: "textTools",
    event: "failed",
    route: "text",
    status: "failed",
    detail: "synthetic recovery fixture"
  });

  writeJsonFile(sessionPath, {
    savedAt,
    sessionId,
    latestExecution: {
      jobId,
      status: "failed",
      route: "text",
      traceCount: 3,
      lastNode: "textTools",
      historyPath: HISTORY_PATH,
      replyPreview: "",
      snapshotPath: executionPath,
      tracePath
    }
  });
}

async function runCase(runtime, name, payload) {
  const accepted = await runtime.invoke(payload);
  const job = await waitForJob(runtime, accepted.jobId);
  const log = await runtime.getJobLog(job.jobId, { maxBytes: 64 * 1024 });
  return {
    name,
    jobId: job.jobId,
    status: job.status,
    phase: job.phase,
    replyMessageId: String(job?.result?.replyMessageId || ""),
    log: log.content
  };
}

async function runCancelledCase(runtime, name, payload, cancelAfterMs = 40) {
  const accepted = await runtime.invoke(payload);
  await sleep(cancelAfterMs);
  await runtime.cancelJob(accepted.jobId);
  const job = await waitForJob(runtime, accepted.jobId);
  const log = await runtime.getJobLog(job.jobId, { maxBytes: 64 * 1024 });
  return {
    name,
    jobId: job.jobId,
    status: job.status,
    phase: job.phase,
    replyMessageId: String(job?.result?.replyMessageId || ""),
    log: log.content
  };
}

function assertSucceeded(result, label) {
  if (result.status !== "succeeded") {
    throw new Error(`${label} failed with status ${result.status}\n${result.log}`);
  }
}

function findPublishedMessage(messages, jobId, matcher) {
  return [...messages]
    .reverse()
    .find((item) => item?.bot?.jobId === jobId && (!matcher || matcher(item)));
}

function buildEnvBackup() {
  const keys = [
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_MULTIMODAL_MODEL",
    "AI_PROVIDER",
    "COPILOT_API_BASE_URL",
    "COPILOT_API_KEY",
    "COPILOT_AUTH_TOKEN",
    "ARK_BASE_URL",
    "ARK_API_KEY",
    "ARK_MODEL",
    "ARK_MULTIMODAL_MODEL",
    "ARK_ENDPOINT_ID",
    "BOT_WEB_SEARCH_BACKEND",
    "BOT_WEB_SEARCH_PROVIDER",
    "BOT_WEB_SEARCH_API_BACKEND",
    "BOT_WEB_SEARCH_API_KEY",
    "BOT_WEB_SEARCH_API_BASE_URL"
  ];
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(envBackup = {}) {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function main() {
  const config = parseConfig();
  ensureCleanDir(TEMP_ROOT);
  ensureCleanDir(STORAGE_ROOT);
  ensureCleanDir(APP_DATA_ROOT);
  createHistoryFixtures();

  const publishedMessages = [];
  const appendedMessages = [];
  const musicPlayer = createMockMusicPlayer();
  const envBackup = buildEnvBackup();

  let mockAi = null;
  let restoreFetch = null;
  if (config.providerMode === "real" && !hasRealProviderConfig()) {
    throw new Error("provider=real 但当前环境没有可用的真实模型配置，请先设置 OPENAI_*、COPILOT_* 或 ARK_* 相关环境变量。");
  }

  try {
    if (config.providerMode === "mock") {
      mockAi = await createMockAiServer();
      process.env.AI_PROVIDER = "openai";
      process.env.OPENAI_BASE_URL = mockAi.baseUrl;
      process.env.OPENAI_API_KEY = "integration-key";
      process.env.OPENAI_MODEL = "mock-text";
      process.env.OPENAI_MULTIMODAL_MODEL = "mock-vision";
      delete process.env.COPILOT_API_BASE_URL;
      delete process.env.COPILOT_API_KEY;
      delete process.env.COPILOT_AUTH_TOKEN;
      delete process.env.ARK_BASE_URL;
      delete process.env.ARK_API_KEY;
      delete process.env.ARK_MODEL;
      delete process.env.ARK_MULTIMODAL_MODEL;
      delete process.env.ARK_ENDPOINT_ID;
    }

    if (config.webMode === "mock") {
      process.env.BOT_WEB_SEARCH_BACKEND = "fetch";
      process.env.BOT_WEB_SEARCH_PROVIDER = "builtin";
      delete process.env.BOT_WEB_SEARCH_API_BACKEND;
      delete process.env.BOT_WEB_SEARCH_API_KEY;
      delete process.env.BOT_WEB_SEARCH_API_BASE_URL;
      restoreFetch = installMockWebFetch();
    }

    const runtime = createBotRuntime({
      clientId: HOST_CLIENT_ID,
      storageRoot: STORAGE_ROOT,
      appDataRoot: APP_DATA_ROOT,
      concurrency: 1,
      dependencies: {
        appendChatMessage: async (historyPath, message) => {
          appendedMessages.push(message);
          appendJsonLine(path.join(STORAGE_ROOT, historyPath), message);
        },
        publishChatMessage: async (message) => {
          publishedMessages.push(message);
        },
        getMusicPlayer: async () => musicPlayer
      }
    });

    try {
      await runtime.init();

      const commandResult = await runCase(runtime, "command", buildInvocation("@ai /new 联调会话"));
      assertSucceeded(commandResult, "command");
      const commandMessage = findPublishedMessage(publishedMessages, commandResult.jobId, (item) => item.text.includes("已创建 AI 会话"));
      if (!commandMessage) {
        throw new Error("command branch did not publish expected session creation reply");
      }

      const textResult = await runCase(runtime, "text", buildInvocation("@ai #1 请结合最近聊天上下文，给我一句联调总结。"));
      assertSucceeded(textResult, "text");
      const textMessage = findPublishedMessage(publishedMessages, textResult.jobId, (item) => item.text && item.bot?.jobId === textResult.jobId);
      if (!textMessage) {
        throw new Error("text branch did not publish final answer");
      }

      const visionResult = await runCase(runtime, "vision", buildInvocation("@ai 看图，这张图里写了什么？", createAttachmentPayload()));
      assertSucceeded(visionResult, "vision");
      const visionMessage = findPublishedMessage(publishedMessages, visionResult.jobId, (item) => item.text && item.bot?.jobId === visionResult.jobId);
      if (!visionMessage) {
        throw new Error("vision branch did not publish final answer");
      }

      const delegateResult = await runCase(runtime, "delegate", buildInvocation("@ai @music 状态"));
      assertSucceeded(delegateResult, "delegate");
      const delegateMessage = findPublishedMessage(publishedMessages, delegateResult.jobId, (item) => item.text.includes("已转交给 音乐助手"));
      if (!delegateMessage) {
        throw new Error("delegate branch did not publish the delegation reply");
      }
      const delegateArtifactJobId = JSON.parse(fs.readFileSync(path.join(APP_DATA_ROOT, "jobs", `${delegateResult.jobId}.json`), "utf8"))
        ?.result?.artifacts?.find?.((item) => item?.type === "delegated-job")?.jobId;
      if (!delegateArtifactJobId) {
        throw new Error("delegate branch did not record delegated job artifact");
      }
      const delegatedJob = await waitForJob(runtime, delegateArtifactJobId);
      if (delegatedJob.status !== "succeeded") {
        throw new Error(`delegated music job failed with status ${delegatedJob.status}`);
      }

      const searchResult = await runCase(runtime, "search-tool", buildInvocation(`@ai #1 /search ${SEARCH_QUERY}`));
      assertSucceeded(searchResult, "search-tool");
      const searchMessage = findPublishedMessage(publishedMessages, searchResult.jobId, (item) => item.text && item.bot?.jobId === searchResult.jobId);
      if (!searchMessage) {
        throw new Error("search-tool branch did not publish final answer");
      }

      const directUrlResult = await runCase(runtime, "direct-url-web", buildInvocation(`@ai #1 ${DIRECT_PAGE_PROMPT}`));
      assertSucceeded(directUrlResult, "direct-url-web");
      const directUrlMessage = findPublishedMessage(publishedMessages, directUrlResult.jobId, (item) => item.text && item.bot?.jobId === directUrlResult.jobId);
      if (!directUrlMessage) {
        throw new Error("direct-url-web branch did not publish final answer");
      }

      const textTracePath = path.join(CHECKPOINT_ROOT, "traces", `${textResult.jobId}.jsonl`);
      const textExecutionPath = path.join(CHECKPOINT_ROOT, "executions", `${textResult.jobId}.json`);
      const textSessionCheckpointPath = path.join(CHECKPOINT_ROOT, "sessions", "1.json");
      const searchTracePath = path.join(CHECKPOINT_ROOT, "traces", `${searchResult.jobId}.jsonl`);
      const searchExecutionPath = path.join(CHECKPOINT_ROOT, "executions", `${searchResult.jobId}.json`);
      const directUrlTracePath = path.join(CHECKPOINT_ROOT, "traces", `${directUrlResult.jobId}.jsonl`);
      const directUrlExecutionPath = path.join(CHECKPOINT_ROOT, "executions", `${directUrlResult.jobId}.json`);
      if (!fs.existsSync(textTracePath) || !fs.existsSync(textExecutionPath)) {
        throw new Error("text branch did not persist LangGraph checkpoint files");
      }
      if (!fs.existsSync(textSessionCheckpointPath)) {
        throw new Error("session-bound text branch did not update latest session checkpoint");
      }
      if (!fs.existsSync(searchTracePath) || !fs.existsSync(searchExecutionPath)) {
        throw new Error("search-tool branch did not persist LangGraph checkpoint files");
      }
      if (!fs.existsSync(directUrlTracePath) || !fs.existsSync(directUrlExecutionPath)) {
        throw new Error("direct-url-web branch did not persist LangGraph checkpoint files");
      }
      await waitForFile(textTracePath);
      await waitForFile(textExecutionPath);
      await waitForFile(textSessionCheckpointPath);
      await waitForFile(searchTracePath);
      await waitForFile(searchExecutionPath);
      await waitForFile(directUrlTracePath);
      await waitForFile(directUrlExecutionPath);
      const textTraceContent = fs.readFileSync(textTracePath, "utf8");
      const searchTraceContent = fs.readFileSync(searchTracePath, "utf8");
      const directUrlTraceContent = fs.readFileSync(directUrlTracePath, "utf8");
      const textExecution = JSON.parse(fs.readFileSync(textExecutionPath, "utf8"));
      const searchExecution = JSON.parse(fs.readFileSync(searchExecutionPath, "utf8"));
      const directUrlExecution = JSON.parse(fs.readFileSync(directUrlExecutionPath, "utf8"));
      const textSessionCheckpoint = JSON.parse(fs.readFileSync(textSessionCheckpointPath, "utf8"));

      const failureSessionResult = await runCase(runtime, "command-failure-session", buildInvocation("@ai /new 失败恢复会话"));
      assertSucceeded(failureSessionResult, "command-failure-session");
      const failToolResult = await runCase(runtime, "fail-tool", buildInvocation(`@ai #2 ${FAIL_TOOL_QUERY}`));
      if (failToolResult.status !== "failed") {
        throw new Error(`fail-tool branch expected failed status but got ${failToolResult.status}`);
      }
      const failExecutionPath = path.join(CHECKPOINT_ROOT, "executions", `${failToolResult.jobId}.json`);
      const failTracePath = path.join(CHECKPOINT_ROOT, "traces", `${failToolResult.jobId}.jsonl`);
      const failSessionCheckpointPath = path.join(CHECKPOINT_ROOT, "sessions", "2.json");
      await waitForFile(failExecutionPath);
      await waitForFile(failTracePath);
      await waitForFile(failSessionCheckpointPath);
      const failExecution = JSON.parse(fs.readFileSync(failExecutionPath, "utf8"));
      const failTraceContent = fs.readFileSync(failTracePath, "utf8");
      const failSessionCheckpoint = JSON.parse(fs.readFileSync(failSessionCheckpointPath, "utf8"));
      const failRecoveryResult = await runCase(runtime, "fail-recovery", buildInvocation("@ai #2 继续刚才失败的检索，但先别盲目重试工具。"));
      assertSucceeded(failRecoveryResult, "fail-recovery");

      const cancelSessionResult = await runCase(runtime, "command-cancel-session", buildInvocation("@ai /new 取消恢复会话"));
      assertSucceeded(cancelSessionResult, "command-cancel-session");
      const cancelResult = await runCancelledCase(runtime, "cancel-text", buildInvocation(`@ai #3 ${CANCEL_TEXT_QUERY} 请输出一段较长的联调说明。`));
      if (cancelResult.status !== "cancelled") {
        throw new Error(`cancel-text branch expected cancelled status but got ${cancelResult.status}`);
      }
      const cancelExecutionPath = path.join(CHECKPOINT_ROOT, "executions", `${cancelResult.jobId}.json`);
      const cancelTracePath = path.join(CHECKPOINT_ROOT, "traces", `${cancelResult.jobId}.jsonl`);
      const cancelSessionCheckpointPath = path.join(CHECKPOINT_ROOT, "sessions", "3.json");
      await waitForFile(cancelExecutionPath);
      await waitForFile(cancelTracePath);
      await waitForFile(cancelSessionCheckpointPath);
      const cancelExecution = JSON.parse(fs.readFileSync(cancelExecutionPath, "utf8"));
      const cancelTraceContent = fs.readFileSync(cancelTracePath, "utf8");
      const cancelSessionCheckpoint = JSON.parse(fs.readFileSync(cancelSessionCheckpointPath, "utf8"));
      const cancelRecoveryResult = await runCase(runtime, "cancel-recovery", buildInvocation("@ai #3 继续刚才被取消的回答，这次先给结论。"));
      assertSucceeded(cancelRecoveryResult, "cancel-recovery");

      const visionRecoverySessionResult = await runCase(runtime, "command-vision-session", buildInvocation("@ai /new 看图恢复会话"));
      assertSucceeded(visionRecoverySessionResult, "command-vision-session");
      const failedVisionBuildResult = await runCase(runtime, "fail-vision-build", buildInvocation("@ai #4 看图并描述附件内容。", createLargeAttachmentPayload()));
      if (failedVisionBuildResult.status !== "failed") {
        throw new Error(`fail-vision-build branch expected failed status but got ${failedVisionBuildResult.status}`);
      }
      const failedVisionExecutionPath = path.join(CHECKPOINT_ROOT, "executions", `${failedVisionBuildResult.jobId}.json`);
      const failedVisionTracePath = path.join(CHECKPOINT_ROOT, "traces", `${failedVisionBuildResult.jobId}.jsonl`);
      const failedVisionSessionCheckpointPath = path.join(CHECKPOINT_ROOT, "sessions", "4.json");
      await waitForFile(failedVisionExecutionPath);
      await waitForFile(failedVisionTracePath);
      await waitForFile(failedVisionSessionCheckpointPath);
      const failedVisionExecution = JSON.parse(fs.readFileSync(failedVisionExecutionPath, "utf8"));
      const failedVisionTraceContent = fs.readFileSync(failedVisionTracePath, "utf8");
      const failedVisionSessionCheckpoint = JSON.parse(fs.readFileSync(failedVisionSessionCheckpointPath, "utf8"));
      const visionRecoveryResult = await runCase(runtime, "vision-recovery", buildInvocation("@ai #4 继续刚才看图流程。"));
      assertSucceeded(visionRecoveryResult, "vision-recovery");
      const visionRecoveryMessage = findPublishedMessage(publishedMessages, visionRecoveryResult.jobId, (item) => item.text && item.bot?.jobId === visionRecoveryResult.jobId);
      if (!visionRecoveryMessage) {
        throw new Error("vision-recovery branch did not publish recovery advice");
      }

      const retrySessionResult = await runCase(runtime, "command-retry-session", buildInvocation("@ai /new 工具直重试会话"));
      assertSucceeded(retrySessionResult, "command-retry-session");
      writeSyntheticTextToolsRecoveryCheckpoint(5);
      const directRetryResult = await runCase(runtime, "direct-retry", buildInvocation("@ai #5 继续刚才读取上下文的恢复流程，并补一句最新结论。"));
      assertSucceeded(directRetryResult, "direct-retry");
      const directRetryMessage = findPublishedMessage(publishedMessages, directRetryResult.jobId, (item) => item.text && item.bot?.jobId === directRetryResult.jobId);
      if (!directRetryMessage) {
        throw new Error("direct-retry branch did not publish final answer");
      }

      const summary = {
        config,
        command: {
          jobId: commandResult.jobId,
          status: commandResult.status,
          routeVerified: /langgraph node enter: command/.test(commandResult.log),
          reply: commandMessage.text
        },
        text: {
          jobId: textResult.jobId,
          status: textResult.status,
          routeVerified: /langgraph node enter: prepareInput/.test(textResult.log) && /langgraph node enter: prepareContext/.test(textResult.log) && /langgraph node enter: textPlan/.test(textResult.log) && /langgraph node enter: textAnswer/.test(textResult.log),
          checkpointVerified: textExecution.status === "succeeded" && textExecution.sessionId === 1 && Boolean(textExecution.result?.reply?.textPreview),
          traceVerified: /"kind":"node"/.test(textTraceContent) && /"event":"enter"/.test(textTraceContent) && /"event":"exit"/.test(textTraceContent),
          sessionCheckpointVerified: Boolean(textSessionCheckpoint.latestExecution?.jobId) && fs.existsSync(String(textSessionCheckpoint.latestExecution?.snapshotPath || "")),
          reply: textMessage.text
        },
        vision: {
          jobId: visionResult.jobId,
          status: visionResult.status,
          routeVerified: /langgraph node enter: prepareInput/.test(visionResult.log) && /langgraph node enter: prepareContext/.test(visionResult.log) && /langgraph node enter: visionCollect/.test(visionResult.log) && /langgraph node enter: visionBuild/.test(visionResult.log) && /langgraph node enter: visionAnswer/.test(visionResult.log),
          reply: visionMessage.text
        },
        delegate: {
          jobId: delegateResult.jobId,
          status: delegateResult.status,
          routeVerified: /langgraph node enter: prepareInput/.test(delegateResult.log) && /langgraph node enter: delegateResolve/.test(delegateResult.log) && /langgraph node enter: delegateExecute/.test(delegateResult.log),
          reply: delegateMessage.text,
          delegatedJobId: delegatedJob.jobId,
          delegatedStatus: delegatedJob.status
        },
        searchTool: {
          jobId: searchResult.jobId,
          status: searchResult.status,
          routeVerified: /langgraph node enter: prepareInput/.test(searchResult.log) && /langgraph node enter: prepareContext/.test(searchResult.log) && /langgraph node enter: textPlan/.test(searchResult.log) && /langgraph node enter: textTools/.test(searchResult.log) && /langgraph node enter: textAnswer/.test(searchResult.log),
          checkpointVerified: searchExecution.status === "succeeded" && Array.isArray(searchExecution.result?.artifacts) && searchExecution.result?.artifactSummary?.types?.includes("answer"),
          traceVerified: /"kind":"tool"/.test(searchTraceContent) && /"tool":"search_web"/.test(searchTraceContent) && /ai session checkpoint restored:/.test(searchResult.log),
          sessionRecoveryVerified: textSessionCheckpoint.latestExecution?.jobId === searchResult.jobId,
          toolCallVerified: /tool-call search_web:/.test(searchResult.log),
          webPlanVerified: /web search plan:/.test(searchResult.log),
          webFollowUpVerified: /web search follow-up:/.test(searchResult.log),
          multiRoundVerified: /tool-call search_web:/.test(searchResult.log) && /langgraph node exit: textTools/.test(searchResult.log) && /langgraph node exit: textAnswer/.test(searchResult.log),
          reply: searchMessage.text
        },
        directUrlWeb: {
          jobId: directUrlResult.jobId,
          status: directUrlResult.status,
          checkpointVerified: directUrlExecution.status === "succeeded" && Array.isArray(directUrlExecution.result?.artifacts),
          directFetchVerified: /web direct fetch:/.test(directUrlResult.log),
          traceVerified: /"kind":"tool"/.test(directUrlTraceContent) && /"tool":"search_web"/.test(directUrlTraceContent),
          finalAnswerVerified: /SEARCH_TOOL_OK:/.test(directUrlMessage.text),
          reply: directUrlMessage.text
        },
        failedCase: {
          jobId: failToolResult.jobId,
          status: failToolResult.status,
          partialTraceVerified: failExecution.status === "failed" && failExecution.route === "text" && failExecution.traceSummary?.lastNode === "textTools" && failExecution.traceSummary?.count > 0,
          traceVerified: /"kind":"tool"/.test(failTraceContent) && /"status":"failed"/.test(failTraceContent),
          sessionCheckpointVerified: failSessionCheckpoint.latestExecution?.jobId === failToolResult.jobId,
          recoveryStrategyVerified: /ai session recovery strategy: .*textTools/i.test(failRecoveryResult.log),
          recoveryRestoreVerified: /ai session checkpoint restored:/.test(failRecoveryResult.log),
          directRetryBlockedVerified: /ai session recovery scheduling: mode=text-replan route=text/.test(failRecoveryResult.log)
        },
        cancelledCase: {
          jobId: cancelResult.jobId,
          status: cancelResult.status,
          partialTraceVerified: cancelExecution.status === "cancelled" && cancelExecution.traceSummary?.count > 0 && ["textPlan", "textAnswer"].includes(String(cancelExecution.traceSummary?.lastNode || "")),
          traceVerified: /"kind":"node"/.test(cancelTraceContent) && /"status":"cancelled"/.test(cancelTraceContent),
          sessionCheckpointVerified: cancelSessionCheckpoint.latestExecution?.jobId === cancelResult.jobId,
          recoveryStrategyVerified: /ai session recovery strategy: .*被用户取消|取消/i.test(cancelRecoveryResult.log),
          recoveryRestoreVerified: /ai session checkpoint restored:/.test(cancelRecoveryResult.log)
        },
        failedVisionBuildCase: {
          jobId: failedVisionBuildResult.jobId,
          status: failedVisionBuildResult.status,
          partialTraceVerified: failedVisionExecution.status === "failed" && failedVisionExecution.route === "vision" && failedVisionExecution.traceSummary?.lastNode === "visionBuild",
          traceVerified: /"kind":"node"/.test(failedVisionTraceContent) && /"node":"visionBuild"/.test(failedVisionTraceContent),
          sessionCheckpointVerified: failedVisionSessionCheckpoint.latestExecution?.jobId === failedVisionBuildResult.jobId,
          recoveryStrategyVerified: /ai session recovery strategy: .*重新上传图片|visionBuild/i.test(visionRecoveryResult.log),
          recoveryRouteVerified: /langgraph node enter: recovery/.test(visionRecoveryResult.log),
          recoveryReplyVerified: /重新上传图片/.test(visionRecoveryMessage.text),
          recoveryCardVerified: visionRecoveryMessage.card?.type === "ai-recovery",
          recoveryArtifactVerified: JSON.parse(fs.readFileSync(path.join(APP_DATA_ROOT, "jobs", `${visionRecoveryResult.jobId}.json`), "utf8"))?.result?.artifacts?.some?.((item) => item?.type === "recovery-route") === true
        },
        directRetryCase: {
          jobId: directRetryResult.jobId,
          status: directRetryResult.status,
          recoverySchedulingVerified: /ai session recovery scheduling: mode=text-retry-tools route=textTools/.test(directRetryResult.log),
          routeVerified: /langgraph node enter: prepareContext/.test(directRetryResult.log) && /langgraph node enter: textTools/.test(directRetryResult.log) && /langgraph node enter: textPlan/.test(directRetryResult.log),
          toolRetryVerified: /tool-call read_chat_history:/.test(directRetryResult.log),
          reply: directRetryMessage.text
        },
        publishedMessageCount: publishedMessages.length,
        appendedMessageCount: appendedMessages.length,
        tempRoot: TEMP_ROOT,
        rerun: {
          mock: "node scripts/ai-chat-integration.mjs",
          realProvider: "node scripts/ai-chat-integration.mjs --provider=real",
          realProviderAndWeb: "node scripts/ai-chat-integration.mjs --provider=real --web=real"
        }
      };

      console.log(JSON.stringify(summary, null, 2));
    } finally {
      await runtime.dispose().catch(() => {});
    }
  } finally {
    restoreFetch?.();
    if (mockAi) {
      await new Promise((resolve) => mockAi.server.close(resolve));
    }
    restoreEnv(envBackup);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});