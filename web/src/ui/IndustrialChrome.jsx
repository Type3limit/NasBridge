import { ThemeSwitch } from "./ThemeProvider";

export function BridgeMark() {
  return <svg className="bridgeMark" viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M4 29 15 7h8L12 29H4Zm14 4L29 11h8L26 33h-8Z" fill="currentColor"/><path d="M12 20h18" stroke="currentColor" strokeWidth="3"/></svg>;
}

export function IndustrialBackdrop() {
  return <div className="industrialBackdrop" aria-hidden="true"><div className="industrialGrid"/><div className="industrialSweep"/><span className="backdropCoordinate">N / 30.67 — E / 104.06</span></div>;
}

export function PageMasthead({ section = "PRIVATE STORAGE NETWORK", title = "NAS BRIDGE" }) {
  return <header className="pageMasthead"><a href="/" className="industrialBrand"><BridgeMark/><span>{title}<small>{section}</small></span></a><ThemeSwitch/></header>;
}

export function RegistryFooter() {
  return <footer className="registryFooter"><span>NAS BRIDGE / PRIVATE CLOUD</span><div><a href="https://beian.miit.gov.cn/" rel="noreferrer" target="_blank">ICP备30177262049410112号</a><a href="https://beian.mps.gov.cn/#/query/webSearch?code=51015602001732" rel="noreferrer" target="_blank">川公网安备51015602001732号</a></div></footer>;
}
