#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const DEFAULT_URL = "https://y.qq.com/";
const DEFAULT_PORT = 9222;
const REQUIRED_COOKIE_GROUPS = [
  ["uin"],
  ["qqmusic_key", "qm_keyst"]
];

function parseArgs(argv) {
  const args = {
    envFile: path.resolve(process.cwd(), ".env"),
    url: DEFAULT_URL,
    port: DEFAULT_PORT,
    proxyUrl: "http://127.0.0.1:3456",
    timeoutMs: 15000,
    quiet: false,
    keepTab: false,
    allowPartial: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1];
    switch (item) {
      case "--env":
        args.envFile = path.resolve(next || args.envFile);
        index += 1;
        break;
      case "--url":
        args.url = next || args.url;
        index += 1;
        break;
      case "--port":
        args.port = Number(next || args.port) || args.port;
        index += 1;
        break;
      case "--proxy-url":
        args.proxyUrl = String(next || args.proxyUrl).replace(/\/+$/, "");
        index += 1;
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(next || args.timeoutMs) || args.timeoutMs;
        index += 1;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "--keep-tab":
        args.keepTab = true;
        break;
      case "--allow-partial":
        args.allowPartial = true;
        break;
      default:
        if (item?.startsWith("--")) {
          throw new Error(`Unknown option: ${item}`);
        }
        break;
    }
  }
  return args;
}

function log(args, ...parts) {
  if (!args.quiet) {
    console.log("[qq-cookie-refresh]", ...parts);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.json();
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.text();
}

function readEdgeDevToolsActivePort() {
  if (process.platform !== "win32") {
    return null;
  }
  const localAppData = process.env.LOCALAPPDATA || "";
  if (!localAppData) {
    return null;
  }
  const filePath = path.join(localAppData, "Microsoft", "Edge", "User Data", "DevToolsActivePort");
  try {
    const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
    const port = Number(lines[0] || 0);
    const wsPath = lines[1] || "";
    if (port > 0 && wsPath) {
      return { port, wsPath, filePath };
    }
  } catch {
  }
  return null;
}

async function discoverBrowserWsUrl(args) {
  try {
    const version = await fetchJson(`http://127.0.0.1:${args.port}/json/version`);
    if (version.webSocketDebuggerUrl) {
      return version.webSocketDebuggerUrl;
    }
  } catch {
  }
  const edge = readEdgeDevToolsActivePort();
  if (edge) {
    args.port = edge.port;
    return `ws://127.0.0.1:${edge.port}${edge.wsPath}`;
  }
  throw new Error(`Unable to discover Edge CDP websocket. Open edge://inspect/#remote-debugging and enable Allow remote debugging for this browser instance.`);
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect(timeoutMs) {
    if (typeof WebSocket !== "function") {
      throw new Error("Native WebSocket is unavailable; use Node.js 22+.");
    }
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket connect timeout")), timeoutMs);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP websocket connect failed"));
      }, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (!payload.id || !this.pending.has(payload.id)) {
        return;
      }
      const item = this.pending.get(payload.id);
      this.pending.delete(payload.id);
      clearTimeout(item.timer);
      if (payload.error) {
        item.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
      } else {
        item.resolve(payload.result || {});
      }
    });
  }

  send(method, params = {}, sessionId = "", timeoutMs = 15000) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
    }
  }
}

function cookieDomainScore(cookie) {
  const domain = String(cookie.domain || "").toLowerCase();
  const pathValue = String(cookie.path || "");
  let score = 0;
  if (domain === "y.qq.com") score += 50;
  else if (domain.endsWith(".y.qq.com")) score += 45;
  else if (domain === "qq.com") score += 35;
  else if (domain.endsWith(".qq.com")) score += 30;
  if (domain.includes("music")) score += 10;
  score += Math.min(10, pathValue.length);
  const expires = Number(cookie.expires || 0);
  if (Number.isFinite(expires) && expires > 0) {
    score += Math.min(20, Math.floor(expires / 86400 / 30));
  }
  return score;
}

function isQqCookie(cookie) {
  const domain = String(cookie.domain || "").toLowerCase().replace(/^\./, "");
  return domain === "qq.com" || domain.endsWith(".qq.com");
}

function normalizeCookieValue(value = "") {
  return String(value || "").replace(/[\r\n]/g, "").trim();
}

function buildCookieHeader(cookies = []) {
  const bestByName = new Map();
  for (const cookie of cookies.filter(isQqCookie)) {
    const name = String(cookie.name || "").trim();
    const value = normalizeCookieValue(cookie.value || "");
    if (!name || !value) {
      continue;
    }
    const current = bestByName.get(name);
    if (!current || cookieDomainScore(cookie) >= cookieDomainScore(current)) {
      bestByName.set(name, { ...cookie, name, value });
    }
  }
  const ordered = [...bestByName.values()].sort((left, right) => {
    const priority = ["uin", "qqmusic_key", "qm_keyst", "qqmusic_fromtag"];
    const leftPriority = priority.indexOf(left.name);
    const rightPriority = priority.indexOf(right.name);
    if (leftPriority !== rightPriority) {
      return (leftPriority < 0 ? 99 : leftPriority) - (rightPriority < 0 ? 99 : rightPriority);
    }
    return left.name.localeCompare(right.name);
  });
  return {
    header: ordered.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    names: ordered.map((cookie) => cookie.name)
  };
}

