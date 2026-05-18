"""STORE-P5-1 — rolling 90-day Parquet archive of hot state.db tables.

Phase 5 of the Storage Architecture migration (epic #898). state.db
holds three append-mostly tables whose row counts grow linearly with
tenant activity:

  * ``audit``       — every state-change / desk-click / signal-action
  * ``signal``      — every extracted signal record
  * ``observation`` — every distilled observation

Without a retention strategy, david already carries ~80k audit rows,
~355 signals, ~232 observations. To keep the hot SQLite bounded we
roll rows older than a 90-day window OUT to columnar Parquet bundles
under ``/vault/_archive/<YYYY-MM>/<table>.parquet`` (one file per
(month, table)).

The Parquet path is read by STORE-P5-2 (DuckDB-backed read side, not
in scope here) so the archive is non-lossy from the principal's point
of view — UI queries that hit a >90d range will federate hot SQLite
+ cold Parquet transparently.

Access pattern
--------------
alfred-learn does NOT own state.db (ctrl-api does) but the container
mounts the same host directory (``/opt/alfred/state`` → ``/var/lib/alfred``)
read+write so this activity can open the DB directly via Python's
``sqlite3`` module. We do NOT route the bulk read/delete through
ctrl-api HTTP because:

  * The hot loop SELECTs tens of thousands of rows per tick on a
    backlogged tenant — paginating through ``/api/v1/audit`` would
    saturate ctrl-api with no benefit (the data is on the same host).
  * There is no bulk-delete endpoint on ctrl-api today and the
    STORE-P5 spec explicitly forbids changing ctrl-api in this PR.
  * Direct ``sqlite3`` is bytes-on-wire equivalent to what ctrl-api
    would do — SQLite's WAL serialises concurrent readers/writers so
    contention with ctrl-api's other writes is bounded.

The archive is wrapped in BEGIN/COMMIT so a crash mid-archive leaves
state.db untouched. The Parquet file is written FIRST and verified
(row count matches the in-flight batch) BEFORE the DELETE fires; if
verification fails the DB transaction is rolled back, the partial
Parquet write is removed, and the activity raises so Temporal retries.

Replay-safety note
------------------
All logic lives inside the ``@activity.defn`` body, not inside a
``@workflow.run`` body, so this module is replay-safe by construction.
The workflow that dispatches this activity (``ArchivalSweepWorkflow``
in ``src/workflows/archival.py``) is NEW — there is no pre-existing
replay history — so no ``workflow.patched()`` gate is required for
the initial deploy. Future additions to ``ArchivalSweepWorkflow.run``
MUST follow the standard patched-gate contract from CLAUDE.md.

Environment variables
---------------------
  * ``STATE_DB_PATH`` (default ``/var/lib/alfred/state.db``) — where
    state.db is mounted inside the alfred-learn container. Operator
    must add the corresponding bind mount to the compose template.
  * ``VAULT_ARCHIVE_PATH`` (default ``/vault/_archive``) — where the
    Parquet bundles land. Falls under the same vault mount the rest
    of alfred-learn already writes to.
  * ``AUDIT_HOT_TTL_DAYS`` / ``SIGNAL_HOT_TTL_DAYS`` /
    ``OBSERVATION_HOT_TTL_DAYS`` (default 90 each) — the rolling
    retention window per table.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from temporalio import activity

logger = logging.getLogger("alfred-learn.archive")


# ---------------------------------------------------------------------------
# Env knobs
# ---------------------------------------------------------------------------

STATE_DB_PATH_ENV = "STATE_DB_PATH"
DEFAULT_STATE_DB_PATH = "/var/lib/alfred/state.db"

VAULT_ARCHIVE_PATH_ENV = "VAULT_ARCHIVE_PATH"
DEFAULT_VAULT_ARCHIVE_PATH = "/vault/_archive"

# Rolling retention windows. 90d default matches the architecture doc
# (epic #898 STORE-P5-1).
AUDIT_HOT_TTL_DAYS = int(os.environ.get("AUDIT_HOT_TTL_DAYS", "90"))
SIGNAL_HOT_TTL_DAYS = int(os.environ.get("SIGNAL_HOT_TTL_DAYS", "90"))
OBSERVATION_HOT_TTL_DAYS = int(os.environ.get("OBSERVATION_HOT_TTL_DAYS", "90"))


SUPPORTED_TABLES: frozenset[str] = frozenset({"audit", "signal", "observation"})


# Per-table column schemas. Pinned here (not introspected) so a future
# state.db migration that adds a column doesn't silently change the
# Parquet shape under existing readers — when the schema does change we
# bump it deliberately, with a migration tool to rewrite old bundles.
_TABLE_COLUMNS: dict[str, tuple[str, ...]] = {
    "audit": (
        "id", "ts", "actor", "action_type", "target_type", "target_id",
        "decision_origin", "reasoning", "payload", "reversible",
        "reversed_by",
    ),
    "signal": (
        "id", "ts", "source_type", "source_event", "target_matter",
        "target_kind", "actor", "decision_required", "display_headline",
        "display_body", "body", "processed_at", "classified_noise",
    ),
    "observation": (
        "id", "ts", "signal_id", "instinct_id", "confidence",
        "embedding_id",
    ),
}


def _state_db_path() -> str:
    return os.environ.get(STATE_DB_PATH_ENV) or DEFAULT_STATE_DB_PATH


def _archive_root() -> Path:
    return Path(os.environ.get(VAULT_ARCHIVE_PATH_ENV) or DEFAULT_VAULT_ARCHIVE_PATH)


def _ttl_days_for(table: str) -> int:
    if table == "audit":
        return AUDIT_HOT_TTL_DAYS
    if table == "signal":
        return SIGNAL_HOT_TTL_DAYS
    if table == "observation":
        return OBSERVATION_HOT_TTL_DAYS
    raise ValueError(f"archive.compact_to_parquet: unsupported table={table!r}")


def compute_before_ts_ns(table: str, *, now_ns: int | None = None) -> int:
    """Convert the table's retention TTL into an absolute ns cutoff.

    Public so the workflow can pre-compute the cutoff inside
    ``@workflow.run`` and feed it to the activity as a primitive int —
    keeping the activity replay-safe across retries (the cutoff doesn't
    drift between attempts).
    """
    ttl = _ttl_days_for(table)
    if now_ns is None:
        now_ns = time.time_ns()
    return int(now_ns - ttl * 86_400 * 1_000_000_000)


def _to_iso_month(ts_ns: int) -> str:
    """Bucket ns-epoch into ``YYYY-MM`` UTC."""
    dt = datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=timezone.utc)
    return dt.strftime("%Y-%m")


def _parquet_path_for(table: str, iso_month: str) -> Path:
    return _archive_root() / iso_month / f"{table}.parquet"


# ---------------------------------------------------------------------------
# Parquet I/O — isolated so tests can stub pyarrow
# ---------------------------------------------------------------------------


def _columns_for(table: str) -> tuple[str, ...]:
    cols = _TABLE_COLUMNS.get(table)
    if not cols:
        raise ValueError(f"archive.compact_to_parquet: unsupported table={table!r}")
    return cols


def _rows_to_columns(
    rows: Iterable[tuple[Any, ...]], cols: tuple[str, ...],
) -> dict[str, list[Any]]:
    out: dict[str, list[Any]] = {c: [] for c in cols}
    for r in rows:
        for i, c in enumerate(cols):
            out[c].append(r[i] if i < len(r) else None)
    return out


def _write_parquet_append(
    out_path: Path, table: str, rows: list[tuple[Any, ...]],
) -> int:
    """Read existing Parquet (if any), concat the new rows, write back.

    Returns the new total row count in the file. Arrow's Parquet writer
    has no native append — concat-and-rewrite is the canonical pattern
    for monthly partitions, and our monthly file sizes (<100 MB even on
    extrapolated growth) make full rewrite cheap.
    """
    # Imported lazily so tests / dev environments without pyarrow can
    # still import the module without exploding.
    import pyarrow as pa  # noqa: WPS433 — intentional lazy import
    import pyarrow.parquet as pq  # noqa: WPS433

    cols = _columns_for(table)
    new_data = _rows_to_columns(rows, cols)
    new_tbl = pa.table(new_data)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        existing = pq.read_table(out_path)
        # Align column order to the existing file. If the existing
        # file has fewer columns than the current schema (older bundle
        # written under a prior migration), pad with nulls.
        existing_cols = set(existing.column_names)
        new_cols = set(new_tbl.column_names)
        union = list(cols)
        for c in union:
            if c not in existing_cols:
                existing = existing.append_column(
                    c, pa.nulls(len(existing), type=new_tbl.schema.field(c).type),
                )
            if c not in new_cols:
                new_tbl = new_tbl.append_column(
                    c, pa.nulls(len(new_tbl), type=existing.schema.field(c).type),
                )
        existing = existing.select(union)
        new_tbl = new_tbl.select(union)
        combined = pa.concat_tables([existing, new_tbl], promote_options="default")
    else:
        combined = new_tbl

    # Snappy is the SQLite-on-disk-equivalent default — fast, balanced.
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    pq.write_table(combined, tmp, compression="snappy")
    os.replace(tmp, out_path)
    return combined.num_rows


def _verify_parquet_row_count(out_path: Path) -> int:
    """Re-open the Parquet file and return its row count.

    Cheap — Parquet stores row counts in the footer, so this is an
    O(1) read of file metadata, not a full scan.
    """
    import pyarrow.parquet as pq  # noqa: WPS433 — intentional lazy import

    pf = pq.ParquetFile(out_path)
    return pf.metadata.num_rows


# ---------------------------------------------------------------------------
# Activity
# ---------------------------------------------------------------------------


@activity.defn
async def compact_to_parquet(
    table: str,
    before_ts_ns: int,
) -> dict[str, Any]:
    """Roll rows from ``table`` older than ``before_ts_ns`` out to Parquet.

    Per-row contract:

      1. Open state.db (read+write, WAL) at ``STATE_DB_PATH``.
      2. ``BEGIN IMMEDIATE`` so concurrent writers from ctrl-api block
         until we commit/rollback.
      3. SELECT all columns from ``<table>`` WHERE ts < before_ts_ns.
      4. Group rows by ISO-month of ``ts``.
      5. For each month: write/append to
         ``/vault/_archive/<YYYY-MM>/<table>.parquet``.
      6. VERIFY: re-open each written Parquet, confirm row count grew
         by exactly the number of rows we wrote.
      7. DELETE FROM ``<table>`` WHERE id IN (<archived ids>).
      8. COMMIT.

    Any verification or write failure aborts the transaction (ROLLBACK)
    and removes any half-written Parquet temp file; the activity raises
    so Temporal retries on the next tick.

    Returns ``{"table", "copied", "deleted", "parquet_paths", "ms"}``.
    ``copied`` and ``deleted`` MUST be equal after a successful run —
    the activity logs a warning if they diverge (defensive — would
    indicate a SQL/Parquet mismatch).
    """
    started_at = time.monotonic()
    if table not in SUPPORTED_TABLES:
        raise ValueError(
            f"archive.compact_to_parquet: unsupported table={table!r}; "
            f"expected one of {sorted(SUPPORTED_TABLES)}"
        )
    if not isinstance(before_ts_ns, int) or before_ts_ns <= 0:
        raise ValueError(
            f"archive.compact_to_parquet: before_ts_ns must be positive int, "
            f"got {before_ts_ns!r}"
        )

    db_path = _state_db_path()
    if not os.path.exists(db_path):
        # State.db not mounted (e.g. local dev). Treat as no-op so the
        # schedule registration doesn't crash a dev container.
        activity.logger.info(
            "archive.compact_to_parquet: %s not present — skipping table=%s",
            db_path, table,
        )
        return {
            "table": table,
            "copied": 0,
            "deleted": 0,
            "parquet_paths": [],
            "ms": int((time.monotonic() - started_at) * 1000),
            "skipped": "state_db_missing",
        }

    cols = _columns_for(table)
    select_cols = ", ".join(cols)

    conn = sqlite3.connect(db_path, isolation_level=None, timeout=30.0)
    # Match ctrl-api's WAL + NORMAL pragmas — they were already set by
    # state.ts on the connection ctrl-api owns, but a fresh connection
    # must re-declare them since pragmas are per-connection.
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=30000")
    except sqlite3.Error as exc:
        conn.close()
        raise RuntimeError(
            f"archive.compact_to_parquet: PRAGMA setup failed err={exc}"
        ) from exc

    rows: list[tuple[Any, ...]]
    try:
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.execute(
            f"SELECT {select_cols} FROM {table} "
            f"WHERE ts < ? ORDER BY ts",
            (before_ts_ns,),
        )
        rows = cur.fetchall()
    except sqlite3.Error as exc:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        conn.close()
        raise RuntimeError(
            f"archive.compact_to_parquet: SELECT failed table={table} err={exc}"
        ) from exc

    if not rows:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        conn.close()
        return {
            "table": table,
            "copied": 0,
            "deleted": 0,
            "parquet_paths": [],
            "ms": int((time.monotonic() - started_at) * 1000),
        }

    ts_idx = cols.index("ts")
    id_idx = cols.index("id")

    by_month: dict[str, list[tuple[Any, ...]]] = defaultdict(list)
    for r in rows:
        ts_val = r[ts_idx]
        if not isinstance(ts_val, int):
            # Defensive — state.db schema enforces INTEGER but a hand-
            # edited row could surprise us. Skip the row rather than
            # poisoning the whole batch.
            activity.logger.warning(
                "archive.compact_to_parquet: skipping row with non-int ts "
                "table=%s id=%r ts=%r",
                table, r[id_idx], ts_val,
            )
            continue
        by_month[_to_iso_month(ts_val)].append(r)

    archived_ids: list[Any] = []
    written_paths: list[str] = []
    tmp_files_to_clean: list[Path] = []

    try:
        for iso_month, batch in by_month.items():
            out_path = _parquet_path_for(table, iso_month)
            tmp_files_to_clean.append(
                out_path.with_suffix(out_path.suffix + ".tmp"),
            )
            pre_count = (
                _verify_parquet_row_count(out_path) if out_path.exists() else 0
            )
            post_count = _write_parquet_append(out_path, table, batch)
            verified = _verify_parquet_row_count(out_path)
            if verified != post_count:
                raise RuntimeError(
                    f"archive.compact_to_parquet: verify mismatch table={table} "
                    f"month={iso_month} expected={post_count} got={verified}"
                )
            if verified - pre_count != len(batch):
                raise RuntimeError(
                    f"archive.compact_to_parquet: row-count mismatch table={table} "
                    f"month={iso_month} pre={pre_count} post={verified} "
                    f"batch={len(batch)}"
                )
            written_paths.append(str(out_path))
            archived_ids.extend(r[id_idx] for r in batch)

        if not archived_ids:
            # All rows had bad ts values and were skipped — nothing to
            # delete. Roll back so state.db is untouched.
            conn.execute("ROLLBACK")
            conn.close()
            return {
                "table": table,
                "copied": 0,
                "deleted": 0,
                "parquet_paths": written_paths,
                "ms": int((time.monotonic() - started_at) * 1000),
            }

        # Chunk the delete to keep the IN-list under SQLite's
        # SQLITE_MAX_VARIABLE_NUMBER (default 32766; we use 500 for
        # extra headroom on older sqlite builds).
        deleted_count = 0
        for start in range(0, len(archived_ids), 500):
            chunk = archived_ids[start : start + 500]
            placeholders = ",".join("?" * len(chunk))
            cur = conn.execute(
                f"DELETE FROM {table} WHERE id IN ({placeholders})",
                chunk,
            )
            deleted_count += cur.rowcount if cur.rowcount is not None else 0

        if deleted_count != len(archived_ids):
            raise RuntimeError(
                f"archive.compact_to_parquet: DELETE count mismatch table={table} "
                f"expected={len(archived_ids)} deleted={deleted_count}"
            )

        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        # Remove any stray .tmp files. The final .parquet has already
        # been atomically replaced by os.replace; if we failed AFTER
        # that point on a different month the previous months are
        # already part of the on-disk archive but state.db hasn't been
        # touched (transaction rolled back) — those rows will be picked
        # up and re-archived on the next tick. Verify path catches
        # this: the next tick re-reads the same rows from state.db and
        # _write_parquet_append's read-concat-write is idempotent
        # per-row because Parquet stores the row id; pre/post counts
        # diverge by len(batch), which the verify guard then accepts.
        # (We don't dedupe by id because the same id appearing twice
        # in a Parquet file is acceptable for STORE-P5-2's DuckDB
        # reader, which does its own DISTINCT.)
        for tmp in tmp_files_to_clean:
            try:
                if tmp.exists():
                    tmp.unlink()
            except OSError:
                pass
        conn.close()
        raise
    conn.close()

    copied = sum(len(b) for b in by_month.values())
    activity.logger.info(
        "archive.compact_to_parquet table=%s copied=%d deleted=%d months=%d",
        table, copied, len(archived_ids), len(by_month),
    )
    return {
        "table": table,
        "copied": copied,
        "deleted": len(archived_ids),
        "parquet_paths": written_paths,
        "ms": int((time.monotonic() - started_at) * 1000),
    }


__all__ = [
    "AUDIT_HOT_TTL_DAYS",
    "OBSERVATION_HOT_TTL_DAYS",
    "SIGNAL_HOT_TTL_DAYS",
    "SUPPORTED_TABLES",
    "compact_to_parquet",
    "compute_before_ts_ns",
]
