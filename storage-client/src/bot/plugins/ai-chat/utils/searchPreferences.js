import { SEARCH_PREFERENCE_ALIASES } from "../constants.js";

export function normalizeSearchPreference(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  for (const [key, aliases] of Object.entries(SEARCH_PREFERENCE_ALIASES)) {
    if (aliases.includes(normalized)) {
      return key;
    }
  }
  return "";
}

export function getSearchPreferenceLabel(value = "") {
  const normalized = normalizeSearchPreference(value);
  if (normalized === "official") {
    return "官网优先";
  }
  if (normalized === "github") {
    return "GitHub 优先";
  }
  if (normalized === "docs") {
    return "文档站优先";
  }
  if (normalized === "news") {
    return "新闻站优先";
  }
  return "默认";
}

export function getMatchedSourceLabel(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "official") {
    return "官网";
  }
  if (normalized === "github") {
    return "GitHub";
  }
  if (normalized === "docs") {
    return "文档站";
  }
  if (normalized === "news") {
    return "新闻站";
  }
  return "网页";
}