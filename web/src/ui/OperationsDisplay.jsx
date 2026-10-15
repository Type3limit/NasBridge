import assembly from "../assets/relay-assembly.webp";
import hall from "../assets/machine-hall.webp";
import nodeRack from "../assets/node-rack.webp";
import conveyor from "../assets/transfer-conveyor.webp";
import vault from "../assets/exchange-vault.webp";
import projector from "../assets/media-projector.webp";
import consoleArt from "../assets/signal-console.webp";
import drive from "../assets/archive-drive.webp";
import { tacticalArt } from "./tacticalArt";

export const equipmentArt = { node: nodeRack, transfer: conveyor, share: vault, media: projector, chat: consoleArt, archive: drive };
export function EquipmentVisual({ kind = "archive", className = "" }) {
  return <img src={equipmentArt[kind] || drive} className={`equipmentVisual ${className}`} alt="" aria-hidden="true" decoding="async" loading="lazy"/>;
}

export function FieldArtwork({ label = "PRIVATE STORAGE NETWORK", compact = false, kind }) {
  return <div className={`fieldArtwork${compact ? " compact" : ""}`} aria-hidden="true">
    <img className="fieldHall" src={hall} alt="" loading="lazy" decoding="async"/>
    <div className="fieldArtGrid"/><div className="fieldArtSweep"/>
    <div className="fieldArtType"><span>// NB INDUSTRIAL SYSTEM</span><strong>BEYOND<br/>THE LOCAL.</strong><small>{label}</small></div>
    <div className="fieldArtRing"/><img className="fieldAssembly" src={kind ? equipmentArt[kind] : assembly} alt="" loading="lazy" decoding="async"/>
    <span className="fieldArtCode">NB / 014 —— SYSTEM INTERFACE</span>
  </div>;
}

const HOME_TILES = [
  { page: "explorer", code: "ARCHIVE", label: "资源浏览器", art: "archive", unit: "FILES" },
  { page: "chat", code: "COMMS", label: "通讯频道", art: "chat", unit: "CHANNEL" },
  { page: "transfers", code: "TRANSIT", label: "传输队列", art: "transfer", unit: "TASKS" },
  { page: "terminals", code: "NODES", label: "终端状态", art: "node", unit: "ONLINE" },
  { page: "shares", code: "EXCHANGE", label: "分享管理", art: "share", unit: "LINKS" },
  { page: "tv", code: "BROADCAST", label: "TV 直播", art: tacticalArt.broadcastTile, unit: "LIVE" },
  { page: "anime", code: "ANIME", label: "番剧", art: tacticalArt.animeTile, unit: "BGM" }
];

export function OperationsOverview({ onlineCount, clients, files, shares, uploads, downloads, wsState, lastRefresh, onUpload, onDiagnostics, onRefresh, onNavigate }) {
  const values = {
    explorer: files, chat: onlineCount ? "ON" : "--", transfers: uploads + downloads,
    terminals: `${onlineCount}/${clients.length}`, shares, tv: "ON", anime: "BGM"
  };
  const pad = value => typeof value === "number" ? String(value).padStart(2, "0") : value;
  const linkUp = wsState === "open";
  return <section className="operationsOverview workspacePage tacHome">
    <header className="tacHomeHeading">
      <div className="tacHomeTitle"><span className="industrialEyebrow">00 / COMMAND CENTER</span><h1 data-text="指挥中心">指挥中心</h1><span className="tacHomeSub">PRIVATE STORAGE NETWORK · OPERATIONS OVERVIEW</span></div>
      <div className="operationsActions"><button onClick={onDiagnostics}><span>链路诊断</span><small>DIAG</small></button><button onClick={onRefresh}><span>同步索引</span><small>SYNC</small></button><button className="solidAction" onClick={onUpload}><span>发起上传</span><small>UPLOAD +</small></button></div>
    </header>
    <div className="tacHomeGrid">
      <div className="tacHero">
        <img src={tacticalArt.commandHero} className="tacHeroHall" alt="" decoding="async"/>
        <div className="tacHeroScrim"/>
        <div className="tacHeroRings" aria-hidden="true"><i/><i/><i/></div>
        <img src={tacticalArt.heroMachine} className="tacHeroMachine" alt="" decoding="async"/>
        <div className="tacHeroScan" aria-hidden="true"/>
        <div className="tacHeroCopy">
          <span className="tacHeroKicker">// RELAY STATUS</span>
          <h2>所有节点<br/>尽在掌握<em>。</em></h2>
          <div className={`tacHeroSignal${linkUp ? " online" : ""}`}><i/><span>SIGNAL {String(wsState || "idle").toUpperCase()}</span><span>SYNC {lastRefresh}</span></div>
        </div>
        <div className="tacHeroStats">
          <div><strong>{pad(onlineCount)}</strong><span>在线节点 / NODES</span></div>
          <div><strong>{pad(files)}</strong><span>索引资源 / FILES</span></div>
          <div><strong>{pad(uploads + downloads)}</strong><span>传输任务 / TASKS</span></div>
        </div>
        <span className="tacHeroSerial" aria-hidden="true">NB—01</span>
        <span className="tacCorner tl"/><span className="tacCorner br"/>
      </div>
      {HOME_TILES.map((tile, index) => <button key={tile.page} type="button" className={`tacTile tile-${tile.page}`} style={{ "--i": index }} onClick={() => onNavigate(tile.page)}>
        <img src={equipmentArt[tile.art] || tile.art} className="tacTileArt" alt="" aria-hidden="true" loading="lazy" decoding="async"/>
        <span className="tacTileIndex">{String(index + 1).padStart(2, "0")}</span>
        <span className="tacTileCode" aria-hidden="true">{tile.code}</span>
        <span className="tacTileBody"><strong>{tile.label}</strong><span className="tacTileValue"><b>{pad(values[tile.page])}</b><small>{tile.unit}</small></span></span>
        <span className="tacTileArrow" aria-hidden="true">↗</span>
      </button>)}
      <div className="tacNodeBoard">
        <header><span className="industrialEyebrow">CONNECTED NODES</span><span className="monoLabel">{pad(onlineCount)} ONLINE</span></header>
        <div>{clients.length ? clients.slice(0, 5).map(client => <button onClick={() => onNavigate("terminals")} key={client.id}><i className={client.status === "online" ? "online" : ""}/><span>{client.name || client.id}</span><small>{client.status}</small></button>) : <p>等待首个存储节点接入<small>START A STORAGE CLIENT TO LINK</small></p>}</div>
      </div>
    </div>
  </section>;
}

