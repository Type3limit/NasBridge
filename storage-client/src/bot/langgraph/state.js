import { Annotation } from "@langchain/langgraph";

function replaceValue(left, right) {
  return right ?? left;
}

function replaceArray(left = [], right) {
  if (!right) {
    return left;
  }
  return Array.isArray(right) ? right : left;
}

function appendTrace(left = [], right = []) {
  if (!right) {
    return left;
  }
  if (Array.isArray(right)) {
    return left.concat(right);
  }
  return left.concat([right]);
}

export const AiChatGraphState = Annotation.Root({
  context: Annotation({
    reducer: replaceValue,
    default: () => null
  }),
  api: Annotation({
    reducer: replaceValue,
    default: () => null
  }),
  handlers: Annotation({
    reducer: replaceValue,
    default: () => ({})
  }),
  hooks: Annotation({
    reducer: replaceValue,
    default: () => ({})
  }),
  route: Annotation({
    reducer: replaceValue,
    default: () => "text"
  }),
  prepared: Annotation({
    reducer: replaceValue,
    default: () => ({})
  }),
  visionAttachments: Annotation({
    reducer: replaceArray,
    default: () => []
  }),
  visionInputs: Annotation({
    reducer: replaceArray,
    default: () => []
  }),
  visionPrompt: Annotation({
    reducer: replaceValue,
    default: () => ""
  }),
  planningMessages: Annotation({
    reducer: replaceArray,
    default: () => []
  }),
  pendingToolCalls: Annotation({
    reducer: replaceArray,
    default: () => []
  }),
  modelResult: Annotation({
    reducer: replaceValue,
    default: () => null
  }),
  toolRound: Annotation({
    reducer: replaceValue,
    default: () => 0
  }),
  result: Annotation({
    reducer: replaceValue,
    default: () => null
  }),
  trace: Annotation({
    reducer: appendTrace,
    default: () => []
  })
});