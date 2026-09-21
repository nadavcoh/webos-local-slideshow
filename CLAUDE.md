# CLAUDE.md — session recovery notes

This file exists so a new Claude session can get oriented on this
project quickly, without re-reading the whole chat history. It
summarizes *why* things are built the way they are — the README covers
*how* to set them up.

## What this is

An ambient photo slideshow for an LG webOS 4K TV, pulling from a
personal photo database rather than a live Google Photos album. Dark
16:9 "lean-back" UI, 15s crossfades, timestamp + full-detail location
overlay (name/street/neighbourhood/city/country, all levels Nominatim
returns — see "Reverse geocoding is deliberately maximal" below), plus
an optional wa-id + filename overlay, on by default — see
`CONFIG.SHOW_FILENAME_OVERLAY`, mainly useful while debugging (also
see `window.debugShowPhoto()`, below). Deployed via a GitHub Action
that packages the app and pushes it to the TV over Tailscale.

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
  index.html, style.css, appinfo.json
  icon.png, largeIcon.png        generic placeholders — see "App icon" below for the real one
  largeIcon.png.gpg              (repo owner adds this) real icon, GPG-encrypted
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
- **Confirmed working on the real TV**: `new Worker(...)` and
  `importScripts()` both succeed from the `file:///.../applications/<id>/`
  origin this app actually runs from once installed — this was an open
  question when the Worker was first added, resolved by the crash logs
  from the bug below actually reaching the *inside* of the worker
  (proving it started and ran) rather than failing to construct. The
  main-thread fallback (`decodeHeicOnMainThread()`) still exists for
  `getHeicWorker()`'s `try/catch` around `new Worker(...)` and for the
  `onerror` case if a worker ever does crash mid-session, but there's
  no longer a specific reason to expect either on this device.
- **The actual bug hit (and the one to not reintroduce)**: `libheif`
  (the global `vendor/libheif/libheif-bundle.js` exposes, in both the
  worker via `importScripts()` and the main thread via the `<script>`
  tag in `index.html`) is a **factory function**, not a ready module —
  calling it kicks off async WASM instantiation and returns a Promise
  that resolves to the real module (the one with `.HeifDecoder` on
  it). Calling `new libheif.HeifDecoder()` directly throws
  `"libheif.HeifDecoder is not a constructor"` — this happened for
  real, in both `heic-worker.js` and `decodeHeicOnMainThread()`
  simultaneously (same mistake, copy-pasted). Fixed by
  `getLibheifModule()`/`getMainThreadLibheifModule()` — two separate
  cached-promise wrappers (one per JS context; the worker and main
  thread each load their own copy of the bundle and can't share
  state) that `await libheif()` once and reuse the resolved module for
  every subsequent decode. If HEIC decoding ever breaks again with
  this exact error, this is almost certainly what regressed — check
  that whatever calls `new heif.HeifDecoder()` is doing so on the
  *awaited* result of one of those two functions, not on the raw
  `libheif` global.
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
- **`heicSignatureError()`** runs right after the raw bytes are
  fetched, before they're handed to the worker — it checks for the
  ISO-BMFF `ftyp` box at offset 4 and, if it's missing, throws with a
  guess at what the bytes actually are (JPEG/PNG/HTML/empty/other)
  plus a hex dump, rather than letting libheif's much less legible
  internal parse error ("No 'ftyp' box...") be the only signal. Added
  after a real HEIC-named file failed to decode for reasons that
  turned out to need this diagnostic to even start narrowing down.

## Debugging console helpers

`window.debugShowPhoto(waId)` — callable directly from the
`ares-inspect` console — fetches one specific photo by its `wa.id`
(see fetchPhotoByWaId() in Step B) and renders it immediately,
bypassing the normal random selection. Every fetched photo (random or
debug) logs `Fetched wa id <id> — <filename>` via
`fetchPhotoByWaRow()`, so a failure anywhere downstream (HEIC decode,
geocoding) has that line sitting right above it in the console,
telling you which photo to re-pull with `debugShowPhoto()`. It's a
one-off preview only — doesn't touch `history`/`upcoming`, so it
doesn't disturb Left/Right navigation or the prefetch queue, and the
normal slide timer moves on as usual at its next interval regardless.

If a future session adds more debug affordances, keep them console
functions on `window` in this same spot rather than UI (buttons, a
debug overlay) — this app has no on-screen chrome beyond the overlay
and the remote-control menu, and `ares-inspect` is already the
established way anyone debugging this actually interacts with it.

## App icon (personal photo, kept out of the repo)

`src/largeIcon.png` (130x130, the webOS `largeIcon` size) and
`src/icon.png` (80x80, generated from it) in the repo are always
generic placeholders — the real icon is a personal photo the repo
owner doesn't want committed in the clear, including as base64 inside
a GitHub Actions secret's cleartext value.

Two approaches were tried and rejected before landing on the current
one — if either comes up again, it's already been ruled out, not
overlooked:
- **A `WEBOS_APP_ICON_B64` secret holding the base64 PNG directly** —
  hit GitHub's hard 48 KB per-secret cap in practice (a 130x130 PNG
  can exceed that depending on export settings), and even under the
  cap, a secret's cleartext value still isn't the right place to store
  something that's actually sensitive rather than merely inconvenient.
- **Committing the real `largeIcon.png` straight into the repo** —
  solves the size limit but not the actual privacy requirement; never
  implemented for real once "it's a personal photo" was clarified.

