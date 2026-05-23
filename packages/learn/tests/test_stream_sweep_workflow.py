"""Tests for StreamSweepWorkflow and the per-stream fan-out collapse (#53).

Issue #53 retired the per-stream ``al-stream-pull-*`` Temporal-schedule
fan-out (created/deleted by ctrl-api as streams were enabled/disabled)
and replaced it with a single ``al-stream-sweep`` schedule running
``StreamSweepWorkflow``. The sweep enumerates the enabled streams that
are due for a pull (via ``list_due_streams``) and runs the existing
per-stream pull body (``_run_stream_pull``) for each.

Two layers of coverage:

* Pure-function unit tests on the sweep's due-stream pre-filter helper
  (``_stream_pull_due``) — this decides which streams land in a sweep
  run.
* End-to-end workflow test through ``WorkflowEnvironment`` — the sweep
  runs against stub activities so a due stream is pulled and a bad
  stream does not sink the run, with no ctrl-api / Composio contact.

Stubbing strategy matches ``test_steward_sweep_workflow.py`` —
replacement activities under the same registered name via
``@activity.defn(name=...)``. The Composio pull path is used for the
end-to-end tests because it is the shortest activity chain
(``build_sync_args`` → ``composio_pull`` → ``ingest_events`` →
``update_cursor``).
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

from src.activities.pull import (
    _DEFAULT_STREAM_INTERVAL_SECONDS,
    _stream_pull_due,
)
from src.workflows.stream_puller import (
    SWEEP_STREAM_BATCH_LIMIT,
    StreamSweepResult,
    StreamSweepWorkflow,
)


# ---------------------------------------------------------------------------
# Pre-filter unit tests — which streams make the due list.
# ---------------------------------------------------------------------------


class TestStreamPullDue:
    """``_stream_pull_due`` — the interval gate ``list_due_streams`` uses."""

    def _now(self) -> datetime:
        return datetime(2026, 5, 19, 12, 0, 0, tzinfo=timezone.utc)

    def test_never_pulled_is_due(self):
        # Empty / missing last_pull_at → always due (first pull).
        assert _stream_pull_due(300, "", self._now()) is True
        assert _stream_pull_due(300, None, self._now()) is True

    def test_interval_not_yet_elapsed_is_not_due(self):
        # Pulled 60s ago, interval 300s → not due.
        last = (self._now() - timedelta(seconds=60)).isoformat()
        assert _stream_pull_due(300, last, self._now()) is False

    def test_interval_elapsed_is_due(self):
        # Pulled 400s ago, interval 300s → due.
        last = (self._now() - timedelta(seconds=400)).isoformat()
        assert _stream_pull_due(300, last, self._now()) is True

    def test_interval_exactly_elapsed_is_due(self):
        # >= is due — pulled exactly `interval` seconds ago.
        last = (self._now() - timedelta(seconds=300)).isoformat()
        assert _stream_pull_due(300, last, self._now()) is True

    def test_z_suffix_timestamp_is_parsed(self):
        last = (self._now() - timedelta(seconds=400)).isoformat().replace(
            "+00:00", "Z",
        )
        assert _stream_pull_due(300, last, self._now()) is True

    def test_naive_timestamp_treated_as_utc(self):
        # A naive ISO timestamp (no tz) is treated as UTC.
        last = (self._now() - timedelta(seconds=400)).replace(
            tzinfo=None,
        ).isoformat()
        assert _stream_pull_due(300, last, self._now()) is True

    def test_unparseable_timestamp_is_due(self):
        # A malformed cursor must never pin a stream out of the sweep.
        assert _stream_pull_due(300, "not-a-date", self._now()) is True

    def test_missing_interval_uses_default(self):
        # No interval → default 300s. Pulled 100s ago → not due,
        # pulled 400s ago → due.
        recent = (self._now() - timedelta(seconds=100)).isoformat()
        old = (self._now() - timedelta(seconds=400)).isoformat()
        assert _stream_pull_due(None, recent, self._now()) is False
        assert _stream_pull_due(None, old, self._now()) is True
        assert _DEFAULT_STREAM_INTERVAL_SECONDS == 300

    def test_zero_or_negative_interval_uses_default(self):
        old = (self._now() - timedelta(seconds=400)).isoformat()
        recent = (self._now() - timedelta(seconds=100)).isoformat()
        assert _stream_pull_due(0, recent, self._now()) is False
        assert _stream_pull_due(-5, old, self._now()) is True

    def test_non_numeric_interval_uses_default(self):
        old = (self._now() - timedelta(seconds=400)).isoformat()
        assert _stream_pull_due("garbage", old, self._now()) is True


# ---------------------------------------------------------------------------
# Workflow integration — the sweep fan-out.
# ---------------------------------------------------------------------------


def _make_stubs(
    *,
    due_streams: list[str],
    configs: dict[str, dict[str, Any]],
) -> tuple[list, dict[str, Any]]:
    """Replacement activities for one sweep run.

    ``due_streams`` is what ``list_due_streams`` returns. ``configs``
    maps a stream id → the config dict ``load_stream_config`` returns.
    The Composio pull activities are stubbed so a due stream runs the
    whole ``_run_stream_pull`` → ``_run_composio_pull`` chain without
    touching Composio.
    """
    state: dict[str, Any] = {
        "listed": False,
        "batch_limit": None,
        "loaded": [],
        "pulled": [],
        "cursor_updates": [],
    }

    @activity.defn(name="list_due_streams")
    async def stub_list_due(batch_limit: int = 100) -> list[str]:
        state["listed"] = True
        state["batch_limit"] = batch_limit
        return list(due_streams)

    @activity.defn(name="load_stream_config")
    async def stub_load_config(stream_id: str) -> dict[str, Any]:
        state["loaded"].append(stream_id)
        return dict(configs.get(stream_id, {}))

    @activity.defn(name="build_sync_args")
    async def stub_build_sync_args(
        action_slug: str, cursor_value: str, last_pull_at: str,
    ) -> dict[str, Any]:
        return {}

    @activity.defn(name="composio_pull")
    async def stub_composio_pull(
        action_slug: str,
        arguments: dict[str, Any] | None = None,
        connected_account_id: str | None = None,
        stream_id: str | None = None,
        stream_type: str | None = None,
        parser_name: str | None = None,
    ) -> dict[str, Any]:
        state["pulled"].append(action_slug)
        return {"data": {"items": [{"id": "evt-1"}]}}

    @activity.defn(name="ingest_events")
    async def stub_ingest(
        stream_id: str,
        stream_type: str,
        parser_name: str,
        raw_items: list[dict[str, Any]],
    ) -> dict[str, int]:
        return {"ingested": 1, "rejected": 0}

    @activity.defn(name="update_cursor")
    async def stub_update_cursor(
        stream_id: str, cursor_value: str, status: str = "ok",
    ) -> None:
        state["cursor_updates"].append((stream_id, status))

    return [
        stub_list_due,
        stub_load_config,
        stub_build_sync_args,
        stub_composio_pull,
        stub_ingest,
        stub_update_cursor,
    ], state


async def _run_sweep(stubs: list) -> StreamSweepResult:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"stream-sweep-test-{uuid.uuid4()}"
        worker = Worker(
            client,
            task_queue=tq,
            workflows=[StreamSweepWorkflow],
            activities=stubs,
        )
        async with worker:
            result = await client.execute_workflow(
                StreamSweepWorkflow.run,
                id=f"stream-sweep-run-{uuid.uuid4()}",
                task_queue=tq,
            )
    return result


def _composio_config(action: str = "GMAIL_FETCH_EMAILS") -> dict[str, Any]:
    """A minimal enabled Composio-backed stream config."""
    return {
        "enabled": True,
        "type": "composio",
        "composio_action": action,
        "parser": "composio",
    }


class TestStreamSweepWorkflow:
    """End-to-end sweep behaviour through WorkflowEnvironment."""

    def test_due_stream_is_pulled(self):
        """A due stream is loaded and its Composio action pulled."""
        stubs, state = _make_stubs(
            due_streams=["composio-gmail-gmail-fetch-emails"],
            configs={
                "composio-gmail-gmail-fetch-emails": _composio_config(),
            },
        )
        result = asyncio.run(_run_sweep(stubs))

        assert result.started is True
        assert result.streams_due == 1
        assert result.streams_processed == 1
        assert result.events_ingested == 1
        assert state["listed"] is True
        assert state["loaded"] == ["composio-gmail-gmail-fetch-emails"]
        assert state["pulled"] == ["GMAIL_FETCH_EMAILS"]
        assert state["cursor_updates"] == [
            ("composio-gmail-gmail-fetch-emails", "ok"),
        ]

    def test_multiple_streams_each_processed(self):
        """Every due stream the listing returns is swept in one run."""
        stubs, state = _make_stubs(
            due_streams=["s-a", "s-b", "s-c"],
            configs={
                "s-a": _composio_config("GMAIL_FETCH_EMAILS"),
                "s-b": _composio_config("SLACK_FETCH_CONVERSATION_HISTORY"),
                "s-c": _composio_config("GITHUB_LIST_NOTIFICATIONS"),
            },
        )
        result = asyncio.run(_run_sweep(stubs))

        assert result.streams_due == 3
        assert result.streams_processed == 3
        assert result.events_ingested == 3
        assert sorted(state["loaded"]) == ["s-a", "s-b", "s-c"]

    def test_disabled_stream_is_a_safe_noop(self):
        """A stream disabled between the listing and the pull is skipped.

        ``_run_stream_pull`` re-loads the config and re-checks
        ``enabled`` — a config that came back disabled is a no-op
        (``error="stream_disabled"``), no Composio call.
        """
        stubs, state = _make_stubs(
            due_streams=["s-disabled"],
            configs={"s-disabled": {"enabled": False, "type": "composio"}},
        )
        result = asyncio.run(_run_sweep(stubs))

        assert result.streams_due == 1
        # The stream is still "processed" (the loop ran the pull body),
        # but the body short-circuited — no Composio pull, no error.
        assert result.streams_processed == 1
        assert state["pulled"] == []
        assert result.errors == 0

    def test_empty_due_list_is_a_clean_noop(self):
        """No due streams → the sweep starts, lists, and finishes empty."""
        stubs, state = _make_stubs(due_streams=[], configs={})
        result = asyncio.run(_run_sweep(stubs))

        assert result.started is True
        assert result.streams_due == 0
        assert result.streams_processed == 0
        assert result.events_ingested == 0
        assert state["listed"] is True
        assert state["loaded"] == []

    def test_batch_limit_passed_to_listing_activity(self):
        """The sweep passes its batch cap to ``list_due_streams``."""
        stubs, state = _make_stubs(due_streams=[], configs={})
        asyncio.run(_run_sweep(stubs))
        assert state["batch_limit"] == SWEEP_STREAM_BATCH_LIMIT

    def test_one_bad_stream_does_not_sink_the_sweep(self):
        """A stream whose config load fails is recorded; others run.

        ``load_stream_config`` for the bad stream raises; the sweep's
        per-stream try/except records the error and continues to the
        next stream.
        """
        state: dict[str, Any] = {"pulled": []}

        @activity.defn(name="list_due_streams")
        async def stub_list_due(batch_limit: int = 100) -> list[str]:
            return ["s-bad", "s-good"]

        @activity.defn(name="load_stream_config")
        async def stub_load(stream_id: str) -> dict[str, Any]:
            if stream_id == "s-bad":
                raise RuntimeError("ctrl-api exploded")
            return _composio_config()

        @activity.defn(name="build_sync_args")
        async def stub_build_sync_args(
            action_slug: str, cursor_value: str, last_pull_at: str,
        ) -> dict[str, Any]:
            return {}

        @activity.defn(name="composio_pull")
        async def stub_composio_pull(
            action_slug: str,
            arguments: dict[str, Any] | None = None,
            connected_account_id: str | None = None,
            stream_id: str | None = None,
            stream_type: str | None = None,
            parser_name: str | None = None,
        ) -> dict[str, Any]:
            state["pulled"].append(action_slug)
            return {"data": {"items": []}}

        @activity.defn(name="ingest_events")
        async def stub_ingest(
            stream_id: str,
            stream_type: str,
            parser_name: str,
            raw_items: list[dict[str, Any]],
        ) -> dict[str, int]:
            return {"ingested": 0, "rejected": 0}

        @activity.defn(name="update_cursor")
        async def stub_update_cursor(
            stream_id: str, cursor_value: str, status: str = "ok",
        ) -> None:
            pass

        result = asyncio.run(_run_sweep([
            stub_list_due, stub_load, stub_build_sync_args,
            stub_composio_pull, stub_ingest, stub_update_cursor,
        ]))

        # The bad stream contributes >=1 error but the good stream still
        # ran end-to-end (its Composio action was pulled).
        assert result.streams_due == 2
        assert result.errors >= 1
        assert state["pulled"] == ["GMAIL_FETCH_EMAILS"]
        assert result.streams_processed == 1
