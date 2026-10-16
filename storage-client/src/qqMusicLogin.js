// QQ Music sign-in by scanning a QR code with mobile QQ or WeChat. The resulting cookie is
// written to the music-lib-bridge .env (QQ_COOKIE), which the bridge re-reads on
// its next request. The credential stays on this storage node.
import fs from "node:fs";
import crypto from "node:crypto";

const QQ_APP_ID = "716027609";
const QQ_MUSIC_AID = "100497308";
const LOGIN_JUMP = "https://graph.qq.com/oauth2.0/login_jump";
const MUSIC_REDIRECT = "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SESSION_TTL_MS = 3 * 60_000;
const WECHAT_APP_ID = "wx48db31d50e334801";
const WECHAT_REDIRECT = "https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/";

// ptlogin's token for a cookie value (qrsig → ptqrtoken).
export function hash33(value = "") {
  let hash = 0;
  for (const ch of String(value)) {
    hash += (hash << 5) + ch.charCodeAt(0);
  }
  return hash & 0x7fffffff;
}

// QQ's g_tk from p_skey.
export function gtk(value = "") {
  let hash = 5381;
  for (const ch of String(value)) {
    hash += (hash << 5) + ch.charCodeAt(0);
  }
  return hash & 0x7fffffff;
}

// ptuiCB('66','0','','0','二维码未失效。', '') → ["66", "0", "", "0", "二维码未失效。", ""]
export function parsePtuiCallback(text = "") {
  const args = [];
  const pattern = /'((?:[^'\\]|\\.)*)'/g;
  let match;
  while ((match = pattern.exec(String(text)))) {
    args.push(match[1]);
  }
  return args;
}

const WECHAT_STATES = {
  "408": { status: "waiting", message: "请用微信扫码" },
  "404": { status: "scanned", message: "已扫码，请在微信上确认登录" },
  "402": { status: "expired", message: "二维码已过期，请重新获取" },
  "403": { status: "expired", message: "已在微信上取消登录" }
};

const POLL_STATES = {
  "66": { status: "waiting", message: "请用手机 QQ 扫码" },
  "67": { status: "scanned", message: "已扫码，请在手机上确认登录" },
  "65": { status: "expired", message: "二维码已过期，请重新获取" },
  "68": { status: "expired", message: "已在手机上拒绝登录" }
};

