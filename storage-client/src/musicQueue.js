// Song-request rules for the shared music queue. Pure functions so the
// ordering can be tested without the player, its bridge or the network.

export const MAX_PENDING_PER_USER = 2;
export const REQUEST_COOLDOWN_MS = 30_000;

export function requesterKey(track = {}) {
  return String(track.submittedById || track.submittedBy || "anonymous");
}

export function normalizeActor(actor = null) {
  if (!actor || typeof actor !== "object") {
    return null;
  }
  const id = String(actor.id || "").trim();
  if (!id) {
    return null;
  }
  return {
    id,
    name: String(actor.name || actor.displayName || "").trim(),
    isAdmin: actor.role === "admin"
  };
}

// Upcoming songs play in rounds: everyone's first waiting song, then everyone's
// second. Inside a round more likes go first and ties keep request order. A song
// an admin pinned plays before every round. The person whose song is playing has
// already used the current round.
export function orderUpcoming(tracks = [], { playing = null } = {}) {
  const byRequest = [...tracks].sort((left, right) => String(left.submittedAt || "").localeCompare(String(right.submittedAt || "")));
  const seen = new Map(playing ? [[requesterKey(playing), 1]] : []);
  const ranked = byRequest.map((track, position) => {
    const key = requesterKey(track);
    const round = seen.get(key) || 0;
    seen.set(key, round + 1);
    return { track, round, position };
  });
  ranked.sort((left, right) => {
    const pinned = Number(Boolean(right.track.pinnedAt)) - Number(Boolean(left.track.pinnedAt));
    if (pinned) return pinned;
    if (left.track.pinnedAt && right.track.pinnedAt) return String(left.track.pinnedAt).localeCompare(String(right.track.pinnedAt));
    if (left.round !== right.round) return left.round - right.round;
    const votes = voteCount(right.track) - voteCount(left.track);
    if (votes) return votes;
    return left.position - right.position;
  });
  return ranked.map(({ track, round }) => ({ ...track, round }));
}

export function voteCount(track = {}) {
  return Array.isArray(track.votes) ? track.votes.length : 0;
}

// Why this person may not request another song right now; "" when they may.
export function checkRequestAllowed({ upcoming = [], current = null, actor = null, candidate = {}, now = Date.now(), lastRequestAt = 0 }) {
  const providerTrackId = String(candidate.providerTrackId || "");
  if (providerTrackId && [current, ...upcoming].some((track) => track && String(track.providerTrackId || "") === providerTrackId)) {
    return "这首歌已经在队列里了，给它点个赞吧";
  }
  if (!actor || actor.isAdmin) {
    return "";
  }
  const pending = upcoming.filter((track) => String(track.submittedById || "") === actor.id).length;
  if (pending >= MAX_PENDING_PER_USER) {
    return `每人最多同时排 ${MAX_PENDING_PER_USER} 首，等你点的歌播完再来`;
  }
  const waitMs = REQUEST_COOLDOWN_MS - (now - lastRequestAt);
  if (lastRequestAt && waitMs > 0) {
    return `点歌太快了，${Math.ceil(waitMs / 1000)} 秒后再试`;
  }
  return "";
}
