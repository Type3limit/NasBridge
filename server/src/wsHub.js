import { WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";
import { touchClient, clearClientFiles, getUserById } from "./db.js";

const CHAT_REALTIME_LIMIT_BYTES = 100 * 1024;

function sanitizeMessageCard(rawCard) {
  const card = rawCard && typeof rawCard === "object" ? rawCard : null;
  if (!card) {
    return null;
  }
  const progress = Number.isFinite(card.progress) ? Math.max(0, Math.min(100, Number(card.progress))) : null;
  const actions = Array.isArray(card.actions)
    ? card.actions.slice(0, 4).map((action) => ({
        type: String(action?.type || "").slice(0, 32),
        label: String(action?.label || "").slice(0, 80),
        url: String(action?.url || "").slice(0, 500),
        attachmentId: String(action?.attachmentId || "").slice(0, 160)
      })).filter((action) => action.type && action.label)
    : [];
  const next = {
    type: String(card.type || "bot-status").slice(0, 32),
    status: String(card.status || "info").slice(0, 24),
    title: String(card.title || "").slice(0, 160),
    subtitle: String(card.subtitle || "").slice(0, 240),
    body: String(card.body || "").slice(0, 2000),
    progress,
    imageUrl: String(card.imageUrl || "").slice(0, 500),
    imageAlt: String(card.imageAlt || "").slice(0, 160),
    mediaAttachmentId: String(card.mediaAttachmentId || "").slice(0, 160),
    sourceLabel: String(card.sourceLabel || "").slice(0, 300),
    sourceUrl: String(card.sourceUrl || "").slice(0, 500),
    actions
  };
  if (!next.title && !next.body && !next.mediaAttachmentId && !next.imageUrl) {
    return null;
  }
  return next;
}

function sanitizeBotMetadata(rawBot) {
  const bot = rawBot && typeof rawBot === "object" ? rawBot : null;
  if (!bot) {
    return null;
  }
  return {
    botId: String(bot.botId || "").slice(0, 120),
    jobId: String(bot.jobId || "").slice(0, 120)
  };
}

function sanitizeAvatarResponse(user) {
  const rawAvatarUrl = String(user?.avatarUrl || "");
  const isInlineAvatar = /^data:/i.test(rawAvatarUrl);
  return {
    avatarUrl: isInlineAvatar ? "" : rawAvatarUrl,
    avatarClientId: user?.avatarClientId || "",
    avatarPath: user?.avatarPath || "",
    avatarFileId: user?.avatarFileId || ""
  };
}

function buildChatAuthor(user) {
  const avatar = sanitizeAvatarResponse(user);
  return {
    id: user?.id || "",
    displayName: user?.displayName || "匿名用户",
    avatarUrl: avatar.avatarUrl,
    avatarClientId: avatar.avatarClientId,
    avatarPath: avatar.avatarPath,
    avatarFileId: avatar.avatarFileId
  };
}

function sanitizeSuppliedBotAuthor(author) {
  const payload = author && typeof author === "object" ? author : {};
  const id = String(payload.id || "").slice(0, 120);
  if (!id.startsWith("bot:")) {
    return null;
  }
  return {
    id,
    displayName: String(payload.displayName || "Bot").slice(0, 80),
    avatarUrl: "",
    avatarClientId: "",
    avatarPath: "",
    avatarFileId: ""
  };
}

function sanitizeChatPayload(rawPayload, principalId) {
  const user = getUserById(principalId);
  if (!user) {
    return null;
  }
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.slice(0, 6).map((item) => ({
        id: String(item?.id || "").slice(0, 160),
        name: String(item?.name || "附件").slice(0, 200),
        mimeType: String(item?.mimeType || "application/octet-stream").slice(0, 120),
        size: Math.max(0, Number(item?.size || 0)),
        path: String(item?.path || "").slice(0, 500),
        clientId: String(item?.clientId || payload.hostClientId || "").slice(0, 120),
        kind: String(item?.kind || "file").slice(0, 24)
      })).filter((item) => item.path && item.clientId)
    : [];
  const message = {
    id: String(payload.id || "").slice(0, 120),
    text: String(payload.text || "").slice(0, 4000),
    createdAt: String(payload.createdAt || new Date().toISOString()).slice(0, 64),
    dayKey: String(payload.dayKey || "").slice(0, 32),
    historyPath: String(payload.historyPath || "").slice(0, 500),
    hostClientId: String(payload.hostClientId || "").slice(0, 120),
    attachments,
    author: buildChatAuthor(user)
  };
  if (!message.id || !message.createdAt || !message.hostClientId || !message.historyPath) {
    return null;
  }
  if (!message.text && !message.attachments.length) {
    return null;
  }
  return message;
}

function sanitizeBotChatPayload(rawPayload, principalId) {
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const author = sanitizeSuppliedBotAuthor(payload.author);
  if (!author) {
    return null;
  }
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.slice(0, 6).map((item) => ({
        id: String(item?.id || "").slice(0, 160),
        name: String(item?.name || "附件").slice(0, 200),
        mimeType: String(item?.mimeType || "application/octet-stream").slice(0, 120),
        size: Math.max(0, Number(item?.size || 0)),
        path: String(item?.path || "").slice(0, 500),
        clientId: String(item?.clientId || payload.hostClientId || "").slice(0, 120),
        kind: String(item?.kind || "file").slice(0, 24)
      })).filter((item) => item.path && item.clientId)
    : [];
  const message = {
    id: String(payload.id || "").slice(0, 120),
    text: String(payload.text || "").slice(0, 4000),
    createdAt: String(payload.createdAt || new Date().toISOString()).slice(0, 64),
    dayKey: String(payload.dayKey || "").slice(0, 32),
    historyPath: String(payload.historyPath || "").slice(0, 500),
    hostClientId: String(payload.hostClientId || "").slice(0, 120),
    attachments,
    author,
    card: sanitizeMessageCard(payload.card),
    bot: sanitizeBotMetadata(payload.bot)
  };
  if (!message.id || !message.createdAt || !message.hostClientId || !message.historyPath) {
    return null;
  }
  if (message.hostClientId !== principalId) {
    return null;
  }
  if (!message.text && !message.attachments.length && !message.card) {
    return null;
  }
  return message;
}

export function initWsHub(server) {
  const wss = new WebSocketServer({ noServer: true });
  const routes = new Map();
  const adminSockets = new Set();
  const clientSockets = new Map();
  const debug = process.env.P2P_DEBUG === "1";

  function log(...args) {
    if (debug) {
      console.log("[server-ws]", ...args);
    }
  }

  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== "/ws") {
        log("upgrade-reject", "invalid-path", url.pathname);
        return socket.destroy();
      }
      const token = url.searchParams.get("token");
      if (!token) {
        log("upgrade-reject", "missing-token");
        return socket.destroy();
      }
      const payload = verifyToken(token);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.identity = payload;
        ws.bridgeRole = url.searchParams.get("bridgeRole") || "";
        wss.emit("connection", ws);
      });
    } catch (error) {
      log("upgrade-error", error?.message || error);
      socket.destroy();
    }
  });

  function broadcastToAdmins(clientId, status) {
    for (const ws of adminSockets) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "admin-client-status", clientId, status }));
      }
    }
  }

  function resolveSignalTarget(targetId) {
    return routes.get(targetId) || clientSockets.get(targetId) || null;
  }

  function broadcastToAppUsers(payload) {
    const serialized = JSON.stringify(payload);
    for (const ws of routes.values()) {
      if (ws.readyState !== ws.OPEN) {
        continue;
      }
      if (ws.identity?.role === "client" || ws.identity?.role === "share") {
        continue;
      }
      if (ws.bridgeRole !== "control") {
        continue;
      }
      ws.send(serialized);
    }
  }

  function sendToSocket(ws, payload) {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  wss.on("connection", (ws) => {
    const principalId = ws.identity.sub;
    const routeId = ws.identity.role === "client"
      ? principalId
      : ws.identity.role === "share"
        ? `share:${principalId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
        : `${principalId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    ws.routeId = routeId;
    routes.set(routeId, ws);
    if (ws.identity.role === "admin") {
      adminSockets.add(ws);
    } else if (ws.identity.role === "client") {
      clientSockets.set(principalId, ws);
    }
    log("connected", ws.identity.role, principalId, routeId);

    if (ws.identity.role === "client") {
      touchClient(principalId, "online");
      broadcastToAdmins(principalId, "online");
    }

    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === "signal" && message.targetId) {
          log("signal", { from: routeId, principalId, to: message.targetId, kind: message.payload?.kind });
          const target = resolveSignalTarget(message.targetId);
          if (target && target.readyState === target.OPEN) {
            target.send(
              JSON.stringify({
                type: "signal",
                fromId: routeId,
                payload: message.payload
              })
            );
          } else {
            log("signal-drop", { from: routeId, principalId, to: message.targetId, reason: "target-offline" });
          }
          return;
        }

        if (message.type === "chat-room-message") {
          if (ws.identity?.role === "share") {
            sendToSocket(ws, { type: "chat-room-error", message: "当前连接不允许发送聊天室消息" });
            return;
          }
          const estimatedSize = Buffer.byteLength(JSON.stringify(message), "utf8");
          if (estimatedSize > CHAT_REALTIME_LIMIT_BYTES) {
            sendToSocket(ws, { type: "chat-room-error", message: "实时聊天室消息超过 100KB 限制" });
            return;
          }
          const sanitized = ws.identity?.role === "client"
            ? sanitizeBotChatPayload(message.payload, principalId)
            : sanitizeChatPayload(message.payload, principalId);
          if (!sanitized) {
            sendToSocket(ws, { type: "chat-room-error", message: "聊天室消息格式无效" });
            return;
          }
          broadcastToAppUsers({ type: "chat-room-message", payload: sanitized });
          return;
        }

      } catch (error) {
        log("message-parse-error", principalId, error?.message || error);
      }
    });

    ws.on("close", () => {
      routes.delete(routeId);
      adminSockets.delete(ws);
      if (ws.identity.role === "client" && clientSockets.get(principalId) === ws) {
        clientSockets.delete(principalId);
      }
      log("closed", ws.identity.role, principalId, routeId);
      if (ws.identity.role === "client") {
        touchClient(principalId, "offline");
        const removed = clearClientFiles(principalId);
        log("client-offline-files-cleared", principalId, `removed=${removed}`);
        broadcastToAdmins(principalId, "offline");
      }
    });
  });

  return {
    broadcastAdminClientStatus: broadcastToAdmins,
    broadcastToAppUsers
  };
}
