import fs from "node:fs";
import path from "node:path";

const PLAYWRIGHT_BROWSER_MISSING_PATTERN = /Executable doesn't exist|browserType\.launch:.*executable/i;

function readFirstEnv(names = [], fallback = "") {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) {
      return value;
    }
  }
  return fallback;
}

function readBooleanEnv(names = [], fallback = true) {
  for (const name of names) {
    if (!(name in process.env)) {
      continue;
    }
    return process.env[name] !== "0";
  }
  return fallback;
}

function buildScopedEnvNames(scope = "", suffix = "") {
  const normalizedScope = String(scope || "").trim().toUpperCase();
  const names = [];
  if (normalizedScope) {
    names.push(`${normalizedScope}_${suffix}`);
  }
  names.push(`PLAYWRIGHT_${suffix}`);
  return names;
}

export function getPlaywrightSettings(scope = "") {
  return {
    executablePath: readFirstEnv(buildScopedEnvNames(scope, "EXECUTABLE_PATH")),
    headless: readBooleanEnv(buildScopedEnvNames(scope, "HEADLESS"), true),
    proxy: readFirstEnv(buildScopedEnvNames(scope, "PROXY"))
  };
}

export function getPlaywrightExecutableCandidates(scope = "") {
  const settings = getPlaywrightSettings(scope);
  const candidates = [];
  if (settings.executablePath) {
    candidates.push(settings.executablePath);
  }
  if (process.platform === "win32") {
    const localAppData = String(process.env.LOCALAPPDATA || "").trim();
    candidates.push(
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
    );
    if (localAppData) {
      candidates.push(
        `${localAppData}/Google/Chrome/Application/chrome.exe`,
        `${localAppData}/Microsoft/Edge/Application/msedge.exe`
      );
    }
  }
  return [...new Set(candidates.map((item) => String(item || "").trim()).filter(Boolean))];
}

export function resolveExistingPlaywrightExecutable(scope = "") {
  for (const candidate of getPlaywrightExecutableCandidates(scope)) {
    const normalized = candidate.replace(/\//g, path.sep);
    if (fs.existsSync(normalized)) {
      return normalized;
    }
  }
  return "";
}

export async function loadPlaywrightChromium() {
  const mod = await import("playwright");
  return mod.chromium || mod.default?.chromium || null;
}

export async function launchPlaywrightBrowser(options = {}) {
  const scope = String(options.scope || "").trim().toUpperCase();
  const chromium = options.chromium || await loadPlaywrightChromium();
  if (!chromium) {
    throw new Error("playwright chromium is unavailable");
  }
  const settings = getPlaywrightSettings(scope);
  const baseOptions = {
    headless: typeof options.headless === "boolean" ? options.headless : settings.headless,
    proxy: options.proxy === undefined
      ? (settings.proxy ? { server: settings.proxy } : undefined)
      : (options.proxy ? { server: options.proxy } : undefined)
  };
  const preferredExecutable = options.executablePath || resolveExistingPlaywrightExecutable(scope);
  if (preferredExecutable) {
    return chromium.launch({
      ...baseOptions,
      executablePath: preferredExecutable
    });
  }
  try {
    return await chromium.launch(baseOptions);
  } catch (error) {
    if (!PLAYWRIGHT_BROWSER_MISSING_PATTERN.test(String(error?.message || error || ""))) {
      throw error;
    }
    const fallbackExecutable = resolveExistingPlaywrightExecutable(scope);
    if (!fallbackExecutable) {
      throw error;
    }
    return chromium.launch({
      ...baseOptions,
      executablePath: fallbackExecutable
    });
  }
}