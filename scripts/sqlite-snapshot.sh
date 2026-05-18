#!/usr/bin/env bash
# sqlite-snapshot.sh — produce a consistent online snapshot of a SQLite db.
#
# Usage:
#   sqlite-snapshot.sh <db-path> [output-path]
#
# Default output: <db-path>.snap
#
# Why this exists:
#   The Alfred storage migration (epic #898, STORE-X-1) puts a SQLite
#   `state.db` into per-tenant restic backups. A naive `cp` of a live
#   SQLite database in WAL mode can produce a torn snapshot — the main
#   file and the `-wal` file disagree because writes are in flight.
#
#   The SQLite `.backup` API is the canonical fix: it acquires the right
#   locks, walks the pages safely, and writes a single consistent file
#   that has no WAL companion. Back up the `.snap` file instead of the
#   live `.db`.
#
# Behavior:
#   - Refuses to run if the source db does not exist.
#   - Overwrites any existing output file at <output-path>.
#   - Uses the sqlite3 CLI if available; falls back to Node 22's
#     `node:sqlite` module (matches what's available in ctrl-api images).
#   - Prints the resulting file size on success.
set -euo pipefail

DB="${1:?usage: sqlite-snapshot.sh <db-path> [output-path]}"
OUT="${2:-${DB}.snap}"

if [[ ! -f "$DB" ]]; then
  echo "sqlite-snapshot: source db not found: $DB" >&2
  exit 1
fi

# Prefer sqlite3 CLI when present — simplest, most portable.
if command -v sqlite3 >/dev/null 2>&1; then
  # The .backup dot-command takes a single quoted argument.
  sqlite3 "$DB" ".backup '${OUT}'"
elif command -v node >/dev/null 2>&1; then
  # Fallback: use Node 22's built-in node:sqlite (the ctrl-api image
  # ships Node 22 with this module enabled). Requires the experimental
  # flag on older 22.x builds; --experimental-sqlite is a no-op on
  # newer ones, so always pass it for safety.
  node --experimental-sqlite -e "
    const { DatabaseSync } = require('node:sqlite');
    const src = new DatabaseSync(process.argv[1], { readOnly: false });
    src.exec(\"VACUUM INTO '\" + process.argv[2].replace(/'/g, \"''\") + \"'\");
    src.close();
  " "$DB" "$OUT"
else
  echo "sqlite-snapshot: neither sqlite3 nor node available" >&2
  exit 2
fi

if [[ ! -s "$OUT" ]]; then
  echo "sqlite-snapshot: snapshot produced empty file at $OUT" >&2
  exit 3
fi

ls -la "$OUT"
