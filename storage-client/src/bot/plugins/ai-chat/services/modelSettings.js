import fs from "node:fs";
import { getDefaultMultimodalModelName, getDefaultTextModelName } from "../../../tools/llmClient.js";
import { AI_MODEL_SETTINGS_FILE_NAME } from "../constants.js";

function getAiModelSettingsPath(appDataRoot = "") {
  return `${String(appDataRoot || "").replace(/[\\/]+$/, "")}/${AI_MODEL_SETTINGS_FILE_NAME}`;
}

export function createEmptyModelCatalogState() {
  return {
    lastListedModels: [],
    lastListFilter: "all"
  };
}

export async function readAiModelSettings(appDataRoot = "") {
  try {
    const raw = await fs.promises.readFile(getAiModelSettingsPath(appDataRoot), "utf8");
    const parsed = JSON.parse(raw);
    return {
      textModel: String(parsed?.textModel || "").trim(),
      multimodalModel: String(parsed?.multimodalModel || "").trim(),
      lastListedModels: Array.isArray(parsed?.lastListedModels)
        ? parsed.lastListedModels.map((item) => ({
            id: String(item?.id || "").trim(),
            name: String(item?.name || item?.id || "").trim(),
            vendor: String(item?.vendor || "").trim(),
            preview: item?.preview === true,
            toolCalls: item?.toolCalls === true,
            vision: item?.vision === true
          })).filter((item) => item.id)
        : [],
      lastListFilter: String(parsed?.lastListFilter || "all").trim() || "all"
    };
  } catch {
    return {
      textModel: "",
      multimodalModel: "",
      ...createEmptyModelCatalogState()
    };
  }
}

export async function writeAiModelSettings(appDataRoot = "", settings = {}) {
  await fs.promises.mkdir(String(appDataRoot || ""), { recursive: true });
  await fs.promises.writeFile(
    getAiModelSettingsPath(appDataRoot),
    `${JSON.stringify({
      textModel: String(settings?.textModel || "").trim(),
      multimodalModel: String(settings?.multimodalModel || "").trim(),
      lastListedModels: Array.isArray(settings?.lastListedModels)
        ? settings.lastListedModels.map((item) => ({
            id: String(item?.id || "").trim(),
            name: String(item?.name || item?.id || "").trim(),
            vendor: String(item?.vendor || "").trim(),
            preview: item?.preview === true,
            toolCalls: item?.toolCalls === true,
            vision: item?.vision === true
          })).filter((item) => item.id)
        : [],
      lastListFilter: String(settings?.lastListFilter || "all").trim() || "all"
    }, null, 2)}\n`,
    "utf8"
  );
}

export function getEffectiveTextModel(settings = {}) {
  return String(settings?.textModel || "").trim() || getDefaultTextModelName() || "";
}

export function getEffectiveMultimodalModel(settings = {}) {
  return String(settings?.multimodalModel || "").trim()
    || String(settings?.textModel || "").trim()
    || getDefaultMultimodalModelName()
    || getDefaultTextModelName()
    || "";
}