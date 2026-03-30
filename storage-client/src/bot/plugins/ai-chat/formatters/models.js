import { getEffectiveMultimodalModel, getEffectiveTextModel } from "../services/modelSettings.js";

export function getModelFilterLabel(filter = "all") {
  if (filter === "tool-calls") {
    return "仅支持 tool-calls";
  }
  if (filter === "vision") {
    return "仅支持视觉";
  }
  return "全部模型";
}

export function filterModelsByCapability(models = [], filter = "all") {
  if (filter === "tool-calls") {
    return models.filter((model) => model.toolCalls);
  }
  if (filter === "vision") {
    return models.filter((model) => model.vision);
  }
  return models;
}

export function sortModelsForDisplay(models = []) {
  return [...models].sort((left, right) => {
    const vendorCompare = String(left.vendor || "未标记 vendor").localeCompare(String(right.vendor || "未标记 vendor"), "zh-Hans-CN", { sensitivity: "base" });
    if (vendorCompare !== 0) {
      return vendorCompare;
    }
    return String(left.id || "").localeCompare(String(right.id || ""), "zh-Hans-CN", { sensitivity: "base" });
  });
}

export function groupModelsByVendor(models = []) {
  const groups = new Map();
  for (const model of sortModelsForDisplay(models)) {
    const vendor = String(model.vendor || "未标记 vendor").trim() || "未标记 vendor";
    if (!groups.has(vendor)) {
      groups.set(vendor, []);
    }
    groups.get(vendor).push(model);
  }
  return groups;
}

export function buildModelUsageText(settings = {}) {
  const envTextModel = getEffectiveTextModel({}) || "未配置";
  const envMultimodalModel = getEffectiveMultimodalModel({}) || envTextModel;
  const textModel = getEffectiveTextModel(settings) || "未配置";
  const multimodalModel = getEffectiveMultimodalModel(settings) || textModel;
  return [
    `当前文本模型：${textModel}`,
    `当前看图模型：${multimodalModel}`,
    `环境默认文本模型：${envTextModel}`,
    `环境默认看图模型：${envMultimodalModel}`,
    "全局切换方法：",
    "- @ai /model set <模型名>",
    "- @ai /model set-all <模型名>",
    "- @ai /model set-vision <模型名>",
    "- @ai /model reset",
    "- @ai /model use <列表序号>",
    "查看模型列表：",
    "- @ai /models",
    "- @ai /models tool-calls",
    "- @ai /models vision",
    "显式联网搜索：",
    "- @ai /search OpenAI 最新模型",
    "- @ai /search --site=github react compiler",
    "- @ai /search 官网 Claude Code 使用方式",
    "临时切换方法：",
    "- @ai /model <模型名> 你的问题",
    "- @ai --model=<模型名> 你的问题"
  ].join("\n");
}

export function buildAvailableModelsText(models = [], settings = {}, filter = "all") {
  const currentTextModel = getEffectiveTextModel(settings) || "";
  const currentMultimodalModel = getEffectiveMultimodalModel(settings) || "";
  if (!models.length) {
    return [
      `当前 provider 在“${getModelFilterLabel(filter)}”下没有返回任何模型。`,
      "你可以直接访问 /v1/models 检查代理是否正常。"
    ].join("\n");
  }
  const lines = [
    `筛选: ${getModelFilterLabel(filter)}`,
    "使用方式: @ai /model use <列表序号>",
    ""
  ];
  let globalIndex = 0;
  for (const [vendor, vendorModels] of groupModelsByVendor(models)) {
    lines.push(`【${vendor}】`);
    for (const model of vendorModels) {
      globalIndex += 1;
      const tags = [];
      if (model.id === currentTextModel) {
        tags.push("当前文本默认");
      }
      if (model.id === currentMultimodalModel) {
        tags.push("当前看图默认");
      }
      if (model.toolCalls) {
        tags.push("tool-calls");
      }
      if (model.vision) {
        tags.push("vision");
      }
      if (model.preview) {
        tags.push("preview");
      }
      const modelLabel = model.name && model.name !== model.id ? `${model.id} (${model.name})` : model.id;
      lines.push(`${globalIndex}. ${modelLabel}${tags.length ? ` [${tags.join(" | ")}]` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function buildUseListedModelText(selectedModel = {}, nextSettings = {}, filter = "all") {
  return [
    `已切换默认文本模型：${getEffectiveTextModel(nextSettings) || "未配置"}`,
    `当前默认看图模型：${getEffectiveMultimodalModel(nextSettings) || "未配置"}`,
    `来自最近一次模型列表：${getModelFilterLabel(filter)}`,
    selectedModel.vision ? "该模型支持视觉，已在不覆盖独立看图设置的前提下联动更新。" : "该模型未标记为视觉模型，仅更新文本默认模型。"
  ].join("\n");
}