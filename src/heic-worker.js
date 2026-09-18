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
 * If this worker fails to start at all (e.g. some webOS builds
 * restrict Worker creation from a file:// origin — this app is
 * installed and runs from file:///.../applications/<app-id>/ on a
 * real TV, unlike desktop-Chrome testing via `npx serve .`), app.js
 * falls back to running this same decode on the main thread instead.
 * See getHeicWorker()/decodeHeicOnMainThread() there.
 * ============================================================ */

importScripts("vendor/libheif/libheif-bundle.js");

// eslint-disable-next-line no-undef
const decoder = new libheif.HeifDecoder();

self.onmessage = (e) => {
  const { id, bytes } = e.data;
  try {
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
