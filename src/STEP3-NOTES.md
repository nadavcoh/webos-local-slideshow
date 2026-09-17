# Step 3 — webOS TV client rewrite

Replaces every Google Photos Picker call and the old pairing-backend
polling with the Supabase/KV handoff from Steps 1–2, plus the new
`wa`/`hashes`-driven random photo fetching. Builds on the `WEBAPP_URL`
this TV now talks to for auth only — photo data itself comes straight
from Supabase using the TV's own authenticated client, not through the
web app.

## What changed vs. the original `src/`

- **`app.js`** — full rewrite. Same overall shape (CONFIG →
  DOM refs → pairing → data → slideshow engine → remote-control menu →
  screensaver suppression → boot), but:
  - Pairing (`runPairing`) now generates a UUID, shows a QR to
    `WEBAPP_URL/tv-login?session=<uuid>`, polls
    `WEBAPP_URL/api/auth/tv-poll`, and hydrates a session via
    `supabaseClient.auth.setSession()` instead of the old
    pairing-backend `/api/start` + `/api/poll` + Picker session dance.
  - **No more shared secret.** The old `PAIRING_SHARED_SECRET` gating
    `/api/start` doesn't have an equivalent — it isn't needed. A
    stranger who finds this TV's pairing URL only reaches a GitHub
    sign-in page; `tv-handoff` itself rejects anyone whose verified
    email isn't the allowed one, so there's nothing to gate earlier.
  - **Session refresh is automatic.** The old code manually tracked
    `accessToken`/`accessTokenExpiresAt` and called a `/api/refresh`
    endpoint. `supabase-js`'s client (`autoRefreshToken: true`) now
    handles this itself in the background — nothing in `app.js` calls
    refresh explicitly.
  - **No pre-loaded playlist.** The old code fetched a full
    `mediaItems.list` up front and stepped through it with an index.
    Now each slide calls `fetchRandomPhoto()` fresh against `wa` +
    `hashes`. A small in-memory `history` buffer (last 50 shown) is
    what makes Left-arrow "previous" still work despite there being no
    fixed list.
  - **"Repick Photos" has no equivalent** and was dropped from the
    remote menu (now just "Log Out"). There's no per-session picker
    selection anymore — flag if you'd rather that button do something
    else (e.g. force-skip to a new random photo, which Right-arrow
    already does during manual browsing).
- **`index.html`** — pairing screen's fallback QR step (for an
  unfinished Picker session) is gone; nothing replaces it since there's
  no analogous "finish selecting" step anymore. Added a second overlay
  line for location. Swapped the QR-only script include for that plus
  the Supabase JS **UMD/CDN build**
  (`cdn.jsdelivr.net/npm/@supabase/supabase-js@2`) — this app has no
  bundler, so the CDN global (`window.supabase.createClient`) is the
  right fit, not the npm package.
- **`style.css`** — `.overlay` restructured to stack a date line and a
  smaller, dimmer location line; unused picker-fallback selectors
  weren't targeted specifically so nothing needed removing there.
- **`secrets.local.js.example`** — replaced `PAIRING_BACKEND_URL`/
  `PAIRING_SHARED_SECRET` with `WEBAPP_URL`, `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`, `PHOTO_SERVER_URL`.
- **`appinfo.json`, `icon.png`, `keepalive.mp4`** — unchanged, copied
  as-is.

## Required Supabase setup — RLS policies

The TV queries `wa` and `hashes` using the *authenticated user's own*
Supabase session (the tokens handed off from the phone), not a service
role key — same pattern as photo-match-next. If RLS is enabled on
these tables with no matching policy, every query will silently return
zero rows rather than erroring. Something like this is needed (adjust
table/column names if they differ from the spec):

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

## One thing to verify before this runs correctly

`wa.filetype` — the spec says "Image or image/jpeg." `app.js` currently
filters with `.in("filetype", ["image", "image/jpeg"])`
(`CONFIG.IMAGE_FILETYPES`). If the actual column stores something else
(e.g. just a bare extension, or full MIME types like `image/png` too),
update that array — worth a quick `select distinct filetype from wa`
to confirm actual values before relying on this filter.

## Testing locally

```bash
npx serve .
```

from `src/`, with `secrets.local.js` filled in (copy from the
`.example`). Note that `WebOSServiceBridge`-based screensaver
suppression will simply no-op in a desktop browser — that's expected,
not a bug to chase locally.

## Next steps (not built yet)

- Anything on the deploy-workflow / GitHub Action side — the Action
  currently substitutes `PAIRING_BACKEND_URL`/`PAIRING_SHARED_SECRET`
  into `app.js` at build time; it'll need updating to substitute the
  four new `CONFIG` values instead (from new repo secrets: `WEBAPP_URL`,
  `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PHOTO_SERVER_URL`). I haven't
  touched `.github/workflows/` yet — say the word and I'll take that on
  next, or fold it into a broader CLAUDE.md/README.md update pass once
  everything else is settled.
- Confirming the `wa.filetype` values (above) and the RLS policies
  actually exist in the live database.
- Retiring `pairing-backend/` once this is confirmed working (it's
  fully superseded by the web app's `/api/auth/*` routes now).
