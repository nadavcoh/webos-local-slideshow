const crypto = require("crypto");

/**
 * GET /api/start?state=<pairing-code>&key=<shared secret>
 *
 * The TV generates a random, single-use `state` value and shows it (as
 * part of this URL, plus the shared secret) as a QR code. Opening it on
 * a phone lands here.
 *
 * Two layers of protection stop a stranger who stumbles onto this URL
 * from spinning up OAuth consent flows against your Google Cloud
 * project (and burning your quota / triggering abuse flags) using
 * their own Google account:
 *   1. `key` must match PAIRING_SHARED_SECRET — without it, this
 *      endpoint refuses outright.
 *   2. The `state` handed to Google is signed (HMAC-SHA256) with that
 *      same secret. /api/callback verifies the signature before doing
 *      anything, so even someone who copies your public client_id and
 *      hits Google's consent screen directly — skipping this endpoint
 *      entirely — can't produce a state that callback.js will accept.
 *
 * Caveat: the shared secret ships inside the packaged TV app (same as
 * any client-side secret), so a determined person with access to the
 * .ipk file could extract it. This is meant to stop casual/automated
 * discovery of a public Vercel URL, not a targeted attacker with your
 * TV in hand.
 */
module.exports = (req, res) => {
  const { state, key } = req.query;

  if (!state || typeof state !== "string") {
    res.status(400).send("Missing state parameter.");
    return;
  }

  if (!process.env.PAIRING_SHARED_SECRET || key !== process.env.PAIRING_SHARED_SECRET) {
    // Generic message either way — don't give a guesser feedback on
    // whether they're close.
    res.status(403).send("Forbidden.");
    return;
  }

  const signature = crypto
    .createHmac("sha256", process.env.PAIRING_SHARED_SECRET)
    .update(state)
    .digest("hex");
  const signedState = `${state}.${signature}`;

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
    access_type: "offline", // required to get a refresh_token back
    prompt: "consent",      // force a fresh refresh_token on every pairing
    state: signedState,
  });

  res.writeHead(302, {
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  });
  res.end();
};
