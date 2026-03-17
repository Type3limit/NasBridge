import { toWsUrl } from "./api";

const FILE_TRANSFER_TIMEOUT_MS = 300_000;
const PEER_IDLE_CLOSE_MS = 60_000;
const DEFAULT_CHANNEL_NAMES = ["file", "thumb", "preview", "upload", "control"];
const PEER_ROLE_ORDER = ["download", "upload", "preview", "control"];
const PEER_ROLE_CONFIG = {
  download: { name: "downloadPeer", channelNames: ["file"] },
  upload: { name: "uploadPeer", channelNames: ["upload"] },
  preview: { name: "previewPeer", channelNames: ["thumb", "preview"] },
  control: { name: "controlPeer", channelNames: ["control"] }
};
const CHANNEL_ROLE_MAP = {
  file: "download",
  upload: "upload",
  thumb: "preview",
  preview: "preview",
  control: "control"
};

function createEmptyDiagnostics() {
  return {
    wsState: "idle",
    wsUrl: "",
    wsLastError: "",
    clients: {}
  };
}

function pickPreferredClientDiagnostics(roleEntries) {
  for (const role of PEER_ROLE_ORDER) {
    const entry = roleEntries.find((item) => item.role === role);
    if (!entry?.diag) {
      continue;
    }
    const connectionState = String(entry.diag.connectionState || "");
    const iceState = String(entry.diag.iceState || "");
    const route = String(entry.diag.route || "unknown");
    if (connectionState === "connected" || iceState === "connected" || iceState === "completed" || route !== "unknown") {
      return entry;
    }
  }
  return roleEntries[0] || null;
}

function mergeDiagnosticsSnapshots(roleSnapshots) {
  const snapshots = roleSnapshots || {};
  const wsStates = PEER_ROLE_ORDER.map((role) => snapshots[role]?.wsState || "idle");
  let wsState = "idle";
  if (wsStates.every((state) => state === "open")) {
    wsState = "open";
  } else if (wsStates.some((state) => state === "connecting")) {
    wsState = "connecting";
  } else if (wsStates.some((state) => state === "open")) {
    wsState = "degraded";
  } else if (wsStates.some((state) => state === "error")) {
    wsState = "error";
  } else if (wsStates.some((state) => state === "closed")) {
    wsState = "closed";
  }

  const wsUrl = PEER_ROLE_ORDER
    .map((role) => `${role}:${snapshots[role]?.wsUrl || "-"}`)
    .join(" | ");
  const wsLastError = PEER_ROLE_ORDER
    .map((role) => snapshots[role]?.wsLastError ? `${role}:${snapshots[role].wsLastError}` : "")
    .filter(Boolean)
    .join(" | ");

  const clientIds = new Set();
  for (const role of PEER_ROLE_ORDER) {
    for (const clientId of Object.keys(snapshots[role]?.clients || {})) {
      clientIds.add(clientId);
    }
  }

  const clients = {};
  for (const clientId of clientIds) {
    const roleEntries = PEER_ROLE_ORDER
      .map((role) => ({
        role,
        diag: snapshots[role]?.clients?.[clientId] || null
      }))
      .filter((entry) => entry.diag);
    const preferredEntry = pickPreferredClientDiagnostics(roleEntries);
    const preferred = preferredEntry?.diag || {};
    const peers = Object.fromEntries(roleEntries.map((entry) => [entry.role, { ...entry.diag }]));
    clients[clientId] = {
      ...preferred,
      route: preferred.route || "unknown",
      routeLabel: preferred.routeLabel || preferred.route || "unknown",
      retries: roleEntries.reduce((sum, entry) => sum + Number(entry.diag?.retries || 0), 0),
      currentSendBps: roleEntries.reduce((sum, entry) => sum + Number(entry.diag?.currentSendBps || 0), 0),
      currentRecvBps: roleEntries.reduce((sum, entry) => sum + Number(entry.diag?.currentRecvBps || 0), 0),
      totalBytesSent: roleEntries.reduce((sum, entry) => sum + Number(entry.diag?.totalBytesSent || 0), 0),
      totalBytesReceived: roleEntries.reduce((sum, entry) => sum + Number(entry.diag?.totalBytesReceived || 0), 0),
      lastError: roleEntries.map((entry) => entry.diag?.lastError || "").find(Boolean) || "",
      peers
    };
  }

  return {
    wsState,
    wsUrl,
    wsLastError,
    clients
  };
}

function resolvePeerRole(channelOrRole) {
  return PEER_ROLE_CONFIG[channelOrRole] ? channelOrRole : (CHANNEL_ROLE_MAP[channelOrRole] || "control");
}

function buildIceServers() {
  const servers = [];
  const stunUrl = import.meta.env.VITE_STUN_URL;
  const turnUrl = import.meta.env.VITE_TURN_URL;
  const turnUsername = import.meta.env.VITE_TURN_USERNAME;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;

  // Normalise URLs: auto-prepend scheme if the user omitted it in .env
  const normaliseStun = (u) => (u && !u.includes(":") ? `stun:${u}` : u);
  const normaliseTurn = (u) => (u && !/^turns?:/.test(u) ? `turn:${u}` : u);

  if (stunUrl) {
    servers.push({ urls: [normaliseStun(stunUrl)] });
  }
  if (turnUrl && turnUsername && turnCredential) {
    servers.push({
      urls: [normaliseTurn(turnUrl)],
      username: turnUsername,
      credential: turnCredential
    });
  }
  if (!servers.length) {
    servers.push({ urls: ["stun:stun.l.google.com:19302"] });
  }
  return servers;
}

function readIceCandidatePoolSize() {
  const raw = Number(import.meta.env.VITE_ICE_CANDIDATE_POOL_SIZE);
  if (!Number.isFinite(raw)) {
    return 2;
  }
  return Math.max(0, Math.min(10, Math.floor(raw)));
}

function readCandidateDelayMs(value, fallback = 0) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, Math.min(10_000, Math.floor(raw)));
}

function readSrflxCandidateDelayMs() {
  const legacy = readCandidateDelayMs(import.meta.env.VITE_P2P_HOST_FIRST_DELAY_MS, 0);
  return readCandidateDelayMs(import.meta.env.VITE_P2P_SRFLX_DELAY_MS, legacy);
}

function readRelayCandidateDelayMs() {
  const legacy = readCandidateDelayMs(import.meta.env.VITE_P2P_HOST_FIRST_DELAY_MS, 0);
  return readCandidateDelayMs(import.meta.env.VITE_P2P_RELAY_DELAY_MS, legacy);
}

function readRelayUpgradeDelayMs() {
  return readCandidateDelayMs(import.meta.env.VITE_P2P_RELAY_UPGRADE_DELAY_MS, 5000);
}

function extractCandidateAddress(candidate) {
  const direct = String(candidate?.address || candidate?.ip || "").trim();
  if (direct) {
    return direct;
  }
  const parts = String(candidate?.candidate || "").trim().split(/\s+/);
  return String(parts[4] || "").trim();
}

function extractCandidateType(candidate) {
  const direct = String(candidate?.type || candidate?.candidateType || "").trim();
  if (direct) {
    return direct;
  }
  const parts = String(candidate?.candidate || "").trim().split(/\s+/);
  const typeIndex = parts.indexOf("typ");
  return typeIndex >= 0 ? String(parts[typeIndex + 1] || "").trim() : "";
}

