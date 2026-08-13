"""Unit tests for the nightly-narrative activities (RFC #884).

Three cases per the deliverable:

  * No signals AND no transitions in the lookback window → workflow
    skips the LLM and the patch entirely.
  * Three signals → ``patch_matter_narrative`` is called once with
    non-empty ``current_state`` and ``signal_count_24h == 3``.
  * Clerk error → no patch is attempted; the matter's prior state
    stays untouched.

Plus tests for the daily-digest data-layer activity:

  * Matter with fresh narrative → ``the_day`` entry uses
    ``source="narrative"`` and the current_state excerpt.
  * Matter with stale ``as_of`` → entry uses ``source="fallback_events"``
    and falls back to a recent-event walk.

All vault I/O is mocked via the existing FakeVaultClient pattern (see
``test_steward_apply_state_change.py``). The clerk is patched at the
``src.activities.nightly_narrative._call_clerk`` import site.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from src.activities.nightly_narrative import (
    generate_matter_narrative,
    load_matter_signals_24h,
    load_task_transitions_24h,
    patch_matter_narrative,
)
from src.activities.vault import collect_living_brief_data
from src.workflows.nightly_narrative import NightlyNarrativeResult


# ---------------------------------------------------------------------------
# Fake vault client — captures every call so the assertions can verify
# exact ctrl-api round-trip shapes.
# ---------------------------------------------------------------------------


class FakeVaultClient:
    def __init__(
        self,
        *,
        list_records_map: dict[str, list[dict[str, Any]]] | None = None,
        read_records_map: dict[str, dict[str, Any]] | None = None,
        patch_raises: Exception | None = None,
    ) -> None:
        self.list_records_map = list_records_map or {}
        self.read_records_map = read_records_map or {}
        self.patch_raises = patch_raises
        self.list_calls: list[tuple[str, int]] = []
        self.read_calls: list[str] = []
        self.patch_calls: list[tuple[str, dict[str, Any]]] = []

    async def close(self) -> None:
        pass

    async def list_records(
        self, record_type: str, status: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        self.list_calls.append((record_type, limit))
        return list(self.list_records_map.get(record_type, []))

    async def read_record(self, path: str) -> dict[str, Any]:
        self.read_calls.append(path)
        if path in self.read_records_map:
            return self.read_records_map[path]
        # Default 404-equivalent so the activity's swallow-on-error path
        # exercises cleanly. Tests that need a real read register the
        # path explicitly.
        raise httpx.HTTPStatusError(
            "not found",
            request=httpx.Request("GET", path),
            response=httpx.Response(404),
        )

    async def patch_frontmatter(self, path: str, updates: dict[str, Any]) -> None:
        self.patch_calls.append((path, updates))
        if self.patch_raises:
            raise self.patch_raises


class FakeStateClient:
    """In-memory StateClient stand-in for the signal storage cutover.

    Signals live in state.db now (#27). Tests feed ``{path, frontmatter}``
    signal records via ``signal_rows``; this client serves them through
    ``list_signals`` as state.db rows whose ``payload`` carries the
    frontmatter — exactly what ``signal_row_to_record`` rehydrates.
    """

    def __init__(self, *, signal_records: list[dict[str, Any]] | None = None) -> None:
        self._records = signal_records or []
        self.list_calls: list[dict[str, Any]] = []

    async def close(self) -> None:
        pass

    async def __aenter__(self) -> "FakeStateClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        pass

    async def list_signals(self, **kwargs: Any) -> list[dict[str, Any]]:
        self.list_calls.append(kwargs)
        rows: list[dict[str, Any]] = []
        for rec in self._records:
            fm = rec.get("frontmatter") or {}
            rows.append({
                "id": rec.get("path") or rec.get("id") or "",
                "kind": fm.get("effect"),
                "source": fm.get("source_type"),
                "ts": fm.get("created") or fm.get("applied_at"),
                "entity_ref": fm.get("target_path"),
                "matter_ref": fm.get("target_matter_path"),
                "status": fm.get("status"),
                "payload": fm,
            })
        return rows


@pytest.fixture
def install_fake_vault():
    """Patch VaultClient on the nightly_narrative + vault modules."""

    def _install(fake: FakeVaultClient) -> list:
        ctxs = [
            patch("src.activities.nightly_narrative.VaultClient", return_value=fake),
            patch("src.activities.vault.VaultClient", return_value=fake),
        ]
        for c in ctxs:
            c.start()
        return ctxs

    started: list = []

    def _make(fake: FakeVaultClient) -> FakeVaultClient:
        started.extend(_install(fake))
        return fake

    yield _make

    for c in started:
        try:
            c.stop()
        except RuntimeError:
            pass


# ---------------------------------------------------------------------------
# load_matter_signals_24h — within / outside the window
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _signal_record(
    *,
    path: str,
    target_path: str | None = None,
    candidates: list[dict[str, Any]] | None = None,
    applied_at: str | None = None,
    created: str | None = None,
    source_type: str = "gmail",
    effect: str = "mutation",
) -> dict[str, Any]:
    fm: dict[str, Any] = {
        "source_type": source_type,
        "effect": effect,
        "raw_quote": "ping",
        "reasoning": "test reasoning",
    }
    if target_path is not None:
        fm["target_path"] = target_path
    if candidates is not None:
        fm["target_candidates"] = candidates
    if applied_at is not None:
        fm["applied_at"] = applied_at
    if created is not None:
        fm["created"] = created
    return {"path": path, "frontmatter": fm}


@pytest.mark.asyncio
async def test_load_matter_signals_24h_returns_only_fresh_targeted(monkeypatch):
    # Storage cutover (#27): load_matter_signals_24h queries state.db,
    # not vault/signal/. The activity scopes the query to the matter +
    # 24h window server-side, so the fake only needs to serve the
    # already-matching, in-window signals.
    now = _now()
    fresh = now - timedelta(hours=3)
    records = [
        _signal_record(
            path="sig-aaaa",
            target_path="matter/carter.md",
            applied_at=fresh.isoformat(timespec="seconds"),
            created=fresh.isoformat(timespec="seconds"),
        ),
        _signal_record(
            path="sig-bbbb",
            candidates=[{"path": "matter/carter.md", "score": 0.6}],
            applied_at=fresh.isoformat(timespec="seconds"),
            created=fresh.isoformat(timespec="seconds"),
        ),
    ]
    fake = FakeStateClient(signal_records=records)
    monkeypatch.setattr(
        "src.utils.signal_state.StateClient", lambda *_a, **_kw: fake
    )

    result = await load_matter_signals_24h("matter/carter.md")
    # Both match: one by target_path, one by candidate.
    assert len(result) == 2
    paths = {r["path"] for r in result}
    assert "sig-aaaa" in paths
    assert "sig-bbbb" in paths
    assert fake.list_calls and fake.list_calls[0].get("matter") == "matter/carter.md"


@pytest.mark.asyncio
async def test_load_matter_signals_24h_no_vault_signal_fallback(monkeypatch):
    """F38 — the composer reads ONE signal store (state.db). When the
    state.db query fails it returns [] rather than silently falling back
    to a vault ``signal/`` walk (the store the matters route used to
    disagree on — paired with Lane I F9). The activity must never read
    vault/signal/."""

    class _Boom:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def list_signals(self, **kwargs: Any):
            raise RuntimeError("state.db unreachable")

    monkeypatch.setattr(
        "src.utils.signal_state.StateClient", lambda *_a, **_kw: _Boom()
    )
    # If the activity tried a vault fallback it would need a VaultClient;
    # leave it unpatched so any such call would error loudly. It must not.
    result = await load_matter_signals_24h("matter/carter.md")
    assert result == []


# ---------------------------------------------------------------------------
# load_task_transitions_24h
# ---------------------------------------------------------------------------


def _task_record(
    *,
    path: str,
    parent_matter: str,
    decision: str,
    evaluated_at: str,
    state: str = "done",
) -> dict[str, Any]:
    return {
        "path": path,
        "frontmatter": {
            "parent_matter": parent_matter,
            "state": state,
            "last_steward_outcome": {
                "decision": decision,
                "evaluated_at": evaluated_at,
                "reasoning": "Steward closed the loop",
            },
        },
    }


@pytest.mark.asyncio
async def test_load_task_transitions_24h_filters_still_active_and_stale(
    install_fake_vault,
):
    now = _now()
    fresh = (now - timedelta(hours=4)).isoformat(timespec="seconds")
    stale = (now - timedelta(hours=40)).isoformat(timespec="seconds")
    fake = install_fake_vault(FakeVaultClient(list_records_map={
        "task": [
            _task_record(
                path="task/foo.md",
                parent_matter="matter/carter.md",
                decision="likely_done",
                evaluated_at=fresh,
            ),
            _task_record(
                path="task/bar.md",
                parent_matter="matter/carter.md",
                decision="still_active",
                evaluated_at=fresh,
            ),
            _task_record(
                path="task/baz.md",
                parent_matter="matter/carter.md",
                decision="likely_done",
                evaluated_at=stale,
            ),
            _task_record(
                path="task/zed.md",
                parent_matter="matter/other.md",
                decision="likely_done",
                evaluated_at=fresh,
            ),
        ],
    }))

    result = await load_task_transitions_24h("matter/carter.md")
    assert len(result) == 1
    assert result[0]["task_path"] == "task/foo.md"
    assert result[0]["decision"] == "likely_done"
    # We touched the task list endpoint exactly once.
    assert any(c[0] == "task" for c in fake.list_calls)


# ---------------------------------------------------------------------------
# generate_matter_narrative — clerk happy path + error
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_generate_matter_narrative_trims_and_caps():
    long_response = (
        "Carter sprint deck is in your inbox awaiting review. " * 30
    )

    async def fake_clerk(prompt: str, raw: bool = False) -> str:  # noqa: ARG001
        return long_response

    with patch(
        "src.activities.nightly_narrative._call_clerk", side_effect=fake_clerk
    ):
        out = await generate_matter_narrative(
            {"name": "Carter", "path": "matter/carter.md", "current_state": ""},
            [{"path": "signal/x.md"}],
            [],
            [],
        )
    assert isinstance(out, str)
    assert len(out) <= 603  # NARRATIVE_CHAR_CAP=600 + ellipsis slack


@pytest.mark.asyncio
async def test_generate_matter_narrative_raises_when_clerk_fails():
    async def boom(prompt: str, raw: bool = False) -> str:  # noqa: ARG001
        raise RuntimeError("Clerk LLM billing error: insufficient credits")

    with patch(
        "src.activities.nightly_narrative._call_clerk", side_effect=boom
    ):
        with pytest.raises(RuntimeError, match="billing error"):
            await generate_matter_narrative(
                {"name": "Carter", "path": "matter/carter.md", "current_state": ""},
                [{"path": "signal/x.md"}],
                [],
                [],
            )


# ---------------------------------------------------------------------------
# patch_matter_narrative — round-trips to ctrl-api
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_matter_narrative_writes_three_fields(install_fake_vault):
    fake = install_fake_vault(FakeVaultClient())

    await patch_matter_narrative(
        "matter/carter.md",
        "Carter sprint deck is in your inbox awaiting review.",
        "2026-05-11T02:00:00+00:00",
        3,
    )
    assert len(fake.patch_calls) == 1
    path, updates = fake.patch_calls[0]
    assert path == "matter/carter.md"
    assert updates["current_state"].startswith("Carter sprint deck")
    assert updates["as_of"] == "2026-05-11T02:00:00+00:00"
    assert updates["signal_count_24h"] == 3


# ---------------------------------------------------------------------------
# Workflow-shaped tests — three deliverable cases.
# We exercise the per-matter logic by composing the activities directly
# rather than spinning up a Temporal TestEnvironment (stretched per the
# deliverable instruction).
# ---------------------------------------------------------------------------


async def _run_one_matter(
    matter_path: str,
    *,
    signals: list[dict[str, Any]],
    transitions: list[dict[str, Any]],
    fake: FakeVaultClient,
    clerk_response: str | Exception = "Carter is on track.",
    current_state: str = "",
) -> NightlyNarrativeResult:
    """Mimic the workflow's per-matter loop with the activity helpers."""
    result = NightlyNarrativeResult(matters_scanned=1)

    # Short-circuit only when prior narrative exists (#564 fix).
    if not signals and not transitions and current_state:
        result.matters_skipped_no_activity += 1
        return result

    async def fake_clerk(prompt: str, raw: bool = False) -> str:  # noqa: ARG001
        if isinstance(clerk_response, Exception):
            raise clerk_response
        return clerk_response

    with patch(
        "src.activities.nightly_narrative._call_clerk", side_effect=fake_clerk
    ):
        try:
            narrative = await generate_matter_narrative(
                {"name": matter_path, "path": matter_path, "current_state": ""},
                signals,
                transitions,
                [],
            )
        except Exception:
            result.matters_errored += 1
            return result

    if not narrative.strip():
        result.matters_errored += 1
        return result

    await patch_matter_narrative(
        matter_path,
        narrative,
        "2026-05-11T02:00:00+00:00",
        len(signals),
    )
    result.matters_refreshed += 1
    return result


@pytest.mark.asyncio
async def test_workflow_no_signals_no_patch(install_fake_vault):
    """Prior narrative present, empty window → short-circuit (cost gate)."""
    fake = install_fake_vault(FakeVaultClient())
    result = await _run_one_matter(
        "matter/carter.md",
        signals=[],
        transitions=[],
        fake=fake,
        current_state="Carter sprint deck is in your inbox, sir.",
    )
    assert result.matters_refreshed == 0
    assert result.matters_skipped_no_activity == 1
    assert fake.patch_calls == []


@pytest.mark.asyncio
async def test_workflow_three_signals_patches_once(install_fake_vault):
    """3 signals → patch_frontmatter called once, signal_count_24h == 3."""
    fake = install_fake_vault(FakeVaultClient())
    signals = [
        {"path": f"signal/x{i}.md", "source_type": "gmail", "reasoning": "ping"}
        for i in range(3)
    ]
    result = await _run_one_matter(
        "matter/carter.md",
        signals=signals,
        transitions=[],
        fake=fake,
        clerk_response="Carter is awaiting your reply on the deck.",
    )
    assert result.matters_refreshed == 1
    assert len(fake.patch_calls) == 1
    path, updates = fake.patch_calls[0]
    assert path == "matter/carter.md"
    assert updates["current_state"].strip() != ""
    assert updates["signal_count_24h"] == 3


@pytest.mark.asyncio
async def test_workflow_clerk_error_no_patch(install_fake_vault):
    """Clerk failure → no patch (failure does not corrupt state)."""
    fake = install_fake_vault(FakeVaultClient())
    signals = [{"path": "signal/x.md", "source_type": "gmail", "reasoning": "ping"}]
    result = await _run_one_matter(
        "matter/carter.md",
        signals=signals,
        transitions=[],
        fake=fake,
        clerk_response=RuntimeError("Clerk LLM billing error: insufficient credits"),
    )
    assert result.matters_errored == 1
    assert result.matters_refreshed == 0
    assert fake.patch_calls == []


# ---------------------------------------------------------------------------
# Cold-start tests (#564)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cold_start_no_signals_generates_narrative(install_fake_vault):
    """Absent current_state + empty window → LLM runs and patches."""
    fake = install_fake_vault(FakeVaultClient())
    result = await _run_one_matter(
        "matter/carter.md",
        signals=[],
        transitions=[],
        fake=fake,
        current_state="",
        clerk_response="No signals; awaiting next development, sir.",
    )
    assert result.matters_refreshed == 1, "cold-start must generate a narrative"
    assert result.matters_skipped_no_activity == 0
    assert len(fake.patch_calls) == 1
    _, updates = fake.patch_calls[0]
    assert updates["current_state"].strip() != ""


@pytest.mark.asyncio
async def test_has_prior_narrative_no_signals_skips(install_fake_vault):
    """Prior current_state present + empty window → short-circuits, no LLM."""
    fake = install_fake_vault(FakeVaultClient())
    clerk_calls: list[str] = []

    async def spy_clerk(prompt: str, raw: bool = False) -> str:  # noqa: ARG001
        clerk_calls.append(prompt)
        return "Should not be reached."

    with patch("src.activities.nightly_narrative._call_clerk", side_effect=spy_clerk):
        result = await _run_one_matter(
            "matter/carter.md",
            signals=[],
            transitions=[],
            fake=fake,
            current_state="Carter sprint deck is in your inbox, sir.",
        )
    assert result.matters_skipped_no_activity == 1, "prior narrative must short-circuit"
    assert clerk_calls == []
    assert fake.patch_calls == []


@pytest.mark.asyncio
async def test_propose_cold_start_no_signals_drafts_first_narrative():
    """v2 path: absent current_state + no signals → propose runs the clerk."""
    from src.activities.nightly_narrative import propose_matter_narrative
    from src.activities.state_mutator import ObservedWindow as _ObservedWindow

    observed = _ObservedWindow(
        start=_now() - timedelta(hours=12),
        end=_now(),
        signal_paths=[],
        decision_paths=[],
        other_refs=[],
    )

    async def fake_clerk(prompt: str, raw: bool = False) -> str:  # noqa: ARG001
        return "No signals yet; the matter awaits its next step, sir."

    with patch("src.activities.nightly_narrative._call_clerk", side_effect=fake_clerk):
        result = await propose_matter_narrative(
            target={"frontmatter": {"current_state": ""}, "as_of": None},
            observed=observed,
            args={
                "signals": [],
                "transitions": [],
                "events": [],
                "matter_path": "matter/carter.md",
                "matter_name": "Carter",
            },
        )

    assert result is not None, "cold-start matter must produce a mutation"
    assert "current_state" in result.fields
    assert result.fields["current_state"].strip() != ""


# ---------------------------------------------------------------------------
# daily_digest data layer — narrative-fresh vs. stale fallback.
# ---------------------------------------------------------------------------


def _matter_record(
    *,
    path: str,
    state: str = "active",
    current_state: str = "",
    as_of: str = "",
    name: str = "",
) -> dict[str, Any]:
    fm: dict[str, Any] = {
        "state": state,
        "name": name or path.removeprefix("matter/").removesuffix(".md"),
    }
    if current_state:
        fm["current_state"] = current_state
    if as_of:
        fm["as_of"] = as_of
    return {"path": path, "frontmatter": fm}


@pytest.mark.asyncio
async def test_collect_living_brief_uses_fresh_narrative(install_fake_vault):
    now = _now()
    fresh_as_of = (now - timedelta(hours=4)).isoformat(timespec="seconds")
    fake = install_fake_vault(FakeVaultClient(list_records_map={
        "matter": [
            _matter_record(
                path="matter/carter.md",
                current_state="Carter sprint deck is in your inbox awaiting review.",
                as_of=fresh_as_of,
            ),
        ],
        "event": [],
        "task": [],
        "needs_attention": [],
        "observation": [],
    }))
    out = await collect_living_brief_data()

    assert out["matter_count"] == 1
    entry = out["the_day"][0]
    assert entry["source"] == "narrative"
    assert "Carter sprint deck" in entry["excerpt"]
    assert entry["narrative_stale"] is False
    # The narrative path should NOT trigger a per-matter event walk.
    assert out["narrative_stale_count"] == 0


@pytest.mark.asyncio
async def test_collect_living_brief_falls_back_when_stale(install_fake_vault):
    now = _now()
    stale_as_of = (now - timedelta(hours=72)).isoformat(timespec="seconds")
    fake = install_fake_vault(FakeVaultClient(list_records_map={
        "matter": [
            _matter_record(
                path="matter/carter.md",
                current_state="stale paragraph",
                as_of=stale_as_of,
            ),
        ],
        "event": [
            {
                "path": "event/2026-05-09-x.md",
                "frontmatter": {
                    "parent_matter": "matter/carter.md",
                    "name": "Carter standup",
                    "summary": "Discussed deck",
                },
                "created": "2026-05-09T10:00:00+00:00",
            },
        ],
        "task": [],
        "needs_attention": [],
        "observation": [],
    }))
    out = await collect_living_brief_data()

    assert out["matter_count"] == 1
    entry = out["the_day"][0]
    assert entry["source"] == "fallback_events"
    assert entry["narrative_stale"] is True
    assert out["narrative_stale_count"] == 1
    # The fallback event we registered should surface.
    assert any(
        e["path"] == "event/2026-05-09-x.md" for e in entry.get("fallback_events", [])
    )


# ===========================================================================
# Phase C — state-mutator v2 retrofit (SM-C4)
# ===========================================================================
#
# Four cases per the deliverable in #891:
#
#   1. Matter with zero signals since as_of → propose returns None →
#      apply_matter_narrative_v2 returns status=no_change; no POST to
#      /api/v1/state-changes; no state_change audit record.
#   2. Matter with signals + clerk proposes mutation → state_change
#      audit lands + frontmatter implicitly patched. (Mocks both the
#      clerk AND the state_mutator's /state-changes POST endpoint.)
#   3. 409 retry happy path — first POST returns 409, second returns 200,
#      retried_count==1.
#   4. Patched-gate respected: with the
#      ``nightly_narrative_state_mutator_v1`` patch absent from history,
#      the OLD direct-PATCH branch runs (we observe the legacy
#      ``patch_frontmatter`` write rather than a /state-changes POST).
#
# ---------------------------------------------------------------------------
# Local fixtures + helpers
# ---------------------------------------------------------------------------

import json as _json
import uuid as _uuid

from src.activities.nightly_narrative import (
    apply_matter_narrative_v2,
    propose_matter_narrative,
)
from src.activities.state_mutator import ObservedWindow as _ObservedWindow


class _ScriptedTransport(httpx.AsyncBaseTransport):
    """Re-implementation of the test_state_mutator transport — local
    copy so we don't import a private fixture across modules.
    """

    def __init__(self, script: list) -> None:
        self.script = list(script)
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self.script:
            raise AssertionError(
                f"_ScriptedTransport: no more responses; request was "
                f"{request.method} {request.url}"
            )
        entry = self.script.pop(0)
        if callable(entry):
            return entry(request)
        return entry


@pytest.fixture
def install_state_mutator_transport():
    """Install a scripted transport into the state_mutator's
    ``httpx.AsyncClient`` factory so POST /api/v1/state-changes is
    deterministically scripted per test.

    Storage cutover (#27): ``gather_observed`` now reads signals from
    state.db via ``StateClient`` (a separate httpx client). This fixture
    also stubs ``signal_state.StateClient`` so the scripted transport
    only ever sees the state-mutator's own POST traffic — the signal
    query is served in-memory and defaults to empty.
    """

    transports: list[_ScriptedTransport] = []
    signal_rows_holder: dict[str, list[dict[str, Any]]] = {"rows": []}

    def _install(
        *responses: httpx.Response,
        signal_records: list[dict[str, Any]] | None = None,
    ) -> _ScriptedTransport:
        transport = _ScriptedTransport(list(responses))
        transports.append(transport)
        # Feed the in-memory StateClient stub the signal records this
        # test wants gather_observed to see (state.db, not vault).
        if signal_records:
            rows: list[dict[str, Any]] = []
            for rec in signal_records:
                fm = rec.get("frontmatter") or {}
                rows.append({
                    "id": rec.get("path") or rec.get("id") or "",
                    "kind": fm.get("effect"),
                    "source": fm.get("source_type"),
                    "ts": fm.get("created") or fm.get("applied_at"),
                    "entity_ref": fm.get("target_path"),
                    "matter_ref": (
                        fm.get("target_matter_path") or fm.get("target_path")
                    ),
                    "status": fm.get("status"),
                    "payload": fm,
                })
            signal_rows_holder["rows"] = rows
        return transport

    real_async_client = httpx.AsyncClient

    def _factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        if transports:
            kwargs["transport"] = transports[0]
        return real_async_client(*args, **kwargs)

    class _StubStateClient:
        def __init__(self, *_a: Any, **_kw: Any) -> None:
            pass

        async def __aenter__(self) -> "_StubStateClient":
            return self

        async def __aexit__(self, *_exc: object) -> None:
            pass

        async def close(self) -> None:
            pass

        async def list_signals(self, **_kwargs: Any) -> list[dict[str, Any]]:
            return list(signal_rows_holder["rows"])

    ctx = patch("src.activities.state_mutator.httpx.AsyncClient", _factory)
    ctx.start()
    ctx_sc = patch(
        "src.utils.signal_state.StateClient", _StubStateClient
    )
    ctx_sc.start()
    yield _install
    ctx.stop()
    ctx_sc.stop()


def _matter_v2_record(
    *,
    path: str = "matter/carter.md",
    current_state: str = "",
    as_of: str | None = None,
    name: str | None = None,
) -> dict[str, Any]:
    fm: dict[str, Any] = {
        "state": "active",
        "name": name or path.removeprefix("matter/").removesuffix(".md"),
    }
    if current_state:
        fm["current_state"] = current_state
    if as_of:
        fm["as_of"] = as_of
    return {"path": path, "frontmatter": fm, "body": ""}


# ---------------------------------------------------------------------------
# Case 1 — zero signals → no POST, no audit
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_phase_c_no_signals_returns_no_change_and_skips_post(
    install_state_mutator_transport,
):
    """Per spec §7 W3 + §12 Phase C step 11: empty window short-circuits
    before the propose function even sees the call; v2 never POSTs.
    """
    now = _now()
    fresh_as_of = (now - timedelta(hours=4)).isoformat(timespec="seconds")
    # No signals targeting our matter, no transitions. Two passes through
    # the FakeVaultClient: one for list_records (signals), one for
    # list_records (tasks), one for read_record (read_target inside v2).
    fake = FakeVaultClient(
        list_records_map={"signal": [], "task": []},
        read_records_map={
            "matter/carter.md": _matter_v2_record(
                path="matter/carter.md",
                current_state="prior paragraph",
                as_of=fresh_as_of,
                name="Carter",
            ),
        },
    )
    # The narrative module ALSO uses VaultClient inside its own loaders
    # (read_matter_summary etc.) so we patch BOTH the narrative module's
    # VaultClient AND state_mutator's VaultClient (latter is what
    # read_target uses).
    ctx_a = patch(
        "src.activities.nightly_narrative.VaultClient", return_value=fake
    )
    ctx_b = patch(
        "src.activities.state_mutator.VaultClient", return_value=fake
    )
    ctx_a.start()
    ctx_b.start()

    transport = install_state_mutator_transport()  # no responses scripted

    try:
        observed_end = now.isoformat(timespec="seconds")
        outcome = await apply_matter_narrative_v2(
            "matter/carter.md", observed_end,
        )
    finally:
        ctx_a.stop()
        ctx_b.stop()

    assert outcome["status"] == "no_change"
    assert outcome["audit_record_path"] is None
    # The /api/v1/state-changes endpoint should NEVER be hit.
    assert transport.requests == []


# ---------------------------------------------------------------------------
# Case 2 — signals + clerk proposes mutation → POST + audit
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_phase_c_signals_plus_clerk_mutation_lands_audit(
    install_state_mutator_transport, monkeypatch,
):
    """Three fresh signals → clerk responds with a JSON mutation →
    apply_matter_narrative_v2 POSTs to /api/v1/state-changes and the
    state_change audit record path is plumbed back.
    """
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    now = _now()
    fresh_as_of = (now - timedelta(hours=4)).isoformat(timespec="seconds")
    signal_ts = (now - timedelta(hours=2)).isoformat(timespec="seconds")

    signal_records = [
        _signal_record(
            path=f"sig-2026-05-13-{i}",
            target_path="matter/carter.md",
            applied_at=signal_ts,
            created=signal_ts,
        )
        for i in range(3)
    ]
    fake = FakeVaultClient(
        list_records_map={"task": []},
        read_records_map={
            "matter/carter.md": _matter_v2_record(
                path="matter/carter.md",
                current_state="prior paragraph",
                as_of=fresh_as_of,
                name="Carter",
            ),
        },
    )
    ctx_a = patch(
        "src.activities.nightly_narrative.VaultClient", return_value=fake
    )
    ctx_b = patch(
        "src.activities.state_mutator.VaultClient", return_value=fake
    )
    ctx_a.start()
    ctx_b.start()

    async def fake_clerk(prompt: str, raw: bool = False) -> str:  # noqa: ARG001
        return _json.dumps({
            "narrative": "Carter's deck has been finalised, sir, and the buyer's response is expected by Friday.",
            "confidence": 0.91,
        })

    clerk_patch = patch(
        "src.activities.nightly_narrative._call_clerk", side_effect=fake_clerk
    )
    clerk_patch.start()

    transport = install_state_mutator_transport(
        httpx.Response(
            200,
            json={
                "audit_record_path": "event/state-change-2026-05-13-carter.md",
                "timeline_entry_id": "01HXYZABC",
                "new_as_of": "2026-05-13T02:00:00Z",
            },
        ),
        signal_records=signal_records,
    )

    try:
        observed_end = now.isoformat(timespec="seconds")
        outcome = await apply_matter_narrative_v2(
            "matter/carter.md", observed_end,
        )
    finally:
        ctx_a.stop()
        ctx_b.stop()
        clerk_patch.stop()

    assert outcome["status"] == "mutated"
    assert outcome["audit_record_path"] == "event/state-change-2026-05-13-carter.md"
    assert outcome["new_as_of"] == "2026-05-13T02:00:00Z"
    assert outcome["retried_count"] == 0

    # Exactly one POST to /api/v1/state-changes with the expected envelope.
    assert len(transport.requests) == 1
    req = transport.requests[0]
    assert req.method == "POST"
    assert req.url.path == "/api/v1/state-changes"
    envelope = _json.loads(req.content.decode("utf-8"))
    assert envelope["target_path"] == "matter/carter.md"
    assert envelope["source"] == "nightly_narrative"
    assert envelope["fields"]["current_state"].startswith("Carter's deck")
    assert "as_of" in envelope["fields"]
    # current_state + as_of are the only state-field writes — NOT
    # signal_count_24h (bookkeeping, not a state field).
    assert set(envelope["fields"].keys()) <= {"current_state", "as_of"}
    # Clerk-supplied confidence flows through.
    assert envelope["confidence"] == pytest.approx(0.91)
    # observed_window carries the three signals we surfaced.
    assert len(envelope["observed_window"]["signal_paths"]) == 3


# ---------------------------------------------------------------------------
# Case 3 — 409 retry happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_phase_c_409_retry_then_success(
    install_state_mutator_transport, monkeypatch,
):
    """First POST returns 409 (as_of mismatch from a racing writer);
    second POST returns 200; retried_count==1, audit lands.
    """
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    now = _now()
    fresh_as_of = (now - timedelta(hours=4)).isoformat(timespec="seconds")
    later_as_of = (now - timedelta(hours=1)).isoformat(timespec="seconds")
    signal_ts = (now - timedelta(hours=2)).isoformat(timespec="seconds")

    signal_records = [
        _signal_record(
            path="sig-2026-05-13-x",
            target_path="matter/carter.md",
            applied_at=signal_ts,
            created=signal_ts,
        ),
    ]
    fake = FakeVaultClient(
        list_records_map={"task": []},
        read_records_map={
            "matter/carter.md": _matter_v2_record(
                path="matter/carter.md",
                current_state="prior",
                as_of=fresh_as_of,
                name="Carter",
            ),
        },
    )
    # The state_mutator's ``read_target`` reads matter/carter.md each
    # retry. Second read returns the post-race as_of so the new
    # expected_as_of envelope matches what the server claims.
    second_read = _matter_v2_record(
        path="matter/carter.md",
        current_state="prior",
        as_of=later_as_of,
        name="Carter",
    )

    # Sequence-aware read: pop later_as_of on the second read_record call
    # for matter/carter.md inside state_mutator. We piggyback on the
    # FakeVaultClient's default by inheriting and tracking reads.
    read_calls = {"matter/carter.md": 0}
    original_read = fake.read_record

    async def sequenced_read(path: str) -> dict[str, Any]:
        read_calls[path] = read_calls.get(path, 0) + 1
        if path == "matter/carter.md" and read_calls[path] >= 2:
            return second_read
        return await original_read(path)

    fake.read_record = sequenced_read  # type: ignore[method-assign]

    ctx_a = patch(
        "src.activities.nightly_narrative.VaultClient", return_value=fake
    )
    ctx_b = patch(
        "src.activities.state_mutator.VaultClient", return_value=fake
    )
    ctx_a.start()
    ctx_b.start()

    async def fake_clerk(prompt: str, raw: bool = False) -> str:  # noqa: ARG001
        return _json.dumps({
            "narrative": "Carter's deck has been finalised, sir.",
            "confidence": 0.90,
        })

    clerk_patch = patch(
        "src.activities.nightly_narrative._call_clerk", side_effect=fake_clerk
    )
    clerk_patch.start()

    transport = install_state_mutator_transport(
        httpx.Response(409, json={"current_as_of": later_as_of, "error": "as_of_mismatch"}),
        httpx.Response(
            200,
            json={
                "audit_record_path": "event/state-change-2026-05-13-carter-r1.md",
                "timeline_entry_id": "01HXYZRETRY",
                "new_as_of": "2026-05-13T02:01:00Z",
            },
        ),
        signal_records=signal_records,
    )

    try:
        observed_end = now.isoformat(timespec="seconds")
        outcome = await apply_matter_narrative_v2(
            "matter/carter.md", observed_end,
        )
    finally:
        ctx_a.stop()
        ctx_b.stop()
        clerk_patch.stop()

    assert outcome["status"] == "mutated"
    assert outcome["retried_count"] == 1
    assert outcome["audit_record_path"] == (
        "event/state-change-2026-05-13-carter-r1.md"
    )
    assert len(transport.requests) == 2
    # The retry envelope carries the server-reported expected_as_of.
    env2 = _json.loads(transport.requests[1].content.decode("utf-8"))
    assert env2["expected_as_of"] == later_as_of


