"""
Photo server for the webOS slideshow.

Serves files out of DOWNLOAD_TARGET_FOLDER (C:\\phash_album_downloads).
Most requests are for a filename with exactly one file on disk, and are
served as plain static bytes - no DB or EXIF work at all.

When a base filename has multiple candidates on disk (foo.jpg, foo(1).jpg,
foo(2).jpg, ... - the collision produced by album_wa.py's
_unique_dest_path()), the client sends ?hash_id=<wa.id_hash> so this
server can pick the right one:

  1. Look up hashes.timestamp / hashes.camera_name for that hash_id
     (one query, hashes table only - the slideshow already has id_hash,
     so no wa lookup needed).
  2. Read EXIF DateTimeOriginal from each on-disk candidate.
  3. Serve whichever candidate's EXIF timestamp is closest to
     hashes.timestamp. Duplicates in this library are months apart, so
     an exact match isn't needed - closest wins.

Resolutions are cached in a dbm file on disk, keyed by hash_id, so the DB
query + EXIF reads happen once per ambiguous photo, not once per
slideshow loop (thousands of photos, nothing held in memory). Each cache
entry also stores the candidate count at resolution time; if that count
changes (a new duplicate lands in the folder from a later album_wa.py
run), the entry is treated as stale and recomputed.

No framework - built directly on http.server, same as the current
`python -m http.server` this replaces.

Needs `pillow-heif` in addition to Pillow/psycopg2 - WhatsApp media
includes HEIC files, which plain Pillow can't open at all
(`Image.open()` raises "cannot identify image file"), so EXIF reads
would silently fail on every HEIC candidate without it.
"""

import dbm
import glob
import http.server
import json
import mimetypes
import os
import re
import socketserver
import urllib.parse
from datetime import datetime

import psycopg2
import psycopg2.extras
from PIL import ExifTags, Image

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    # HEIC candidates will fail to read EXIF (Pillow alone can't open them -
    # same underlying limitation the TV app itself works around with
    # libheif, see CLAUDE.md's "HEIC photos" section). pip install
    # pillow-heif to fix.
    pass

# --- adjust to match your setup -------------------------------------------
DOWNLOAD_TARGET_FOLDER = r"C:\phash_album_downloads"  # matches album_wa.py
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config.json")  # same
                                                                        # DB_NAME/DB_USER/... shape as gphoto_selenium_v2.py
CACHE_PATH = os.path.join(os.path.dirname(__file__), "resolved_photos")
PORT = 8080  # set to whatever PHOTO_SERVER_URL currently uses
# ---------------------------------------------------------------------------

_DUP_RE = re.compile(r"^(.*)\((\d+)\)$")


def _base_name(filename):
    """'foo(2).jpg' -> 'foo.jpg'; 'foo.jpg' -> 'foo.jpg' unchanged."""
    stem, ext = os.path.splitext(filename)
    m = _DUP_RE.match(stem)
    if m:
        stem = m.group(1)
    return stem + ext


def _candidates(filename):
    """On-disk files sharing filename's base name: for 'foo.jpg' that's
    whichever of foo.jpg, foo(1).jpg, foo(2).jpg, ... exist. No space
    before the parenthesis, matching _unique_dest_path()'s f"{base}({n}){ext}".
    Case-insensitive on the extension: files on disk aren't consistently
    cased (e.g. IMG_0421.HEIC vs IMG_0421(1).heic - same photo family,
    different download source), and this must still find both."""
    base = _base_name(filename)
    stem, ext = os.path.splitext(base)
    pattern = os.path.join(DOWNLOAD_TARGET_FOLDER, glob.escape(stem) + "*" + glob.escape(ext))
    exact_re = re.compile(
        r"^" + re.escape(stem) + r"(\(\d+\))?" + re.escape(ext) + r"$", re.IGNORECASE
    )
    return sorted(
        f for f in glob.glob(pattern) if exact_re.match(os.path.basename(f))
    )


def _exif_datetime(path):
    """DateTimeOriginal (Exif sub-IFD 0x9003), falling back to the
    top-level DateTime tag (0x0132) if a file has no Exif sub-IFD."""
    try:
        with Image.open(path) as img:
            exif = img.getexif()
            exif_ifd = exif.get_ifd(ExifTags.IFD.Exif)
            raw = exif_ifd.get(0x9003) or exif.get(0x0132)
            if not raw:
                return None
            return datetime.strptime(raw, "%Y:%m:%d %H:%M:%S")
    except Exception as e:
        print(f"EXIF read failed for {path}: {e}")
        return None


def _hashes_row(hash_id):
    with open(CONFIG_PATH) as f:
        config = json.load(f)
    conn = psycopg2.connect(
        database=config["DB_NAME"],
        user=config["DB_USER"],
        password=config["DB_PASSWORD"],
        host=config["DB_HOST"],
        port=config["DB_PORT"],
    )
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
        cur.execute("SELECT timestamp, camera_name FROM hashes WHERE id = %s", (hash_id,))
        return cur.fetchone()
    finally:
        conn.close()


def _resolve(filename, hash_id):
    """Basename of the correct on-disk file for this request."""
    candidates = _candidates(filename)
    if len(candidates) <= 1:
        return os.path.basename(candidates[0]) if candidates else filename
    if not hash_id:
        # Ambiguous but no hash_id sent - fall back to the plain name
        # rather than guessing.
        return filename

    cache_key = str(hash_id)
    with dbm.open(CACHE_PATH, "c") as cache:
        cached = cache.get(cache_key)
        if cached:
            cached_count, cached_name = cached.decode().split("|", 1)
            if int(cached_count) == len(candidates):
                return cached_name  # still valid - candidate set unchanged

        row = _hashes_row(hash_id)
        target_ts = row["timestamp"] if row else None

        winner = os.path.basename(candidates[0])
        if target_ts is not None:
            target_ts = target_ts.replace(tzinfo=None)  # see note below re: tz
            best_delta = None
            for path in candidates:
                ts = _exif_datetime(path)
                if ts is None:
                    continue
                delta = abs((ts - target_ts).total_seconds())
                if best_delta is None or delta < best_delta:
                    best_delta = delta
                    winner = os.path.basename(path)

        cache[cache_key] = f"{len(candidates)}|{winner}"
        return winner


class PhotoHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DOWNLOAD_TARGET_FOLDER, **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        filename = urllib.parse.unquote(parsed.path.lstrip("/"))
        hash_id = urllib.parse.parse_qs(parsed.query).get("hash_id", [None])[0]

        resolved = _resolve(filename, hash_id)
        file_path = os.path.join(DOWNLOAD_TARGET_FOLDER, resolved)

        if not os.path.isfile(file_path):
            self.send_error(404, "Photo not found")
            return

        mime_type, _ = mimetypes.guess_type(file_path)
        self.send_response(200)
        self.send_header("Content-Type", mime_type or "application/octet-stream")
        self.send_header("Content-Length", str(os.path.getsize(file_path)))
        self.end_headers()
        with open(file_path, "rb") as f:
            self.wfile.write(f.read())


if __name__ == "__main__":
    with socketserver.ThreadingTCPServer(("", PORT), PhotoHandler) as httpd:
        print(f"Serving {DOWNLOAD_TARGET_FOLDER} on port {PORT}")
        httpd.serve_forever()
