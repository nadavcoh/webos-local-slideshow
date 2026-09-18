# CLAUDE.md — session recovery notes

This file exists so a new Claude session can get oriented on this
project quickly, without re-reading the whole chat history. It
summarizes *why* things are built the way they are — the README covers
*how* to set them up.

## What this is

An ambient photo slideshow for an LG webOS 4K TV, pulling from a
personal photo database rather than a live Google Photos album. Dark
16:9 "lean-back" UI, 15s crossfades, timestamp + location overlay.
Deployed via a GitHub Action that packages the app and pushes it to
the TV over Tailscale.

## Architecture, and why it isn't the Google Photos thing anymore

This project originally ran on the Google Photos Picker API via a
`pairing-backend/` OAuth bridge — see "History: the Google Photos
era" below for why that existed and why it was retired. As of the
current architecture:

- **Auth**: Supabase (GitHub SSO), restricted to a single allowed
  email (`cohen.n@gmail.com`, same allowlist pattern as
  `photo-match-next`).
- **Photo data**: a `wa` table (photo metadata, one row per photo)
  joined against a `hashes` table (`wa.id_hash -> hashes.id`) for
  filename, location, location_name, and timestamp. Same underlying
  database/schema as the `photo-match-next` project — both are fed by
  a separate `phash` ingest repo, not by anything in this repo. A
  small forward queue (`CONFIG.PREFETCH_DEPTH`) keeps a few upcoming
  photos already fetched, image-preloaded, and reverse-geocoded
  (coords → place name, via Nominatim) ahead of time, so skipping
  doesn't wait on a fresh round trip.
- **Photo bytes**: a plain, unauthenticated HTTP server on a machine
  in the home LAN, serving files by filename. Not Supabase Storage,
  not Backblaze — just a local static file server.
- **TV-to-mobile auth handoff**: a small Next.js web app (separate
  deployment, in `webapp/` if pulled into this repo — see "Repo
  layout") with two API routes backed by Vercel KV:
  - `POST /api/auth/tv-handoff` — phone calls this after Supabase
    GitHub sign-in, sending `tvSessionId` + both tokens. Server
    re-verifies the access token against Supabase itself and checks
    the email server-side before writing to KV (5 min TTL) — the
    client's claimed identity is never trusted directly.
  - `GET /api/auth/tv-poll?sessionId=...` — TV polls this every ~3s;
    returns the tokens once available and deletes the KV record in
    the same request (not truly atomic — `@vercel/kv` has no
    `GETDEL` — but fine here since only the originating TV will ever
    poll a given session id).
  - `/tv-login` — the mobile landing page the QR code points at;
    drives the Supabase GitHub OAuth (implicit flow, tokens land in
    the URL hash) and calls `tv-handoff` once signed in.

This is **not** a real OAuth Device Flow (RFC 8628) — no device code
is verified against GitHub/Supabase directly, and the TV's UUID is
just a pickup key for the KV relay. That's an intentional
simplification for a single-user app; don't describe it as Device
Flow in user-facing copy.

### Security model change from the Google Photos era

There's no shared secret gating the pairing URL anymore (the old
`PAIRING_SHARED_SECRET` had no equivalent introduced). A stranger who
finds this TV's QR/URL only reaches a GitHub sign-in page —
`tv-handoff` itself rejects anyone whose GitHub-verified email isn't
the one allowed address, so gating the URL earlier would add nothing.
The Supabase anon key embedded in the TV app is meant to be
public/client-side; RLS policies on `wa`/`hashes` (scoped to the
allowed email) are the actual access control — **if those policies
are missing, the TV app will silently get zero rows back, not an
error.** See README.md for the policy SQL.

## Repo layout

```
src/                    ← the actual webOS app (ares-package src)
  app.js                  Supabase/KV pairing client, wa/hashes fetching, slideshow
  heic-worker.js          off-main-thread HEIC->JPEG decode (see "HEIC photos" below)
  vendor/libheif/         vendored WASM build of libheif used by heic-worker.js + app.js
  index.html, style.css, appinfo.json, icon.png
  secrets.local.js.example  copy → secrets.local.js (gitignored) for local testing
webapp/                 ← separate Next.js/Vercel deployment, NOT packaged into the TV app
  app/api/auth/tv-handoff/route.js   phone → KV, after verifying the Supabase token + email
  app/api/auth/tv-poll/route.js      TV polls this for the tokens
  app/tv-login/page.js                mobile landing page, drives Supabase GitHub sign-in
  lib/                                 cors.js, uuid.js, supabaseClient.js
.github/workflows/deploy-webos.yml   ← package + Tailscale + install to TV
pairing-backend/        ← RETIRED — superseded by webapp/api/auth/*, safe to delete
                           once the new flow is confirmed working end-to-end
```

