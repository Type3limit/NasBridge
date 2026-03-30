import { useEffect, useRef, useState } from "react";
import { Caption1 } from "@fluentui/react-components";
import VideoPlayerControls from "./VideoPlayerControls";

function getFullscreenElement() {
  if (typeof document === "undefined") {
    return null;
  }
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

async function requestElementFullscreen(element) {
  if (!element) {
    return;
  }
  if (typeof element.requestFullscreen === "function") {
    await element.requestFullscreen();
    return;
  }
  if (typeof element.webkitRequestFullscreen === "function") {
    await element.webkitRequestFullscreen();
  }
}

async function exitElementFullscreen() {
  if (typeof document === "undefined") {
    return;
  }
  if (typeof document.exitFullscreen === "function") {
    await document.exitFullscreen();
    return;
  }
  if (typeof document.webkitExitFullscreen === "function") {
    await document.webkitExitFullscreen();
  }
}

export default function VideoViewportSurface({
  className = "",
  style = null,
  controls = null,
  overlay = null,
  children,
  surfaceRef = null,
  playing = false,
  autoHideControls = true,
  controlsHideDelayMs = 1600,
  controlsInitiallyVisible = false,
  forceControlsVisible = false,
  onDoubleClick,
  onClick
}) {
  const rootRef = useRef(null);
  const [controlsVisible, setControlsVisible] = useState(Boolean(forceControlsVisible || controlsInitiallyVisible));
  const [focusWithin, setFocusWithin] = useState(false);
  const hideControlsTimerRef = useRef(null);

  useEffect(() => {
    setControlsVisible(Boolean(forceControlsVisible || controlsInitiallyVisible));
  }, [controlsInitiallyVisible, forceControlsVisible]);

  useEffect(() => {
    if (typeof surfaceRef === "function") {
      surfaceRef(rootRef.current);
      return;
    }
    if (surfaceRef && typeof surfaceRef === "object") {
      surfaceRef.current = rootRef.current;
    }
  }, [surfaceRef]);

  useEffect(() => {
    return () => {
      if (hideControlsTimerRef.current) {
        window.clearTimeout(hideControlsTimerRef.current);
        hideControlsTimerRef.current = null;
      }
    };
  }, []);

  function cancelHideTimer() {
    if (hideControlsTimerRef.current) {
      window.clearTimeout(hideControlsTimerRef.current);
      hideControlsTimerRef.current = null;
    }
  }

  function scheduleHide() {
    if (focusWithin) {
      setControlsVisible(true);
      return;
    }
    cancelHideTimer();
    hideControlsTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      hideControlsTimerRef.current = null;
    }, controlsHideDelayMs);
  }

  function revealControls() {
    if (forceControlsVisible) {
      setControlsVisible(true);
      return;
    }
    setControlsVisible(true);
    if (autoHideControls && playing) {
      scheduleHide();
    } else {
      cancelHideTimer();
    }
  }

  function hideControlsImmediately() {
    if (forceControlsVisible || !playing || focusWithin) {
      return;
    }
    cancelHideTimer();
    setControlsVisible(false);
  }

  useEffect(() => {
    if (forceControlsVisible || !playing || focusWithin) {
      cancelHideTimer();
      setControlsVisible(true);
      return;
    }
    if (controlsVisible && autoHideControls) {
      scheduleHide();
    }
  }, [autoHideControls, controlsVisible, focusWithin, forceControlsVisible, playing]);

  return (
    <div
      ref={rootRef}
      className={`videoViewportSurface${controlsVisible ? " controlsVisible" : ""}${className ? ` ${className}` : ""}`}
      style={style || undefined}
      onMouseEnter={revealControls}
      onMouseMove={revealControls}
      onMouseLeave={hideControlsImmediately}
      onFocusCapture={() => {
        setFocusWithin(true);
        revealControls();
      }}
      onBlurCapture={(event) => {
        const nextFocused = event.relatedTarget;
        if (rootRef.current?.contains(nextFocused)) {
          setFocusWithin(true);
          revealControls();
          return;
        }
        setFocusWithin(false);
        if (autoHideControls && !forceControlsVisible && playing) {
          scheduleHide();
        }
      }}
      onDoubleClick={onDoubleClick}
      onClick={onClick}
    >
      {children}
      {overlay}
      {controls ? <div className="videoViewportControls">{controls}</div> : null}
    </div>
  );
}

