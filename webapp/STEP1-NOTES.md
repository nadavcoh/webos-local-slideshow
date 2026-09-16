# Step 1 — API routes + KV handoff

This is the first slice of the webOS rewrite: the two endpoints that
move Supabase tokens from a phone to the TV. Nothing here builds the
mobile UI, the TV client changes, or the `wa`/`hashes` queries yet —
those are separate steps.

## What's here

- `app/api/auth/tv-handoff/route.js` — `POST`, called by the mobile
  page after GitHub SSO completes. Verifies the `access_token` against
  Supabase itself (never trusts the client's claimed identity), checks
  the resulting email against `ALLOWED_EMAIL`, then stores both tokens
  in KV under `tv-handoff:<tvSessionId>` with a 300s TTL.
- `app/api/auth/tv-poll/route.js` — `GET ?sessionId=<uuid>`, called by
  the TV every ~3s. Returns `{status: "pending"}` (202) until the
  tokens show up, then `{status: "ready", access_token, refresh_token}`
  (200) and deletes the KV key in the same request.
- `lib/cors.js` — both routes need CORS since the TV app isn't served
  from this app's own origin; same class of bug the old
  `pairing-backend` hit on `/api/poll` and `/api/refresh`.
- `lib/uuid.js` — shared `tvSessionId`/`sessionId` format check.

## Setup

1. `npm install` in this directory.
2. Attach a Vercel KV (Upstash Redis) database to the Vercel project —
   this auto-populates `KV_REST_API_URL`/`KV_REST_API_TOKEN`, same as
   the old pairing-backend.
3. Copy `.env.example` to `.env.local` and fill in the Supabase project
   URL/anon key. `ALLOWED_EMAIL` defaults to `cohen.n@gmail.com` if
   unset.
4. `npm run dev`, then exercise the flow manually:
   ```bash
   # Simulate the TV starting a session:
   TV_SESSION=$(node -e "console.log(crypto.randomUUID())")

   # Simulate the mobile page after Supabase sign-in (use a real
   # access_token/refresh_token pair from a signed-in session):
   curl -X POST http://localhost:3000/api/auth/tv-handoff \
     -H "Content-Type: application/json" \
     -d "{\"tvSessionId\":\"$TV_SESSION\",\"access_token\":\"...\",\"refresh_token\":\"...\"}"

   # Simulate the TV polling:
   curl "http://localhost:3000/api/auth/tv-poll?sessionId=$TV_SESSION"
   # -> {"status":"ready","access_token":"...","refresh_token":"..."}
   curl "http://localhost:3000/api/auth/tv-poll?sessionId=$TV_SESSION"
   # -> {"status":"pending"}  (deleted after first successful poll)
   ```

## Design notes / things worth knowing before extending this

- **Not a real OAuth Device Flow** — it's a simpler bespoke handoff:
  the mobile page does a normal Supabase GitHub sign-in, then hands the
  resulting session tokens to the TV via this KV relay. There's no
  device code shown to the user or verified against Google/GitHub
  directly; the TV's UUID is just a pickup key. That's fine for a
  single-user app but worth naming so it isn't mistaken for RFC 8628.
- **get-then-delete, not atomic** — `@vercel/kv` (Upstash Redis) has no
  `GETDEL` exposed. Since only the one TV that generated a given
  `sessionId` will ever poll for it, the tiny window between the get
  and the del isn't a real replay risk here. Flagged in the route's
  comments if this ever gets reused somewhere less trusted.
- **Allowlist check happens server-side, not just in the mobile UI** —
  `tv-handoff` re-verifies the token and email itself rather than
  trusting whatever the mobile page sends, same reasoning as
  photo-match-pwa's allowlist.
- **CORS is wide open (`Access-Control-Allow-Origin: *`)** on both
  routes deliberately — the TV has no fixed origin (`file://` locally,
  an ares-package-assigned origin once installed) and the actual
  protection is the unguessable `tvSessionId` plus the tokens
  themselves, not origin-locking.

## Next steps (not built yet)

- Mobile `/tv-login` page: reads `?session=<uuid>` from the QR code,
  drives Supabase GitHub sign-in, then POSTs to `tv-handoff`.
- TV client changes: generate the UUID, render the QR code, poll
  `tv-poll`, call `supabase.auth.setSession()` once tokens arrive.
- The `wa`/`hashes` query logic and location/timestamp formatting for
  the slideshow's data source.
