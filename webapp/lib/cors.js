/**
 * The TV app calls these endpoints cross-origin (it isn't served from
 * this Next.js app's own domain), so every response needs CORS headers
 * or the browser-based fetch() on the TV silently fails — same bug
 * class as the one noted in the old pairing-backend's CLAUDE.md for
 * /api/poll and /api/refresh.
 *
 * Kept permissive (`*`) rather than locked to a specific origin: the
 * TV app has no fixed origin of its own (file:// during local/webOS
 * testing, an ares-package-assigned origin once installed), and these
 * routes don't rely on cookies/credentials for auth — the tvSessionId
 * and Supabase tokens in the request/response bodies are the actual
 * protection, matching how the old pairing-backend treated its
 * unguessable UUIDs and refresh token as sufficient without extra
 * origin locking.
 */
export function withCors(response) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
}

export function corsPreflight() {
  return withCors(new Response(null, { status: 204 }));
}
