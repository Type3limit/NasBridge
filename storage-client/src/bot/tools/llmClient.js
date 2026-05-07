function trimTrailingSlash(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

const MODEL_CONTEXT_LIMITS = [
  [/gpt-4o/i, 128000],
  [/gpt-4-turbo/i, 128000],
  [/gpt-4-32k/i, 32768],
  [/gpt-4/i, 8192],
  [/gpt-3\.5-turbo-16k/i, 16385],
  [/gpt-3\.5/i, 16385],
  [/claude-3[-. ]5/i, 200000],
  [/claude-3/i, 200000],
  [/claude-2/i, 100000],
  [/claude/i, 100000],
  [/gemini-1\.5/i, 1048576],
  [/gemini/i, 32768],
  [/deepseek-r1/i, 65536],
  [/deepseek-v3/i, 65536],
  [/deepseek/i, 65536],
  [/qwen.*long/i, 1000000],
  [/qwen.*72b/i, 131072],
  [/qwen/i, 32768],
  [/glm-4/i, 128000],
  [/glm/i, 128000],
  [/llama-3.*70b/i, 128000],
  [/llama-3/i, 8192],
  [/llama/i, 4096],
  [/mistral/i, 32768],
  [/yi-/i, 200000],
];

function readEnv(names = []) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

const XUNFEI_PROVIDER_IDS = new Set(["xunfei", "xfyun", "xf-maas", "xunfei-maas", "maas"]);
const XUNFEI_DEFAULT_BASE_URL = "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2";
const XUNFEI_DEFAULT_TEXT_MODEL = "astron-code-latest";
const MODEL_PROVIDER_SEPARATOR = "::";
const KNOWN_PROVIDERS = ["copilot", "xunfei", "ark", "openai"];
const PROVIDER_DISPLAY_NAMES = {
  copilot: "GitHub Copilot",
  xunfei: "讯飞Maas",
  ark: "Ark",
  openai: "OpenAI Compatible"
};

function normalizeProviderName(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (XUNFEI_PROVIDER_IDS.has(normalized)) {
    return "xunfei";
  }
  return normalized;
}

function getProviderDisplayName(provider = "") {
  return PROVIDER_DISPLAY_NAMES[provider] || String(provider || "").trim() || "未标记 provider";
}

function getExplicitProviders() {
  return [...new Set(
    String(process.env.AI_PROVIDER || "")
      .split(/[\s,]+/)
      .map((value) => normalizeProviderName(value))
      .filter(Boolean)
  )];
}

function hasProviderConfig(provider = "") {
  if (provider === "copilot") {
    return Boolean(readEnv(["COPILOT_API_BASE_URL", "COPILOT_BASE_URL", "COPILOT_MODEL", "COPILOT_MULTIMODAL_MODEL", "COPILOT_API_KEY", "COPILOT_AUTH_TOKEN"]));
  }
  if (provider === "xunfei") {
    return Boolean(readEnv(["XUNFEI_BASE_URL", "XFYUN_BASE_URL", "XUNFEI_MODEL", "XFYUN_MODEL", "XUNFEI_MULTIMODAL_MODEL", "XFYUN_MULTIMODAL_MODEL", "XUNFEI_API_KEY", "XFYUN_API_KEY"]));
  }
  if (provider === "ark") {
    return Boolean(readEnv(["ARK_BASE_URL", "ARK_MODEL", "ARK_MULTIMODAL_MODEL", "ARK_ENDPOINT_ID", "ARK_API_KEY"]));
  }
  if (provider === "openai") {
    return Boolean(readEnv(["OPENAI_BASE_URL", "OPENAI_MODEL", "OPENAI_MULTIMODAL_MODEL", "OPENAI_API_KEY"]));
  }
  return false;
}

function getDetectedProviders() {
  return KNOWN_PROVIDERS.filter((provider) => hasProviderConfig(provider));
}

function getEnabledProviders() {
  const explicitProviders = getExplicitProviders();
  const detectedProviders = getDetectedProviders();
  if (!explicitProviders.length) {
    return detectedProviders;
  }

  const ordered = [];
  const push = (provider) => {
    if (!provider || ordered.includes(provider) || !KNOWN_PROVIDERS.includes(provider)) {
      return;
    }
    if (hasProviderConfig(provider)) {
      ordered.push(provider);
    }
  };

  explicitProviders.filter((provider) => provider !== "all").forEach(push);
  if (explicitProviders.includes("all")) {
    detectedProviders.forEach(push);
  }
  return ordered.length ? ordered : detectedProviders;
}

function encodeModelRef(provider = "", modelId = "") {
  const normalizedProvider = normalizeProviderName(provider);
  const normalizedModelId = String(modelId || "").trim();
  if (!normalizedProvider || !normalizedModelId) {
    return normalizedModelId;
  }
  return `${normalizedProvider}${MODEL_PROVIDER_SEPARATOR}${normalizedModelId}`;
}

function parseModelRef(value = "") {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return { provider: "", modelId: "", qualified: false };
  }
  for (const provider of KNOWN_PROVIDERS) {
    const prefix = `${provider}${MODEL_PROVIDER_SEPARATOR}`;
    if (trimmed.startsWith(prefix)) {
      return {
        provider,
        modelId: trimmed.slice(prefix.length).trim(),
        qualified: true
      };
    }
  }
  return { provider: "", modelId: trimmed, qualified: false };
}

