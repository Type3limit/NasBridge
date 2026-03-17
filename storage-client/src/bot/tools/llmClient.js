function trimTrailingSlash(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

function readEnv(names = []) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function getConfiguredProvider() {
  const explicit = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
  if (explicit) {
    return explicit;
  }
  if (readEnv(["COPILOT_API_BASE_URL", "COPILOT_BASE_URL", "COPILOT_MODEL", "COPILOT_MULTIMODAL_MODEL"])) {
    return "copilot";
  }
  if (readEnv(["ARK_BASE_URL", "ARK_MODEL", "ARK_MULTIMODAL_MODEL", "ARK_ENDPOINT_ID"])) {
    return "ark";
  }
  if (readEnv(["OPENAI_BASE_URL", "OPENAI_MODEL", "OPENAI_MULTIMODAL_MODEL"])) {
    return "openai";
  }
  return "";
}

function getBaseUrl() {
  return trimTrailingSlash(readEnv([
    "COPILOT_API_BASE_URL",
    "COPILOT_BASE_URL",
    "ARK_BASE_URL",
    "OPENAI_BASE_URL"
  ]));
}

function getApiKey() {
  const configured = readEnv([
    "COPILOT_API_KEY",
    "COPILOT_AUTH_TOKEN",
    "ARK_API_KEY",
    "OPENAI_API_KEY"
  ]);
  if (configured) {
    return configured;
  }
  if (getConfiguredProvider() === "copilot") {
    return String(process.env.COPILOT_DUMMY_API_KEY || "dummy").trim() || "dummy";
  }
  return "";
}

function getModel(mode = "text") {
  if (mode === "multimodal") {
    return readEnv([
      "COPILOT_MULTIMODAL_MODEL",
      "ARK_MULTIMODAL_MODEL",
      "OPENAI_MULTIMODAL_MODEL",
      "COPILOT_MODEL",
      "ARK_MODEL",
      "ARK_ENDPOINT_ID",
      "OPENAI_MODEL"
    ]);
  }
  return readEnv([
    "COPILOT_MODEL",
    "ARK_MODEL",
    "ARK_ENDPOINT_ID",
    "OPENAI_MODEL"
  ]);
}

export function getDefaultTextModelName() {
  return getModel("text");
}

export function getDefaultMultimodalModelName() {
  return getModel("multimodal");
}

function getEndpointUrl() {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw new Error("COPILOT_API_BASE_URL, ARK_BASE_URL, or OPENAI_BASE_URL is required for AI bot");
  }
  if (/\/chat\/completions$/i.test(baseUrl)) {
    return baseUrl;
  }
  return `${baseUrl}/chat/completions`;
}

function getModelsEndpointUrl() {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw new Error("COPILOT_API_BASE_URL, ARK_BASE_URL, or OPENAI_BASE_URL is required for AI bot");
  }
  if (/\/chat\/completions$/i.test(baseUrl)) {
    return baseUrl.replace(/\/chat\/completions$/i, "/models");
  }
  if (/\/v1$/i.test(baseUrl)) {
    return `${baseUrl}/models`;
  }
  return `${baseUrl}/models`;
}

function getAuthHeaders() {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("COPILOT_API_KEY, COPILOT_AUTH_TOKEN, ARK_API_KEY, or OPENAI_API_KEY is required for AI bot");
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };
}

function hasTruthySupportFlag(source, keys = []) {
  return keys.some((key) => source?.[key] === true);
}

function detectVisionSupport(item = {}) {
  const supports = item?.capabilities?.supports || {};
  if (hasTruthySupportFlag(supports, ["vision", "image_input", "input_image", "image", "multimodal"])) {
    return true;
  }

  const modalities = [
    ...(Array.isArray(item?.modalities) ? item.modalities : []),
    ...(Array.isArray(item?.input_modalities) ? item.input_modalities : []),
    ...(Array.isArray(item?.output_modalities) ? item.output_modalities : [])
  ].map((value) => String(value || "").toLowerCase());
  if (modalities.some((value) => value.includes("image") || value.includes("vision"))) {
    return true;
  }

  const modelId = String(item?.id || item?.name || "").toLowerCase();
  if (!modelId || /embed|rerank|tts|whisper|audio/i.test(modelId)) {
    return false;
  }
  return /(vision|vl|gpt-4o|gpt-4\.1|claude-3|claude-3\.5|claude-3\.7|claude-sonnet-4|gemini|qwen-vl|glm-4v|llava|pixtral)/i.test(modelId);
}