## Remote-control menu (log out) + manual photo nav

While the slideshow is playing:

- **Left/Right arrows** step to the previous/next photo immediately and
  reset the 15s auto-advance clock (`goToPrevSlide`/`goToNextSlide` →
  `restartSlideTimer`). Unlike the old `mediaItems` array (a fixed,
  pre-fetched list with a `displayedIndex`), photos are now fetched
  from Supabase rather than indexed from one static list — but not
  strictly one-at-a-time on demand either. Two buffers cover the two
  directions:
  - `history` (last `CONFIG.HISTORY_MAX`, currently 50) — photos
    already shown this session; Left walks backward through it.
  - `upcoming` (`CONFIG.PREFETCH_DEPTH`, currently 3) — photos not yet
    shown, but already fetched, image-preloaded, and reverse-geocoded
    ahead of time (`topUpQueue()`/`fetchAndPreloadOne()`); Right past
    the end of `history` pulls from here first, only falling back to
    an inline fetch if this is empty. This is what makes skipping feel
    instant instead of waiting on a fresh round trip each time.
- **Any other button** opens a small on-screen menu (OK activates via
  native browser behavior, auto-hides after 8s):
  - **Log Out** — clears the Supabase session (`auth.signOut()`) and
    calls `boot()` again → falls through to the full `runPairing()`
    QR.
  - There's **no "Repick Photos" anymore** — that was specific to
    Picker sessions, which no longer exist. If a "shuffle now" /
    "skip this one" button is wanted again, Right-arrow already does
    that during manual browsing; nothing dedicated was added to the
    menu for it. Flag if the user wants one.
- **Back button**: webOS's remote Back key is inconsistent across
  firmware/remotes about what it reports — `isBackKey()` checks
  `e.keyCode === 461` (the actual LG-documented code) *and*
  `e.key === "GoBack"`/`"Backspace"`/`"Escape"`, since real devices have
  been seen sending any of these. If Back still doesn't do anything on
  a given TV, use `ares-inspect` (remote Chrome DevTools) to check what
  that specific remote actually sends and add it to `isBackKey()` —
  don't just swap which key is checked.

## HEIC photos

`wa.filetype` doesn't distinguish HEIC from JPEG — WhatsApp media rows
are just generically `"Image"` — so HEIC files pass
`CONFIG.IMAGE_FILETYPES` and reach the browser, where a plain `<img>`
silently fails (webOS's Chromium has no native HEIC decoder; that
codec is WebKit/Safari-only). Fixed by decoding HEIC → JPEG on the TV
itself, in `heic-worker.js`, using a vendored WASM build of libheif
(`vendor/libheif/`) — not on the LAN photo server, even though that
machine (a much older Sandy Bridge laptop) is individually not
obviously slower at this than the TV. The server also runs Plex,
qBittorrent, the full `*arr` stack, Tautulli, Tailscale, and a
SeleniumBase/Chrome scraper on only 4GB RAM — genuinely contended —
whereas the TV does nothing else, and this decode is small/bursty
(one photo every 15s, a few prefetched ahead), so it's a better fit
for "has idle time to spare" than "wins a benchmark."

- `isHeic()` checks the filename extension; only `.heic`/`.heif` files
  take this path, everything else uses the LAN server URL directly.
- The decode runs in `heic-worker.js` (a Worker) so it can't stall the
  main thread — the crossfade timer, remote-key handling, and the menu
  auto-hide timer all live there. `getHeicWorker()` in `app.js` starts
  it lazily on first use.
- **Untested fallback**: if the Worker can't start at all — the app
  runs from `file:///media/developer/apps/usr/palm/applications/<id>/`
  once installed on a real TV, and some webOS/Chromium builds are
  known to restrict Worker creation from a `file://` origin — the same
  decode runs on the main thread instead (`decodeHeicOnMainThread()`),
  briefly blocking but still correct. Same if the worker crashes
  mid-session (`onerror`) — it's marked broken and every HEIC photo
  after that falls back too, without retrying a dead worker each time.
  Check `ares-inspect` logs the first time this runs on the real TV
  for "Could not start HEIC worker" / "HEIC worker crashed" to know
  which path it's actually taking; if it's always the fallback, the
  Worker restriction guess above was right and there'd be no reason to
  keep the Worker path around.
