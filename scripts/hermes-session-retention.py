#!/usr/bin/env python3
"""
Hermes session-store retention tool.  refs #430

Policy rationale — per-profile windows, not a single global number
-------------------------------------------------------------------
A flat 30-day window is the wrong shape for this data:

  workers (default 14 days): ephemeral background-agent traffic (clerk,
    curator, janitor, distiller). Holds ~87% of sessions and ~73% of
    messages. Its durable output already lives in alfred-state.db and
    the vault, so raw transcripts have little independent audit value.

  main (default 90 days): the principal's own conversation history.
    Highest audit value. Only ~10% of the reclaimable messages. Preserve
    generously.

  heavy (default 90 days): reflection and onboarding reasoning. Low
    volume; sparse but important context. Not worth aggressive pruning.

Per-profile windows are explicit in PROFILE_RETENTION below, and
overridable at the command line.  Never collapse them into one number.

Liveness predicate — a session is protected if ANY holds:
  1. ended_at IS NULL            — session is in progress
  2. started_at > cutoff         — newer than the retention window
  3. id in compression_locks     — compression in flight; deleting now
     where released_at IS NULL     would corrupt the session

FTS5 note:
  The script inspects sqlite_master at runtime to detect whether UPDATE/
  DELETE triggers maintain messages_fts automatically.  If no such
  triggers are found, it deletes from messages_fts explicitly (matching
  on rowid = messages.id) before deleting from messages.  Never assume —
  always verify from the live schema.

VACUUM warning:
  VACUUM rewrites the entire database file and requires ~2x the current
  file size in free disk space.  Run it detached (nohup / screen).
  Expected: workers 14 GB → ~2 h; main 7 GB → ~45 min.
  Use --checkpoint first to reclaim WAL space without a full rewrite.
"""

import argparse
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Per-profile retention windows.  Override with --profile <name>:<days>.
# ---------------------------------------------------------------------------
PROFILE_RETENTION: dict[str, int] = {
    "workers": 14,   # ephemeral; durable output lives in state.db + vault
    "main":    90,   # principal's conversation history — highest audit value
    "heavy":   90,   # low-volume reflection reasoning — not worth aggressive pruning
}

HERMES_HOME = os.environ.get("HERMES_HOME", "/hermes-state")
BATCH_SIZE = 500   # rows per DELETE batch; committed independently for resumability


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
    return row and row[0] == "ok"


def _has_fts_triggers(con: sqlite3.Connection) -> bool:
    """Return True if DELETE triggers on `messages` maintain `messages_fts`."""
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='messages'"
    ).fetchall()
    return any("fts" in (r["name"] or "").lower() for r in rows)


def _fts_is_content_table(con: sqlite3.Connection) -> bool:
    """Return True if messages_fts is an FTS5 *content* table (content='messages').

    A content table delegates storage to an external table; its shadow tables
    hold only the index, not a copy of the data.  Rows cannot be deleted from
    a content FTS directly by rowid — that path raises "database disk image is
    malformed".  Cleanup requires 'rebuild' after the source rows are gone.

    Detection: read the CREATE VIRTUAL TABLE DDL from sqlite_master.  An FTS5
    content table always has a content=... option in its definition.
    """
    row = con.execute(
        "SELECT sql FROM sqlite_master WHERE name='messages_fts'"
    ).fetchone()
    if not row or not row[0]:
        return False
    return "content=" in row[0].lower()


def _cutoff(days: int) -> float:
    return time.time() - days * 86400


def _eligible(con: sqlite3.Connection, cutoff_ts: float) -> list[str]:
    """Session IDs eligible for deletion (outside window, ended, not in compression_locks)."""
    rows = con.execute(
        """
        SELECT s.id FROM sessions s
        WHERE s.ended_at IS NOT NULL
          AND s.started_at < ?
          AND s.id NOT IN (
              SELECT session_id FROM compression_locks WHERE released_at IS NULL
          )
        """,
        (cutoff_ts,),
    ).fetchall()
    return [r["id"] for r in rows]