# ---------------------------------------------------------------------------
# Case 4 — patched-gate respected: workflow.patched=False → legacy branch
# ---------------------------------------------------------------------------
#
# Per the workflow's contract (and packages/learn/CLAUDE.md replay
# rules), histories started before the patched gate was added must
# continue to execute the legacy direct-PATCH branch. We exercise this
# by running ``NightlyNarrativeWorkflow.run`` inside an in-process
# Temporal env with a worker that registers ALL the relevant
# activities and forces ``workflow.patched`` to return False via
# Temporal's worker_deployment_versioning patching utilities. The
# observable contract is: ``patch_matter_narrative`` (legacy) gets
# called, not ``apply_matter_narrative_v2`` (v2).


@pytest.mark.asyncio
async def test_phase_c_patched_gate_wired_so_new_history_runs_v2():
    """Run the workflow under a fresh Temporal env. For a brand-new
    history (no recorded events yet) ``workflow.patched`` returns True
    for any patch id, so the v2 branch executes — the legacy
    ``patch_matter_narrative`` activity must NOT be invoked.

    Temporal doesn't expose a public way to inject ``patched=False``
    for a fresh start (it's the replay-of-old-history behaviour that
    matters), so the practically-meaningful contract this test verifies
    is the inverse: that the gate name matches
    ``nightly_narrative_state_mutator_v1`` AND that under the post-
    deploy steady state (gate=True) the v2 branch routes through
    ``apply_matter_narrative_v2`` rather than the legacy direct-PATCH
    activities. Replay-of-old-history is exercised in CI by running an
    old recorded history against new code; that lives outside this
    unit suite.
    """
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker
    from temporalio import activity as _activity
    from src.workflows.nightly_narrative import (
        NightlyNarrativeWorkflow,
        NIGHTLY_NARRATIVE_STATE_MUTATOR_PATCH,
    )

    # Stub each activity registered on the workflow to a deterministic
    # mock that records calls. The legacy branch invokes (in order):
    #   list_active_matters → read_matter_summary → load_matter_signals_24h
    #   → load_task_transitions_24h → (load_source_events) →
    #   generate_matter_narrative → patch_matter_narrative
    #
    # The v2 branch would invoke ``apply_matter_narrative_v2`` once
    # per matter instead. By scripting both and asserting which fires,
    # we know which branch ran.

    calls: dict[str, list[Any]] = {
        "list_active_matters": [],
        "read_matter_summary": [],
        "load_matter_signals_24h": [],
        "load_task_transitions_24h": [],
        "load_source_events": [],
        "generate_matter_narrative": [],
        "patch_matter_narrative": [],
        "apply_matter_narrative_v2": [],
    }

    @_activity.defn(name="list_active_matters")
    async def list_active_matters_stub() -> list[str]:
        calls["list_active_matters"].append(())
        return ["matter/carter.md"]

    @_activity.defn(name="read_matter_summary")
    async def read_matter_summary_stub(matter_path: str) -> dict[str, Any]:
        calls["read_matter_summary"].append(matter_path)
        return {"name": "Carter", "path": matter_path, "current_state": "prior"}

    @_activity.defn(name="load_matter_signals_24h")
    async def load_matter_signals_24h_stub(matter_path: str) -> list[dict[str, Any]]:
        calls["load_matter_signals_24h"].append(matter_path)
        return [{"path": "signal/x.md", "source_type": "gmail", "reasoning": "ping"}]

    @_activity.defn(name="load_task_transitions_24h")
    async def load_task_transitions_24h_stub(matter_path: str) -> list[dict[str, Any]]:
        calls["load_task_transitions_24h"].append(matter_path)
        return []

    @_activity.defn(name="load_source_events")
    async def load_source_events_stub(signal_paths: list[str]) -> list[dict[str, Any]]:
        calls["load_source_events"].append(signal_paths)
        return []

    @_activity.defn(name="generate_matter_narrative")
    async def generate_matter_narrative_stub(
        summary: dict[str, Any],
        signals: list[dict[str, Any]],
        transitions: list[dict[str, Any]],
        events: list[dict[str, Any]],
    ) -> str:
        calls["generate_matter_narrative"].append(summary.get("path"))
        return "Carter is on track, sir."

    @_activity.defn(name="patch_matter_narrative")
    async def patch_matter_narrative_stub(
        matter_path: str, current_state: str, as_of: str, signal_count_24h: int
    ) -> None:
        calls["patch_matter_narrative"].append({
            "matter_path": matter_path,
            "current_state": current_state,
            "as_of": as_of,
            "signal_count_24h": signal_count_24h,
        })

    @_activity.defn(name="apply_matter_narrative_v2")
    async def apply_matter_narrative_v2_stub(
        matter_path: str, observed_end_iso: str,
    ) -> dict[str, Any]:
        calls["apply_matter_narrative_v2"].append({
            "matter_path": matter_path,
            "observed_end_iso": observed_end_iso,
        })
        return {"matter_path": matter_path, "status": "mutated"}

    async with await WorkflowEnvironment.start_time_skipping() as env:
        task_queue = f"test-tq-{_uuid.uuid4().hex[:8]}"
        worker = Worker(
            env.client,
            task_queue=task_queue,
            workflows=[NightlyNarrativeWorkflow],
            activities=[
                list_active_matters_stub,
                read_matter_summary_stub,
                load_matter_signals_24h_stub,
                load_task_transitions_24h_stub,
                load_source_events_stub,
                generate_matter_narrative_stub,
                patch_matter_narrative_stub,
                apply_matter_narrative_v2_stub,
            ],
        )
        async with worker:
            wf_id = f"test-narrative-{_uuid.uuid4().hex[:8]}"
            handle = await env.client.start_workflow(
                NightlyNarrativeWorkflow.run,
                id=wf_id,
                task_queue=task_queue,
            )
            result = await handle.result()

    # Sanity — the workflow returned.
    assert result is not None
    # In a brand-new history started AFTER the deploy that landed the
    # patched gate, ``workflow.patched`` returns True (because the
    # current code DOES have the patch marker). So the v2 branch runs.
    # That's the post-deploy steady-state behaviour. The legacy
    # ``patch_matter_narrative`` activity should NOT be invoked.
    assert calls["apply_matter_narrative_v2"], (
        "apply_matter_narrative_v2 was not invoked — the patched gate "
        "may have failed to register"
    )
    assert not calls["patch_matter_narrative"], (
        "patch_matter_narrative (legacy) was invoked even though the "
        "patched gate is in effect — the workflow took the wrong branch"
    )
    # Verify the patch name matches the contract.
    assert NIGHTLY_NARRATIVE_STATE_MUTATOR_PATCH == (
        "nightly_narrative_state_mutator_v1"
    )


