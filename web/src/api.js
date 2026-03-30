function isLoopbackHost(hostname = "") {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function resolveBaseUrl() {
  const configured = import.meta.env.VITE_SERVER_BASE_URL || "";
  if (!configured) {
    return "";
  }
  try {
    const configuredUrl = new URL(configured);
    const pageHost = window.location?.hostname || "";
    if (!isLoopbackHost(pageHost) && isLoopbackHost(configuredUrl.hostname)) {
      return "";
    }
  } catch {
  }
  return configured;
}

const baseUrl = resolveBaseUrl();

export async function apiRequest(path, { method = "GET", token, body } = {}) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    const errorText = await response.text();
    try {
      const parsed = JSON.parse(errorText);
      throw new Error(parsed?.message || errorText || "request failed");
    } catch {
      throw new Error(errorText || "request failed");
    }
  }
  return response.json();
}

export function toWsUrl(token, options = {}) {
  const serverBase = baseUrl || window.location.origin;
  const wsBase = serverBase.replace(/^http/, "ws");
  const wsPath = options.channel === "chat" ? "/ws/chat" : "/ws";
  const url = new URL(wsPath, wsBase);
  url.searchParams.set("token", token);
  if (options.bridgeRole) {
    url.searchParams.set("bridgeRole", options.bridgeRole);
  }
  return url.toString();
}