What's actually implemented: `src/largeIcon.png.gpg` is the real
icon, GPG-symmetric-encrypted and committed (safe even in a public
repo — unreadable without the passphrase). The workflow's "Decrypt
icon and generate icon.png" step decrypts it using the small
`ICON_DECRYPT_PASSPHRASE` repo secret, validates the result (PNG
signature + exact 130x130), and downscales it via `sharp` to produce
`icon.png` — all inside the CI runner's ephemeral filesystem, never
written back to the repo. See README section (d) for the exact local
`gpg` commands. Skipped cleanly (placeholders ship) if either the
secret or the `.gpg` file is missing — this was deliberately made
optional rather than required, so the workflow still succeeds for a
fork/PR that hasn't set it up.

One YAML gotcha hit along the way: **`secrets` cannot be referenced
directly in a step's `if:` condition** — GitHub Actions rejects that
at parse time (`Unrecognized named-value: 'secrets'`). The workaround,
used here, is mirroring the secret into a job-level `env:` var first,
then checking `env.ICON_DECRYPT_PASSPHRASE != ''` in the `if:`
instead. If a future secret ever needs a similar opt-in `if:` guard on
a step, this is the pattern to reuse rather than re-discovering it.

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
  instead (two round trips). It selects both `id` (the `wa` table's
  own primary key — what's shown/logged, see the "wa id vs id_hash"
  note below) and `id_hash` (the join key to `hashes`) in the same
  query, so no separate lookup is needed for the random path. If this
  ever needs to become one round trip, that's a Postgres RPC function,
  not a query-builder trick — matches the RPC pattern
  `photo-match-next` already uses for its own distance queries.
- **`wa.id` vs `wa.id_hash` — don't conflate these.** `id` is the
  table's own primary key and is what's shown in the overlay, logged
  to console, and what `debugShowPhoto()` takes. `id_hash` is purely
  an internal join key to `hashes.id` and is never shown anywhere.
  `fetchPhotoByWaRow(waRow)` is the one place that turns a `{id,
  id_hash}` pair into a full `meta` (with `meta.waId = waRow.id`) —
  both `fetchRandomPhoto()` and `fetchPhotoByWaId()` (used by
  `debugShowPhoto()`) funnel through it, so logging/display stays
  consistent between the two paths. This got mixed up once already —
  an earlier version used `id_hash` for the on-screen "wa id" — so if
  it comes up confused again, this is the fix to reapply, not a new
  problem to solve from scratch.
- **`hashes.location_name` has two literal placeholder values** —
  `"Add a location"` (Google Photos, when nothing's tagged) and
  `"Unknown location"`. `parseLocationName()` treats both as empty
  rather than displaying them. If a similar placeholder ever shows up
  in a different casing/wording, extend that same check rather than
  adding a second one elsewhere.
- **Reverse geocoding must not block rendering.** `formatLocation()` is
  synchronous on purpose — the actual Nominatim network call
  (`reverseGeocode()`) only ever happens inside `fetchAndPreloadOne()`,
  during prefetch, so `meta.geocodedPlace` is already populated by the
  time a photo is shown. Don't call `reverseGeocode()` directly from
  `renderPhoto()`/`formatLocation()` even for a "quick fix" — that
  would reintroduce exactly the latency the prefetch queue exists to
  avoid.
- **Reverse geocoding is deliberately maximal, not "smart."**
  `zoom=18` (confirmed against Nominatim's own docs — 0-18, 18 is
  building-level and is actually their own default) asks for the most
  detail Nominatim will give. `extractPlaceName()` then concatenates
  *every* level that came back — a named feature, street address,
  neighbourhood/suburb, city, country — deduplicated, rather than
  picking just the most specific one. This was a deliberate, explicit
  ask ("always show all available data"), not an oversight — don't
  simplify it back down to a single "best" level without checking
  first. `geocodeCache`'s bucket size was tightened from ~100m to
  ~11m (4 decimal places) specifically because of this: at 100m,
  neighboring buildings/streets could share one cached result, which
  was harmless when results were only ever city-level but would be
  actively wrong now that they're this specific.
- **`preloadImage(photoImageUrl(meta))` alone doesn't work for every
  photo** — some `wa`/`hashes` rows are HEIC files, which no webOS
  Chromium build decodes natively. See "HEIC photos" above; don't
  re-diagnose "Image failed to load" errors as a server/network
  problem without first checking `meta.filename`'s extension.
- **`libheif.HeifDecoder is not a constructor`**: hit this for real in
  both `heic-worker.js` and `decodeHeicOnMainThread()` at once — the
  vendored `libheif` global is a factory function that must be called
  and awaited (`await libheif()`) before `.HeifDecoder` exists; it's
  not already an initialized module. See "HEIC photos" above for the
  fix (`getLibheifModule()`/`getMainThreadLibheifModule()`). If this
  exact error resurfaces, it's almost certainly a new call site
  constructing `HeifDecoder` from the raw `libheif` global again
  instead of going through one of those two functions.
- **"No 'ftyp' box" from inside the WASM decoder** means the bytes
  handed to libheif weren't a valid HEIF container at all — not a
  libheif bug, and not necessarily the LAN server's fault either.
  `heicSignatureError()` in `resolvePhotoDisplayUrl()` checks for this
  *before* the fetched bytes ever reach the worker, and logs a
  specific guess (JPEG/PNG/HTML/empty body/genuinely unrecognized,
  with a hex dump) instead of just letting the opaque parse error
  through. If this fires, the diagnostic message itself says what to
  look at next — resist the urge to add a second, different check
  elsewhere; extend this one instead.
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
