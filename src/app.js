/* ============================================================
 * Ambient Photos — app.js
 *
 * Flow:
 *   1. On load, check for a persisted Supabase session (supabase-js
 *      handles this itself via localStorage — see CONFIG.SUPABASE_*
 *      client options below). If one exists, skip straight to the
 *      slideshow.
 *   2. Otherwise run the pairing flow: generate a UUID, show a QR
 *      pointing at the web app's /tv-login?session=<uuid> page, and
 *      poll that web app's /api/auth/tv-poll endpoint every few
 *      seconds. The phone completes GitHub SSO via Supabase there and
 *      hands the resulting access/refresh tokens back through a
 *      short-lived Vercel KV record, keyed by that same UUID.
 *   3. Once tokens arrive, hydrate a local Supabase session with
 *      supabase.auth.setSession(). From here on, supabase-js manages
 *      token refresh on its own.
 *   4. Slideshow photos are NOT a pre-fetched playlist in the sense of
 *      one big upfront list, but they aren't fetched strictly
 *      one-at-a-time either: a small forward queue
 *      (CONFIG.PREFETCH_DEPTH) keeps a few upcoming photos already
 *      fetched, image-preloaded, AND reverse-geocoded (coords -> place
 *      name, via Nominatim), so skipping ahead doesn't wait on a fresh
 *      round trip. A separate in-memory history buffer makes manual
 *      Left (previous) possible on top of that.
 *
 * CONFIG VALUES: loaded from window.APP_CONFIG if present (see
 * secrets.local.js.example — copy it to secrets.local.js, gitignored,
 * for local testing with `npx serve .` from this directory), else
 * fall back to the placeholder strings below, which the GitHub Action
 * substitutes at build time. Either way, nothing sensitive is
 * committed to the repo. The Supabase anon key is the one exception
 * to "sensitive" — it's meant to be public/embedded client-side, same
 * as photo-match-next; RLS policies on wa/hashes do the actual
 * access control (see README.md for the policies this app needs).
 *
 * SECURITY MODEL CHANGE from the old pairing-backend: there's no
 * shared secret gating the pairing URL anymore. A stranger who finds
 * this TV's QR/URL can only reach the GitHub sign-in page — the
 * web app's tv-handoff endpoint rejects anyone whose GitHub-verified
 * email isn't the one allowed address, so getting to that page buys
 * them nothing.
 * ============================================================ */

/* ---------------------- CONFIG ---------------------- */

const localConfig = (typeof window !== "undefined" && window.APP_CONFIG) || {};

const CONFIG = {
  // Base URL of the deployed Next.js web app (tv-handoff/tv-poll/tv-login).
  WEBAPP_URL: localConfig.WEBAPP_URL || "https://YOUR-WEBAPP.vercel.app",

  SUPABASE_URL: localConfig.SUPABASE_URL || "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: localConfig.SUPABASE_ANON_KEY || "YOUR_SUPABASE_ANON_KEY",

  // Local HTTP server serving the actual photo bytes.
  PHOTO_SERVER_URL: localConfig.PHOTO_SERVER_URL || "http://YOUR-PHOTO-SERVER:PORT",

  PAIRING_POLL_INTERVAL_MS: 3 * 1000,
  PAIRING_POLL_TIMEOUT_MS: 10 * 60 * 1000, // how long the TV waits for the phone to finish

  // Slideshow behavior
  SLIDE_INTERVAL_MS: 15 * 1000, // 15 seconds per requirement
  HISTORY_MAX: 50, // how many recently-shown photos Left/Right can browse back through
  PREFETCH_DEPTH: 3, // how many upcoming photos to have fetched + image-preloaded ahead of time

  // Shows meta.filename as a small on-screen overlay (see renderPhoto)
  // — handy for correlating what's on screen against ares-inspect /
  // LAN-server logs while debugging (e.g. the HEIC decode work), but
  // it's a raw filename, not really "ambient" content — flip to false
  // once you're done troubleshooting and just want date + location.
  SHOW_FILENAME_OVERLAY: true,

  // wa.filetype values considered "an image" — adjust here if the
  // actual stored values turn out to differ (see README.md note).
  IMAGE_FILETYPES: ["Image", "image/jpeg"],

  // JPEG quality used when re-encoding a decoded HEIC photo (see "HEIC
  // handling" below) — 0..1, passed straight to canvas.toBlob().
  HEIC_JPEG_QUALITY: 0.9,
};

