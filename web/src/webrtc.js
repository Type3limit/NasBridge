import { toWsUrl } from "./api";

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

export class P2PBridge {
  constructor(token) {
    this.token = token;
    this.socket = null;
    this.socketReady = null;
    this.peers = new Map();
    this.pendingPeers = new Map();
    this.currentOp = new Map();
    this.clientQueues = new Map();
    this.iceServers = buildIceServers();
    this.statsTimers = new Map();
    this.keepaliveTimers = new Map();
    this.lastPongTime = new Map();
    this.activeUploads = new Map();
    this.diagnostics = {
      wsState: "idle",
      wsUrl: "",
      wsLastError: "",
      clients: {}
    };
    this.diagnosticsListener = null;
    this.channelNames = ["file", "thumb", "preview", "upload", "control"];
    this.disposed = false;
    this.debug = import.meta.env.VITE_P2P_DEBUG === "1";
    this.wsReconnectDelay = 2000;
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
      console.log("[web-p2p]", ...args);
    }
  }

  logInfo(...args) {
    console.info("[web-p2p]", ...args);
  }

  logWarn(...args) {
    console.warn("[web-p2p]", ...args);
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
    const socket = new WebSocket(toWsUrl(this.token));
    this.log("ws-connect", toWsUrl(this.token));
    this.socket = socket;
    this.diagnostics.wsState = "connecting";
    this.diagnostics.wsUrl = toWsUrl(this.token);
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
            this.closePeer(message.clientId);
          }
          return;
        }
        if (message.type !== "signal") {
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
      this.updateClientDiagnostics(clientId, { iceState: "closed", route: "unknown" });
      return;
    }

    this.peers.delete(clientId);

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
      const route = localType === "relay" || remoteType === "relay" ? "relay" : (localType === "unknown" ? "unknown" : "direct");
      this.updateClientDiagnostics(clientId, {
        route,
        localCandidateType: localType,
        remoteCandidateType: remoteType
      });
    } catch {
    }
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

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        this.logInfo("ice-gathering-complete", clientId);
        return;
      }
      const c = event.candidate;
      this.logInfo("ice-candidate", clientId, c.type, c.protocol, c.address || c.ip || "?", c.port);
      this.sendSignal(clientId, { kind: "ice", candidate: c }).catch(() => {});
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
        disconnectTimer = setTimeout(() => {
          const livePeer = this.peers.get(clientId);
          if (livePeer?.pc?.connectionState === "disconnected") {
            this.closePeer(clientId, true);
          }
        }, 8000);
        armRestartTimer();
      }
    };

    this.startStatsTimer(clientId, pc);
    armRestartTimer();
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
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.logInfo("peer-create", clientId, "iceServers:", this.iceServers.map((s) => s.urls).flat().join(","));
    const channels = {};
    const peer = {
      pc,
      channels,
      ready: Promise.resolve(),
      createdAt: Date.now(),
      initiator: Boolean(initiator),
      restartAttempts: 0
    };
    this.peers.set(clientId, peer);
    this.updateClientDiagnostics(clientId, { iceState: "connecting" });
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

  cancelClientChannel(clientId, channelName) {
    const opKey = this.opKey(clientId, channelName);
    const op = this.currentOp.get(opKey);
    if (op) {
      const err = new Error("operation cancelled");
      err.cancelled = true;
      err.intentionalClose = true;
      op.onError?.(err);
      this.currentOp.delete(opKey);
    }
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
        if (Date.now() - lastPong > 38000) {
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
          if (connState === "connecting" && ageMs > 25000) {
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
      if (message.type === "put-file-cancelled") {
        const err = new Error("上传已取消");
        err.cancelled = true;
        err.intentionalClose = true;
        op.onError?.(err);
      }
      if (message.type === "delete-file-result") op.onDeleteResult?.(message);
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

  async downloadFile(clientId, relativePath) {
    return this.enqueueClientTask(clientId, "file", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "file");
      const requestId = this.generateRequestId();
      this.log("op-start", "download", clientId, relativePath, requestId);
      return new Promise((resolve, reject) => {
        let timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 120_000);
        const refreshTimeout = () => {
          clearTimeout(timeout);
          timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 120_000);
        };
        const opKey = this.opKey(clientId, opChannelName);
        const ctx = {
          requestId,
          chunks: [],
          meta: null,
          onMeta: (message) => {
            ctx.meta = message;
            refreshTimeout();
          },
          onChunk: (chunk) => {
            ctx.chunks.push(chunk);
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
        channel.send(JSON.stringify({ type: "get-file", path: relativePath, requestId }));
      });
    }));
  }

  async downloadFileStream(clientId, relativePath, options = {}) {
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

    return this.enqueueClientTask(clientId, "file", async () => this.withPeerRetry(clientId, async (peer) => {
      const { channel, opChannelName } = await this.getChannelForOp(peer, "file");
      const requestId = this.generateRequestId();
      this.log("op-start", "download-stream", clientId, relativePath, requestId);
      return new Promise((resolve, reject) => {
        let timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 120_000);
        const refreshTimeout = () => {
          clearTimeout(timeout);
          timeout = this.createOperationTimeout(clientId, opChannelName, requestId, 120_000);
        };
        const opKey = this.opKey(clientId, opChannelName);
        let pending = Promise.resolve();
        let failed = false;
        const ctx = {
          requestId,
          meta: null,
          onMeta: (message) => {
            ctx.meta = message;
            refreshTimeout();
            options.onMeta?.(message);
          },
          onChunk: (chunk) => {
            refreshTimeout();
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
        channel.send(JSON.stringify({ type: "get-file", path: relativePath, requestId }));
      });
    }));
  }

  async thumbnailFile(clientId, relativePath) {
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
        channel.send(JSON.stringify({ type: "get-thumbnail", path: relativePath, requestId }));
      });
    }));
  }

  async previewImageCompressed(clientId, relativePath) {
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
        channel.send(JSON.stringify({ type: "get-image-preview", path: relativePath, requestId }));
      });
    }));
  }

  async getHlsManifest(clientId, relativePath, options = {}) {
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
        channel.send(JSON.stringify({
          type: "get-hls-manifest",
          path: relativePath,
          requestId,
          profile: options.profile || "720p"
        }));
      });
    }));
  }

  async getHlsSegment(clientId, hlsId, segmentName) {
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
        channel.send(JSON.stringify({
          type: "get-hls-segment",
          requestId,
          hlsId,
          segment: segmentName
        }));
      });
    }));
  }

  async streamPreviewFile(clientId, relativePath, onReady, options = {}) {
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
          JSON.stringify({
            type: "get-file-stream",
            path: relativePath,
            requestId,
            transcode: options.transcode || null,
            previewProfile: options.previewProfile || null
          })
        );
      });
    }));
  }

  async uploadFile(clientId, relativePath, file, options = {}) {
    const uploadKey = `${clientId}::${relativePath}`;
    return this.enqueueClientTask(clientId, "upload", async () => this.withPeerRetry(clientId, async (peer) => {
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
          name: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
          requestId
        }));
      });
    }));
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
    this.cancelClientChannel(clientId, "upload");
    return true;
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
}
