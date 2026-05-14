"""Unit tests for ``state_mutator.apply_state_change_v2`` — Phase A
(spec §14, six cases).

The mutator's ctrl-api round-trip is mocked at the ``httpx.AsyncClient``
factory layer using ``httpx.MockTransport`` so we exercise the full
request envelope construction (URL, auth header, JSON body) without
needing a live ctrl-api on :3100. VaultClient.read_record (the
``read_target`` activity reads through it) is patched with an
in-process fake so the read-reason-write cycle deterministically
returns the prior frontmatter we set per case.

All six cases the spec calls out:

  1. Read-reason-write happy path.
  2. Propose returns None → no POST, applied=False.
  3. 409 then 200 → retried_count=1, applied=True.
  4. 409 three times → MutatorContentionError, retried_count=3.
  5. Caller mode=live, env STEWARD_LIVE_MODE=shadow → effective_mode=shadow.
  6. mode=live + env=live_high_confidence_only + confidence=0.5 (<0.85)
     → pending_confirmation=True in the POST body's fields,
     applied=True, audit_record_path is set.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from unittest.mock import patch

import httpx
import pytest

from src.activities import state_mutator as sm
from src.activities.state_mutator import (
    MutatorContentionError,
    MutationResult,
    ObservedWindow,
    ProposedMutation,
    apply_state_change_v2,
    propose_fn,
)


# ---------------------------------------------------------------------------
# Fake VaultClient — patched onto state_mutator.VaultClient. Only
# ``read_record`` + ``close`` are exercised by ``read_target``.
# ---------------------------------------------------------------------------


class FakeVaultClient:
    def __init__(
        self,
        frontmatter: dict[str, Any] | None = None,
        body: str = "",
    ) -> None:
        # ``frontmatter_sequence`` lets a test inject different prior FM
        # on successive reads (used by the 409-retry cases — the server
        # sees a new ``as_of`` after the race resolves). When set, each
        # ``read_record`` pops the next snapshot.
        self._fm_default = frontmatter or {}
        self._body = body
        self.frontmatter_sequence: list[dict[str, Any]] | None = None
        self.read_calls: list[str] = []

    async def close(self) -> None:
        pass

    async def read_record(self, path: str) -> dict[str, Any]:
        self.read_calls.append(path)
        if self.frontmatter_sequence:
            fm = self.frontmatter_sequence.pop(0)
        else:
            fm = dict(self._fm_default)
        return {"frontmatter": fm, "body": self._body}


@pytest.fixture
def fake_vault_factory():
    """Patch VaultClient on state_mutator with a captured fake."""

    def _make(**kwargs: Any) -> tuple[FakeVaultClient, Any]:
        fake = FakeVaultClient(**kwargs)
        ctx = patch("src.activities.state_mutator.VaultClient", return_value=fake)
        ctx.start()
        return fake, ctx

    return _make


# ---------------------------------------------------------------------------
# Fake ctrl-api transport — scripted responses with full request capture.
# ---------------------------------------------------------------------------


class ScriptedTransport(httpx.AsyncBaseTransport):
    """Replay a list of canned responses against incoming requests.

    Each entry is either an ``httpx.Response`` (returned verbatim) or a
    callable ``(request) -> Response`` for tests that need to inspect
    the envelope before deciding what to return. The transport captures
    every request for post-test assertions.
    """

    def __init__(
        self, script: list[httpx.Response | Any]
    ) -> None:
        self.script = list(script)
        self.requests: list[httpx.Request] = []

    async def handle_async_request(
        self, request: httpx.Request
    ) -> httpx.Response:
        self.requests.append(request)
        if not self.script:
            raise AssertionError(
                f"ScriptedTransport: no more responses; request was "
                f"{request.method} {request.url}"
            )
        entry = self.script.pop(0)
        if callable(entry):
            return entry(request)
        return entry


@pytest.fixture
def install_transport():
    """Install a ScriptedTransport into the httpx.AsyncClient that
    ``apply_state_change_v2`` builds for the /state-changes POST."""

    transports: list[ScriptedTransport] = []

    def _install(*responses: httpx.Response) -> ScriptedTransport:
        transport = ScriptedTransport(list(responses))
        transports.append(transport)
        return transport

    real_async_client = httpx.AsyncClient
    captured: dict[str, ScriptedTransport] = {}

    def _factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        # Inject our transport into the next AsyncClient construction.
        # Tests that exercise multiple AsyncClient builds (e.g. retry)
        # rely on a single transport handling the whole sequence; each
        # test creates one transport via ``transport = install(...)``
        # and we re-use it across the AsyncClient constructions made by
        # ``_post_state_change``.
        if transports:
            kwargs["transport"] = transports[0]
        return real_async_client(*args, **kwargs)

    ctx = patch("src.activities.state_mutator.httpx.AsyncClient", _factory)
    ctx.start()
    yield _install
    ctx.stop()


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _observed() -> ObservedWindow:
    start = datetime(2026, 5, 12, 18, 0, 0, tzinfo=timezone.utc)
    end = datetime(2026, 5, 13, 7, 0, 0, tzinfo=timezone.utc)
    return ObservedWindow(
        start=start,
        end=end,
        signal_paths=["signal/s1.md"],
        decision_paths=["decision/d1.md"],
        other_refs=[],
    )


def _ok_response(
    *,
    audit_record_path: str = "event/state-change-test.md",
    timeline_entry_id: str = "01HXYZABC",
    new_as_of: str = "2026-05-13T07:00:14Z",
) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "audit_record_path": audit_record_path,
            "timeline_entry_id": timeline_entry_id,
            "new_as_of": new_as_of,
        },
    )


def _conflict_response(
    current_as_of: str = "2026-05-13T07:01:00Z",
) -> httpx.Response:
    return httpx.Response(
        409,
        json={"error": "as_of_mismatch", "current_as_of": current_as_of},
    )


# Register all propose functions used by the tests under names the
# tests reference. Each registration is idempotent (decorator de-dupes)
# so re-import in a hot test runner doesn't fail.

_PROPOSE_CALLS: list[dict[str, Any]] = []


@propose_fn("test.propose_change")
async def _propose_change(
    *, target: dict[str, Any], observed: ObservedWindow, args: dict[str, Any]
) -> ProposedMutation | None:
    _PROPOSE_CALLS.append({"target": target, "args": args})
    return ProposedMutation(
        fields={
            "current_state": "New state paragraph.",
            "as_of": "2026-05-13T07:00:14Z",
            "status": "active",
        },
        reason="three signals about the property listing",
        confidence=args.get("confidence", 0.92),
        fan_out=tuple(args.get("fan_out", ())),
    )


@propose_fn("test.propose_none")
async def _propose_none(
    *, target: dict[str, Any], observed: ObservedWindow, args: dict[str, Any]
) -> ProposedMutation | None:
    _PROPOSE_CALLS.append({"target": target, "args": args, "verdict": "none"})
    return None


@pytest.fixture(autouse=True)
def _clear_propose_history():
    _PROPOSE_CALLS.clear()
    yield


# ---------------------------------------------------------------------------
# Case 1 — happy path
# ---------------------------------------------------------------------------


async def test_happy_path_writes_audit_and_returns_result(
    fake_vault_factory, install_transport, monkeypatch
):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    monkeypatch.setenv("AAS_API_KEY", "secret-key")
    fake, ctx = fake_vault_factory(
        frontmatter={
            "as_of": "2026-05-12T18:00:02Z",
            "status": "dormant",
            "current_state": "prior paragraph",
        }
    )
    transport = install_transport(_ok_response())
    try:
        result = await apply_state_change_v2(
            target_path="matter/property-listing.md",
            source="briefing.morning",
            observed=_observed(),
            propose_fn_name="test.propose_change",
            propose_fn_args={"confidence": 0.92},
            mode="live",
            expected_as_of="2026-05-12T18:00:02Z",
        )
    finally:
        ctx.stop()

    assert isinstance(result, MutationResult)
    assert result.applied is True
    assert result.mode == "live"
    assert result.effective_mode == "live"
    assert result.pending_confirmation is False
    assert result.retried_count == 0
    assert result.audit_record_path == "event/state-change-test.md"
    assert result.timeline_entry_id == "01HXYZABC"
    assert result.new_as_of == "2026-05-13T07:00:14Z"
    assert result.prior_as_of == "2026-05-12T18:00:02Z"

    # One POST to /api/v1/state-changes with the expected envelope.
    assert len(transport.requests) == 1
    req = transport.requests[0]
    assert req.method == "POST"
    assert req.url.path == "/api/v1/state-changes"
    assert req.headers.get("authorization") == "Bearer secret-key"
    envelope = json.loads(req.content.decode("utf-8"))
    assert envelope["target_path"] == "matter/property-listing.md"
    assert envelope["source"] == "briefing.morning"
    assert envelope["expected_as_of"] == "2026-05-12T18:00:02Z"
    assert envelope["mode"] == "live"
    assert envelope["confidence"] == 0.92
    assert envelope["fields"]["current_state"] == "New state paragraph."
    assert envelope["fields"]["status"] == "active"
    assert envelope["fields"]["as_of"] == "2026-05-13T07:00:14Z"
    assert "pending_confirmation" not in envelope["fields"]
    assert "undo_recipe" in envelope
    assert envelope["undo_recipe"]["vault_patch"]["target_path"] == (
        "matter/property-listing.md"
    )
    # Undo recipe captures prior values for every changed field.
    revert = envelope["undo_recipe"]["vault_patch"]["revert_fields"]
    assert revert["current_state"] == "prior paragraph"
    assert revert["status"] == "dormant"
    assert revert["as_of"] == "2026-05-12T18:00:02Z"


# ---------------------------------------------------------------------------
# Case 2 — propose returns None
# ---------------------------------------------------------------------------


async def test_propose_returns_none_skips_post(
    fake_vault_factory, install_transport
):
    fake, ctx = fake_vault_factory(
        frontmatter={"as_of": "2026-05-12T18:00:02Z", "status": "dormant"}
    )
    transport = install_transport()  # no responses queued — POST would fail
    try:
        result = await apply_state_change_v2(
            target_path="matter/health.md",
            source="briefing.morning",
            observed=_observed(),
            propose_fn_name="test.propose_none",
            propose_fn_args={},
            mode="shadow",
        )
    finally:
        ctx.stop()

    assert result.applied is False
    assert result.audit_record_path is None
    assert result.timeline_entry_id is None
    assert result.retried_count == 0
    assert result.fan_out_triggered == []
    assert transport.requests == []  # no POST


# ---------------------------------------------------------------------------
# Case 3 — 409 then 200
# ---------------------------------------------------------------------------


async def test_409_retries_then_succeeds(
    fake_vault_factory, install_transport, monkeypatch
):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    fake, ctx = fake_vault_factory()
    # Server's as_of changes between attempts (the race the 409 reports).
    fake.frontmatter_sequence = [
        {"as_of": "2026-05-12T18:00:02Z", "status": "dormant"},
        {"as_of": "2026-05-13T07:01:00Z", "status": "dormant"},
    ]
    transport = install_transport(
        _conflict_response("2026-05-13T07:01:00Z"),
        _ok_response(new_as_of="2026-05-13T07:02:00Z"),
    )
    try:
        result = await apply_state_change_v2(
            target_path="matter/property-listing.md",
            source="briefing.morning",
            observed=_observed(),
            propose_fn_name="test.propose_change",
            propose_fn_args={"confidence": 0.92},
            mode="live",
            expected_as_of="2026-05-12T18:00:02Z",
        )
    finally:
        ctx.stop()

    assert result.applied is True
    assert result.retried_count == 1
    assert result.new_as_of == "2026-05-13T07:02:00Z"
    assert len(transport.requests) == 2
    # Second envelope's expected_as_of is the server-reported value.
    env2 = json.loads(transport.requests[1].content.decode("utf-8"))
    assert env2["expected_as_of"] == "2026-05-13T07:01:00Z"


# ---------------------------------------------------------------------------
# Case 4 — 409 three times → contention error
# ---------------------------------------------------------------------------


async def test_409_exhausted_raises(
    fake_vault_factory, install_transport, monkeypatch
):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    fake, ctx = fake_vault_factory(
        frontmatter={"as_of": "2026-05-12T18:00:02Z", "status": "dormant"}
    )
    transport = install_transport(
        _conflict_response("2026-05-13T07:01:00Z"),
        _conflict_response("2026-05-13T07:02:00Z"),
        _conflict_response("2026-05-13T07:03:00Z"),
    )
    try:
        with pytest.raises(MutatorContentionError) as excinfo:
            await apply_state_change_v2(
                target_path="matter/property-listing.md",
                source="briefing.morning",
                observed=_observed(),
                propose_fn_name="test.propose_change",
                propose_fn_args={"confidence": 0.92},
                mode="live",
                expected_as_of="2026-05-12T18:00:02Z",
            )
    finally:
        ctx.stop()
    assert len(transport.requests) == 3
    assert "2026-05-13T07:03:00Z" in str(excinfo.value)


# ---------------------------------------------------------------------------
# Case 5 — env shadow downgrades caller live → effective shadow
# ---------------------------------------------------------------------------


async def test_env_shadow_downgrades_live(
    fake_vault_factory, install_transport, monkeypatch
):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "shadow")
    fake, ctx = fake_vault_factory(
        frontmatter={"as_of": "2026-05-12T18:00:02Z", "status": "dormant"}
    )
    transport = install_transport(_ok_response())
    try:
        result = await apply_state_change_v2(
            target_path="matter/property-listing.md",
            source="briefing.morning",
            observed=_observed(),
            propose_fn_name="test.propose_change",
            propose_fn_args={"confidence": 0.92},
            mode="live",
        )
    finally:
        ctx.stop()

    assert result.mode == "live"
    assert result.effective_mode == "shadow"
    assert result.pending_confirmation is False
    # The envelope sent to ctrl-api carries the effective_mode so the
    # server can decide whether to expose this as a Desk action.
    env = json.loads(transport.requests[0].content.decode("utf-8"))
    assert env["mode"] == "shadow"


# ---------------------------------------------------------------------------
# Case 6 — sub-threshold live HC-only writes land as pending_confirmation
# ---------------------------------------------------------------------------


async def test_subthreshold_live_marks_pending_confirmation(
    fake_vault_factory, install_transport, monkeypatch
):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live_high_confidence_only")
    fake, ctx = fake_vault_factory(
        frontmatter={"as_of": "2026-05-12T18:00:02Z", "status": "dormant"}
    )
    transport = install_transport(_ok_response())
    try:
        result = await apply_state_change_v2(
            target_path="matter/property-listing.md",
            source="briefing.morning",
            observed=_observed(),
            propose_fn_name="test.propose_change",
            propose_fn_args={"confidence": 0.50},  # below 0.85 threshold
            mode="live",
        )
    finally:
        ctx.stop()

    assert result.applied is True
    assert result.effective_mode == "live"
    assert result.pending_confirmation is True
    assert result.audit_record_path == "event/state-change-test.md"
    env = json.loads(transport.requests[0].content.decode("utf-8"))
    assert env["mode"] == "live"
    assert env["fields"]["pending_confirmation"] is True
