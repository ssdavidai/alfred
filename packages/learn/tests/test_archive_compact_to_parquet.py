"""STORE-P5-1 (#921) — unit tests for the Parquet archival activity.

Covers:

  * Env-driven cutoff computation (compute_before_ts_ns).
  * Support-table guard (compact_to_parquet raises on unknown table).
  * No-op behaviour when state.db isn't mounted (returns ``skipped``).

Heavyweight integration paths — actual SQLite + Parquet round-trip —
are deliberately NOT exercised here because the test sandbox doesn't
guarantee a ``pyarrow`` wheel is installed (the dev environment may
not have it; the production image always does). Tests fall back to a
``pytest.importorskip`` for the round-trip case so the suite stays at
the baseline pass count on machines without pyarrow.
"""
from __future__ import annotations

import asyncio
import os
import sqlite3
import time
import uuid

import pytest

from src.activities import archive as archive_mod


class TestComputeBeforeTsNs:
    def test_audit_uses_audit_ttl(self, monkeypatch):
        # Patch the module-level constant in place (env is read at
        # import time, so we monkey-patch the binding the function
        # actually consults).
        monkeypatch.setattr(archive_mod, "AUDIT_HOT_TTL_DAYS", 90)
        now_ns = 1_700_000_000_000_000_000
        cutoff = archive_mod.compute_before_ts_ns("audit", now_ns=now_ns)
        expected = now_ns - 90 * 86_400 * 1_000_000_000
        assert cutoff == expected

    def test_signal_uses_signal_ttl(self, monkeypatch):
        monkeypatch.setattr(archive_mod, "SIGNAL_HOT_TTL_DAYS", 30)
        now_ns = 1_700_000_000_000_000_000
        cutoff = archive_mod.compute_before_ts_ns("signal", now_ns=now_ns)
        assert cutoff == now_ns - 30 * 86_400 * 1_000_000_000

    def test_observation_uses_observation_ttl(self, monkeypatch):
        monkeypatch.setattr(archive_mod, "OBSERVATION_HOT_TTL_DAYS", 7)
        now_ns = 1_700_000_000_000_000_000
        cutoff = archive_mod.compute_before_ts_ns("observation", now_ns=now_ns)
        assert cutoff == now_ns - 7 * 86_400 * 1_000_000_000

    def test_unknown_table_raises(self):
        with pytest.raises(ValueError):
            archive_mod.compute_before_ts_ns("not_a_table")


class TestCompactToParquetGuards:
    def test_unsupported_table_raises(self):
        async def go():
            return await archive_mod.compact_to_parquet(
                "bogus", 1,
            )
        with pytest.raises(ValueError):
            asyncio.new_event_loop().run_until_complete(go())

    def test_non_positive_cutoff_raises(self):
        async def go():
            return await archive_mod.compact_to_parquet(
                "audit", 0,
            )
        with pytest.raises(ValueError):
            asyncio.new_event_loop().run_until_complete(go())

    def test_missing_state_db_skips(self, monkeypatch, tmp_path):
        # Point STATE_DB_PATH at a file that doesn't exist.
        ghost = tmp_path / "missing.db"
        monkeypatch.setenv("STATE_DB_PATH", str(ghost))
        result = asyncio.new_event_loop().run_until_complete(
            archive_mod.compact_to_parquet("audit", time.time_ns())
        )
        assert result["table"] == "audit"
        assert result["copied"] == 0
        assert result["deleted"] == 0
        assert result["parquet_paths"] == []
        assert result["skipped"] == "state_db_missing"


class TestCompactToParquetRoundTrip:
    """Real round-trip — requires pyarrow. Skipped when unavailable."""

    def _build_audit_db(self, db_path: str) -> None:
        conn = sqlite3.connect(db_path)
        conn.execute("""
            CREATE TABLE audit (
              id TEXT PRIMARY KEY,
              ts INTEGER NOT NULL,
              actor TEXT NOT NULL,
              action_type TEXT NOT NULL,
              target_type TEXT NOT NULL,
              target_id TEXT NOT NULL,
              decision_origin TEXT,
              reasoning TEXT,
              payload TEXT NOT NULL,
              reversible INTEGER NOT NULL DEFAULT 0,
              reversed_by TEXT
            )
        """)
        # 3 old rows (>90d ago by a wide margin) + 1 fresh row.
        old_ts = int(time.time_ns() - 200 * 86_400 * 1_000_000_000)
        fresh_ts = int(time.time_ns())
        for i in range(3):
            conn.execute(
                "INSERT INTO audit VALUES (?,?,?,?,?,?,NULL,NULL,?,0,NULL)",
                (
                    str(uuid.uuid4()),
                    old_ts + i,  # all same month bucket
                    "test_actor",
                    "state_change",
                    "matter",
                    f"matter/test-{i}.md",
                    "{}",
                ),
            )
        conn.execute(
            "INSERT INTO audit VALUES (?,?,?,?,?,?,NULL,NULL,?,0,NULL)",
            (
                str(uuid.uuid4()),
                fresh_ts,
                "test_actor",
                "state_change",
                "matter",
                "matter/fresh.md",
                "{}",
            ),
        )
        conn.commit()
        conn.close()

    def test_round_trip_audit(self, monkeypatch, tmp_path):
        pytest.importorskip("pyarrow")
        pytest.importorskip("pyarrow.parquet")

        db_path = tmp_path / "state.db"
        archive_root = tmp_path / "_archive"
        self._build_audit_db(str(db_path))

        monkeypatch.setenv("STATE_DB_PATH", str(db_path))
        monkeypatch.setenv("VAULT_ARCHIVE_PATH", str(archive_root))

        cutoff = archive_mod.compute_before_ts_ns(
            "audit", now_ns=time.time_ns(),
        )
        result = asyncio.new_event_loop().run_until_complete(
            archive_mod.compact_to_parquet("audit", cutoff)
        )
        assert result["table"] == "audit"
        assert result["copied"] == 3, result
        assert result["deleted"] == 3, result
        assert len(result["parquet_paths"]) == 1

        # state.db should now contain only the fresh row.
        conn = sqlite3.connect(str(db_path))
        try:
            (remaining,) = conn.execute(
                "SELECT COUNT(*) FROM audit"
            ).fetchone()
        finally:
            conn.close()
        assert remaining == 1

        # Parquet file should contain exactly 3 rows.
        import pyarrow.parquet as pq
        pf = pq.ParquetFile(result["parquet_paths"][0])
        assert pf.metadata.num_rows == 3
