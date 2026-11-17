"use client";

import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

// The QR code encodes ?session=<uuid>. That query string won't survive
// the round trip to GitHub and back (Supabase's redirect replaces it
// with its own auth params), so it's stashed here before redirecting
// and read back afterward.
const SESSION_STORAGE_KEY = "tv_pairing_session_id";

export default function TvLoginPage() {
  const [status, setStatus] = useState("loading");
  const [errorMessage, setErrorMessage] = useState("");
  // True when the failure happened after signing in, so trying another GitHub
  // account can help (not for a missing pairing session).
  const [canSwitch, setCanSwitch] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("session");

    if (fromQuery) {
      localStorage.setItem(SESSION_STORAGE_KEY, fromQuery);
      // Drop it from the visible URL/history now that it's saved —
      // nothing later needs it there, and a stray browser-history entry
      // with someone else's pairing UUID isn't worth keeping around.
      window.history.replaceState({}, "", window.location.pathname);
    }

    const tvSessionId = fromQuery || localStorage.getItem(SESSION_STORAGE_KEY);

    if (!tvSessionId) {
      setStatus("error");
      setErrorMessage("No pairing session found. Scan the QR code on your TV again.");
      return;
    }

    // Covers two paths with one listener: landing here fresh from
    // GitHub's redirect (fires SIGNED_IN once the hash is parsed), and
    // a session that already existed on this device/browser.
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) {
        handOff(session, tvSessionId);
      }
    });

    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        handOff(data.session, tvSessionId);
      } else {
        setStatus("needs-auth");
      }
    });

    return () => authListener.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handOff(session, tvSessionId) {
    setStatus("handing-off");
    try {
      const res = await fetch("/api/auth/tv-handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tvSessionId,
          access_token: session.access_token,
          refresh_token: session.refresh_token,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus("error");
        setCanSwitch(true);
        setErrorMessage(
          body.error === "Invalid Supabase session"
            ? "This GitHub account isn't authorized for this TV."
            : "Something went wrong finishing sign-in. Scan the QR code again."
        );
        return;
      }

      localStorage.removeItem(SESSION_STORAGE_KEY);
      setStatus("done");
    } catch {
      setStatus("error");
      setCanSwitch(true);
      setErrorMessage("Couldn't reach the server. Check your connection and try again.");
    }
  }

  async function signIn() {
    setStatus("signing-in");
    await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: `${window.location.origin}/tv-login`,
        // Make GitHub show its account picker instead of silently reusing the
        // account that is already signed in in this browser / PWA.
        queryParams: { prompt: "select_account" },
      },
    });
    // Browser navigates to GitHub here; nothing after this line runs
    // in this page load.
  }

  // Drop the (wrong) session on this device, then sign in again with the picker.
  async function switchAccount() {
    await supabase.auth.signOut();
    await signIn();
  }

  return (
    <main className="wrap">
      {status === "loading" && <p>Checking pairing session…</p>}

      {status === "needs-auth" && (
        <>
          <h1>Connect your TV</h1>
          <p>Sign in to link this slideshow to your photo library.</p>
          <button onClick={signIn}>Sign in with GitHub</button>
        </>
      )}

      {status === "signing-in" && <p>Redirecting to GitHub…</p>}
      {status === "handing-off" && <p>Connecting your TV…</p>}

      {status === "done" && (
        <>
          <h1>✓ TV connected</h1>
          <p>You can close this page — your slideshow will start shortly.</p>
        </>
      )}

      {status === "error" && (
        <>
          <h1>Something went wrong</h1>
          <p>{errorMessage}</p>
          {canSwitch && (
            <button onClick={switchAccount}>Use a different GitHub account</button>
          )}
        </>
      )}

      <style jsx>{`
        .wrap {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 24px;
          font-family: system-ui, -apple-system, sans-serif;
          background: #0b0b0d;
          color: #f2f2f2;
        }
        h1 {
          font-size: 22px;
          margin-bottom: 8px;
        }
        p {
          color: #b3b3b3;
          max-width: 320px;
        }
        button {
          margin-top: 20px;
          padding: 14px 28px;
          font-size: 16px;
          border-radius: 8px;
          border: none;
          background: #24292f;
          color: white;
          cursor: pointer;
        }
        button:active {
          background: #1a1e22;
        }
      `}</style>
    </main>
  );
}
