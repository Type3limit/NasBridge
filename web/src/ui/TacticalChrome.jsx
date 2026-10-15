import { useEffect, useState } from "react";
import { tacticalArt } from "./tacticalArt";

/*
 * Tactical terminal chrome — the animated layer of the NAS Bridge UI.
 * Every effect here animates transform / opacity only and is switched off by
 * prefers-reduced-motion (see tactical.css). Swappable artwork lives in
 * ./tacticalArt.js.
 */

const PARTICLES = Array.from({ length: 16 }, (_, index) => ({
  left: (index * 61 + 7) % 100,
  delay: -((index * 1.7) % 14),
  duration: 12 + (index % 5) * 3,
  size: 1 + (index % 3)
}));

export function TacticalBackdrop() {
  return (
    <div className="tacBackdrop" aria-hidden="true">
      <div className="tacBgArt" style={{ backgroundImage: `url(${tacticalArt.backdrop})` }} />
      <div className="tacBgFloor"><div className="tacBgFloorGrid" /></div>
      <div className="tacBgGrid" />
      <svg className="tacBgRings" viewBox="0 0 600 600">
        <circle cx="300" cy="300" r="290" className="ringA" />
        <circle cx="300" cy="300" r="240" className="ringB" />
        <circle cx="300" cy="300" r="182" className="ringC" />
        <path d="M300 4v40M300 556v40M4 300h40M556 300h40" className="ringTicks" />
      </svg>
      <div className="tacBgBeams"><i /><i /><i /></div>
      <div className="tacBgHazard" />
      <div className="tacBgParticles">
        {PARTICLES.map((particle, index) => (
          <i key={index} style={{ left: `${particle.left}%`, animationDelay: `${particle.delay}s`, animationDuration: `${particle.duration}s`, width: particle.size, height: particle.size }} />
        ))}
      </div>
      <div className="tacBgScan" />
      <div className="tacBgNoise" />
      <div className="tacBgVignette" />
      <span className="tacBgCoord tl">SYS.NB—01 // SECTOR 30.67N</span>
      <span className="tacBgCoord br">104.06E // RELAY GRID ACTIVE</span>
    </div>
  );
}

const BOOT_KEY = "nas_boot_seen";
const BOOT_LINES = [
  "INIT  CORE RELAY ............ OK",
  "LINK  SIGNAL CHANNEL ........ OK",
  "SCAN  STORAGE NODES ......... OK",
  "LOAD  TACTICAL INTERFACE .... OK"
];

function shouldPlayBoot() {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    return sessionStorage.getItem(BOOT_KEY) !== "1";
  } catch {
    return false;
  }
}

// One short boot sequence per browser session; any click or key skips it.
export function BootSequence() {
  const [phase, setPhase] = useState(() => (shouldPlayBoot() ? "run" : "done"));
  useEffect(() => {
    if (phase !== "run") return undefined;
    try { sessionStorage.setItem(BOOT_KEY, "1"); } catch { /* private storage */ }
    const skip = () => setPhase("leave");
    const timer = setTimeout(skip, 1500);
    window.addEventListener("keydown", skip);
    return () => { clearTimeout(timer); window.removeEventListener("keydown", skip); };
  }, [phase]);
  useEffect(() => {
    if (phase !== "leave") return undefined;
    const timer = setTimeout(() => setPhase("done"), 420);
    return () => clearTimeout(timer);
  }, [phase]);
  if (phase === "done") return null;
  return (
    <div className={`tacBoot${phase === "leave" ? " leave" : ""}`} onClick={() => setPhase("leave")} role="presentation">
      <div className="tacBootBand top" />
      <div className="tacBootBand bottom" />
      <div className="tacBootCore">
        <svg className="tacBootMark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path d="M4 29 15 7h8L12 29H4Zm14 4L29 11h8L26 33h-8Z" />
          <path d="M12 20h18" />
        </svg>
        <div className="tacBootTitle"><strong>NAS BRIDGE</strong><span>TACTICAL STORAGE TERMINAL</span></div>
        <div className="tacBootBar"><i /></div>
        <ol className="tacBootLog">
          {BOOT_LINES.map((line, index) => <li key={line} style={{ animationDelay: `${0.2 + index * 0.24}s` }}>{line}</li>)}
        </ol>
      </div>
      <span className="tacBootSkip">CLICK / ANY KEY TO SKIP</span>
    </div>
  );
}

function formatClock(date) {
  const pad = value => String(value).padStart(2, "0");
  return {
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    date: `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
  };
}

export function HudClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const { time, date } = formatClock(now);
  return <div className="tacClock" aria-label={`当前时间 ${time}`}><strong>{time}</strong><span>{date} · UTC+8</span></div>;
}

export function HudTicker({ items }) {
  const line = items.filter(Boolean).join("   ///   ");
  return (
    <div className="tacTicker" aria-hidden="true">
      <span className="tacTickerTag">LIVE</span>
      <div className="tacTickerTrack"><div className="tacTickerRun"><span>{line}</span><span>{line}</span></div></div>
    </div>
  );
}

// Keyed by the active module so each switch replays the wipe + reveal.
export function TacticalStage({ code, index, children }) {
  return (
    <div className="tacStage" style={{ "--tac-index": `"${index}"` }}>
      {children}
      <div className="tacWipe" aria-hidden="true">
        <div className="tacWipePanel"><span>{index}</span><strong>{code}</strong></div>
      </div>
    </div>
  );
}

export function TacticalStatusBar({ onlineCount, nodeTotal, wsState, lastRefresh, moduleCode }) {
  const linkUp = wsState === "open";
  return (
    <footer className="tacStatusBar registryFooter">
      <div className="tacStatusCells">
        <span className={`tacStatusCell${linkUp ? " ok" : " warn"}`}><i />SIGNAL {String(wsState || "idle").toUpperCase()}</span>
        <span className="tacStatusCell"><b>{String(onlineCount).padStart(2, "0")}</b>/{String(nodeTotal).padStart(2, "0")} NODES</span>
        <span className="tacStatusCell">SYNC {lastRefresh}</span>
        <span className="tacStatusCell module">MODULE // {moduleCode}</span>
      </div>
      <div>
        <a href="https://beian.miit.gov.cn/" rel="noreferrer" target="_blank">ICP备30177262049410112号</a>
        <a href="https://beian.mps.gov.cn/#/query/webSearch?code=51015602001732" rel="noreferrer" target="_blank">川公网安备51015602001732号</a>
      </div>
    </footer>
  );
}

// Pointer-tracked spotlight for hoverable panels: one listener, rAF throttled,
// fine pointers only.
const SPOT_SELECTOR = ".tacTile, .gridItem, .terminalModelCard, .miniListRow, .simpleRow, .workspaceNavButton, .accessFormPanel";
export function usePointerSpotlight() {
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia("(pointer: fine)").matches) return undefined;
    let frame = 0;
    let pending = null;
    const apply = () => {
      frame = 0;
      if (!pending) return;
      const target = pending.target instanceof Element ? pending.target.closest(SPOT_SELECTOR) : null;
      if (target) {
        const rect = target.getBoundingClientRect();
        target.style.setProperty("--mx", `${pending.clientX - rect.left}px`);
        target.style.setProperty("--my", `${pending.clientY - rect.top}px`);
      }
      pending = null;
    };
    const onMove = event => {
      pending = event;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => { window.removeEventListener("pointermove", onMove); if (frame) cancelAnimationFrame(frame); };
  }, []);
}

export function SpotlightRoot() {
  usePointerSpotlight();
  return null;
}
