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