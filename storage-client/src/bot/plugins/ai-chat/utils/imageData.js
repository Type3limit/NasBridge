import fs from "node:fs";
import { MAX_INLINE_IMAGE_BYTES } from "../constants.js";

export async function attachmentToDataUrl(attachment, options = {}) {
  const maxInlineBytes = Number(options?.maxInlineBytes) || MAX_INLINE_IMAGE_BYTES;
  const errorPrefix = String(options?.errorPrefix || "图片").trim() || "图片";
  const fallbackMimeType = String(options?.fallbackMimeType || "image/jpeg").trim() || "image/jpeg";
  const mimeType = String(attachment?.mimeType || fallbackMimeType).trim() || fallbackMimeType;
  const stat = await fs.promises.stat(attachment.absolutePath);
  if (Number(stat.size || 0) > maxInlineBytes) {
    throw new Error(`${errorPrefix} ${attachment.name} 超过 ${(maxInlineBytes / (1024 * 1024)).toFixed(0)}MB，暂不发送给多模态模型`);
  }
  const content = await fs.promises.readFile(attachment.absolutePath);
  return {
    dataUrl: `data:${mimeType};base64,${content.toString("base64")}`,
    mimeType,
    byteLength: Number(stat.size || 0)
  };
}