export async function listAvailableModels(options = {}) {
  const response = await fetch(getModelsEndpointUrl(), {
    method: "GET",
    headers: getAuthHeaders(),
    signal: options.signal
  });
  const rawText = await response.text();
  let payload = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
  }
  if (!response.ok) {
    const detail = String(payload?.error?.message || rawText || `${response.status} ${response.statusText}`).trim();
    throw new Error(`AI models request failed: ${detail}`);
  }
  const models = Array.isArray(payload?.data)
    ? payload.data.map((item) => ({
        id: String(item?.id || "").trim(),
        name: String(item?.name || item?.id || "").trim(),
        vendor: String(item?.vendor || "").trim(),
        preview: item?.preview === true,
        toolCalls: item?.capabilities?.supports?.tool_calls === true,
        vision: detectVisionSupport(item)
      })).filter((item) => item.id)
    : [];
  return {
    models,
    raw: payload
  };
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item?.type === "text") {
          return String(item.text || "");
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

function extractDeltaText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item?.type === "text") {
        if (typeof item.text === "string") {
          return item.text;
        }
        return String(item?.text?.value || "");
      }
      return "";
    }).join("");
  }
  return "";
}

function normalizeToolDefinitions(tools = []) {
  return tools
    .map((tool) => {
      const name = String(tool?.name || "").trim();
      if (!name) {
        return null;
      }
      return {
        type: "function",
        function: {
          name,
          description: String(tool?.description || "").trim(),
          parameters: tool?.inputSchema && typeof tool.inputSchema === "object"
            ? tool.inputSchema
            : { type: "object", properties: {} }
        }
      };
    })
    .filter(Boolean);
}

function extractToolCalls(message = {}) {
  return Array.isArray(message?.tool_calls)
    ? message.tool_calls.map((call) => {
      const rawArguments = String(call?.function?.arguments || "{}");
      let input = {};
      try {
        input = rawArguments ? JSON.parse(rawArguments) : {};
      } catch {
        input = { _raw: rawArguments };
      }
      return {
        id: String(call?.id || ""),
        type: String(call?.type || "function"),
        name: String(call?.function?.name || ""),
        input
      };
    }).filter((call) => call.name)
    : [];
}

async function invokeChatCompletion(body = {}) {
  const response = await fetch(getEndpointUrl(), {
    method: "POST",
    headers: getAuthHeaders(),
    signal: body.signal,
    body: JSON.stringify(body)
  });
  const rawText = await response.text();
  let payload = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
  }
  if (!response.ok) {
    const detail = String(payload?.error?.message || rawText || `${response.status} ${response.statusText}`).trim();
    throw new Error(`AI model request failed: ${detail}`);
  }
  const choice = payload?.choices?.[0]?.message;
  return {
    text: extractTextContent(choice?.content),
    model: String(payload?.model || body.model || ""),
    usage: payload?.usage || null,
    finishReason: String(payload?.choices?.[0]?.finish_reason || ""),
    toolCalls: extractToolCalls(choice),
    message: choice || null,
    raw: payload
  };
}

async function invokeChatCompletionStream(body = {}, handlers = {}) {
  const response = await fetch(getEndpointUrl(), {
    method: "POST",
    headers: getAuthHeaders(),
    signal: body.signal,
    body: JSON.stringify({
      ...body,
      stream: true,
      stream_options: { include_usage: true }
    })
  });
  if (!response.ok || !response.body) {
    const rawText = await response.text().catch(() => "");
    throw new Error(`AI model stream failed: ${rawText || `${response.status} ${response.statusText}`}`.trim());
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let text = "";
  let model = String(body.model || "");
  let usage = null;
  let finishReason = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";

    for (const eventText of events) {
      const dataLines = eventText
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      if (!dataLines.length) {
        continue;
      }
      const data = dataLines.join("\n");
      if (data === "[DONE]") {
        handlers.onDone?.({ text, model, usage, finishReason });
        return { text, model, usage, finishReason };
      }
      let payload = null;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      model = String(payload?.model || model || "");
      usage = payload?.usage || usage;
      const choice = payload?.choices?.[0];
      if (!choice) {
        continue;
      }
      if (choice.finish_reason) {
        finishReason = String(choice.finish_reason || "");
      }
      const deltaText = extractDeltaText(choice?.delta?.content);
      if (deltaText) {
        text += deltaText;
        handlers.onText?.({ text, delta: deltaText, model, usage, finishReason, raw: payload });
      }
    }

    if (done) {
      handlers.onDone?.({ text, model, usage, finishReason });
      return { text, model, usage, finishReason };
    }
  }
}

export async function invokeTextModel(options = {}) {
  const model = String(options.model || getModel("text") || "").trim();
  if (!model) {
    throw new Error("COPILOT_MODEL, ARK_MODEL, ARK_ENDPOINT_ID, or OPENAI_MODEL is required for text AI bot");
  }
  const messages = Array.isArray(options.messages)
    ? options.messages.filter((message) => message?.role && (message?.content !== undefined || Array.isArray(message?.tool_calls)))
    : (() => {
        const next = [];
        if (options.systemPrompt) {
          next.push({ role: "system", content: String(options.systemPrompt) });
        }
        for (const message of Array.isArray(options.historyMessages) ? options.historyMessages : []) {
          if (!message?.role || !message?.content) {
            continue;
          }
          next.push({ role: message.role, content: message.content });
        }
        next.push({ role: "user", content: String(options.userPrompt || "") });
        return next;
      })();
  const tools = normalizeToolDefinitions(Array.isArray(options.tools) ? options.tools : []);
  return invokeChatCompletion({
    model,
    messages,
    signal: options.signal,
    temperature: Number.isFinite(options.temperature) ? Number(options.temperature) : 0.3,
    max_tokens: Number.isFinite(options.maxTokens) ? Math.max(128, Math.floor(options.maxTokens)) : 900,
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? (options.toolChoice || "auto") : undefined
  });
}

