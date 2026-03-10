import { useEffect, useRef } from "react";
import { Button, Caption1, Spinner, Subtitle1, Text } from "@fluentui/react-components";

function buildP2pHlsSegmentUrl(clientId, hlsId, segmentName) {
  return `https://p2p-hls.local/segment/${encodeURIComponent(clientId)}/${encodeURIComponent(hlsId)}/${encodeURIComponent(segmentName)}`;
}

function parseP2pHlsSegmentUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "p2p-hls.local") {
      return null;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] !== "segment" || parts.length < 4) {
      return null;
    }
    return {
      clientId: decodeURIComponent(parts[1]),
      hlsId: decodeURIComponent(parts[2]),
      segmentName: decodeURIComponent(parts.slice(3).join("/"))
    };
  } catch {
    return null;
  }
}

function createHlsLoaderStats() {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 }
  };
}

export default function PreviewModal({
  previewing,
  previewName,
  previewMime,
  previewPath,
  previewClientId,
  previewUrl,
  previewStatusText,
  previewProgress,
  previewStage,
  previewDebug,
  previewHlsSource,
  p2p,
  setPreviewHlsSource,
  setPreviewDebug,
  setMessage,
  setPreviewStatusText,
  onClose,
  onFirstFrame,
  onDownload,
  getClientDisplayName,
  formatBytes,
  isInlinePreviewMime
}) {
  const previewVideoRef = useRef(null);
  const previewHlsRef = useRef(null);
  const hlsReadyRef = useRef(false);

  useEffect(() => {
    return () => {
      hlsReadyRef.current = false;
      if (previewHlsRef.current) {
        previewHlsRef.current.destroy();
        previewHlsRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (previewing || !previewHlsSource || !p2p) {
      return;
    }

    let disposed = false;
    const video = previewVideoRef.current;
    if (!video) {
      return;
    }

    async function attachHls() {
      try {
        hlsReadyRef.current = false;
        const mod = await import("hls.js");
        const Hls = mod.default;
        if (disposed) {
          return;
        }
        const hasMse = typeof window !== "undefined" && !!(window.MediaSource || window.ManagedMediaSource || window.WebKitMediaSource);
        if (!Hls || (!Hls.isSupported?.() && !hasMse)) {
          setMessage("当前浏览器环境无法附加 HLS，已回退普通预览", "warning");
          setPreviewHlsSource(null);
          return;
        }

        if (previewHlsRef.current) {
          previewHlsRef.current.destroy();
          previewHlsRef.current = null;
        }

        const sourceSnapshot = previewHlsSource;
        const rewrittenManifest = String(sourceSnapshot.manifest || "")
          .split(/\r?\n/)
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) {
              return line;
            }
            return buildP2pHlsSegmentUrl(sourceSnapshot.clientId, sourceSnapshot.hlsId, trimmed);
          })
          .join("\n");
        const manifestDataUrl = `data:application/vnd.apple.mpegurl;charset=utf-8,${encodeURIComponent(rewrittenManifest)}`;
        const manifestSegments = String(sourceSnapshot.manifest || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"))
          .length;

        setPreviewDebug((prev) => ({
          ...prev,
          mode: "hls-stream",
          hlsId: sourceSnapshot.hlsId || "",
          codec: sourceSnapshot.codec || prev.codec || "",
          manifestSegments,
          segmentRequests: 0,
          segmentCompleted: 0,
          segmentErrors: 0,
          segmentBytes: 0,
          lastSegment: "",
          lastError: "",
          hlsState: "initializing",
          lastHlsEvent: "init"
        }));

        class P2PHlsLoader {
          constructor() {
            this.aborted = false;
            this.context = null;
            this.stats = createHlsLoaderStats();
          }

          load(context, _config, callbacks) {
            this.context = context;
            this.stats = createHlsLoaderStats();
            const stats = this.stats;
            stats.loading.start = performance.now();

            (async () => {
              try {
                if (this.aborted || disposed) {
                  return;
                }

                setPreviewDebug((prev) => ({
                  ...prev,
                  lastHlsEvent: `loader:${context.type || "unknown"}`,
                  hlsState: "loading"
                }));

                const parsed = parseP2pHlsSegmentUrl(context.url);
                if (!parsed && typeof context.url === "string" && (/^https?:\/\//i.test(context.url) || /^data:/i.test(context.url))) {
                  const response = await fetch(context.url);
                  if (!response.ok) {
                    throw new Error(`http fallback load failed: ${response.status}`);
                  }
                  const isText = context.type === "manifest" || context.type === "level" || context.type === "audioTrack";
                  const data = isText ? await response.text() : await response.arrayBuffer();
                  const now = performance.now();
                  stats.loading.first = now;
                  stats.loading.end = now;
                  stats.loaded = isText ? data.length : data.byteLength;
                  stats.total = stats.loaded;
                  stats.chunkCount = Math.max(1, stats.chunkCount);
                  setPreviewDebug((prev) => ({
                    ...prev,
                    lastError: "",
                    hlsState: /^data:/i.test(context.url) ? "manifest-data-loaded" : "loaded-fallback",
                    lastHlsEvent: /^data:/i.test(context.url) ? "MANIFEST_DATA_URL" : prev.lastHlsEvent
                  }));
                  callbacks.onSuccess({ url: context.url, data }, stats, context, null);
                  return;
                }

                if (!parsed) {
                  throw new Error(`invalid hls url (${context.type || "unknown"}): ${context.url}`);
                }

                setPreviewDebug((prev) => ({
                  ...prev,
                  segmentRequests: prev.segmentRequests + 1,
                  lastSegment: parsed.segmentName,
                  hlsState: "segment-loading"
                }));

                const response = await p2p.getHlsSegment(parsed.clientId, parsed.hlsId, parsed.segmentName);
                const data = await response.blob.arrayBuffer();
                const now = performance.now();
                stats.loading.first = stats.loading.first || now;
                stats.loading.end = now;
                stats.loaded = data.byteLength;
                stats.total = data.byteLength;
                stats.chunkCount = Math.max(1, stats.chunkCount + 1);
                setPreviewDebug((prev) => ({
                  ...prev,
                  segmentCompleted: prev.segmentCompleted + 1,
                  segmentBytes: prev.segmentBytes + data.byteLength,
                  lastSegment: parsed.segmentName,
                  lastError: "",
                  hlsState: "segment-loaded"
                }));
                callbacks.onSuccess({ url: context.url, data }, stats, context, null);
              } catch (error) {
                const errorText = error?.message || "hls load failed";
                stats.loading.end = performance.now();
                setPreviewDebug((prev) => ({
                  ...prev,
                  segmentErrors: prev.segmentErrors + 1,
                  lastError: errorText,
                  hlsState: "error"
                }));
                callbacks.onError({ code: 0, text: errorText }, context, null, stats);
              }
            })();
          }

          abort() {
            this.aborted = true;
            if (this.stats) {
              this.stats.aborted = true;
              this.stats.loading.end = performance.now();
            }
          }

          destroy() {
            this.aborted = true;
          }
        }

        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          fLoader: P2PHlsLoader
        });
        previewHlsRef.current = hls;

        const markHlsReady = () => {
          if (hlsReadyRef.current) {
            return;
          }
          hlsReadyRef.current = true;
          onFirstFrame?.();
        };

        hls.on(Hls.Events.MANIFEST_LOADING, () => {
          setPreviewDebug((prev) => ({ ...prev, hlsState: "manifest-loading", lastHlsEvent: "MANIFEST_LOADING" }));
        });
        hls.on(Hls.Events.MANIFEST_LOADED, () => {
          setPreviewDebug((prev) => ({ ...prev, hlsState: "manifest-loaded", lastHlsEvent: "MANIFEST_LOADED" }));
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setPreviewDebug((prev) => ({ ...prev, hlsState: "manifest-parsed", lastHlsEvent: "MANIFEST_PARSED" }));
          video.play().catch(() => {});
        });
        hls.on(Hls.Events.FRAG_LOADING, (_event, data) => {
          setPreviewDebug((prev) => ({
            ...prev,
            hlsState: "frag-loading",
            lastHlsEvent: `FRAG_LOADING ${data?.frag?.sn ?? "-"}`
          }));
        });
        hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
          setPreviewDebug((prev) => ({
            ...prev,
            hlsState: "frag-loaded",
            lastHlsEvent: `FRAG_LOADED ${data?.frag?.sn ?? "-"}`
          }));
        });
        hls.on(Hls.Events.BUFFER_APPENDED, () => {
          setPreviewDebug((prev) => ({ ...prev, hlsState: "buffer-appended", lastHlsEvent: "BUFFER_APPENDED" }));
          if ((video.readyState || 0) >= 2) {
            markHlsReady();
          }
        });
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          setPreviewDebug((prev) => ({ ...prev, hlsState: "frag-buffered", lastHlsEvent: "FRAG_BUFFERED" }));
          markHlsReady();
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          const detailText = [
            data?.details || data?.type || "unknown",
            data?.reason || "",
            data?.error?.message || ""
          ].filter(Boolean).join(" | ");
          if (!data?.fatal) {
            setPreviewDebug((prev) => ({
              ...prev,
              lastHlsEvent: `ERROR:${detailText || "non-fatal"}`
            }));
            return;
          }
          setPreviewDebug((prev) => ({
            ...prev,
            lastError: `hls-fatal:${detailText || "unknown"}`,
            segmentErrors: prev.segmentErrors + 1,
            hlsState: "fatal-error",
            lastHlsEvent: `FATAL:${detailText || "unknown"}`
          }));
          setMessage(`HLS预览失败: ${detailText || "unknown"}`);
          setPreviewHlsSource(null);
          hls.destroy();
          if (previewHlsRef.current === hls) {
            previewHlsRef.current = null;
          }
        });

        hls.attachMedia(video);
        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
          setPreviewDebug((prev) => ({ ...prev, hlsState: "media-attached", lastHlsEvent: "MEDIA_ATTACHED" }));
          hls.loadSource(manifestDataUrl);
        });
      } catch (error) {
        setPreviewDebug((prev) => ({
          ...prev,
          lastError: error?.message || "hls-init-failed",
          hlsState: "error"
        }));
        setMessage(`HLS 初始化失败，已回退普通预览: ${error?.message || "unknown"}`, "warning");
        setPreviewHlsSource(null);
      }
    }

    attachHls();

    return () => {
      disposed = true;
      hlsReadyRef.current = false;
      if (previewHlsRef.current) {
        previewHlsRef.current.destroy();
        previewHlsRef.current = null;
      }
    };
  }, [previewing, previewHlsSource, p2p, setPreviewDebug, setPreviewHlsSource]);

  useEffect(() => {
    if (previewing || !previewMime.startsWith("video/")) {
      return;
    }
    const video = previewVideoRef.current;
    if (!video) {
      return;
    }

    const timer = setInterval(() => {
      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      let bufferedEnd = currentTime;
      try {
        for (let idx = 0; idx < video.buffered.length; idx += 1) {
          const start = video.buffered.start(idx);
          const end = video.buffered.end(idx);
          if (currentTime >= start && currentTime <= end) {
            bufferedEnd = end;
            break;
          }
          if (end > bufferedEnd) {
            bufferedEnd = end;
          }
        }
      } catch {
      }
      setPreviewDebug((prev) => ({
        ...prev,
        currentTime,
        duration,
        bufferedAhead: Math.max(0, bufferedEnd - currentTime)
      }));
    }, 500);

    return () => clearInterval(timer);
  }, [previewMime, previewing, setPreviewDebug]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modalWindow previewModal" onClick={(event) => event.stopPropagation()}>
        <div className="previewTopBar">
          <div>
            <Subtitle1>{previewName || "文件"}</Subtitle1>
            <Caption1>{previewMime || "未知类型"}</Caption1>
          </div>
          <div className="row">
            <Button size="small" onClick={onDownload}>下载</Button>
            <Button size="small" onClick={onClose}>关闭</Button>
          </div>
        </div>
        <div className="previewBody">
          <div className="playerSurface">
            {previewing && <Spinner label={previewStatusText || "正在加载预览..."} />}
            {previewing && previewStatusText ? (
              <Caption1>
                {previewStatusText}
                {typeof previewProgress === "number" ? ` (${previewProgress}%)` : ""}
              </Caption1>
            ) : null}
            {previewing && previewStage ? <Caption1 className="previewStage">阶段：{previewStage}</Caption1> : null}
            {!previewing && previewMime.startsWith("video/") && (
              <video
                ref={previewVideoRef}
                src={previewHlsSource ? undefined : previewUrl}
                controls
                className="preview"
                onLoadedData={onFirstFrame}
                onPlaying={onFirstFrame}
              />
            )}
            {!previewing && previewMime.startsWith("audio/") && <audio src={previewUrl} controls className="previewAudio" />}
            {!previewing && previewMime.startsWith("image/") && <img src={previewUrl} className="preview" />}
            {!previewing && previewMime === "application/pdf" && <iframe src={previewUrl} className="previewFrame" title="preview-frame" />}
          </div>
          {!previewing && previewMime.startsWith("video/") && (
            <aside className="previewSidePanel">
              <div className="previewDebugPanel compact">
                <div className="debugHighlightGrid">
                  <div className="debugHighlightCard">
                    <Caption1>播放模式</Caption1>
                    <Text>{previewDebug.mode || "-"}</Text>
                  </div>
                  <div className="debugHighlightCard">
                    <Caption1>连接状态</Caption1>
                    <Text>{previewDebug.hlsState || "-"}</Text>
                  </div>
                  <div className="debugHighlightCard">
                    <Caption1>缓冲前瞻</Caption1>
                    <Text>{previewDebug.bufferedAhead.toFixed(1)}s</Text>
                  </div>
                  <div className="debugHighlightCard">
                    <Caption1>错误次数</Caption1>
                    <Text>{previewDebug.segmentErrors}</Text>
                  </div>
                </div>
                <div className="previewDebugRow emphasis">
                  <Caption1>分片 {previewDebug.segmentCompleted}/{Math.max(previewDebug.manifestSegments, previewDebug.segmentRequests)}</Caption1>
                  <Caption1>流量 {formatBytes(previewDebug.segmentBytes || 0)}</Caption1>
                </div>
                <div className="previewDebugRow emphasis">
                  <Caption1>首帧 {previewDebug.firstFrameAt || "-"}</Caption1>
                  <Caption1>播放 {previewDebug.currentTime.toFixed(1)}s / {previewDebug.duration > 0 ? previewDebug.duration.toFixed(1) : "-"}s</Caption1>
                </div>
                {previewDebug.lastError ? (
                  <div className="debugNotice danger">
                    <Caption1>最近错误</Caption1>
                    <Text>{previewDebug.lastError}</Text>
                  </div>
                ) : null}
                <div className="debugNotice">
                  <Caption1>最近事件</Caption1>
                  <Text>{previewDebug.lastHlsEvent || previewDebug.lastSegment || "-"}</Text>
                </div>
              </div>
            </aside>
          )}
        </div>
        <div className="previewMetaBar">
          <Caption1>终端：{getClientDisplayName(previewClientId || "") || "-"}</Caption1>
          <Caption1 title={previewPath}>{previewPath || "-"}</Caption1>
        </div>
        {!previewing && previewName && !isInlinePreviewMime(previewMime) && (
          <div className="unsupportedPreview">
            <Text>当前文件类型不支持在线预览，请直接下载。</Text>
            <Button appearance="primary" size="small" onClick={onDownload}>下载</Button>
          </div>
        )}
      </div>
    </div>
  );
}