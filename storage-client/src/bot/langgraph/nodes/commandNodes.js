import { buildAvailableModelChoices, buildAvailableModelsText, buildModelUsageText, buildUseListedModelText, filterModelsByCapability, getModelFilterLabel, sortModelsForDisplay } from "../../plugins/ai-chat/formatters/models.js";
import { normalizeModelFilter } from "../../plugins/ai-chat/parsers/modelDirectives.js";
import { withSessionSubtitle } from "../../plugins/ai-chat/parsers/sessionDirectives.js";
import { createAiSession, deleteAiSession, formatAiSessionLabel, listAiSessions, renameAiSession } from "../../plugins/ai-chat/services/aiSessions.js";
import { compressAiSessionContext } from "../../plugins/ai-chat/services/compressAiSession.js";
import { getEffectiveMultimodalModel, getEffectiveTextModel, writeAiModelSettings } from "../../plugins/ai-chat/services/modelSettings.js";
import { getDefaultTextModelName, listAvailableModels } from "../../tools/llmClient.js";

const MODEL_PROVIDER_SEPARATOR = "::";
const PROVIDER_BADGE_META = {
  copilot: { label: "GitHub Copilot", color: "informative" },
  xunfei: { label: "讯飞Maas", color: "warning" },
  ark: { label: "Ark", color: "success" },
  openai: { label: "OpenAI Compatible", color: "subtle" }
};

function getProviderFromModelRef(value = "") {
  const trimmed = String(value || "").trim();
  if (!trimmed.includes(MODEL_PROVIDER_SEPARATOR)) {
    return "";
  }
  return String(trimmed.split(MODEL_PROVIDER_SEPARATOR)[0] || "").trim().toLowerCase();
}

function getProviderLabel(provider = "") {
  const normalized = String(provider || "").trim().toLowerCase();
  return PROVIDER_BADGE_META[normalized]?.label || normalized || "未标记 provider";
}

function getProviderBadgeColor(provider = "") {
  const normalized = String(provider || "").trim().toLowerCase();
  return PROVIDER_BADGE_META[normalized]?.color || "informative";
}

function createProviderBadge(provider = "", prefix = "") {
  const normalized = String(provider || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return {
    label: prefix ? `${prefix} · ${getProviderLabel(normalized)}` : getProviderLabel(normalized),
    color: getProviderBadgeColor(normalized),
    appearance: "tint"
  };
}

function buildProviderSummaryBadges(models = []) {
  const counts = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const provider = String(model?.provider || "").trim().toLowerCase();
    if (!provider) {
      continue;
    }
    counts.set(provider, (counts.get(provider) || 0) + 1);
  }
  return [...counts.entries()].map(([provider, count]) => ({
    label: `${getProviderLabel(provider)} ${count}`,
    color: getProviderBadgeColor(provider),
    appearance: "tint"
  }));
}

function buildEffectiveProviderBadges(settings = {}) {
  const textProvider = getProviderFromModelRef(getEffectiveTextModel(settings));
  const visionProvider = getProviderFromModelRef(getEffectiveMultimodalModel(settings));
  if (textProvider && visionProvider && textProvider === visionProvider) {
    return [createProviderBadge(textProvider, "文本/看图")].filter(Boolean);
  }
  return [
    createProviderBadge(textProvider, "文本"),
    createProviderBadge(visionProvider, "看图")
  ].filter(Boolean);
}

