# Step 4 — Deploy workflow (GitHub Action)

Updates the config-injection step in `deploy-webos.yml` to match the
new `CONFIG` shape from Step 3's `app.js` rewrite. Nothing else in the
workflow changed — Tailscale connect, ipk packaging, novacom
install steps are all untouched.

## Repo secrets — add these, remove the old ones

Add (matching the four `CONFIG` placeholders in the new `app.js`):

- `WEBAPP_URL` — the deployed Next.js web app's URL (Steps 1–2)
- `SUPABASE_URL` — same Supabase project the web app uses
- `SUPABASE_ANON_KEY` — the anon/public key (not the service role key)
- `PHOTO_SERVER_URL` — the local photo HTTP server's address

Remove (no longer referenced anywhere):

- `PAIRING_BACKEND_URL`
- `PAIRING_SHARED_SECRET`

`WEBOS_APP_ID`, `TS_OAUTH_CLIENT_ID`/`TS_OAUTH_SECRET`,
`WEBOS_TV_HOST`, `WEBOS_TV_SSH_KEY_B64`, `TV_PASSPHRASE` are unrelated
to this migration and stay as they are.

## Where this leaves `pairing-backend/`

Fully superseded — nothing in the deploy workflow, the TV app, or the
web app calls it anymore. Once you've confirmed the new flow works
end-to-end, it can be deleted (repo directory) and its own Vercel
project/env vars torn down. I haven't deleted it myself since you may
want to keep it around a little longer as a fallback during testing.

## Not touched yet

`CLAUDE.md` and `README.md` still describe the old Google Photos
Picker / pairing-backend architecture throughout — the session-recovery
notes, the "why Picker API" rationale, setup instructions, all of it
predates this migration. Worth a pass once the new flow is confirmed
working, so the docs match what's actually deployed. Say the word and
I'll take that on next.
