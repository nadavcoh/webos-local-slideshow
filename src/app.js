/* ============================================================
 * Ambient Photos — app.js
 *
 * Flow:
 *   1. If we have a stored refresh token AND Picker session id, use
 *      the pairing backend to refresh an access token silently and
 *      check whether that session still has media sources set.
 *   2. Otherwise run the pairing flow: show one QR code linking to
 *      the pairing backend's /api/start?state=<code>&key=<shared
 *      secret>. That backend handles the full Google OAuth
 *      Authorization Code exchange (server-side, so the client secret
 *      never lives in this app), creates a Picker session, and hands
 *      both back to us once the user finishes on their phone. We poll
 *      /api/poll for this.
 *   3. If the Picker session isn't done yet (mediaItemsSet false) —
 *      normally the phone is auto-redirected straight into it by the
 *      backend, but just in case, show a fallback QR/link to the
 *      session's own pickerUri and keep polling.
 *   4. Once media sources are set, list curated media items and
 *      start the slideshow. Base URLs (the actual image bytes)
 *      expire after ~60 minutes, so the media list is silently
 *      re-fetched on a timer without interrupting playback.
 *
 * CONFIG VALUES: loaded from window.APP_CONFIG if present (see
 * secrets.local.js.example — copy it to secrets.local.js, gitignored,
 * for local testing with `npx serve .` from this directory), else
 * fall back to the placeholder strings below, which the GitHub Action
 * substitutes at build time. Either way, nothing sensitive is
 * committed to the repo.
 *
 * IMPORTANT — read the README before running this:
 *   Two other approaches were tried and rejected before landing here:
 *     - `mediaItems:search` (Library API) stopped supporting general
 *       library search on April 1, 2025.
 *     - The Photos Ambient API (a better architectural fit — a
 *       persistent device + ongoing curated feed) requires acceptance
 *       into Google's Photos Partner Program; it's not self-serve.
 *   The Picker API works without any partner approval, but its scope
 *   isn't on Google's allow-list for the Device Authorization Grant
 *   (requesting it returns `invalid_scope`). So OAuth consent has to
 *   go through a standard Authorization Code flow instead, which
 *   needs a real HTTPS redirect URI — hence the small pairing-backend/
 *   service this app now talks to instead of Google directly for
 *   anything auth-related. See README.md and pairing-backend/README.md.
 * ============================================================ */

/* ---------------------- CONFIG ---------------------- */

const localConfig = (typeof window !== "undefined" && window.APP_CONFIG) || {};

const CONFIG = {
  // Base URL of the deployed pairing-backend/ service, no trailing
  // slash. There is no Google client ID/secret in this file at all —
  // those live server-side in the pairing backend.
  PAIRING_BACKEND_URL: localConfig.PAIRING_BACKEND_URL || "https://YOUR-PAIRING-BACKEND.vercel.app",

  // Shared secret required by /api/start, so a stranger who finds the
  // backend's URL can't spin up OAuth consent flows against your
  // Google Cloud project. This only raises the bar (anyone who
  // extracts the packaged .ipk can read it back out) — it's not a
  // substitute for keeping the backend URL itself out of casual reach.
  PAIRING_SHARED_SECRET: localConfig.PAIRING_SHARED_SECRET || "YOUR_PAIRING_SHARED_SECRET",

  PAIRING_POLL_INTERVAL_MS: 3 * 1000,
  PAIRING_POLL_TIMEOUT_MS: 10 * 60 * 1000, // matches the backend's 10-minute KV entry TTL

  PICKER_SESSION_URL: "https://photospicker.googleapis.com/v1/sessions",
  PICKER_MEDIA_ITEMS_URL: "https://photospicker.googleapis.com/v1/mediaItems",

  // How long to keep polling the Picker session waiting for the user
  // to finish picking (fallback path only — normally this finishes
  // during the pairing redirect chain before we even get here).
  MEDIA_SOURCE_POLL_TIMEOUT_MS: 30 * 60 * 1000,

  // Slideshow behavior
  SLIDE_INTERVAL_MS: 15 * 1000,          // 15 seconds per requirement
  MEDIA_LIST_REFRESH_MS: 50 * 60 * 1000, // re-fetch baseUrls before the 60 min expiry
  MAX_ITEMS_TO_LOAD: 200,

  // localStorage keys
  LS_REFRESH_TOKEN: "ambient_photos_refresh_token",
  LS_PICKER_SESSION_ID: "ambient_photos_picker_session_id",
};

