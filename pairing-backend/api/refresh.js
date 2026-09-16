/**
 * POST /api/refresh
 * Body: { "refreshToken": "..." }
 *
 * The TV calls this instead of talking to Google's token endpoint
 * directly, so the client secret never has to live inside the
 * packaged TV app.
 */
module.exports = async (req, res) => {
  // Same CORS reasoning as poll.js. This endpoint is POSTed to with a
  // JSON body, which triggers a CORS *preflight* (an OPTIONS request)
  // first — that needs its own response with the Allow-Methods/Headers
  // set, separate from the real POST handling below.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    res.status(400).json({ error: "missing_refresh_token" });
    return;
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const tokens = await tokenRes.json();

  if (!tokenRes.ok) {
    // Surface Google's status/body as-is — the TV treats a 400 here
    // (e.g. invalid_grant, meaning the refresh token was revoked) as a
    // signal to clear its stored token and re-pair from scratch.
    res.status(tokenRes.status).json(tokens);
    return;
  }

  res.status(200).json({
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in,
  });
};
