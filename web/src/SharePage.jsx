import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Caption1, Spinner, Text, Title3 } from "@fluentui/react-components";
import { ArrowDownloadRegular, ArrowLeftRegular, StreamRegular } from "@fluentui/react-icons";
import { apiRequest } from "./api";
import { P2PBridgePool } from "./webrtc";

const PreviewModal = lazy(() => import("./components/PreviewModal"));

const DESKTOP_STREAM_SAVE_THRESHOLD_BYTES = 512 * 1024 * 1024;
const PREVIEW_FORCE_BLOB_MAX_SIZE = 120 * 1024 * 1024;

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "-";
  return new Date(parsed).toLocaleString();
}

function getShareStatusLabel(status) {
  if (status === "active") return "有效";
  if (status === "expired") return "已过期";
  if (status === "revoked") return "已撤销";
  return "未知";
}

function getShareStatusColor(status) {
  if (status === "active") return "success";
  if (status === "expired") return "warning";
  if (status === "revoked") return "danger";
  return "subtle";
}

function isImageMime(mimeType = "") {
  return mimeType.startsWith("image/");
}

function isVideoMime(mimeType = "") {
  return mimeType.startsWith("video/");
}

function isAudioMime(mimeType = "") {
  return mimeType.startsWith("audio/");
}

function isTextPreviewMime(mimeType = "") {
  const normalized = String(mimeType || "").toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("text/")) {
    return true;
  }
  if (normalized === "application/json" || normalized === "application/xml") {
    return true;
  }
  if (normalized.includes("markdown") || normalized.includes("md")) {
    return true;
  }
  if (normalized.endsWith("+json") || normalized.endsWith("+xml")) {
    return true;
  }
  return false;
}

function isInlinePreviewMime(mimeType = "") {
  return isImageMime(mimeType) || isVideoMime(mimeType) || isAudioMime(mimeType) || isTextPreviewMime(mimeType) || mimeType === "application/pdf";
}

function canBrowserPlayVideoMime(mimeType = "") {
  if (!isVideoMime(mimeType)) {
    return false;
  }
  const video = document.createElement("video");
  const result = video.canPlayType(mimeType);
  return result === "probably" || result === "maybe";
}

function emptyPreviewDebug() {
  return {
    mode: "",
    hlsId: "",
    hlsProfile: "",
    codec: "",
    sourceWidth: 0,
    sourceHeight: 0,
    manifestSegments: 0,
    segmentRequests: 0,
    segmentCompleted: 0,
    segmentErrors: 0,
    segmentBytes: 0,
    lastSegment: "",
    lastError: "",
    hlsState: "idle",
    lastHlsEvent: "",
    bufferedAhead: 0,
    currentTime: 0,
    duration: 0,
    firstFrameAt: ""
  };
}

async function getHlsPlaybackSupport() {
  try {
    const mod = await import("hls.js");
    const Hls = mod?.default;
    if (!Hls) {
      return { supported: false, reason: "hls.js 未正确加载" };
    }
    if (typeof Hls.isSupported === "function" && Hls.isSupported()) {
      return { supported: true, reason: "hls.js supported" };
    }
    const hasMse = typeof window !== "undefined" && !!(window.MediaSource || window.ManagedMediaSource || window.WebKitMediaSource);
    if (hasMse) {
      return { supported: true, reason: "MediaSource 可用，尝试 HLS" };
    }
    return { supported: false, reason: "当前浏览器缺少 MediaSource 支持" };
  } catch (error) {
    return { supported: false, reason: error?.message || "hls.js 动态加载失败" };
  }
}

function supportsAnchorDownload() {
  if (typeof document === "undefined") {
    return false;
  }
  const link = document.createElement("a");
  return "download" in link;
}

function triggerBrowserDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "download";
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 60_000);
}

function isMobileBrowser() {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || "");
}

async function tryShareDownloadedFile(blob, fileName, mimeType = "application/octet-stream") {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
    return false;
  }
  try {
    const file = new File([blob], fileName || "download", { type: blob.type || mimeType });
    if (typeof navigator.canShare === "function" && !navigator.canShare({ files: [file] })) {
      return false;
    }
    await navigator.share({ files: [file], title: file.name });
    return true;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw error;
    }
    return false;
  }
}

