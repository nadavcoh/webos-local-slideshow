# Ambient Photos — webOS TV slideshow

## ⚠️ Read this first: two other approaches were tried and rejected

Your original spec called for `mediaItems:search` filtered by album or
favorite status. As of **April 1, 2025**, Google removed that capability
for the `photoslibrary.readonly` scope — the Library API now only returns
items an app *itself* uploaded.

The next candidate, the **Photos Ambient API**, is purpose-built for
exactly this use case (a persistent "device" with an ongoing curated
feed, no re-picking) — but it requires acceptance into Google's **Photos
Partner Program** first. That's a formal application aimed at device
manufacturers, not a self-serve API, so it's a dead end for a personal
project unless you want to go apply for it separately.

What this app actually uses is the **Photos Picker API**, which needs no
partner approval. Its catch: the scope
(`photospicker.mediaitems.readonly`) isn't on Google's allow-list for the
OAuth **Device Authorization Grant** (the TV-shows-a-code flow) —
requesting it there returns `invalid_scope`. Getting that scope requires
a standard **Authorization Code** flow with a real HTTPS redirect URI,
which a TV app alone can't provide. So this app talks to a small
**pairing backend** (in `pairing-backend/`) instead of Google directly
for anything auth-related — see that folder's own README for what it
does and how to deploy it. The end-user experience is unchanged: one QR
code on the TV, sign in and pick photos on your phone.

## Directory layout

```
webos-photos-slideshow/
├── .gitignore                ← ignores *secret* (see src/secrets.local.js below)
├── src/                       ← everything ares-package hands to webOS — nothing else
│   ├── appinfo.json            ← webOS app manifest
│   ├── icon.png                 ← 80x80 app icon (placeholder — swap for your own)
│   ├── index.html                ← markup for pairing screen + slideshow
│   ├── style.css                  ← dark-mode lean-back styling, crossfade CSS
│   ├── app.js                      ← pairing-backend client, Picker API flow, slideshow engine
│   └── secrets.local.js.example     ← copy to secrets.local.js (gitignored) for local testing
├── .github/workflows/          ← GitHub Action: package + deploy to the TV over Tailscale
└── pairing-backend/             ← small Vercel service — a SEPARATE deployment, never packaged
```

Everything under `src/` is plain HTML/CSS/JS — no build step, no
bundler — and is exactly the directory you hand to `ares-package`
(`ares-package src`). Keeping the TV app in its own `src/` folder means
packaging never needs to explicitly exclude `pairing-backend/`,
`.github/`, or this README — they're simply siblings, not descendants.

## 0. Deploy the pairing backend

Do this first — the TV app needs its URL. Full instructions are in
[`pairing-backend/README.md`](pairing-backend/README.md): create a
**Web application** OAuth client (not "TVs and Limited Input devices"),
enable the Photos Picker API, deploy the four functions to Vercel with a
KV database attached, generate a `PAIRING_SHARED_SECRET`, and note the
resulting `https://....vercel.app` URL.

## 1. Configure the app

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
  PAIRING_BACKEND_URL: "https://your-pairing-backend.vercel.app",
  PAIRING_SHARED_SECRET: "the same value you set on the backend",
};
```

`src/app.js` reads this at runtime — `window.APP_CONFIG` if present,
otherwise its own placeholder strings (which is what the GitHub Action
replaces for real builds). Either way, nothing sensitive needs to be
edited into `app.js` directly or committed to the repo.

Also update `src/appinfo.json` → `"id"` to your own reverse-domain app
ID (e.g. `com.yourname.ambientphotos`) if packaging manually — the
GitHub Action sets this (and `vendor`) for you.

There is no Google client ID/secret anywhere in the TV app — those live
only in the pairing backend's own environment variables.

## Testing locally in Chrome

Since it's plain static HTML/JS/CSS, you can preview the whole pairing
+ slideshow flow in a desktop browser before ever touching the TV or
`ares-package`. From inside `src/`:

```bash
cd src
npx serve .
```

Open the printed `http://localhost:...` URL in Chrome. Don't open
`index.html` directly via `file://` — `fetch()` calls and the QR code
renderer get blocked by browser security restrictions on that origin.
Since webOS's browser is also Chromium-based under the hood, this is a
genuinely useful proxy for what'll happen on the real TV, not just a
rough approximation — DevTools' Console/Network tabs during the flow
are the easiest way to catch problems early.

## 2. Install the webOS CLI (on your dev machine, not the TV)

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

## 3. Package and install

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
   phone — it takes you through Google sign-in and then straight into
   the Photos Picker to choose albums/photos, back to back.
2. The slideshow starts automatically once you finish picking, and keeps
   running; the picked-item list is silently refreshed every 50 minutes
   to keep image URLs (which expire hourly) valid. The refresh token and
   Picker session id are stored in `localStorage`, so a reboot skips
   pairing entirely — until that session eventually needs re-picking
   (Picker sessions aren't indefinite), at which point the same QR flow
   reappears automatically.

## 4. Generating the TV pairing key

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

## 5. Automatic deploys via GitHub Actions (`.github/workflows/deploy-webos.yml`)

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

- `WEBOS_TV_SSH_KEY_B64` — from section 4 above
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

### c) Pairing backend

Two repo secrets — the workflow writes both into `src/app.js` in place
of the `CONFIG.PAIRING_BACKEND_URL` / `CONFIG.PAIRING_SHARED_SECRET`
placeholders right before packaging:
- `PAIRING_BACKEND_URL` — e.g. `https://your-pairing-backend.vercel.app`
  (no trailing slash), from step 0
- `PAIRING_SHARED_SECRET` — the same value you set as the backend's
  `PAIRING_SHARED_SECRET` env var

There's no Google client ID/secret to add here — those belong to the
pairing backend's *own* Vercel project env vars, set up separately per
`pairing-backend/README.md`, and this GitHub Action never touches them.

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
- **`--no-minify`** on `ares-package` (see section 3 above).
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
- **Image count cap** (`CONFIG.MAX_ITEMS_TO_LOAD`) guards against loading
  an enormous picked album into memory at once; raise it if you picked a
  large album and want the full set in rotation.
- **Pairing timeout**: `CONFIG.PAIRING_POLL_TIMEOUT_MS` (10 minutes)
  matches the pairing backend's KV entry TTL — if you change one, change
  the other (`ex: 600` in `pairing-backend/api/callback.js`).
- webOS's browser engine is Chromium-based and modern enough for all the
  `fetch`/`async`/`URLSearchParams` used here, but if you're targeting a
  very old webOS 4 firmware revision, test on the actual TV early —
  device-specific `fetch` quirks do occasionally show up.