function resolveProviderAndModel(value = "", mode = "text") {
  const parsed = parseModelRef(value);
  const provider = parsed.provider || getConfiguredProvider();
  const modelId = parsed.modelId || getModel(mode, provider) || "";
  return {
    provider,
    modelId,
    qualified: Boolean(parsed.provider)
  };
}

function buildXunfeiFallbackModels() {
  const seen = new Set();
  const models = [];
  const push = (id, extra = {}) => {
    const modelId = String(id || "").trim();
    if (!modelId || seen.has(modelId)) {
      return;
    }
    seen.add(modelId);
    models.push({
      id: modelId,
      name: "讯飞Maas",
      vendor: "讯飞Maas",
      preview: false,
      toolCalls: true,
      vision: false,
      ...extra
    });
  };

  push(readEnv(["XUNFEI_MODEL", "XFYUN_MODEL"]) || XUNFEI_DEFAULT_TEXT_MODEL);
  push(readEnv(["XUNFEI_MULTIMODAL_MODEL", "XFYUN_MULTIMODAL_MODEL"]), { vision: true });
  return models;
}

function buildOpenAiFallbackModels() {
  const seen = new Set();
  const models = [];
  const push = (id, extra = {}) => {
    const modelId = String(id || "").trim();
    if (!modelId || seen.has(modelId)) {
      return;
    }
    seen.add(modelId);
    models.push({
      id: modelId,
      name: modelId,
      vendor: getProviderDisplayName("openai"),
      preview: false,
      toolCalls: false,
      vision: false,
      ...extra
    });
  };

  push(readEnv(["OPENAI_MODEL"]));
  push(readEnv(["OPENAI_MULTIMODAL_MODEL"]), { vision: true });
  return models;
}

function getConfiguredProvider() {
  return getEnabledProviders()[0] || "";
}

function getBaseUrl(provider = "") {
  const selectedProvider = normalizeProviderName(provider) || getConfiguredProvider();
  const configured = trimTrailingSlash(
    selectedProvider === "copilot"
      ? readEnv(["COPILOT_API_BASE_URL", "COPILOT_BASE_URL"])
      : selectedProvider === "xunfei"
        ? readEnv(["XUNFEI_BASE_URL", "XFYUN_BASE_URL"])
        : selectedProvider === "ark"
          ? readEnv(["ARK_BASE_URL"])
          : selectedProvider === "openai"
            ? readEnv(["OPENAI_BASE_URL"])
            : ""
  );
  if (configured) {
    return configured;
  }
  if (selectedProvider === "xunfei") {
    return XUNFEI_DEFAULT_BASE_URL;
  }
  return "";
}

