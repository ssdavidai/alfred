#!/usr/bin/env bash
set -euo pipefail

workdir="${TMPDIR:-/tmp}/alfred-restore-drill.$$"
cleanup() {
  rm -rf "$workdir"
}
trap cleanup EXIT

src="$workdir/source"
backup="$workdir/backup"
restore="$workdir/restore"
mkdir -p "$src/vault_data/note" "$src/state_data" "$backup" "$restore"

cat > "$src/vault_data/note/restore-drill.md" <<'EOF'
---
type: note
name: restore-drill
---

A user-facing vault artifact used by the backup restore drill.
EOF

python - "$src/state_data/alfred-state.db" <<'PY'
import sqlite3
import sys
path = sys.argv[1]
con = sqlite3.connect(path)
con.execute("PRAGMA journal_mode=WAL")
con.execute("CREATE TABLE audit (id INTEGER PRIMARY KEY, message TEXT NOT NULL)")
con.execute("INSERT INTO audit(message) VALUES (?)", ("restore-drill-state-artifact",))
con.commit()
con.close()
PY

for volume in vault_data state_data; do
  tar -C "$src/$volume" -czf "$backup/$volume.tgz" .
done

mkdir -p "$restore/vault_data" "$restore/state_data"
for volume in vault_data state_data; do
  tar -C "$restore/$volume" -xzf "$backup/$volume.tgz"
done

test -f "$restore/vault_data/note/restore-drill.md"
grep -q "restore-drill" "$restore/vault_data/note/restore-drill.md"

python - "$restore/state_data/alfred-state.db" <<'PY'
import sqlite3
import sys
path = sys.argv[1]
con = sqlite3.connect(path)
row = con.execute("SELECT message FROM audit WHERE id = 1").fetchone()
con.close()
if row != ("restore-drill-state-artifact",):
    raise SystemExit(f"unexpected restored state row: {row!r}")
PY

printf 'restore drill passed: vault file and SQLite state artifact restored\n'
