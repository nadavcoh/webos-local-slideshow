# Step 2 — Mobile sign-in page (`/tv-login`)

Adds the page a phone lands on after scanning the TV's QR code. Builds
on Step 1 (`tv-handoff`/`tv-poll` API routes) — that KV logic didn't
change.

## What's here

- `app/tv-login/page.js` — client component, states:
  `loading -> needs-auth -> signing-in -> handing-off -> done` (or
  `error` at any point).
- `lib/supabaseClient.js` — browser Supabase client, explicit
  `flowType: "implicit"` (confirmed as the library default, set
  explicitly so a future major version bump can't silently change
  behavior here).
- `app/layout.js` — minimal root layout the App Router requires now
  that there's an actual page, not just API routes.

## How the redirect round-trip works

1. TV's QR code points at `https://your-app.vercel.app/tv-login?session=<uuid>`.
2. Page saves that `uuid` to `localStorage` immediately (the query
   string won't survive the trip to GitHub and back) and strips it from
   the visible URL.
3. User taps **Sign in with GitHub** →
   `supabase.auth.signInWithOAuth({ provider: "github", redirectTo:
   ".../tv-login" })`.
4. GitHub → Supabase → back to `/tv-login`, this time with the session
   in the URL hash (`#access_token=...`). `detectSessionInUrl` parses
   it automatically and fires a `SIGNED_IN` event.
5. The page's listener catches that, reads the `uuid` back out of
   `localStorage`, and POSTs both tokens to `/api/auth/tv-handoff`.
6. On success it clears `localStorage` and shows "TV connected"; the TV
   picks the tokens up on its next `tv-poll`.

## Setup — one thing you need to add in Supabase

**Auth → URL Configuration → Redirect URLs** needs
`https://your-app.vercel.app/tv-login` (and
`http://localhost:3000/tv-login` for local testing) added to the
allow-list, or `signInWithOAuth`'s redirect will be rejected. This is
a Supabase dashboard setting, not something in code.

## Testing locally

```bash
npm run dev
```

Then, with a real TV UUID (or any UUID for manual testing):

```
http://localhost:3000/tv-login?session=<uuid>
```

Sign in, and you should land on "TV connected." Confirm the handoff
actually worked by hitting the poll endpoint from Step 1:

```bash
curl "http://localhost:3000/api/auth/tv-poll?sessionId=<uuid>"
```

To test the allowlist rejection path, sign in with a GitHub account
other than `cohen.n@gmail.com` — you should land on the "This GitHub
account isn't authorized" error state, and `tv-handoff` should have
returned a 401 without ever writing to KV.

## Next steps (not built yet)

- webOS TV client: generate the UUID, render the QR pointing here,
  poll `tv-poll`, call `supabase.auth.setSession()` once tokens land.
- The `wa`/`hashes` query logic and location/timestamp formatting for
  the slideshow's photo data.
