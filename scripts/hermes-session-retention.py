#!/usr/bin/env python3
"""Hermes session-store retention tool.  refs #430

Per-profile windows (not one global number):
  workers 14d — ephemeral background-agent transcripts; durable output in state.db/vault.
  main    90d — principal's conversation history; highest audit value.
  heavy   90d — reflection/onboarding reasoning; low volume, worth keeping.

Liveness predicate — session excluded if ANY holds:
  1. ended_at IS NULL          — in progress
  2. started_at > cutoff       — within window
  3. compression_locks.expires_at > now  — LCM compression in flight
     (expiry-time semantics; there is NO released_at column)

FTS5: messages_fts is USING fts5(content) — 'content' is a column name, NOT
the content='tablename' option (very different).  Six triggers maintain both
FTS indexes on DELETE; verified at runtime.  Never call 'rebuild' on a plain
FTS5 table — it wipes the index.  WAL/VACUUM: see hermes-retention-maintenance.
"""

import argparse
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

PROFILE_RETENTION: dict[str, int] = {
    "workers": 14,
    "main":    90,
    "heavy":   90,
}
HERMES_HOME = os.environ.get("HERMES_HOME", "/hermes-state")
BATCH_SIZE = 500

def _open(db_path: Path, readonly: bool) -> sqlite3.Connection:
    uri = f"file:{db_path}{'?mode=ro' if readonly else ''}"
    con = sqlite3.connect(uri, uri=True, timeout=30)
    con.row_factory = sqlite3.Row
    if not readonly:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA busy_timeout=10000")
    return con


def _integrity(con: sqlite3.Connection) -> bool:
    row = con.execute("PRAGMA integrity_check").fetchone()
    return bool(row and row[0] == "ok")

def _has_fts_triggers(con: sqlite3.Connection) -> bool:
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='messages'"
    ).fetchall()
    return any("fts" in (r["name"] or "").lower() for r in rows)


def _cutoff(days: int) -> float:
    return time.time() - days * 86400

def _eligible(con: sqlite3.Connection, cutoff_ts: float) -> list[str]:
    """Session IDs eligible for deletion (ended, outside window, no live lock)."""
    now = time.time()
    rows = con.execute(
        """
        SELECT s.id FROM sessions s
        WHERE s.ended_at IS NOT NULL
          AND s.started_at < ?
          AND s.id NOT IN (
              SELECT session_id FROM compression_locks WHERE expires_at > ?
          )
        """,
        (cutoff_ts, now),
    ).fetchall()
    return [r["id"] for r in rows]

def _msg_count(con: sqlite3.Connection, ids: list[str]) -> int:
    if not ids:
        return 0
    ph = ",".join("?" * len(ids))
    return con.execute(f"SELECT COUNT(*) FROM messages WHERE session_id IN ({ph})", ids).fetchone()[0]

def _db_bytes(con: sqlite3.Connection) -> int:
    ps = con.execute("PRAGMA page_size").fetchone()[0]
    pc = con.execute("PRAGMA page_count").fetchone()[0]
    return ps * pc

def _batches(lst: list, n: int):
    for i in range(0, len(lst), n):
        yield lst[i : i + n]


def dry_run(db_path: Path, profile: str, days: int) -> dict:
    if not db_path.exists():
        return {"error": f"missing: {db_path}"}
    con = _open(db_path, readonly=True)
    if not _integrity(con):
        con.close()
        return {"error": "integrity_check failed"}
    cut = _cutoff(days)
    ids = _eligible(con, cut)
    msgs = _msg_count(con, ids)
    size_b = _db_bytes(con)
    oldest = newest = None
    if ids:
        row = con.execute(f"SELECT MIN(started_at), MAX(started_at) FROM sessions WHERE id IN ({','.join('?'*len(ids))})", ids).fetchone()
        ts2d = lambda ts: datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat() if ts else None
        oldest, newest = ts2d(row[0]), ts2d(row[1])
    con.close()
    return {
        "profile": profile, "window_days": days, "db": str(db_path),
        "db_bytes": size_b, "eligible_sessions": len(ids),
        "eligible_messages": msgs, "oldest": oldest, "newest": newest,
    }