function isLoopbackCandidateAddress(address = "") {
  const value = String(address || "").trim().toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

function isLinkLocalCandidateAddress(address = "") {
  const value = String(address || "").trim().toLowerCase();
  return value.startsWith("169.254.") || value.startsWith("fe80:");
}

function getCandidateSignalDelayMs(candidateType, delays) {
  if (candidateType === "relay") {
    return delays.relay;
  }
  if (candidateType === "srflx") {
    return delays.srflx;
  }
  return 0;
}

export class P2PBridge {
  constructor(token, options = {}) {
    this.token = token;
    this.accessToken = options.accessToken || "";
    this.name = options.name || "peer";
    this.role = options.role || "default";
    this.socket = null;
    this.socketReady = null;
    this.peers = new Map();
    this.pendingPeers = new Map();
    this.currentOp = new Map();
    this.clientQueues = new Map();
    this.iceServers = buildIceServers();
    this.iceCandidatePoolSize = readIceCandidatePoolSize();
    this.candidateSignalDelayMs = {
      srflx: readSrflxCandidateDelayMs(),
      relay: readRelayCandidateDelayMs()
    };
    this.relayUpgradeDelayMs = readRelayUpgradeDelayMs();
    this.statsTimers = new Map();
    this.keepaliveTimers = new Map();
    this.lastPongTime = new Map();
    this.activeUploads = new Map();
    this.routeSamples = new Map();
    this.lastSelectedPairLog = new Map();
    this.relayUpgradeTimers = new Map();
    this.lastClientActivity = new Map();
    this.idleSweepTimer = setInterval(() => this.sweepIdlePeers(), 15_000);
    this.diagnostics = {
      wsState: "idle",
      wsUrl: "",
      wsLastError: "",
      clients: {}
    };
    this.diagnosticsListener = null;
    this.serverMessageListeners = new Set();
    this.channelNames = Array.isArray(options.channelNames) && options.channelNames.length
      ? [...options.channelNames]
      : [...DEFAULT_CHANNEL_NAMES];
    this.disposed = false;
    this.debug = import.meta.env.VITE_P2P_DEBUG === "1";
    this.wsReconnectDelay = 2000;
  }

  buildRequestPayload(payload = {}, options = {}) {
    const accessToken = options.accessToken || this.accessToken || "";
    if (!accessToken) {
      return payload;
    }
    return {
      ...payload,
      accessToken
    };
  }

  getActiveClientOpCount(clientId) {
    const prefix = `${clientId}::`;
    let count = 0;
    for (const key of this.currentOp.keys()) {
      if (key.startsWith(prefix)) {
        count += 1;
      }
    }
    return count;
  }

  hasActiveClientTransfer(clientId) {
    return this.getActiveClientOpCount(clientId) > 0 || this.isClientBusy(clientId);
  }

  markClientActivity(clientId) {
    if (!clientId) {
      return;
    }
    this.lastClientActivity.set(clientId, Date.now());
  }

  sweepIdlePeers() {
    if (this.disposed) {
      return;
    }
    const now = Date.now();
    for (const [clientId, peer] of this.peers.entries()) {
      if (!peer?.pc) {
        continue;
      }
      if (this.isClientBusy(clientId) || this.pendingPeers.has(clientId)) {
        continue;
      }
      const connState = peer.pc.connectionState;
      if (connState === "closed" || connState === "failed") {
        continue;
      }
      const lastActiveAt = this.lastClientActivity.get(clientId) || peer.createdAt || now;
      if (now - lastActiveAt < PEER_IDLE_CLOSE_MS) {
        continue;
      }
      this.updateClientDiagnostics(clientId, { lastError: `idle-close after ${Math.round(PEER_IDLE_CLOSE_MS / 1000)}s` });
      this.closePeer(clientId, true);
    }
  }

  waitAnyChannelOpen(channels) {
    return new Promise((resolve, reject) => {
      const allChannels = Object.values(channels || {}).filter(Boolean);
      if (!allChannels.length) {
        reject(new Error("P2P channels unavailable"));
        return;
      }
      const alreadyOpen = allChannels.find((channel) => channel.readyState === "open");
      if (alreadyOpen) {
        resolve();
        return;
      }

      const pending = new Set(allChannels);
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("P2P channel timeout"));
      }, 35000);

      const listeners = [];
      const cleanup = () => {
        clearTimeout(timer);
        for (const item of listeners) {
          item.channel.removeEventListener(item.event, item.handler);
        }
      };

      const onOpen = () => {
        cleanup();
        resolve();
      };

      const onClosedOrError = (channel) => {
        pending.delete(channel);
        if (!pending.size) {
          cleanup();
          reject(new Error("P2P all channels failed"));
        }
      };

      for (const channel of allChannels) {
        const openHandler = () => onOpen();
        const errorHandler = () => onClosedOrError(channel);
        const closeHandler = () => onClosedOrError(channel);
        channel.addEventListener("open", openHandler, { once: true });
        channel.addEventListener("error", errorHandler, { once: true });
        channel.addEventListener("close", closeHandler, { once: true });
        listeners.push(
          { channel, event: "open", handler: openHandler },
          { channel, event: "error", handler: errorHandler },
          { channel, event: "close", handler: closeHandler }
        );
      }
    });
  }
  log(...args) {
    if (this.debug) {
      console.log(`[web-p2p:${this.name}]`, ...args);
    }
  }

  logInfo(...args) {
    console.info(`[web-p2p:${this.name}]`, ...args);
  }

  logWarn(...args) {
    console.warn(`[web-p2p:${this.name}]`, ...args);
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  opKey(clientId, channelName) {
    return `${clientId}::${channelName}`;
  }

  setDiagnosticsListener(listener) {
    this.diagnosticsListener = listener;
    this.emitDiagnostics();
  }

  addServerMessageListener(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    this.serverMessageListeners.add(listener);
    return () => {
      this.serverMessageListeners.delete(listener);
    };
  }

  emitServerMessage(message) {
    for (const listener of this.serverMessageListeners) {
      try {
        listener(message);
      } catch {
      }
    }
  }

  emitDiagnostics() {
    if (typeof this.diagnosticsListener !== "function") {
      return;
    }
    this.diagnosticsListener({
      wsState: this.diagnostics.wsState,
      wsUrl: this.diagnostics.wsUrl,
      wsLastError: this.diagnostics.wsLastError,
      clients: { ...this.diagnostics.clients }
    });
  }

  updateClientDiagnostics(clientId, patch) {
    this.diagnostics.clients[clientId] = {
      retries: 0,
      iceState: "new",
      route: "unknown",
      lastError: "",
      ...this.diagnostics.clients[clientId],
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.emitDiagnostics();
  }

  connect() {
    if (this.disposed) {
      return;
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.socket && (this.socket.readyState === WebSocket.CLOSED || this.socket.readyState === WebSocket.CLOSING)) {
      this.socket = null;
      this.socketReady = null;
    }
    const wsUrl = toWsUrl(this.token, { bridgeRole: this.role });
    const socket = new WebSocket(wsUrl);
    this.log("ws-connect", wsUrl);
    this.socket = socket;
    this.diagnostics.wsState = "connecting";
    this.diagnostics.wsUrl = wsUrl;
    this.diagnostics.wsLastError = "";
    this.emitDiagnostics();

    this.socketReady = new Promise((resolve, reject) => {
      socket.addEventListener("open", () => {
        this.log("ws-open");
        this.diagnostics.wsState = "open";
        this.wsReconnectDelay = 2000;
        this.emitDiagnostics();
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        this.log("ws-error-open-phase");
        this.diagnostics.wsState = "error";
        this.diagnostics.wsLastError = "WebSocket connect failed";
        this.emitDiagnostics();
        reject(new Error("WebSocket connect failed"));
      }, { once: true });
      socket.addEventListener("close", () => {
        this.log("ws-close-open-phase");
        this.diagnostics.wsState = "closed";
        this.diagnostics.wsLastError = "WebSocket closed before ready";
        this.emitDiagnostics();
        reject(new Error("WebSocket closed before ready"));
      }, { once: true });
    });
    // Attach a no-op catch so that if socketReady is rejected before any caller
    // has awaited it (e.g. during React StrictMode mount/unmount/remount cycle),
    // the browser does not report an "Unhandled Promise Rejection".
    // The real error handling happens inside ensureSocketOpen's try/catch.
    this.socketReady.catch(() => {});

    socket.onmessage = async (event) => {
      this.log("ws-message", event.data?.length || 0);
      try {
        const message = JSON.parse(event.data);
        if (message.type === "admin-client-status") {
          this.log("client-status", message.clientId, message.status);
          if (message.status === "offline") {
            if (this.isPeerConnected(message.clientId) || this.isClientBusy(message.clientId)) {
              this.updateClientDiagnostics(message.clientId, { lastError: "client offline signal ignored during active peer session" });
            } else {
              this.closePeer(message.clientId);
            }
          }
          return;
        }
        if (message.type !== "signal") {
          this.emitServerMessage(message);
          return;
        }
        await this.handleSignal(message.fromId, message.payload);
      } catch (error) {
        this.log("signal-handle-error", error?.message || error);
      }
    };

    socket.onclose = () => {
      this.log("ws-close-runtime");
      this.socket = null;
      this.socketReady = null;
      this.diagnostics.wsState = "closed";
      this.diagnostics.wsLastError = this.diagnostics.wsLastError || "WebSocket closed";
      this.emitDiagnostics();
      if (!this.disposed) {
        const delay = this.wsReconnectDelay;
        this.wsReconnectDelay = Math.min(30000, delay * 1.5);
        setTimeout(() => this.connect(), delay);
      }
    };

    socket.onerror = (error) => {
      this.log("ws-error-runtime", error?.message || "runtime-error");
      this.diagnostics.wsLastError = error?.message || "WebSocket runtime error";
      this.emitDiagnostics();
    };
  }

  dispose() {
    this.disposed = true;
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = null;
    }
    for (const clientId of [...this.peers.keys()]) {
      this.closePeer(clientId);
    }
    for (const [, timer] of this.keepaliveTimers) {
      clearInterval(timer);
    }
    this.keepaliveTimers.clear();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
      }
    }
    this.socket = null;
    this.socketReady = null;
  }

  async ensureSocketOpen() {
    if (this.disposed) {
      throw new Error("WebSocket is disposed");
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (!this.socket || this.socket.readyState === WebSocket.CLOSED || this.socket.readyState === WebSocket.CLOSING) {
        this.socket = null;
        this.socketReady = null;
        this.connect();
      }

      try {
        if (this.socketReady) {
          await this.socketReady;
        }
      } catch {
        this.socket = null;
        this.socketReady = null;
      }

      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        return;
      }
      await this.sleep(Math.min(2000, 500 * attempt));
    }

    throw new Error("信令服务器连接失败，请确认服务端已启动");
  }

  isSocketOpen() {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  async sendSignal(targetId, payload) {
    await this.ensureSocketOpen();
    this.log("signal-send", { to: targetId, kind: payload?.kind });
    this.socket.send(JSON.stringify({ type: "signal", targetId, payload }));
  }

  async sendServerMessage(message) {
    await this.ensureSocketOpen();
    this.socket.send(JSON.stringify(message));
  }

  // soft=true: fire normal (retryable) errors to sibling ops so they can retry.
  // soft=false (default): fire intentionalClose so sibling ops abort immediately
  //   (used for true intentional closes: dispose, client-offline notification).
  closePeer(clientId, soft = false) {
    this.log("peer-close", clientId, soft ? "soft" : "hard");
    const peer = this.peers.get(clientId);
    const prefix = `${clientId}::`;
    for (const [key, pendingOp] of this.currentOp.entries()) {
      if (key.startsWith(prefix) && pendingOp?.onError) {
        const err = new Error("P2P peer closed");
        if (!soft) err.intentionalClose = true;
        pendingOp.onError(err);
      }
    }

    if (!peer) {
      for (const key of [...this.currentOp.keys()]) {
        if (key.startsWith(prefix)) {
          this.currentOp.delete(key);
        }
      }
      for (const key of [...this.clientQueues.keys()]) {
        if (key.startsWith(prefix)) {
          this.clientQueues.delete(key);
        }
      }
      this.stopKeepalive(clientId);
      const relayUpgradeTimer = this.relayUpgradeTimers.get(clientId);
      if (relayUpgradeTimer) {
        clearTimeout(relayUpgradeTimer);
        this.relayUpgradeTimers.delete(clientId);
      }
      this.routeSamples.delete(clientId);
      this.lastSelectedPairLog.delete(clientId);
      this.lastClientActivity.delete(clientId);
      this.updateClientDiagnostics(clientId, { iceState: "closed", route: "unknown" });
      return;
    }

    this.peers.delete(clientId);
    this.lastClientActivity.delete(clientId);

    const timer = this.statsTimers.get(clientId);
    if (timer) {
      clearInterval(timer);
      this.statsTimers.delete(clientId);
    }
    try {
      for (const channel of Object.values(peer.channels || {})) {
        channel?.close();
      }
    } catch {
    }
    try {
      peer.pc?.close();
    } catch {
    }
    for (const key of [...this.currentOp.keys()]) {
      if (key.startsWith(prefix)) {
        this.currentOp.delete(key);
      }
    }
    for (const key of [...this.clientQueues.keys()]) {
      if (key.startsWith(prefix)) {
        this.clientQueues.delete(key);
      }
    }
    this.stopKeepalive(clientId);
    const relayUpgradeTimer = this.relayUpgradeTimers.get(clientId);
    if (relayUpgradeTimer) {
      clearTimeout(relayUpgradeTimer);
      this.relayUpgradeTimers.delete(clientId);
    }
    this.routeSamples.delete(clientId);
    this.lastSelectedPairLog.delete(clientId);
    this.updateClientDiagnostics(clientId, { iceState: "closed", route: "unknown" });
  }

  async collectRouteDiagnostics(clientId, pc) {
    try {
      const stats = await pc.getStats();
      let selectedPair = null;
      let localCandidate = null;
      let remoteCandidate = null;

      stats.forEach((report) => {
        if (report.type === "transport" && report.selectedCandidatePairId && stats.get(report.selectedCandidatePairId)) {
          selectedPair = stats.get(report.selectedCandidatePairId);
        }
      });

      if (!selectedPair) {
        stats.forEach((report) => {
          if (report.type === "candidate-pair" && report.nominated && report.state === "succeeded") {
            selectedPair = report;
          }
        });
      }

      if (selectedPair) {
        localCandidate = stats.get(selectedPair.localCandidateId);
        remoteCandidate = stats.get(selectedPair.remoteCandidateId);
      }

      const localType = localCandidate?.candidateType || "unknown";
      const remoteType = remoteCandidate?.candidateType || "unknown";
      const localAddress = String(localCandidate?.address || localCandidate?.ip || "?").trim() || "?";
      const remoteAddress = String(remoteCandidate?.address || remoteCandidate?.ip || "?").trim() || "?";
      const route = localType === "relay" || remoteType === "relay" ? "relay" : (localType === "unknown" ? "unknown" : "direct");
      const routeLabel = route === "direct"
        ? `direct(${localType}-${remoteType})`
        : route === "relay"
          ? `relay(${localType}-${remoteType})`
          : `unknown(${localType}-${remoteType})`;
      const timestamp = Number(selectedPair?.timestamp || Date.now());
      const bytesSent = Number(selectedPair?.bytesSent || 0);
      const bytesReceived = Number(selectedPair?.bytesReceived || 0);
      const previous = this.routeSamples.get(clientId);
      let sendBps = 0;
      let recvBps = 0;
      if (previous && Number.isFinite(previous.timestamp) && timestamp > previous.timestamp) {
        const elapsedSeconds = (timestamp - previous.timestamp) / 1000;
        if (elapsedSeconds > 0) {
          sendBps = Math.max(0, Math.round((bytesSent - previous.bytesSent) / elapsedSeconds));
          recvBps = Math.max(0, Math.round((bytesReceived - previous.bytesReceived) / elapsedSeconds));
        }
      }
      this.routeSamples.set(clientId, { timestamp, bytesSent, bytesReceived });
      const selectedPairLabel = `${routeLabel}|${localAddress}|${remoteAddress}`;
      if (selectedPairLabel !== this.lastSelectedPairLog.get(clientId)) {
        this.lastSelectedPairLog.set(clientId, selectedPairLabel);
        this.logInfo("selected-pair", clientId, routeLabel, `local=${localAddress}`, `remote=${remoteAddress}`);
      }
      this.updateClientDiagnostics(clientId, {
        route,
        routeLabel,
        localCandidateType: localType,
        remoteCandidateType: remoteType,
        localCandidateAddress: localAddress,
        remoteCandidateAddress: remoteAddress,
        currentSendBps: sendBps,
        currentRecvBps: recvBps,
        totalBytesSent: bytesSent,
        totalBytesReceived: bytesReceived
      });
      const livePeer = this.peers.get(clientId);
      if (route === "relay") {
        this.maybeScheduleRelayUpgrade(clientId, livePeer);
      } else {
        this.cancelRelayUpgrade(clientId);
      }
    } catch {
    }
  }

  cancelRelayUpgrade(clientId) {
    const timer = this.relayUpgradeTimers.get(clientId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.relayUpgradeTimers.delete(clientId);
  }

  maybeScheduleRelayUpgrade(clientId, peer) {
    if (!peer?.initiator || peer.relayUpgradeAttempted || this.relayUpgradeTimers.has(clientId)) {
      return;
    }
    if (String(peer.pc?.connectionState || "") !== "connected") {
      return;
    }
    if (this.relayUpgradeDelayMs <= 0) {
      return;
    }
    const timer = setTimeout(() => {
      this.relayUpgradeTimers.delete(clientId);
      const livePeer = this.peers.get(clientId);
      if (!livePeer?.pc || !livePeer.initiator || livePeer.relayUpgradeAttempted) {
        return;
      }
      if (String(livePeer.pc.connectionState || "") !== "connected") {
        return;
      }
      if (String(this.diagnostics.clients?.[clientId]?.route || "unknown") !== "relay") {
        return;
      }
      if (this.hasActiveClientTransfer(clientId)) {
        return;
      }
      if ((livePeer.restartAttempts || 0) >= 2) {
        return;
      }
      livePeer.relayUpgradeAttempted = true;
      this.logInfo("relay-upgrade-retry", clientId, `${this.relayUpgradeDelayMs}ms`);
      this.restartIceAndOffer(clientId, livePeer).catch(() => {});
    }, this.relayUpgradeDelayMs);
    this.relayUpgradeTimers.set(clientId, timer);
  }

  startStatsTimer(clientId, pc) {
    this.collectRouteDiagnostics(clientId, pc);
    if (this.statsTimers.has(clientId)) {
      return;
    }
    const timer = setInterval(() => {
      const livePeer = this.peers.get(clientId);
      if (!livePeer) {
        clearInterval(timer);
        this.statsTimers.delete(clientId);
        return;
      }
      this.collectRouteDiagnostics(clientId, livePeer.pc);
    }, 3000);
    this.statsTimers.set(clientId, timer);
  }

  maybeClosePeerAfterChannelStateChange(clientId) {
    const livePeer = this.peers.get(clientId);
    if (!livePeer) {
      return;
    }
    const states = Object.values(livePeer.channels || {}).map((ch) => ch?.readyState || "closed");
    const hasOpenOrConnecting = states.some((state) => state === "open" || state === "connecting");
    if (hasOpenOrConnecting) {
      return;
    }
    const connState = livePeer.pc?.connectionState;
    if (connState === "failed" || connState === "closed") {
      this.closePeer(clientId, true);
    }
  }

  bindPeerEvents(clientId, peer) {
    const pc = peer.pc;
    let disconnectTimer = null;
    let restartTimer = null;
    let delayedCandidates = [];
    let delayedCandidateTimer = null;

    const armRestartTimer = () => {
      if (!peer.initiator || peer.restartAttempts >= 2) {
        return;
      }
      if (restartTimer) {
        clearTimeout(restartTimer);
      }
      restartTimer = setTimeout(() => {
        if (pc.connectionState === "connected" || pc.connectionState === "closed" || pc.connectionState === "failed") {
          return;
        }
        this.restartIceAndOffer(clientId, peer).catch(() => {});
      }, 15000);
    };

    const scheduleDelayedCandidateFlush = () => {
      if (delayedCandidateTimer) {
        clearTimeout(delayedCandidateTimer);
        delayedCandidateTimer = null;
      }
      if (!delayedCandidates.length) {
        return;
      }
      const nextReleaseAt = delayedCandidates.reduce((min, entry) => Math.min(min, entry.releaseAt), delayedCandidates[0].releaseAt);
      delayedCandidateTimer = setTimeout(() => {
        flushDelayedCandidates();
      }, Math.max(0, nextReleaseAt - Date.now()));
    };

    const flushDelayedCandidates = (force = false) => {
      if (delayedCandidateTimer) {
        clearTimeout(delayedCandidateTimer);
        delayedCandidateTimer = null;
      }
      const now = Date.now();
      const pending = force
        ? delayedCandidates
        : delayedCandidates.filter((entry) => entry.releaseAt <= now);
      delayedCandidates = force
        ? []
        : delayedCandidates.filter((entry) => entry.releaseAt > now);
      for (const entry of pending) {
        this.sendSignal(clientId, { kind: "ice", candidate: entry.candidate }).catch(() => {});
      }
      if (delayedCandidates.length) {
        scheduleDelayedCandidateFlush();
      }
    };

    const sendIceCandidate = (candidate) => {
      const candidateType = extractCandidateType(candidate);
      const candidateAddress = extractCandidateAddress(candidate);
      if (candidateType === "host" && (isLoopbackCandidateAddress(candidateAddress) || isLinkLocalCandidateAddress(candidateAddress))) {
        this.logInfo("ice-candidate-skip", clientId, candidateType, candidateAddress || "?");
        return;
      }
      const candidateDelayMs = getCandidateSignalDelayMs(candidateType, this.candidateSignalDelayMs);
      if (candidateDelayMs > 0) {
        delayedCandidates.push({ candidate, releaseAt: Date.now() + candidateDelayMs });
        scheduleDelayedCandidateFlush();
        this.logInfo("ice-candidate-delay", clientId, candidateType, candidateAddress || "?", `${candidateDelayMs}ms`);
        return;
      }
      this.sendSignal(clientId, { kind: "ice", candidate }).catch(() => {});
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        this.logInfo("ice-gathering-complete", clientId);
        flushDelayedCandidates(true);
        return;
      }
      const c = event.candidate;
      this.logInfo("ice-candidate", clientId, c.type, c.protocol, c.address || c.ip || "?", c.port);
      sendIceCandidate(c);
    };

    pc.oniceconnectionstatechange = () => {
      this.logInfo("ice-state", clientId, pc.iceConnectionState);
      this.updateClientDiagnostics(clientId, { iceState: pc.iceConnectionState });
      if (pc.iceConnectionState === "checking") {
        armRestartTimer();
      }
    };

    pc.onconnectionstatechange = () => {
      this.logInfo("conn-state", clientId, pc.connectionState);
      this.updateClientDiagnostics(clientId, { connectionState: pc.connectionState });
      if (pc.connectionState === "connected") {
        if (disconnectTimer) {
          clearTimeout(disconnectTimer);
          disconnectTimer = null;
        }
        if (restartTimer) {
          clearTimeout(restartTimer);
          restartTimer = null;
        }
        return;
      }
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.closePeer(clientId, true);
        return;
      }
      if (pc.connectionState === "disconnected") {
        if (disconnectTimer) {
          clearTimeout(disconnectTimer);
        }
        const busy = this.hasActiveClientTransfer(clientId);
        disconnectTimer = setTimeout(() => {
          const livePeer = this.peers.get(clientId);
          if (livePeer?.pc?.connectionState === "disconnected") {
            this.closePeer(clientId, true);
          }
        }, busy ? 45_000 : 8_000);
        armRestartTimer();
      }
    };

    this.startStatsTimer(clientId, pc);
  }

  async restartIceAndOffer(clientId, peer) {
    if (!peer?.pc || peer.pc.connectionState === "closed" || peer.pc.connectionState === "failed") {
      return;
    }
    peer.restartAttempts = (peer.restartAttempts || 0) + 1;
    this.updateClientDiagnostics(clientId, { lastError: "ICE restart" });
    this.log("ice-restart", clientId, `attempt=${peer.restartAttempts}`);
    const offer = await peer.pc.createOffer({ iceRestart: true });
    await peer.pc.setLocalDescription(offer);
    await this.sendSignal(clientId, { kind: "offer", sdp: peer.pc.localDescription });
  }

  initPeer(clientId, { initiator }) {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: this.iceCandidatePoolSize
    });
    this.logInfo("peer-create", clientId, "iceServers:", this.iceServers.map((s) => s.urls).flat().join(","));
    const channels = {};
    const peer = {
      pc,
      channels,
      ready: Promise.resolve(),
      createdAt: Date.now(),
      initiator: Boolean(initiator),
      restartAttempts: 0,
      relayUpgradeAttempted: false
    };
    this.peers.set(clientId, peer);
    this.updateClientDiagnostics(clientId, { iceState: "connecting" });
    this.markClientActivity(clientId);
    this.bindPeerEvents(clientId, peer);

    if (initiator) {
      for (const name of this.channelNames) {
        channels[name] = pc.createDataChannel(`nas-${name}`);
      }
      for (const [name, channel] of Object.entries(channels)) {
        this.wireChannel(clientId, name, channel);
      }
    } else {
      pc.ondatachannel = (event) => {
        const name = String(event.channel?.label || "").replace(/^nas-/, "") || "control";
        channels[name] = event.channel;
        this.wireChannel(clientId, name, event.channel);
      };
    }

    return peer;
  }

  generateRequestId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  createOperationTimeout(clientId, channelName, requestId, ms) {
    return setTimeout(() => {
      const active = this.currentOp.get(this.opKey(clientId, channelName));
      if (!active || active.requestId !== requestId) {
        return;
      }
      // Only fail this operation. withPeerRetry will close + reconnect as needed.
      // Do NOT call closePeer here — that would cascade-kill sibling ops
      // on other channels with intentionalClose (no retry), causing all operations
      // to fail on any single timeout.
      active.onError?.(new Error("P2P operation timeout"));
    }, ms);
  }

  cancelOperation(clientId, channelName, requestId = "") {
    const opKey = this.opKey(clientId, channelName);
    const op = this.currentOp.get(opKey);
    if (!op) {
      return false;
    }
    if (requestId && op.requestId && op.requestId !== requestId) {
      return false;
    }
    const err = new Error("operation cancelled");
    err.cancelled = true;
    err.intentionalClose = true;
    op.onError?.(err);
    this.currentOp.delete(opKey);
    this.clientQueues.delete(opKey);
    return true;
  }

  enqueueClientTask(clientId, channelName, task) {
    const queueKey = this.opKey(clientId, channelName);
    const previous = this.clientQueues.get(queueKey) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.clientQueues.set(queueKey, next.finally(() => {
      if (this.clientQueues.get(queueKey) === next) {
        this.clientQueues.delete(queueKey);
      }
    }));
    return next;
  }

  enqueueTransferTask(clientId, task) {
    return this.enqueueClientTask(clientId, "transfer", task);
  }

  cancelClientChannel(clientId, channelName) {
    const opKey = this.opKey(clientId, channelName);
    this.cancelOperation(clientId, channelName);
    this.clientQueues.delete(opKey);
  }

  isClientBusy(clientId) {
    const prefix = `${clientId}::`;
    for (const key of this.currentOp.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    for (const key of this.clientQueues.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  startKeepalive(clientId) {
    this.stopKeepalive(clientId);
    this.markClientActivity(clientId);
    this.lastPongTime.set(clientId, Date.now());
    const timer = setInterval(() => {
      const peer = this.peers.get(clientId);
      if (!peer) {
        this.stopKeepalive(clientId);
        return;
      }
      const controlChannel = peer.channels?.control;
      if (controlChannel?.readyState === "open") {
        const lastPong = this.lastPongTime.get(clientId) || 0;
        const pongTimeoutMs = this.hasActiveClientTransfer(clientId) ? 180_000 : 38_000;
        if (Date.now() - lastPong > pongTimeoutMs) {
          this.log("keepalive-pong-timeout", clientId);
          this.closePeer(clientId, true);
          return;
        }
        try {
          controlChannel.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        } catch {
          this.log("keepalive-send-failed", clientId);
          this.closePeer(clientId, true);
        }
      } else {
        const anyOpen = Object.values(peer.channels || {}).some((ch) => ch?.readyState === "open");
        if (!anyOpen) {
          const connState = peer.pc?.connectionState;
          if (connState !== "connecting" && connState !== "new") {
            this.log("keepalive-no-open-channels", clientId);
            this.closePeer(clientId, true);
          }
        }
      }
    }, 15000);
    this.keepaliveTimers.set(clientId, timer);
  }

  stopKeepalive(clientId) {
    const timer = this.keepaliveTimers.get(clientId);
    if (timer) {
      clearInterval(timer);
      this.keepaliveTimers.delete(clientId);
    }
    this.lastPongTime.delete(clientId);
  }

  async connectToPeer(clientId) {
    try {
      await this.getPeer(clientId);
      this.log("pre-connect-ok", clientId);
    } catch (error) {
      this.log("pre-connect-failed", clientId, error?.message || error);
    }
  }

  isPeerConnected(clientId) {
    const peer = this.peers.get(clientId);
    if (!peer?.pc) return false;
    const state = peer.pc.connectionState;
    if (state === "closed" || state === "failed") return false;
    return Object.values(peer.channels || {}).some((ch) => ch?.readyState === "open");
  }

  async withPeerRetry(clientId, task) {
    try {
      const peer = await this.getPeer(clientId);
      return await task(peer);
    } catch (error) {
      if (error.intentionalClose || error.cancelled) {
        throw error;
      }
      const retryable = /timeout|failed|closed|WebSocket|channel|unavailable/i.test(String(error?.message || ""));
      if (!retryable) {
        throw error;
      }
      this.updateClientDiagnostics(clientId, {
        retries: (this.diagnostics.clients[clientId]?.retries || 0) + 1,
        lastError: error?.message || "retry"
      });
      this.log("peer-retry", clientId, error?.message || error);

      const existingPeer = this.peers.get(clientId);
      const hasSiblingTransfers = this.getActiveClientOpCount(clientId) > 1;
      const existingConnState = existingPeer?.pc?.connectionState || "unknown";
      const existingHasOpenChannel = Object.values(existingPeer?.channels || {}).some((ch) => ch?.readyState === "open");
      const canRetryWithoutRebuild = existingPeer
        && existingConnState === "connected"
        && existingHasOpenChannel;

      if (canRetryWithoutRebuild && hasSiblingTransfers) {
        this.log("peer-retry-reuse", clientId, `conn=${existingConnState}`);
        await this.sleep(500);
        const peer = await this.getPeer(clientId);
        return task(peer);
      }

      // Soft-close: sibling ops get a retryable (non-intentionalClose) error so
      // their own withPeerRetry can reconnect independently.  Hard close is only
      // for truly intentional tears (dispose, client-offline).
      this.closePeer(clientId, true);
      await this.sleep(500);
      const peer = await this.getPeer(clientId);
      return task(peer);
    }
  }

  async getPeer(clientId) {
    await this.ensureSocketOpen();

    let peer = this.peers.get(clientId);
    if (peer && peer.pc) {
      const connState = peer.pc.connectionState;
      if (connState !== "closed" && connState !== "failed") {
        const channelStates = Object.entries(peer.channels || {})
          .map(([n, ch]) => `${n}=${ch?.readyState || "?"}`);
        const hasLiveChannel = Object.values(peer.channels || {}).some(
          (ch) => ch && (ch.readyState === "open" || ch.readyState === "connecting")
        );
        if (hasLiveChannel) {
          const ageMs = Date.now() - (peer.createdAt || 0);
          const staleConnectingMs = this.hasActiveClientTransfer(clientId) ? 60_000 : 25_000;
          if (connState === "connecting" && ageMs > staleConnectingMs) {
            this.log("peer-stale-connecting", clientId, `age=${ageMs}ms`, channelStates.join(","));
            this.closePeer(clientId, true);
          } else {
            this.logInfo("peer-cache-hit", clientId, `conn=${connState}`, channelStates.join(","));
            return peer;
          }
        }
        this.log("peer-stale-channels", clientId, connState);
      }
      this.closePeer(clientId);
    }

    const pending = this.pendingPeers.get(clientId);
    if (pending) {
      return pending;
    }

    const connectPromise = this._connectPeer(clientId);
    this.pendingPeers.set(clientId, connectPromise);
    try {
      return await connectPromise;
    } catch (error) {
      this.closePeer(clientId);
      throw error;
    } finally {
      this.pendingPeers.delete(clientId);
    }
  }

  async _connectPeer(clientId) {
    const peer = this.initPeer(clientId, { initiator: true });
    const pc = peer.pc;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.sendSignal(clientId, { kind: "offer", sdp: pc.localDescription });
    this.logInfo("offer-sent", clientId);
    this.log("offer-sent", clientId);

    await this.waitPeerChannelAvailable(peer, 35000);
    this.startKeepalive(clientId);
    this.log("peer-ready", clientId);
    return peer;
  }

  waitPeerChannelAvailable(peer, timeoutMs = 35000) {
    return new Promise((resolve, reject) => {
      const channels = Object.values(peer?.channels || {}).filter(Boolean);
      if (!channels.length) {
        reject(new Error("P2P channels unavailable"));
        return;
      }

      const hasOpen = channels.some((channel) => channel.readyState === "open");
      if (hasOpen) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("P2P channel timeout"));
      }, timeoutMs);

      const listeners = [];
      const cleanup = () => {
        clearTimeout(timer);
        for (const item of listeners) {
          item.channel.removeEventListener(item.event, item.handler);
        }
      };

      const onStateChange = () => {
        const anyOpen = channels.some((channel) => channel.readyState === "open");
        if (anyOpen) {
          cleanup();
          resolve();
          return;
        }
        const anyConnecting = channels.some((channel) => channel.readyState === "connecting");
        if (!anyConnecting) {
          cleanup();
          reject(new Error("P2P all channels failed"));
        }
      };

      for (const channel of channels) {
        const openHandler = () => onStateChange();
        const closeHandler = () => onStateChange();
        const errorHandler = () => onStateChange();
        channel.addEventListener("open", openHandler, { once: true });
        channel.addEventListener("close", closeHandler, { once: true });
        channel.addEventListener("error", errorHandler, { once: true });
        listeners.push(
          { channel, event: "open", handler: openHandler },
          { channel, event: "close", handler: closeHandler },
          { channel, event: "error", handler: errorHandler }
        );
      }
    });
  }

  getChannel(peer, channelName) {
    const channel = peer?.channels?.[channelName];
    if (!channel || channel.readyState !== "open") {
      throw new Error(`P2P channel not ready: ${channelName}`);
    }
    return channel;
  }

  async getPreferredChannel(peer, preferred) {
    const preferredChannel = peer?.channels?.[preferred];
    if (preferredChannel?.readyState === "open") {
      return preferredChannel;
    }

    if (preferredChannel?.readyState === "connecting") {
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("preferred channel wait timeout")), 8000);
          const onOpen = () => { clearTimeout(timer); resolve(); };
          const onError = () => { clearTimeout(timer); reject(new Error("preferred channel failed")); };
          const onClose = () => { clearTimeout(timer); reject(new Error("preferred channel closed")); };
          preferredChannel.addEventListener("open", onOpen, { once: true });
          preferredChannel.addEventListener("error", onError, { once: true });
          preferredChannel.addEventListener("close", onClose, { once: true });
        });
        return preferredChannel;
      } catch {
        this.log("preferred-channel-wait-failed", preferred);
      }
    }

    const pickOpenChannel = () => {
      const preferredCandidate = peer?.channels?.[preferred];
      if (preferredCandidate?.readyState === "open") {
        return preferredCandidate;
      }
      const fileCandidate = peer?.channels?.file;
      if (fileCandidate?.readyState === "open") {
        return fileCandidate;
      }
      for (const channel of Object.values(peer?.channels || {})) {
        if (channel?.readyState === "open") {
          return channel;
        }
      }
      return null;
    };

    const existing = pickOpenChannel();
    if (existing) {
      return existing;
    }

    await this.waitPeerChannelAvailable(peer, 35000);
    const afterWait = pickOpenChannel();
    if (afterWait) {
      return afterWait;
    }

    throw new Error(`No available channel for ${preferred}`);
  }

  waitChannelOpen(channel) {
    return new Promise((resolve, reject) => {
      if (channel.readyState === "open") {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error("P2P channel timeout")), 35000);
      channel.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      channel.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("P2P channel failed"));
      }, { once: true });
    });
  }

  // Returns { channel, opChannelName } ensuring opChannelName always matches
  // the actual channel used, preventing opKey mismatches.
  async getChannelForOp(peer, preferred) {
    let channel = peer?.channels?.[preferred];
    if (channel && channel.readyState === "connecting") {
      this.logInfo("waiting-channel-open", preferred, `state=${channel.readyState}`);
      try { await this.waitChannelOpen(channel); } catch { channel = null; }
    }
    if (channel?.readyState === "open") {
      return { channel, opChannelName: preferred };
    }
    const fallback = await this.getPreferredChannel(peer, preferred);
    const name = Object.entries(peer?.channels || {}).find(([, ch]) => ch === fallback)?.[0] || preferred;
    return { channel: fallback, opChannelName: name };
  }

  wireChannel(clientId, channelName, channel) {
    channel.binaryType = "arraybuffer";
    this.log("channel-wire", clientId, channelName);

    channel.addEventListener("open", () => {
      this.logInfo("channel-open", clientId, channelName);
      this.markClientActivity(clientId);
      this.startKeepalive(clientId);
    });
    channel.addEventListener("close", () => {
      this.logWarn("channel-close", clientId, channelName);
      this.updateClientDiagnostics(clientId, { lastError: `datachannel closed: ${channelName}` });
      this.maybeClosePeerAfterChannelStateChange(clientId);
    });
    channel.addEventListener("error", (ev) => {
      this.logWarn("channel-error", clientId, channelName, ev?.error?.message || "");
      this.updateClientDiagnostics(clientId, { lastError: `datachannel error: ${channelName}` });
      this.maybeClosePeerAfterChannelStateChange(clientId);
    });

    channel.onmessage = (event) => {
      if (typeof event.data !== "string") {
        const op = this.currentOp.get(this.opKey(clientId, channelName));
        if (!op) {
          return;
        }
        const chunkData = event.data;
        if (chunkData instanceof Blob) {
          chunkData.arrayBuffer()
            .then((buffer) => {
              const activeOp = this.currentOp.get(this.opKey(clientId, channelName));
              if (!activeOp) {
                return;
              }
              activeOp.onChunk?.(buffer);
            })
            .catch((error) => {
              const activeOp = this.currentOp.get(this.opKey(clientId, channelName));
              if (!activeOp) {
                return;
              }
              activeOp.onError?.(new Error(`binary decode failed: ${error?.message || "unknown"}`));
            });
          return;
        }
        op.onChunk?.(chunkData);
        return;
      }

      const message = JSON.parse(event.data);
      this.log("channel-message", clientId, channelName, message.type, message.requestId || "-");

      if (message.type === "pong") {
        this.lastPongTime.set(clientId, Date.now());
        return;
      }

      this.markClientActivity(clientId);

      const op = this.currentOp.get(this.opKey(clientId, channelName));
      if (!op) {
        return;
      }
      if (message.requestId && op.requestId && message.requestId !== op.requestId) {
        return;
      }

      if (message.type === "file-meta") op.onMeta?.(message);
      if (message.type === "file-end") op.onEnd?.(message);
      if (message.type === "put-file-ack") op.onAck?.(message);
      if (message.type === "put-file-finish") op.onFinish?.(message);
      if (message.type === "chat-append-result") op.onChatAppendResult?.(message);
      if (message.type === "bot-catalog-result") op.onBotCatalogResult?.(message);
      if (message.type === "bot-job-accepted") op.onBotJobAccepted?.(message);
      if (message.type === "bot-job-result") op.onBotJobResult?.(message);
      if (message.type === "bot-job-cancelled") op.onBotJobCancelled?.(message);
      if (message.type === "put-file-cancelled") {
        const err = new Error("上传已取消");
        err.cancelled = true;
        err.intentionalClose = true;
        op.onError?.(err);
      }
      if (message.type === "delete-file-result") op.onDeleteResult?.(message);
      if (message.type === "rename-file-result") op.onRenameResult?.(message);
      if (message.type === "delete-folder-result") op.onDeleteFolderResult?.(message);
      if (message.type === "rename-folder-result") op.onRenameFolderResult?.(message);
      if (message.type === "create-folder-result") op.onCreateFolderResult?.(message);
      if (message.type === "hls-manifest") op.onHlsManifest?.(message);
      if (message.type === "transcode-status") op.onProgress?.(message);
      if (message.type === "error") {
        this.updateClientDiagnostics(clientId, { lastError: message.message || "unknown error" });
        op.onError?.(new Error(message.message || "unknown error"));
      }
    };
  }

  async handleSignal(clientId, payload) {
    this.log("signal-recv", { from: clientId, kind: payload?.kind });
    let peer = this.peers.get(clientId);
    if (!peer) {
      peer = this.initPeer(clientId, { initiator: false });
    }

    if (payload.kind === "answer") {
      if (peer.pc.signalingState !== "have-local-offer") {
        this.log("signal-answer-ignored", clientId, peer.pc.signalingState);
        return;
      }
      try {
        await peer.pc.setRemoteDescription(payload.sdp);
      } catch (error) {
        const text = String(error?.message || error || "");
        if (/wrong state|stable|set remote answer/i.test(text)) {
          this.log("signal-answer-race-ignored", clientId, peer.pc.signalingState);
          return;
        }
        throw error;
      }
      return;
    }
    if (payload.kind === "offer") {
      await peer.pc.setRemoteDescription(payload.sdp);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      await this.sendSignal(clientId, { kind: "answer", sdp: peer.pc.localDescription });
      return;
    }
    if (payload.kind === "ice") {
      await peer.pc.addIceCandidate(payload.candidate);
    }
  }

  async downloadFile(clientId, relativePath, options = {}) {
    this.markClientActivity(clientId);
    return this.enqueueTransferTask(clientId, async () => this.enqueueClientTask(clientId, "file", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "file");
      const requestId = this.generateRequestId();
      options.onStart?.({ requestId, channelName: opChannelName });
      this.log("op-start", "download", clientId, relativePath, requestId);
      return new Promise((resolve, reject) => {
        let timeout = this.createOperationTimeout(clientId, opChannelName, requestId, FILE_TRANSFER_TIMEOUT_MS);
        const refreshTimeout = () => {
          clearTimeout(timeout);
          timeout = this.createOperationTimeout(clientId, opChannelName, requestId, FILE_TRANSFER_TIMEOUT_MS);
        };
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          chunks: [],
          meta: null,
          transferredBytes: 0,
          onMeta: (message) => {
            ctx.meta = message;
            refreshTimeout();
            options.onMeta?.(message);
            options.onProgress?.({
              transferredBytes: ctx.transferredBytes,
              totalBytes: Number(message?.size || 0),
              progress: Number(message?.size || 0) > 0 ? 0 : null
            });
          },
          onChunk: (chunk) => {
            ctx.chunks.push(chunk);
            ctx.transferredBytes += Number(chunk?.byteLength || chunk?.length || 0);
            const totalBytes = Number(ctx.meta?.size || 0);
            options.onProgress?.({
              transferredBytes: ctx.transferredBytes,
              totalBytes,
              progress: totalBytes > 0 ? Math.max(0, Math.min(100, Math.round((ctx.transferredBytes / totalBytes) * 100))) : null
            });
            refreshTimeout();
          },
          onEnd: () => {
            clearTimeout(timeout);
            const blob = new Blob(ctx.chunks, { type: ctx.meta?.mimeType || "application/octet-stream" });
            this.currentOp.delete(opKey);
            this.log("op-done", "download", clientId, requestId, `chunks=${ctx.chunks.length}`);
            resolve({ blob, meta: ctx.meta });
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            this.log("op-error", "download", clientId, requestId, error?.message || error);
            reject(error);
          }
        };

        this.currentOp.set(opKey, ctx);
        this.logInfo("op-send", "get-file", clientId, opChannelName, `ch=${channel.readyState}`, relativePath);
        channel.send(JSON.stringify(this.buildRequestPayload({ type: "get-file", path: relativePath, requestId }, options)));
      });
    })));
  }

  async downloadFileStream(clientId, relativePath, options = {}) {
    this.markClientActivity(clientId);
    const writable = options.writable;
    if (!writable) {
      throw new Error("writable stream required");
    }

    const writer = typeof writable.getWriter === "function" ? writable.getWriter() : null;
    const writeChunk = async (chunk) => {
      const payload = chunk instanceof ArrayBuffer
        ? new Uint8Array(chunk)
        : ArrayBuffer.isView(chunk)
          ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : chunk;
      if (writer) {
        return writer.write(payload);
      }
      return writable.write(payload);
    };
    const closeWriter = async () => {
      if (writer) {
        return writer.close();
      }
      if (typeof writable.close === "function") {
        return writable.close();
      }
    };
    const abortWriter = async (error) => {
      if (writer?.abort) {
        return writer.abort(error);
      }
      if (typeof writable.abort === "function") {
        return writable.abort(error);
      }
      if (typeof writable.close === "function") {
        return writable.close();
      }
    };

    return this.enqueueTransferTask(clientId, async () => this.enqueueClientTask(clientId, "file", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "file");
      const requestId = this.generateRequestId();
      options.onStart?.({ requestId, channelName: opChannelName });
      this.log("op-start", "download-stream", clientId, relativePath, requestId);
      return new Promise((resolve, reject) => {
        let timeout = this.createOperationTimeout(clientId, opChannelName, requestId, FILE_TRANSFER_TIMEOUT_MS);
        const refreshTimeout = () => {
          clearTimeout(timeout);
          timeout = this.createOperationTimeout(clientId, opChannelName, requestId, FILE_TRANSFER_TIMEOUT_MS);
        };
        const opKey = this.opKey(clientId, opChannelName);
        let pending = Promise.resolve();
        let failed = false;
        const ctx = {
          requestId,
          meta: null,
          transferredBytes: 0,
          onMeta: (message) => {
            ctx.meta = message;
            refreshTimeout();
            options.onMeta?.(message);
            options.onProgress?.({
              transferredBytes: ctx.transferredBytes,
              totalBytes: Number(message?.size || 0),
              progress: Number(message?.size || 0) > 0 ? 0 : null
            });
          },
          onChunk: (chunk) => {
            refreshTimeout();
            ctx.transferredBytes += Number(chunk?.byteLength || chunk?.length || 0);
            const totalBytes = Number(ctx.meta?.size || 0);
            options.onProgress?.({
              transferredBytes: ctx.transferredBytes,
              totalBytes,
              progress: totalBytes > 0 ? Math.max(0, Math.min(100, Math.round((ctx.transferredBytes / totalBytes) * 100))) : null
            });
            pending = pending.then(() => writeChunk(chunk));
            pending.catch((error) => {
              if (failed) {
                return;
              }
              failed = true;
              ctx.onError?.(error);
            });
          },
          onEnd: () => {
            refreshTimeout();
            pending
              .then(() => closeWriter())
              .then(() => {
                clearTimeout(timeout);
                this.currentOp.delete(opKey);
                this.log("op-done", "download-stream", clientId, requestId);
                resolve({ meta: ctx.meta });
              })
              .catch((error) => {
                ctx.onError?.(error);
              });
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            abortWriter(error).catch(() => {});
            this.log("op-error", "download-stream", clientId, requestId, error?.message || error);
            reject(error);
          }
        };

        this.currentOp.set(opKey, ctx);
        this.logInfo("op-send", "get-file", clientId, opChannelName, `ch=${channel.readyState}`, relativePath);
        channel.send(JSON.stringify(this.buildRequestPayload({ type: "get-file", path: relativePath, requestId }, options)));
      });
    })));
  }

  async thumbnailFile(clientId, relativePath, options = {}) {
    this.markClientActivity(clientId);
    return this.enqueueClientTask(clientId, "thumb", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "thumb");
      const requestId = this.generateRequestId();
      this.log("op-start", "thumbnail", clientId, relativePath, requestId);
      return new Promise((resolve, reject) => {
        const timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 45_000);
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          chunks: [],
          meta: null,
          onMeta: (message) => {
            ctx.meta = message;
          },
          onChunk: (chunk) => {
            ctx.chunks.push(chunk);
          },
          onEnd: () => {
            clearTimeout(timeout);
            const blob = new Blob(ctx.chunks, { type: ctx.meta?.mimeType || "image/jpeg" });
            this.currentOp.delete(opKey);
            this.log("op-done", "thumbnail", clientId, requestId, `chunks=${ctx.chunks.length}`);
            resolve({ blob, meta: ctx.meta });
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            this.log("op-error", "thumbnail", clientId, requestId, error?.message || error);
            reject(error);
          }
        };

        this.currentOp.set(opKey, ctx);
        this.logInfo("op-send", "get-thumbnail", clientId, opChannelName, `ch=${channel.readyState}`, relativePath);
        channel.send(JSON.stringify(this.buildRequestPayload({ type: "get-thumbnail", path: relativePath, requestId }, options)));
      });
    }));
  }

  async previewImageCompressed(clientId, relativePath, options = {}) {
    this.markClientActivity(clientId);
    return this.enqueueClientTask(clientId, "preview", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "preview");
      const requestId = this.generateRequestId();
      this.log("op-start", "image-preview", clientId, relativePath, requestId);
      return new Promise((resolve, reject) => {
        const timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 120_000);
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          chunks: [],
          meta: null,
          onMeta: (message) => {
            ctx.meta = message;
          },
          onChunk: (chunk) => {
            ctx.chunks.push(chunk);
          },
          onEnd: () => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            const blob = new Blob(ctx.chunks, { type: ctx.meta?.mimeType || "image/jpeg" });
            this.log("op-done", "image-preview", clientId, requestId, `bytes=${blob.size}`);
            resolve({ blob, meta: ctx.meta });
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            this.log("op-error", "image-preview", clientId, requestId, error?.message || error);
            reject(error);
          }
        };

        this.currentOp.set(opKey, ctx);
        this.logInfo("op-send", "get-image-preview", clientId, opChannelName, `ch=${channel.readyState}`, relativePath);
        channel.send(JSON.stringify(this.buildRequestPayload({ type: "get-image-preview", path: relativePath, requestId }, options)));
      });
    }));
  }

  async getHlsManifest(clientId, relativePath, options = {}) {
    this.markClientActivity(clientId);
    return this.enqueueClientTask(clientId, "preview", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "preview");
      const requestId = this.generateRequestId();
      this.log("op-start", "hls-manifest", clientId, relativePath, requestId, options.profile || "720p");
      return new Promise((resolve, reject) => {
        const timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 480_000);
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          onHlsManifest: (message) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            this.log("op-done", "hls-manifest", clientId, requestId, message.hlsId || "-");
            this.logInfo("hls-manifest-recv", clientId, message.hlsId || "-", `codec=${message.codec || ""}`);
            resolve({
              manifest: String(message.manifest || ""),
              hlsId: String(message.hlsId || ""),
              profile: String(message.profile || options.profile || "720p"),
              codec: String(message.codec || "")
            });
          },
          onProgress: (message) => {
            options.onProgress?.(message);
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            this.log("op-error", "hls-manifest", clientId, requestId, error?.message || error);
            reject(error);
          }
        };
        this.currentOp.set(opKey, ctx);
        this.logInfo("op-send", "get-hls-manifest", clientId, opChannelName, `ch=${channel.readyState}`, relativePath);
        channel.send(JSON.stringify(this.buildRequestPayload({
          type: "get-hls-manifest",
          path: relativePath,
          requestId,
          profile: options.profile || "720p"
        }, options)));
      });
    }));
  }

  async getHlsSegment(clientId, hlsId, segmentName, options = {}) {
    this.markClientActivity(clientId);
    return this.enqueueClientTask(clientId, "preview", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "preview");
      const requestId = this.generateRequestId();
      this.log("op-start", "hls-segment", clientId, `${hlsId}/${segmentName}`, requestId);
      return new Promise((resolve, reject) => {
        const timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 120_000);
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          meta: null,
          chunks: [],
          onMeta: (message) => {
            ctx.meta = message;
          },
          onChunk: (chunk) => {
            ctx.chunks.push(chunk);
          },
          onEnd: () => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            const blob = new Blob(ctx.chunks, { type: ctx.meta?.mimeType || "video/mp2t" });
            this.log("op-done", "hls-segment", clientId, requestId, `bytes=${blob.size}`);
            resolve({ blob, meta: ctx.meta });
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            this.log("op-error", "hls-segment", clientId, requestId, error?.message || error);
            reject(error);
          }
        };
        this.currentOp.set(opKey, ctx);
        this.logInfo("op-send", "get-hls-segment", clientId, opChannelName, `ch=${channel.readyState}`, `${hlsId}/${segmentName}`);
        channel.send(JSON.stringify(this.buildRequestPayload({
          type: "get-hls-segment",
          requestId,
          hlsId,
          segment: segmentName
        }, options)));
      });
    }));
  }

  async streamPreviewFile(clientId, relativePath, onReady, options = {}) {
    this.markClientActivity(clientId);
    return this.enqueueClientTask(clientId, "preview", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "preview");
      const requestId = this.generateRequestId();
      this.log("op-start", "preview", clientId, relativePath, requestId, options?.transcode ? "transcode" : "direct");
      return new Promise((resolve, reject) => {
        const timeoutMs = Number(options.timeoutMs || (options.transcode ? 300_000 : 120_000));
        let timeout = this.createOperationTimeout(clientId, opChannelName, requestId, timeoutMs);
        const refreshTimeout = () => {
          clearTimeout(timeout);
          timeout = this.createOperationTimeout(clientId, opChannelName, requestId, timeoutMs);
        };
        const opKey = this.opKey(clientId, opChannelName);
        const streamCtx = {
          requestId,
          meta: null,
          mediaSource: null,
          objectUrl: null,
          sourceBuffer: null,
          queue: [],
          ended: false,
          fallback: false,
          fallbackChunks: [],
          fallbackBytes: 0,
          fallbackMaxBytes: Number(options.maxFallbackBytes || 0),
          fallbackDisabled: false,
          resolved: false,
          finalized: false,
          finalize: () => {
            if (streamCtx.finalized) {
              return;
            }
            if (streamCtx.fallback && streamCtx.fallbackDisabled) {
              streamCtx.onError?.(new Error("preview fallback disabled due to size"));
              return;
            }
            if (streamCtx.fallback) {
              const blob = new Blob(streamCtx.fallbackChunks, { type: streamCtx.meta?.mimeType || "application/octet-stream" });
              if (streamCtx.ended && blob.size === 0) {
                streamCtx.onError?.(new Error("preview stream ended with empty payload"));
                return;
              }
              const objectUrl = URL.createObjectURL(blob);
              streamCtx.finalized = true;
              this.currentOp.delete(opKey);
              if (!streamCtx.resolved) {
                streamCtx.resolved = true;
                onReady?.({
                  url: objectUrl,
                  meta: streamCtx.meta,
                  release: () => URL.revokeObjectURL(objectUrl)
                });
              }
              clearTimeout(timeout);
              this.log("op-done", "preview", clientId, requestId, "fallback-blob");
              resolve({
                url: objectUrl,
                meta: streamCtx.meta,
                release: () => URL.revokeObjectURL(objectUrl)
              });
              return;
            }

            if (!streamCtx.ended) {
              return;
            }
            if (!streamCtx.sourceBuffer || streamCtx.sourceBuffer.updating || streamCtx.queue.length > 0) {
              return;
            }
            if (streamCtx.mediaSource?.readyState === "open") {
              try {
                streamCtx.mediaSource.endOfStream();
              } catch {
              }
            }

            streamCtx.finalized = true;
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            this.log("op-done", "preview", clientId, requestId, "stream");
            resolve({
              url: streamCtx.objectUrl,
              meta: streamCtx.meta,
              release: () => streamCtx.objectUrl && URL.revokeObjectURL(streamCtx.objectUrl)
            });
          },
          onMeta: (meta) => {
            streamCtx.meta = meta;
            refreshTimeout();
            const mimeType = String(meta?.mimeType || "").toLowerCase();
            const forceBlobByMime = mimeType.includes("quicktime");
            if (options.forceBlob || forceBlobByMime) {
              if (forceBlobByMime) {
                this.log("preview-force-blob", clientId, requestId, mimeType || "unknown");
              }
              streamCtx.fallback = true;
              return;
            }
            if (typeof MediaSource === "undefined") {
              streamCtx.onError?.(new Error("MediaSource unsupported"));
              return;
            }
            try {
              const mediaSource = new MediaSource();
              const objectUrl = URL.createObjectURL(mediaSource);
              streamCtx.mediaSource = mediaSource;
              streamCtx.objectUrl = objectUrl;

              if (!streamCtx.resolved) {
                streamCtx.resolved = true;
                onReady?.({
                  url: objectUrl,
                  meta,
                  release: () => URL.revokeObjectURL(objectUrl)
                });
              }

              mediaSource.addEventListener("sourceopen", () => {
                const candidates = [];
                if (mimeType) {
                  candidates.push(mimeType);
                }
                if (mimeType.startsWith("video/mp4") || mimeType.includes("quicktime") || mimeType.includes("mp4")) {
                  candidates.push('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
                  candidates.push('video/mp4; codecs="avc1.4d401e, mp4a.40.2"');
                  candidates.push("video/mp4");
                }
                if (mimeType.startsWith("audio/mp4") || mimeType.startsWith("audio/")) {
                  candidates.push('audio/mp4; codecs="mp4a.40.2"');
                  candidates.push("audio/mp4");
                }
                if (mimeType.includes("webm")) {
                  candidates.push('video/webm; codecs="vp8, vorbis"');
                  candidates.push("video/webm");
                }
                if (!candidates.length) {
                  candidates.push("video/mp4");
                }

                const uniqCandidates = [...new Set(candidates)];
                let sourceBuffer = null;
                for (const candidate of uniqCandidates) {
                  try {
                    if (typeof MediaSource.isTypeSupported === "function" && !MediaSource.isTypeSupported(candidate)) {
                      continue;
                    }
                    sourceBuffer = mediaSource.addSourceBuffer(candidate);
                    this.log("preview-sourcebuffer", clientId, requestId, candidate);
                    break;
                  } catch {
                  }
                }

                if (!sourceBuffer) {
                  this.log("preview-sourcebuffer-fallback", clientId, requestId, mimeType || "unknown");
                  streamCtx.onError?.(new Error(`SourceBuffer unsupported: ${mimeType || "unknown"}`));
                  return;
                }

                streamCtx.sourceBuffer = sourceBuffer;

                streamCtx.sourceBuffer.addEventListener("updateend", () => {
                  streamCtx.flush();
                  streamCtx.finalize();
                });

                streamCtx.flush();
              });
            } catch (error) {
              streamCtx.onError?.(new Error(`MediaSource init failed: ${error?.message || "unknown"}`));
            }
          },
          onChunk: (chunk) => {
            let normalized;
            if (chunk instanceof ArrayBuffer) {
              normalized = new Uint8Array(chunk);
            } else if (ArrayBuffer.isView(chunk)) {
              normalized = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            } else {
              this.log("preview-chunk-unknown", clientId, requestId, Object.prototype.toString.call(chunk));
              return;
            }
            if (!normalized.byteLength) {
              return;
            }
            refreshTimeout();
            if (!streamCtx.fallbackDisabled) {
              const nextBytes = streamCtx.fallbackBytes + normalized.byteLength;
              if (streamCtx.fallbackMaxBytes && nextBytes > streamCtx.fallbackMaxBytes) {
                streamCtx.fallbackDisabled = true;
                streamCtx.fallbackChunks = [];
              } else {
                streamCtx.fallbackBytes = nextBytes;
                streamCtx.fallbackChunks.push(normalized);
              }
            }
            if (streamCtx.fallback) {
              return;
            }
            streamCtx.queue.push(normalized);
            streamCtx.flush();
          },
          flush: () => {
            if (streamCtx.fallback || !streamCtx.sourceBuffer || streamCtx.sourceBuffer.updating || !streamCtx.queue.length) {
              return;
            }
            if (streamCtx.mediaSource?.readyState !== "open") {
              streamCtx.fallback = true;
              return;
            }
            try {
              streamCtx.sourceBuffer.appendBuffer(streamCtx.queue.shift());
            } catch (error) {
              this.log("preview-append-fallback", clientId, requestId, error?.message || "unknown");
              streamCtx.fallback = true;
            }
          },
          onEnd: () => {
            refreshTimeout();
            streamCtx.ended = true;
            streamCtx.finalize();
          },
          onProgress: (progressMessage) => {
            refreshTimeout();
            options.onProgress?.(progressMessage);
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            this.log("op-error", "preview", clientId, requestId, error?.message || error);
            reject(error);
          }
        };

        this.currentOp.set(opKey, streamCtx);
        this.logInfo("op-send", "get-file-stream", clientId, opChannelName, `ch=${channel.readyState}`, relativePath, options.transcode || "direct");
        channel.send(
          JSON.stringify(this.buildRequestPayload({
            type: "get-file-stream",
            path: relativePath,
            requestId,
            transcode: options.transcode || null,
            previewProfile: options.previewProfile || null
          }, options))
        );
      });
    }));
  }

  async uploadFile(clientId, relativePath, file, options = {}) {
    this.markClientActivity(clientId);
    const uploadKey = `${clientId}::${relativePath}`;
    return this.enqueueTransferTask(clientId, async () => this.enqueueClientTask(clientId, "upload", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "upload");
      const requestId = this.generateRequestId();
      this.log("op-start", "upload", clientId, relativePath, requestId, `size=${file.size}`);

      let aborted = false;
      const abortCtrl = {
        abort: () => { aborted = true; }
      };
      this.activeUploads.set(uploadKey, {
        abort: abortCtrl.abort,
        requestId,
        channelName: opChannelName,
        clientId,
        relativePath
      });

      return new Promise((resolve, reject) => {
        const cleanup = () => {
          this.activeUploads.delete(uploadKey);
        };
        // Phase-1 timeout: waiting for put-file-ack from the remote (30s is generous).
        // Replaced with a fresh 300s timer once ack arrives and data transfer begins.
        let timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 30_000);
        const refreshTimeout = (ms) => {
          clearTimeout(timeout);
          timeout = this.createOperationTimeout(clientId, opChannelName, requestId, ms);
        };
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          onAck: async () => {
            // Reset timer: give full 300s for the actual data transfer phase.
            refreshTimeout(300_000);
            try {
              const chunkSize = 64 * 1024;
              const highWaterMark = 4 * 1024 * 1024;
              const lowWaterMark = 512 * 1024;
              channel.bufferedAmountLowThreshold = lowWaterMark;

              const waitForDrain = async () => {
                if (channel.bufferedAmount <= highWaterMark) {
                  return;
                }
                const startedAt = Date.now();
                while (channel.bufferedAmount > highWaterMark) {
                  if (aborted) {
                    throw new Error("上传已取消");
                  }
                  if (channel.readyState !== "open") {
                    throw new Error("P2P upload channel closed while draining");
                  }
                  if (Date.now() - startedAt > 180000) {
                    throw new Error("P2P upload stalled (buffer not draining)");
                  }
                  await new Promise((resolveDrain) => {
                    let settled = false;
                    const finish = () => {
                      if (settled) {
                        return;
                      }
                      settled = true;
                      channel.removeEventListener("bufferedamountlow", onLow);
                      clearTimeout(pollTimer);
                      resolveDrain();
                    };
                    const onLow = () => finish();
                    const pollTimer = setTimeout(() => finish(), 250);
                    channel.addEventListener("bufferedamountlow", onLow, { once: true });
                  });
                }
              };

              let offset = 0;
              while (offset < file.size) {
                if (aborted) {
                  throw new Error("上传已取消");
                }
                await waitForDrain();
                const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
                channel.send(chunk);
                offset += chunkSize;
                refreshTimeout(300_000);
                options.onProgress?.({
                  transferredBytes: offset,
                  totalBytes: file.size,
                  progress: file.size ? Math.round((offset / file.size) * 100) : 0
                });
              }
              channel.send(JSON.stringify({ type: "put-file-end", requestId }));
            } catch (error) {
              clearTimeout(timeout);
              this.currentOp.delete(opKey);
              cleanup();
              reject(error);
            }
          },
          onFinish: (message) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            cleanup();
            this.log("op-done", "upload", clientId, requestId, `bytes=${message?.bytes || 0}`);
            resolve(message);
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            cleanup();
            this.log("op-error", "upload", clientId, requestId, error?.message || error);
            reject(error);
          }
        };

        this.currentOp.set(opKey, ctx);
        this.logInfo("op-send", "put-file-start", clientId, opChannelName, `ch=${channel.readyState}`, relativePath, `size=${file.size}`);
        channel.send(JSON.stringify({
          type: "put-file-start",
          path: relativePath,
          name: options.uploadName || file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
          requestId
        }));
      });
    })));
  }

  async sendUploadCancel(clientId, requestId, relativePath) {
    try {
      const peer = this.peers.get(clientId);
      if (!peer) {
        return;
      }
      const channel = await this.getPreferredChannel(peer, "upload");
      if (!channel || channel.readyState !== "open") {
        return;
      }
      channel.send(JSON.stringify({ type: "put-file-cancel", requestId, path: relativePath }));
    } catch {
    }
  }

  cancelUpload(clientId, relativePath) {
    const uploadKey = `${clientId}::${relativePath}`;
    const ctrl = this.activeUploads.get(uploadKey);
    if (ctrl) {
      ctrl.abort?.();
      if (ctrl.requestId) {
        this.sendUploadCancel(clientId, ctrl.requestId, relativePath).catch(() => {});
      }
      this.activeUploads.delete(uploadKey);
      this.log("upload-cancelled", clientId, relativePath);
      if (ctrl.channelName) {
        this.cancelClientChannel(clientId, ctrl.channelName);
      }
      return true;
    }
    return false;
  }

  cancelAllUploads(clientId) {
    for (const [key, ctrl] of this.activeUploads.entries()) {
      if (key.startsWith(`${clientId}::`)) {
        ctrl.abort?.();
        if (ctrl.requestId) {
          this.sendUploadCancel(clientId, ctrl.requestId, ctrl.relativePath).catch(() => {});
        }
        this.activeUploads.delete(key);
      }
    }
    this.cancelClientChannel(clientId, "upload");
  }

  async deleteFile(clientId, relativePath) {
    this.markClientActivity(clientId);
    return this.enqueueClientTask(clientId, "control", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "control");
      const requestId = this.generateRequestId();
      this.log("op-start", "delete", clientId, relativePath, requestId);
      return new Promise((resolve, reject) => {
        const timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 60_000);
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          onDeleteResult: (message) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            if (message.ok) {
              this.log("op-done", "delete", clientId, requestId, "ok");
              resolve({ ok: true });
            } else {
              this.log("op-error", "delete", clientId, requestId, message.message || "delete failed");
              reject(new Error(message.message || "delete failed"));
            }
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            this.log("op-error", "delete", clientId, requestId, error?.message || error);
            reject(error);
          }
        };

        this.currentOp.set(opKey, ctx);
        this.logInfo("op-send", "delete-file", clientId, opChannelName, `ch=${channel.readyState}`, relativePath);
        channel.send(JSON.stringify({ type: "delete-file", path: relativePath, requestId }));
      });
    }));
  }

  async renameFile(clientId, relativePath, nextRelativePath) {
    this.markClientActivity(clientId);
    return this.enqueueClientTask(clientId, "control", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "control");
      const requestId = this.generateRequestId();
      this.log("op-start", "rename", clientId, `${relativePath} -> ${nextRelativePath}`, requestId);
      return new Promise((resolve, reject) => {
        const timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 60_000);
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          onRenameResult: (message) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            if (message.ok) {
              this.log("op-done", "rename", clientId, requestId, nextRelativePath);
              resolve({ ok: true, path: message.path || nextRelativePath });
            } else {
              reject(new Error(message.message || "rename failed"));
            }
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            this.log("op-error", "rename", clientId, requestId, error?.message || error);
            reject(error);
          }
        };
        this.currentOp.set(opKey, ctx);
        channel.send(JSON.stringify({ type: "rename-file", path: relativePath, nextPath: nextRelativePath, requestId }));
      });
    }));
  }

  async createFolder(clientId, relativePath) {
    this.markClientActivity(clientId);
    return this.enqueueClientTask(clientId, "control", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "control");
      const requestId = this.generateRequestId();
      this.log("op-start", "create-folder", clientId, relativePath, requestId);
      return new Promise((resolve, reject) => {
        const timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 60_000);
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          onCreateFolderResult: (message) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            if (message.ok) {
              this.log("op-done", "create-folder", clientId, requestId, message.path || relativePath);
              resolve({ ok: true, path: message.path || relativePath });
            } else {
              reject(new Error(message.message || "create folder failed"));
            }
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            this.log("op-error", "create-folder", clientId, requestId, error?.message || error);
            reject(error);
          }
        };
        this.currentOp.set(opKey, ctx);
        channel.send(JSON.stringify({ type: "create-folder", path: relativePath, requestId }));
      });
    }));
  }

  async deleteFolder(clientId, relativePath) {
    this.markClientActivity(clientId);
    return this.enqueueClientTask(clientId, "control", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "control");
      const requestId = this.generateRequestId();
      this.log("op-start", "delete-folder", clientId, relativePath, requestId);
      return new Promise((resolve, reject) => {
        const timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 60_000);
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          onDeleteFolderResult: (message) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            if (message.ok) {
              this.log("op-done", "delete-folder", clientId, requestId, message.path || relativePath);
              resolve({ ok: true, path: message.path || relativePath });
            } else {
              reject(new Error(message.message || "delete folder failed"));
            }
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            this.log("op-error", "delete-folder", clientId, requestId, error?.message || error);
            reject(error);
          }
        };
        this.currentOp.set(opKey, ctx);
        channel.send(JSON.stringify({ type: "delete-folder", path: relativePath, requestId }));
      });
    }));
  }

  async renameFolder(clientId, relativePath, nextRelativePath) {
    this.markClientActivity(clientId);
    return this.enqueueClientTask(clientId, "control", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "control");
      const requestId = this.generateRequestId();
      this.log("op-start", "rename-folder", clientId, `${relativePath} -> ${nextRelativePath}`, requestId);
      return new Promise((resolve, reject) => {
        const timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 60_000);
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          onRenameFolderResult: (message) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            if (message.ok) {
              this.log("op-done", "rename-folder", clientId, requestId, message.path || nextRelativePath);
              resolve({ ok: true, path: message.path || nextRelativePath });
            } else {
              reject(new Error(message.message || "rename folder failed"));
            }
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            this.log("op-error", "rename-folder", clientId, requestId, error?.message || error);
            reject(error);
          }
        };
        this.currentOp.set(opKey, ctx);
        channel.send(JSON.stringify({ type: "rename-folder", path: relativePath, nextPath: nextRelativePath, requestId }));
      });
    }));
  }

  async appendChatMessage(clientId, relativePath, entry) {
    this.markClientActivity(clientId);
    return this.enqueueClientTask(clientId, "control", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "control");
      const requestId = this.generateRequestId();
      this.log("op-start", "chat-append", clientId, relativePath, requestId);
      return new Promise((resolve, reject) => {
        const timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 60_000);
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          onChatAppendResult: (message) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            if (message.ok) {
              this.log("op-done", "chat-append", clientId, requestId, relativePath);
              resolve({ ok: true, path: message.path || relativePath });
            } else {
              reject(new Error(message.message || "chat append failed"));
            }
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            this.log("op-error", "chat-append", clientId, requestId, error?.message || error);
            reject(error);
          }
        };
        this.currentOp.set(opKey, ctx);
        channel.send(JSON.stringify({ type: "append-chat-message", path: relativePath, entry, requestId }));
      });
    }));
  }

  async getBotCatalog(clientId) {
    this.markClientActivity(clientId);
    return this.enqueueClientTask(clientId, "control", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "control");
      const requestId = this.generateRequestId();
      return new Promise((resolve, reject) => {
        const timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 30_000);
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          onBotCatalogResult: (message) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            resolve({ bots: Array.isArray(message.bots) ? message.bots : [] });
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            reject(error);
          }
        };
        this.currentOp.set(opKey, ctx);
        channel.send(JSON.stringify({ type: "get-bot-catalog", requestId }));
      });
    }));
  }

  async invokeBot(clientId, payload = {}) {
    this.markClientActivity(clientId);
    return this.enqueueClientTask(clientId, "control", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "control");
      const requestId = this.generateRequestId();
      return new Promise((resolve, reject) => {
        const timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 60_000);
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          onBotJobAccepted: (message) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            resolve({ job: message.job || null });
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            reject(error);
          }
        };
        this.currentOp.set(opKey, ctx);
        channel.send(JSON.stringify({
          type: "invoke-bot",
          requestId,
          ...payload
        }));
      });
    }));
  }

  async getBotJob(clientId, jobId) {
    this.markClientActivity(clientId);
    return this.enqueueClientTask(clientId, "control", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "control");
      const requestId = this.generateRequestId();
      return new Promise((resolve, reject) => {
        const timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 30_000);
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          onBotJobResult: (message) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            resolve({ job: message.job || null });
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            reject(error);
          }
        };
        this.currentOp.set(opKey, ctx);
        channel.send(JSON.stringify({ type: "get-bot-job", requestId, jobId }));
      });
    }));
  }

  async cancelBotJob(clientId, jobId) {
    this.markClientActivity(clientId);
    return this.enqueueClientTask(clientId, "control", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "control");
      const requestId = this.generateRequestId();
      return new Promise((resolve, reject) => {
        const timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 30_000);
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          onBotJobCancelled: (message) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            resolve({ jobId: message.jobId || jobId, status: message.status || "cancelled" });
          },
          onError: (error) => {
            clearTimeout(timeout);
            this.currentOp.delete(opKey);
            reject(error);
          }
        };
        this.currentOp.set(opKey, ctx);
        channel.send(JSON.stringify({ type: "cancel-bot-job", requestId, jobId }));
      });
    }));
  }
}

