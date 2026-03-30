import { createBotJobMessageId } from "../../context.js";
import { withSessionSubtitle } from "./parsers/sessionDirectives.js";

export async function delegateBotInvocation(api, context, nestedInvocation, activeSession = null, options = {}) {
  await api.emitProgress({ phase: "delegate-bot", label: `委派给 ${nestedInvocation.target.displayName}`, percent: 35 });
  const delegatedJob = await api.invokeBot({
    botId: nestedInvocation.target.botId,
    trigger: {
      type: options.triggerType || "delegated-by-ai",
      rawText: nestedInvocation.rawText,
      parsedArgs: nestedInvocation.parsedArgs
    },
    options: {
      delegatedBy: api.botId,
      parentJobId: api.jobId,
      ...(options.extraOptions && typeof options.extraOptions === "object" ? options.extraOptions : {})
    }
  });
  const reply = `已转交给 ${nestedInvocation.target.displayName}，任务 ${String(delegatedJob.jobId || "").slice(0, 12)} 已创建。`;
  return {
    reply,
    delegatedJob,
    chatReply: await api.publishChatReply({
      id: options.replyMessageId || createBotJobMessageId(context.jobId),
      text: reply,
      card: {
        type: "ai-answer",
        status: "succeeded",
        title: "AI 调度完成",
        subtitle: withSessionSubtitle(options.subtitle || `已委派给 ${nestedInvocation.target.displayName}`, activeSession),
        body: reply
      }
    }),
    artifacts: [{ type: "delegated-job", jobId: delegatedJob.jobId || "", botId: nestedInvocation.target.botId }]
  };
}