function getApiKey(provider = "") {
  const selectedProvider = normalizeProviderName(provider) || getConfiguredProvider();
  const configured =
    selectedProvider === "copilot"
      ? readEnv(["COPILOT_API_KEY", "COPILOT_AUTH_TOKEN"])
      : selectedProvider === "xunfei"
        ? readEnv(["XUNFEI_API_KEY", "XFYUN_API_KEY"])
        : selectedProvider === "ark"
          ? readEnv(["ARK_API_KEY"])
          : selectedProvider === "openai"
            ? readEnv(["OPENAI_API_KEY"])
            : "";
  if (configured) {
    return configured;
  }
  if (selectedProvider === "copilot") {
    return String(process.env.COPILOT_DUMMY_API_KEY || "dummy").trim() || "dummy";
  }
  return "";
}

function getModel(mode = "text", provider = "") {
  const selectedProvider = normalizeProviderName(provider) || getConfiguredProvider();
  if (mode === "multimodal") {
    const configured =
      selectedProvider === "copilot"
        ? readEnv(["COPILOT_MULTIMODAL_MODEL", "COPILOT_MODEL"])
        : selectedProvider === "xunfei"
          ? readEnv(["XUNFEI_MULTIMODAL_MODEL", "XFYUN_MULTIMODAL_MODEL", "XUNFEI_MODEL", "XFYUN_MODEL"])
          : selectedProvider === "ark"
            ? readEnv(["ARK_MULTIMODAL_MODEL", "ARK_MODEL", "ARK_ENDPOINT_ID"])
            : selectedProvider === "openai"
              ? readEnv(["OPENAI_MULTIMODAL_MODEL", "OPENAI_MODEL"])
              : "";
    if (configured) {
      return configured;
    }
    if (selectedProvider === "xunfei") {
      return XUNFEI_DEFAULT_TEXT_MODEL;
    }
    return "";
  }
  const configured =
    selectedProvider === "copilot"
      ? readEnv(["COPILOT_MODEL"])
      : selectedProvider === "xunfei"
        ? readEnv(["XUNFEI_MODEL", "XFYUN_MODEL"])
        : selectedProvider === "ark"
          ? readEnv(["ARK_MODEL", "ARK_ENDPOINT_ID"])
          : selectedProvider === "openai"
            ? readEnv(["OPENAI_MODEL"])
            : "";
  if (configured) {
    return configured;
  }
  if (selectedProvider === "xunfei") {
    return XUNFEI_DEFAULT_TEXT_MODEL;
  }
  return "";
}

export function getDefaultTextModelName() {
  const provider = getConfiguredProvider();
  const modelId = getModel("text", provider);
  return modelId ? encodeModelRef(provider, modelId) : "";
}

export function getModelContextLimit(modelRef = "") {
  const modelId = String(parseModelRef(String(modelRef || "")).modelId || modelRef || "").toLowerCase();
  for (const [pattern, limit] of MODEL_CONTEXT_LIMITS) {
    if (pattern.test(modelId)) {
      return limit;
    }
  }
  return null;
}

export function getDefaultMultimodalModelName() {
  const provider = getConfiguredProvider();
  const modelId = getModel("multimodal", provider);
  return modelId ? encodeModelRef(provider, modelId) : "";
}

function getEndpointUrl(provider = "") {
  const baseUrl = getBaseUrl(provider);
  if (!baseUrl) {
    throw new Error("COPILOT_API_BASE_URL, XUNFEI_BASE_URL, XFYUN_BASE_URL, ARK_BASE_URL, or OPENAI_BASE_URL is required for AI bot");
  }
  if (/\/chat\/completions$/i.test(baseUrl)) {
    return baseUrl;
  }
  return `${baseUrl}/chat/completions`;
}

