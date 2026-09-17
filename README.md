# Ambient Photos — webOS TV slideshow

## Architecture

This app shows an ambient, ever-changing slideshow on an LG webOS TV,
pulling from a personal photo database rather than a live album on a
photo-sharing service. Three pieces:

- **`src/`** — the webOS TV app itself: plain HTML/CSS/JS, no build
  step. Shows a QR code for pairing, then a 15-second-crossfade
  slideshow with a timestamp + location overlay.
- **`webapp/`** — a small Next.js app (separate Vercel deployment) that
  handles the TV-to-mobile auth handoff: two API routes backed by
  Vercel KV, plus the mobile landing page the QR code points at.
- **Supabase** — auth (GitHub SSO, restricted to one allowed email)
  and the photo database itself (`wa` + `hashes` tables, fed by a
  separate ingest project — not part of this repo).

Photo bytes themselves come from a plain HTTP server on a machine in
your home LAN, not from Supabase Storage or any cloud photo service.

> **Coming from an older checkout?** This app used to run on the
> Google Photos Picker API via a `pairing-backend/` OAuth bridge.
> That's retired — see `CLAUDE.md`'s "History: the Google Photos era"
> section if you're curious why it existed. `pairing-backend/` can be
> deleted once you've confirmed the new flow below works end to end.

## Directory layout

```
webos-photos-slideshow/
├── .gitignore                ← ignores *secret* (see src/secrets.local.js below)
├── src/                       ← everything ares-package hands to webOS — nothing else
│   ├── appinfo.json            ← webOS app manifest
│   ├── icon.png                 ← 80x80 app icon (placeholder — swap for your own)
│   ├── index.html                ← markup for pairing screen + slideshow
│   ├── style.css                  ← dark-mode lean-back styling, crossfade CSS
│   ├── app.js                      ← Supabase/KV pairing client, wa/hashes fetching, slideshow engine
│   └── secrets.local.js.example     ← copy to secrets.local.js (gitignored) for local testing
├── .github/workflows/          ← GitHub Action: package + deploy to the TV over Tailscale
├── webapp/                      ← Next.js app — a SEPARATE Vercel deployment, never packaged into the TV app
│   ├── app/api/auth/tv-handoff/route.js   phone → KV, after verifying the Supabase token + email
│   ├── app/api/auth/tv-poll/route.js       TV polls this for the tokens
│   ├── app/tv-login/page.js                 mobile landing page, drives Supabase GitHub sign-in
│   └── lib/                                  cors.js, uuid.js, supabaseClient.js
└── pairing-backend/              ← RETIRED (Google Photos era) — safe to delete once confirmed unused
```

Everything under `src/` is plain HTML/CSS/JS — no build step, no
bundler — and is exactly the directory you hand to `ares-package`
(`ares-package src`). `webapp/` is a normal Next.js app; deploy it to
Vercel like any other.

## 0. Set up Supabase

1. Create (or reuse) a Supabase project with GitHub added as an Auth
   provider, and the `wa`/`hashes` tables already populated by your
   ingest project.
2. **Row Level Security** — the TV queries these tables using the
   signed-in user's own token, not a service role key, so RLS needs an
   explicit policy or every query will silently return zero rows:
   ```sql
   alter table wa enable row level security;
   alter table hashes enable row level security;

   create policy "allowed account can read wa"
     on wa for select
     to authenticated
     using (auth.jwt() ->> 'email' = 'cohen.n@gmail.com');

   create policy "allowed account can read hashes"
     on hashes for select
     to authenticated
     using (auth.jwt() ->> 'email' = 'cohen.n@gmail.com');
   ```
3. Note your project's **URL** and **anon/public key** (Settings →
   API) — needed by both `webapp/` and the TV app below. The anon key
   is meant to be public/client-side; RLS above is the real access
   control.
4. **Auth → URL Configuration → Redirect URLs** — add
   `https://<your-webapp>.vercel.app/tv-login` (and
   `http://localhost:3000/tv-login` for local testing), or the mobile
   sign-in page's OAuth redirect will be rejected.

## 1. Deploy the web app (`webapp/`)

Do this before configuring the TV app — the TV needs its URL.

```bash
cd webapp
npm install
```