- The decoded JPEG becomes a `blob:` URL stored on `meta.displayUrl`;
  `renderPhoto()` uses that instead of re-deriving the server URL.
  **These are not cleaned up automatically** — `revokeDisplayUrl()` is
  called exactly at the two points a photo is actually discarded
  (evicted from `history` past `CONFIG.HISTORY_MAX`, or on `logOut()`
  clearing `history`). `upcoming` is deliberately left alone on
  logout — those photos are still valid and get shown after
  re-pairing. Don't add a new place metas get discarded without also
  revoking there — this app runs unattended for weeks, so a missed
  case is a slow memory leak, not an immediate bug.
- `vendor/libheif/libheif-bundle.js` is loaded twice on purpose: once
  via `importScripts()` inside the worker, once via a `<script>` tag
  in `index.html` for the main-thread fallback path. Don't switch
  either one to the CDN version (`jsdelivr`) `qrcode`/`supabase-js`
  use — an unreachable CDN mid-decode is a worse failure mode here
  than for a page's initial load, and the worker needs a same-origin
  script to `importScripts()` cleanly anyway.
- `CONFIG.HEIC_JPEG_QUALITY` (0.9) is the only tuning knob — lower it
  if decoded blob sizes/memory ever become a concern; there's no
  reason to expect they will at one photo every 15s.

## Screensaver suppression

Unchanged by the auth/data migration — still the same two layers:

1. **`startKeepaliveVideo()`** (primary) — an invisible 1x1 muted
   looping `<video src="keepalive.mp4">`. webOS explicitly exempts
   active video playback from the screensaver at the OS level — needs
   no special permission, so it isn't at the mercy of what a
   third-party `.ipk` is allowed to call.
2. **`suppressScreenSaverViaLuna()`** (secondary, best-effort) — an
   **undocumented** Luna handshake against `com.webos.service.tvpower`;
   likely denied outright by ACG permissions on a non-LG-signed `.ipk`,
   which is why (1) is load-bearing and this is a bonus. Known footgun
   (not yet hit here): if the client app closes mid-handshake, the
   service can get stuck refusing all screensaver requests until a TV
   power cycle — don't add logic that closes/reloads the app while a
   `state: "Active"` callback might be outstanding.

Both no-op harmlessly when testing via `npx serve .` in a desktop
browser (no `WebOSServiceBridge`).

**Separately**, there's a forked `webosbrew/custom-screensaver` repo
(not this one) that renders this app as a true system-level
screensaver via `file://` in a QML `WebEngineView`, for the rooted-TV
setup. That fork is unaffected by this auth/data migration — it just
loads whatever static files this app's own deploy already installed.

## Local config pattern

