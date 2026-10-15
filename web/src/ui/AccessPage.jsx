import { Button, Field, Input } from "@fluentui/react-components";
import { PageMasthead, RegistryFooter } from "./IndustrialChrome";
import { sceneClass, tacticalArt } from "./tacticalArt";

export default function AccessPage({ mode, setMode, email, setEmail, password, setPassword, displayName, setDisplayName, onSubmit, toast }) {
  const register = mode === "register";
  return <div className="page accessPage">
    {toast}
    <PageMasthead/>
    <main className="accessStage">
      <img className={`accessArtwork ${sceneClass(tacticalArt.accessHero)}`} src={tacticalArt.accessHero} alt="" aria-hidden="true" fetchpriority="low" decoding="async"/>
      <div className="accessHeroScrim"/>
      <div className="accessColumn">
        <div className="accessTitle">
          <h1><span className="accessTitleAnchor">NAS</span><span>BRIDGE</span></h1>
          <p>连接，无限可能。将远端存储、媒体与协作，汇聚于你的私人云端。</p>
        </div>
        <section className="accessFormPanel" aria-label={register ? "创建账户" : "登录账户"}>
          <div className="accessFormTitle"><span className="industrialEyebrow">{register ? "注册 / REGISTER" : "登录 / SIGN IN"}</span><h2>{register ? "创建你的连接" : "欢迎回到工作台"}</h2></div>
          <div className="accessModeSwitch" role="tablist" aria-label="账户操作"><button type="button" role="tab" aria-selected={!register} onClick={() => setMode("login")}>登录 <span>01</span></button><button type="button" role="tab" aria-selected={register} onClick={() => setMode("register")}>注册 <span>02</span></button></div>
          <form className="accessForm" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
            <Field label="邮箱地址"><Input type="email" value={email} placeholder="name@example.com" autoComplete="email" onChange={(_, data) => setEmail(data.value)}/></Field>
            <Field label="密码"><Input type="password" value={password} placeholder="输入登录密码" autoComplete={register ? "new-password" : "current-password"} onChange={(_, data) => setPassword(data.value)}/></Field>
            {register && <Field label="显示名称"><Input value={displayName} placeholder="例如：家用 NAS" autoComplete="nickname" onChange={(_, data) => setDisplayName(data.value)}/></Field>}
            <Button className="accessSubmit" appearance="primary" type="submit">{register ? "创建并进入" : "进入控制台"}<span aria-hidden="true">→</span></Button>
          </form>
        </section>
      </div>
      <div className="tacAccessTape" aria-hidden="true"><div className="tacTapeRun"><span>RESTRICTED ACCESS · AUTHORIZED OPERATORS ONLY · PRIVATE STORAGE NETWORK · RESTRICTED ACCESS · AUTHORIZED OPERATORS ONLY · PRIVATE STORAGE NETWORK · </span><span>RESTRICTED ACCESS · AUTHORIZED OPERATORS ONLY · PRIVATE STORAGE NETWORK · RESTRICTED ACCESS · AUTHORIZED OPERATORS ONLY · PRIVATE STORAGE NETWORK · </span></div></div>
    </main>
    <div className="accessFeatureStrip"><span><b>01</b> 直连传输</span><span><b>02</b> 多端协作</span><span><b>03</b> 媒体随行</span></div>
    <RegistryFooter/>
  </div>;
}
