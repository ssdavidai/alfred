#!/usr/bin/env python3
"""sessionstore-maintenance — periodic Hermes SessionStore housekeeping.

Replaces the deleted OpenClaw `.bak-*` session reaper. That reaper existed
only because OpenClaw stored each agent's history as per-agent `.jsonl` files
and did an O(N) `readdir` over them — leaked trajectory files eventually
CPU-pegged the workers gateway. Hermes uses a SQLite SessionStore, so the
readdir failure mode is structurally gone; what remains is ordinary table
growth. This job keeps that bounded:

    DELETE FROM sessions WHERE <updated-column> < cutoff   -- prune stale rows
    VACUUM                                                 -- reclaim pages

Run as a 5th supervised process in the Hermes container (see supervisor.sh):
a plain sleep loop — Hermes' own Jobs/cron API is profile-scoped and aimed at
agent-authored jobs, not infra housekeeping, so an external loop is simpler
and observable in the same logs.

Scope: by default the WORKERS profile only — that profile runs the high-volume
autonomous agents (clerk, curator, janitor, distiller, ephemeral executors)
whose sessions accumulate fastest. The user-facing `main` profile keeps its
sessions for conversational continuity; set HERMES_MAINT_PROFILES to include it
if desired.

Environment:
    HERMES_HOME              profile root            (default /opt/data)
    HERMES_MAINT_PROFILES    comma-separated profiles (default "workers")
    HERMES_MAINT_INTERVAL    seconds between sweeps   (default 3600 — hourly)
    HERMES_MAINT_MAX_AGE     prune rows older than N seconds (default 604800 — 7d)
    HERMES_MAINT_ONESHOT     "1" → run one sweep and exit (for cron/testing)
"""

from __future__ import annotations

import glob
import os
import sqlite3
import sys
import time

HERMES_HOME = os.environ.get("HERMES_HOME", "/opt/data")
PROFILES = [
    p.strip()
    for p in os.environ.get("HERMES_MAINT_PROFILES", "workers").split(",")
    if p.strip()
]
INTERVAL = int(os.environ.get("HERMES_MAINT_INTERVAL", "3600"))
MAX_AGE = int(os.environ.get("HERMES_MAINT_MAX_AGE", str(7 * 24 * 3600)))
ONESHOT = os.environ.get("HERMES_MAINT_ONESHOT", "") in ("1", "true", "yes")

# Candidate timestamp columns on the `sessions` table, newest-write first.
# Different Hermes builds name this differently; we probe in order and use
# whichever exists. INTEGER epoch and TEXT ISO timestamps are both handled.
_TS_COLUMNS = ("updated_at", "last_active_at", "modified_at", "created_at", "ts")


def log(msg: str) -> None:
    print(
        f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} "
        f"[sessionstore-maintenance] {msg}",
        flush=True,
    )


def find_session_dbs(profile: str) -> list[str]:
    """Find SQLite files under a profile dir whose schema has a `sessions` table.

    The exact SessionStore filename is not contractually pinned, so we glob
    every *.db / *.sqlite* under the profile directory and keep the ones that
    actually carry a `sessions` table.
    """
    profile_dir = os.path.join(HERMES_HOME, "profiles", profile)
    if not os.path.isdir(profile_dir):
        log(f"profile dir absent, skipping: {profile_dir}")
        return []

    candidates: list[str] = []
    for pattern in ("*.db", "*.sqlite", "*.sqlite3"):
        candidates.extend(glob.glob(os.path.join(profile_dir, "**", pattern), recursive=True))

    matched: list[str] = []
    for path in sorted(set(candidates)):
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
            try:
                row = con.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='table' AND name='sessions'"
                ).fetchone()
            finally:
                con.close()
            if row:
                matched.append(path)
        except sqlite3.Error as exc:
            log(f"could not inspect {path}: {exc}")
    return matched


def resolve_ts_column(con: sqlite3.Connection) -> str | None:
    """Return the best available timestamp column on the `sessions` table."""
    cols = {r[1] for r in con.execute("PRAGMA table_info(sessions)")}
    for name in _TS_COLUMNS:
        if name in cols:
            return name
    return None


def sweep_db(path: str) -> None:
    """Prune stale `sessions` rows from one DB, then VACUUM."""
    try:
        con = sqlite3.connect(path, timeout=30)
    except sqlite3.Error as exc:
        log(f"open failed {path}: {exc}")
        return

    try:
        ts_col = resolve_ts_column(con)
        if ts_col is None:
            log(f"{path}: no recognised timestamp column on `sessions` — skip prune")
            con.execute("VACUUM")
            con.commit()
            return

        now = time.time()
        cutoff_epoch = now - MAX_AGE
        # ISO-8601 cutoff for TEXT timestamp columns.
        cutoff_iso = time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(cutoff_epoch)
        )

        # The column may store either an epoch number or an ISO string.
        # CASE-discriminate on typeof() so one statement covers both.
        deleted = con.execute(
            f"""
            DELETE FROM sessions
            WHERE (typeof({ts_col}) IN ('integer','real') AND {ts_col} < ?)
               OR (typeof({ts_col}) = 'text'            AND {ts_col} < ?)
            """,
            (cutoff_epoch, cutoff_iso),
        ).rowcount
        con.commit()

        # VACUUM cannot run inside a transaction — commit above first.
        con.execute("VACUUM")
        con.commit()
        log(
            f"{path}: pruned {deleted} session row(s) older than "
            f"{MAX_AGE}s (col={ts_col}); VACUUM done"
        )
    except sqlite3.Error as exc:
        log(f"{path}: sweep error: {exc}")
    finally:
        con.close()


def run_once() -> None:
    swept = 0
    for profile in PROFILES:
        dbs = find_session_dbs(profile)
        if not dbs:
            log(f"profile '{profile}': no SessionStore DB found")
            continue
        for path in dbs:
            sweep_db(path)
            swept += 1
    log(f"sweep complete — {swept} DB(s) processed across profiles {PROFILES}")


def main() -> None:
    log(
        f"starting — HERMES_HOME={HERMES_HOME} profiles={PROFILES} "
        f"interval={INTERVAL}s max_age={MAX_AGE}s oneshot={ONESHOT}"
    )
    if ONESHOT:
        run_once()
        return

    while True:
        try:
            run_once()
        except Exception as exc:  # noqa: BLE001 — never let the loop die
            log(f"unexpected error in sweep: {exc}")
        time.sleep(INTERVAL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
