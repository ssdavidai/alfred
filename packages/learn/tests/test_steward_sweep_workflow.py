"""Tests for StewardSweepWorkflow and the per-matter fan-out collapse (#52).

Issue #52 retired the per-matter ``al-steward-<slug>`` Temporal-schedule
fan-out and replaced it with a single ``al-steward-sweep`` schedule
running ``StewardSweepWorkflow``. The sweep enumerates the matters with
due Steward work (via ``list_due_steward_matters``) and runs the
existing per-matter loop for each.

Two layers of coverage:

* Pure-function unit tests on the sweep's due-matter pre-filter helpers
  (``_next_check_elapsed`` / ``_task_is_terminal``) — these decide which
  matters land in a sweep run.
* End-to-end workflow test through ``WorkflowEnvironment`` — the sweep
  runs against stub activities so a due matter is evaluated and a
  not-yet-due matter is skipped, with no ctrl-api / clerk contact.

Stubbing strategy matches ``test_task_closure_workflow.py`` —
replacement activities under the same registered name via
``@activity.defn(name=...)``.
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from temporalio import activity
from temporalio.client import Client
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from src.activities.steward import _next_check_elapsed, _task_is_terminal
from src.workflows.steward import (
    SWEEP_MATTER_BATCH_LIMIT,
    StewardSweepResult,
    StewardSweepWorkflow,
)


# ---------------------------------------------------------------------------
# Pre-filter unit tests — which tasks make a matter "due".
# ---------------------------------------------------------------------------


class TestNextCheckElapsed:
    """``_next_check_elapsed`` — the cursor gate the sweep pre-filter uses."""

    def _now(self) -> datetime:
        return datetime(2026, 5, 19, 12, 0, 0, tzinfo=timezone.utc)

    def test_missing_cursor_is_due(self):
        assert _next_check_elapsed(None, self._now()) is True

    def test_empty_string_cursor_is_due(self):
        assert _next_check_elapsed("   ", self._now()) is True

    def test_past_cursor_is_due(self):
        assert _next_check_elapsed("2026-05-19T11:00:00Z", self._now()) is True

    def test_future_cursor_is_not_due(self):
        assert _next_check_elapsed("2026-05-19T13:00:00Z", self._now()) is False

    def test_exactly_now_is_due(self):
        assert _next_check_elapsed("2026-05-19T12:00:00Z", self._now()) is True

    def test_naive_timestamp_treated_as_utc(self):
        # No tz suffix — assumed UTC, one hour in the past → due.
        assert _next_check_elapsed("2026-05-19T11:00:00", self._now()) is True

    def test_unparseable_cursor_is_due(self):
        # A malformed cursor must never pin a task forever.
        assert _next_check_elapsed("not-a-date", self._now()) is True

    def test_datetime_object_future_not_due(self):
        future = self._now() + timedelta(hours=2)
        assert _next_check_elapsed(future, self._now()) is False


class TestTaskIsTerminal:
    """``_task_is_terminal`` — terminal tasks never make a matter due."""

    def test_done_is_terminal(self):
        assert _task_is_terminal({"state": "done"}) is True

    def test_archived_is_terminal(self):
        assert _task_is_terminal({"state": "Archived"}) is True

    def test_open_is_not_terminal(self):
        assert _task_is_terminal({"state": "open"}) is False

    def test_missing_state_is_not_terminal(self):
        assert _task_is_terminal({}) is False


# ---------------------------------------------------------------------------
# Workflow integration — the sweep fan-out.
# ---------------------------------------------------------------------------


def _make_stubs(
    *,
    due_matters: list[str],
    matter_tasks: dict[str, list[dict[str, Any]]],
) -> tuple[list, dict[str, Any]]:
    """Replacement activities for one sweep run.

    ``due_matters`` is what ``list_due_steward_matters`` returns.
    ``matter_tasks`` maps a matter id → the task list
    ``load_matter_tasks`` returns for it. ``evaluate_task`` /
    ``record_steward_check`` / ``update_matter_cadence`` are recorded so
    the test can assert which matters were actually evaluated.
    """
    state: dict[str, Any] = {
        "listed": False,
        "loaded_matters": [],
        "evaluated_tasks": [],
        "recorded_tasks": [],
        "cadence_matters": [],
    }

    @activity.defn(name="list_due_steward_matters")
    async def stub_list_due(batch_limit: int = 200) -> list[str]:
        state["listed"] = True
        state["batch_limit"] = batch_limit
        return list(due_matters)

    @activity.defn(name="load_matter_tasks")
    async def stub_load_tasks(matter_id: str) -> list[dict[str, Any]]:
        state["loaded_matters"].append(matter_id)
        return list(matter_tasks.get(matter_id, []))

    @activity.defn(name="evaluate_task")
    async def stub_evaluate(
        task_id: str, task_data: dict[str, Any],
    ) -> dict[str, Any]:
        state["evaluated_tasks"].append(task_id)
        return {"signals_summary": {"count": 0}}

    @activity.defn(name="record_steward_check")
    async def stub_record(task_id: str, outcome: dict[str, Any]) -> None:
        state["recorded_tasks"].append(task_id)

    @activity.defn(name="update_matter_cadence")
    async def stub_cadence(
        matter_id: str, had_signal: bool,
    ) -> dict[str, Any]:
        state["cadence_matters"].append(matter_id)
        return {
            "matter_id": matter_id,
            "no_signal_streak": 1,
            "cadence_seconds": 1800,
            "transitioned": False,
        }

    return [
        stub_list_due,
        stub_load_tasks,
        stub_evaluate,
        stub_record,
        stub_cadence,
    ], state


async def _run_sweep(stubs: list) -> StewardSweepResult:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"steward-sweep-test-{uuid.uuid4()}"
        worker = Worker(
            client,
            task_queue=tq,
            workflows=[StewardSweepWorkflow],
            activities=stubs,
        )
        async with worker:
            result = await client.execute_workflow(
                StewardSweepWorkflow.run,
                id=f"steward-sweep-run-{uuid.uuid4()}",
                task_queue=tq,
            )
    return result


def _task(slug: str, *, next_check_after: Any = None, state: str = "open") -> dict[str, Any]:
    fm: dict[str, Any] = {"state": state}
    if next_check_after is not None:
        fm["next_check_after"] = next_check_after
    return {"id": slug, "path": f"task/{slug}.md", "frontmatter": fm}


class TestStewardSweepWorkflow:
    """End-to-end sweep behaviour through WorkflowEnvironment."""

    def test_due_matter_is_evaluated(self):
        """A matter with a due task is loaded and its task evaluated."""
        stubs, state = _make_stubs(
            due_matters=["matter/acme.md"],
            matter_tasks={
                "matter/acme.md": [
                    _task("acme-task-1", next_check_after=None),
                ],
            },
        )
        result = asyncio.run(_run_sweep(stubs))

        assert result.started is True
        assert result.matters_due == 1
        assert result.matters_processed == 1
        assert result.tasks_evaluated == 1
        assert state["listed"] is True
        assert state["loaded_matters"] == ["matter/acme.md"]
        assert state["evaluated_tasks"] == ["acme-task-1"]
        assert state["recorded_tasks"] == ["acme-task-1"]

    def test_not_yet_due_task_is_skipped(self):
        """A matter whose only task has a future cursor evaluates nothing.

        The matter is still loaded (the sweep processes every matter the
        listing returned), but the per-task ``next_check_after`` gate is
        the authoritative second check — a future cursor → skipped, no
        ``evaluate_task`` call.
        """
        future = (
            datetime.now(timezone.utc) + timedelta(days=1)
        ).isoformat()
        stubs, state = _make_stubs(
            due_matters=["matter/quiet.md"],
            matter_tasks={
                "matter/quiet.md": [
                    _task("quiet-task-1", next_check_after=future),
                ],
            },
        )
        result = asyncio.run(_run_sweep(stubs))

        assert result.matters_processed == 1
        assert result.tasks_evaluated == 0
        assert result.tasks_skipped == 1
        assert state["evaluated_tasks"] == []

    def test_terminal_task_is_skipped(self):
        """A done/archived task is skipped even with an elapsed cursor."""
        stubs, state = _make_stubs(
            due_matters=["matter/closed.md"],
            matter_tasks={
                "matter/closed.md": [
                    _task("closed-task-1", next_check_after=None, state="done"),
                ],
            },
        )
        result = asyncio.run(_run_sweep(stubs))

        assert result.tasks_evaluated == 0
        assert result.tasks_skipped == 1
        assert state["evaluated_tasks"] == []

    def test_multiple_matters_each_processed(self):
        """Every due matter the listing returns is swept in one run."""
        stubs, state = _make_stubs(
            due_matters=["matter/a.md", "matter/b.md", "matter/c.md"],
            matter_tasks={
                "matter/a.md": [_task("a1", next_check_after=None)],
                "matter/b.md": [_task("b1", next_check_after=None)],
                "matter/c.md": [_task("c1", next_check_after=None)],
            },
        )
        result = asyncio.run(_run_sweep(stubs))

        assert result.matters_due == 3
        assert result.matters_processed == 3
        assert result.tasks_evaluated == 3
        assert sorted(state["loaded_matters"]) == [
            "matter/a.md", "matter/b.md", "matter/c.md",
        ]

    def test_empty_due_list_is_a_clean_noop(self):
        """No due matters → the sweep starts, lists, and finishes empty."""
        stubs, state = _make_stubs(due_matters=[], matter_tasks={})
        result = asyncio.run(_run_sweep(stubs))

        assert result.started is True
        assert result.matters_due == 0
        assert result.matters_processed == 0
        assert result.tasks_evaluated == 0
        assert state["listed"] is True
        assert state["loaded_matters"] == []

    def test_batch_limit_passed_to_listing_activity(self):
        """The sweep passes its batch cap to ``list_due_steward_matters``."""
        stubs, state = _make_stubs(due_matters=[], matter_tasks={})
        asyncio.run(_run_sweep(stubs))
        assert state["batch_limit"] == SWEEP_MATTER_BATCH_LIMIT

    def test_one_bad_matter_does_not_sink_the_sweep(self):
        """A matter whose load fails is recorded as an error; others run.

        ``load_matter_tasks`` for the bad matter raises; the sweep's
        per-matter try/except records the error and continues to the
        next matter.
        """
        state: dict[str, Any] = {"evaluated": []}

        @activity.defn(name="list_due_steward_matters")
        async def stub_list_due(batch_limit: int = 200) -> list[str]:
            return ["matter/bad.md", "matter/good.md"]

        @activity.defn(name="load_matter_tasks")
        async def stub_load(matter_id: str) -> list[dict[str, Any]]:
            if matter_id == "matter/bad.md":
                raise RuntimeError("ctrl-api exploded")
            return [_task("good-1", next_check_after=None)]

        @activity.defn(name="evaluate_task")
        async def stub_evaluate(
            task_id: str, task_data: dict[str, Any],
        ) -> dict[str, Any]:
            state["evaluated"].append(task_id)
            return {"signals_summary": {"count": 0}}

        @activity.defn(name="record_steward_check")
        async def stub_record(task_id: str, outcome: dict[str, Any]) -> None:
            pass

        @activity.defn(name="update_matter_cadence")
        async def stub_cadence(
            matter_id: str, had_signal: bool,
        ) -> dict[str, Any]:
            return {"no_signal_streak": 0, "cadence_seconds": 1800}

        result = asyncio.run(_run_sweep([
            stub_list_due, stub_load, stub_evaluate, stub_record, stub_cadence,
        ]))

        # The bad matter contributes >=1 error but the good matter still
        # ran end-to-end.
        assert result.matters_due == 2
        assert result.errors >= 1
        assert state["evaluated"] == ["good-1"]
        assert result.tasks_evaluated == 1