export class P2PBridgePool {
  constructor(token, options = {}) {
    this.token = token;
    this.accessToken = options.accessToken || "";
    this.diagnosticsListener = null;
    this.roleSnapshots = Object.fromEntries(PEER_ROLE_ORDER.map((role) => [role, createEmptyDiagnostics()]));
    this.bridges = new Map(
      PEER_ROLE_ORDER.map((role) => {
        const config = PEER_ROLE_CONFIG[role];
        const bridge = new P2PBridge(token, {
          role,
          name: config.name,
          channelNames: config.channelNames,
          accessToken: this.accessToken
        });
        bridge.setDiagnosticsListener((snapshot) => {
          this.roleSnapshots[role] = snapshot;
          this.emitDiagnostics();
        });
        return [role, bridge];
      })
    );
  }

  getBridge(roleOrChannel) {
    return this.bridges.get(resolvePeerRole(roleOrChannel)) || this.bridges.get("control");
  }

  setDiagnosticsListener(listener) {
    this.diagnosticsListener = listener;
    this.emitDiagnostics();
  }

  onServerMessage(listener) {
    return this.getBridge("control").addServerMessageListener(listener);
  }

  emitDiagnostics() {
    if (typeof this.diagnosticsListener !== "function") {
      return;
    }
    this.diagnosticsListener(mergeDiagnosticsSnapshots(this.roleSnapshots));
  }