function getModelsEndpointUrl(provider = "") {
  const baseUrl = getBaseUrl(provider);
  if (!baseUrl) {
    throw new Error("COPILOT_API_BASE_URL, XUNFEI_BASE_URL, XFYUN_BASE_URL, ARK_BASE_URL, or OPENAI_BASE_URL is required for AI bot");
  }
  if (/\/chat\/completions$/i.test(baseUrl)) {
    return baseUrl.replace(/\/chat\/completions$/i, "/models");
  }
  if (/\/v1$/i.test(baseUrl)) {
    return `${baseUrl}/models`;
  }
  return `${baseUrl}/models`;
}

function getAuthHeaders(provider = "") {
  const selectedProvider = normalizeProviderName(provider) || getConfiguredProvider();
  const apiKey = getApiKey(selectedProvider);
  if (!apiKey) {
    throw new Error("COPILOT_API_KEY, COPILOT_AUTH_TOKEN, XUNFEI_API_KEY, XFYUN_API_KEY, ARK_API_KEY, or OPENAI_API_KEY is required for AI bot");
  }
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };
  if (selectedProvider === "xunfei") {
    headers["X-Api-Key"] = apiKey;
  }
  return headers;
}

function decorateModels(provider = "", models = []) {
  return models
    .map((item) => {
      const modelId = String(item?.modelId || item?.id || "").trim();
      if (!modelId) {
        return null;
      }
      return {
        id: encodeModelRef(provider, modelId),
        modelId,
        provider,
        name: String(item?.name || modelId).trim(),
        vendor: String(item?.vendor || getProviderDisplayName(provider)).trim(),
        preview: item?.preview === true,
        toolCalls: item?.toolCalls === true,
        vision: item?.vision === true
      };
    })
    .filter(Boolean);
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

async function listAvailableModelsForProvider(provider = "", options = {}) {
  const openAiFallbackModels = provider === "openai"
    ? decorateModels(provider, buildOpenAiFallbackModels())
    : [];
  let response;
  try {
    response = await fetch(getModelsEndpointUrl(provider), {
      method: "GET",
      headers: getAuthHeaders(provider),
      signal: options.signal
    });
  } catch (error) {
    if (provider === "openai" && openAiFallbackModels.length) {
      return {
        models: openAiFallbackModels,
        raw: null,
        fallback: true
      };
    }
    throw error;
  }
  const rawText = await response.text();
  let payload = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
  }
  if (!response.ok) {
    if (provider === "xunfei" && [404, 405, 501].includes(Number(response.status))) {
      return {
        models: decorateModels(provider, buildXunfeiFallbackModels()),
        raw: payload,
        fallback: true
      };
    }
    const detail = String(payload?.error?.message || rawText || `${response.status} ${response.statusText}`).trim();
    if (provider === "openai" && openAiFallbackModels.length) {
      return {
        models: openAiFallbackModels,
        raw: payload,
        fallback: true
      };
    }
    throw new Error(`AI models request failed: ${detail}`);
  }
  const models = decorateModels(provider, Array.isArray(payload?.data)
    ? payload.data.map((item) => ({
        id: String(item?.id || "").trim(),
        modelId: String(item?.id || "").trim(),
        name: String(item?.name || (provider === "xunfei" ? "讯飞Maas" : item?.id || "")).trim(),
        vendor: String(item?.vendor || getProviderDisplayName(provider)).trim(),
        preview: item?.preview === true,
        toolCalls: item?.capabilities?.supports?.tool_calls === true,
        vision: detectVisionSupport(item)
      }))
    : []);
  if (!models.length && provider === "xunfei") {
    return {
      models: decorateModels(provider, buildXunfeiFallbackModels()),
      raw: payload,
      fallback: true
    };
  }
  if (!models.length && provider === "openai" && openAiFallbackModels.length) {
    return {
      models: openAiFallbackModels,
      raw: payload,
      fallback: true
    };
  }
  return {
    models,
    raw: payload
  };
}

