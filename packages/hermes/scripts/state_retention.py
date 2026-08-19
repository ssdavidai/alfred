#!/usr/bin/env python3
"""Bound a Hermes profile's session storage. Runs nightly as a --no-agent cron.

Why this exists (#241 / #261, root fix #274 was closed NOT_PLANNED)
------------------------------------------------------------------
The workers profile accumulates one session per ephemeral /v1/runs dispatch and
never releases it. Two tenants reached 53-55 GB of `state.db`, and a 16 GB one
could not cold-start its gateway at all — the bloat is invisible while a
container stays up and becomes an outage the moment it restarts.

#266 shipped a nightly `prune-old-sessions` + `vacuum-state-db` pair declared
under `cron.jobs` in the profile config.yaml. Neither has ever run: Hermes
schedules from its cron STORE (`<profile>/cron/jobs.json`), not from that
config key. Observed on a live tenant — config.yaml declared both jobs, `cron
list` reported none, and session files from two months earlier were still on
disk under a 7-day policy. This script is registered in the store instead.

What it does
------------
1. Prunes `sessions/session_*.json` and `sessions/request_dump_*.json` older
   than FILE_DAYS (that is #266's intent, via a channel that actually fires).
2. Deletes `sessions` rows older than ROW_DAYS and everything keyed to them.
   This is the half that bounds `state.db`.

Deleting from `messages` is enough to clean both FTS indexes: the schema
carries `messages_fts_delete` / `messages_fts_trigram_delete` AFTER DELETE
triggers that drop the matching rowid. No manual rebuild, no index drift.

Deletes run in small batches with a wall-clock budget, NOT as one statement.
Measured on a 12 GB tenant copy, deleting the whole 35.6k-session backlog in a
single transaction ran past ten minutes — every removed message fires two FTS
delete triggers, and the trigram index is the largest object in the file. A
nightly job holding a write lock that long would stall the gateway it is meant
to protect. Batching keeps each transaction short, lets the gateway interleave,
and simply converges over successive nights when there is a large backlog.

VACUUM is not used and never could have worked here. It reclaims free pages
rather than deleting rows — that tenant's freelist was 97k pages against a
2.9M-page file, so it would have returned ~400 MB of 12 GB — and it needs an
exclusive lock the live gateway holds. Deleting rows is what bounds the file;
freed pages are then reused, so it stops growing even though it does not
shrink. Reclaiming an existing high-water mark is a stop-the-container job.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import time

FILE_DAYS = int(os.environ.get("HERMES_RETENTION_FILE_DAYS", "7"))
ROW_DAYS = int(os.environ.get("HERMES_RETENTION_ROW_DAYS", "14"))
# Sessions per transaction, and the wall-clock ceiling for the whole row pass.
BATCH = int(os.environ.get("HERMES_RETENTION_BATCH", "250"))
BUDGET_S = int(os.environ.get("HERMES_RETENTION_BUDGET_SECONDS", "900"))

# Keyed to sessions.id; delete before the parent row. compression_locks and
# session_model_usage are the other two session_id carriers in the 0.20 schema.
CHILD_TABLES = ("messages", "session_model_usage", "compression_locks")


def main() -> int:
    profile_dir = os.environ.get("HERMES_HOME") or os.getcwd()
    slug = os.path.basename(profile_dir.rstrip("/"))

    # Hard guard: `main` is the principal's chat history, not machine scratch.
    # The supervisor only registers this on workers/heavy; this is the second,
    # independent check that a misregistration cannot delete it.
    if slug == "main":
        print("state-retention: refusing to run on the main profile", file=sys.stderr)
        return 2

    db = os.path.join(profile_dir, "state.db")
    sessions_dir = os.path.join(profile_dir, "sessions")
    print(f"state-retention[{slug}] files>{FILE_DAYS}d rows>{ROW_DAYS}d")

    # ---- 1. session artefacts on disk -------------------------------------
    removed = freed = 0
    cutoff_files = time.time() - FILE_DAYS * 86400
    if os.path.isdir(sessions_dir):
        with os.scandir(sessions_dir) as it:
            for e in it:
                if not e.is_file(follow_symlinks=False):
                    continue
                if not (e.name.startswith("session_") or e.name.startswith("request_dump_")):
                    continue
                if not e.name.endswith(".json"):
                    continue
                try:
                    st = e.stat(follow_symlinks=False)
                    if st.st_mtime < cutoff_files:
                        os.unlink(e.path)
                        removed += 1
                        freed += st.st_size
                except OSError:
                    pass  # raced with the gateway; next run picks it up
    print(f"  files:  removed {removed} ({freed / 1_048_576:.0f} MB)")

    # ---- 2. rows ----------------------------------------------------------
    if not os.path.exists(db):
        print("  rows:   no state.db, nothing to do")
        return 0

    cutoff_rows = time.time() - ROW_DAYS * 86400
    deadline = time.monotonic() + BUDGET_S
    conn = sqlite3.connect(db, timeout=60)
    try:
        conn.execute("PRAGMA busy_timeout=60000")
        before = conn.execute("SELECT count(*) FROM sessions").fetchone()[0]
        batches = 0
        while True:
            ids = [
                r[0]
                for r in conn.execute(
                    "SELECT id FROM sessions WHERE started_at < ? LIMIT ?",
                    (cutoff_rows, BATCH),
                )
            ]
            if not ids:
                break
            marks = ",".join("?" * len(ids))
            # Children first, parent last: a crash between batches can never
            # leave a message without its session.
            with conn:
                for table in CHILD_TABLES:
                    try:
                        conn.execute(
                            f"DELETE FROM {table} WHERE session_id IN ({marks})", ids
                        )
                    except sqlite3.OperationalError:
                        continue  # table absent in this schema version
                conn.execute(f"DELETE FROM sessions WHERE id IN ({marks})", ids)
            batches += 1
            if time.monotonic() > deadline:
                print(f"  rows:   budget reached after {batches} batches — resuming next run")
                break
        after = conn.execute("SELECT count(*) FROM sessions").fetchone()[0]
        page = conn.execute("PRAGMA page_size").fetchone()[0]
        count = conn.execute("PRAGMA page_count").fetchone()[0]
        free = conn.execute("PRAGMA freelist_count").fetchone()[0]
    finally:
        conn.close()

    print(f"  rows:   sessions {before} -> {after} (deleted {before - after})")
    print(
        f"  db:     {count * page / 1_073_741_824:.2f} GB on disk, "
        f"{free * page / 1_073_741_824:.2f} GB reusable"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
