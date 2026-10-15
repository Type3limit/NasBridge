import { Button, Field, Input } from "@fluentui/react-components";
import { PageMasthead, RegistryFooter } from "./IndustrialChrome";
import station from "../assets/relay-station.webp";

export default function AccessPage({ mode, setMode, email, setEmail, password, setPassword, displayName, setDisplayName, onSubmit, toast }) {
  const register = mode === "register";
  return <div className="page accessPage">
    {toast}
    <PageMasthead/>
    <main className="accessLayout">
      <section className="accessHero">
        <img className="accessArtwork" src={station} alt="" aria-hidden="true" fetchPriority="low" decoding="async"/>
        <div className="accessHeroScrim"/>
        <div className="accessHeroFrame" aria-hidden="true"/>
        <div className="accessHeroTop"><span className="monoLabel">// NETWORK ACCESS · 01</span><span className="signalLabel"><i/> CONNECTION READY</span></div>
        <div className="accessHeroCopy"><span className="industrialEyebrow">YOUR DATA. YOUR FRONTIER.</span><h1>连接，<br/>无限可能<span>。</span></h1><p>将远端存储、媒体与协作，<br/>汇聚于你的私人云端。</p></div>
        <div className="accessHeroBottom"><span className="heroSerial">NB—01</span><div><strong>跨越边界 · 自由连接</strong><span>PRIVATE CLOUD / DIRECT CONNECTION</span></div><span className="heroCross">+</span></div>
      </section>
      <section className="accessFormPanel" aria-label={register ? "创建账户" : "登录账户"}>
        <div className="accessFormTop"><span className="monoLabel">ACCESS TERMINAL</span><span className="terminalIndex">[ 01 ]</span></div>
        <div className="accessFormTitle"><span className="industrialEyebrow">{register ? "REGISTER / 注册" : "SIGN IN / 登录"}</span><h2>{register ? "创建你的连接" : "欢迎回到工作台"}</h2><p>{register ? "建立账户，开始管理你的存储网络。" : "连接存储节点，继续你的工作。"}</p></div>
        <div className="accessModeSwitch" role="tablist" aria-label="账户操作"><button type="button" role="tab" aria-selected={!register} onClick={() => setMode("login")}>登录 <span>01</span></button><button type="button" role="tab" aria-selected={register} onClick={() => setMode("register")}>注册 <span>02</span></button></div>
        <form className="accessForm" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
          <Field label="邮箱地址"><Input type="email" value={email} placeholder="name@example.com" autoComplete="email" onChange={(_, data) => setEmail(data.value)}/></Field>
          <Field label="密码"><Input type="password" value={password} placeholder="输入登录密码" autoComplete={register ? "new-password" : "current-password"} onChange={(_, data) => setPassword(data.value)}/></Field>
          {register && <Field label="显示名称"><Input value={displayName} placeholder="例如：家用 NAS" autoComplete="nickname" onChange={(_, data) => setDisplayName(data.value)}/></Field>}
          <Button className="accessSubmit" appearance="primary" type="submit">{register ? "创建并进入" : "进入控制台"}<span aria-hidden="true">↗</span></Button>
        </form>
        <div className="accessFormFoot"><span className="statusDot"/><span>数据由你掌控，连接随时就绪。</span><span className="monoLabel">P2P</span></div>
      </section>
    </main>
    <div className="accessFeatureStrip"><span><b>01</b> 直连传输</span><span><b>02</b> 多端协作</span><span><b>03</b> 媒体随行</span><span className="monoLabel">BEYOND THE LOCAL / ALWAYS CONNECTED</span></div>
    <RegistryFooter/>
  </div>;
}