`src/app.js` reads `window.APP_CONFIG` if present, else falls back to
placeholder strings. `src/index.html` loads `secrets.local.js`
(gitignored via the repo's `*secret*` pattern) right before `app.js`.
Missing file → harmless 404 → placeholders stay in effect. The GitHub
Action never touches this file; it does its own placeholder
substitution directly into `app.js` at build time from repo secrets.
Current placeholders (post-migration):

- `CONFIG.WEBAPP_URL` ← `https://YOUR-WEBAPP.vercel.app`
- `CONFIG.SUPABASE_URL` ← `https://YOUR-PROJECT.supabase.co`
- `CONFIG.SUPABASE_ANON_KEY` ← `YOUR_SUPABASE_ANON_KEY`
- `CONFIG.PHOTO_SERVER_URL` ← `http://YOUR-PHOTO-SERVER:PORT`

This is *the* pattern to extend if a new config value needs both a
local-testing path and a CI path — don't invent a second mechanism.

## Gotchas already hit and fixed (don't re-diagnose these)

From the Google Photos era, still relevant to how this app is
structured even though the specific APIs are gone:

- **Boot screen stuck on spinner during sign-in**: was a real ordering
  bug — `boot()` called `showScreen("pairing")` only *after* awaiting
  the full sign-in flow. Fixed by showing the pairing screen from
  inside the sign-in function itself, before it starts polling. The
  current `runPairing()` still follows this ordering — don't move the
  `showScreen("pairing")` call back to `boot()`.
- **`src/app.js` got corrupted once** via a partial manual merge
  between two old versions. If `app.js` ever looks like it's mixing
  terminology from two different eras (Picker `mediaItems`/`baseUrl`
  showing up alongside Supabase/`wa`/`hashes` code, say), that's the
  same failure mode — restore from a clean version rather than
  hand-patching it.
- **Vercel functions don't send CORS headers by default** — hit this
  with the old `pairing-backend/api/poll.js`/`refresh.js`, and it
  applies equally to the new `webapp/app/api/auth/*` routes for the
  same reason (TV calls them cross-origin). Both new routes already
  have CORS + `OPTIONS` handling; if a future route is added under
  `api/auth/`, don't forget it there too.
- **PostgREST has no `order by random()`** via the query builder —
  `fetchRandomPhoto()` in the new `app.js` does count-then-offset
  instead (two round trips). If this ever needs to become one round
  trip, that's a Postgres RPC function, not a query-builder trick —
  matches the RPC pattern `photo-match-next` already uses for its own
  distance queries.
- **`hashes.location_name` has a literal `"Add a location"` placeholder**
  Google Photos shows when nothing's tagged — `parseLocationName()`
  treats that string as empty rather than displaying it. If a similar
  placeholder ever shows up in a different casing/wording, extend that
  same check rather than adding a second one elsewhere.
- **Reverse geocoding must not block rendering.** `formatLocation()` is
  synchronous on purpose — the actual Nominatim network call
  (`reverseGeocode()`) only ever happens inside `fetchAndPreloadOne()`,
  during prefetch, so `meta.geocodedPlace` is already populated by the
  time a photo is shown. Don't call `reverseGeocode()` directly from
  `renderPhoto()`/`formatLocation()` even for a "quick fix" — that
  would reintroduce exactly the latency the prefetch queue exists to
  avoid.
- **`preloadImage(photoImageUrl(meta))` alone doesn't work for every
  photo** — some `wa`/`hashes` rows are HEIC files, which no webOS
  Chromium build decodes natively. See "HEIC photos" above; don't
  re-diagnose "Image failed to load" errors as a server/network
  problem without first checking `meta.filename`'s extension.
- **Nominatim throttling is app-wide, not per-caller** — `geocodeChain`
  serializes every `reverseGeocode()` call through one queue regardless
  of how many photos are being prefetched concurrently. If a second,
  independent geocoding call site is ever added elsewhere in the app,
  route it through the same `reverseGeocode()`/`geocodeChain`, not a
  separate throttle — two independent throttles could each think
  they're within the ~1/sec budget while jointly exceeding it.

## History: the Google Photos era (retired, kept for context)

Skip this unless you're trying to understand why `pairing-backend/`
exists or why the repo still has Picker-era references lying around
mid-migration. Three approaches were tried before landing on the
current Supabase/local-DB architecture:

1. **Library API `mediaItems:search`** — Google removed general
   library search from this endpoint on April 1, 2025; dead end.
2. **Photos Ambient API** — the best architectural fit (a persistent
   "device" + ongoing curated feed), but gated behind Google's **Photos
   Partner Program**, not self-serve; dead end for a personal project.
3. **Photos Picker API** — no partner approval needed, but its scope
   isn't on Google's Device Authorization Grant allow-list, so OAuth
   had to go through a standard Authorization Code flow instead, which
   needs a real HTTPS redirect URI a TV app can't provide alone —
   hence `pairing-backend/`, a small Vercel service doing that OAuth
   exchange server-side.

That whole chain (and `pairing-backend/` with it) was retired in favor
of the current architecture because the *photo source itself* changed
— photos now come from a personal database (`wa`/`hashes`, fed by a
separate `phash` ingest project) rather than a live Google Photos
album, so there's no Google Photos API of any kind left to work
around. The Supabase GitHub SSO + Vercel KV handoff exists purely to
solve the same "TV has no browser-based OAuth redirect" problem the
old pairing-backend solved, just for a much simpler auth need (no
third-party API scope headaches, just "prove you're the one allowed
GitHub account").

## Open items / things a new session might need to pick up

- Confirm the Supabase RLS policies on `wa`/`hashes` actually exist in
  the live database (see README.md) — without them the TV app fails
  silently (empty results, not an error).
- Confirm `wa.filetype`'s actual stored values match
  `CONFIG.IMAGE_FILETYPES` (`["image", "image/jpeg"]`) — a
  `select distinct filetype from wa` was recommended but not yet
  confirmed run.
- `pairing-backend/` and its Vercel project/env vars are still live as
  of this writing — retire them once the new flow is confirmed working
  end-to-end on the real TV.
- Full secret/env-var inventory (current):
  - **GitHub repo secrets**: `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`,
    `WEBOS_TV_SSH_KEY_B64`, `WEBOS_TV_HOST`, `TV_PASSPHRASE`,
    `WEBOS_APP_ID`, `WEBAPP_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
    `PHOTO_SERVER_URL`
  - **Vercel (webapp) env vars**: `NEXT_PUBLIC_SUPABASE_URL`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ALLOWED_EMAIL`, plus
    `KV_REST_API_URL`/`KV_REST_API_TOKEN` (auto-injected by attaching a
    Vercel KV database)
  - **Supabase dashboard**: Auth → URL Configuration → Redirect URLs
    must include `https://<webapp>/tv-login` (and the localhost
    equivalent for local testing)
