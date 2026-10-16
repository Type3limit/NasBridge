import { useContext } from "react";
import { MusicPlayerContext } from "../GlobalMusicPlayer";
import { PauseRegular, PlayRegular, NextRegular } from "@fluentui/react-icons";

export default function MiniMusicBar() {
  const ctx = useContext(MusicPlayerContext);

  // No player mounted: nothing to show.
  if (!ctx) return null;

  const { currentTrack, isPlaying, togglePlay, nextTrack, openDeck, upcomingCount = 0 } = ctx;

  return (
    <div className={`mobileMinimusicBar${isPlaying ? " playing" : ""}`} role="region" aria-label="正在播放" onClick={() => openDeck?.(upcomingCount ? "queue" : "search")}>
      {/* Cover art */}
      <div className="mobileMinimusicCover" aria-hidden="true">
        {currentTrack?.coverUrl ? (
          <img src={currentTrack.coverUrl} alt="" />
        ) : (
          <span className="mobileMinimusicCoverPlaceholder">♪</span>
        )}
      </div>

      {/* Track info */}
      <div className="mobileMinimusicInfo">
        <span className="mobileMinimusicTitle">{currentTrack?.title || "还没有人点歌"}</span>
        <span className="mobileMinimusicArtist">
          {currentTrack ? `${currentTrack.artist || ""}${currentTrack.submittedBy ? ` · ${currentTrack.submittedBy} 点的` : ""}` : "点这里打开点歌台"}
        </span>
      </div>

      {/* Controls */}
      <div className="mobileMinimusicControls">
        {currentTrack ? (
          <>
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
          </>
        ) : null}
        <button
          type="button"
          className="mobileMinimusicDeck"
          onClick={(e) => { e.stopPropagation(); openDeck?.(upcomingCount ? "queue" : "search"); }}
          aria-label="打开点歌台"
        >
          点歌 <span>{upcomingCount}</span>
        </button>
      </div>
    </div>
  );
}