function parseCookieHeaderText(cookieText = "", domain = "y.qq.com") {
  return String(cookieText || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf("=");
      return {
        domain,
        path: "/",
        name: separator >= 0 ? item.slice(0, separator) : item,
        value: separator >= 0 ? item.slice(separator + 1) : ""
      };
    });
}

function getMissingCookieGroups(names = []) {
  const set = new Set(names);
  return REQUIRED_COOKIE_GROUPS
    .filter((group) => !group.some((name) => set.has(name)))
    .map((group) => group.join(" or "));
}

function setEnvLine(filePath, key, value) {
  const lines = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8").split(/\r?\n/)
    : [];
  let found = false;
  const nextLines = lines.map((line) => {
    if (line.match(new RegExp(`^\\s*${key}=`))) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    nextLines.push(`${key}=${value}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, nextLines.join("\n").replace(/\n{3,}$/g, "\n\n"), "utf8");
}

async function waitForReady(client, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await client.send("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true
      }, sessionId, 3000);
      const value = result?.result?.value;
      if (value === "interactive" || value === "complete") {
        return;
      }
    } catch {
    }
    await sleep(500);
  }
}

async function readCookiesWithCdp(args) {
  const wsUrl = await discoverBrowserWsUrl(args);

  const client = new CdpClient(wsUrl);
  let targetId = "";
  let sessionId = "";
  try {
    await client.connect(args.timeoutMs);
    const created = await client.send("Target.createTarget", {
      url: "about:blank",
      background: true
    }, "", args.timeoutMs);
    targetId = created.targetId;
    const attached = await client.send("Target.attachToTarget", {
      targetId,
      flatten: true
    }, "", args.timeoutMs);
    sessionId = attached.sessionId;
    await client.send("Page.enable", {}, sessionId, args.timeoutMs).catch(() => {});
    await client.send("Network.enable", {}, sessionId, args.timeoutMs).catch(() => {});
    await client.send("Page.navigate", { url: args.url }, sessionId, args.timeoutMs);
    await waitForReady(client, sessionId, args.timeoutMs);
    await sleep(2500);

    try {
      const result = await client.send("Network.getAllCookies", {}, sessionId, args.timeoutMs);
      if (Array.isArray(result.cookies) && result.cookies.length) {
        return result.cookies;
      }
    } catch {
    }

    const result = await client.send("Runtime.evaluate", {
      expression: "document.cookie",
      returnByValue: true
    }, sessionId, args.timeoutMs);
    const cookieText = String(result?.result?.value || "");
    return cookieText
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const separator = item.indexOf("=");
        return {
          domain: "y.qq.com",
          path: "/",
          name: separator >= 0 ? item.slice(0, separator) : item,
          value: separator >= 0 ? item.slice(separator + 1) : ""
        };
      });
  } finally {
    if (targetId && !args.keepTab) {
      await client.send("Target.closeTarget", { targetId }, "", 3000).catch(() => {});
    }
    client.close();
  }
}

async function readCookiesWithProxy(args) {
  const health = await fetchJson(`${args.proxyUrl}/health`);
  if (!health?.connected) {
    throw new Error(`web-access proxy is not connected: ${JSON.stringify(health)}`);
  }
  let targetId = "";
  try {
    const created = await fetchJson(`${args.proxyUrl}/new`, {
      method: "POST",
      body: args.url
    });
    targetId = created.targetId;
    if (!targetId) {
      throw new Error(`web-access proxy did not return targetId: ${JSON.stringify(created)}`);
    }
    await sleep(2500);
    const js = `(() => {
      const cookies = document.cookie || "";
      return {
        href: location.href,
        readyState: document.readyState,
        cookie: cookies,
        cookieNames: cookies.split(";").map((item) => item.trim().split("=")[0]).filter(Boolean)
      };
    })()`;
    const evaluated = await fetchJson(`${args.proxyUrl}/eval?target=${encodeURIComponent(targetId)}`, {
      method: "POST",
      body: js
    });
    const value = evaluated?.value || {};
    return parseCookieHeaderText(value.cookie || "", "y.qq.com");
  } finally {
    if (targetId && !args.keepTab) {
      await fetchText(`${args.proxyUrl}/close?target=${encodeURIComponent(targetId)}`).catch(() => {});
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log(args, `reading Edge cookies from ${args.url}`);
  let cookies = [];
  try {
    cookies = await readCookiesWithProxy(args);
  } catch (proxyError) {
    log(args, `web-access proxy read failed: ${proxyError?.message || proxyError}`);
    cookies = await readCookiesWithCdp(args);
  }
  const { header, names } = buildCookieHeader(cookies);
  if (!header) {
    throw new Error("No QQ cookies were found in the browser session.");
  }
  const missing = getMissingCookieGroups(names);
  if (missing.length && !args.allowPartial) {
    throw new Error(`QQ Music login cookies are incomplete; missing ${missing.join(", ")}. Open https://y.qq.com/ in Edge and sign in, then retry.`);
  }
  setEnvLine(args.envFile, "QQ_COOKIE", header);
  setEnvLine(args.envFile, "QQ_COOKIE_REFRESHED_AT", new Date().toISOString());
  log(args, `updated ${args.envFile}`);
  log(args, `cookie keys: ${names.join(", ")}`);
  if (missing.length) {
    log(args, `warning: missing ${missing.join(", ")}`);
  }
}

main().catch((error) => {
  console.error("[qq-cookie-refresh] failed:", error?.message || error);
  process.exit(1);
});
