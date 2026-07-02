import fs from "node:fs";
import { getDefaultMultimodalModelName, getDefaultTextModelName } from "../../../tools/llmClient.js";
import { AI_MODEL_SETTINGS_FILE_NAME } from "../constants.js";

function getAiModelSettingsPath(appDataRoot = "") {
  return `${String(appDataRoot || "").replace(/[\\/]+$/, "")}/${AI_MODEL_SETTINGS_FILE_NAME}`;
}

function normalizeModelLookupKey(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function normalizeListedModels(models = []) {
  return Array.isArray(models)
    ? models.map((item) => ({
        id: String(item?.id || "").trim(),
        modelId: String(item?.modelId || item?.id || "").trim(),
        provider: String(item?.provider || "").trim(),
        name: String(item?.name || item?.id || "").trim(),
        vendor: String(item?.vendor || "").trim(),
        preview: item?.preview === true,
        toolCalls: item?.toolCalls === true,
        vision: item?.vision === true
      })).filter((item) => item.id)
    : [];
}

export function migrateStoredModelRef(value = "", listedModels = []) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const models = normalizeListedModels(listedModels);
  if (models.some((item) => item.id === raw)) {
    return raw;
  }
  const rawKey = normalizeModelLookupKey(raw);
  const matches = models.filter((item) => (
    normalizeModelLookupKey(item.modelId) === rawKey
    || normalizeModelLookupKey(item.name) === rawKey
    || normalizeModelLookupKey(item.id) === rawKey
  ));
  return matches.length === 1 ? matches[0].id : raw;
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
    const lastListedModels = normalizeListedModels(parsed?.lastListedModels);
    return {
      textModel: migrateStoredModelRef(parsed?.textModel, lastListedModels),
      multimodalModel: migrateStoredModelRef(parsed?.multimodalModel, lastListedModels),
      lastListedModels,
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
      lastListedModels: normalizeListedModels(settings?.lastListedModels),
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
