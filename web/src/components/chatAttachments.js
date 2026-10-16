import { contentIdentity } from "../replicas.js";

const nodePathKey = (clientId, filePath) => `${clientId}|${String(filePath || "").replace(/\\/g, "/")}`;
const nameSizeKey = (name, size) => `${String(name || "").toLowerCase()}|${Number(size)}`;

export function buildAttachmentFileIndex(files = []) {
  const index = { byId: new Map(), byNodePath: new Map(), byIdentity: new Map(), byNameSize: new Map() };
  const push = (map, key, file) => map.set(key, [...(map.get(key) || []), file]);
  for (const file of files) {
    index.byId.set(file.id, file);
    index.byNodePath.set(nodePathKey(file.clientId, file.path), file);
    const identity = contentIdentity(file);
    if (identity) push(index.byIdentity, identity, file);
    if (Number.isSafeInteger(file.size)) push(index.byNameSize, nameSizeKey(file.name || String(file.path || "").split("/").pop(), file.size), file);
  }
  return index;
}

// Chat attachments are mirrored to every node at the same path, so one whose node
// is offline can be read from any online node. Library files are followed through
// the index: by content hash (or, for older cards, name and size) they are found
// again after being moved, renamed folders, or copied to another node.
export function resolveAttachmentNode(attachment, context) {
  if (!attachment?.clientId || !attachment.path || !context.onlineIds.size) {
    return attachment;
  }
  if (String(attachment.path).startsWith(`${context.chatAssetPrefix}/`)) {
    if (context.onlineIds.has(attachment.clientId)) return attachment;
    const clientId = context.onlineIds.has(context.preferredId) ? context.preferredId : [...context.onlineIds][0];
    return { ...attachment, clientId, originClientId: attachment.clientId };
  }
  const index = context.fileIndex();
  const indexedHere = index.byNodePath.get(nodePathKey(attachment.clientId, attachment.path));
  if (indexedHere && context.onlineIds.has(attachment.clientId)) {
    return attachment;
  }
  const identity = contentIdentity(attachment) || contentIdentity(index.byId.get(attachment.id) || indexedHere || {});
  const candidates = (identity
    ? index.byIdentity.get(identity)
    : index.byNameSize.get(nameSizeKey(attachment.name || String(attachment.path).split("/").pop(), attachment.size))) || [];
  const online = candidates.filter((file) => context.onlineIds.has(file.clientId));
  const copy = online.find((file) => file.clientId === attachment.clientId) || online.find((file) => file.clientId === context.preferredId) || online[0];
  if (!copy) return attachment;
  return { ...attachment, clientId: copy.clientId, path: copy.path, contentHash: attachment.contentHash || copy.contentHash || "", originClientId: attachment.clientId };
}