export function NodeTopology({ clients, diagnostics = {} }) {
  return <div className="terminalFleet">{clients.length ? clients.map((client, index) => <article className={`terminalModelCard ${client.status === "online" ? "online" : ""}`} key={client.id}>
    <header><span className="industrialEyebrow">NODE / {String(index + 1).padStart(2, "0")}</span><span className="terminalStatus"><i/>{client.status === "online" ? "在线" : client.status === "disabled" ? "已禁用" : "离线"}</span></header>
    <div className="terminalModelStage"><EquipmentVisual kind="node"/><span className="terminalModelSerial">NB—{String(index + 1).padStart(2, "0")}</span><div className="terminalScanner"/></div>
    <div className="terminalModelInfo"><h3>{client.name || client.id}</h3><dl><div><dt>节点标识</dt><dd>{client.id}</dd></div><div><dt>链路模式</dt><dd>{diagnostics[client.id]?.routeLabel || diagnostics[client.id]?.route || "等待连接"}</dd></div><div><dt>最近心跳</dt><dd>{client.lastHeartbeatAt ? new Date(client.lastHeartbeatAt).toLocaleTimeString("zh-CN", { hour12: false }) : "尚无记录"}</dd></div></dl></div>
  </article>) : <div className="equipmentEmpty"><EquipmentVisual kind="node"/><h3>等待节点接入</h3><p>启动存储客户端以建立连接</p></div>}</div>;
}

export function TransferDisplay({ uploads, downloads }) {
  const active = uploads + downloads;
  return <div className={`transferShowcase${active ? " running" : ""}`}><div className="transferShowcaseCopy"><span className="industrialEyebrow">DATA TRANSPORT / 数据传输</span><h3>{active ? "正在传输，连接继续。" : "整装待发。"}</h3><p>{active ? `${active} 个任务进行中，详细进度见下方队列。` : "你的下一次传输，从这里开始。"}</p><div><span><b>{uploads}</b> 上传任务</span><span><b>{downloads}</b> 下载任务</span></div></div><div className="transferEquipment"><EquipmentVisual kind="transfer"/><span className="transferEquipmentScan"/></div></div>;
}

export function FileTypeVisual({ mime = "", label = "" }) {
  const video = mime.startsWith("video");
  const image = mime.startsWith("image");
  const audio = mime.startsWith("audio");
  return <div className={`fileTypeVisual ${video ? "video" : image ? "image" : audio ? "audio" : "document"}`}>
    <span className="fileVisualCode">{video ? "VIDEO ARCHIVE" : image ? "IMAGE ASSET" : audio ? "AUDIO RECORD" : "DATA FILE"}</span>
    <EquipmentVisual kind={video || audio ? "media" : image ? "share" : "archive"}/>
    <span className="fileVisualLabel">{audio ? "音频" : label}</span><span className="fileVisualBarcode" aria-hidden="true"/>
  </div>;
}