/* ---------------------- DOM ---------------------- */

const el = {
  boot: document.getElementById("boot-screen"),
  pairing: document.getElementById("pairing-screen"),
  slideshow: document.getElementById("slideshow-screen"),

  connectStep: document.getElementById("pairing-step-connect"),
  connectQr: document.getElementById("connect-qr"),
  connectUrl: document.getElementById("connect-url"),
  connectStatus: document.getElementById("connect-status"),

  mediaFallback: document.getElementById("pairing-step-media-fallback"),
  mediaQr: document.getElementById("media-qr"),
  mediaUrl: document.getElementById("media-url"),

  pairingError: document.getElementById("pairing-error"),

  layerA: document.getElementById("layer-a"),
  layerB: document.getElementById("layer-b"),
  overlayDate: document.getElementById("overlay-date"),

  menuOverlay: document.getElementById("menu-overlay"),
  menuRepick: document.getElementById("menu-repick"),
  menuLogout: document.getElementById("menu-logout"),

  keepalive: document.getElementById("keepalive"),
};

function showScreen(name) {
  el.boot.classList.add("hidden");
  el.pairing.classList.add("hidden");
  el.slideshow.classList.add("hidden");
  ({ boot: el.boot, pairing: el.pairing, slideshow: el.slideshow })[name].classList.remove("hidden");
}

function showError(message) {
  el.pairingError.textContent = message;
  el.pairingError.classList.remove("hidden");
}

function hideError() {
  el.pairingError.classList.add("hidden");
  el.pairingError.textContent = "";
}

/* ---------------------- STORAGE ---------------------- */

const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* storage disabled — session-only */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* no-op */ }
  },
};

/** RFC 4122 v4 UUID, without relying on crypto.randomUUID (unavailable on
 *  older Chromium builds that some webOS versions ship with). Used here
 *  as the pairing "state" code — treat it like a short-lived credential. */
function uuidv4() {
  const bytes = new Uint8Array(16);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

/* In-memory access token (never persisted — only the refresh token is) */
let accessToken = null;
let accessTokenExpiresAt = 0;

/* ============================================================
 * STEP A — Pairing (via pairing-backend/, not Google directly)
 * ============================================================ */

/** Polls the backend until /api/callback has stashed tokens + session for this code. */
function pollPairingBackend(pairingCode) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + CONFIG.PAIRING_POLL_TIMEOUT_MS;
    const poll = async () => {
      if (Date.now() > deadline) {
        reject(new Error("Pairing timed out before it was completed. Please try again."));
        return;
      }
      try {
        const res = await fetch(`${CONFIG.PAIRING_BACKEND_URL}/api/poll?state=${pairingCode}`);
        if (res.status === 200) {
          resolve(await res.json());
          return;
        }
        // 202 (pending) or a transient error — keep polling either way.
      } catch (networkErr) {
        // keep polling through transient network errors
      }
      setTimeout(poll, CONFIG.PAIRING_POLL_INTERVAL_MS);
    };
    poll();
  });
}

