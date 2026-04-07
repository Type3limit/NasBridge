import { Caption1, Text } from "@fluentui/react-components";
import { ArrowDownRegular, ArrowUpRegular, EyeRegular, PauseRegular, PlayRegular } from "@fluentui/react-icons";

function formatVideoClock(timeSec = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(timeSec || 0)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${minutes}:${seconds}`;
  }
  return `${minutes}:${seconds}`;
}

export default function VideoPlayerControls({
  currentTime = 0,
  duration = 0,
  bufferedTime = 0,
  playing = false,
  pictureInPictureActive = false,
  pageFillActive = false,
  fullscreenActive = false,
  canUsePictureInPicture = false,
  onTogglePlay,
  onSeek,
  onTogglePictureInPicture,
  onTogglePageFill,
  onToggleFullscreen,
  showPictureInPictureButton = true,
  showPageFillButton = true,
  showFullscreenButton = true,
  showTime = true,
  showTransportActions = true,
  children = null,
  extraClassName = ""
}) {
  const safeDuration = Math.max(0, Number(duration || 0));
  const safeCurrentTime = Math.max(0, Math.min(Number(currentTime || 0), safeDuration || Number(currentTime || 0)));
  const playedPercent = safeDuration > 0 ? Math.min(100, (safeCurrentTime / safeDuration) * 100) : 0;
  const bufferedPercent = safeDuration > 0 ? Math.min(100, (Math.max(safeCurrentTime, Number(bufferedTime || 0)) / safeDuration) * 100) : 0;
  const rootClassName = `previewDanmakuPanel previewPlayerBar${extraClassName ? ` ${extraClassName}` : ""}`;

  return (
    <div className={rootClassName}>
      <div className="previewTransportBar">
        <button
          type="button"
          className="iconActionButton previewControlButton"
          onClick={onTogglePlay}
          aria-label={playing ? "暂停" : "播放"}
          title={playing ? "暂停" : "播放"}
        >
          {playing ? <PauseRegular /> : <PlayRegular />}
        </button>
        {showTime ? (
          <div className="previewDanmakuMeta playback previewTransportMeta">
            <span className="previewPlaybackTime current">{formatVideoClock(safeCurrentTime)}</span>
            <span className="previewPlaybackSeparator">/</span>
            <span className="previewPlaybackTime total">{formatVideoClock(safeDuration)}</span>
          </div>
        ) : null}
        <div className="previewTimelineBlock">
          <input
            className="previewTimelineRange"
            type="range"
            min="0"
            max={safeDuration > 0 ? safeDuration : 1}
            step="0.1"
            value={safeDuration > 0 ? safeCurrentTime : 0}
            onChange={(event) => onSeek?.(Number(event.target.value))}
            aria-label="视频进度"
            style={{
              background: `linear-gradient(90deg, rgba(251, 191, 36, 0.96) 0%, rgba(251, 191, 36, 0.96) ${playedPercent}%, #FBF4B8AA ${playedPercent}%, #FBF4B8AA ${bufferedPercent}%, rgba(100, 116, 139, 0.48) ${bufferedPercent}%, rgba(100, 116, 139, 0.48) 100%)`
            }}
          />
        </div>
        {showTransportActions ? (
          <div className="previewTransportActions">
            {showPictureInPictureButton ? (
              <button
                type="button"
                className={`iconActionButton previewControlButton${pictureInPictureActive ? " active" : ""}`}
                onClick={() => onTogglePictureInPicture?.()}
                disabled={!canUsePictureInPicture}
                aria-label={pictureInPictureActive ? "退出画中画" : "画中画"}
                title={pictureInPictureActive ? "退出画中画" : "画中画"}
              >
                <span className="previewControlGlyph" aria-hidden="true">
                  {pictureInPictureActive
                    ? /* 退出画中画 */ <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><rect x="12" y="12" width="8" height="6" rx="1" fill="currentColor" stroke="none"/><line x1="9" y1="9" x2="4" y2="4"/><polyline points="4 8 4 4 8 4"/></svg>
                    : /* 开启画中画 */ <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><rect x="12" y="12" width="8" height="6" rx="1" fill="currentColor" stroke="none"/></svg>
                  }
                </span>
              </button>
            ) : null}
            {showPageFillButton ? (
              <button
                type="button"
                className={`iconActionButton previewControlButton${pageFillActive ? " active" : ""}`}
                onClick={() => onTogglePageFill?.()}
                aria-label={pageFillActive ? "退出页面铺满" : "页面铺满"}
                title={pageFillActive ? "退出页面铺满" : "页面铺满"}
              >
                <span className="previewControlGlyph text" aria-hidden="true">页</span>
              </button>
            ) : null}
            {showFullscreenButton ? (
              <button
                type="button"
                className={`iconActionButton previewControlButton${fullscreenActive ? " active" : ""}`}
                onClick={() => onToggleFullscreen?.()}
                aria-label={fullscreenActive ? "退出全屏" : "全屏"}
                title={fullscreenActive ? "退出全屏" : "全屏"}
              >
                <span className="previewControlGlyph" aria-hidden="true">⛶</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {children ? <div className="previewPlayerExtra">{children}</div> : null}
    </div>
  );
}

export function VideoDanmakuComposer({
  danmakuVisible = true,
  danmakuItemsCount = 0,
  danmakuMode = "scroll",
  onDanmakuModeChange,
  onToggleDanmakuVisible,
  draft = "",
  onDraftChange,
  onDraftKeyDown,
  danmakuSettingsOpen = false,
  onToggleDanmakuSettings,
  danmakuColor = "#FFFFFF",
  onDanmakuColorChange,
  danmakuBackgroundOpacity = 0.12,
  onDanmakuBackgroundOpacityChange,
  danmakuTextOpacity = 1,
  onDanmakuTextOpacityChange,
  danmakuFontScale = 1,
  onDanmakuFontScaleChange,
  onSubmit,
  inputNode,
  sendDisabled = false
}) {
  return (
    <div className="previewDanmakuComposer previewDanmakuComposerBili">
      <div className="previewDanmakuStatusBlock">
        <Text>{danmakuVisible ? "弹幕已开启" : "弹幕已关闭"}</Text>
        <Caption1>已装填 {danmakuItemsCount} 条弹幕</Caption1>
      </div>
      <div className="previewDanmakuModeGroup" role="group" aria-label="弹幕模式">
        <button type="button" className={`previewModeChip iconOnly${danmakuMode === "scroll" ? " active" : ""}`} onClick={() => onDanmakuModeChange?.("scroll")} aria-label="滚动弹幕" title="滚动弹幕">
          <span className="previewModeGlyph" aria-hidden="true">↔</span>
        </button>
        <button type="button" className={`previewModeChip iconOnly${danmakuMode === "top" ? " active" : ""}`} onClick={() => onDanmakuModeChange?.("top")} aria-label="顶部弹幕" title="顶部弹幕">
          <ArrowUpRegular />
        </button>
        <button type="button" className={`previewModeChip iconOnly${danmakuMode === "bottom" ? " active" : ""}`} onClick={() => onDanmakuModeChange?.("bottom")} aria-label="底部弹幕" title="底部弹幕">
          <ArrowDownRegular />
        </button>
      </div>
      <button
        type="button"
        className={`iconActionButton previewControlButton${danmakuVisible ? " active" : ""}`}
        onClick={() => onToggleDanmakuVisible?.()}
        aria-label={danmakuVisible ? "隐藏弹幕" : "显示弹幕"}
        title={danmakuVisible ? "隐藏弹幕" : "显示弹幕"}
      >
        <EyeRegular />
      </button>
      {inputNode}
      <div className="previewDanmakuSettingsWrap">
        <button
          type="button"
          className={`previewDanmakuEtiquetteButton${danmakuSettingsOpen ? " active" : ""}`}
          onClick={() => onToggleDanmakuSettings?.()}
          aria-label="弹幕设置"
          title="弹幕设置"
        >
          弹幕设置
        </button>
        {danmakuSettingsOpen ? (
          <div className="previewDanmakuSettingsPopup" role="dialog" aria-label="弹幕设置">
            <label className="previewDanmakuSettingField previewDanmakuColorField">
              <Caption1>弹幕颜色</Caption1>
              <label className="previewDanmakuColorButton" aria-label="弹幕颜色" title="弹幕颜色">
                <input className="previewDanmakuColor" type="color" value={danmakuColor} onChange={(event) => onDanmakuColorChange?.(event.target.value.toUpperCase())} aria-label="弹幕颜色" />
              </label>
            </label>
            <label className="previewDanmakuSettingField">
              <Caption1>背景透明度 {Math.round(danmakuBackgroundOpacity * 100)}%</Caption1>
              <input type="range" min="0" max="0.9" step="0.05" value={danmakuBackgroundOpacity} onChange={(event) => onDanmakuBackgroundOpacityChange?.(event.target.value)} />
            </label>
            <label className="previewDanmakuSettingField">
              <Caption1>文本透明度 {Math.round(danmakuTextOpacity * 100)}%</Caption1>
              <input type="range" min="0.2" max="1" step="0.05" value={danmakuTextOpacity} onChange={(event) => onDanmakuTextOpacityChange?.(event.target.value)} />
            </label>
            <label className="previewDanmakuSettingField">
              <Caption1>字号缩放 {Math.round(danmakuFontScale * 100)}%</Caption1>
              <input type="range" min="0.8" max="1.6" step="0.05" value={danmakuFontScale} onChange={(event) => onDanmakuFontScaleChange?.(event.target.value)} />
            </label>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="previewDanmakuSendButton"
        onClick={() => onSubmit?.()}
        disabled={sendDisabled}
        aria-label="发送弹幕"
        title="发送弹幕"
      >
        发送
      </button>
    </div>
  );
}