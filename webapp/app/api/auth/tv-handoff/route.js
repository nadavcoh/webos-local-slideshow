import { kv } from "@vercel/kv";
import { createClient } from "@supabase/supabase-js";
import { withCors, corsPreflight } from "../../../../lib/cors";
import { isUuid } from "../../../../lib/uuid";

// Same account restriction pattern as photo-match-next: single-user app, so the
// allowlist is one GitHub user id (numeric, never changes), not a table.
const ALLOWED_GITHUB_ID = process.env.ALLOWED_GITHUB_ID || "29537286";

// Matches CONFIG.PAIRING_POLL_TIMEOUT_MS's role in the old pairing
// backend, just shorter — this handoff is meant to be picked up by an
// already-polling TV within seconds, not minutes.
const HANDOFF_TTL_SECONDS = 300;

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return withCors(json({ error: "Invalid JSON body" }, 400));
  }

  const { tvSessionId, access_token, refresh_token } = body || {};

  if (!isUuid(tvSessionId)) {
    return withCors(json({ error: "Missing or invalid tvSessionId" }, 400));
  }
  if (!access_token || !refresh_token) {
    return withCors(json({ error: "Missing access_token or refresh_token" }, 400));
  }

  // Verify the access_token is real and current by asking Supabase, and
  // check the GitHub identity server-side — never trust anything the mobile page
  // claims about who's signed in. A forged/expired token, or a token
  // for the wrong GitHub account, is rejected before it ever reaches KV.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  const { data, error } = await supabase.auth.getUser(access_token);

  if (error || !data?.user) {
    return withCors(json({ error: "Invalid Supabase session" }, 401));
  }

  // identities are set by the auth server (user_metadata is user-editable and is
  // not used). For a GitHub identity, `id` is the GitHub user id.
  const isOwner = (data.user.identities ?? []).some(
    (identity) =>
      identity.provider === "github" &&
      (String(identity.id) === ALLOWED_GITHUB_ID ||
        String(identity.identity_data?.sub) === ALLOWED_GITHUB_ID)
  );
  if (!isOwner) {
    // Deliberately the same generic message as an invalid token above —
    // don't tell a stranger "you're signed in fine, just not the owner."
    return withCors(json({ error: "Invalid Supabase session" }, 401));
  }

  await kv.set(
    `tv-handoff:${tvSessionId}`,
    { access_token, refresh_token },
    { ex: HANDOFF_TTL_SECONDS }
  );

  return withCors(json({ ok: true }, 200));
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
