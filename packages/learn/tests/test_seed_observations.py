"""Tests for seed_observations_from_chore_runs (Plan F.2)."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities import observe
from src.activities.observe import (
    _build_observation_from_chore_run,
    _read_seed_cursor,
    _write_seed_cursor,
    seed_observations_from_chore_runs,
)


def _run_activity(*args):
    env = ActivityEnvironment()
    return asyncio.run(env.run(seed_observations_from_chore_runs, *args))


def _seed_history(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as fh:
        for e in entries:
            fh.write(json.dumps(e) + "\n")


# ---------------------------------------------------------------------------
# _build_observation_from_chore_run
# ---------------------------------------------------------------------------

class TestBuildObservationFromChoreRun:
    def test_minimal_entry(self):
        obs = _build_observation_from_chore_run({
            "timestamp": 100.0,
            "chore_slug": "test-chore",
            "result_summary": "ok",
            "was_dry_run": False,
        })
        assert obs["input_type"] == "chore_run"
        assert obs["input_source"] == "chore/test-chore"
        assert obs["source"] == "chore_run"
        assert obs["routed_by"] == "alfred"
        assert obs["confidence"] == "machine"
        assert "test-chore" in obs["reasoning"]
        assert "ok" in obs["reasoning"]
        assert "live" in obs["reasoning"]

    def test_dry_run_marked(self):
        obs = _build_observation_from_chore_run({
            "timestamp": 100.0,
            "chore_slug": "test",
            "result_summary": "—",
            "was_dry_run": True,
        })
        assert "dry-run" in obs["reasoning"]
        assert "dry-run" in obs["tags"]

    def test_signals_shape_correct(self):
        obs = _build_observation_from_chore_run({
            "timestamp": 100.0,
            "chore_slug": "watch-stripe",
            "result_summary": "ok",
            "was_dry_run": False,
        })
        signals = obs["signals"]
        assert "domain_patterns" in signals
        assert "keyword_patterns" in signals
        assert "input_types" in signals
        assert "attachment_patterns" in signals
        assert isinstance(signals["domain_patterns"], list)
        assert "watch-stripe" in signals["keyword_patterns"]

    def test_routing_decision_is_dict(self):
        obs = _build_observation_from_chore_run({
            "timestamp": 100.0,
            "chore_slug": "test",
            "result_summary": "ok",
        })
        assert isinstance(obs["routing_decision"], dict)
        assert obs["routing_decision"]["destination"] == "log"

    def test_validates_against_schema(self):
        from src.validators.observation import validate_observation_record
        obs = _build_observation_from_chore_run({
            "timestamp": 100.0,
            "chore_slug": "test",
            "result_summary": "ok",
            "was_dry_run": False,
        })
        result = validate_observation_record(obs)
        assert result.valid, f"validation failed: {result.errors}"


# ---------------------------------------------------------------------------
# Cursor read/write
# ---------------------------------------------------------------------------

class TestSeedCursor:
    def test_missing_cursor_returns_default(self, tmp_path):
        with patch.object(observe, "_OBS_SEED_CURSOR_PATH", tmp_path / "missing.json"):
            cursor = _read_seed_cursor()
        assert cursor["chore_run_history_max_ts"] == 0.0

    def test_write_then_read(self, tmp_path):
        target = tmp_path / "cursor.json"
        with patch.object(observe, "_OBS_SEED_CURSOR_PATH", target):
            _write_seed_cursor({"chore_run_history_max_ts": 1234.5})
            cursor = _read_seed_cursor()
        assert cursor["chore_run_history_max_ts"] == 1234.5

    def test_corrupt_cursor_returns_default(self, tmp_path):
        target = tmp_path / "corrupt.json"
        target.write_text("not json")
        with patch.object(observe, "_OBS_SEED_CURSOR_PATH", target):
            cursor = _read_seed_cursor()
        assert cursor["chore_run_history_max_ts"] == 0.0


# ---------------------------------------------------------------------------
# Integration: seed_observations_from_chore_runs
# ---------------------------------------------------------------------------

class TestSeedObservationsFromChoreRuns:
    def test_missing_history_returns_zero(self, tmp_path):
        with patch.object(observe, "_CHORE_RUN_HISTORY_PATH", tmp_path / "missing.jsonl"), \
             patch.object(observe, "_OBS_SEED_CURSOR_PATH", tmp_path / "cursor.json"):
            result = _run_activity()
        assert result["ok"] is True
        assert result["scanned"] == 0
        assert result["seeded"] == 0

    def test_seeds_new_entries(self, tmp_path):
        history = tmp_path / "history.jsonl"
        cursor = tmp_path / "cursor.json"
        _seed_history(history, [
            {"timestamp": 100.0, "chore_slug": "a", "result_summary": "ok", "was_dry_run": False},
            {"timestamp": 200.0, "chore_slug": "b", "result_summary": "ok", "was_dry_run": False},
            {"timestamp": 300.0, "chore_slug": "c", "result_summary": "ok", "was_dry_run": True},
        ])

        # Mock write_observation_record to avoid hitting real ctrl-api
        with patch.object(observe, "_CHORE_RUN_HISTORY_PATH", history), \
             patch.object(observe, "_OBS_SEED_CURSOR_PATH", cursor), \
             patch("src.activities.vault.write_observation_record",
                   new=AsyncMock(return_value="path/to/obs.md")):
            result = _run_activity()

        assert result["ok"] is True
        assert result["scanned"] == 3
        assert result["seeded"] == 3
        assert result["max_ts"] == 300.0
        # Cursor should have been updated
        c = json.loads(cursor.read_text())
        assert c["chore_run_history_max_ts"] == 300.0

    def test_skips_already_processed(self, tmp_path):
        history = tmp_path / "history.jsonl"
        cursor = tmp_path / "cursor.json"
        cursor.write_text(json.dumps({"chore_run_history_max_ts": 200.0}))
        _seed_history(history, [
            {"timestamp": 100.0, "chore_slug": "a", "result_summary": "ok", "was_dry_run": False},
            {"timestamp": 200.0, "chore_slug": "b", "result_summary": "ok", "was_dry_run": False},
            {"timestamp": 300.0, "chore_slug": "c", "result_summary": "ok", "was_dry_run": False},
        ])

        with patch.object(observe, "_CHORE_RUN_HISTORY_PATH", history), \
             patch.object(observe, "_OBS_SEED_CURSOR_PATH", cursor), \
             patch("src.activities.vault.write_observation_record",
                   new=AsyncMock(return_value="path")):
            result = _run_activity()

        # Only entry at 300.0 should have been seeded
        assert result["scanned"] == 3
        assert result["skipped"] == 2  # 100 and 200 are <= 200
        assert result["seeded"] == 1
        assert result["max_ts"] == 300.0

    def test_respects_max_per_tick(self, tmp_path):
        history = tmp_path / "history.jsonl"
        cursor = tmp_path / "cursor.json"
        _seed_history(history, [
            {"timestamp": float(i), "chore_slug": f"c-{i}", "result_summary": "ok", "was_dry_run": False}
            for i in range(1, 21)
        ])

        with patch.object(observe, "_CHORE_RUN_HISTORY_PATH", history), \
             patch.object(observe, "_OBS_SEED_CURSOR_PATH", cursor), \
             patch("src.activities.vault.write_observation_record",
                   new=AsyncMock(return_value="path")):
            result = _run_activity(5)  # max_per_tick=5

        assert result["seeded"] == 5

    def test_corrupt_lines_skipped(self, tmp_path):
        history = tmp_path / "history.jsonl"
        cursor = tmp_path / "cursor.json"
        history.write_text(
            '{"timestamp": 1.0, "chore_slug": "a", "was_dry_run": false}\n'
            "garbage\n"
            '{"timestamp": 2.0, "chore_slug": "b", "was_dry_run": false}\n'
        )

        with patch.object(observe, "_CHORE_RUN_HISTORY_PATH", history), \
             patch.object(observe, "_OBS_SEED_CURSOR_PATH", cursor), \
             patch("src.activities.vault.write_observation_record",
                   new=AsyncMock(return_value="path")):
            result = _run_activity()

        assert result["seeded"] == 2

    def test_no_new_entries_no_cursor_update(self, tmp_path):
        history = tmp_path / "history.jsonl"
        cursor = tmp_path / "cursor.json"
        cursor.write_text(json.dumps({"chore_run_history_max_ts": 1000.0}))
        _seed_history(history, [
            {"timestamp": 100.0, "chore_slug": "a", "was_dry_run": False},
        ])

        with patch.object(observe, "_CHORE_RUN_HISTORY_PATH", history), \
             patch.object(observe, "_OBS_SEED_CURSOR_PATH", cursor), \
             patch("src.activities.vault.write_observation_record",
                   new=AsyncMock(return_value="path")):
            result = _run_activity()

        assert result["seeded"] == 0
        # Cursor unchanged
        c = json.loads(cursor.read_text())
        assert c["chore_run_history_max_ts"] == 1000.0

    def test_write_failure_continues_processing(self, tmp_path):
        history = tmp_path / "history.jsonl"
        cursor = tmp_path / "cursor.json"
        _seed_history(history, [
            {"timestamp": 100.0, "chore_slug": "a", "result_summary": "ok", "was_dry_run": False},
            {"timestamp": 200.0, "chore_slug": "b", "result_summary": "ok", "was_dry_run": False},
            {"timestamp": 300.0, "chore_slug": "c", "result_summary": "ok", "was_dry_run": False},
        ])

        # Have the second write fail
        call_count = {"n": 0}
        async def flaky_write(*args, **kwargs):
            call_count["n"] += 1
            if call_count["n"] == 2:
                raise RuntimeError("vault offline")
            return "path"

        with patch.object(observe, "_CHORE_RUN_HISTORY_PATH", history), \
             patch.object(observe, "_OBS_SEED_CURSOR_PATH", cursor), \
             patch("src.activities.vault.write_observation_record", new=flaky_write):
            result = _run_activity()

        # 3 attempts, 1 failed, 2 succeeded
        assert call_count["n"] == 3
        assert result["seeded"] == 2
