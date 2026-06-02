"""Tests for FilesColdArchiveWorkflow + files_cold_archive activities.

The workflow runs daily at 03:00 LOCAL and drains all
``last_accessed_at`` >= 90 days files from the live volume into
ZSTD-compressed copies on the cold volume. ctrl-api owns the
compression + atomic SQL flip; the workflow is pure orchestration.

These tests cover:

  * Activities (``find_cold_candidates``, ``promote_to_cold``) in
    isolation with the httpx call stubbed at the transport level so
    no network I/O happens.
  * The workflow via ``WorkflowEnvironment.start_time_skipping()``
    with stub activities — exercises:
      - empty-candidate-list no-op
      - happy-path promotion across multiple files
      - per-entry try/except boundary on a failing promote
      - already-cold accounting (a no-op response is NOT counted as a
        new promotion)
      - aggregate bytes-saved + compression-ratio roll-up

Mirrors the discipline ``test_composio_reconnect_cleanup.py`` already
follows for the other Temporal-scheduled sweep.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any

import httpx
import pytest
from temporalio import activity
from temporalio.client import Client
from temporalio.testing import ActivityEnvironment, WorkflowEnvironment
from temporalio.worker import Worker

from src.activities.files_cold_archive import (
    find_cold_candidates,
    promote_to_cold,
)
from src.workflows.files_cold_archive import (
    DEFAULT_COLD_AFTER_MS,
    FilesColdArchiveResult,
    FilesColdArchiveWorkflow,
)


# ---------------------------------------------------------------------------
# Activity isolation tests — stub httpx so no network I/O happens.
# ---------------------------------------------------------------------------


class _StubTransport(httpx.AsyncBaseTransport):
    """Captures every request + returns the next queued response."""

    def __init__(self) -> None:
        self.queued: list[httpx.Response] = []
        self.requests: list[httpx.Request] = []

    def queue(
        self,
        status: int = 200,
        json_payload: dict[str, Any] | None = None,
    ) -> None:
        self.queued.append(
            httpx.Response(status, json=json_payload or {})
        )

    async def handle_async_request(  # type: ignore[override]
        self, request: httpx.Request,
    ) -> httpx.Response:
        self.requests.append(request)
        if not self.queued:
            return httpx.Response(500, json={"error": "no stub queued"})
        return self.queued.pop(0)


@pytest.fixture
def stub_transport(monkeypatch):
    """Patch httpx.AsyncClient to use a deterministic stub transport.

    Each test gets a fresh transport so cross-test interference is
    impossible.
    """
    transport = _StubTransport()

    real_init = httpx.AsyncClient.__init__

    def patched_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["transport"] = transport
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)
    monkeypatch.setenv("ALFRED_CTRL_URL", "http://stub-ctrl:3100")
    monkeypatch.setenv("AAS_API_KEY", "test-key")
    return transport


class TestFindColdCandidates:
    def test_returns_items_list(self, stub_transport):
        stub_transport.queue(
            200,
            {
                "cutoff_ms": 100,
                "older_than_ms": 90,
                "total": 2,
                "items": [
                    {"id": "01HF0000000000000000000001", "size_bytes": 1024},
                    {"id": "01HF0000000000000000000002", "size_bytes": 2048},
                ],
            },
        )
        env = ActivityEnvironment()
        items = asyncio.run(env.run(find_cold_candidates, 90))
        assert len(items) == 2
        assert items[0]["id"] == "01HF0000000000000000000001"
        # The bearer header was set from AAS_API_KEY.
        req = stub_transport.requests[0]
        assert req.headers.get("authorization") == "Bearer test-key"
        # The older_than_ms query parameter rode along.
        assert "older_than_ms=90" in str(req.url)

    def test_empty_items_returns_empty_list(self, stub_transport):
        stub_transport.queue(
            200, {"cutoff_ms": 0, "older_than_ms": 0, "total": 0, "items": []}
        )
        env = ActivityEnvironment()
        items = asyncio.run(env.run(find_cold_candidates, 1))
        assert items == []

    def test_5xx_bubbles_out(self, stub_transport):
        stub_transport.queue(503, {"error": "downstream broken"})
        env = ActivityEnvironment()
        with pytest.raises(httpx.HTTPStatusError):
            asyncio.run(env.run(find_cold_candidates, 1))


class TestPromoteToCold:
    def test_returns_payload(self, stub_transport):
        stub_transport.queue(
            200,
            {
                "id": "01HF0000000000000000000001",
                "sha256": "abc",
                "path": "cold:01HF0000000000000000000001",
                "cold_promoted_at": 12345,
                "live_bytes": 1024,
                "cold_bytes": 256,
                "compression_ratio": 4.0,
            },
        )
        env = ActivityEnvironment()
        resp = asyncio.run(
            env.run(promote_to_cold, "01HF0000000000000000000001")
        )
        assert resp["live_bytes"] == 1024
        assert resp["cold_bytes"] == 256
        assert resp["path"].startswith("cold:")
        # Path was built from the file_id.
        req = stub_transport.requests[0]
        assert "/api/v1/files/cold-promote/01HF0000000000000000000001" in str(
            req.url
        )

    def test_4xx_bubbles_out(self, stub_transport):
        stub_transport.queue(409, {"error": {"code": "TOMBSTONED"}})
        env = ActivityEnvironment()
        with pytest.raises(httpx.HTTPStatusError):
            asyncio.run(env.run(promote_to_cold, "tombstoned-id"))


# ---------------------------------------------------------------------------
# Workflow tests — stub activities so no httpx call happens at all.
# ---------------------------------------------------------------------------


_CALL_LOG: list[tuple[str, Any]] = []


def _reset_call_log() -> None:
    _CALL_LOG.clear()


def _make_stubs(
    *,
    candidates: list[dict[str, Any]],
    promote_outcomes: dict[str, dict[str, Any]] | None = None,
    promote_raises: set[str] | None = None,
):
    """Build a (find, promote) activity pair backed by deterministic stubs.

    ``promote_outcomes`` maps file_id → response dict; defaults to a
    happy 2x-ratio response.
    ``promote_raises`` is a set of file_ids the promote stub should
    raise for, to exercise the per-entry try/except.
    """
    promote_outcomes = promote_outcomes or {}
    promote_raises = promote_raises or set()

    @activity.defn(name="find_cold_candidates")
    async def stub_find(older_than_ms: int) -> list[dict[str, Any]]:
        _CALL_LOG.append(("find", older_than_ms))
        return list(candidates)

    @activity.defn(name="promote_to_cold")
    async def stub_promote(file_id: str) -> dict[str, Any]:
        _CALL_LOG.append(("promote", file_id))
        if file_id in promote_raises:
            raise RuntimeError(f"simulated failure for {file_id}")
        if file_id in promote_outcomes:
            return promote_outcomes[file_id]
        # Default: 2x ratio + 1KB cold.
        return {
            "id": file_id,
            "path": f"cold:{file_id}",
            "cold_promoted_at": 12345,
            "live_bytes": 2048,
            "cold_bytes": 1024,
            "compression_ratio": 2.0,
        }

    return [stub_find, stub_promote]


async def _run_workflow(
    stubs, older_than_ms: int = DEFAULT_COLD_AFTER_MS,
) -> FilesColdArchiveResult:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"files-cold-archive-test-{uuid.uuid4()}"
        worker = Worker(
            client,
            task_queue=tq,
            workflows=[FilesColdArchiveWorkflow],
            activities=stubs,
        )
        async with worker:
            result = await client.execute_workflow(
                FilesColdArchiveWorkflow.run,
                older_than_ms,
                id=f"files-cold-archive-run-{uuid.uuid4()}",
                task_queue=tq,
            )
    return result


class TestEmptyCandidates:
    def test_no_op(self):
        _reset_call_log()
        stubs = _make_stubs(candidates=[])
        result = asyncio.run(_run_workflow(stubs))
        assert result.candidates_total == 0
        assert result.promoted == []
        assert result.errors == []
        # Only the find call happened — no promote loop.
        verbs = [c[0] for c in _CALL_LOG]
        assert verbs == ["find"]


class TestHappyPath:
    def test_promotes_each_candidate_and_rolls_up_bytes(self):
        _reset_call_log()
        candidates = [
            {"id": "f-1", "size_bytes": 2048},
            {"id": "f-2", "size_bytes": 4096},
        ]
        promote_outcomes = {
            "f-1": {
                "id": "f-1",
                "path": "cold:f-1",
                "cold_promoted_at": 1,
                "live_bytes": 2048,
                "cold_bytes": 512,
                "compression_ratio": 4.0,
            },
            "f-2": {
                "id": "f-2",
                "path": "cold:f-2",
                "cold_promoted_at": 2,
                "live_bytes": 4096,
                "cold_bytes": 2048,
                "compression_ratio": 2.0,
            },
        }
        stubs = _make_stubs(
            candidates=candidates, promote_outcomes=promote_outcomes,
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.candidates_total == 2
        assert sorted(result.promoted) == ["f-1", "f-2"]
        assert result.live_bytes_freed == 2048 + 4096
        assert result.cold_bytes_written == 512 + 2048
        # Average compression ratio is 6144/2560 = 2.4x.
        ratio = result.compression_ratio
        assert ratio is not None
        assert abs(ratio - 2.4) < 0.01
        assert result.errors == []


class TestPerEntryFailureIsolation:
    def test_one_failed_promote_does_not_strand_the_others(self):
        _reset_call_log()
        candidates = [
            {"id": "f-good-1", "size_bytes": 1024},
            {"id": "f-bad", "size_bytes": 2048},
            {"id": "f-good-2", "size_bytes": 4096},
        ]
        stubs = _make_stubs(
            candidates=candidates,
            promote_raises={"f-bad"},
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.candidates_total == 3
        # Both good files promoted; the bad one is in errors but did
        # not poison the run.
        assert sorted(result.promoted) == ["f-good-1", "f-good-2"]
        assert len(result.errors) == 1
        assert "f-bad" in result.errors[0]


class TestAlreadyColdAccounting:
    def test_already_cold_is_not_counted_as_a_new_promotion(self):
        _reset_call_log()
        candidates = [
            {"id": "f-fresh", "size_bytes": 2048},
            {"id": "f-already", "size_bytes": 1024},
        ]
        promote_outcomes = {
            "f-already": {
                "id": "f-already",
                "path": "cold:f-already",
                "cold_promoted_at": 99,
                "already_cold": True,
            },
            "f-fresh": {
                "id": "f-fresh",
                "path": "cold:f-fresh",
                "cold_promoted_at": 100,
                "live_bytes": 2048,
                "cold_bytes": 1024,
                "compression_ratio": 2.0,
            },
        }
        stubs = _make_stubs(
            candidates=candidates, promote_outcomes=promote_outcomes,
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.promoted == ["f-fresh"]
        assert result.already_cold == ["f-already"]
        # Bytes accounting only includes the actually-promoted file.
        assert result.live_bytes_freed == 2048
        assert result.cold_bytes_written == 1024


class TestFindFailureShortCircuits:
    def test_find_failure_returns_with_an_error_no_promote_attempts(self):
        _reset_call_log()

        @activity.defn(name="find_cold_candidates")
        async def boom_find(older_than_ms: int) -> list[dict[str, Any]]:
            raise RuntimeError("simulated find failure")

        @activity.defn(name="promote_to_cold")
        async def stub_promote(file_id: str) -> dict[str, Any]:
            _CALL_LOG.append(("promote", file_id))
            return {}

        result = asyncio.run(_run_workflow([boom_find, stub_promote]))
        assert result.candidates_total == 0
        assert result.promoted == []
        assert any("find_cold_candidates failed" in e for e in result.errors)
        # No promote attempts after a find failure.
        assert [c for c in _CALL_LOG if c[0] == "promote"] == []


class TestThresholdPassThrough:
    def test_workflow_passes_older_than_ms_to_the_find_activity(self):
        _reset_call_log()
        stubs = _make_stubs(candidates=[])
        custom_threshold = 60 * 60 * 1000  # 1h
        asyncio.run(_run_workflow(stubs, older_than_ms=custom_threshold))
        # The find call sees the workflow's input verbatim.
        find_calls = [c for c in _CALL_LOG if c[0] == "find"]
        assert find_calls == [("find", custom_threshold)]
