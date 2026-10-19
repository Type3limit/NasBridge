import { useContext } from "react";
import { PauseRegular, PlayRegular } from "@fluentui/react-icons";
import { MusicPlayerContext } from "./GlobalMusicPlayer";

// Command-center panel: the song on air, the next three, and today's DJs.
export default function MusicCommandBoard() {
  const ctx = useContext(MusicPlayerContext);
  if (!ctx) {
    return null;
  }
  const { currentTrack, isPlaying, togglePlay, nextTrack, openDeck, upcomingTracks = [], loopTracks = [], queueItems = [], skipLabel, mySkipVoted, progressPercent = 0, hostName } = ctx;
  const looping = !upcomingTracks.length;
  const nextThree = (looping ? loopTracks : upcomingTracks).slice(0, 3);
  const today = new Date().toDateString();
  const djCounts = new Map();
  for (const track of queueItems) {
    if (track.submittedBy && track.submittedAt && new Date(track.submittedAt).toDateString() === today) {
      djCounts.set(track.submittedBy, (djCounts.get(track.submittedBy) || 0) + 1);
    }
  }
  const djs = [...djCounts].sort((left, right) => right[1] - left[1]).slice(0, 3);

  return (
    <section className={`tacMusicBoard${isPlaying ? " playing" : ""}`} aria-label="点歌台">
      <header>
        <span className="industrialEyebrow">ON AIR / 点歌台{hostName ? ` · ${hostName}` : ""}</span>
        <button type="button" className="tacMusicRequest" onClick={() => openDeck?.("search")}>点歌</button>
      </header>
      <div className="tacMusicBody">
        <div className="tacMusicNow">
          {currentTrack?.coverUrl ? <img src={currentTrack.coverUrl} alt="" /> : <span className="tacMusicCover" aria-hidden="true">♪</span>}
          <div className="tacMusicNowText">
            <strong title={currentTrack?.title || ""}>{currentTrack?.title || "还没有人点歌"}</strong>
            <span>{currentTrack ? `${currentTrack.artist || ""}${currentTrack.submittedBy ? ` · ${currentTrack.submittedBy} 点的` : ""}` : "点右上角的“点歌”，搜一首大家一起听"}</span>
            <i className="tacMusicProgress" style={{ "--music-progress": `${progressPercent}%` }} aria-hidden="true" />
            {currentTrack ? (
              <div className="tacMusicControls">
                <button type="button" onClick={() => togglePlay?.()} aria-label={isPlaying ? "暂停" : "播放"}>{isPlaying ? <PauseRegular /> : <PlayRegular />}</button>
                <button type="button" onClick={() => nextTrack?.()} disabled={mySkipVoted}>{mySkipVoted ? "已投票" : skipLabel}</button>
              </div>
            ) : null}
          </div>
        </div>
        <div className="tacMusicList">
          <span className="tacMusicListTitle">{looping ? "接下来（循环）" : "接下来"}</span>
          {nextThree.length ? (
            <ol>
              {nextThree.map((track) => (
                <li key={track.id}><strong>{track.title}</strong><span>{track.submittedBy || track.artist}</span></li>
              ))}
            </ol>
          ) : <p>队列是空的</p>}
        </div>
        <div className="tacMusicList">
          <span className="tacMusicListTitle">今日 DJ</span>
          {djs.length ? (
            <ol>
              {djs.map(([name, count]) => (
                <li key={name}><strong>{name}</strong><span className="tacNum">{count} 首</span></li>
              ))}
            </ol>
          ) : <p>今天还没人点歌</p>}
        </div>
      </div>
    </section>
  );
}