  connect() {
    for (const bridge of this.bridges.values()) {
      bridge.connect();
    }
  }

  dispose() {
    this.diagnosticsListener = null;
    for (const [role, bridge] of this.bridges.entries()) {
      bridge.setDiagnosticsListener(null);
      bridge.dispose();
      this.roleSnapshots[role] = createEmptyDiagnostics();
    }
  }

  async ensureSocketOpen(role) {
    if (role) {
      return this.getBridge(role).ensureSocketOpen();
    }
    await Promise.all([...this.bridges.values()].map((bridge) => bridge.ensureSocketOpen()));
  }

  isSocketOpen(role) {
    if (role) {
      return this.getBridge(role).isSocketOpen();
    }
    return [...this.bridges.values()].every((bridge) => bridge.isSocketOpen());
  }

  connectToPeer(clientId, role) {
    if (role) {
      return this.getBridge(role).connectToPeer(clientId);
    }
    return Promise.all(PEER_ROLE_ORDER.map((peerRole) => this.getBridge(peerRole).connectToPeer(clientId)));
  }

  closePeer(clientId, soft = false, role) {
    if (role) {
      this.getBridge(role).closePeer(clientId, soft);
      return;
    }
    for (const bridge of this.bridges.values()) {
      bridge.closePeer(clientId, soft);
    }
  }