Attach a **Vercel KV** (Upstash Redis) database to the Vercel project
— this auto-populates `KV_REST_API_URL`/`KV_REST_API_TOKEN`. Then set
these Vercel environment variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `ALLOWED_EMAIL` (defaults to `cohen.n@gmail.com` if unset)

Deploy (`vercel deploy` or connect the repo/subdirectory in the Vercel
dashboard) and note the resulting `https://....vercel.app` URL.

To test locally first: `npm run dev`, with a `.env.local` copied from
`webapp/.env.example`. See `webapp/STEP1-NOTES.md` and
`webapp/STEP2-NOTES.md` for manual `curl` walkthroughs of the
handoff/poll endpoints and the sign-in page.

## 2. Configure the TV app

**If you're deploying via the GitHub Action (section 5 below), skip
this** — leave the placeholders in `src/app.js` as-is; the workflow
substitutes them from repo secrets at build time, and drops `vendor`
into `appinfo.json` automatically too.

For manual/local packaging, or for testing locally in a browser (see
"Testing locally" below), copy `src/secrets.local.js.example` to
`src/secrets.local.js` (already covered by `.gitignore`'s `*secret*`
pattern — never committed, and excluded from the packaged `.ipk` too)
and fill in:

```js
window.APP_CONFIG = {
  WEBAPP_URL: "https://your-webapp.vercel.app",
  SUPABASE_URL: "https://your-project.supabase.co",
  SUPABASE_ANON_KEY: "your-anon-key",
  PHOTO_SERVER_URL: "http://192.168.1.50:8080",
};
```

`src/app.js` reads this at runtime — `window.APP_CONFIG` if present,
otherwise its own placeholder strings (which is what the GitHub Action
replaces for real builds).

Also update `src/appinfo.json` → `"id"` to your own reverse-domain app
ID (e.g. `com.yourname.ambientphotos`) if packaging manually — the
GitHub Action sets this (and `vendor`) for you.

## Testing locally in Chrome

Since the TV app is plain static HTML/JS/CSS, you can preview the
whole pairing + slideshow flow in a desktop browser before ever
touching the TV or `ares-package`. From inside `src/`:

```bash
cd src
npx serve .
```

Open the printed `http://localhost:...` URL in Chrome. Don't open
`index.html` directly via `file://` — `fetch()` calls and the QR code
renderer get blocked by browser security restrictions on that origin.
(This `file://` restriction is specific to desktop Chrome — it doesn't
apply on the real webOS TV, which is relevant if you're ever
integrating this as a system screensaver via a `file://`-loading
`WebEngineView` rather than through this local dev server.)

Since webOS's browser is also Chromium-based under the hood, this is a
genuinely useful proxy for what'll happen on the real TV — DevTools'
Console/Network tabs during the flow are the easiest way to catch
problems early. Run `webapp` locally too (`npm run dev` in that
directory) if you want the full loop without touching production.

## 3. Install the webOS CLI (on your dev machine, not the TV)

```bash
npm install -g @webos-tools/cli
```

(This project previously used the now-effectively-deprecated
`@webosose/ares-cli` package — if you have that installed, uninstall it
first to avoid two copies of `ares-*` commands shadowing each other on
your `PATH`.)

Put your TV into Developer Mode (install the **Developer Mode** app from
the LG Content Store, enable it, note the IP address it shows), then
register the TV as a deploy target:

```bash
ares-setup-device
# follow the prompts: name it e.g. "livingroom-tv", enter its IP,
# port 9922, and the passphrase shown in the Developer Mode app
```

## 4. Package and install

```bash
ares-package src --no-minify
# produces com.yourdomain.ambientphotos_1.0.0_all.ipk

ares-install -d livingroom-tv com.yourdomain.ambientphotos_1.0.0_all.ipk

ares-launch -d livingroom-tv com.yourdomain.ambientphotos
```

`--no-minify` skips webOS's built-in minification step — mainly useful
if you ever need to inspect the installed app's `app.js` on the TV
itself (e.g. via `ares-shell`) and want it to still read like the
source rather than a minified blob.

To iterate quickly during development, `ares-install` again after each
`ares-package` — no need to relaunch Developer Mode each time.

### First run on the TV

