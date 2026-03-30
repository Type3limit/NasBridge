import { useContext } from "react";
import { MusicPlayerContext } from "../GlobalMusicPlayer";
import { PauseRegular, PlayRegular, NextRegular } from "@fluentui/react-icons";

export default function MiniMusicBar() {
  const ctx = useContext(MusicPlayerContext);

  // If no context (player not mounted) or no track, don't render
  if (!ctx || !ctx.currentTrack) return null;

  const { currentTrack, isPlaying, togglePlay, nextTrack } = ctx;

  return (
    <div className="mobileMinimusicBar" role="region" aria-label="正在播放">
      {/* Cover art */}
      <div className="mobileMinimusicCover" aria-hidden="true">
        {currentTrack.coverUrl ? (
          <img src={currentTrack.coverUrl} alt="" />
        ) : (
          <span className="mobileMinimusicCoverPlaceholder">♪</span>
        )}
      </div>

      {/* Track info */}
      <div className="mobileMinimusicInfo">
        <span className="mobileMinimusicTitle">{currentTrack.title || "未知曲目"}</span>
        {currentTrack.artist ? <span className="mobileMinimusicArtist">{currentTrack.artist}</span> : null}
      </div>

      {/* Controls */}
      <div className="mobileMinimusicControls">
        <button
          type="button"
          className="mobileMinimusicBtn"
          onClick={(e) => { e.stopPropagation(); togglePlay(); }}
          aria-label={isPlaying ? "暂停" : "播放"}
        >
          {isPlaying ? <PauseRegular /> : <PlayRegular />}
        </button>
        <button
          type="button"
          className="mobileMinimusicBtn"
          onClick={(e) => { e.stopPropagation(); nextTrack(); }}
          aria-label="下一首"
        >
          <NextRegular />
        </button>
      </div>
    </div>
  );
}