export async function listAvailableModels(options = {}) {
  const providers = getEnabledProviders();
  if (!providers.length) {
    return {
      models: [],
      raw: [],
      fallback: false,
      errors: []
    };
  }

  const settled = await Promise.allSettled(
    providers.map((provider) => listAvailableModelsForProvider(provider, options))
  );

  const models = [];
  const raw = [];
  const errors = [];
  let fallback = false;
  const seen = new Set();

  settled.forEach((result, index) => {
    const provider = providers[index];
    if (result.status === "fulfilled") {
      raw.push({ provider, payload: result.value.raw || null });
      fallback ||= result.value.fallback === true;
      for (const model of Array.isArray(result.value.models) ? result.value.models : []) {
        if (!model?.id || seen.has(model.id)) {
          continue;
        }
        seen.add(model.id);
        models.push(model);
      }
      return;
    }
    errors.push({ provider, message: String(result.reason?.message || result.reason || "unknown error").trim() });
  });

  if (!models.length && errors.length) {
    throw new Error(`AI models request failed: ${errors.map((item) => `${getProviderDisplayName(item.provider)}: ${item.message}`).join(" | ")}`);
  }

  return {
    models,
    raw,
    fallback,
    errors
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

function describeTransportError(prefix, error) {
  const name = String(error?.name || "Error").trim();
  const message = String(error?.message || error || "unknown error").trim();
  const code = String(error?.code || "").trim();
  const cause = String(error?.cause?.message || error?.cause || "").trim();
  const detail = [
    `${name}: ${message}`.trim(),
    code ? `code=${code}` : "",
    cause ? `cause=${cause}` : ""
  ].filter(Boolean).join("; ");
  const wrapped = new Error(`${prefix}: ${detail || "unknown error"}`);
  if (error?.stack) {
    wrapped.stack = `${wrapped.name}: ${wrapped.message}\nCaused by:\n${String(error.stack).trim()}`;
  }
  if (error?.cause) {
    wrapped.cause = error.cause;
  }
  if (error?.code) {
    wrapped.code = error.code;
  }
  return wrapped;
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
  const { _provider = "", _mode = "text", ...requestBody } = body;
  const resolved = resolveProviderAndModel(requestBody.model || "", _mode);
  requestBody.model = resolved.modelId;

  let response = null;
  try {
    response = await fetch(getEndpointUrl(resolved.provider), {
      method: "POST",
      headers: getAuthHeaders(resolved.provider),
      signal: requestBody.signal,
      body: JSON.stringify(requestBody)
    });
  } catch (error) {
    throw describeTransportError("AI model request transport failed", error);
  }
  let rawText = "";
  try {
    rawText = await response.text();
  } catch (error) {
    throw describeTransportError("AI model response read failed", error);
  }
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
    model: encodeModelRef(resolved.provider, String(payload?.model || requestBody.model || "")),
    usage: payload?.usage || null,
    finishReason: String(payload?.choices?.[0]?.finish_reason || ""),
    toolCalls: extractToolCalls(choice),
    message: choice || null,
    raw: payload
  };
}

async function invokeChatCompletionStream(body = {}, handlers = {}) {
  const { _provider = "", _mode = "text", ...requestBody } = body;
  const resolved = resolveProviderAndModel(requestBody.model || "", _mode);
  requestBody.model = resolved.modelId;

  let response = null;
  try {
    response = await fetch(getEndpointUrl(resolved.provider), {
      method: "POST",
      headers: getAuthHeaders(resolved.provider),
      signal: requestBody.signal,
      body: JSON.stringify({
        ...requestBody,
        stream: true,
        stream_options: { include_usage: true }
      })
    });
  } catch (error) {
    throw describeTransportError("AI model stream transport failed", error);
  }
  if (!response.ok || !response.body) {
    const rawText = await response.text().catch(() => "");
    throw new Error(`AI model stream failed: ${rawText || `${response.status} ${response.statusText}`}`.trim());
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let text = "";
  let model = encodeModelRef(resolved.provider, String(requestBody.model || ""));
  let usage = null;
  let finishReason = "";

  try {
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
        model = encodeModelRef(resolved.provider, String(payload?.model || parseModelRef(model).modelId || ""));
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
  } catch (error) {
    throw describeTransportError("AI model stream read failed", error);
  }
}

export async function invokeTextModel(options = {}) {
  const model = String(options.model || getDefaultTextModelName() || "").trim();
  if (!model) {
    throw new Error("COPILOT_MODEL, XUNFEI_MODEL, XFYUN_MODEL, ARK_MODEL, ARK_ENDPOINT_ID, or OPENAI_MODEL is required for text AI bot");
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
    _mode: "text",
    messages,
    signal: options.signal,
    temperature: Number.isFinite(options.temperature) ? Number(options.temperature) : 0.3,
    max_tokens: Number.isFinite(options.maxTokens) ? Math.max(128, Math.floor(options.maxTokens)) : 900,
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? (options.toolChoice || "auto") : undefined
  });
}

export async function invokeTextModelStream(options = {}, handlers = {}) {
  const model = String(options.model || getDefaultTextModelName() || "").trim();
  if (!model) {
    throw new Error("COPILOT_MODEL, XUNFEI_MODEL, XFYUN_MODEL, ARK_MODEL, ARK_ENDPOINT_ID, or OPENAI_MODEL is required for text AI bot");
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
    _mode: "text",
    messages,
    signal: options.signal,
    temperature: Number.isFinite(options.temperature) ? Number(options.temperature) : 0.3,
    max_tokens: Number.isFinite(options.maxTokens) ? Math.max(128, Math.floor(options.maxTokens)) : 900
  }, handlers);
}