1. The app shows one QR code / link. Scan it (or open the link) on your
   phone — it takes you to the web app's sign-in page, where you sign
   in with the one allowed GitHub account.
2. The slideshow starts automatically once sign-in completes.
   Supabase's client library keeps the session valid on its own
   (automatic token refresh), so a reboot skips pairing entirely —
   until you explicitly Log Out from the on-screen remote menu, at
   which point the same QR flow reappears.
3. Each photo is fetched fresh from the `wa`/`hashes` tables — there's
   no fixed "picked album" to run out of or need to refresh
   periodically, unlike the old Google Photos Picker flow.

## 5. Generating the TV pairing key

Generate this once, locally, from a machine already on the same LAN as
the TV (with Developer Mode open and its passphrase visible on-screen):

```bash
ares-setup-device --add livingroom-tv \
  -i "host=<TV LAN IP>" -i "port=9922" -i "username=prisoner"
ares-novacom --device livingroom-tv --getkey --passphrase <passphrase-shown-on-TV>
```

`@webos-tools/cli` writes the resulting key under
`~/.ssh/livingroom-tv/webos_rsa` (this replaced the older
`@webosose/ares-cli`'s `~/.novacom-cert/<name>/webos_rsa` path — if
you're following an old note or blog post that mentions
`.novacom-cert`, that's why it no longer matches).

Base64-encode it for the `WEBOS_TV_SSH_KEY_B64` secret:

**macOS:**
```bash
base64 -i ~/.ssh/livingroom-tv/webos_rsa | pbcopy
```

**Linux:**
```bash
base64 -w0 ~/.ssh/livingroom-tv/webos_rsa | xclip -selection clipboard
# or just: base64 -w0 ~/.ssh/livingroom-tv/webos_rsa
```

**Windows (PowerShell):**
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.ssh\livingroom-tv\webos_rsa")) | clip
```

Developer Mode sessions expire after a couple of days unless extended in
the Developer Mode app on the TV; the derived key stops working once the
session lapses and you'll need to regenerate it via the commands above
with a fresh passphrase.

## 6. Automatic deploys via GitHub Actions (`.github/workflows/deploy-webos.yml`)

The workflow packages the app, joins your tailnet, and pushes the result
straight to the TV on every push to `main` that touches a file under
`src/`. Set up these secrets first:

### a) Tailscale reachability

webOS has no Tailscale client, so the TV itself is never a tailnet node.
The GitHub-hosted runner only reaches it if **one** of these is true:

- A device already on your home LAN (a Pi, NAS, or router) is running
  Tailscale as a **subnet router**:
  ```bash
  sudo tailscale up --advertise-routes=192.168.1.0/24   # use your TV's actual subnet
  ```
  then approve that route in the [Tailscale admin console](https://login.tailscale.com/admin/machines).
- Or you self-host the Actions runner on a machine already on that LAN
  (swap `runs-on: ubuntu-latest` for `runs-on: self-hosted` in the
  workflow) — in that case the Tailscale step is optional.

Create a Tailscale OAuth client (Admin console → Settings → OAuth clients)
scoped to write devices with a tag (the workflow currently uses
`tag:github-actions` — keep this in sync if you rename it), and add
these repo secrets:
- `TS_OAUTH_CLIENT_ID`
- `TS_OAUTH_SECRET`

> **Troubleshooting `403: calling actor does not have enough permissions`**
> This means the OAuth client has the wrong scope. It needs **Auth Keys:
> Write** specifically (a distinct entry from "Devices" or "OAuth
> clients" in the scope picker — easy to pick the wrong one). Also make
> sure your tag exists in your ACL policy's `tagOwners` block before you
> try to scope the client to it:
> ```json
> "tagOwners": {
>   "tag:github-actions": ["autogroup:admin"]
> }
> ```
> and that the tag selected on the OAuth client matches the workflow's
> `tags:` value exactly.

### b) TV pairing key

- `WEBOS_TV_SSH_KEY_B64` — from section 5 above
- `WEBOS_TV_HOST` — the TV's LAN IP (reachable via the subnet route)
- `TV_PASSPHRASE` — the Developer Mode passphrase shown on-screen at the
  time you registered the device; used by `ares-setup-device` in the
  workflow to re-establish trust non-interactively
- `WEBOS_APP_ID` — your reverse-domain app ID (e.g.
  `com.yourname.ambientphotos`); the workflow writes this into
  `appinfo.json` → `"id"` at build time

`appinfo.json` → `"vendor"` no longer needs a secret at all — the
workflow drops in your GitHub username/org (`github.repository_owner`)
automatically.

### c) Web app / Supabase config

Four repo secrets — the workflow writes all of them into `src/app.js`
in place of the `CONFIG.WEBAPP_URL` / `CONFIG.SUPABASE_URL` /
`CONFIG.SUPABASE_ANON_KEY` / `CONFIG.PHOTO_SERVER_URL` placeholders
right before packaging:

- `WEBAPP_URL` — e.g. `https://your-webapp.vercel.app` (no trailing
  slash), from step 1
