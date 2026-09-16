import { kv } from "@vercel/kv";
import { withCors, corsPreflight } from "../../../../lib/cors";
import { isUuid } from "../../../../lib/uuid";

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");

  if (!isUuid(sessionId)) {
    return withCors(json({ error: "Missing or invalid sessionId" }, 400));
  }

  const key = `tv-handoff:${sessionId}`;

  // @vercel/kv (Upstash Redis under the hood) has no atomic GETDEL, so
  // this is a plain get-then-delete rather than one round trip. In
  // practice this is fine here: the only client that will ever call
  // this with a valid sessionId is the one TV that generated it, so
  // there's no realistic second poller racing to replay the same key
  // — but if this endpoint is ever exposed more broadly, revisit with
  // a Lua EVAL script for true atomicity.
  const tokens = await kv.get(key);

  if (tokens === null || tokens === undefined) {
    return withCors(json({ status: "pending" }, 202));
  }

  await kv.del(key);

  return withCors(json({ status: "ready", ...tokens }, 200));
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