export function setEnvLines(filePath, values = {}) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").split(/\r?\n/) : [];
  const pending = new Map(Object.entries(values));
  const lines = existing.map((line) => {
    const key = line.slice(0, line.indexOf("=")).trim();
    if (line.includes("=") && pending.has(key)) {
      const value = pending.get(key);
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  while (lines.length && lines.at(-1) === "") {
    lines.pop();
  }
  for (const [key, value] of pending) {
    lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function readEnvValue(filePath, key) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  const line = fs.readFileSync(filePath, "utf8").split(/\r?\n/).find((item) => item.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : "";
}

function maskUin(uin = "") {
  const text = String(uin).replace(/^o0*/, "");
  return text.length > 4 ? `${text.slice(0, 2)}****${text.slice(-2)}` : text;
}

export function createQqMusicLogin({ envFile, fetchImpl = fetch, now = () => Date.now(), logger = () => {} } = {}) {
  let session = null;

  const request = async (url, { cookies = {}, method = "GET", body, headers = {} } = {}) => {
    const response = await fetchImpl(url, {
      method,
      body,
      redirect: "manual",
      headers: {
        "User-Agent": USER_AGENT,
        Cookie: Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join("; "),
        ...headers
      }
    });
    for (const line of response.headers.getSetCookie?.() || []) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      const key = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (key && value) {
        cookies[key] = value;
      }
    }
    return response;
  };

  async function finishLogin(checkSigUrl, cookies) {
    await request(checkSigUrl, { cookies, headers: { Referer: "https://xui.ptlogin2.qq.com/" } });
    if (!cookies.p_skey) {
      throw new Error("QQ 登录未返回 p_skey");
    }
    const form = new URLSearchParams({
      response_type: "code",
      client_id: QQ_MUSIC_AID,
      redirect_uri: MUSIC_REDIRECT,
      scope: "get_user_info,get_app_friends",
      state: "state",
      switch: "",
      from_ptlogin: "1",
      src: "1",
      update_auth: "1",
      openapi: "1010_1030",
      g_tk: String(gtk(cookies.p_skey)),
      auth_time: String(now()),
      ui: crypto.randomUUID()
    });
    const authorize = await request("https://graph.qq.com/oauth2.0/authorize", {
      cookies,
      method: "POST",
      body: form.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "https://graph.qq.com/" }
    });
    const code = new URL(authorize.headers.get("location") || "", "https://y.qq.com").searchParams.get("code");
    if (!code) {
      throw new Error("QQ 授权未返回 code");
    }
    const loginResponse = await request("https://u.y.qq.com/cgi-bin/musicu.fcg", {
      cookies,
      method: "POST",
      body: JSON.stringify({
        comm: { g_tk: 5381, platform: "yqq", ct: 24, cv: 0 },
        req: { module: "QQConnectLogin.LoginServer", method: "QQLogin", param: { code } }
      }),
      headers: { "Content-Type": "application/json", Referer: "https://y.qq.com/" }
    });
    const payload = await loginResponse.json().catch(() => ({}));
    const data = payload?.req?.data || {};
    const musicKey = String(data.musickey || cookies.qqmusic_key || cookies.qm_keyst || "");
    const musicId = String(data.musicid || "").trim() || String(cookies.uin || "").replace(/^o0*/, "");
    if (!musicKey || !musicId) {
      throw new Error(`QQ 音乐登录失败（code=${payload?.req?.code ?? "?"}）`);
    }
    return saveCookie(`uin=${musicId}; qqmusic_key=${musicKey}; qm_keyst=${musicKey}`, musicId, data, "qq");
  }

  function saveCookie(header, musicId, data, provider) {
    const expiresIn = Number(data.keyExpiresIn || data.expired_in || 0);
    setEnvLines(envFile, {
      QQ_COOKIE: header,
      QQ_COOKIE_REFRESHED_AT: new Date(now()).toISOString(),
      QQ_COOKIE_EXPIRES_AT: expiresIn > 0 ? new Date(now() + expiresIn * 1000).toISOString() : "",
      QQ_COOKIE_PROVIDER: provider
    });
    logger("qq-music-login-success", provider, maskUin(musicId));
    return maskUin(musicId);
  }

  async function finishWechatLogin(code) {
    const response = await request("https://u.y.qq.com/cgi-bin/musicu.fcg", {
      method: "POST",
      body: JSON.stringify({
        comm: { g_tk: 5381, platform: "yqq", ct: 24, cv: 0, tmeLoginType: 1 },
        req: { module: "music.login.LoginServer", method: "Login", param: { code, strAppid: WECHAT_APP_ID } }
      }),
      headers: { "Content-Type": "application/json", Referer: "https://y.qq.com/" }
    });
    const payload = await response.json().catch(() => ({}));
    const data = payload?.req?.data || {};
    const musicKey = String(data.musickey || "");
    const musicId = String(data.musicid || "").trim();
    if (!musicKey || !musicId) {
      throw new Error(`微信登录 QQ 音乐失败（code=${payload?.req?.code ?? "?"}）`);
    }
    return saveCookie(`uin=${musicId}; wxuin=o${musicId}; qqmusic_key=${musicKey}; qm_keyst=${musicKey}; tmeLoginType=1`, musicId, data, "wechat");
  }

  // WeChat answers a long poll (about 25 s) only when the state changes, so it runs
  // in the background and poll() reports the latest state.
  async function watchWechat(current) {
    let last = "";
    while (session === current && now() - current.startedAt < SESSION_TTL_MS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35_000);
      let text = "";
      try {
        const response = await fetchImpl(`https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=${current.uuid}${last ? `&last=${last}` : ""}&_=${now()}`, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
        text = await response.text();
      } catch {
        continue;
      } finally {
        clearTimeout(timer);
      }
      const errcode = (text.match(/wx_errcode=(\d+)/) || [])[1] || "";
      const code = (text.match(/wx_code='([^']*)'/) || [])[1] || "";
      if (errcode === "405" && code) {
        try {
          const account = await finishWechatLogin(code);
          Object.assign(current, { status: "success", message: "登录成功，点歌台已切换到这个 QQ 音乐账号", account });
        } catch (error) {
          Object.assign(current, { status: "error", message: error.message });
        }
        return;
      }
      const state = WECHAT_STATES[errcode];
      if (state) {
        Object.assign(current, state);
        if (state.status === "expired") return;
      }
      last = errcode || last;
    }
  }

  return {
    status() {
      const cookie = readEnvValue(envFile, "QQ_COOKIE");
      const uin = (cookie.match(/(?:^|;\s*)uin=([^;]+)/) || [])[1] || "";
      return {
        loggedIn: /qqmusic_key=|qm_keyst=/.test(cookie),
        account: maskUin(uin),
        refreshedAt: readEnvValue(envFile, "QQ_COOKIE_REFRESHED_AT"),
        expiresAt: readEnvValue(envFile, "QQ_COOKIE_EXPIRES_AT"),
        provider: readEnvValue(envFile, "QQ_COOKIE_PROVIDER") || "qq"
      };
    },

    async start(provider = "qq") {
      if (provider === "wechat") {
        const page = await fetchImpl(`https://open.weixin.qq.com/connect/qrconnect?appid=${WECHAT_APP_ID}&redirect_uri=${encodeURIComponent(WECHAT_REDIRECT)}&response_type=code&scope=snsapi_login&state=STATE`, { headers: { "User-Agent": USER_AGENT } });
        const uuid = ((await page.text()).match(/\/connect\/qrcode\/([A-Za-z0-9_-]+)/) || [])[1];
        if (!uuid) {
          throw new Error("获取微信登录二维码失败");
        }
        const imageResponse = await fetchImpl(`https://open.weixin.qq.com/connect/qrcode/${uuid}`, { headers: { "User-Agent": USER_AGENT } });
        const image = Buffer.from(await imageResponse.arrayBuffer());
        session = { provider: "wechat", uuid, startedAt: now(), ...WECHAT_STATES["408"] };
        void watchWechat(session);
        return { status: "waiting", message: WECHAT_STATES["408"].message, qrDataUrl: `data:image/jpeg;base64,${image.toString("base64")}` };
      }
      const cookies = {};
      const response = await request(`https://ssl.ptlogin2.qq.com/ptqrshow?appid=${QQ_APP_ID}&e=2&l=M&s=3&d=72&v=4&t=${Math.random()}&daid=383&pt_3rd_aid=${QQ_MUSIC_AID}`, {
        cookies,
        headers: { Referer: "https://xui.ptlogin2.qq.com/" }
      });
      const image = Buffer.from(await response.arrayBuffer());
      if (!response.ok || !cookies.qrsig || !image.length) {
        throw new Error("获取 QQ 登录二维码失败");
      }
      session = { provider: "qq", cookies, startedAt: now(), status: "waiting" };
      return { status: "waiting", message: POLL_STATES["66"].message, qrDataUrl: `data:image/png;base64,${image.toString("base64")}` };
    },

    async poll() {
      if (!session) {
        return { status: "idle", message: "还没有开始扫码登录" };
      }
      if (session.status === "success") {
        return { status: "success", message: "登录成功", account: session.account };
      }
      if (session.provider === "wechat") {
        if (now() - session.startedAt > SESSION_TTL_MS) {
          session = null;
          return WECHAT_STATES["402"];
        }
        return { status: session.status, message: session.message, ...(session.account ? { account: session.account } : {}) };
      }
      if (now() - session.startedAt > SESSION_TTL_MS) {
        session = null;
        return POLL_STATES["65"];
      }
      const { cookies } = session;
      const response = await request(`https://ssl.ptlogin2.qq.com/ptqrlogin?u1=${encodeURIComponent(LOGIN_JUMP)}&ptqrtoken=${hash33(cookies.qrsig)}&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=0-0-${now()}&js_ver=23111510&js_type=1&login_sig=&pt_uistyle=40&aid=${QQ_APP_ID}&daid=383&pt_3rd_aid=${QQ_MUSIC_AID}`, {
        cookies,
        headers: { Referer: "https://xui.ptlogin2.qq.com/" }
      });
      const [code, , checkSigUrl] = parsePtuiCallback(await response.text());
      if (code !== "0") {
        const state = POLL_STATES[code] || { status: "error", message: `QQ 登录返回 ${code || "未知状态"}` };
        if (state.status === "expired") {
          session = null;
        }
        return state;
      }
      const account = await finishLogin(checkSigUrl, cookies);
      session = { ...session, status: "success", account };
      return { status: "success", message: "登录成功，点歌台已切换到这个 QQ 音乐账号", account };
    }
  };
}
