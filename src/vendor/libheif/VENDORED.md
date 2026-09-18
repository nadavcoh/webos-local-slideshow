# Vendored: libheif-js

`libheif-bundle.js` is copied verbatim from the `libheif-js` npm package
(`libheif-wasm/libheif-bundle.js` — the pre-bundled WASM variant, with
the `.wasm` binary embedded inline as base64, so this is the only file
needed; no separate `.wasm` fetch/CORS path to worry about).

- Package: `libheif-js`
- Version vendored: **1.23.2**
- Source: https://github.com/catdad-experiments/libheif-js
- License: see `LICENSE` in this folder (copied alongside)

Vendored (rather than loaded from a CDN like `qrcode.min.js`/
`supabase-js` in `index.html`) on purpose: this file is also
`importScript`'d from inside `heic-worker.js`, and a flaky/unreachable
CDN mid-decode is a worse failure mode for an always-on kiosk app than
for a page's initial load. Update by re-copying the same file from a
newer `libheif-js` release if you ever need to bump it — nothing else
in this repo depends on its internal structure beyond the documented
`libheif.HeifDecoder` API (see `app.js`'s "HEIC handling" section).