/* ---------------------- SUPABASE CLIENT ---------------------- */

// supabase-js UMD build (loaded via <script> in index.html) exposes a
// global `supabase` object with createClient — shadow-renamed here to
// `supabaseLib` so it doesn't collide with our own `supabaseClient`.
// eslint-disable-next-line no-undef
const supabaseLib = window.supabase;

const supabaseClient = supabaseLib.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true, // supabase-js manages its own localStorage keys
    autoRefreshToken: true,
    detectSessionInUrl: false, // no OAuth redirect ever lands on the TV itself
  },
});

/* ---------------------- DOM ---------------------- */

const el = {
  boot: document.getElementById("boot-screen"),
  pairing: document.getElementById("pairing-screen"),
  slideshow: document.getElementById("slideshow-screen"),

  connectStep: document.getElementById("pairing-step-connect"),
  connectQr: document.getElementById("connect-qr"),
  connectUrl: document.getElementById("connect-url"),
  connectStatus: document.getElementById("connect-status"),

  pairingError: document.getElementById("pairing-error"),

  layerA: document.getElementById("layer-a"),
  layerB: document.getElementById("layer-b"),
  overlayDate: document.getElementById("overlay-date"),
  overlayLocation: document.getElementById("overlay-location"),
  overlayFilename: document.getElementById("overlay-filename"),

  menuOverlay: document.getElementById("menu-overlay"),
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

/** RFC 4122 v4 UUID, without relying on crypto.randomUUID (unavailable on
 *  older Chromium builds that some webOS versions ship with). Used here
 *  as the TV's pairing session id — treat it like a short-lived credential. */
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

/* ============================================================
 * STEP A — Pairing (TV <-> mobile handoff via the web app + KV)
 * ============================================================ */

/** Polls the web app until /api/auth/tv-poll has tokens waiting for this session id. */
function pollTvHandoff(tvSessionId) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + CONFIG.PAIRING_POLL_TIMEOUT_MS;
    const poll = async () => {
      if (Date.now() > deadline) {
        reject(new Error("Pairing timed out before it was completed. Please try again."));
        return;
      }
      try {
        const res = await fetch(`${CONFIG.WEBAPP_URL}/api/auth/tv-poll?sessionId=${tvSessionId}`);
        if (res.status === 200) {
          const body = await res.json();
          resolve({ access_token: body.access_token, refresh_token: body.refresh_token });
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

/** Runs the full pairing UI + polling sequence, hydrates a Supabase
 *  session from the resulting tokens, and returns that session. */
async function runPairing() {
  showScreen("pairing");
  el.connectStep.classList.remove("hidden");
  hideError();
  el.connectStatus.textContent = "Preparing…";

  const tvSessionId = uuidv4();
  const loginUrl = `${CONFIG.WEBAPP_URL}/tv-login?session=${tvSessionId}`;

  el.connectUrl.textContent = loginUrl.replace(/^https?:\/\//, "");
  el.connectQr.innerHTML = "";
  // eslint-disable-next-line no-undef
  new QRCode(el.connectQr, { text: loginUrl, width: 480, height: 480 });
  el.connectStatus.textContent = "Waiting for sign-in on your phone…";

  const tokens = await pollTvHandoff(tvSessionId);

  const { data, error } = await supabaseClient.auth.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
  if (error) throw error;

  el.connectStep.classList.add("hidden");
  return data.session;
}

/* ============================================================
 * STEP B — Photo data (wa + hashes tables)
 * ============================================================ */

/**
 * Picks one random eligible row from `wa` and returns its joined
 * metadata from `hashes`. PostgREST's query builder has no direct
 * "order by random()", so this is a count-then-random-offset pair of
 * requests rather than one round trip. Fine here: each result is only
 * needed once every SLIDE_INTERVAL_MS, not in a tight loop.
 */
async function fetchRandomPhoto() {
  const { count, error: countError } = await supabaseClient
    .from("wa")
    .select("id_hash", { count: "exact", head: true })
    .not("id_hash", "is", null)
    .eq("processed", true)
    .in("filetype", CONFIG.IMAGE_FILETYPES);

  if (countError) throw countError;
  if (!count) throw new Error("No eligible photos found in the wa table.");

  const offset = Math.floor(Math.random() * count);

  const { data: waRows, error: waError } = await supabaseClient
    .from("wa")
    .select("id_hash")
    .not("id_hash", "is", null)
    .eq("processed", true)
    .in("filetype", CONFIG.IMAGE_FILETYPES)
    .order("id_hash", { ascending: true }) // deterministic order so the offset is meaningful
    .range(offset, offset);

  if (waError) throw waError;
  const idHash = waRows && waRows[0] && waRows[0].id_hash;
  if (!idHash) throw new Error("Random wa row had no id_hash.");

  const { data: hashRows, error: hashError } = await supabaseClient
    .from("hashes")
    .select("filename, location, location_name, timestamp")
    .eq("id", idHash)
    .limit(1);

  if (hashError) throw hashError;
  const meta = hashRows && hashRows[0];
  if (!meta) throw new Error(`No hashes row found for id_hash ${idHash}.`);

  return meta;
}

/**
 * hashes.location_name looks like:
 *   "Holon\nEstimated location - \nLearn more"
 * The actual place name is the first line; the rest is Google Photos'
 * own UI boilerplate, not meaningful metadata.
 */
function parseLocationName(raw) {
  if (!raw) return "";
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const name = lines[0] || "";
  // Google Photos shows this literal placeholder when a photo has no
  // location tagged at all — it's not a real place name, so treat it
  // the same as an empty field (formatLocation falls back to coords,
  // then to nothing).
  if (name.toLowerCase() === "add a location") return "";
  return name;
}

/** hashes.location looks like "https://www.google.com/maps?q=loc:LAT,LNG". */
function parseMapsCoords(raw) {
  if (!raw) return null;
  const match = raw.match(/loc:(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (!match) return null;
  return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
}

/**
 * Reverse geocoding (coords -> place name) via Nominatim's free public
 * API (OpenStreetMap data, no API key, CORS-enabled — confirmed
 * against their own usage docs rather than assumed). Two things their
 * usage policy asks for that matter here:
 *   - Max ~1 request/second. `geocodeChain` serializes every call
 *     (even concurrent ones from prefetching several photos in a row)
 *     through one queue, each waiting out GEOCODE_MIN_INTERVAL_MS
 *     since the last actual request — not per-caller, app-wide.
 *   - Identify the application. Browsers block scripts from setting a
 *     custom User-Agent header (it's on the fetch spec's forbidden
 *     header list), so this relies on the Referer header the browser
 *     sends automatically instead, which does identify this app's own
 *     domain — the commonly-accepted workaround for browser-side
 *     Nominatim usage.
 * `geocodeCache` is keyed to ~100m buckets (3 decimal places) since
 * many photos taken near each other resolve to the same place name —
 * this avoids a repeat request every time, not just within one prefetch
 * batch but for the lifetime of the app.
 */
const geocodeCache = new Map(); // "lat,lng" (3dp) -> place name string | null
const GEOCODE_MIN_INTERVAL_MS = 1100;
let lastGeocodeAt = 0;
let geocodeChain = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractPlaceName(nominatimJson) {
  const address = nominatimJson && nominatimJson.address;
  if (!address) return null;
  const locality = address.city || address.town || address.village || address.municipality || address.suburb || address.county;
  const country = address.country;
  if (locality && country) return `${locality}, ${country}`;
  return locality || country || null;
}

function reverseGeocode(coords) {
  const key = `${coords.lat.toFixed(3)},${coords.lng.toFixed(3)}`;
  if (geocodeCache.has(key)) return Promise.resolve(geocodeCache.get(key));

  const run = async () => {
    const wait = GEOCODE_MIN_INTERVAL_MS - (Date.now() - lastGeocodeAt);
    if (wait > 0) await sleep(wait);
    lastGeocodeAt = Date.now();

    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${coords.lat}&lon=${coords.lng}&zoom=10&addressdetails=1`
      );
      if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
      const place = extractPlaceName(await res.json());
      geocodeCache.set(key, place);
      return place;
    } catch (err) {
      console.error("Reverse geocoding failed:", err);
      geocodeCache.set(key, null); // don't re-hit the same failing coords on every prefetch
      return null;
    }
  };

  // Chained (not Promise.all'd) so overlapping prefetches still hit
  // Nominatim one at a time, in order, regardless of how many photos
  // are being prefetched concurrently.
  const task = geocodeChain.then(run, run);
  geocodeChain = task.catch(() => {});
  return task;
}

/**
 * Combines the human-entered location_name (if present and not
 * Google Photos' "Add a location" placeholder) with a place name
 * reverse-geocoded from the raw coordinates — shown together rather
 * than one as a fallback for the other, since they're often different
 * levels of detail (Google Photos' own "Holon" vs. a fuller "Holon,
 * Israel" from the coordinates). `meta.geocodedPlace` is attached
 * during prefetch (see fetchAndPreloadOne) so this itself stays
 * synchronous — formatLocation is called from the render path, which
 * shouldn't be blocked on a network request.
 */
function formatLocation(meta) {
  const name = parseLocationName(meta.location_name);
  const geocoded = meta.geocodedPlace;

  const parts = [];
  if (name) parts.push(name);
  // Skip the geocoded part if it's just a more verbose restatement of
  // the same place (e.g. name "Holon", geocoded "Holon, Israel").
  if (geocoded && !(name && geocoded.toLowerCase().startsWith(name.toLowerCase()))) {
    parts.push(geocoded);
  }
  if (parts.length > 0) return parts.join(" · ");

  // Geocoding hasn't resolved (still in flight, or failed) and there's
  // no location_name either — last-resort raw coordinates.
  const coords = parseMapsCoords(meta.location);
  if (coords) return `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`;

  return "";
}

function formatTimestamp(meta) {
  if (!meta.timestamp) return "";
  const d = new Date(meta.timestamp);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function photoImageUrl(meta) {
  return `${CONFIG.PHOTO_SERVER_URL}/${encodeURIComponent(meta.filename)}`;
}

/* ============================================================
 * HEIC handling
 *
 * webOS's Chromium build has no native HEIC decoder (that codec is
 * WebKit/Safari-only) — a plain <img> silently fails on these even
 * though the LAN photo server serves the bytes fine (200 OK, visible
 * in its own access log). `wa.filetype` doesn't distinguish HEIC from
 * JPEG (WhatsApp media rows are just generically "Image"), so these
 * reach the browser and only fail once it tries to decode them.
 *
 * Rather than converting at ingest time or on the LAN server, this
 * decodes HEIC -> JPEG right here on the TV, in a Web Worker, using a
 * locally vendored WASM build of libheif (vendor/libheif/) — see
 * CLAUDE.md for the full reasoning on why the TV rather than the
 * server. If the worker can't start at all (untested: some webOS
 * builds restrict Worker creation from a file:// origin, which is how
 * this app actually runs once installed), everything below falls
 * back to running the same decode on the main thread instead — slower
 * and briefly blocking, but still correct. Watch `ares-inspect` the
 * first time this runs on the real TV for either the worker-crashed
 * console.error below or "Could not start HEIC worker" to know which
 * path it's actually taking.
 * ============================================================ */

function isHeic(filename) {
  return /\.hei[cf]$/i.test(filename || "");
}

let heicWorker = null;
let heicWorkerBroken = false;
let heicRequestId = 0;
const heicPending = new Map(); // id -> {resolve, reject}

/** Lazily starts the HEIC decode worker on first use. Returns null
 *  (rather than throwing) once the worker is known to be unusable, so
 *  callers can fall back to decoding on the main thread instead. */
function getHeicWorker() {
  if (heicWorkerBroken) return null;
  if (heicWorker) return heicWorker;

  try {
    heicWorker = new Worker("heic-worker.js");
  } catch (err) {
    console.error("Could not start HEIC worker, decoding on the main thread instead:", err);
    heicWorkerBroken = true;
    return null;
  }

  heicWorker.onmessage = (e) => {
    const { id, width, height, buffer, error } = e.data;
    const pending = heicPending.get(id);
    if (!pending) return; // stale/unknown id — ignore
    heicPending.delete(id);
    if (error) pending.reject(new Error(error));
    else pending.resolve({ width, height, buffer });
  };

  // If the worker dies mid-flight (crash, uncaught exception loading
  // the vendored bundle, etc.), every request currently in flight for
  // it can never resolve — reject them explicitly rather than hanging
  // a prefetch forever, and mark the worker broken so later HEIC
  // photos fall back to the main thread instead of retrying a dead
  // worker every time.
  heicWorker.onerror = (err) => {
    console.error("HEIC worker crashed — decoding on the main thread from now on:", (err && err.message) || err);
    heicWorkerBroken = true;
    heicWorker.terminate();
    heicWorker = null;
    heicPending.forEach(({ reject }) => reject(new Error("HEIC worker crashed.")));
    heicPending.clear();
  };

  return heicWorker;
}

function decodeHeicViaWorker(worker, arrayBuffer) {
  const id = ++heicRequestId;
  return new Promise((resolve, reject) => {
    heicPending.set(id, { resolve, reject });
    // Transfer the buffer into the worker rather than copying it —
    // it's a few MB for a typical phone photo.
    worker.postMessage({ id, bytes: arrayBuffer }, [arrayBuffer]);
  }).then(rgbaToJpegBlob);
}

/** Same decode, run on the main thread — the fallback path when the
 *  Worker itself couldn't start (see getHeicWorker). window.libheif
 *  here comes from the same vendored bundle loaded via <script> in
 *  index.html, and — same caveat as heic-worker.js — is a factory
 *  function that must be called and awaited to get the actual
 *  initialized module, not an already-ready object. Cached the same
 *  way, but as a separate promise: this runs in a different JS
 *  context (main thread vs. Worker) than heic-worker.js's own copy,
 *  so the two can't share state even though they load the identical
 *  vendored file. */
let mainThreadLibheifModulePromise = null;
function getMainThreadLibheifModule() {
  if (!mainThreadLibheifModulePromise) {
    // eslint-disable-next-line no-undef
    mainThreadLibheifModulePromise = libheif();
  }
  return mainThreadLibheifModulePromise;
}

async function decodeHeicOnMainThread(arrayBuffer) {
  const heif = await getMainThreadLibheifModule();
  const decoder = new heif.HeifDecoder();
  const images = decoder.decode(new Uint8Array(arrayBuffer));
  const image = images && images[0];
  if (!image) throw new Error("No image found in HEIC data.");

  const width = image.get_width();
  const height = image.get_height();
  const rgba = new Uint8ClampedArray(width * height * 4);

  const decoded = await new Promise((resolve, reject) => {
    image.display({ data: rgba, width, height }, (displayData) => {
      if (!displayData) reject(new Error("libheif image.display() failed."));
      else resolve({ width, height, buffer: rgba.buffer });
    });
  });
  return rgbaToJpegBlob(decoded);
}

/** Shared final step for both decode paths above: paint raw RGBA
 *  pixels onto a plain <canvas> and re-encode as JPEG. This needs the
 *  main thread either way (no OffscreenCanvas dependency — see
 *  heic-worker.js's header comment), but it's a native browser
 *  operation, not JS-level pixel work, so it's cheap relative to the
 *  actual HEIF decode. */
function rgbaToJpegBlob({ width, height, buffer }) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob() produced no JPEG blob."))),
      "image/jpeg",
      CONFIG.HEIC_JPEG_QUALITY
    );
  });
}

function decodeHeicToJpegBlob(arrayBuffer) {
  const worker = getHeicWorker();
  return worker ? decodeHeicViaWorker(worker, arrayBuffer) : decodeHeicOnMainThread(arrayBuffer);
}

/** Sanity-checks that `bytes` actually looks like an ISO-BMFF
 *  (HEIF/HEIC/MP4-family) container before it's handed to libheif —
 *  every such file has a 4-byte box size followed by the ASCII bytes
 *  "ftyp", starting at offset 4. Returns null if the check passes, or
 *  a diagnostic message (with a guess at what the bytes actually are)
 *  if it doesn't — catching "this wasn't actually a HEIC file, despite
 *  the extension" here, with something actionable in the console,
 *  rather than only surfacing libheif's much less legible internal
 *  parse error ("No 'ftyp' box...") after a wasted worker round trip. */
function heicSignatureError(bytes, url) {
  const view = new Uint8Array(bytes);
  const isFtyp = view.length >= 8 && view[4] === 0x66 && view[5] === 0x74 && view[6] === 0x79 && view[7] === 0x70; // "ftyp"
  if (isFtyp) return null;

  const hex = Array.from(view.slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");

  let guess = "unrecognized format";
  if (view.length === 0) guess = "empty response body";
  else if (view[0] === 0xff && view[1] === 0xd8) guess = "looks like a JPEG, not HEIC — is this file misnamed/mistagged?";
  else if (view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47) guess = "looks like a PNG, not HEIC";
  else if (/^\s*(<!doctype|<html)/i.test(String.fromCharCode(...view.slice(0, 15)))) guess = "looks like an HTML page, not an image — wrong URL, or the LAN server returned an error page with a 200 status?";

  return `${url} doesn't look like a valid HEIF/HEIC file (no 'ftyp' box at offset 4) — ${guess}. First ${view.length < 16 ? view.length : 16} bytes: ${hex || "(none)"}; ${view.length} bytes total.`;
}

/** Returns the URL renderPhoto/preloadImage should actually use: the
 *  LAN server URL directly for anything the browser can decode
 *  natively, or a locally-decoded blob: URL for HEIC/HEIF. The caller
 *  is responsible for eventually revoking that blob URL (see
 *  revokeDisplayUrl) — it isn't cleaned up automatically, and this
 *  app runs unattended for weeks at a time. */
async function resolvePhotoDisplayUrl(meta) {
  const rawUrl = photoImageUrl(meta);
  if (!isHeic(meta.filename)) return rawUrl;

  const res = await fetch(rawUrl);
  if (!res.ok) throw new Error(`Photo server returned ${res.status} for ${meta.filename}`);
  const bytes = await res.arrayBuffer();

  const sigError = heicSignatureError(bytes, rawUrl);
  if (sigError) throw new Error(sigError);

  const jpegBlob = await decodeHeicToJpegBlob(bytes);
  return URL.createObjectURL(jpegBlob);
}

/** Releases a blob: URL created by resolvePhotoDisplayUrl. Safe to
 *  call on any meta, HEIC-derived or not — a no-op on a plain server
 *  URL. Must be called exactly once a photo is truly done with
 *  (evicted from history, or discarded on logout): call it too early
 *  and a still-visible/still-navigable-back-to <img> goes blank;
 *  never call it and the app slowly leaks memory over its normal
 *  weeks-at-a-time uptime. */
function revokeDisplayUrl(meta) {
  if (meta && meta.displayUrl && meta.displayUrl.startsWith("blob:")) {
    URL.revokeObjectURL(meta.displayUrl);
  }
}

/* ============================================================
 * STEP C — Slideshow engine
 * ============================================================ */

let visibleLayer = el.layerA;
let hiddenLayer = el.layerB;
let slideTimer = null;

// Each photo is fetched fresh rather than drawn from a pre-loaded
// playlist, so a small rolling buffer is what makes manual "previous"
// possible — otherwise there'd be nothing to go back to.
let history = [];
let historyIndex = -1; // pointer into history; -1 = nothing shown yet

// Forward-looking counterpart to `history`: photos already fetched
// from Supabase AND already image-preloaded, ready to display
// instantly. Without this, every skip (manual or auto-advance) would
// have to wait on a full round trip plus an image load before
// anything appeared. `renderPhoto` still calls `preloadImage` itself
// when consuming from here, but since the browser already has the
// image cached from the prefetch, that resolves near-instantly.
let upcoming = [];
let toppingUpQueue = false; // guards against overlapping top-up calls

/** Local HTTP server is assumed unauthenticated on the home LAN, so a
 *  plain <img> load (no Bearer-token blob workaround like the old
 *  Google Photos code needed) is enough. */
function preloadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(url);
    img.onerror = () => reject(new Error(`Image failed to load: ${url}`));
    img.src = url;
  });
}

/** Resolves the URL renderPhoto should actually display — decoding
 *  HEIC to a blob: URL first if needed (see resolvePhotoDisplayUrl)
 *  — and confirms the browser can load it, storing the result on
 *  `meta.displayUrl`. Split out from fetchAndPreloadOne so it can run
 *  concurrently with reverseGeocode below, same as the plain
 *  preloadImage() call this replaces did before HEIC support existed. */
async function resolveAndPreload(meta) {
  const displayUrl = await resolvePhotoDisplayUrl(meta);
  await preloadImage(displayUrl);
  meta.displayUrl = displayUrl;
}

/** Fetches one random photo's metadata, preloads its (possibly
 *  HEIC-decoded) image, and reverse-geocodes its coordinates (if any)
 *  — all before resolving, so everything renderPhoto/formatLocation
 *  need is already on `meta` by the time this photo is actually
 *  shown. Image resolution/preload and geocoding are independent
 *  network calls to different services, so they run concurrently
 *  rather than one after another. */
async function fetchAndPreloadOne() {
  const meta = await fetchRandomPhoto();
  const coords = parseMapsCoords(meta.location);
  const [, geocodedPlace] = await Promise.all([
    resolveAndPreload(meta),
    coords ? reverseGeocode(coords) : Promise.resolve(null),
  ]);
  meta.geocodedPlace = geocodedPlace;
  return meta;
}

/** Tops the prefetch queue back up to CONFIG.PREFETCH_DEPTH, one photo
 *  at a time. Fire-and-forget from callers — never awaited on the
 *  critical path of showing the current slide. Stops (rather than
 *  retrying in a tight loop) on the first failure; the next slide
 *  advance calls this again anyway. */
async function topUpQueue() {
  if (toppingUpQueue) return;
  toppingUpQueue = true;
  try {
    while (upcoming.length < CONFIG.PREFETCH_DEPTH) {
      try {
        upcoming.push(await fetchAndPreloadOne());
      } catch (err) {
        console.error("Prefetch failed, will retry on next advance:", err);
        break;
      }
    }
  } finally {
    toppingUpQueue = false;
  }
}

/** Returns the next not-yet-shown photo: from the prefetch queue if
 *  it's ready, or fetched inline as a fallback (e.g. right at boot,
 *  before the first top-up has had time to finish). */
async function takeNextUpcoming() {
  if (upcoming.length > 0) return upcoming.shift();
  try {
    return await fetchAndPreloadOne();
  } catch (err) {
    console.error("Failed to fetch next photo:", err);
    return null;
  }
}

/** Loads and crossfades in a specific photo's metadata. Returns false
 *  (without throwing) if the image failed to load, so callers can
 *  move on rather than getting stuck on one broken row. */
async function renderPhoto(meta) {
  // meta.displayUrl is set during prefetch (see resolveAndPreload) —
  // for HEIC photos this is a blob: URL from the on-TV decode.
  // Falling back to the raw server URL here would just reproduce the
  // original "Image failed to load" bug for those photos, so only
  // fall back to it for metas that somehow skipped prefetch entirely.
  const url = meta.displayUrl || photoImageUrl(meta);
  try {
    await preloadImage(url);
  } catch (e) {
    console.error(e);
    return false;
  }

  hiddenLayer.src = url;
  el.overlayDate.textContent = formatTimestamp(meta);
  el.overlayLocation.textContent = formatLocation(meta);
  el.overlayFilename.textContent = CONFIG.SHOW_FILENAME_OVERLAY ? meta.filename : "";

  // Crossfade: fade the new layer in, fade the old one out, then swap roles.
  hiddenLayer.classList.add("visible");
  visibleLayer.classList.remove("visible");
  [visibleLayer, hiddenLayer] = [hiddenLayer, visibleLayer];
  return true;
}

async function showNextSlide() {
  let meta;
  let consumedFromQueue = false;

  if (historyIndex < history.length - 1) {
    // Stepped backward manually earlier — walk forward through the
    // buffered history before touching the prefetch queue at all.
    historyIndex++;
    meta = history[historyIndex];
  } else {
    meta = await takeNextUpcoming();
    if (!meta) return; // next timer tick retries
    consumedFromQueue = true;
    history.push(meta);
    // Evicting from history is the one place a shown photo is truly
    // discarded (see revokeDisplayUrl) — release its blob: URL, if any.
    if (history.length > CONFIG.HISTORY_MAX) revokeDisplayUrl(history.shift());
    historyIndex = history.length - 1;
  }

  const ok = await renderPhoto(meta);
  if (consumedFromQueue) topUpQueue(); // fire-and-forget; refill what was just consumed
  if (!ok) showNextSlide(); // skip a broken row, try another immediately
}

async function showPrevSlide() {
  if (historyIndex <= 0) return; // nothing earlier buffered yet
  historyIndex--;
  const ok = await renderPhoto(history[historyIndex]);
  if (!ok) showPrevSlide();
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
  topUpQueue(); // fire-and-forget; fills in parallel with the first fetch below
  showNextSlide();
  restartSlideTimer();
}

/* ============================================================
 * STEP D — Remote-control menu (log out)
 * ============================================================ */

/** "Log Out": clears the Supabase session and drops back to the
 *  sign-in QR, same as a fresh first run. There's no "Repick Photos"
 *  equivalent anymore — photos come from the wa/hashes tables rather
 *  than a per-session picker selection, so there's nothing to repick.
 *  (Right-arrow already works as an ad hoc "skip this one" during
 *  manual browsing — flag if a dedicated "shuffle" button is wanted
 *  instead.) */
async function logOut() {
  clearInterval(slideTimer);
  // `upcoming` is intentionally left alone here — those photos (and
  // any blob: URLs already decoded for them) are still valid and get
  // shown after re-pairing; `history` is what's actually discarded.
  history.forEach(revokeDisplayUrl);
  history = [];
  historyIndex = -1;

  await supabaseClient.auth.signOut();

  hideError();
  boot();
}

let menuHideTimer = null;
const MENU_AUTO_HIDE_MS = 8000;

function menuIsOpen() {
  return !el.menuOverlay.classList.contains("hidden");
}

function showMenu() {
  clearTimeout(menuHideTimer);
  el.menuOverlay.classList.remove("hidden");
  el.menuLogout.focus();
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

    if (isBackKey(e)) {
      hideMenu();
      e.preventDefault();
    }
    // Enter/OK activates the (only) button natively.
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
    const { data } = await supabaseClient.auth.getSession();
    let session = data.session;

    if (!session) {
      session = await runPairing();
    }

    if (!session) {
      throw new Error("Sign-in did not produce a usable session.");
    }

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