- `SUPABASE_URL` — from step 0
- `SUPABASE_ANON_KEY` — from step 0 (the anon/public key, not the
  service role key)
- `PHOTO_SERVER_URL` — e.g. `http://192.168.1.50:8080`

If you're migrating an existing deployment, **remove** the old
`PAIRING_BACKEND_URL` / `PAIRING_SHARED_SECRET` repo secrets — nothing
references them anymore.

### Changes made to the default workflow, for future reference

If you're picking this project back up after a while, the workflow has
diverged from a "textbook" version in a few deliberate ways:

- **`@webos-tools/cli`**, not `@webosose/ares-cli` — the latter is the
  older, now largely unmaintained package name.
- **Node 24** explicitly, plus `actions/checkout@v5` and
  `actions/setup-node@v5` — both v4 majors only ran on the
  now-deprecated Node 20 runtime.
- **`tag:github-actions`** (not `tag:ci`) as the Tailscale ACL tag.
- **Two reachability checks** back to back: `tailscale ping` (confirms
  the tailnet route) and a plain `ping` (confirms the TV actually
  responds on that address) — either can fail independently, so both
  are kept as separate steps for clearer failure messages.
- **`ares-setup-device` uses `-i key=value` flags** plus a
  `TV_PASSPHRASE` secret, rather than a single JSON `--info` blob — this
  lets the workflow re-establish the SSH trust relationship
  non-interactively on a fresh runner every time, instead of assuming a
  key generated once will always be accepted.
- **`ares-setup-device --listfull`** right after registering — purely
  diagnostic output in the log, useful when a deploy fails at the
  install step and you need to confirm the device profile actually
  registered correctly.
- **`--no-minify`** on `ares-package` (see section 4 above).
- **The relaunch step is commented out** — `ares-install` already
  restarts a running app on install for this project's testing
  workflow; uncomment `ares-launch` if your TV doesn't do this
  automatically.
- **`--app-exclude secrets.local.js` / `secrets.local.js.example`** on
  the package step — belt-and-suspenders, since CI never has these
  files anyway (gitignored), but keeps a stray local file from ever
  ending up in a manually-built `.ipk` either.

## Notes / things to adjust for your setup

- **15-second crossfade timing** lives in `CONFIG.SLIDE_INTERVAL_MS` and
  the CSS `--transition-duration` variable in `style.css`.
- **History buffer size** (`CONFIG.HISTORY_MAX`, currently 50) controls
  how far back manual Left-arrow "previous" navigation can go before
  hitting the start of what's been shown this session.
- **Pairing timeout**: `CONFIG.PAIRING_POLL_TIMEOUT_MS` (10 minutes) —
  how long the TV waits overall for the phone to finish sign-in. This
  is separate from the KV handoff record's own 5-minute TTL (in
  `webapp/app/api/auth/tv-handoff/route.js`), which only needs to
  cover the gap between the phone finishing sign-in and the TV's next
  poll — normally seconds.
- **`wa.filetype` values**: `CONFIG.IMAGE_FILETYPES` currently filters
  on `["image", "image/jpeg"]` per spec; run
  `select distinct filetype from wa` against your actual data and
  adjust if it stores something else.
- webOS's browser engine is Chromium-based and modern enough for all the
  `fetch`/`async`/`URLSearchParams` used here, but if you're targeting a
  very old webOS 4 firmware revision, test on the actual TV early —
  device-specific `fetch` quirks do occasionally show up.
