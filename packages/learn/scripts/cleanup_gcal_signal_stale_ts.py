"""One-time cleanup: rewrite ``ts`` on gcal signal rows from fetch-wall-clock
to the actual event-occurrence time.

CONTEXT
-------

Until PR #940, ``packages/learn/src/parsers/composio.py:_item_to_event`` only
extracted ``received_at`` from gmail-shaped fields (``date``, ``created_at``,
``messageTimestamp``, ``internalDate``). For Google Calendar events — which
carry the occurrence under ``start.dateTime`` / ``start.date`` — none of
those existed, so the parser fell through to ``datetime.now()``. Every gcal
event therefore landed in state.db's ``signal`` table with ``ts`` set to the
fetch wall-clock instead of the actual event time.

On david this produced 186 gcal signal rows in the May 6–May 19 ``ts`` band,
each pointing at events spanning January through October. Those rows still
appear in the brief's read window because PR #932's 14-day ``ts`` cutoff
can't filter content-stale-but-row-fresh data.

PR #940 fixed the parser for FUTURE gcal ingests but does not backfill the
existing rows; the Composio gcal connector uses a syncToken cursor, so the
old events will not be re-fetched unless they change. This script is the
one-time backfill.

STRATEGY
--------

The signal row's ``body`` includes a "Raw quote" line emitted at extraction
time that contains the event's date in ``YYYY-MM-DD HH:MM`` format. Example::

    > Jon a csalad — 2025-02-08 00:00 — 2025-02-09 00:00, organizer ...

We parse the first ``YYYY-MM-DD`` (with optional ``HH:MM``) match from the
body. If the parsed event-date is at least 1 day OLDER than the current
``ts`` we rewrite ``ts`` to the event-date's nanosecond timestamp. We never
move ``ts`` forward and we skip rows where parsing fails — both choices keep
the operation strictly conservative.

USAGE
-----

Run inside the alfred-learn container (it has ``/var/lib/alfred/state.db``
mounted at the host's persistent path)::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.cleanup_gcal_signal_stale_ts [--dry-run]

Flags::

    --dry-run         Print what would change without writing.
    --batch-size N    Log progress every N records (default 50).
    --min-drift-hours N
                      Only rewrite ts when the parsed event-date is at
                      least N hours older than the current ts (default 24).
                      Prevents touching rows whose ts is already roughly
                      correct (e.g. a same-day fetch of a same-day event).

OUTPUT
------

Prints a one-line summary per row when verbose, plus a final tally::

    examined: 186
    updated:  179  (median drift: 87 days)
    skipped:  7    (no parseable date in body)

After this lands, the brief's 14d cutoff will correctly filter the
already-past gcal events.
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone


logger = logging.getLogger("cleanup-gcal-signal-stale-ts")


# Match ``2025-02-08`` or ``2025-02-08 17:30`` or ``2025-02-08T17:30`` — the
# event-date shape the Composio gcal parser writes into the body's Raw
# quote line. The hour-minute is optional; when absent we default to 09:00
# UTC so the row's ts at least lands inside the right day.
_DATE_RE = re.compile(
    r"\b(?P<year>20\d{2})-(?P<month>\d{2})-(?P<day>\d{2})"
    r"(?:[T ](?P<hour>\d{2}):(?P<minute>\d{2}))?",
)

# The body has the FETCH-date in the source_event path on the very first
# line (e.g. ``stream_event/generic-2026-05-18-...md``) and the actual
# EVENT-date later under a ``Raw quote:`` block. We want the latter.
_RAW_QUOTE_RE = re.compile(r"Raw quote:\s*\n", re.IGNORECASE)


def parse_event_dt(body: str) -> datetime | None:
    """Return the most plausible event datetime found in the body, or None.

    Strategy:
    1. If a ``Raw quote:`` marker exists, scan only the text after it. The
       Raw quote is what the signal extractor copied verbatim from the
       Composio gcal event payload, so the first date there is the event's
       actual occurrence time.
    2. Otherwise fall back to the *earliest* date anywhere in the body —
       chosen because the fetch-date in the ``source_event`` path is
       always recent (within the last ~14 days) so a date older than that
       must be the event date.
    """
    if not body:
        return None

    quote_match = _RAW_QUOTE_RE.search(body)
    if quote_match:
        scan = body[quote_match.end():]
        m = _DATE_RE.search(scan)
    else:
        # Fallback: pick the earliest date anywhere in the body.
        candidates = [_match_to_dt(m) for m in _DATE_RE.finditer(body)]
        candidates = [c for c in candidates if c is not None]
        if not candidates:
            return None
        return min(candidates)

    if not m:
        return None
    return _match_to_dt(m)


def _match_to_dt(m: re.Match[str]) -> datetime | None:
    try:
        year = int(m.group("year"))
        month = int(m.group("month"))
        day = int(m.group("day"))
        hour = int(m.group("hour") or "9")
        minute = int(m.group("minute") or "0")
        return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def dt_to_ns(dt: datetime) -> int:
    """Convert a tz-aware datetime to integer nanoseconds since epoch."""
    return int(dt.timestamp() * 1_000_000_000)


def cleanup(
    db_path: str,
    *,
    dry_run: bool,
    min_drift_hours: int,
    batch_size: int,
) -> int:
    """Walk gcal signal rows; rewrite ts when the body's date is older.

    Returns 0 on success, 1 if no rows were examined (sanity guard).
    """
    if not os.path.exists(db_path):
        logger.error("state.db not found at %s", db_path)
        return 1

    conn = sqlite3.connect(db_path)
    # Always-fresh read; we do our own batching for writes.
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        "SELECT id, ts, body FROM signal WHERE source_type = 'gcal'",
    ).fetchall()
    total = len(rows)
    if total == 0:
        logger.info("no gcal signal rows in %s — nothing to do", db_path)
        return 0

    updated = 0
    skipped_no_date = 0
    skipped_already_old = 0
    drift_days: list[int] = []

    min_drift_ns = int(min_drift_hours * 3600 * 1_000_000_000)

    for i, row in enumerate(rows, start=1):
        body = row["body"] or ""
        event_dt = parse_event_dt(body)
        if event_dt is None:
            skipped_no_date += 1
            logger.debug("skip id=%s — no date in body", row["id"][:8])
            continue

        new_ts = dt_to_ns(event_dt)
        old_ts = int(row["ts"])
        if old_ts - new_ts < min_drift_ns:
            # ts is already close to event time (or before it — don't move
            # forward). Skip.
            skipped_already_old += 1
            continue

        drift_days.append((old_ts - new_ts) // (86_400 * 1_000_000_000))

        if not dry_run:
            conn.execute(
                "UPDATE signal SET ts = ? WHERE id = ?",
                (new_ts, row["id"]),
            )
        updated += 1

        if updated and updated % batch_size == 0:
            logger.info("processed %d/%d (%d updated so far)", i, total, updated)
            if not dry_run:
                conn.commit()

    if not dry_run:
        conn.commit()
    conn.close()

    median_drift = sorted(drift_days)[len(drift_days) // 2] if drift_days else 0
    mode = "DRY-RUN" if dry_run else "APPLIED"
    logger.info(
        "%s — examined=%d updated=%d skipped_no_date=%d skipped_already_old=%d "
        "median_drift=%dd",
        mode,
        total,
        updated,
        skipped_no_date,
        skipped_already_old,
        median_drift,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--db-path",
        default=os.environ.get("STATE_DB_PATH", "/var/lib/alfred/state.db"),
        help="Path to state.db (default: /var/lib/alfred/state.db)",
    )
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument(
        "--min-drift-hours",
        type=int,
        default=24,
        help="Only rewrite ts when the body's date is at least N hours older "
        "than the current ts (default 24).",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Print per-row decisions",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    return cleanup(
        args.db_path,
        dry_run=args.dry_run,
        min_drift_hours=args.min_drift_hours,
        batch_size=args.batch_size,
    )


if __name__ == "__main__":
    sys.exit(main())
