const { kv } = require("@vercel/kv");

/**
 * GET /api/poll?state=<pairing-code>
 *
 * The TV polls this every few seconds. Returns 202 while waiting, and
 * 200 with the tokens + Picker session id once /api/callback has
 * stored them. Single-use: the entry is deleted as soon as it's
 * collected, so a leaked/guessed `state` is only useful for a brief
 * window and only once.
 */
module.exports = async (req, res) => {
  // The TV app's origin (file://, http://localhost during testing, or
  // whatever webOS assigns the packaged app) is always cross-origin
  // relative to this backend, so this needs an explicit CORS header —
  // Vercel functions don't send one by default. No credentials/cookies
  // are involved here (auth is the shared secret + HMAC-signed state,
  // not same-origin), so a wildcard is fine.
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { state } = req.query;

  if (!state || typeof state !== "string") {
    res.status(400).json({ error: "missing_state" });
    return;
  }

  const raw = await kv.get(`pairing:${state}`);
  if (!raw) {
    res.status(202).json({ status: "pending" });
    return;
  }

  await kv.del(`pairing:${state}`);
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  res.status(200).json(data);
};
