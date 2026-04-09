export function stripSelfMention(rawText = "") {
  return String(rawText || "").replace(/^\s*@\s*(?:ai|assistant)\b\s*/i, "").trim();
}

export function isImageAttachment(attachment) {
  return /^image\//i.test(String(attachment?.mimeType || ""));
}

export function wantsSummary(prompt = "") {
  return /总结|摘要|summary|summari[sz]e/i.test(String(prompt || ""));
}

export function wantsVision(prompt = "", attachments = []) {
  if (attachments.some((item) => isImageAttachment(item))) {
    return true;
  }
  return /看图|识图|describe image|analy[sz]e image|图片|image|截图|照片|photo/i.test(String(prompt || ""));
}

export function wantsVideoAnalysis(prompt = "") {
  const text = String(prompt || "");
  const hasBilibiliUrl = /https?:\/\/(?:www\.)?bilibili\.com\/video\/[A-Za-z0-9]+|https?:\/\/b23\.tv\/[A-Za-z0-9]+|\bBV[0-9A-Za-z]{10}\b/i.test(text);
  if (!hasBilibiliUrl) {
    return false;
  }
  return /分析|总结|讲了什么|说了什么|内容|summarize|summary|analyze|analyse/i.test(text);
}

export function wantsBatchTagging(prompt = "") {
  const text = String(prompt || "");
  return /打标签|批量.*标签|标签.*视频|视频.*标签|给.*视频.*分类|auto.tag|batch.tag|classify.*video/i.test(text);
}