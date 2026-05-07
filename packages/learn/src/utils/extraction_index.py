"""Sidecar SQLite index for signal-extraction state.

Replaces the vault-frontmatter ``signal_extracted_at`` cursor with a
local SQLite index. The vault-frontmatter approach forced every mark
through ``alfred vault edit`` (parse-edit-write the entire YAML), which
fails on records with malformed Unicode. A single bad record poisoned
its workflow tick, causing infinite re-extraction and unbounded LLM
spend on david's gcal backlog.

The sidecar is the source of truth going forward. The
``signal_extracted_at`` field still gets written into new stream-event
frontmatter by ``stream_vault.py`` (initial value ``null``) for
read-back diagnostics, but the workflow no longer writes to it.

Schema:
    extracted(path TEXT PRIMARY KEY, extracted_at TEXT, signal_path TEXT)

Path: ``/alfred-data/state/signal_extraction.db`` (overridable via env
``SIGNAL_EXTRACTION_DB_PATH``).
"""
from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

logger = logging.getLogger("alfred-learn")

_DEFAULT_DB_PATH = "/alfred-data/state/signal_extraction.db"


def db_path() -> str:
    return os.environ.get("SIGNAL_EXTRACTION_DB_PATH", _DEFAULT_DB_PATH)


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS extracted (
            path TEXT PRIMARY KEY,
            extracted_at TEXT NOT NULL,
            signal_path TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS bootstrap (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            completed_at TEXT NOT NULL
        )
        """
    )
    conn.commit()


@contextmanager
def _open_db():
    path = db_path()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    try:
        _ensure_schema(conn)
        yield conn
    finally:
        conn.close()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def mark_processed(path: str, signal_path: str | None) -> None:
    """Record ``path`` as extracted. Idempotent."""

    def _sync() -> None:
        with _open_db() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO extracted(path, extracted_at, signal_path) "
                "VALUES (?, ?, ?)",
                (path, _now(), signal_path),
            )
            conn.commit()

    await asyncio.to_thread(_sync)


async def mark_processed_bulk(paths: Iterable[str]) -> int:
    """Mark many paths processed in one transaction.

    Used by ``list_unprocessed_stream_events`` to bulk-dismiss
    structurally-garbage records (Composio API errors stored as
    events, openclaw slash-commands, hard-blocked source types) so
    they never appear in a subsequent listing.

    Returns the number of rows inserted.
    """

    def _sync() -> int:
        ts = _now()
        rows = [(p, ts, None) for p in paths if p]
        if not rows:
            return 0
        with _open_db() as conn:
            conn.executemany(
                "INSERT OR REPLACE INTO extracted(path, extracted_at, signal_path) "
                "VALUES (?, ?, ?)",
                rows,
            )
            conn.commit()
        return len(rows)

    return await asyncio.to_thread(_sync)


async def get_processed_set() -> set[str]:
    """Return every path the sidecar has ever marked processed."""

    def _sync() -> set[str]:
        with _open_db() as conn:
            return {row[0] for row in conn.execute("SELECT path FROM extracted")}

    return await asyncio.to_thread(_sync)


async def is_bootstrapped() -> bool:
    def _sync() -> bool:
        with _open_db() as conn:
            return (
                conn.execute("SELECT 1 FROM bootstrap WHERE id = 1").fetchone()
                is not None
            )

    return await asyncio.to_thread(_sync)


async def bootstrap_from_records(records: Iterable[dict]) -> int:
    """One-shot import of existing ``signal_extracted_at`` values.

    Reads frontmatter from every vault record passed in and inserts
    paths whose ``signal_extracted_at`` is a real ISO date (not null,
    empty, or unparseable). Marks bootstrap complete so subsequent
    ticks skip this work.
    """

    def _sync() -> int:
        count = 0
        with _open_db() as conn:
            for rec in records:
                fm = rec.get("frontmatter") or {}
                if not isinstance(fm, dict):
                    continue
                ext = fm.get("signal_extracted_at")
                if not isinstance(ext, str):
                    continue
                ext = ext.strip().strip("\"'")
                if not ext or ext == "null" or not ext.startswith("20"):
                    continue
                path = str(rec.get("path") or "").strip()
                if not path:
                    continue
                conn.execute(
                    "INSERT OR REPLACE INTO extracted(path, extracted_at, signal_path) "
                    "VALUES (?, ?, ?)",
                    (path, ext, fm.get("signal_path")),
                )
                count += 1
            conn.execute(
                "INSERT OR REPLACE INTO bootstrap(id, completed_at) VALUES (1, ?)",
                (_now(),),
            )
            conn.commit()
        return count

    return await asyncio.to_thread(_sync)