  isPeerConnected(clientId, role) {
    if (role) {
      return this.getBridge(role).isPeerConnected(clientId);
    }
    return PEER_ROLE_ORDER.every((peerRole) => this.getBridge(peerRole).isPeerConnected(clientId));
  }

  isClientBusy(clientId, role) {
    if (role) {
      return this.getBridge(role).isClientBusy(clientId);
    }
    return [...this.bridges.values()].some((bridge) => bridge.isClientBusy(clientId));
  }

  cancelOperation(clientId, channelName, requestId = "") {
    return this.getBridge(channelName).cancelOperation(clientId, channelName, requestId);
  }

  cancelClientChannel(clientId, channelName) {
    this.getBridge(channelName).cancelClientChannel(clientId, channelName);
  }

  downloadFile(clientId, relativePath, options = {}) {
    return this.getBridge("download").downloadFile(clientId, relativePath, options);
  }

  createFolder(clientId, relativePath) {
    return this.getBridge("control").createFolder(clientId, relativePath);
  }

  deleteFolder(clientId, relativePath) {
    return this.getBridge("control").deleteFolder(clientId, relativePath);
  }

  renameFolder(clientId, relativePath, nextRelativePath) {
    return this.getBridge("control").renameFolder(clientId, relativePath, nextRelativePath);
  }