def _msg_count(con: sqlite3.Connection, session_ids: list[str]) -> int:
    if not session_ids:
        return 0
    placeholders = ",".join("?" * len(session_ids))
    return con.execute(
        f"SELECT COUNT(*) FROM messages WHERE session_id IN ({placeholders})",
        session_ids,
    ).fetchone()[0]


def _page_size(con: sqlite3.Connection) -> int:
    return con.execute("PRAGMA page_size").fetchone()[0]


def _page_count(con: sqlite3.Connection) -> int:
    return con.execute("PRAGMA page_count").fetchone()[0]


def _batches(lst: list, n: int):
    for i in range(0, len(lst), n):
        yield lst[i : i + n]


def dry_run(db_path: Path, profile: str, days: int) -> dict:
    if not db_path.exists():
        return {"error": f"missing: {db_path}"}
    con = _open(db_path, readonly=True)
    if not _integrity(con):
        return {"error": "integrity_check failed — aborting"}
    cut = _cutoff(days)
    ids = _eligible(con, cut)
    msgs = _msg_count(con, ids)
    size_b = _page_size(con) * _page_count(con)
    oldest = newest = None
    if ids:
        dates = con.execute(
            f"SELECT MIN(started_at), MAX(started_at) FROM sessions WHERE id IN ({','.join('?'*len(ids))})",
            ids,
        ).fetchone()
        oldest = datetime.fromtimestamp(dates[0], tz=timezone.utc).date().isoformat() if dates[0] else None
        newest = datetime.fromtimestamp(dates[1], tz=timezone.utc).date().isoformat() if dates[1] else None
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
        return {"error": "integrity_check failed — aborting"}
    cut = _cutoff(days)
    ids = _eligible(con, cut)
    if not ids:
        con.close()
        return {"profile": profile, "deleted_sessions": 0, "deleted_messages": 0}
    size_before = _page_size(con) * _page_count(con)
    has_triggers = _has_fts_triggers(con)
    is_content_fts = _fts_is_content_table(con)
    del_msgs = del_sess = 0
    for batch in _batches(ids, BATCH_SIZE):
        ph = ",".join("?" * len(batch))
        if not has_triggers and not is_content_fts:
            # Standalone FTS5 (own data copy, no triggers) — delete by rowid directly
            con.execute(f"DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_id IN ({ph}))", batch)
        con.execute(f"DELETE FROM messages WHERE session_id IN ({ph})", batch)
        del_msgs += con.total_changes
        con.execute(f"DELETE FROM sessions WHERE id IN ({ph})", batch)
        del_sess += len(batch)
        con.commit()
        if verbose:
            print(f"  [{profile}] batch done: {del_sess}/{len(ids)} sessions", flush=True)
    if not has_triggers and is_content_fts:
        # Content table FTS5 (content='messages') — rebuild index from remaining rows.
        # This is the only safe cleanup path; rowid DELETE raises "malformed" on content tables.
        con.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
        con.commit()
    size_after = _page_size(con) * _page_count(con)
    con.close()
    return {
        "profile": profile, "window_days": days,
        "deleted_sessions": del_sess, "deleted_messages": del_msgs,
        "bytes_before": size_before, "bytes_after": size_after,
        "freed_bytes": size_before - size_after,
    }


def checkpoint(db_path: Path, profile: str) -> dict:
    if not db_path.exists():
        return {"error": f"missing: {db_path}"}
    con = _open(db_path, readonly=False)
    row = con.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    con.close()
    # row: (busy, log, checkpointed)
    return {"profile": profile, "busy": row[0], "log_frames": row[1], "ckpt_frames": row[2]}


def vacuum_db(db_path: Path, profile: str) -> dict:
    if not db_path.exists():
        return {"error": f"missing: {db_path}"}
    con = _open(db_path, readonly=False)
    t0 = time.time()
    con.execute("VACUUM")
    elapsed = time.time() - t0
    con.close()
    return {"profile": profile, "vacuum_seconds": round(elapsed, 1)}