export async function invokeTextModelStream(options = {}, handlers = {}) {
  const model = String(options.model || getModel("text") || "").trim();
  if (!model) {
    throw new Error("COPILOT_MODEL, ARK_MODEL, ARK_ENDPOINT_ID, or OPENAI_MODEL is required for text AI bot");
  }
  const messages = Array.isArray(options.messages)
    ? options.messages.filter((message) => message?.role && (message?.content !== undefined || Array.isArray(message?.tool_calls)))
    : (() => {
        const next = [];
        if (options.systemPrompt) {
          next.push({ role: "system", content: String(options.systemPrompt) });
        }
        for (const message of Array.isArray(options.historyMessages) ? options.historyMessages : []) {
          if (!message?.role || !message?.content) {
            continue;
          }
          next.push({ role: message.role, content: message.content });
        }
        next.push({ role: "user", content: String(options.userPrompt || "") });
        return next;
      })();
  return invokeChatCompletionStream({
    model,
    messages,
    signal: options.signal,
    temperature: Number.isFinite(options.temperature) ? Number(options.temperature) : 0.3,
    max_tokens: Number.isFinite(options.maxTokens) ? Math.max(128, Math.floor(options.maxTokens)) : 900
  }, handlers);
}

export async function invokeMultimodalModel(options = {}) {
  const model = String(options.model || getModel("multimodal") || "").trim();
  if (!model) {
    throw new Error("COPILOT_MULTIMODAL_MODEL, COPILOT_MODEL, ARK_MULTIMODAL_MODEL, ARK_MODEL, ARK_ENDPOINT_ID, or OPENAI_MULTIMODAL_MODEL is required for multimodal AI bot");
  }
  const messages = [];
  if (options.systemPrompt) {
    messages.push({ role: "system", content: String(options.systemPrompt) });
  }
  for (const message of Array.isArray(options.historyMessages) ? options.historyMessages : []) {
    if (!message?.role || !message?.content) {
      continue;
    }
    messages.push({ role: message.role, content: message.content });
  }
  const content = [{ type: "text", text: String(options.userPrompt || "") }];
  for (const image of Array.isArray(options.imageInputs) ? options.imageInputs : []) {
    const dataUrl = String(image?.dataUrl || "").trim();
    if (!dataUrl) {
      continue;
    }
    content.push({
      type: "image_url",
      image_url: {
        url: dataUrl,
        detail: String(image?.detail || "auto")
      }
    });
  }
  messages.push({ role: "user", content });
  return invokeChatCompletion({
    model,
    messages,
    signal: options.signal,
    temperature: Number.isFinite(options.temperature) ? Number(options.temperature) : 0.2,
    max_tokens: Number.isFinite(options.maxTokens) ? Math.max(128, Math.floor(options.maxTokens)) : 1000
  });
}

export async function invokeMultimodalModelStream(options = {}, handlers = {}) {
  const model = String(options.model || getModel("multimodal") || "").trim();
  if (!model) {
    throw new Error("COPILOT_MULTIMODAL_MODEL, COPILOT_MODEL, ARK_MULTIMODAL_MODEL, ARK_MODEL, ARK_ENDPOINT_ID, or OPENAI_MULTIMODAL_MODEL is required for multimodal AI bot");
  }
  const messages = [];
  if (options.systemPrompt) {
    messages.push({ role: "system", content: String(options.systemPrompt) });
  }
  for (const message of Array.isArray(options.historyMessages) ? options.historyMessages : []) {
    if (!message?.role || !message?.content) {
      continue;
    }
    messages.push({ role: message.role, content: message.content });
  }
  const content = [{ type: "text", text: String(options.userPrompt || "") }];
  for (const image of Array.isArray(options.imageInputs) ? options.imageInputs : []) {
    const dataUrl = String(image?.dataUrl || "").trim();
    if (!dataUrl) {
      continue;
    }
    content.push({
      type: "image_url",
      image_url: {
        url: dataUrl,
        detail: String(image?.detail || "auto")
      }
    });
  }
  messages.push({ role: "user", content });
  return invokeChatCompletionStream({
    model,
    messages,
    signal: options.signal,
    temperature: Number.isFinite(options.temperature) ? Number(options.temperature) : 0.2,
    max_tokens: Number.isFinite(options.maxTokens) ? Math.max(128, Math.floor(options.maxTokens)) : 1000
  }, handlers);
}
