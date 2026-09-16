import { createClient } from "@supabase/supabase-js";

// Implicit flow is the library default (confirmed against
// @supabase/auth-js), and it's the right choice here: this is a plain
// client-rendered page with no server route to exchange a PKCE code,
// so tokens coming back from GitHub land in the URL hash and
// detectSessionInUrl (also on by default) parses them automatically.
// Set explicitly so a future upgrade that changes the library default
// doesn't silently break this page.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  {
    auth: {
      flowType: "implicit",
      detectSessionInUrl: true,
      persistSession: true,
    },
  }
);