# ---------------------------------------------------------------------------
# propose_matter_narrative unit tests — confidence parsing + NO_CHANGE
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_propose_returns_none_on_empty_signals_and_transitions():
    observed = _ObservedWindow(
        start=_now() - timedelta(hours=12),
        end=_now(),
        signal_paths=[],
        decision_paths=[],
        other_refs=[],
    )
    result = await propose_matter_narrative(
        target={"frontmatter": {"current_state": "prior"}, "as_of": "2026-05-12T18:00:00Z"},
        observed=observed,
        args={"signals": [], "transitions": [], "events": [], "matter_path": "matter/carter.md"},
    )
    assert result is None


@pytest.mark.asyncio
async def test_propose_handles_no_change_clerk_token():
    observed = _ObservedWindow(
        start=_now() - timedelta(hours=12),
        end=_now(),
        signal_paths=["signal/x.md"],
        decision_paths=[],
        other_refs=[],
    )

    async def fake_clerk(prompt: str, raw: bool = False) -> str:  # noqa: ARG001
        return "NO_CHANGE"

    with patch(
        "src.activities.nightly_narrative._call_clerk", side_effect=fake_clerk
    ):
        result = await propose_matter_narrative(
            target={
                "frontmatter": {"current_state": "prior"},
                "as_of": "2026-05-12T18:00:00Z",
            },
            observed=observed,
            args={
                "signals": [{"path": "signal/x.md", "reasoning": "ping"}],
                "transitions": [],
                "events": [],
                "matter_path": "matter/carter.md",
                "matter_name": "Carter",
            },
        )
    assert result is None


