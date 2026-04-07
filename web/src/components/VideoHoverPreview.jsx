/**
 * VideoHoverPreview
 * 鼠标悬停超过 1 秒后，在缩略图区域上方叠加一个静音循环的 HLS 预览视频。
 * 用于主页资源浏览器的列表项 / 网格项。
 */
import { useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────────────────
// P2P HLS URL 工具（与 LivingRoomPage / PreviewModal 保持一致）
// ─────────────────────────────────────────────────────────
function buildP2pHlsSegmentUrl(clientId, hlsId, segmentName) {
  return `https://p2p-hls.local/segment/${encodeURIComponent(clientId)}/${encodeURIComponent(hlsId)}/${encodeURIComponent(segmentName)}`;
}

function parseP2pHlsSegmentUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "p2p-hls.local") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] !== "segment" || parts.length < 4) return null;
    return {
      clientId: decodeURIComponent(parts[1]),
      hlsId: decodeURIComponent(parts[2]),
      segmentName: decodeURIComponent(parts.slice(3).join("/"))
    };
  } catch { return null; }
}

function createP2PHlsLoaderClass(p2pInstance) {
  const newStats = () => ({
    aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 }
  });
  return class P2PHlsLoader {
    constructor() { this.aborted = false; this.stats = newStats(); }
    load(context, _config, callbacks) {
      this.stats = newStats();
      this.stats.loading.start = performance.now();
      const self = this;
      (async () => {
        try {
          if (self.aborted) return;
          const parsed = parseP2pHlsSegmentUrl(context.url);
          if (!parsed) {
            const resp = await fetch(context.url);
            if (!resp.ok) throw new Error(`fetch ${resp.status}`);
            const isText = context.type === "manifest" || context.type === "level";
            const data = isText ? await resp.text() : await resp.arrayBuffer();
            const now = performance.now();
            self.stats.loading.first = self.stats.loading.end = now;
            self.stats.loaded = self.stats.total = isText ? data.length : data.byteLength;
            self.stats.chunkCount = 1;
            callbacks.onSuccess({ url: context.url, data }, self.stats, context, null);
            return;
          }
          const response = await p2pInstance.getHlsSegment(
            parsed.clientId, parsed.hlsId, parsed.segmentName, { timeoutMs: 60_000 }
          );
          if (self.aborted) return;
          const data = await response.blob.arrayBuffer();
          const now = performance.now();
          self.stats.loading.first = self.stats.loading.end = now;
          self.stats.loaded = self.stats.total = data.byteLength;
          self.stats.chunkCount = 1;
          callbacks.onSuccess({ url: context.url, data }, self.stats, context, null);
        } catch (error) {
          if (!self.aborted) callbacks.onError({ code: 0, text: error?.message || "load failed" }, context, null, self.stats);
        }
      })();
    }
    abort() { this.aborted = true; }
    destroy() { this.aborted = true; }
  };
}

// ─────────────────────────────────────────────────────────
// VideoHoverPreview component
// ─────────────────────────────────────────────────────────

/**
 * @param {{ file: object, p2p: object, children: React.ReactNode, enabled?: boolean }} props
 * file  - 文件对象 (需有 clientId, path, mimeType)
 * p2p   - P2PBridgePool 实例
 * children - 原始缩略图内容
 * enabled - 是否启用（可用于只对视频文件启用）
 */
export default function VideoHoverPreview({ file, p2p, children, enabled = true, className = "" }) {
  const wrapRef = useRef(null);
  const videoRef = useRef(null);
  const timerRef = useRef(null);
  const hlsRef = useRef(null);
  const activeRef = useRef(false);

  const cleanup = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute("src");
      videoRef.current.load();
      videoRef.current.classList.remove("vhpVideoActive");
    }
    activeRef.current = false;
  }, []);

  const startPreview = useCallback(async () => {
    if (!p2p || !file || !videoRef.current) return;
    let stale = false;
    activeRef.current = true;
    try {
      const { supported } = await (async () => {
        try {
          const mod = await import("hls.js");
          const Hls = mod?.default;
          if (!Hls) return { supported: false };
          if (typeof Hls.isSupported === "function" && Hls.isSupported()) return { supported: true };
          const hasMse = !!(window.MediaSource || window.ManagedMediaSource || window.WebKitMediaSource);
          return { supported: hasMse };
        } catch { return { supported: false }; }
      })();
      if (!supported || stale || !activeRef.current) return;

      const hlsResult = await p2p.getHlsManifest(file.clientId, file.path, { onProgress: () => {} });
      if (stale || !activeRef.current || !videoRef.current) return;

      const mod = await import("hls.js");
      const Hls = mod.default;
      if (!Hls?.isSupported?.() || stale || !activeRef.current) return;

      const rewrittenManifest = String(hlsResult.manifest || "")
        .split(/\r?\n/)
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) return line;
          return buildP2pHlsSegmentUrl(file.clientId, hlsResult.hlsId, trimmed);
        })
        .join("\n");
      const manifestDataUrl = `data:application/vnd.apple.mpegurl;charset=utf-8,${encodeURIComponent(rewrittenManifest)}`;

      const P2PHlsLoaderClass = createP2PHlsLoaderClass(p2p);
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        fLoader: P2PHlsLoaderClass,
        maxBufferLength: 8,
        maxMaxBufferLength: 12,
      });
      hlsRef.current = hls;

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) { hls.destroy(); if (hlsRef.current === hls) hlsRef.current = null; }
      });

      const video = videoRef.current;
      if (!video || stale || !activeRef.current) { hls.destroy(); hlsRef.current = null; return; }

      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => { hls.loadSource(manifestDataUrl); });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (stale || !activeRef.current || !videoRef.current) return;
        const vid = videoRef.current;
        const doPlay = () => {
          if (stale || !activeRef.current || !videoRef.current) return;
          const dur = vid.duration;
          if (isFinite(dur) && dur > 10) vid.currentTime = dur * 0.15;
          vid.play().catch(() => {});
          vid.classList.add("vhpVideoActive");
        };
        if (isFinite(vid.duration) && vid.duration > 0) doPlay();
        else vid.addEventListener("loadedmetadata", doPlay, { once: true });
      });
    } catch (e) {
      stale = true;
    }
  }, [file, p2p]);

  const handleMouseEnter = useCallback(() => {
    if (!enabled || activeRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      startPreview();
    }, 1000);
  }, [enabled, startPreview]);

  const handleMouseLeave = useCallback(() => {
    cleanup();
  }, [cleanup]);

  // 文件变化时清理
  useEffect(() => {
    return () => { cleanup(); };
  }, [file?.clientId, file?.path, cleanup]);

  return (
    <div
      ref={wrapRef}
      className={`vhpWrap${className ? ` ${className}` : ""}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      <video
        ref={videoRef}
        className="vhpVideo"
        muted
        loop
        playsInline
        preload="none"
        aria-hidden="true"
      />
    </div>
  );
}
