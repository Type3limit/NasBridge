// Removes ads that resource-site CDNs splice into VOD playlists.
// The ads are short runs between #EXT-X-DISCONTINUITY tags whose segments live in a
// different directory from the episode itself (e.g. /20261009/l7aBZIKL/10152kb/hls/
// inside an episode stored under /20231028/3BMRArnT/1051kb/hls/).

const MAX_AD_GROUP_SECONDS = 120;
const MIN_MAIN_SHARE = 0.6;

function segmentDir(uri) {
  let target = uri;
  // Proxied URIs wrap the real one: /api/anime/proxy-stream?url=<encoded>&ref=…
  const wrapped = uri.match(/[?&]url=([^&]+)/);
  if (wrapped) {
    try { target = decodeURIComponent(wrapped[1]); } catch {}
  }
  const path = target.split("?")[0];
  return path.slice(0, path.lastIndexOf("/") + 1);
}

export function stripAdSegments(text) {
  if (typeof text !== "string" || !text.includes("#EXT-X-DISCONTINUITY") || text.includes("#EXT-X-STREAM-INF")) {
    return { text, removed: 0 };
  }
  const head = [];
  const segments = [];
  let pending = [];
  let group = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    if (t.startsWith("#")) {
      if (t === "#EXT-X-DISCONTINUITY") {
        group++;
        pending.push(line);
      } else if (segments.length === 0 && pending.length === 0 && !t.startsWith("#EXTINF") && !t.startsWith("#EXT-X-KEY")) {
        head.push(line);
      } else {
        pending.push(line);
      }
      continue;
    }
    const extinf = pending.find((l) => l.startsWith("#EXTINF:"));
    segments.push({ lines: [...pending, line], group, dir: segmentDir(t), dur: parseFloat(extinf?.slice(8)) || 0 });
    pending = [];
  }
  if (segments.length < 10) {
    return { text, removed: 0 };
  }

  const dirCounts = new Map();
  for (const seg of segments) {
    dirCounts.set(seg.dir, (dirCounts.get(seg.dir) || 0) + 1);
  }
  const [mainDir, mainCount] = [...dirCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (mainCount / segments.length < MIN_MAIN_SHARE) {
    return { text, removed: 0 };
  }

  const groups = new Map();
  for (const seg of segments) {
    const g = groups.get(seg.group) || { foreign: true, dur: 0 };
    g.foreign = g.foreign && seg.dir !== mainDir;
    g.dur += seg.dur;
    groups.set(seg.group, g);
  }
  const adGroups = new Set([...groups.entries()]
    .filter(([, g]) => g.foreign && g.dur <= MAX_AD_GROUP_SECONDS)
    .map(([id]) => id));
  if (adGroups.size === 0) {
    return { text, removed: 0 };
  }
  const kept = segments.filter((seg) => !adGroups.has(seg.group));
  return {
    text: [...head, ...kept.flatMap((seg) => seg.lines), ...pending].join("\n"),
    removed: segments.length - kept.length,
  };
}

// hls.js playlist loader that runs stripAdSegments on every media playlist.
export function createAdFilterLoader(Hls, onRemoved) {
  const BaseLoader = Hls.DefaultConfig.loader;
  return class AdFilterLoader extends BaseLoader {
    load(context, config, callbacks) {
      const onSuccess = callbacks.onSuccess;
      callbacks.onSuccess = (response, stats, ctx, networkDetails) => {
        const result = stripAdSegments(response.data);
        if (result.removed > 0) {
          response.data = result.text;
          onRemoved?.(result.removed);
        }
        onSuccess(response, stats, ctx, networkDetails);
      };
      super.load(context, config, callbacks);
    }
  };
}
