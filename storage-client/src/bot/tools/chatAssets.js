import fs from "node:fs";
import path from "node:path";
import mime from "mime-types";
import { safeJoin } from "../../fsIndex.js";

const chatRoomDirName = process.env.CHAT_ROOM_DIR_NAME || ".nas-chat-room";
const chatAttachmentPrefix = `${chatRoomDirName}/attachments/`;

function normalizeRelativePath(value = "") {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function normalizeAttachment(item = {}, hostClientId = "") {
  return {
    id: String(item?.id || `${item?.clientId || hostClientId}:${item?.path || ""}`),
    name: String(item?.name || "附件"),
    mimeType: String(item?.mimeType || "application/octet-stream"),
    size: Math.max(0, Number(item?.size || 0)),
    path: normalizeRelativePath(item?.path || ""),
    clientId: String(item?.clientId || hostClientId || ""),
    kind: String(item?.kind || "file")
  };
}

export async function resolveChatAttachmentFile(options = {}) {
  const storageRoot = path.resolve(options.storageRoot || process.cwd());
  const attachment = normalizeAttachment(options.attachment, options.hostClientId || "");
  if (!attachment.path.startsWith(chatAttachmentPrefix)) {
    throw new Error("attachment is outside chat attachment scope");
  }
  const absolutePath = safeJoin(storageRoot, attachment.path);
  const stat = await fs.promises.stat(absolutePath);
  return {
    ...attachment,
    absolutePath,
    relativePath: attachment.path,
    size: Number(stat.size || attachment.size || 0),
    mimeType: attachment.mimeType || mime.lookup(absolutePath) || "application/octet-stream"
  };
}

export async function listReferencedChatAttachments(options = {}) {
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const limit = Math.max(1, Math.min(12, Math.floor(Number(options.limit || 6) || 6)));
  const mimePrefix = String(options.mimePrefix || "").trim().toLowerCase();
  const seen = new Set();
  const candidates = [];

  for (const attachment of attachments) {
    candidates.push(normalizeAttachment(attachment, options.hostClientId || ""));
  }

  for (const message of [...messages].reverse()) {
    for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
      candidates.push(normalizeAttachment(attachment, message?.hostClientId || options.hostClientId || ""));
    }
  }

  const resolved = [];
  for (const attachment of candidates) {
    const key = `${attachment.clientId}:${attachment.path}`;
    if (!attachment.path || seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (mimePrefix && !String(attachment.mimeType || "").toLowerCase().startsWith(mimePrefix)) {
      continue;
    }
    try {
      resolved.push(await resolveChatAttachmentFile({
        storageRoot: options.storageRoot,
        attachment,
        hostClientId: options.hostClientId || ""
      }));
    } catch {
    }
    if (resolved.length >= limit) {
      break;
    }
  }
  return resolved;
}
