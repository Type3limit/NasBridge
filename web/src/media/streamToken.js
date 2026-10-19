// Playback-only token for /api/tv/stream and /api/anime/proxy-stream.
// <video src> and native HLS cannot send an Authorization header, so proxied URLs
// carry this short-lived token as ?st= instead of the login token.
let cached = null; // { token, expiresAt, authToken }
let pending = null;

export async function getMediaToken(authToken) {
  if (cached && cached.authToken === authToken && cached.expiresAt - Date.now() > 60 * 60 * 1000) {
    return cached.token;
  }
  if (!pending) {
    pending = fetch("/api/media/token", { headers: { Authorization: `Bearer ${authToken}` } })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(({ token, expiresInSec }) => {
        cached = { token, authToken, expiresAt: Date.now() + expiresInSec * 1000 };
        return token;
      })
      .finally(() => { pending = null; });
  }
  return pending;
}
