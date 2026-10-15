import { useEffect, useState } from "react";
/*
 * Tactical terminal chrome for the NAS Bridge UI. At rest the only thing that
 * moves is the warning strip (HudTicker); everything else animates once on
 * entry. All motion is switched off by prefers-reduced-motion (tactical.css).
 */

export function TacticalBackdrop() {
  return (
    <div className="tacBackdrop" aria-hidden="true">
      <div className="tacBgGrid" />
      <div className="tacBgScan" />
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

// Scrolling warning strip: the one element that keeps moving at rest.
export function HudTicker({ items }) {
  const line = items.filter(Boolean).join("  ·  ");
  return (
    <div className="tacTicker" aria-hidden="true">
      <span className="tacTickerTag">NOTICE</span>
      <div className="tacTickerTrack"><div className="tacTickerRun"><span>{line}</span><span>{line}</span></div></div>
    </div>
  );
}

// Keyed by the active module so each switch replays the wipe + reveal. The
// mast is the page's display title: oversized code bleeding off the right edge
// plus the module's slanted yellow index block.
export function TacticalStage({ code, index, label, children }) {
  return (
    <div className="tacStage">
      <header className="tacMast" aria-hidden="true">
        <span className="tacMastIndex">{index}</span>
        <span className="tacMastText"><strong>{code}</strong><small>{label}</small></span>
      </header>
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