export async function handleAiChatCommandRoute(state = {}) {
  const prepared = state.prepared || {};
  const api = prepared.api;
  const sessionDirective = prepared.sessionDirective || {};
  const modelDirective = prepared.modelDirective || {};
  const modelSettings = prepared.modelSettings || {};
  const activeSession = prepared.activeSession || null;
  const modelOverride = prepared.modelOverride || "";
  const defaultTextModel = prepared.defaultTextModel || "";
  const defaultMultimodalModel = prepared.defaultMultimodalModel || "";

  api.throwIfCancelled();

  if (sessionDirective.command?.type === "new-session") {
    const session = await createAiSession(api.appDataRoot, sessionDirective.command.name || "");
    const reply = [`已创建 AI 会话 ${formatAiSessionLabel(session)}`, `后续使用方式：@ai #${session.id} 你的问题`, `例如：@ai #${session.id} 继续刚才的话题`].join("\n");
    return {
      result: {
        chatReply: await api.publishChatReply({
          text: reply,
          card: { type: "ai-answer", status: "succeeded", title: "AI 会话已创建", subtitle: formatAiSessionLabel(session), body: reply }
        }),
        importedFiles: [],
        artifacts: [{ type: "ai-session-created", sessionId: session.id, name: session.name }]
      }
    };
  }

  if (sessionDirective.command?.type === "list-sessions") {
    const sessions = await listAiSessions(api.appDataRoot);
    const reply = sessions.length
      ? ["已有 AI 会话：", ...sessions.map((item) => `- ${formatAiSessionLabel(item)} · 最近更新 ${String(item.updatedAt || item.createdAt || "").slice(0, 16).replace("T", " ")}`), "", "使用方式：@ai #编号 你的问题"].join("\n")
      : "当前还没有 AI 会话，先执行 @ai /new 会话名字";
    return {
      result: {
        chatReply: await api.publishChatReply({
          text: reply,
          card: { type: "ai-answer", status: "succeeded", title: "AI 会话列表", subtitle: `共 ${sessions.length} 个会话`, body: reply }
        }),
        importedFiles: [],
        artifacts: [{ type: "ai-session-list", count: sessions.length }]
      }
    };
  }

  if (sessionDirective.command?.type === "rename-session") {
    const renamed = await renameAiSession(api.appDataRoot, sessionDirective.sessionId, sessionDirective.command.name || "");
    if (!renamed) {
      throw new Error(`AI 会话 #${sessionDirective.sessionId} 不存在，无法重命名`);
    }
    const reply = [`已重命名 AI 会话 ${formatAiSessionLabel(renamed)}`, `后续使用方式：@ai #${renamed.id} 你的问题`].join("\n");
    return {
      result: {
        chatReply: await api.publishChatReply({
          text: reply,
          card: { type: "ai-answer", status: "succeeded", title: "AI 会话已重命名", subtitle: formatAiSessionLabel(renamed), body: reply }
        }),
        importedFiles: [],
        artifacts: [{ type: "ai-session-renamed", sessionId: renamed.id, name: renamed.name }]
      }
    };
  }

  if (sessionDirective.command?.type === "delete-session") {
    const deleted = await deleteAiSession(api.appDataRoot, sessionDirective.sessionId);
    if (!deleted) {
      throw new Error(`AI 会话 #${sessionDirective.sessionId} 不存在，无法删除`);
    }
    const reply = [`已删除 AI 会话 ${formatAiSessionLabel(deleted)}`, "该会话的独立上下文已一并移除。"].join("\n");
    return {
      result: {
        chatReply: await api.publishChatReply({
          text: reply,
          card: { type: "ai-answer", status: "succeeded", title: "AI 会话已删除", subtitle: `#${deleted.id}`, body: reply }
        }),
        importedFiles: [],
        artifacts: [{ type: "ai-session-deleted", sessionId: deleted.id, name: deleted.name }]
      }
    };
  }

  if (modelDirective.inspectOnly) {
    const usageText = buildModelUsageText(modelSettings);
    const infoBadges = modelOverride
      ? [createProviderBadge(getProviderFromModelRef(modelOverride), "临时")].filter(Boolean)
      : buildEffectiveProviderBadges(modelSettings);
    return {
      result: {
        chatReply: await api.publishChatReply({
          text: usageText,
          card: { type: "ai-answer", status: "succeeded", title: "AI 模型信息", subtitle: withSessionSubtitle(modelOverride ? `临时模型: ${modelOverride}` : "可在消息内临时切换", activeSession), body: usageText, badges: infoBadges }
        }),
        importedFiles: [],
        artifacts: [{ type: "model-info", textModel: defaultTextModel, multimodalModel: defaultMultimodalModel }]
      }
    };
  }

  if (modelDirective.command && modelDirective.command.type !== "explicit-search") {
    if (modelDirective.command.type === "compress") {
      if (!activeSession) {
        throw new Error("压缩上下文需要绑定 AI 会话，请使用格式：@ai #会话编号 /compress");
      }
      const summary = await compressAiSessionContext({
        appDataRoot: api.appDataRoot,
        session: activeSession,
        textModel: defaultTextModel,
        signal: api.signal
      });
      if (!summary) {
        const body = "当前会话消息数量不足（少于 4 条），无需压缩上下文。";
        return {
          result: {
            chatReply: await api.publishChatReply({
              text: body,
              card: { type: "ai-answer", status: "succeeded", title: "上下文压缩", subtitle: withSessionSubtitle("", activeSession), body }
            }),
            importedFiles: [],
            artifacts: [{ type: "compress-skipped", sessionId: activeSession.id }]
          }
        };
      }
      const body = `上下文已压缩，会话历史已替换为以下摘要：\n\n${summary}\n\n后续对话将基于此摘要继续。`;
      return {
        result: {
          chatReply: await api.publishChatReply({
            text: body,
            card: { type: "ai-answer", status: "succeeded", title: "上下文已压缩", subtitle: withSessionSubtitle("", activeSession), body }
          }),
          importedFiles: [],
          artifacts: [{ type: "compress-done", sessionId: activeSession.id }]
        }
      };
    }

    if (modelDirective.command.type === "list-models") {
      const filter = normalizeModelFilter(modelDirective.command.filter || "all");
      const result = await listAvailableModels({ signal: api.signal });
      const displayedModels = sortModelsForDisplay(filterModelsByCapability(result.models, filter));
      const nextSettings = { ...modelSettings, lastListedModels: displayedModels, lastListFilter: filter };
      await writeAiModelSettings(api.appDataRoot, nextSettings);
      const body = buildAvailableModelsText(displayedModels, nextSettings, filter);
      const providerBadges = buildProviderSummaryBadges(displayedModels);
      const modelChoices = buildAvailableModelChoices(displayedModels, nextSettings);
      return {
        result: {
          chatReply: await api.publishChatReply({
            text: body,
            card: { type: "ai-answer", status: "succeeded", title: "AI 可用模型列表", subtitle: withSessionSubtitle(`${getModelFilterLabel(filter)} · 共 ${displayedModels.length} 个模型`, activeSession), body, badges: providerBadges, modelChoices }
          }),
          importedFiles: [],
          artifacts: [{ type: "model-list", count: displayedModels.length, filter }]
        }
      };
    }

    if (modelDirective.command.type === "use-listed-model") {
      const listedModels = Array.isArray(modelSettings.lastListedModels) ? modelSettings.lastListedModels : [];
      const selectedIndex = Number(modelDirective.command.index || 0);
      if (!listedModels.length) {
        throw new Error("还没有可用的模型列表，请先执行 @ai /models、@ai /models tool-calls 或 @ai /models vision。");
      }
      if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > listedModels.length) {
        throw new Error(`列表序号超出范围，请输入 1 到 ${listedModels.length} 之间的数字。`);
      }
      const selectedModel = listedModels[selectedIndex - 1];
      const previousTextModel = String(modelSettings.textModel || "").trim() || getDefaultTextModelName() || "";
      const nextSettings = { ...modelSettings, textModel: selectedModel.id, multimodalModel: String(modelSettings.multimodalModel || "").trim() };
      const hasIndependentVisionModel = nextSettings.multimodalModel && nextSettings.multimodalModel !== previousTextModel;
      if (selectedModel.vision && !hasIndependentVisionModel) {
        nextSettings.multimodalModel = selectedModel.id;
      }
      await writeAiModelSettings(api.appDataRoot, nextSettings);
      const body = buildUseListedModelText(selectedModel, nextSettings, String(modelSettings.lastListFilter || "all").trim() || "all");
      return {
        result: {
          chatReply: await api.publishChatReply({
            text: body,
            card: { type: "ai-answer", status: "succeeded", title: "AI 默认模型已更新", subtitle: withSessionSubtitle(`${selectedIndex}. ${selectedModel.modelId || selectedModel.id}`, activeSession), body, badges: [createProviderBadge(selectedModel.provider, "当前")].filter(Boolean) }
          }),
          importedFiles: [],
          artifacts: [{ type: "model-settings-updated", textModel: nextSettings.textModel || "", multimodalModel: nextSettings.multimodalModel || "" }]
        }
      };
    }

    const nextSettings = {
      textModel: String(modelSettings.textModel || "").trim(),
      multimodalModel: String(modelSettings.multimodalModel || "").trim(),
      lastListedModels: Array.isArray(modelSettings.lastListedModels) ? modelSettings.lastListedModels : [],
      lastListFilter: String(modelSettings.lastListFilter || "all").trim() || "all"
    };
    if (modelDirective.command.type === "set") {
      nextSettings.textModel = String(modelDirective.command.model || "").trim();
    } else if (modelDirective.command.type === "set-vision") {
      nextSettings.multimodalModel = String(modelDirective.command.model || "").trim();
    } else if (modelDirective.command.type === "set-all") {
      nextSettings.textModel = String(modelDirective.command.model || "").trim();
      nextSettings.multimodalModel = String(modelDirective.command.model || "").trim();
    } else if (modelDirective.command.type === "reset") {
      nextSettings.textModel = "";
      nextSettings.multimodalModel = "";
    } else if (modelDirective.command.type === "reset-vision") {
      nextSettings.multimodalModel = "";
    }

    await writeAiModelSettings(api.appDataRoot, nextSettings);
    const usageText = buildModelUsageText(nextSettings);
    const badges = buildEffectiveProviderBadges(nextSettings);
    return {
      result: {
        chatReply: await api.publishChatReply({
          text: usageText,
          card: { type: "ai-answer", status: "succeeded", title: "AI 默认模型已更新", subtitle: withSessionSubtitle(`文本: ${getEffectiveTextModel(nextSettings) || "未配置"} · 看图: ${getEffectiveMultimodalModel(nextSettings) || "未配置"}`, activeSession), body: usageText, badges }
        }),
        importedFiles: [],
        artifacts: [{ type: "model-settings-updated", textModel: nextSettings.textModel || "", multimodalModel: nextSettings.multimodalModel || "" }]
      }
    };
  }

  throw new Error("AI chat graph reached command route without a command handler");
}