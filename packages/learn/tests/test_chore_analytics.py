"""Tests for S5-1 chore run history + get_chore_run_statistics activity.

Covers:
  - `_append_run_history` persists JSONL entries correctly
  - `get_chore_run_statistics` aggregate math (total_runs, live_runs,
    dry_runs, first_run, last_run, recent_runs)
  - `since` timestamp filter
  - Corrupt lines are skipped without raising
  - Missing history file returns zeroes cleanly

Tests patch `_CHORE_RUN_HISTORY_PATH` to a tmp_path so nothing touches
the real /alfred-data directory.
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from unittest.mock import patch

from temporalio.testing import ActivityEnvironment

from src.workflows.chores import _base


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_stats(chore_slug: str, since: str = "") -> dict:
    env = ActivityEnvironment()
    return asyncio.run(env.run(_base.get_chore_run_statistics, chore_slug, since))


def _seed_history(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as fh:
        for e in entries:
            fh.write(json.dumps(e) + "\n")


# ---------------------------------------------------------------------------
# _append_run_history
# ---------------------------------------------------------------------------

class TestAppendRunHistory:
    def test_creates_parent_directory(self, tmp_path):
        target = tmp_path / "deep" / "nested" / "history.jsonl"
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", target):
            _base._append_run_history({"chore_slug": "x", "timestamp": 1.0})
        assert target.exists()
        assert target.parent.is_dir()

    def test_appends_jsonl_lines(self, tmp_path):
        target = tmp_path / "history.jsonl"
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", target):
            _base._append_run_history({"chore_slug": "a", "timestamp": 1.0})
            _base._append_run_history({"chore_slug": "b", "timestamp": 2.0})
            _base._append_run_history({"chore_slug": "c", "timestamp": 3.0})
        lines = target.read_text().strip().split("\n")
        assert len(lines) == 3
        assert json.loads(lines[0])["chore_slug"] == "a"
        assert json.loads(lines[2])["chore_slug"] == "c"

    def test_swallows_oserror_on_bad_path(self, tmp_path):
        # Point at a directory where mkdir + open fails
        target = tmp_path / "afile"
        target.write_text("blocker")  # exists as a file, not a dir
        bad_target = target / "history.jsonl"  # would need "afile" to be a dir
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", bad_target):
            # Must not raise
            _base._append_run_history({"chore_slug": "x", "timestamp": 1.0})


# ---------------------------------------------------------------------------
# get_chore_run_statistics — happy path
# ---------------------------------------------------------------------------

class TestGetChoreRunStatistics:
    def test_missing_history_file_returns_zeroes(self, tmp_path):
        target = tmp_path / "nonexistent.jsonl"
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", target):
            stats = _run_stats("any-slug")
        assert stats["total_runs"] == 0
        assert stats["live_runs"] == 0
        assert stats["dry_runs"] == 0
        assert stats["first_run"] is None
        assert stats["last_run"] is None
        assert stats["recent_runs"] == []

    def test_single_run_reported(self, tmp_path):
        target = tmp_path / "history.jsonl"
        _seed_history(target, [
            {"timestamp": 100.0, "chore_slug": "foo", "result_summary": "ok", "was_dry_run": False},
        ])
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", target):
            stats = _run_stats("foo")
        assert stats["total_runs"] == 1
        assert stats["live_runs"] == 1
        assert stats["dry_runs"] == 0
        assert stats["first_run"] == 100.0
        assert stats["last_run"] == 100.0

    def test_filters_by_chore_slug(self, tmp_path):
        target = tmp_path / "history.jsonl"
        _seed_history(target, [
            {"timestamp": 1.0, "chore_slug": "foo", "result_summary": "a", "was_dry_run": False},
            {"timestamp": 2.0, "chore_slug": "bar", "result_summary": "b", "was_dry_run": False},
            {"timestamp": 3.0, "chore_slug": "foo", "result_summary": "c", "was_dry_run": False},
        ])
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", target):
            stats = _run_stats("foo")
        assert stats["total_runs"] == 2
        assert stats["first_run"] == 1.0
        assert stats["last_run"] == 3.0

    def test_separates_live_vs_dry_runs(self, tmp_path):
        target = tmp_path / "history.jsonl"
        _seed_history(target, [
            {"timestamp": 1.0, "chore_slug": "x", "result_summary": "dry", "was_dry_run": True},
            {"timestamp": 2.0, "chore_slug": "x", "result_summary": "dry", "was_dry_run": True},
            {"timestamp": 3.0, "chore_slug": "x", "result_summary": "dry", "was_dry_run": True},
            {"timestamp": 4.0, "chore_slug": "x", "result_summary": "live", "was_dry_run": False},
            {"timestamp": 5.0, "chore_slug": "x", "result_summary": "live", "was_dry_run": False},
        ])
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", target):
            stats = _run_stats("x")
        assert stats["total_runs"] == 5
        assert stats["dry_runs"] == 3
        assert stats["live_runs"] == 2

    def test_recent_runs_limited_to_last_10(self, tmp_path):
        target = tmp_path / "history.jsonl"
        _seed_history(target, [
            {"timestamp": float(i), "chore_slug": "x", "result_summary": f"run{i}", "was_dry_run": False}
            for i in range(1, 16)
        ])
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", target):
            stats = _run_stats("x")
        assert stats["total_runs"] == 15
        assert len(stats["recent_runs"]) == 10
        # Last 10 means entries 6 through 15 (timestamps 6.0..15.0)
        assert stats["recent_runs"][0]["timestamp"] == 6.0
        assert stats["recent_runs"][-1]["timestamp"] == 15.0

    def test_sorts_by_timestamp(self, tmp_path):
        """first_run/last_run should reflect chronological extremes
        even if the file is out-of-order (e.g. concurrent writers)."""
        target = tmp_path / "history.jsonl"
        _seed_history(target, [
            {"timestamp": 5.0, "chore_slug": "x", "result_summary": "b", "was_dry_run": False},
            {"timestamp": 1.0, "chore_slug": "x", "result_summary": "a", "was_dry_run": False},
            {"timestamp": 3.0, "chore_slug": "x", "result_summary": "c", "was_dry_run": False},
        ])
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", target):
            stats = _run_stats("x")
        assert stats["first_run"] == 1.0
        assert stats["last_run"] == 5.0


# ---------------------------------------------------------------------------
# get_chore_run_statistics — since filter
# ---------------------------------------------------------------------------

class TestSinceFilter:
    def test_since_iso_filters_older_entries(self, tmp_path):
        target = tmp_path / "history.jsonl"
        # Build entries at known epochs
        _seed_history(target, [
            {"timestamp": 1000.0, "chore_slug": "x", "result_summary": "old", "was_dry_run": False},
            {"timestamp": 2000.0, "chore_slug": "x", "result_summary": "mid", "was_dry_run": False},
            {"timestamp": 3000.0, "chore_slug": "x", "result_summary": "new", "was_dry_run": False},
        ])
        # ISO for ts 1500 → should include only mid + new (2 entries)
        from datetime import datetime, timezone
        since_iso = datetime.fromtimestamp(1500.0, tz=timezone.utc).isoformat()
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", target):
            stats = _run_stats("x", since=since_iso)
        assert stats["total_runs"] == 2
        assert stats["first_run"] == 2000.0

    def test_malformed_since_treated_as_no_filter(self, tmp_path):
        target = tmp_path / "history.jsonl"
        _seed_history(target, [
            {"timestamp": 1.0, "chore_slug": "x", "result_summary": "a", "was_dry_run": False},
            {"timestamp": 2.0, "chore_slug": "x", "result_summary": "b", "was_dry_run": False},
        ])
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", target):
            stats = _run_stats("x", since="not-an-iso-string")
        # Should include everything
        assert stats["total_runs"] == 2


# ---------------------------------------------------------------------------
# get_chore_run_statistics — robustness
# ---------------------------------------------------------------------------

class TestRobustness:
    def test_corrupt_line_skipped(self, tmp_path):
        target = tmp_path / "history.jsonl"
        target.write_text(
            '{"timestamp": 1.0, "chore_slug": "x", "was_dry_run": false}\n'
            "garbage garbage not json\n"
            '{"timestamp": 2.0, "chore_slug": "x", "was_dry_run": false}\n'
        )
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", target):
            stats = _run_stats("x")
        # Both valid entries counted, corrupt line skipped
        assert stats["total_runs"] == 2

    def test_non_dict_json_line_skipped(self, tmp_path):
        target = tmp_path / "history.jsonl"
        target.write_text(
            '[1, 2, 3]\n'  # Valid JSON but not a dict
            '{"timestamp": 1.0, "chore_slug": "x", "was_dry_run": false}\n'
            '"just a string"\n'
        )
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", target):
            stats = _run_stats("x")
        assert stats["total_runs"] == 1

    def test_missing_timestamp_skipped(self, tmp_path):
        target = tmp_path / "history.jsonl"
        target.write_text(
            '{"chore_slug": "x", "was_dry_run": false}\n'
            '{"timestamp": "not-a-number", "chore_slug": "x", "was_dry_run": false}\n'
            '{"timestamp": 1.0, "chore_slug": "x", "was_dry_run": false}\n'
        )
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", target):
            stats = _run_stats("x")
        assert stats["total_runs"] == 1

    def test_empty_file_returns_zeroes(self, tmp_path):
        target = tmp_path / "history.jsonl"
        target.write_text("")
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", target):
            stats = _run_stats("x")
        assert stats["total_runs"] == 0

    def test_chore_slug_empty_string_matches_all(self, tmp_path):
        target = tmp_path / "history.jsonl"
        _seed_history(target, [
            {"timestamp": 1.0, "chore_slug": "a", "was_dry_run": False},
            {"timestamp": 2.0, "chore_slug": "b", "was_dry_run": False},
            {"timestamp": 3.0, "chore_slug": "c", "was_dry_run": False},
        ])
        with patch.object(_base, "_CHORE_RUN_HISTORY_PATH", target):
            stats = _run_stats("")
        assert stats["total_runs"] == 3
