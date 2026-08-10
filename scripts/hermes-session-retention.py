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
import shutil
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

def _db_bytes(con: sqlite3.Connection) -> int:
    ps = con.execute("PRAGMA page_size").fetchone()[0]
    pc = con.execute("PRAGMA page_count").fetchone()[0]
    return ps * pc

def _batches(lst: list, n: int):
    for i in range(0, len(lst), n):
        yield lst[i : i + n]


def checkpoint(db_path: Path, verbose: bool) -> dict:
    """WAL checkpoint (TRUNCATE mode).  Safe at any time; no data-loss risk."""
    if not db_path.exists():
        return {"error": f"missing: {db_path}"}
    con = _open(db_path, readonly=False)
    busy, log_pg, ckpt_pg = con.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    con.close()
    if verbose:
        print(f"  checkpoint: busy={busy} log_pages={log_pg} moved={ckpt_pg}", flush=True)
    return {"busy": bool(busy), "log_pages": log_pg, "ckpt_pages": ckpt_pg}


def vacuum_db(db_path: Path, verbose: bool, _free_override: int = -1) -> dict:
    """VACUUM in-place.  Requires ~2x file size in free disk; aborts if disk is tight.

    _free_override: inject a fake free-bytes value for tests (>=0 to activate).
    WAL truncation and a full-file rewrite differ from session deletion in disk
    requirement, risk, and timing — that is why they are opt-in flags rather
    than steps in --apply.
    """
    if not db_path.exists():
        return {"error": f"missing: {db_path}"}
    con = _open(db_path, readonly=False)
    db_bytes = _db_bytes(con)
    con.close()
    free = _free_override if _free_override >= 0 else shutil.disk_usage(db_path.parent).free
    needed = db_bytes * 2
    if free < needed:
        return {"error": f"need ~{needed//(1024**3):.1f} GB free, have {free//(1024**3):.1f} GB",
                "db_bytes": db_bytes, "free_bytes": free}
    con = _open(db_path, readonly=False)
    if verbose:
        print(f"  VACUUM {db_path} ({db_bytes//(1024**3):.1f} GB) ...", flush=True)
    con.execute("VACUUM")
    size_after = _db_bytes(con)
    con.close()
    return {"bytes_before": db_bytes, "bytes_after": size_after, "freed_bytes": db_bytes - size_after}


def dry_run(db_path: Path, profile: str, days: int) -> dict:
    if not db_path.exists():
        return {"error": f"missing: {db_path}"}
    con = _open(db_path, readonly=True)
    if not _integrity(con):
        con.close()
        return {"error": "integrity_check failed"}
    cut = _cutoff(days)
    now = time.time()
    # Predicate-based counts — never materialise the session id list.
    # The old _msg_count() built one SQL placeholder per id; on stores with
    # >32 k eligible sessions this exceeded SQLite_MAX_VARIABLE_NUMBER (32766)
    # and hung.  A single predicate-join query runs in <1 s on 678 k messages.
    n_sess = con.execute(
        "SELECT COUNT(*) FROM sessions"
        " WHERE ended_at IS NOT NULL AND started_at < ?"
        " AND id NOT IN (SELECT session_id FROM compression_locks WHERE expires_at > ?)",
        (cut, now),
    ).fetchone()[0]
    n_msgs = con.execute(
        "SELECT COUNT(*) FROM messages m"
        " JOIN sessions s ON m.session_id = s.id"
        " WHERE s.ended_at IS NOT NULL AND s.started_at < ?"
        " AND s.id NOT IN (SELECT session_id FROM compression_locks WHERE expires_at > ?)",
        (cut, now),
    ).fetchone()[0]
    size_b = _db_bytes(con)
    oldest = newest = None
    if n_sess:
        row = con.execute(
            "SELECT MIN(started_at), MAX(started_at) FROM sessions"
            " WHERE ended_at IS NOT NULL AND started_at < ?"
            " AND id NOT IN (SELECT session_id FROM compression_locks WHERE expires_at > ?)",
            (cut, now),
        ).fetchone()
        ts2d = lambda ts: datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat() if ts else None
        oldest, newest = ts2d(row[0]), ts2d(row[1])
    con.close()
    return {
        "profile": profile, "window_days": days, "db": str(db_path),
        "db_bytes": size_b, "eligible_sessions": n_sess,
        "eligible_messages": n_msgs, "oldest": oldest, "newest": newest,
    }


