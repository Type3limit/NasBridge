import { normalizeSearchPreference } from "../utils/searchPreferences.js";

export function normalizeModelFilter(rawValue = "") {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value || value === "all" || value === "全部") {
    return "all";
  }
  if (["tool", "tools", "tool-call", "tool-calls", "function", "functions", "工具", "工具调用"].includes(value)) {
    return "tool-calls";
  }
  if (["vision", "image", "multimodal", "看图", "视觉", "图片"].includes(value)) {
    return "vision";
  }
  return "all";
}

export function parseModelDirective(rawPrompt = "") {
  const prompt = String(rawPrompt || "").trim();
  if (!prompt) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: null
    };
  }

  if (/^\/model\s*$/i.test(prompt)) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: true,
      command: null
    };
  }

  if (/^\/search\b/i.test(prompt)) {
    const rest = prompt.replace(/^\/search\b/i, "").trim();
    let preferredSource = "";
    let query = rest;
    const optionMatch = query.match(/^--site(?:=|\s+)([^\s]+)\s*([\s\S]*)$/i);
    if (optionMatch) {
      preferredSource = normalizeSearchPreference(optionMatch[1] || "");
      query = String(optionMatch[2] || "").trim();
    } else {
      const inlineMatch = query.match(/^([^\s]+)\s+([\s\S]*)$/);
      const maybePreference = normalizeSearchPreference(inlineMatch?.[1] || "");
      if (maybePreference) {
        preferredSource = maybePreference;
        query = String(inlineMatch?.[2] || "").trim();
      }
    }
    return {
      prompt: query,
      modelOverride: "",
      inspectOnly: false,
      command: {
        type: "explicit-search",
        query,
        preferredSource
      }
    };
  }

  const useCommand = prompt.match(/^\/model\s+use\s+(\d+)\s*$/i);
  if (useCommand?.[1]) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: {
        type: "use-listed-model",
        index: Number.parseInt(useCommand[1], 10)
      }
    };
  }

  const listCommand = prompt.match(/^\/(?:models|model\s+list)(?:\s+([^\s]+))?\s*$/i);
  if (listCommand) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: {
        type: "list-models",
        filter: normalizeModelFilter(listCommand[1] || "")
      }
    };
  }

  const setAllCommand = prompt.match(/^\/model\s+set-all\s+([^\s]+)\s*$/i);
  if (setAllCommand?.[1]) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: {
        type: "set-all",
        model: String(setAllCommand[1] || "").trim()
      }
    };
  }

  const setVisionCommand = prompt.match(/^\/model\s+set-vision\s+([^\s]+)\s*$/i);
  if (setVisionCommand?.[1]) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: {
        type: "set-vision",
        model: String(setVisionCommand[1] || "").trim()
      }
    };
  }

  const setCommand = prompt.match(/^\/model\s+set\s+([^\s]+)\s*$/i);
  if (setCommand?.[1]) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: {
        type: "set",
        model: String(setCommand[1] || "").trim()
      }
    };
  }

  if (/^\/model\s+reset-vision\s*$/i.test(prompt)) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: {
        type: "reset-vision"
      }
    };
  }

  if (/^\/model\s+reset\s*$/i.test(prompt)) {
    return {
      prompt: "",
      modelOverride: "",
      inspectOnly: false,
      command: {
        type: "reset"
      }
    };
  }

  const inlineOption = prompt.match(/^--model(?:=|\s+)([^\s]+)(?:\s+([\s\S]*))?$/i);
  if (inlineOption?.[1]) {
    return {
      prompt: String(inlineOption[2] || "").trim(),
      modelOverride: String(inlineOption[1] || "").trim(),
      inspectOnly: false,
      command: null
    };
  }

  const slashCommand = prompt.match(/^\/(?:model|use-model)\s+([^\s]+)(?:\s+([\s\S]*))?$/i);
  if (slashCommand?.[1]) {
    return {
      prompt: String(slashCommand[2] || "").trim(),
      modelOverride: String(slashCommand[1] || "").trim(),
      inspectOnly: false,
      command: null
    };
  }

  return {
    prompt,
    modelOverride: "",
    inspectOnly: false,
    command: null
  };
}