export function InlineVideoPlayer({
  src = "",
  poster = "",
  name = "视频",
  className = "",
  videoClassName = "",
  viewportClassName = "",
  hint = "",
  onOpenExternal,
  defaultMuted = false,
  preload = "metadata"
}) {
  const videoRef = useRef(null);
  const viewportRef = useRef(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedTime, setBufferedTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pictureInPictureActive, setPictureInPictureActive] = useState(false);
  const [fullscreenActive, setFullscreenActive] = useState(false);
  const [videoDimensions, setVideoDimensions] = useState({ width: 16, height: 9 });
  const canUsePictureInPicture = typeof document !== "undefined" && Boolean(document.pictureInPictureEnabled);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return undefined;
    }

    const syncPlaybackState = () => {
      const nextCurrentTime = Number.isFinite(video.currentTime) ? Number(video.currentTime) : 0;
      const nextDuration = Number.isFinite(video.duration) ? Number(video.duration) : 0;
      let nextBufferedTime = nextCurrentTime;
      try {
        for (let idx = 0; idx < video.buffered.length; idx += 1) {
          const start = video.buffered.start(idx);
          const end = video.buffered.end(idx);
          if (nextCurrentTime >= start && nextCurrentTime <= end) {
            nextBufferedTime = end;
            break;
          }
          if (end > nextBufferedTime) {
            nextBufferedTime = end;
          }
        }
      } catch {
      }
      setCurrentTime(nextCurrentTime);
      setDuration(nextDuration);
      setBufferedTime(nextBufferedTime);
      setPlaying(!video.paused && !video.ended);
      const intrinsicWidth = Number(video.videoWidth || 0);
      const intrinsicHeight = Number(video.videoHeight || 0);
      if (intrinsicWidth > 0 && intrinsicHeight > 0) {
        setVideoDimensions((prev) => (
          prev.width === intrinsicWidth && prev.height === intrinsicHeight
            ? prev
            : { width: intrinsicWidth, height: intrinsicHeight }
        ));
      }
    };

    const syncPictureInPictureState = () => {
      if (typeof document === "undefined") {
        setPictureInPictureActive(false);
        return;
      }
      setPictureInPictureActive(document.pictureInPictureElement === video);
    };

    syncPlaybackState();
    syncPictureInPictureState();

    video.addEventListener("timeupdate", syncPlaybackState);
    video.addEventListener("loadedmetadata", syncPlaybackState);
    video.addEventListener("durationchange", syncPlaybackState);
    video.addEventListener("progress", syncPlaybackState);
    video.addEventListener("play", syncPlaybackState);
    video.addEventListener("pause", syncPlaybackState);
    video.addEventListener("ended", syncPlaybackState);
    video.addEventListener("enterpictureinpicture", syncPictureInPictureState);
    video.addEventListener("leavepictureinpicture", syncPictureInPictureState);

    return () => {
      video.removeEventListener("timeupdate", syncPlaybackState);
      video.removeEventListener("loadedmetadata", syncPlaybackState);
      video.removeEventListener("durationchange", syncPlaybackState);
      video.removeEventListener("progress", syncPlaybackState);
      video.removeEventListener("play", syncPlaybackState);
      video.removeEventListener("pause", syncPlaybackState);
      video.removeEventListener("ended", syncPlaybackState);
      video.removeEventListener("enterpictureinpicture", syncPictureInPictureState);
      video.removeEventListener("leavepictureinpicture", syncPictureInPictureState);
    };
  }, [src]);

  useEffect(() => {
    const syncFullscreenState = () => {
      const viewport = viewportRef.current;
      const fullscreenElement = getFullscreenElement();
      setFullscreenActive(Boolean(fullscreenElement && viewport && (fullscreenElement === viewport || viewport.contains(fullscreenElement))));
    };

    syncFullscreenState();
    document.addEventListener("fullscreenchange", syncFullscreenState);
    document.addEventListener("webkitfullscreenchange", syncFullscreenState);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      document.removeEventListener("webkitfullscreenchange", syncFullscreenState);
    };
  }, []);

  function seekVideoTo(nextTime) {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const nextDuration = Number.isFinite(video.duration) ? Number(video.duration) : Number(duration || 0);
    const maxTime = nextDuration > 0 ? nextDuration : Math.max(0, Number(nextTime || 0));
    const safeTime = Math.max(0, Math.min(Number(nextTime || 0), maxTime));
    video.currentTime = safeTime;
    setCurrentTime(safeTime);
  }

  function toggleVideoPlayback() {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused || video.ended) {
      video.play().catch(() => {});
      return;
    }
    video.pause();
  }

  async function togglePictureInPicture() {
    const video = videoRef.current;
    if (!video || typeof document === "undefined" || !document.pictureInPictureEnabled) {
      return;
    }
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture();
      return;
    }
    if (typeof video.requestPictureInPicture === "function") {
      await video.requestPictureInPicture();
    }
  }

  async function togglePlayerFullscreen() {
    const viewport = viewportRef.current || videoRef.current;
    if (!viewport) {
      return;
    }
    const fullscreenElement = getFullscreenElement();
    if (fullscreenElement && (fullscreenElement === viewport || viewport.contains(fullscreenElement))) {
      await exitElementFullscreen();
      return;
    }
    await requestElementFullscreen(viewport);
  }

  const aspectRatio = Math.max(0.4, Math.min(2.4, Number(videoDimensions.width || 16) / Math.max(1, Number(videoDimensions.height || 9))));
  const inlineMaxWidth = aspectRatio >= 1.65
    ? 460
    : aspectRatio >= 1.15
      ? 390
      : Math.max(200, Math.min(320, Math.round(240 * aspectRatio + 90)));
  const inlineMaxHeight = aspectRatio < 0.82
    ? 460
    : aspectRatio < 1.12
      ? 380
      : aspectRatio > 1.65
        ? 280
        : 320;
  const inlineStyle = {
    width: `min(100%, ${inlineMaxWidth}px)`,
    maxHeight: `${inlineMaxHeight}px`
  };
  const tileStyle = {
    aspectRatio: `${Number(videoDimensions.width || 16)} / ${Number(videoDimensions.height || 9)}`,
    maxHeight: `${inlineMaxHeight}px`
  };

  return (
    <VideoViewportSurface
      surfaceRef={viewportRef}
      className={`chatInlineVideoViewport${viewportClassName ? ` ${viewportClassName}` : ""}`}
      style={inlineStyle}
      playing={playing}
      controls={(
        <VideoPlayerControls
          currentTime={currentTime}
          duration={duration}
          bufferedTime={bufferedTime}
          playing={playing}
          pictureInPictureActive={pictureInPictureActive}
          fullscreenActive={fullscreenActive}
          canUsePictureInPicture={canUsePictureInPicture}
          onTogglePlay={toggleVideoPlayback}
          onSeek={seekVideoTo}
          onTogglePictureInPicture={() => togglePictureInPicture().catch(() => {})}
          onToggleFullscreen={() => togglePlayerFullscreen().catch(() => {})}
          showTime={false}
          showTransportActions={false}
          showPictureInPictureButton={false}
          showPageFillButton={false}
          showFullscreenButton={false}
          extraClassName="chatInlineVideoControls compact"
        />
      )}
    >
      <div className={`chatAttachmentTile video chatInlineVideoTile${className ? ` ${className}` : ""}`} style={tileStyle}>
        <video
          ref={videoRef}
          src={src}
          poster={poster || undefined}
          className={videoClassName}
          preload={preload}
          playsInline
          muted={defaultMuted}
        />
      </div>
    </VideoViewportSurface>
  );
}