/* ============================================================
 * heic-worker.js
 *
 * Decodes HEIC/HEIF bytes to raw RGBA pixels using libheif-js (WASM
 * build, vendored locally in vendor/libheif/ — see that folder's
 * LICENSE and app.js's "HEIC handling" section for why this exists
 * at all: webOS's Chromium has no native HEIC decoder, so a plain
 * <img> silently fails on these even though the LAN photo server
 * serves the bytes fine).
 *
 * Runs in a Worker so a large decode never stalls the main thread —
 * the slideshow's crossfade timer, remote-key handling, and the menu
 * auto-hide timer all live there. Only the WASM decode happens here;
 * turning the resulting pixels into a JPEG Blob needs <canvas>, which
 * isn't available in a plain Worker without OffscreenCanvas support.
 * Rather than assume this specific webOS Chromium build has that,
 * the raw RGBA buffer is transferred back to the main thread (see
 * rgbaToJpegBlob in app.js) and painted onto a real <canvas> there —
 * a native browser op, not JS-level pixel work, so it's cheap
 * relative to the decode itself.
 *
 * If this worker fails to start at all (untested in the abstract, but
 * confirmed NOT to be the issue on the real TV as of the fix in this
 * file — `new Worker(...)` and `importScripts()` both work fine from
 * the file:// origin this app actually runs from once installed),
 * app.js falls back to running this same decode on the main thread
 * instead. See getHeicWorker()/decodeHeicOnMainThread() there.
 * ============================================================ */

importScripts("vendor/libheif/libheif-bundle.js");

// `libheif` (just loaded above) is a *factory function*, not an
// already-initialized module — calling it kicks off async WASM
// instantiation and returns a Promise that resolves to the real
// module (the one with .HeifDecoder on it). Calling `new
// libheif.HeifDecoder()` directly, without awaiting the factory
// first, throws "libheif.HeifDecoder is not a constructor" — that
// was the actual bug the first version of this file had, not a
// device/Worker limitation. Cache the promise so repeated decodes
// reuse the same initialized module instead of re-instantiating the
// WASM runtime on every photo.
let libheifModulePromise = null;
function getLibheifModule() {
  if (!libheifModulePromise) {
    // eslint-disable-next-line no-undef
    libheifModulePromise = libheif();
  }
  return libheifModulePromise;
}

self.onmessage = async (e) => {
  const { id, bytes } = e.data;
  try {
    const heif = await getLibheifModule();
    const decoder = new heif.HeifDecoder();
    const images = decoder.decode(new Uint8Array(bytes));
    const image = images && images[0];
    if (!image) throw new Error("No image found in HEIC data.");

    const width = image.get_width();
    const height = image.get_height();
    const rgba = new Uint8ClampedArray(width * height * 4);

    // image.display() is libheif-js's own async decode-into-buffer
    // call — the object passed in just needs {data, width, height}
    // (matches the library's own Node.js example, which has no
    // ImageData/canvas to construct one from either).
    image.display({ data: rgba, width, height }, (displayData) => {
      if (!displayData) {
        self.postMessage({ id, error: "libheif image.display() failed." });
        return;
      }
      // Transfer the underlying buffer back rather than copying it —
      // it's already the exact bytes the main thread needs.
      self.postMessage({ id, width, height, buffer: rgba.buffer }, [rgba.buffer]);
    });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