def apply(db_path: Path, profile: str, days: int, verbose: bool) -> dict:
    if not db_path.exists():
        return {"error": f"missing: {db_path}"}
    con = _open(db_path, readonly=False)
    if not _integrity(con):
        con.close()
        return {"error": "integrity_check failed"}
    cut = _cutoff(days)
    now = time.time()
    # Count without materialising the id list (same predicate as the LIMIT loop).
    total = con.execute(
        "SELECT COUNT(*) FROM sessions"
        " WHERE ended_at IS NOT NULL AND started_at < ?"
        " AND id NOT IN (SELECT session_id FROM compression_locks WHERE expires_at > ?)",
        (cut, now),
    ).fetchone()[0]
    if not total:
        con.close()
        return {"profile": profile, "deleted_sessions": 0, "deleted_messages": 0}
    size_before = _db_bytes(con)
    has_triggers = _has_fts_triggers(con)
    del_msgs = del_sess = 0
    # Batched LIMIT loop — avoids loading 100k+ ids into memory and remains
    # resumable: each committed batch is gone, so the next SELECT picks up
    # exactly the remaining sessions without any offset arithmetic.
    while True:
        rows = con.execute(
            "SELECT id FROM sessions"
            " WHERE ended_at IS NOT NULL AND started_at < ?"
            " AND id NOT IN (SELECT session_id FROM compression_locks WHERE expires_at > ?)"
            " LIMIT ?",
            (cut, now, BATCH_SIZE),
        ).fetchall()
        if not rows:
            break
        batch = [r[0] for r in rows]
        ph = ",".join("?" * len(batch))
        if not has_triggers:
            # No triggers: plain FTS5 owns its data — delete by rowid.
            # Do NOT call 'rebuild'; on a plain FTS5 table that wipes the index.
            con.execute(
                f"DELETE FROM messages_fts WHERE rowid IN"
                f" (SELECT id FROM messages WHERE session_id IN ({ph}))",
                batch,
            )
        cur = con.execute(f"DELETE FROM messages WHERE session_id IN ({ph})", batch)
        del_msgs += cur.rowcount   # rowcount = rows affected by THIS statement
        cur2 = con.execute(f"DELETE FROM sessions WHERE id IN ({ph})", batch)
        del_sess += cur2.rowcount  # not total_changes (cumulative) or len(batch) (assumed)
        con.commit()
        if verbose:
            print(f"  [{profile}] {del_sess}/{total} sessions deleted", flush=True)
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
    p.add_argument("--checkpoint", action="store_true", help="WAL checkpoint (TRUNCATE) each profile store")
    p.add_argument("--vacuum", action="store_true", help="VACUUM each profile store (needs ~2x file size free)")
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
        # Skip the eligibility scan when only maintenance ops are requested.
        # --checkpoint and --vacuum need no eligibility information; the scan
        # was the bottleneck that made "checkpoint-only" runs hang for 20+ min.
        do_scan = args.apply or (not args.checkpoint and not args.vacuum)
        if do_scan:
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
        if args.checkpoint:
            cr = checkpoint(db_path, args.verbose)
            if "error" in cr:
                print(f"  checkpoint ERROR: {cr['error']}")
            else:
                print(f"  WAL checkpoint: busy={cr['busy']} log={cr['log_pages']} moved={cr['ckpt_pages']}")
        if args.vacuum:
            vr = vacuum_db(db_path, args.verbose)
            if "error" in vr:
                print(f"  VACUUM ERROR: {vr['error']}")
            else:
                freed = vr.get("freed_bytes", 0)
                print(f"  VACUUM freed {freed//(1024**3):.1f} GB ({freed:,} bytes)")
    if not args.apply:
        print("\n[DRY RUN — re-run with --apply --backup-ok to prune]\n")


if __name__ == "__main__":
    main()
