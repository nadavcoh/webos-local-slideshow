# CLAUDE.md — session recovery notes

This file exists so a new Claude session can get oriented on this
project quickly, without re-reading the whole chat history. It
summarizes *why* things are built the way they are — the README covers
*how* to set them up.

## What this is

An ambient Google Photos slideshow for an LG webOS 4K TV. Dark 16:9
"lean-back" UI, 15s crossfades, timestamp overlay. Deployed via a
GitHub Action that packages the app and pushes it to the TV over
Tailscale.

## Architecture, and why it isn't the obvious thing

This went through three different Google Photos API approaches before
landing on the current one. If you're tempted to "simplify" the auth
flow, re-read this section first — each rejected approach was rejected
for a concrete, verified reason, not a hunch:

1. **Library API `mediaItems:search`** (the original ask) — Google
   removed general library search from this endpoint on April 1, 2025.
   `photoslibrary.readonly` now only returns items the app itself
   uploaded. Dead end.
2. **Photos Ambient API** — purpose-built for exactly this use case (a
   persistent "device" + an ongoing curated feed, no re-picking
   sessions). Architecturally the best fit. But it's gated behind
   Google's **Photos Partner Program**, a formal application aimed at
   device manufacturers — not self-serve, no guaranteed approval or
   timeline. Confirmed via a real 403
   `PERMISSION_DENIED`/`developers.google.com/photos/partner-program`
   response, not just docs. Dead end for a personal project.
3. **Photos Picker API** (current) — no partner approval needed. But
   its scope (`photospicker.mediaitems.readonly`) is not on Google's
   allow-list for the OAuth **Device Authorization Grant** (the
   TV-shows-a-code flow) — confirmed via a real `invalid_scope`
   response. Getting that scope requires a standard **Authorization
   Code** flow with a real HTTPS redirect URI, which a TV app alone
   can't provide.

That last constraint is why there's a whole separate `pairing-backend/`
service: it's a small Vercel deployment that does the real OAuth
Authorization Code exchange server-side (so the TV app never needs a
client secret at all — an improvement over the original device-flow
design, which Google's own docs flag as inherently unable to keep a
secret confidential on a TV anyway), then bridges the result back to
the TV via short-lived pairing codes it polls for. End-user experience
is still just "one QR code on the TV, sign in and pick photos on your
phone."

## Repo layout

```
src/                    ← the actual webOS app (ares-package src)
  app.js                  pairing-backend client, Picker API, slideshow
  index.html, style.css, appinfo.json, icon.png
  secrets.local.js.example  copy → secrets.local.js (gitignored) for local testing
pairing-backend/        ← separate Vercel deployment, NOT packaged into the TV app
  api/start.js            gated by PAIRING_SHARED_SECRET; HMAC-signs `state`
  api/callback.js         verifies signature, exchanges code, creates Picker session, stashes in KV
  api/poll.js             TV polls this for the tokens+session
  api/refresh.js          TV calls this instead of holding a client secret itself
.github/workflows/deploy-webos.yml   ← package + Tailscale + install to TV
```

## Security model (added after an explicit ask to lock this down)

- `pairing-backend/api/start.js` requires `?key=<PAIRING_SHARED_SECRET>`
  or refuses with 403 — stops a stranger who finds the `.vercel.app`
  URL from spinning up OAuth consent flows against the project's own
  Google Cloud app.
- The `state` value sent to Google is HMAC-signed with that same
  secret; `callback.js` verifies the signature before doing anything.
  This closes the gap where someone copies the public `client_id` and
  hits Google's consent screen directly, bypassing `start.js` entirely.
- Caveat, stated plainly in both READMEs: the shared secret ships
  inside the packaged TV app, so it's not secret from someone who
  extracts the `.ipk`. It raises the bar against casual/remote
  discovery of a public URL, nothing more.
- `/api/poll` and `/api/refresh` weren't given the same gate —
  unguessable random tokens (the pairing UUID, the refresh token) are
  already the right protection for those; adding a shared secret there
  wouldn't add real security, just friction.

## Remote-control menu (repick / log out) + manual photo nav

While the slideshow is playing:

