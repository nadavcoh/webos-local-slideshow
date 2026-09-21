"""
Dry run for photo_serve.py's duplicate-resolution logic.

Finds every filename shared by more than one wa row, and for each wa row
in that group, shows which on-disk candidate the resolver would pick and
how close the match was - without touching the DB, the download folder,
or requiring the TV app to send hash_id yet. Read-only, safe to run
against the real database and folder as many times as you like.

Also flags two situations worth a second look:
  - two wa rows in the same group resolving to the same on-disk file
  - a candidate file that no wa row in its group ends up matching

Run from the same directory as photo_serve.py (imports its helpers and
config.json so the two never drift apart).
"""

import json
import os
from collections import defaultdict

import psycopg2
import psycopg2.extras

from photo_serve import CONFIG_PATH, _candidates, _exif_datetime


def _db_connect():
    with open(CONFIG_PATH) as f:
        config = json.load(f)
    return psycopg2.connect(
        database=config["DB_NAME"],
        user=config["DB_USER"],
        password=config["DB_PASSWORD"],
        host=config["DB_HOST"],
        port=config["DB_PORT"],
    )


def _colliding_wa_rows():
    """wa rows (with a matched hashes row) whose filename is shared by
    more than one wa row."""
    conn = _db_connect()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
        cur.execute("""
            SELECT wa.id AS wa_id, wa.filename, wa.id_hash AS hash_id,
                   hashes.timestamp, hashes.camera_name
            FROM wa
            JOIN hashes ON wa.id_hash = hashes.id
            WHERE wa.filename IN (
                SELECT filename FROM wa
                WHERE id_hash IS NOT NULL
                GROUP BY filename
                HAVING COUNT(*) > 1
            )
            ORDER BY wa.filename, hashes.timestamp
        """)
        return cur.fetchall()
    finally:
        conn.close()


def _best_match(candidates, target_ts):
    """(winner_path, delta_seconds) for target_ts among candidates, or
    (None, None) if none of them have a readable EXIF date."""
    target_ts = target_ts.replace(tzinfo=None)
    best_path, best_delta = None, None
    for path in candidates:
        ts = _exif_datetime(path)
        if ts is None:
            continue
        delta = abs((ts - target_ts).total_seconds())
        if best_delta is None or delta < best_delta:
            best_path, best_delta = path, delta
    return best_path, best_delta


def main():
    rows = _colliding_wa_rows()
    by_filename = defaultdict(list)
    for row in rows:
        by_filename[row["filename"]].append(row)

    print(f"{len(by_filename)} colliding filename(s), {len(rows)} wa row(s) total\n")

    for filename, group in by_filename.items():
        candidates = _candidates(filename)
        print(f"=== {filename} ({len(candidates)} file(s) on disk, {len(group)} wa row(s)) ===")
        if len(candidates) != len(group):
            print(f"  ! mismatch: {len(candidates)} files but {len(group)} db rows - "
                  f"investigate before trusting this group")

        assigned = {}
        for row in group:
            if row["timestamp"] is None:
                print(f"  wa_id={row['wa_id']} hash_id={row['hash_id']} -> NO TIMESTAMP in hashes row")
                continue
            winner, delta = _best_match(candidates, row["timestamp"])
            days = f"{delta / 86400:.1f}d" if delta is not None else "n/a"
            print(f"  wa_id={row['wa_id']} hash_id={row['hash_id']} "
                  f"target={row['timestamp']} camera={row['camera_name']!r} "
                  f"-> {os.path.basename(winner) if winner else 'NO MATCH (no EXIF on any candidate)'} "
                  f"(delta {days})")
            if winner:
                assigned.setdefault(winner, []).append(row["wa_id"])

        for path, wa_ids in assigned.items():
            if len(wa_ids) > 1:
                print(f"  ! {os.path.basename(path)} claimed by multiple wa rows: {wa_ids}")
        unclaimed = [c for c in candidates if c not in assigned]
        for c in unclaimed:
            print(f"  ! {os.path.basename(c)} not chosen by any wa row in this group")
        print()


if __name__ == "__main__":
    main()
