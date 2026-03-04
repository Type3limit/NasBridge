import { WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";
import { touchClient, clearClientFiles } from "./db.js";

export function initWsHub(server) {
  const wss = new WebSocketServer({ noServer: true });
  const peers = new Map();
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
        wss.emit("connection", ws);
      });
    } catch (error) {
      log("upgrade-error", error?.message || error);
      socket.destroy();
    }
  });

  function broadcastToAdmins(clientId, status) {
    for (const [, ws] of peers.entries()) {
      if (ws.identity?.role === "admin" && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "admin-client-status", clientId, status }));
      }
    }
  }

  wss.on("connection", (ws) => {
    const principalId = ws.identity.sub;
    peers.set(principalId, ws);
    log("connected", ws.identity.role, principalId);

    if (ws.identity.role === "client") {
      touchClient(principalId, "online");
      broadcastToAdmins(principalId, "online");
    }

    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === "signal" && message.targetId) {
          log("signal", { from: principalId, to: message.targetId, kind: message.payload?.kind });
          const target = peers.get(message.targetId);
          if (target && target.readyState === target.OPEN) {
            target.send(
              JSON.stringify({
                type: "signal",
                fromId: principalId,
                payload: message.payload
              })
            );
          } else {
            log("signal-drop", { from: principalId, to: message.targetId, reason: "target-offline" });
          }
        }
      } catch (error) {
        log("message-parse-error", principalId, error?.message || error);
      }
    });

    ws.on("close", () => {
      peers.delete(principalId);
      log("closed", ws.identity.role, principalId);
      if (ws.identity.role === "client") {
        touchClient(principalId, "offline");
        const removed = clearClientFiles(principalId);
        log("client-offline-files-cleared", principalId, `removed=${removed}`);
        broadcastToAdmins(principalId, "offline");
      }
    });
  });

  return { broadcastAdminClientStatus: broadcastToAdmins };
}