/** Runs the full pairing UI + polling sequence and stores the resulting credentials. */
async function runPairing() {
  showScreen("pairing");
  el.mediaFallback.classList.add("hidden");
  el.connectStep.classList.remove("hidden");
  el.connectStatus.textContent = "Preparing…";

  const pairingCode = uuidv4();
  const startUrl = `${CONFIG.PAIRING_BACKEND_URL}/api/start?state=${pairingCode}&key=${encodeURIComponent(CONFIG.PAIRING_SHARED_SECRET)}`;

  el.connectUrl.textContent = startUrl.replace(/^https?:\/\//, "").split("&key=")[0];
  el.connectQr.innerHTML = "";
  // eslint-disable-next-line no-undef
  new QRCode(el.connectQr, { text: startUrl, width: 480, height: 480 });
  el.connectStatus.textContent = "Waiting for sign-in…";

  const result = await pollPairingBackend(pairingCode);
  // result: { refreshToken, accessToken, accessTokenExpiresAt, sessionId }

  accessToken = result.accessToken;
  accessTokenExpiresAt = result.accessTokenExpiresAt;
  store.set(CONFIG.LS_REFRESH_TOKEN, result.refreshToken);
  store.set(CONFIG.LS_PICKER_SESSION_ID, result.sessionId);

  el.connectStep.classList.add("hidden");
  return result.sessionId;
}

/** Exchanges a stored refresh token for a fresh access token via the backend. */
async function refreshAccessToken() {
  const refreshToken = store.get(CONFIG.LS_REFRESH_TOKEN);
  if (!refreshToken) throw new Error("No refresh token stored.");

  const res = await fetch(`${CONFIG.PAIRING_BACKEND_URL}/api/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });

  if (!res.ok) {
    // Refresh token itself is invalid/revoked — force a fresh pairing.
    store.remove(CONFIG.LS_REFRESH_TOKEN);
    store.remove(CONFIG.LS_PICKER_SESSION_ID);
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const body = await res.json();
  accessToken = body.accessToken;
  accessTokenExpiresAt = Date.now() + body.expiresIn * 1000;
}

/** Returns a valid access token via the stored refresh token, or null if we need to pair. */
async function ensureAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt - 60_000) {
    return accessToken;
  }
  if (!store.get(CONFIG.LS_REFRESH_TOKEN)) {
    return null;
  }
  try {
    await refreshAccessToken();
    return accessToken;
  } catch (e) {
    return null;
  }
}

/* ============================================================
 * STEP B — Google Photos Picker API
 * ============================================================ */

async function getPickerSession(token, sessionId) {
  const res = await fetch(`${CONFIG.PICKER_SESSION_URL}/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Picker session lookup failed: ${res.status}`);
  return res.json();
}

/** Polls a picker session until the user finishes selecting media on their phone. */
function pollPickerSession(token, sessionId, pollIntervalSeconds, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = async () => {
      if (Date.now() > deadline) {
        reject(new Error("Timed out waiting for a photo selection."));
        return;
      }
      let session;
      try {
        session = await getPickerSession(token, sessionId);
      } catch (err) {
        setTimeout(poll, pollIntervalSeconds * 1000);
        return;
      }
      if (session.mediaItemsSet) {
        resolve(session);
      } else {
        setTimeout(poll, pollIntervalSeconds * 1000);
      }
    };
    poll();
  });
}

/**
 * Makes sure the given Picker session has media sources selected.
 * Normally the phone was already auto-redirected into the picker by
 * the backend during pairing, so this resolves almost immediately.
 * If not (e.g. re-showing after a restart with an unfinished session),
 * shows a fallback QR/link to the session's own pickerUri.
 */
async function ensureSessionReady(token, sessionId) {
  showScreen("pairing");
  el.connectStep.classList.add("hidden");

  let session = await getPickerSession(token, sessionId);
  if (session.mediaItemsSet) return;

  el.mediaFallback.classList.remove("hidden");
  el.mediaUrl.textContent = session.pickerUri.replace(/^https?:\/\//, "");
  el.mediaQr.innerHTML = "";
  // eslint-disable-next-line no-undef
  new QRCode(el.mediaQr, { text: session.pickerUri, width: 480, height: 480 });

  const pollInterval = session.pollingConfig?.pollInterval
    ? parseFloat(session.pollingConfig.pollInterval)
    : 3;

  await pollPickerSession(token, sessionId, pollInterval, CONFIG.MEDIA_SOURCE_POLL_TIMEOUT_MS);
  el.mediaFallback.classList.add("hidden");
}

/** Fetches every picked media item for a completed session (paginated). */
async function listPickedMediaItems(token, sessionId) {
  const items = [];
  let pageToken = "";

  do {
    const url = new URL(CONFIG.PICKER_MEDIA_ITEMS_URL);
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`mediaItems.list failed: ${res.status}`);
    const body = await res.json();

    (body.mediaItems || []).forEach((item) => items.push(item));
    pageToken = body.nextPageToken || "";
  } while (pageToken && items.length < CONFIG.MAX_ITEMS_TO_LOAD);

  // Photos only — skip videos for a still-image ambient slideshow.
  return items.filter((item) => item.mediaFile?.mimeType?.startsWith("image/"));
}

/* ============================================================
 * STEP C — Slideshow engine
 * ============================================================ */

let mediaItems = [];
let displayedIndex = -1; // index of the currently-visible item; -1 = nothing shown yet
let visibleLayer = el.layerA;
let hiddenLayer = el.layerB;
let slideTimer = null;

/** Google Photos base URLs need a size suffix and expire after ~60 min. */
function fullResUrl(item) {
  return `${item.mediaFile.baseUrl}=w1920-h1080`;
}

function formatDate(item) {
  const iso = item.mediaFile?.mediaFileMetadata?.creationTime || item.createTime;
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Google Photos base URLs (Library API and Picker API alike) are not
 * plain public image URLs — Google requires the request to carry the
 * same OAuth access token as an `Authorization: Bearer` header, or it
 * 403s. A bare <img src="..."> can't attach that header, so we fetch
 * the bytes ourselves and hand the <img> a local blob: URL instead.
 */
function preload(item) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        const token = await ensureAccessToken();
        if (!token) throw new Error("No access token available for image fetch.");

        const res = await fetch(fullResUrl(item), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);

        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);

        const img = new Image();
        img.onload = () => resolve(objectUrl);
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error("Image failed to decode."));
        };
        img.src = objectUrl;
      } catch (e) {
        reject(e);
      }
    })();
  });
}

/** Loads and crossfades in a specific item. Returns false (without
 *  throwing) if the item's image failed to load/decode, so callers can
 *  skip to the next one in whichever direction they're going. */
async function renderItem(item) {
  let url;
  try {
    url = await preload(item);
  } catch (e) {
    return false;
  }

  // hiddenLayer is about to be overwritten and has been off-screen since
  // the previous-previous cycle, so its old blob: URL is safe to free.
  if (hiddenLayer.dataset.objectUrl) {
    URL.revokeObjectURL(hiddenLayer.dataset.objectUrl);
  }
  hiddenLayer.src = url;
  hiddenLayer.dataset.objectUrl = url;
  el.overlayDate.textContent = formatDate(item);

  // Crossfade: fade the new layer in, fade the old one out, then swap roles.
  hiddenLayer.classList.add("visible");
  visibleLayer.classList.remove("visible");
  [visibleLayer, hiddenLayer] = [hiddenLayer, visibleLayer];
  return true;
}

async function showNextSlide() {
  if (mediaItems.length === 0) return;
  displayedIndex = (displayedIndex + 1) % mediaItems.length;
  const ok = await renderItem(mediaItems[displayedIndex]);
  if (!ok) showNextSlide(); // skip a broken/expired item, try the next one immediately
}

async function showPrevSlide() {
  if (mediaItems.length === 0) return;
  displayedIndex = (displayedIndex - 1 + mediaItems.length) % mediaItems.length;
  const ok = await renderItem(mediaItems[displayedIndex]);
  if (!ok) showPrevSlide(); // skip a broken/expired item, try the previous one immediately
}

function restartSlideTimer() {
  clearInterval(slideTimer);
  slideTimer = setInterval(showNextSlide, CONFIG.SLIDE_INTERVAL_MS);
}

/** Manual navigation from the remote — jumps immediately and resets the
 *  auto-advance clock so it doesn't fire right on top of the manual one. */
function goToNextSlide() {
  showNextSlide();
  restartSlideTimer();
}

function goToPrevSlide() {
  showPrevSlide();
  restartSlideTimer();
}

function startSlideshow() {
  showScreen("slideshow");
  showNextSlide();
  restartSlideTimer();
}

/** Re-fetches the media list (fresh baseUrls) without interrupting playback. */
let mediaListRefreshTimer = null;
function scheduleMediaListRefresh(sessionId) {
  clearInterval(mediaListRefreshTimer); // repick/relogin can call this again — don't stack timers
  mediaListRefreshTimer = setInterval(async () => {
    try {
      const token = await ensureAccessToken();
      if (!token) return; // next tick retries; boot() only re-pairs on startup
      const fresh = await listPickedMediaItems(token, sessionId);
      if (fresh.length) mediaItems = fresh;
    } catch (err) {
      // Keep showing the current (possibly stale) list; next tick retries.
      console.error("Media list refresh failed:", err);
    }
  }, CONFIG.MEDIA_LIST_REFRESH_MS);
}

/* ============================================================
 * STEP D — Remote-control menu (repick / log out)
 * ============================================================ */

/** Creates a brand-new Picker session for the already-authorized
 *  account — no Google sign-in required, unlike full pairing. Called
 *  directly against Google (same as getPickerSession/listPickedMediaItems
 *  already do); this JSON endpoint accepts cross-origin Bearer-token
 *  requests same as those do. */
async function createPickerSession(token) {
  const res = await fetch(CONFIG.PICKER_SESSION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!res.ok) throw new Error(`Picker session creation failed: ${res.status}`);
  return res.json();
}

/** "Repick Photos": keeps the current Google sign-in, just opens a new
 *  Picker session so a different album/selection can be chosen. Shows
 *  only the photo-picker QR (pairing-step-media-fallback), not the
 *  full sign-in QR. */
async function repickPhotos() {
  clearInterval(slideTimer);
  clearInterval(mediaListRefreshTimer);
  hideError();

  try {
    const token = await ensureAccessToken();
    if (!token) {
      // Refresh token itself is gone/invalid — nothing to repick with.
      await logOut();
      return;
    }

    const session = await createPickerSession(token);
    store.set(CONFIG.LS_PICKER_SESSION_ID, session.id);

    showScreen("pairing");
    el.connectStep.classList.add("hidden"); // skip the sign-in QR — already signed in
    await ensureSessionReady(token, session.id);

    mediaItems = await listPickedMediaItems(token, session.id);
    if (mediaItems.length === 0) {
      throw new Error("No photos were selected.");
    }

    scheduleMediaListRefresh(session.id);
    startSlideshow();
  } catch (err) {
    console.error(err);
    showScreen("pairing");
    el.connectStep.classList.add("hidden");
    showError(err.message || "Repicking photos failed.");
  }
}

/** "Log Out": clears everything (refresh token + Picker session) and
 *  drops back to the full sign-in QR, same as a fresh first run. */
async function logOut() {
  clearInterval(slideTimer);
  clearInterval(mediaListRefreshTimer);

  store.remove(CONFIG.LS_REFRESH_TOKEN);
  store.remove(CONFIG.LS_PICKER_SESSION_ID);
  accessToken = null;
  accessTokenExpiresAt = 0;
  mediaItems = [];

  el.connectStep.classList.remove("hidden");
  hideError();
  boot();
}

/* ---- Remote-control wiring: any button reveals the menu, D-pad moves
 *      focus between the two buttons, OK activates natively, Back/Escape
 *      dismisses, and it auto-hides after a few seconds either way. ---- */

let menuHideTimer = null;
const MENU_AUTO_HIDE_MS = 8000;

function menuIsOpen() {
  return !el.menuOverlay.classList.contains("hidden");
}

function showMenu() {
  clearTimeout(menuHideTimer);
  el.menuOverlay.classList.remove("hidden");
  el.menuRepick.focus();
  menuHideTimer = setTimeout(hideMenu, MENU_AUTO_HIDE_MS);
}

function hideMenu() {
  clearTimeout(menuHideTimer);
  el.menuOverlay.classList.add("hidden");
}

/**
 * webOS's remote Back button is unreliable to detect by `e.key` alone —
 * different firmware/remote combos report it as `Backspace`, `Escape`,
 * or (most commonly on actual LG TVs) `e.key === "GoBack"` /
 * `"Unidentified"` with `e.keyCode === 461`. Check all of them rather
 * than trusting one. If Back still doesn't fire, use `ares-inspect` to
 * open remote DevTools and check the real `e.key`/`e.keyCode` values
 * this specific remote sends, then add them here.
 */
function isBackKey(e) {
  return e.keyCode === 461 || e.key === "GoBack" || e.key === "Backspace" || e.key === "Escape";
}

document.addEventListener("keydown", (e) => {
  if (el.slideshow.classList.contains("hidden")) return; // only during playback

  if (menuIsOpen()) {
    clearTimeout(menuHideTimer);
    menuHideTimer = setTimeout(hideMenu, MENU_AUTO_HIDE_MS);

    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      const next = document.activeElement === el.menuRepick ? el.menuLogout : el.menuRepick;
      next.focus();
      e.preventDefault();
    } else if (isBackKey(e)) {
      hideMenu();
      e.preventDefault();
    }
    // Enter/OK activates whichever button is focused via native <button> behavior.
    return;
  }

  // Menu closed: Left/Right browse photos manually; Back is a no-op
  // (nothing open to dismiss); anything else opens the menu.
  if (e.key === "ArrowRight") {
    goToNextSlide();
    e.preventDefault();
  } else if (e.key === "ArrowLeft") {
    goToPrevSlide();
    e.preventDefault();
  } else if (isBackKey(e)) {
    e.preventDefault();
  } else {
    showMenu();
    e.preventDefault();
  }
});

el.menuRepick.addEventListener("click", () => {
  hideMenu();
  repickPhotos();
});

el.menuLogout.addEventListener("click", () => {
  hideMenu();
  logOut();
});

/* ============================================================
 * Screensaver suppression (webOS TV)
 * ============================================================ */

/**
 * Primary mechanism: an invisible 1x1, muted, looping local video.
 * webOS explicitly exempts active video playback from the screensaver
 * at the OS level (see appinfo.json's "enablePigScreenSaver" docs) —
 * unlike the tvpower Luna service below, this needs no special
 * permission, so it isn't at the mercy of what a third-party .ipk is
 * allowed to call. Self-heals if the video is ever paused (some
 * webOS versions pause background <video> elements briefly during
 * transitions) by immediately resuming it.
 */
function startKeepaliveVideo() {
  if (!el.keepalive) return;
  const tryPlay = () => el.keepalive.play().catch((err) => console.error("Keepalive video play() failed:", err));
  el.keepalive.addEventListener("pause", tryPlay);
  el.keepalive.addEventListener("ended", tryPlay); // loop should handle this, but just in case
  tryPlay();
}

/**
 * Secondary, best-effort mechanism: webOS's own screensaver-defer Luna
 * handshake. This is likely what silently failed before — this call
 * (com.webos.service.tvpower) is a privileged system service, and a
 * plain third-party .ipk (not homebrew-rooted, not LG-signed) is often
 * denied access to it outright by the platform's ACG permission system,
 * with no visible error unless you're watching for it. Now logs both
 * the registration result and every deferral, so `ares-inspect` will
 * show plainly whether this is actually being allowed to run — check
 * those logs before assuming this half of the fix is the problem.
 *   1. Subscribe to registerScreenSaverRequest.
 *   2. Each time it calls back with state: "Active" (i.e. "about to
 *      start"), reply via responseScreenSaverRequest with ack: false,
 *      which defers it — and it'll ask again next cycle, so this just
 *      keeps saying no indefinitely for as long as the app is running.
 * Only exists inside the real webOS runtime (`WebOSServiceBridge`) —
 * this no-ops harmlessly when testing in a desktop browser via
 * `npx serve .`, so it's safe to always call.
 */
function suppressScreenSaverViaLuna() {
  if (typeof WebOSServiceBridge === "undefined") return; // not running on a real webOS TV

  try {
    const bridge = new WebOSServiceBridge();
    bridge.onservicecallback = (msg) => {
      let message;
      try {
        message = JSON.parse(msg);
      } catch (e) {
        return;
      }

      if (message.returnValue === false) {
        // This is the "didn't work" case — almost certainly a denied
        // permission (ACG) rather than a code bug. errorCode/errorText
        // (when present) will say so explicitly.
        console.error("tvpower registerScreenSaverRequest denied:", message);
        return;
      }

      if (message.state === "Active") {
        bridge.call(
          "luna://com.webos.service.tvpower/power/responseScreenSaverRequest",
          JSON.stringify({
            clientName: "ambientPhotos",
            ack: false, // false = "not now" — keep deferring
            timestamp: message.timestamp,
          })
        );
      }
    };
    bridge.call(
      "luna://com.webos.service.tvpower/power/registerScreenSaverRequest",
      JSON.stringify({ subscribe: true, clientName: "ambientPhotos" })
    );
  } catch (e) {
    console.error("Screensaver suppression failed to register:", e);
  }
}

/* ============================================================
 * BOOT SEQUENCE
 * ============================================================ */

async function boot() {
  showScreen("boot");
  try {
    let token = await ensureAccessToken();
    let sessionId = store.get(CONFIG.LS_PICKER_SESSION_ID);

    if (!token || !sessionId) {
      sessionId = await runPairing();
      token = accessToken;
    }

    try {
      await ensureSessionReady(token, sessionId);
    } catch (e) {
      // Session was deleted/expired server-side, or belongs to a stale
      // pairing — clear it and pair again from scratch.
      store.remove(CONFIG.LS_REFRESH_TOKEN);
      store.remove(CONFIG.LS_PICKER_SESSION_ID);
      sessionId = await runPairing();
      token = accessToken;
      await ensureSessionReady(token, sessionId);
    }

    mediaItems = await listPickedMediaItems(token, sessionId);
    if (mediaItems.length === 0) {
      throw new Error("No photos were found in the picker selection.");
    }

    scheduleMediaListRefresh(sessionId);
    startSlideshow();
  } catch (err) {
    console.error(err);
    showScreen("pairing");
    showError(err.message || "Something went wrong during setup.");
  }
}

suppressScreenSaverViaLuna(); // best-effort; check console via ares-inspect if in doubt
startKeepaliveVideo(); // primary mechanism — needs no special permission
boot();
