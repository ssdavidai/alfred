"""The observation table is a shared bus — its readers must filter by kind.

Written after `attention_read` (#584) was about to be added as a new kind:
neither the daily brief's Quiet Notes nor pattern discovery filtered anything,
so a reporting kind would have surfaced in Sir's brief as an intuition note and
been fed to pattern discovery as an observation about the world.
"""
from unittest.mock import AsyncMock, patch

import pytest

from src.utils.signal_state import (
    INTUITION_OBS_KINDS,
    list_observation_records,
    observation_row_to_record,
)


def _row(obs_id: str, kind: str, payload: dict | None = None) -> dict:
    return {
        "id": obs_id, "kind": kind, "subject": f"s-{obs_id}",
        "summary": f"summary {obs_id}", "ts": "2026-08-15T00:00:00Z",
        "payload": payload or {},
    }


class TestKindIsNotOnTheRehydratedRecord:
    """Why the filter must run on the raw row, not the record."""

    def test_record_has_no_top_level_kind(self):
        rec = observation_row_to_record(_row("a", "signal"))
        assert "kind" not in rec, (
            "if this ever gains a top-level kind, the raw-row filter can be "
            "simplified — until then, filtering the record silently matches nothing"
        )

    def test_payload_source_kind_wins_over_the_column(self):
        # setdefault: a payload carrying source_kind keeps its own value and the
        # kind column is lost. Filtering on frontmatter["source_kind"] would
        # therefore misclassify this row.
        rec = observation_row_to_record(
            _row("b", "attention_read", {"source_kind": "signal"}),
        )
        assert rec["frontmatter"]["source_kind"] == "signal"


class TestKindsFilter:
    @pytest.mark.asyncio
    async def test_reporting_kind_excluded_intuition_kinds_kept(self):
        rows = [
            _row("1", "signal"), _row("2", "decision"),
            _row("3", "attention_read"), _row("4", "chore_run"),
        ]
        with patch("src.utils.signal_state.StateClient") as sc:
            sc.return_value.__aenter__.return_value.list_observations = AsyncMock(
                return_value=rows,
            )
            out = await list_observation_records(limit=20, kinds=INTUITION_OBS_KINDS)
        assert [r["id"] for r in out] == ["1", "2", "4"]

    @pytest.mark.asyncio
    async def test_no_kinds_argument_filters_nothing(self):
        # Existing callers that pass no `kinds` must keep their behaviour.
        rows = [_row("1", "signal"), _row("2", "attention_read")]
        with patch("src.utils.signal_state.StateClient") as sc:
            sc.return_value.__aenter__.return_value.list_observations = AsyncMock(
                return_value=rows,
            )
            out = await list_observation_records(limit=20)
        assert [r["id"] for r in out] == ["1", "2"]

    def test_attention_read_is_not_an_intuition_kind(self):
        assert "attention_read" not in INTUITION_OBS_KINDS
        for k in ("signal", "decision", "chore_run"):
            assert k in INTUITION_OBS_KINDS


class TestBothConsumersPassTheFilter:
    """Guards the call sites, not just the helper — the helper defaults to
    filtering nothing, so a consumer that forgets the argument is the bug."""

    def test_brief_quiet_notes_passes_kinds(self):
        src = open("src/activities/vault.py").read()
        assert "kinds=INTUITION_OBS_KINDS" in src

    def test_pattern_detection_passes_kinds(self):
        src = open("src/activities/pattern_detection.py").read()
        assert "kinds=INTUITION_OBS_KINDS" in src
