"""SM-D-W5 — propose function unit tests for the archival sweep retrofit.

The cold-task archival sweep lives in
``packages/learn/scripts/cold_task_archival.py`` (asyncio script, no
Temporal workflow). Under the Phase D contract every successful
archive lays down a ``state_change`` audit + timeline entry on the task
via ``apply_state_change_v2`` with propose function
``archival_sweep.cold``. The retrofit is env-gated
(``ARCHIVAL_SWEEP_STATE_MUTATOR_V1``) — the legacy PATCH path is
unchanged so existing behaviour and existing test coverage continue to
hold.

This file covers the new propose-function logic directly. End-to-end
script coverage is exercised in CI integration; per Phase D guidance
each writer's existing tests must still pass and one new Phase D case
is added — these are the new cases.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from src.activities.archival_sweep import propose_archival_sweep_cold
from src.activities.state_mutator import ObservedWindow, ProposedMutation


def _window() -> ObservedWindow:
    now = datetime.now(timezone.utc)
    return ObservedWindow(
        start=now,
        end=now,
        signal_paths=[],
        decision_paths=[],
        other_refs=[],
    )


class TestArchivalSweepCold:
    """Direct unit coverage on the deterministic propose function."""

    def test_open_task_returns_archived_mutation(self) -> None:
        """A non-terminal task lands a ProposedMutation with status=archived."""

        async def _go() -> ProposedMutation | None:
            target = {
                "frontmatter": {
                    "status": "open",
                    "as_of": "2026-04-13T12:00:00Z",
                },
                "body": "",
                "as_of": "2026-04-13T12:00:00Z",
            }
            return await propose_archival_sweep_cold(
                target=target,
                observed=_window(),
                args={"reason": "cold_inactive_30d"},
            )

        result = asyncio.run(_go())
        assert isinstance(result, ProposedMutation)
        assert result.fields == {"status": "archived"}
        # Deterministic writers default to full confidence.
        assert result.confidence == 1.0
        # Reason must mention the provenance string so /decisions surfaces it.
        assert "cold_inactive_30d" in result.reason

    def test_already_archived_returns_none(self) -> None:
        """Idempotency: re-running over an archived task must NOT propose anything."""

        async def _go() -> ProposedMutation | None:
            target = {
                "frontmatter": {"status": "archived"},
                "body": "",
                "as_of": "2026-04-13T12:00:00Z",
            }
            return await propose_archival_sweep_cold(
                target=target,
                observed=_window(),
                args={"reason": "cold_inactive_30d"},
            )

        assert asyncio.run(_go()) is None

    def test_cancelled_status_is_terminal(self) -> None:
        """Plane-mirrored ``cancelled`` is treated as terminal too."""

        async def _go() -> ProposedMutation | None:
            target = {"frontmatter": {"status": "cancelled"}}
            return await propose_archival_sweep_cold(
                target=target,
                observed=_window(),
                args={},
            )

        assert asyncio.run(_go()) is None

    def test_status_case_insensitive(self) -> None:
        """Mixed-case ``ARCHIVED`` from a stray writer still counts as terminal."""

        async def _go() -> ProposedMutation | None:
            target = {"frontmatter": {"status": "ARCHIVED"}}
            return await propose_archival_sweep_cold(
                target=target,
                observed=_window(),
                args={},
            )

        assert asyncio.run(_go()) is None

    def test_missing_status_still_archives(self) -> None:
        """Frontmatter without ``status`` (very old vault entries) is archivable —
        the script's age classifier already vetted them, the propose function
        trusts that."""

        async def _go() -> ProposedMutation | None:
            target = {"frontmatter": {}}
            return await propose_archival_sweep_cold(
                target=target,
                observed=_window(),
                args={"reason": "cold_untouched_30d"},
            )

        result = asyncio.run(_go())
        assert isinstance(result, ProposedMutation)
        assert result.fields == {"status": "archived"}

    def test_default_reason_when_args_omitted(self) -> None:
        """The propose function falls back to ``cold_inactive`` when the
        caller forgot to pass a reason string — keeps the audit record's
        ``reason`` field non-empty even on misconfigured drivers."""

        async def _go() -> ProposedMutation | None:
            target = {"frontmatter": {"status": "open"}}
            return await propose_archival_sweep_cold(
                target=target,
                observed=_window(),
                args={},
            )

        result = asyncio.run(_go())
        assert isinstance(result, ProposedMutation)
        assert "cold_inactive" in result.reason