- **Left/Right arrows** step to the previous/next photo immediately and
  reset the 15s auto-advance clock (`goToPrevSlide`/`goToNextSlide` →
  `restartSlideTimer`), so manual browsing doesn't fight the timer.
  `mediaItems` navigation is tracked via a single `displayedIndex`
  (bidirectional, wraps both ways) rather than the old one-directional
  `currentIndex`.
- **Any other button** opens a small on-screen menu (D-pad left/right/
  up/down moves focus between two real `<button>`s, OK activates via
  native browser behavior, auto-hides after 8s):
  - **Repick Photos** — calls `POST /v1/sessions` on
    `photospicker.googleapis.com` *directly from the TV* using the
    already-valid access token, no pairing-backend involved. Safe
    because session creation only needs a Bearer token, not the client
    secret — same reason `getPickerSession`/`listPickedMediaItems`
    already call Google directly. Only the fallback QR
    (`pairing-step-media-fallback`) is shown, not the full sign-in QR —
    user stays signed in, they're just picking a new selection.
  - **Log Out** — clears both `localStorage` keys (refresh token +
    Picker session id) and the in-memory access token, then calls
    `boot()` again → falls through to the full `runPairing()` QR.
  Both paths `clearInterval` the slideshow timer *and* the media-list
  refresh timer first (`scheduleMediaListRefresh` tracks its interval
  in module-level `mediaListRefreshTimer`, clearing any existing one on
  entry — repicking twice, or repicking after a normal boot, never
  stacks duplicate refresh intervals).
- **Back button**: webOS's remote Back key is inconsistent across
  firmware/remotes about what it reports — `isBackKey()` checks
  `e.keyCode === 461` (the actual LG-documented code) *and*
  `e.key === "GoBack"`/`"Backspace"`/`"Escape"`, since real devices have
  been seen sending any of these. If Back still doesn't do anything on
  a given TV, use `ares-inspect` (remote Chrome DevTools) to check what
  that specific remote actually sends and add it to `isBackKey()` —
  don't just swap which key is checked.

## Screensaver suppression

Two layers, tried in this order of reliability:

