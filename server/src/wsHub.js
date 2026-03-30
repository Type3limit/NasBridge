import { WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";
import { touchClient, clearClientFiles } from "./db.js";
import { persistChatMessage } from "./chatDb.js";
import { sanitizeUserChatPayload, sanitizeBotChatPayload } from "./chatMessages.js";

const CHAT_REALTIME_LIMIT_BYTES = 100 * 1024;

export function initWsHub(server) {
  const wss = new WebSocketServer({ noServer: true });
  const routes = new Map();
  const adminSockets = new Set();
  const clientSockets = new Map();
  const chatSockets = new Set();
  const debug = process.env.P2P_DEBUG === "1";

  function log(...args) {
    if (debug) {
      console.log("[server-ws]", ...args);
    }
  }

  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== "/ws" && url.pathname !== "/ws/chat") {
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
        ws.channel = url.pathname === "/ws/chat" ? "chat" : "control";
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

  function broadcastToChatUsers(payload) {
    const serialized = JSON.stringify(payload);
    for (const ws of chatSockets) {
      if (ws.readyState !== ws.OPEN) {
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
    if (ws.channel === "chat") {
      chatSockets.add(ws);
    } else if (ws.identity.role === "admin") {
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
        if (ws.channel === "chat") {
          sendToSocket(ws, { type: "chat-room-error", message: "聊天室实时通道只接收服务器广播" });
          return;
        }
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
            : sanitizeUserChatPayload(message.payload, principalId);
          if (!sanitized) {
            sendToSocket(ws, { type: "chat-room-error", message: "聊天室消息格式无效" });
            return;
          }
          const stored = persistChatMessage(sanitized);
          broadcastToChatUsers({ type: "chat-room-message", payload: stored });
          return;
        }

      } catch (error) {
        log("message-parse-error", principalId, error?.message || error);
      }
    });

    ws.on("close", () => {
      routes.delete(routeId);
      chatSockets.delete(ws);
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
    broadcastToAppUsers,
    broadcastToChatUsers
  };
}
