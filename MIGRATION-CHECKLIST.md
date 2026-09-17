# Migration checklist — Google Photos Picker → Supabase/KV

Everything from Steps 1–5 in one place, as an actual cutover checklist
rather than a per-step build log. Directory names in this archive now
match the real repo (`src/`, `webapp/`, `.github/`, root `README.md`/
`CLAUDE.md`) — this is meant to be dropped in wholesale, not diffed by
hand.

## 1. Supabase (do first)

- [ ] GitHub added as an Auth provider on the project
- [ ] RLS enabled + policies applied on `wa` and `hashes` (SQL in
      `README.md` section 0) — **without this, the TV app will get
      zero rows back with no error**, so don't skip it even for a
      quick test
- [ ] `select distinct filetype from wa` run once, and
      `CONFIG.IMAGE_FILETYPES` in `src/app.js` adjusted if the actual
      values aren't `["image", "image/jpeg"]`
- [ ] Auth → URL Configuration → Redirect URLs includes
      `https://<webapp>.vercel.app/tv-login` and, if testing locally,
      `http://localhost:3000/tv-login`

## 2. `webapp/` deploy

- [ ] Vercel KV database attached to the project
- [ ] Env vars set: `NEXT_PUBLIC_SUPABASE_URL`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ALLOWED_EMAIL`
- [ ] Deployed, URL noted for the next section
- [ ] (Optional but recommended) manual `curl` walkthrough from
      `webapp/STEP1-NOTES.md` to confirm `tv-handoff`/`tv-poll` work
      before wiring up the TV

## 3. GitHub repo secrets (for the Action)

Add:
- [ ] `WEBAPP_URL`
- [ ] `SUPABASE_URL`
- [ ] `SUPABASE_ANON_KEY`
- [ ] `PHOTO_SERVER_URL`

Remove (nothing references these anymore):
- [ ] `PAIRING_BACKEND_URL`
- [ ] `PAIRING_SHARED_SECRET`

Unchanged: `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`,
`WEBOS_TV_SSH_KEY_B64`, `WEBOS_TV_HOST`, `TV_PASSPHRASE`,
`WEBOS_APP_ID`.

## 4. Drop in the new files

Replace, in your actual repo:
- `src/` — entirely (app.js, index.html, style.css, secrets.local.js.example, appinfo.json/icon.png/keepalive.mp4 unchanged but included for completeness)
- `.github/workflows/deploy-webos.yml`
- `README.md`, `CLAUDE.md` at repo root
- Add `webapp/` as a new top-level directory (own Vercel project, not packaged by `ares-package`)

## 5. Test end-to-end

- [ ] Push to `main` (or `workflow_dispatch`) and confirm the Action
      packages and installs successfully with the new secrets
- [ ] On the TV: scan the QR, sign in with the allowed GitHub account
      on your phone, confirm the slideshow starts
- [ ] Confirm timestamp + location overlay render correctly for a few
      different photos (including ones where location might be empty)
- [ ] Try signing in with a **different** GitHub account once, to
      confirm the allowlist actually rejects it (`tv-handoff` should
      401, mobile page should show "not authorized")
- [ ] Reboot the TV (or relaunch the app) and confirm it skips
      pairing entirely — session should persist via Supabase's own
      token refresh
- [ ] Use the remote menu's **Log Out**, confirm it drops back to a
      fresh QR

## 6. Retire `pairing-backend/`

Only after the above is confirmed working — this deliberately isn't
automatic:

```bash
git rm -r pairing-backend/
```

Then in the Google Cloud Console, the OAuth client used only by
`pairing-backend/` can be deleted (it's not used anywhere else), and
the `pairing-backend/`-specific Vercel project can be torn down —
delete the project itself and, if desired, remove its
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI`/
`PAIRING_SHARED_SECRET` env vars along with it (nothing else in this
migration depends on any of those).