def main():
    p = argparse.ArgumentParser(
        description="Hermes session-store retention.  Dry-run by default.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python3 hermes-session-retention.py                         # dry-run all profiles\n"
            "  python3 hermes-session-retention.py --apply --backup-ok     # prune all profiles\n"
            "  python3 hermes-session-retention.py --checkpoint            # WAL truncate only\n"
            "  python3 hermes-session-retention.py --vacuum --apply --backup-ok  # VACUUM (2h+)\n"
            "  python3 hermes-session-retention.py --profile workers:7     # override one window\n"
        ),
    )
    p.add_argument("--apply", action="store_true", help="Mutate databases (default: dry-run)")
    p.add_argument("--backup-ok", action="store_true", help="Attest that a volume backup was taken; required for --apply")
    p.add_argument("--checkpoint", action="store_true", help="Run PRAGMA wal_checkpoint(TRUNCATE) on each profile DB")
    p.add_argument("--vacuum", action="store_true", help="Run VACUUM after deletion (separate opt-in; needs 2x disk free)")
    p.add_argument("--profile", action="append", metavar="NAME:DAYS", default=[],
                   help="Override retention window for one profile (repeatable)")
    p.add_argument("--hermes-home", default=HERMES_HOME, help=f"HERMES_HOME path (default: {HERMES_HOME})")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    # Apply per-profile overrides
    windows = dict(PROFILE_RETENTION)
    for override in args.profile:
        name, _, days_str = override.partition(":")
        if not days_str.isdigit():
            sys.exit(f"Bad --profile value '{override}': expected NAME:DAYS (integer)")
        windows[name] = int(days_str)

    if args.apply and not args.backup_ok:
        sys.exit("ERROR: --apply requires --backup-ok (attest that a volume backup was taken first)")

    profiles_root = Path(args.hermes_home) / "profiles"
    if not profiles_root.exists():
        sys.exit(f"ERROR: profiles directory not found: {profiles_root}")

    for profile, days in windows.items():
        db_path = profiles_root / profile / "state.db"
        print(f"\n=== {profile} (window: {days}d, db: {db_path}) ===")

        if args.checkpoint:
            r = checkpoint(db_path, profile)
            if "error" in r:
                print(f"  CHECKPOINT ERROR: {r['error']}")
            else:
                print(f"  WAL checkpoint: busy={r['busy']} log={r['log_frames']} ckpt={r['ckpt_frames']}")

        if args.apply:
            r = apply(db_path, profile, days, args.verbose)
            if "error" in r:
                print(f"  ERROR: {r['error']}")
            else:
                print(f"  Deleted: {r['deleted_sessions']} sessions, {r['deleted_messages']} messages")
                freed = r.get("freed_bytes", 0)
                print(f"  Freed: {freed // (1024**3):.1f} GB ({freed:,} bytes) [pre-VACUUM estimate]")
            if args.vacuum:
                vr = vacuum_db(db_path, profile)
                if "error" in vr:
                    print(f"  VACUUM ERROR: {vr['error']}")
                else:
                    print(f"  VACUUM done in {vr['vacuum_seconds']}s")
        else:
            r = dry_run(db_path, profile, days)
            if "error" in r:
                print(f"  ERROR: {r['error']}")
            else:
                gb = r["db_bytes"] / (1024**3)
                print(f"  DB size: {gb:.2f} GB ({r['db_bytes']:,} bytes)")
                print(f"  Eligible sessions: {r['eligible_sessions']:,}  messages: {r['eligible_messages']:,}")
                print(f"  Date range of eligible: {r['oldest']} → {r['newest']}")

    if not args.apply:
        print("\n[DRY RUN — no changes made.  Re-run with --apply --backup-ok to prune.]\n")


if __name__ == "__main__":
    main()