export default function SharePage() {
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState("");
  const [viewerToken, setViewerToken] = useState("");
  const [viewerUser, setViewerUser] = useState(null);
  const [file, setFile] = useState(null);
  const [share, setShare] = useState(null);
  const [shareToken, setShareToken] = useState("");
  const [client, setClient] = useState(null);
  const [thumbUrl, setThumbUrl] = useState("");
  const [thumbLoading, setThumbLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewName, setPreviewName] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewMime, setPreviewMime] = useState("");
  const [previewPath, setPreviewPath] = useState("");
  const [previewClientId, setPreviewClientId] = useState("");
  const [previewStatusText, setPreviewStatusText] = useState("");
  const [previewProgress, setPreviewProgress] = useState(null);
  const [previewHlsSource, setPreviewHlsSource] = useState(null);
  const [previewDebug, setPreviewDebug] = useState(emptyPreviewDebug());
  const [previewStage, setPreviewStage] = useState("");
  const [message, setMessage] = useState("");
  const previewReleaseRef = useRef(null);
  const previewSessionIdRef = useRef(0);
  const previewModeRef = useRef("");
  const previewFirstFrameRef = useRef(false);
  const p2p = useMemo(() => {
    if (!shareToken) {
      return null;
    }
    return new P2PBridgePool(shareToken, { accessToken: shareToken });
  }, [shareToken]);

  useEffect(() => {
    return () => {
      p2p?.dispose();
    };
  }, [p2p]);

  useEffect(() => {
    return () => {
      if (thumbUrl) {
        URL.revokeObjectURL(thumbUrl);
      }
    };
  }, [thumbUrl]);

  useEffect(() => {
    let disposed = false;
    const savedToken = typeof window !== "undefined" ? (window.localStorage.getItem("nas_token") || "") : "";
    if (!savedToken) {
      setViewerToken("");
      setViewerUser(null);
      return () => {
        disposed = true;
      };
    }

    apiRequest("/api/me", { token: savedToken })
      .then((me) => {
        if (disposed) {
          return;
        }
        setViewerToken(savedToken);
        setViewerUser(me.profile || null);
      })
      .catch(() => {
        if (disposed) {
          return;
        }
        setViewerToken("");
        setViewerUser(null);
      });

    return () => {
      disposed = true;
    };
  }, []);

  function clearPreview() {
    if (previewReleaseRef.current) {
      previewReleaseRef.current();
      previewReleaseRef.current = null;
    } else if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewUrl("");
    setPreviewMime("");
    setPreviewName("");
    setPreviewPath("");
    setPreviewClientId("");
    setPreviewStatusText("");
    setPreviewProgress(null);
    setPreviewHlsSource(null);
    setPreviewDebug(emptyPreviewDebug());
    setPreviewStage("");
    previewModeRef.current = "";
    previewFirstFrameRef.current = false;
  }

  function stopActivePreviewSession() {
    previewSessionIdRef.current += 1;
    if (p2p && previewClientId) {
      p2p.cancelClientChannel(previewClientId, "preview");
    }
    clearPreview();
    setPreviewOpen(false);
  }

  async function ensureSignalingReady(role) {
    if (!p2p) {
      return false;
    }
    try {
      await p2p.ensureSocketOpen(role);
      return true;
    } catch {
      setMessage("分享预览连接不可用，请稍后重试");
      return false;
    }
  }

  async function previewShared(target, options = {}) {
    if (!p2p || !target?.clientId) return;
    if (!(await ensureSignalingReady("preview"))) return;
    const sessionId = ++previewSessionIdRef.current;
    p2p.cancelClientChannel(target.clientId, "preview");
    const needTranscode = !!options.forceTranscode || (isVideoMime(target.mimeType) && !canBrowserPlayVideoMime(target.mimeType));

    if (!isInlinePreviewMime(target.mimeType)) {
      clearPreview();
      setPreviewName(target.name);
      setPreviewMime(target.mimeType);
      setPreviewPath(target.path);
      setPreviewClientId(target.clientId);
      setPreviewOpen(true);
      setMessage("该文件类型暂不支持在线预览，请使用下载");
      return;
    }

    try {
      setPreviewing(true);
      setPreviewOpen(true);
      setPreviewProgress(null);
      setPreviewStatusText("");
      setPreviewStage("连接终端");
      setMessage("正在获取分享预览...");
      clearPreview();

      const withTimeout = (promise, ms) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("预览超时，请稍后重试")), ms))
      ]);

      const hlsCapability = isVideoMime(target.mimeType) && !options.forceTranscode && !options.skipHls
        ? await getHlsPlaybackSupport()
        : { supported: false, reason: "当前预览流程未启用 HLS" };
      const requestedHlsProfile = String(options.hlsProfile || "max");

      if ((isVideoMime(target.mimeType) || isAudioMime(target.mimeType)) && hlsCapability.supported) {
        try {
          setPreviewStage("准备 HLS");
          setPreviewStatusText("正在准备 HLS 预览...");
          const hlsResult = await withTimeout(
            p2p.getHlsManifest(target.clientId, target.path, {
              profile: requestedHlsProfile,
              accessToken: shareToken,
              onProgress: (status) => {
                if (!status) return;
                setPreviewStatusText(status.message || "正在生成 HLS 预览...");
                if (typeof status.progress === "number") {
                  setPreviewProgress(Math.max(0, Math.min(100, status.progress)));
                }
              }
            }),
            // 内层超时 480s × 2（单次重试）+ 60s 缓冲
            480_000 * 2 + 60_000
          );
          setPreviewName(target.name);
          setPreviewMime("video/mp4");
          setPreviewPath(target.path);
          setPreviewClientId(target.clientId);
          setPreviewHlsSource({
            clientId: target.clientId,
            path: target.path,
            hlsId: hlsResult.hlsId,
            manifest: hlsResult.manifest,
            codec: hlsResult.codec || "",
            profile: hlsResult.profile || requestedHlsProfile,
            availableProfiles: Array.isArray(hlsResult.availableProfiles) ? hlsResult.availableProfiles : [],
            sourceWidth: Number(hlsResult.sourceWidth || 0),
            sourceHeight: Number(hlsResult.sourceHeight || 0),
            accessToken: shareToken
          });
          setPreviewing(false);
          previewModeRef.current = "hls-stream";
          setPreviewDebug((prev) => ({
            ...prev,
            mode: "hls-stream",
            hlsId: hlsResult.hlsId || "",
            hlsProfile: hlsResult.profile || requestedHlsProfile,
            codec: hlsResult.codec || prev.codec || "",
            sourceWidth: Number(hlsResult.sourceWidth || 0),
            sourceHeight: Number(hlsResult.sourceHeight || 0)
          }));
          setPreviewStage(`${hlsResult.profile || requestedHlsProfile} HLS 就绪`);
          setMessage(`分享预览已就绪${hlsResult.profile ? ` (${hlsResult.profile})` : ""}`);
          return;
        } catch {
        }
      }

      const ready = await withTimeout(
        p2p.streamPreviewFile(
          target.clientId,
          target.path,
          ({ url, meta, release }) => {
            if (previewSessionIdRef.current !== sessionId) {
              release?.();
              return;
            }
            previewReleaseRef.current = release || null;
            setPreviewUrl(url);
            setPreviewMime(meta?.mimeType || target.mimeType);
            setPreviewName(target.name);
            setPreviewPath(target.path);
            setPreviewClientId(target.clientId);
            setPreviewing(false);
            setPreviewStage("预览就绪");
          },
          {
            accessToken: shareToken,
            forceBlob: Number(target.size || 0) <= PREVIEW_FORCE_BLOB_MAX_SIZE || isTextPreviewMime(target.mimeType),
            transcode: needTranscode ? "mp4" : null,
            previewProfile: needTranscode ? null : (isVideoMime(target.mimeType) ? "fast" : null),
            maxFallbackBytes: PREVIEW_FORCE_BLOB_MAX_SIZE,
            onProgress: (status) => {
              if (status?.message) {
                setPreviewStatusText(status.message);
              }
              if (typeof status?.progress === "number") {
                setPreviewProgress(Math.max(0, Math.min(100, status.progress)));
              }
            }
          }
        ),
        300000
      );
      if (!ready || previewSessionIdRef.current !== sessionId) {
        return;
      }
      setMessage("分享预览已就绪");
    } catch (error) {
      if (previewSessionIdRef.current !== sessionId) return;
      setPreviewing(false);
      setMessage(`预览失败: ${error.message}`);
      setErrorText(error.message || "预览失败");
    }
  }

  async function switchPreviewHlsProfile(profileId) {
    if (!file || !isVideoMime(file.mimeType) || !profileId) {
      return;
    }
    if (previewHlsSource?.profile === profileId) {
      return;
    }
    await previewShared(file, { hlsProfile: profileId });
  }

  async function downloadShared(target) {
    if (!p2p || !target?.clientId) return;
    if (!(await ensureSignalingReady("download"))) return;
    try {
      const mobileBrowser = isMobileBrowser();
      const preferDesktopDirectSave = !mobileBrowser
        && Number(target.size || 0) >= DESKTOP_STREAM_SAVE_THRESHOLD_BYTES
        && typeof window.showSaveFilePicker === "function"
        && typeof p2p.downloadFileStream === "function";

      if (preferDesktopDirectSave) {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: target.name });
          const writable = await handle.createWritable();
          await p2p.downloadFileStream(target.clientId, target.path, {
            accessToken: shareToken,
            writable
          });
          setMessage("下载完成（已直接写入本地）");
          return;
        } catch (error) {
          if (error?.name === "AbortError") {
            setMessage("已取消保存");
            return;
          }
        }
      }

      const result = await p2p.downloadFile(target.clientId, target.path, { accessToken: shareToken });
      if (mobileBrowser) {
        try {
          const shared = await tryShareDownloadedFile(result.blob, target.name, result.meta?.mimeType || target.mimeType);
          if (shared) {
            setMessage("已打开系统分享/存储面板");
            return;
          }
        } catch (error) {
          if (error?.name === "AbortError") {
            setMessage("已取消保存");
            return;
          }
        }
      }
      if (supportsAnchorDownload()) {
        triggerBrowserDownload(result.blob, target.name);
        setMessage("浏览器下载已开始");
        return;
      }
      throw new Error("当前浏览器不支持下载");
    } catch (error) {
      setMessage(`下载失败: ${error.message}`);
      setErrorText(error.message || "下载失败");
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shareId = params.get("share");
    if (!shareId) {
      setErrorText("缺少分享标识");
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const result = await apiRequest(`/api/share/${encodeURIComponent(shareId)}`, { method: "GET" });
        setFile(result.file || null);
        setShare(result.share || null);
        setShareToken(result.shareToken || "");
        setClient(result.client || null);
      } catch (error) {
        setErrorText(error.message || "分享链接无效或已过期");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!file || !shareToken || !p2p) {
      return;
    }
    previewShared(file).catch(() => {});
  }, [file, shareToken, p2p]);

  useEffect(() => {
    if (!file || !shareToken || !p2p || !(isImageMime(file.mimeType) || isVideoMime(file.mimeType))) {
      return;
    }
    let disposed = false;
    setThumbLoading(true);
    p2p.thumbnailFile(file.clientId, file.path, { accessToken: shareToken })
      .then((result) => {
        if (disposed || !result?.blob) {
          return;
        }
        const objectUrl = URL.createObjectURL(result.blob);
        setThumbUrl((prev) => {
          if (prev) {
            URL.revokeObjectURL(prev);
          }
          return objectUrl;
        });
      })
      .catch(() => {})
      .finally(() => {
        if (!disposed) {
          setThumbLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [file, shareToken, p2p]);

  if (loading) {
    return (
      <div className="page sharePage">
        <div className="shareStandaloneShell">
          <div className="surfaceCard panelCard commandCard shareLoadingCard">
            <Spinner label="正在加载分享文件..." />
          </div>
        </div>
      </div>
    );
  }

  if (errorText || !file) {
    return (
      <div className="page sharePage">
        <div className="shareStandaloneShell">
          <div className="surfaceCard panelCard commandCard shareHeroPanel">
            <Badge appearance="outline" color="danger">分享不可用</Badge>
            <Title3>{errorText || "文件不存在"}</Title3>
            <Text>该分享链接可能已失效、已过期，或目标存储终端当前不可用。</Text>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page sharePage">
      <div className="shareStandaloneShell">
        <div className="surfaceCard panelCard commandCard shareHeroPanel">
          <div className="shareHeroTop">
            <div className="shareHeroCopy">
              <div className="shareHeroIntro">
                <Badge appearance="outline" color="informative">公开分享</Badge>
                <Caption1>{viewerUser ? `已登录为 ${viewerUser.displayName || viewerUser.email || "当前用户"} · 可评论弹幕` : "匿名访问 · 只读权限 · 直接预览"}</Caption1>
              </div>
              <div className="shareHeroHeadline">
                <Title3>{file.name}</Title3>
                <Text>该页面收敛到主工作台同一套卡片层级与排版节奏，无需登录即可预览和下载，不开放上传、编辑、删除等写操作。</Text>
              </div>
              <div className="shareHeroFacts">
                <div className="summaryPill">
                  <Caption1>文件大小</Caption1>
                  <Text>{formatBytes(Number(file.size || 0))}</Text>
                </div>
                <div className="summaryPill">
                  <Caption1>分享状态</Caption1>
                  <Text>{getShareStatusLabel(share?.status)}</Text>
                </div>
                <div className="summaryPill">
                  <Caption1>访问次数</Caption1>
                  <Text>{share?.accessCount || 0}</Text>
                </div>
                <div className="summaryPill">
                  <Caption1>失效时间</Caption1>
                  <Text>{share?.expiresAt ? formatDateTime(share.expiresAt) : "长期有效"}</Text>
                </div>
              </div>
            </div>

            <div className="surfaceCard panelCard sharePreviewPanel">
              <div className="sectionHeaderCompact">
                <div>
                  <Caption1>预览封面</Caption1>
                  <Text>媒体文件会优先显示缩略图。</Text>
                </div>
                <Badge appearance="outline" color={thumbUrl ? "success" : "subtle"}>{thumbUrl ? "已生成" : (thumbLoading ? "处理中" : "无缩略图")}</Badge>
              </div>
              <div className="shareStandalonePreviewCard">
                {thumbUrl ? <img src={thumbUrl} alt={file.name} className="shareStandaloneThumb" /> : null}
                {!thumbUrl && (
                  <div className="shareStandaloneThumbFallback">
                    <Text>{thumbLoading ? "正在生成缩略图" : (isImageMime(file.mimeType) ? "图片" : isVideoMime(file.mimeType) ? "视频" : "文件")}</Text>
                  </div>
                )}
              </div>
              <div className="sharePreviewMeta">
                <Caption1>{client?.name || file.clientId}</Caption1>
                <Text>{file.mimeType || "application/octet-stream"}</Text>
              </div>
            </div>
          </div>

          <div className="shareStandaloneActions">
            <Button appearance="secondary" icon={<ArrowLeftRegular />} onClick={() => window.location.assign("/")}>返回首页</Button>
            {(isVideoMime(file.mimeType) || isAudioMime(file.mimeType)) && (
              <Button
                appearance="primary"
                icon={<StreamRegular />}
                onClick={() => {
                  try {
                    sessionStorage.setItem("lr_share_launch", JSON.stringify({
                      shareToken,
                      file: { id: file.id, clientId: file.clientId, path: file.path, name: file.name, mimeType: file.mimeType, size: file.size },
                      shareHref: window.location.href
                    }));
                  } catch { }
                  window.location.assign("/living-room.html");
                }}
              >
                大屏播放
              </Button>
            )}
            <Button appearance="secondary" onClick={() => previewShared(file)}>重新打开预览</Button>
            <Button appearance="primary" icon={<ArrowDownloadRegular />} onClick={() => downloadShared(file)}>下载文件</Button>
          </div>
        </div>

        <div className="shareWorkspaceGrid">
          <div className="surfaceCard panelCard controlCard shareDetailsPanel">
            <div className="sectionHeaderCompact">
              <div>
                <Caption1>文件与分享信息</Caption1>
                <Text>按主工作台的双列指标卡组织核心元数据。</Text>
              </div>
              <Badge appearance="outline" color={getShareStatusColor(share?.status)}>{getShareStatusLabel(share?.status)}</Badge>
            </div>
            <div className="railMetricList shareMetricGrid">
              <div className="railMetric">
                <Caption1>文件类型</Caption1>
                <Text>{file.mimeType || "application/octet-stream"}</Text>
              </div>
              <div className="railMetric">
                <Caption1>文件路径</Caption1>
                <Text>{file.path}</Text>
              </div>
              <div className="railMetric">
                <Caption1>创建时间</Caption1>
                <Text>{formatDateTime(share?.createdAt)}</Text>
              </div>
              <div className="railMetric">
                <Caption1>分享期限</Caption1>
                <Text>{share?.expiresAt ? formatDateTime(share.expiresAt) : "长期有效"}</Text>
              </div>
            </div>
          </div>

          <div className="surfaceCard panelCard controlCard shareDetailsPanel">
            <div className="sectionHeaderCompact">
              <div>
                <Caption1>来源终端</Caption1>
                <Text>共享文件来自当前在线或最近在线的存储终端。</Text>
              </div>
              <Badge appearance="outline" color={client?.status === "online" ? "success" : "subtle"}>{client?.status || "unknown"}</Badge>
            </div>
            <div className="miniList shareMiniList">
              <div className="miniListRow shareMiniRow">
                <div className="miniListMain">
                  <Text className="miniListTitle">{client?.name || file.clientId}</Text>
                  <Caption1>终端标识：{file.clientId}</Caption1>
                </div>
                <div className="miniListBadges">
                  <Badge appearance="outline" color="informative">只读访问</Badge>
                </div>
              </div>
              <div className="miniListRow shareMiniRow">
                <div className="miniListMain">
                  <Text className="miniListTitle">最近心跳</Text>
                  <Caption1>{formatDateTime(client?.lastHeartbeatAt)}</Caption1>
                </div>
                <div className="miniListBadges">
                  <Badge appearance="outline" color={client?.lastHeartbeatAt ? "success" : "subtle"}>{client?.lastHeartbeatAt ? "可追踪" : "未知"}</Badge>
                </div>
              </div>
            </div>
          </div>
        </div>

        {share?.shareUrl ? (
          <div className="surfaceCard panelCard shareNoticePanel">
            <div className="sectionHeaderCompact">
              <div>
                <Caption1>分享链接</Caption1>
                <Text>该链接可直接打开当前公开落地页。</Text>
              </div>
              <Badge appearance="outline" color="informative">公开访问</Badge>
            </div>
            <div className="drawerSection shareLinkBlock">
              <Text>{share.shareUrl}</Text>
            </div>
          </div>
        ) : null}

        {message ? (
          <div className="surfaceCard panelCard shareNoticePanel">
            <div className="sectionHeaderCompact">
              <div>
                <Caption1>当前状态</Caption1>
                <Text>预览与下载过程中的即时反馈。</Text>
              </div>
              <Badge appearance="outline" color="informative">实时消息</Badge>
            </div>
            <div className="drawerSection shareStatusBlock">
              <Text>{message}</Text>
            </div>
          </div>
        ) : null}
      </div>

      {previewOpen && (
        <Suspense fallback={<div className="overlay"><div className="modalWindow previewModal previewFallbackModal"><Spinner label="正在加载预览模块..." /></div></div>}>
          <PreviewModal
            previewing={previewing}
            previewName={previewName}
            previewMime={previewMime}
            previewPath={previewPath}
            previewClientId={previewClientId}
            previewUrl={previewUrl}
            previewStatusText={previewStatusText}
            previewProgress={previewProgress}
            previewStage={previewStage}
            previewDebug={previewDebug}
            previewHlsSource={previewHlsSource}
            p2p={p2p}
            onSelectHlsProfile={switchPreviewHlsProfile}
            setPreviewHlsSource={setPreviewHlsSource}
            setPreviewDebug={setPreviewDebug}
            setMessage={setMessage}
            setPreviewStatusText={setPreviewStatusText}
            onClose={stopActivePreviewSession}
            onFirstFrame={() => {
              previewFirstFrameRef.current = true;
              setPreviewStatusText("");
              setPreviewDebug((prev) => ({ ...prev, firstFrameAt: prev.firstFrameAt || new Date().toLocaleTimeString() }));
            }}
            onDownload={() => downloadShared(file)}
            onOpenInLivingRoom={() => {
              try {
                sessionStorage.setItem("lr_share_launch", JSON.stringify({
                  shareToken,
                  file: { id: file.id, clientId: file.clientId, path: file.path, name: file.name, mimeType: file.mimeType, size: file.size },
                  shareHref: window.location.href
                }));
              } catch {}
              window.location.assign("/living-room.html");
            }}
            getClientDisplayName={() => client?.name || file.clientId}
            formatBytes={formatBytes}
            formatRelativeTime={formatDateTime}
            isInlinePreviewMime={isInlinePreviewMime}
            authToken={viewerToken}
            currentUser={viewerUser}
            previewFileId={file.id || ""}
            commentsEnabled={Boolean(viewerToken && viewerUser)}
          />
        </Suspense>
      )}
    </div>
  );
}