  downloadFileStream(clientId, relativePath, options = {}) {
    return this.getBridge("download").downloadFileStream(clientId, relativePath, options);
  }

  thumbnailFile(clientId, relativePath, options = {}) {
    return this.getBridge("preview").thumbnailFile(clientId, relativePath, options);
  }

  previewImageCompressed(clientId, relativePath, options = {}) {
    return this.getBridge("preview").previewImageCompressed(clientId, relativePath, options);
  }

  getHlsManifest(clientId, relativePath, options = {}) {
    return this.getBridge("preview").getHlsManifest(clientId, relativePath, options);
  }

  getHlsSegment(clientId, hlsId, segmentName, options = {}) {
    return this.getBridge("preview").getHlsSegment(clientId, hlsId, segmentName, options);
  }

  streamPreviewFile(clientId, relativePath, onReady, options = {}) {
    return this.getBridge("preview").streamPreviewFile(clientId, relativePath, onReady, options);
  }

  uploadFile(clientId, relativePath, file, options = {}) {
    return this.getBridge("upload").uploadFile(clientId, relativePath, file, options);
  }

  cancelUpload(clientId, relativePath) {
    return this.getBridge("upload").cancelUpload(clientId, relativePath);
  }

  cancelAllUploads(clientId) {
    return this.getBridge("upload").cancelAllUploads(clientId);
  }

  deleteFile(clientId, relativePath) {
    return this.getBridge("control").deleteFile(clientId, relativePath);
  }

  renameFile(clientId, relativePath, nextRelativePath) {
    return this.getBridge("control").renameFile(clientId, relativePath, nextRelativePath);
  }

  appendChatMessage(clientId, relativePath, entry) {
    return this.getBridge("control").appendChatMessage(clientId, relativePath, entry);
  }

  getBotCatalog(clientId) {
    return this.getBridge("control").getBotCatalog(clientId);
  }

  invokeBot(clientId, payload = {}) {
    return this.getBridge("control").invokeBot(clientId, payload);
  }

  getBotJob(clientId, jobId) {
    return this.getBridge("control").getBotJob(clientId, jobId);
  }

  cancelBotJob(clientId, jobId) {
    return this.getBridge("control").cancelBotJob(clientId, jobId);
  }

  sendServerMessage(message) {
    return this.getBridge("control").sendServerMessage(message);
  }
}