1. **`startKeepaliveVideo()`** (primary) — an invisible 1x1 muted
   looping `<video src="keepalive.mp4">` (a ~1.5KB, 2s, black H.264
   clip; regenerate with
   `ffmpeg -f lavfi -i color=c=black:s=64x64:r=1:d=2 -an -c:v libx264
   -profile:v baseline -pix_fmt yuv420p -movflags +faststart
   keepalive.mp4` if it's ever lost). webOS explicitly exempts active
   video playback from the screensaver at the OS level — this needs no
   special permission, unlike the Luna approach below, so it isn't at
   the mercy of what a third-party `.ipk` is allowed to call. Lives in
   `src/`, so `ares-package src` picks it up automatically; no
   packaging config changes needed.
2. **`suppressScreenSaverViaLuna()`** (secondary, best-effort) — an
   **undocumented** Luna handshake: subscribe to
   `registerScreenSaverRequest`, and every time it calls back with
   `state: "Active"`, reply via `responseScreenSaverRequest` with
   `ack: false` to defer it.

**First attempt at (2) alone didn't work** — almost certainly because
`com.webos.service.tvpower` is a privileged system service, and a plain
third-party `.ipk` (not homebrew-rooted, not LG-signed) is commonly
denied access to it by the platform's ACG permission system, silently
unless you're logging for it. It now logs both the registration result
and every deferral, so `ares-inspect` will show plainly whether it's
actually running — if `registerScreenSaverRequest denied` shows up in
the console, that confirms the permission theory and (1) is doing all
the real work, which is fine — (2) is a bonus, not load-bearing.

**Known footgun, from other devs' reports, not yet hit here but worth
knowing before touching (2)**: the `tvpower` service hands off a
screensaver request and waits for a reply; if the *client* app closes
while a request is mid-flight (rather than replying), the service can
get stuck treating itself as busy and refuse every later screensaver
request until the TV is power-cycled. Practically: don't add logic that
closes/reloads the app while a `state: "Active"` callback might be
outstanding, and if the screensaver ever seems to stop responding to
this app's `ack: false` after an app crash/force-close during dev
iteration, a TV power cycle is the known fix, not a code bug to chase.

Both no-op harmlessly when testing via `npx serve .` in a desktop
browser (no `WebOSServiceBridge`; the tiny video will actually play
there too, harmlessly) — that's expected, not a bug to chase there.

## Local config pattern

`src/app.js` reads `window.APP_CONFIG` if present, else falls back to
placeholder strings. `src/index.html` loads `secrets.local.js` (gitignored
via the repo's `*secret*` pattern; `.gitignore` has a `!*secret*.example`
exception so the example file itself stays tracked) right before
`app.js`. Missing file → harmless 404 → placeholders stay in effect.
The GitHub Action never touches this file; it does its own placeholder
substitution directly into `app.js` at build time from repo secrets.
This is *the* pattern to extend if a new config value needs both a
local-testing path and a CI path — don't invent a second mechanism.

## Gotchas already hit and fixed (don't re-diagnose these)

- **Boot screen stuck on spinner during sign-in**: was a real ordering
  bug — `boot()` called `showScreen("pairing")` only *after* awaiting
  the full sign-in flow, so the pairing screen (with the code already
  written into its DOM) stayed hidden behind the boot spinner the whole
  time. Fixed by showing the pairing screen from inside the sign-in
  function itself, before it starts polling.
- **`{"error":"authorization_pending","error_description":"Precondition Required"}`**
  in DevTools is *normal*, not a bug — it's Google's documented device-flow
  response (HTTP 428) while waiting for the user to finish on their
  phone. The polling code already handles it by design.
- **Tailscale GitHub Action 403 `calling actor does not have enough
  permissions`**: the OAuth client needs the **Auth Keys: Write** scope
  specifically (a distinct entry from "Devices"/"OAuth clients" in the
  scope picker), and the ACL's `tagOwners` must already contain the tag
  before you scope a client to it.
- **Grayscale "no entry" icon on slideshow start, `403` on
  `lh3.googleusercontent.com` in the console**: `preload()` was setting
  `img.src` directly to the Picker API `baseUrl` (with the size suffix).
  Google's media `baseUrl`s (Library API and Picker API both) require
  the OAuth access token as an `Authorization: Bearer` header on the
  download request itself — a plain `<img src>` can't send that header,
  so the browser's unauthenticated GET 403s. Fixed by fetching the
  bytes with `fetch()` + the Bearer header, then pointing the `<img>` at
  a `URL.createObjectURL(blob)` instead of the raw Google URL (with the
  old blob URL revoked each cycle to avoid leaking memory on a
  long-running TV app). Don't "simplify" `preload()` back to a bare
  `img.src = url` — that's this bug again.
- **`src/app.js` got corrupted once** via what looked like a partial
  manual merge between the Ambient-API version and the Picker+pairing-
  backend version (referenced undefined things like `getAmbientDevice`
  and a bare `deviceId`). Restored from the known-good Picker version.
  If app.js ever looks like it's mixing "device"/Ambient terminology
  with "session"/Picker terminology again, that's the same failure mode
  — restore from a clean version rather than trying to hand-patch it.

## Open items / things a new session might need to pick up

- The user has NOT yet been confirmed to have completed the actual
  pairing-backend Vercel deployment + Google "Web application" OAuth
  client setup end-to-end on real infrastructure — verify current status
  before assuming it's live.
- `PAIRING_SHARED_SECRET` needs to be set identically in three places:
  the Vercel env var, the GitHub repo secret, and (for local testing
  only) `src/secrets.local.js`. If pairing starts failing with a 403
  from `/api/start`, mismatch between these is the first thing to check.
- Full secret/env-var inventory:
  - **GitHub repo secrets**: `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`,
    `WEBOS_TV_SSH_KEY_B64`, `WEBOS_TV_HOST`, `TV_PASSPHRASE`,
    `WEBOS_APP_ID`, `PAIRING_BACKEND_URL`, `PAIRING_SHARED_SECRET`
  - **Vercel (pairing-backend) env vars**: `GOOGLE_CLIENT_ID`,
    `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
    `PAIRING_SHARED_SECRET`, plus `KV_REST_API_URL`/`KV_REST_API_TOKEN`
    (auto-injected by attaching a Vercel KV database)
