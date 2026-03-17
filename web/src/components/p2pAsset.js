import { useEffect, useMemo, useState } from "react";

const objectUrlCache = new Map();
const pendingLoadCache = new Map();
let cleanupRegistered = false;

function registerCleanup() {
  if (cleanupRegistered || typeof window === "undefined") {
    return;
  }
  cleanupRegistered = true;
  window.addEventListener("beforeunload", () => {
    for (const value of objectUrlCache.values()) {
      try {
        URL.revokeObjectURL(value);
      } catch {
      }
    }
    objectUrlCache.clear();
    pendingLoadCache.clear();
  });
}

export function isInlineDataUrl(value = "") {
  return /^data:/i.test(String(value || "").trim());
}

export function getP2PAssetCacheKey({ fileId = "", clientId = "", path = "", url = "" }) {
  if (fileId) {
    return `file:${fileId}`;
  }
  if (clientId && path) {
    return `path:${clientId}:${path}`;
  }
  if (url && !isInlineDataUrl(url)) {
    return `url:${url}`;
  }
  return "";
}

async function loadAssetFromStorage(p2p, asset) {
  const cacheKey = getP2PAssetCacheKey(asset);
  if (!cacheKey) {
    return "";
  }
  if (objectUrlCache.has(cacheKey)) {
    return objectUrlCache.get(cacheKey);
  }
  const pending = pendingLoadCache.get(cacheKey);
  if (pending) {
    return pending;
  }
  if (!p2p || !asset.clientId || !asset.path) {
    return "";
  }
  registerCleanup();
  const nextPending = p2p.downloadFile(asset.clientId, asset.path)
    .then((result) => {
      const nextUrl = URL.createObjectURL(result.blob);
      objectUrlCache.set(cacheKey, nextUrl);
      pendingLoadCache.delete(cacheKey);
      return nextUrl;
    })
    .catch((error) => {
      pendingLoadCache.delete(cacheKey);
      throw error;
    });
  pendingLoadCache.set(cacheKey, nextPending);
  return nextPending;
}

export function useResolvedP2PAssetUrl({ directUrl = "", url = "", clientId = "", path = "", fileId = "", p2p }) {
  const resolvedDirectUrl = directUrl || (url && !isInlineDataUrl(url) ? url : "");
  const cacheKey = useMemo(
    () => getP2PAssetCacheKey({ url, clientId, path, fileId }),
    [clientId, fileId, path, url]
  );
  const [resolvedUrl, setResolvedUrl] = useState(() => resolvedDirectUrl || (cacheKey && objectUrlCache.get(cacheKey)) || "");

  useEffect(() => {
    let cancelled = false;

    if (resolvedDirectUrl) {
      setResolvedUrl(resolvedDirectUrl);
      return () => {
        cancelled = true;
      };
    }

    if (!cacheKey) {
      setResolvedUrl("");
      return () => {
        cancelled = true;
      };
    }

    const cachedUrl = objectUrlCache.get(cacheKey);
    if (cachedUrl) {
      setResolvedUrl(cachedUrl);
      return () => {
        cancelled = true;
      };
    }

    setResolvedUrl("");
    loadAssetFromStorage(p2p, { url, clientId, path, fileId })
      .then((nextUrl) => {
        if (!cancelled) {
          setResolvedUrl(nextUrl || "");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedUrl("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, clientId, fileId, path, p2p, resolvedDirectUrl, url]);

  return resolvedUrl;
}