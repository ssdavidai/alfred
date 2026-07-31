"""Consumer half of the ingest dead-letter loop (#311).

ctrl-api owns the retry budget, but nothing bounds anything unless the
consumer actually *reports* its failures. Before this, a failed extraction
just skipped `mark_stream_event_processed`, so the event returned on the
pending feed every tick — forever. Three IDs cycled ~20 times each.
"""
from __future__ import annotations

import httpx
import pytest

from src.activities import signals as sig


class _Resp:
    def __init__(self, payload: dict, status: int = 200) -> None:
        self._payload = payload
        self.status_code = status
        self.content = b"x"

    def json(self) -> dict:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            req = httpx.Request("POST", "http://ctrl/x")
            raise httpx.HTTPStatusError(
                str(self.status_code), request=req,
                response=httpx.Response(self.status_code, request=req),
            )


class _Client:
    """Captures the outbound report instead of making it."""

    def __init__(self, payload: dict | None = None, status: int = 200) -> None:
        self._payload = payload or {"failure_count": 1, "dead_lettered": False}
        self._status = status
        self.calls: list[tuple[str, dict]] = []

    async def __aenter__(self) -> "_Client":
        return self

    async def __aexit__(self, *_exc) -> bool:
        return False

    async def post(self, url: str, json: dict | None = None):
        self.calls.append((url, json or {}))
        return _Resp(self._payload, self._status)


@pytest.fixture
def patch_client(monkeypatch):
    holder: dict[str, _Client] = {}

    def install(payload=None, status=200):
        client = _Client(payload, status)
        holder["c"] = client
        monkeypatch.setattr(
            sig.httpx, "AsyncClient", lambda *a, **k: client
        )
        return client

    return install


async def test_reports_retryable_failure_with_event_id(patch_client):
    client = patch_client({"failure_count": 2, "dead_lettered": False})

    out = await sig.report_ingest_event_failure(
        "ingest:01ABCDEF", "Unknown source_type='unknown'", "retryable"
    )

    assert out["reported"] is True
    assert out["dead_lettered"] is False
    assert out["failure_count"] == 2

    url, body = client.calls[0]
    assert url == "/api/v1/ingest/events/01ABCDEF/failure"
    assert body["error_class"] == "retryable"
    assert body["source"] == "signal_extract"
    assert "Unknown source_type" in body["error"]


async def test_surfaces_dead_letter_verdict(patch_client):
    patch_client({"failure_count": 5, "dead_lettered": True})
    out = await sig.report_ingest_event_failure("ingest:01XYZ", "boom", "retryable")
    assert out["dead_lettered"] is True
    assert out["failure_count"] == 5


async def test_non_retryable_is_passed_through(patch_client):
    client = patch_client({"failure_count": 1, "dead_lettered": True})
    await sig.report_ingest_event_failure("ingest:01Q", "bad schema", "non_retryable")
    assert client.calls[0][1]["error_class"] == "non_retryable"


async def test_unknown_error_class_defaults_to_retryable(patch_client):
    """A typo must not silently dead-letter an event on its first failure."""
    client = patch_client()
    await sig.report_ingest_event_failure("ingest:01Q", "x", "banana")
    assert client.calls[0][1]["error_class"] == "retryable"


@pytest.mark.parametrize("path", ["", None, "signal/foo.md", "vault/stream_event/x.md"])
async def test_non_ingest_refs_are_a_noop(patch_client, path):
    """Legacy vault-path events have no ingest row to report against."""
    client = patch_client()
    out = await sig.report_ingest_event_failure(path, "x", "retryable")
    assert out == {"reported": False, "dead_lettered": False, "failure_count": 0}
    assert client.calls == []


async def test_report_failure_never_raises(patch_client):
    """An older ctrl-api has no /failure route. That is the pre-#311
    behaviour, not a new failure mode — it must not escalate a handled
    extraction failure into a workflow error."""
    patch_client({}, status=404)
    out = await sig.report_ingest_event_failure("ingest:01Q", "x", "retryable")
    assert out["reported"] is False


def test_workflow_gates_the_new_activity_call():
    """Adding an activity call to a deployed workflow is non-additive for
    history replay — packages/learn/CLAUDE.md requires workflow.patched()."""
    import inspect

    from src.workflows import signals as wf

    src = inspect.getsource(wf)
    assert "report_ingest_event_failure" in src
    assert 'workflow.patched("signal_extract_dead_letter_v1")' in src
    # and the classification must default to retryable
    assert "_NON_RETRYABLE_EXTRACT_ERRORS" in src