export async function invokeMultimodalModel(options = {}) {
  const model = String(options.model || getDefaultMultimodalModelName() || "").trim();
  if (!model) {
    throw new Error("COPILOT_MULTIMODAL_MODEL, COPILOT_MODEL, XUNFEI_MULTIMODAL_MODEL, XFYUN_MULTIMODAL_MODEL, XUNFEI_MODEL, XFYUN_MODEL, ARK_MULTIMODAL_MODEL, ARK_MODEL, ARK_ENDPOINT_ID, or OPENAI_MULTIMODAL_MODEL is required for multimodal AI bot");
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
    _mode: "multimodal",
    messages,
    signal: options.signal,
    temperature: Number.isFinite(options.temperature) ? Number(options.temperature) : 0.2,
    max_tokens: Number.isFinite(options.maxTokens) ? Math.max(128, Math.floor(options.maxTokens)) : 1000
  });
}

export async function invokeMultimodalModelStream(options = {}, handlers = {}) {
  const model = String(options.model || getDefaultMultimodalModelName() || "").trim();
  if (!model) {
    throw new Error("COPILOT_MULTIMODAL_MODEL, COPILOT_MODEL, XUNFEI_MULTIMODAL_MODEL, XFYUN_MULTIMODAL_MODEL, XUNFEI_MODEL, XFYUN_MODEL, ARK_MULTIMODAL_MODEL, ARK_MODEL, ARK_ENDPOINT_ID, or OPENAI_MULTIMODAL_MODEL is required for multimodal AI bot");
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
    _mode: "multimodal",
    messages,
    signal: options.signal,
    temperature: Number.isFinite(options.temperature) ? Number(options.temperature) : 0.2,
    max_tokens: Number.isFinite(options.maxTokens) ? Math.max(128, Math.floor(options.maxTokens)) : 1000
  }, handlers);
}
