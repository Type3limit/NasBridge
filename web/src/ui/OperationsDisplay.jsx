import assembly from "../assets/relay-assembly.webp";
import hall from "../assets/machine-hall.webp";
import nodeRack from "../assets/node-rack.webp";
import conveyor from "../assets/transfer-conveyor.webp";
import vault from "../assets/exchange-vault.webp";
import projector from "../assets/media-projector.webp";
import consoleArt from "../assets/signal-console.webp";
import drive from "../assets/archive-drive.webp";

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

export function OperationsOverview({ onlineCount, clients, files, shares, uploads, downloads, wsState, lastRefresh, onUpload, onDiagnostics, onRefresh, onNavigate }) {
  const metrics = [
    { value: String(onlineCount).padStart(2, "0"), label: "在线存储节点", unit: "NODES", page: "terminals" },
    { value: String(files).padStart(2, "0"), label: "索引资源", unit: "FILES", page: "explorer" },
    { value: String(uploads + downloads).padStart(2, "0"), label: "传输任务", unit: "TASKS", page: "transfers" },
    { value: String(shares).padStart(2, "0"), label: "共享链接", unit: "LINKS", page: "shares" }
  ];
  return <section className="operationsOverview workspacePage">
    <header className="operationsHeading"><div><span className="industrialEyebrow">01 / OPERATIONS CENTER</span><h1>系统概览<span>。</span></h1></div><div className="operationsActions"><button onClick={onDiagnostics}>链路诊断 ↗</button><button onClick={onRefresh}>同步索引 ↻</button><button className="solidAction" onClick={onUpload}>发起上传 +</button></div></header>
    <div className="operationsStage">
      <img src={hall} className="operationsHall" alt="" decoding="async"/>
      <div className="operationsStageScrim"/>
      <div className="operationsData"><span className="stageKicker">PRIVATE CLOUD / CONTROL CENTER</span><h2>所有节点。<br/>尽在掌握。</h2><p>从文件到媒体，从传输到协作。<br/>你的存储网络，由你掌控。</p><div className="operationsSignal"><i className={wsState === "open" ? "online" : ""}/><span>信令 {wsState || "idle"}</span><span>更新 {lastRefresh}</span></div></div>
      <div className="operationsMachine" aria-hidden="true"><div className="machineOrbit"/><div className="machineOrbit second"/><img src={assembly} alt="" decoding="async"/><span className="machineCaption">DATA RELAY ASSEMBLY / NB—01</span><div className="machineScan"/></div>
      <div className="stageCrosses" aria-hidden="true"><span>+</span><span>+</span></div>
    </div>
    <div className="operationsMetrics">{metrics.map((metric, index) => <button key={metric.page} onClick={() => onNavigate(metric.page)}><span className="metricIndex">0{index + 1} / {metric.unit}</span><strong>{metric.value}<small>↗</small></strong><span>{metric.label}</span></button>)}</div>
    <div className="operationsBottom"><span className="monoLabel">CONNECTED NODES / 存储网络</span><div>{clients.length ? clients.slice(0, 4).map(client => <button onClick={() => onNavigate("terminals")} key={client.id}><i className={client.status === "online" ? "online" : ""}/><span>{client.name || client.id}</span><small>{client.status}</small></button>) : <span>等待首个存储节点接入</span>}</div></div>
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