def apply(db_path: Path, profile: str, days: int, verbose: bool) -> dict:
    if not db_path.exists():
        return {"error": f"missing: {db_path}"}
    con = _open(db_path, readonly=False)
    if not _integrity(con):
        con.close()
        return {"error": "integrity_check failed"}
    cut = _cutoff(days)
    ids = _eligible(con, cut)
    if not ids:
        con.close()
        return {"profile": profile, "deleted_sessions": 0, "deleted_messages": 0}
    size_before = _db_bytes(con)
    has_triggers = _has_fts_triggers(con)
    del_msgs = del_sess = 0
    for batch in _batches(ids, BATCH_SIZE):
        ph = ",".join("?" * len(batch))
        if not has_triggers:
            # No triggers: plain FTS5 owns its data — delete by rowid.
            # Do NOT call 'rebuild'; on a plain FTS5 table that wipes the index.
            con.execute(f"DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_id IN ({ph}))", batch)
        con.execute(f"DELETE FROM messages WHERE session_id IN ({ph})", batch)
        del_msgs += con.total_changes
        con.execute(f"DELETE FROM sessions WHERE id IN ({ph})", batch)
        del_sess += len(batch)
        con.commit()
        if verbose:
            print(f"  [{profile}] {del_sess}/{len(ids)} sessions deleted", flush=True)
    size_after = _db_bytes(con)
    con.close()
    return {
        "profile": profile, "window_days": days,
        "deleted_sessions": del_sess, "deleted_messages": del_msgs,
        "bytes_before": size_before, "bytes_after": size_after,
        "freed_bytes": size_before - size_after,
    }


def main():
    p = argparse.ArgumentParser(description="Hermes session-store retention.  Dry-run by default.")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--backup-ok", action="store_true", help="Attest backup taken; required for --apply")
    p.add_argument("--profile", action="append", metavar="NAME:DAYS", default=[])
    p.add_argument("--hermes-home", default=HERMES_HOME)
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    windows = dict(PROFILE_RETENTION)
    for ov in args.profile:
        name, _, days_s = ov.partition(":")
        if not days_s.isdigit():
            sys.exit(f"Bad --profile '{ov}': expected NAME:DAYS")
        windows[name] = int(days_s)
    if args.apply and not args.backup_ok:
        sys.exit("ERROR: --apply requires --backup-ok")
    profiles_root = Path(args.hermes_home) / "profiles"
    if not profiles_root.exists():
        sys.exit(f"ERROR: profiles directory not found: {profiles_root}")

    for profile, days in windows.items():
        db_path = profiles_root / profile / "state.db"
        print(f"\n=== {profile} (window: {days}d) ===")
        if args.apply:
            r = apply(db_path, profile, days, args.verbose)
            if "error" in r:
                print(f"  ERROR: {r['error']}")
            else:
                freed = r.get("freed_bytes", 0)
                print(f"  Deleted: {r['deleted_sessions']} sessions, {r['deleted_messages']} messages")
                print(f"  Freed: {freed // (1024**3):.1f} GB ({freed:,} bytes) [pre-VACUUM estimate]")
        else:
            r = dry_run(db_path, profile, days)
            if "error" in r:
                print(f"  ERROR: {r['error']}")
            else:
                print(f"  DB: {r['db_bytes'] / (1024**3):.2f} GB | "
                      f"Eligible: {r['eligible_sessions']:,} sessions {r['eligible_messages']:,} msgs | "
                      f"Range: {r['oldest']} → {r['newest']}")
    if not args.apply:
        print("\n[DRY RUN — re-run with --apply --backup-ok to prune]\n")


if __name__ == "__main__":
    main()
