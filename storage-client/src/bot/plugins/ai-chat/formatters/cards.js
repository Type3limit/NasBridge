import { MAX_CARD_BODY_LENGTH } from "../constants.js";
import { withSessionSubtitle } from "../parsers/sessionDirectives.js";
import { getMatchedSourceLabel, getSearchPreferenceLabel } from "../utils/searchPreferences.js";

export function createAnswerCard(answer, model, mode = "text", session = null) {
  return {
    type: mode === "multimodal" ? "image-analysis" : "ai-answer",
    status: "succeeded",
    title: mode === "multimodal" ? "AI 看图结果" : "AI 回答",
    subtitle: withSessionSubtitle(model ? `模型: ${model}` : "", session),
    body: String(answer || "").slice(0, MAX_CARD_BODY_LENGTH)
  };
}

export function formatSearchCardBody(searchResult = {}, answer = "") {
  const plan = searchResult?.plan || {};
  const followUpDecision = searchResult?.followUpDecision || {};
  const results = Array.isArray(searchResult?.results) ? searchResult.results : [];
  const queryLines = [
    `- 用户问题：${String(searchResult?.query || "").trim() || "未提供"}`,
    `- 站点偏好：${String(searchResult?.preferredSourceLabel || getSearchPreferenceLabel(searchResult?.preferredSource || "") || "默认")}`,
    `- 拟搜索词：${Array.isArray(plan.searchTerms) && plan.searchTerms.length ? plan.searchTerms.join("；") : "未生成"}`
  ];
  if (Array.isArray(plan.strategy) && plan.strategy.length) {
    queryLines.push(`- 检索方案：${plan.strategy.join("；")}`);
  }
  queryLines.push(`- 是否二次进页：${followUpDecision?.needsPageFetch ? "是" : "否"}`);
  if (String(followUpDecision?.reason || "").trim()) {
    queryLines.push(`- 进页判断：${String(followUpDecision.reason || "").trim()}`);
  }

  const sourceLines = results.length
    ? results.map((item, index) => `${index + 1}. [${String(item.title || item.url || "结果").replace(/\]/g, "")}](${item.url})\n   - 来源类型：${getMatchedSourceLabel(item.matchedSource)}\n   - 命中检索词：${String(item.matchedQuery || item.query || "").trim() || "未记录"}\n   - 页面抓取：${item?.page ? "已进入页面" : "仅使用搜索摘要"}`)
    : ["暂无命中结果"];

  const summaryLines = results.length
    ? results.map((item, index) => {
        const rankingEntries = Array.isArray(item?.page?.ranking?.entries) ? item.page.ranking.entries : [];
        const excerpt = String(item?.page?.excerpt || item?.page?.description || item?.snippet || "").trim() || "暂无页面摘要";
        if (rankingEntries.length) {
          const topText = rankingEntries.slice(0, 5).map((entry) => `${entry.rank || "-"}. ${entry.title}`).join("；");
          return `${index + 1}. ${String(item.title || item.url || "结果").trim()}：${topText}`;
        }
        return `${index + 1}. ${String(item.title || item.url || "结果").trim()}：${excerpt}`;
      })
    : ["暂无页面摘要"];

  return [
    "## 检索词",
    ...queryLines,
    "",
    "## 命中来源",
    ...sourceLines,
    "",
    "## 页面摘要",
    ...summaryLines,
    "",
    "## 最终回答",
    String(answer || "模型没有返回可显示的内容。").trim()
  ].join("\n");
}