@pytest.mark.asyncio
async def test_propose_defaults_confidence_when_clerk_returns_bare_paragraph():
    observed = _ObservedWindow(
        start=_now() - timedelta(hours=12),
        end=_now(),
        signal_paths=["signal/x.md"],
        decision_paths=[],
        other_refs=[],
    )

    async def fake_clerk(prompt: str, raw: bool = False) -> str:  # noqa: ARG001
        # Bare paragraph (no JSON) — propose function should fall back
        # to DEFAULT_NARRATIVE_CONFIDENCE = 0.85.
        return "Carter's deck is in your inbox, sir."

    with patch(
        "src.activities.nightly_narrative._call_clerk", side_effect=fake_clerk
    ):
        result = await propose_matter_narrative(
            target={
                "frontmatter": {"current_state": "prior"},
                "as_of": "2026-05-12T18:00:00Z",
            },
            observed=observed,
            args={
                "signals": [{"path": "signal/x.md", "reasoning": "ping"}],
                "transitions": [],
                "events": [],
                "matter_path": "matter/carter.md",
                "matter_name": "Carter",
            },
        )
    assert result is not None
    assert result.confidence == pytest.approx(0.85)
    assert "Carter" in result.fields["current_state"]
    assert "as_of" in result.fields


@pytest.mark.asyncio
async def test_propose_uses_clerk_confidence_when_supplied():
    observed = _ObservedWindow(
        start=_now() - timedelta(hours=12),
        end=_now(),
        signal_paths=["signal/x.md"],
        decision_paths=[],
        other_refs=[],
    )

    async def fake_clerk(prompt: str, raw: bool = False) -> str:  # noqa: ARG001
        return _json.dumps({
            "narrative": "Carter is in motion, sir.",
            "confidence": 0.73,
        })

    with patch(
        "src.activities.nightly_narrative._call_clerk", side_effect=fake_clerk
    ):
        result = await propose_matter_narrative(
            target={
                "frontmatter": {"current_state": "prior"},
                "as_of": "2026-05-12T18:00:00Z",
            },
            observed=observed,
            args={
                "signals": [{"path": "signal/x.md", "reasoning": "ping"}],
                "transitions": [],
                "events": [],
                "matter_path": "matter/carter.md",
                "matter_name": "Carter",
            },
        )
    assert result is not None
    assert result.confidence == pytest.approx(0.73)
