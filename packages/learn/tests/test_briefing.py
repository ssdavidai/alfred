"""Unit tests for BriefingWorkflow + briefing activities (#893 Phase E).

Coverage per spec §14:

  * BriefingWorkflow.run with 3 active matters (2 mutate, 1 no-change):
    expect 2 state_change audits + 1 no-change visit + briefing snapshot
    written via vault_client.write_record.
  * get_prior_briefing returns None on first run, then returns the
    previous slot's record on a subsequent call.
  * Two-phase write: assert compose_and_write_briefing reads the
    post-mutation matter snapshot (after Phase 1 mutates).
  * propose_briefing_matter_update no-change case → returns None
    (no v2 round-trip), even when signals are present in the window
    if the clerk returns NO_CHANGE.

Mocks:

  * ``state_mutator._post_state_change`` — scripted httpx responses for
    Phase 1 v2 round-trips (no live ctrl-api).
  * ``briefing._call_clerk`` / ``nightly_narrative._call_clerk`` —
    deterministic strings per matter.
  * VaultClient — captures every list / read / write so the assertions
    inspect the exact ctrl-api surface.
"""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from src.activities import briefing as briefing_mod
from src.activities.briefing import (
    briefing_visit_matter,
    compose_and_write_briefing,
    get_prior_briefing,
    list_active_matters_for_briefing,
    propose_briefing_matter_update,
)
from src.activities.state_mutator import ObservedWindow


# ---------------------------------------------------------------------------
# Fake VaultClient — single fixture-managed instance used across modules so
# every activity sees the same state.
# ---------------------------------------------------------------------------


class FakeVaultClient:
    def __init__(self) -> None:
        # Map record_type → list of records (each {path, frontmatter}).
        self.records_by_type: dict[str, list[dict[str, Any]]] = {}
        # Map full path → record dict {frontmatter, body}.
        self.records_by_path: dict[str, dict[str, Any]] = {}
        self.list_calls: list[tuple[str, int]] = []
        self.read_calls: list[str] = []
        self.write_calls: list[tuple[str, str, str]] = []

    async def close(self) -> None:
        pass

    async def list_records(
        self, record_type: str, status: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        self.list_calls.append((record_type, limit))
        return [dict(r) for r in self.records_by_type.get(record_type, [])]

    async def read_record(self, path: str) -> dict[str, Any]:
        self.read_calls.append(path)
        if path in self.records_by_path:
            # Return a copy so caller mutations don't leak back into
            # subsequent reads. Frontmatter dict is deep-copied via
            # json round-trip for simplicity.
            rec = self.records_by_path[path]
            return {
                "frontmatter": json.loads(json.dumps(rec.get("frontmatter") or {})),
                "body": rec.get("body", ""),
            }
        raise httpx.HTTPStatusError(
            "not found",
            request=httpx.Request("GET", path),
            response=httpx.Response(404),
        )

    async def write_record(self, record_type: str, name: str, content: str) -> str:
        path = f"{record_type}/{name}.md"
        self.write_calls.append((record_type, name, content))
        # Persist the writer's content so later reads see it.
        self.records_by_path[path] = {
            "frontmatter": {"record_type": record_type, "slot": "morning"},
            "body": content,
        }
        return path


@pytest.fixture
def fake_vault():
    """Patch VaultClient on the briefing module + state_mutator."""
    fake = FakeVaultClient()
    patches = [
        patch("src.activities.briefing.VaultClient", return_value=fake),
        patch("src.activities.state_mutator.VaultClient", return_value=fake),
    ]
    for p in patches:
        p.start()
    yield fake
    for p in patches:
        try:
            p.stop()
        except RuntimeError:
            pass


# ---------------------------------------------------------------------------
# Scripted httpx transport — mock state_mutator's POST to /state-changes.
# ---------------------------------------------------------------------------


class ScriptedTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        # Map matter path → list of responses (popped per attempt).
        self.responses_by_target: dict[str, list[httpx.Response]] = {}
        self.requests: list[dict[str, Any]] = []

    def queue(self, matter_path: str, response: httpx.Response) -> None:
        self.responses_by_target.setdefault(matter_path, []).append(response)

    async def handle_async_request(
        self, request: httpx.Request
    ) -> httpx.Response:
        body_raw = await request.aread()
        # patching httpx.AsyncClient via the state_mutator namespace is
        # actually module-wide (httpx is a singleton), so the new
        # briefing.py gatherers (_load_soul_md, _gather_window_signals,
        # _gather_money_envelope, _gather_day_shape, _gather_in_flight_agents)
        # also flow through this transport. Filter to only record the
        # state-change POSTs the test is asserting on; stub everything
        # else with a 200 empty payload so the gatherers degrade cleanly.
        if not request.url.path.endswith("/state-changes") or request.method != "POST":
            return httpx.Response(200, json={})
        envelope = json.loads(body_raw.decode("utf-8")) if body_raw else {}
        target = envelope.get("target_path", "")
        self.requests.append({
            "target_path": target,
            "source": envelope.get("source"),
            "fields": envelope.get("fields", {}),
            "envelope": envelope,
        })
        if target in self.responses_by_target and self.responses_by_target[target]:
            return self.responses_by_target[target].pop(0)
        return httpx.Response(
            500,
            json={"error": f"no scripted response for target={target!r}"},
        )


@pytest.fixture
def install_transport():
    """Install a ScriptedTransport for state_mutator's POST factory."""
    transport = ScriptedTransport()
    real_async_client = httpx.AsyncClient

    def _factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    ctx = patch("src.activities.state_mutator.httpx.AsyncClient", _factory)
    ctx.start()
    yield transport
    ctx.stop()


# ---------------------------------------------------------------------------
# Helper factories
# ---------------------------------------------------------------------------


def _matter_record(slug: str, **overrides: Any) -> dict[str, Any]:
    fm: dict[str, Any] = {
        "name": slug,
        "state": "active",
        "current_state": f"prior paragraph for {slug}",
        "as_of": "2026-05-12T18:00:00Z",
    }
    fm.update(overrides)
    return {"path": f"matter/{slug}.md", "frontmatter": fm}


def _signal_record(path: str, target_path: str, applied_at: str) -> dict[str, Any]:
    return {
        "path": path,
        "frontmatter": {
            "source_type": "gmail",
            "effect": "mutation",
            "target_path": target_path,
            "applied_at": applied_at,
        },
    }


def _ok_state_change_response(audit_path: str, new_as_of: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "audit_record_path": audit_path,
            "timeline_entry_id": f"01HX{audit_path[-8:]}",
            "new_as_of": new_as_of,
        },
    )


# ---------------------------------------------------------------------------
# list_active_matters_for_briefing
# ---------------------------------------------------------------------------


async def test_list_active_matters_for_briefing_skips_terminal(fake_vault):
    fake_vault.records_by_type["matter"] = [
        _matter_record("alpha", state="active"),
        _matter_record("beta", state="done"),
        _matter_record("gamma", status="archived"),
        _matter_record("delta", state="active"),
    ]
    out = await list_active_matters_for_briefing()
    assert out == ["matter/alpha.md", "matter/delta.md"]


# ---------------------------------------------------------------------------
# get_prior_briefing
# ---------------------------------------------------------------------------


async def test_get_prior_briefing_none_on_first_run(fake_vault):
    fake_vault.records_by_type["briefing"] = []
    out = await get_prior_briefing("morning")
    assert out is None


async def test_get_prior_briefing_returns_most_recent_for_slot(fake_vault):
    fake_vault.records_by_type["briefing"] = [
        {
            "path": "briefing/2026-05-12-morning.md",
            "frontmatter": {"slot": "morning", "composed_at": "2026-05-12T07:00:00Z"},
        },
        {
            "path": "briefing/2026-05-12-evening.md",
            "frontmatter": {"slot": "evening", "composed_at": "2026-05-12T18:00:00Z"},
        },
        {
            "path": "briefing/2026-05-11-morning.md",
            "frontmatter": {"slot": "morning", "composed_at": "2026-05-11T07:00:00Z"},
        },
    ]
    out_morning = await get_prior_briefing("morning")
    assert out_morning is not None
    assert out_morning["path"] == "briefing/2026-05-12-morning.md"
    assert out_morning["composed_at"].startswith("2026-05-12T07:00:00")

    out_evening = await get_prior_briefing("evening")
    assert out_evening is not None
    assert out_evening["path"] == "briefing/2026-05-12-evening.md"


# ---------------------------------------------------------------------------
# propose_briefing_matter_update — no-change case
# ---------------------------------------------------------------------------


async def test_propose_returns_none_on_clerk_no_change(fake_vault):
    target = {
        "frontmatter": {
            "path": "matter/alpha.md",
            "current_state": "prior paragraph",
            "as_of": "2026-05-12T18:00:00Z",
        },
        "body": "",
    }
    observed = ObservedWindow(
        start=briefing_mod._parse_iso_or_none("2026-05-12T18:00:00Z"),
        end=briefing_mod._parse_iso_or_none("2026-05-13T07:00:00Z"),
        signal_paths=["signal/s1.md"],
        decision_paths=[],
        other_refs=[],
    )
    with patch(
        "src.activities.briefing._call_clerk",
        new=AsyncMock(return_value="NO_CHANGE"),
    ):
        result = await propose_briefing_matter_update(
            target=target,
            observed=observed,
            args={
                "slot": "morning",
                "prior_state": "prior paragraph",
                "as_of": "2026-05-12T18:00:00Z",
                "matter_slug": "alpha",
            },
        )
    assert result is None


async def test_propose_returns_none_when_window_empty(fake_vault):
    target = {
        "frontmatter": {"path": "matter/alpha.md"},
        "body": "",
    }
    observed = ObservedWindow(
        start=briefing_mod._parse_iso_or_none("2026-05-12T18:00:00Z"),
        end=briefing_mod._parse_iso_or_none("2026-05-13T07:00:00Z"),
        signal_paths=[],
        decision_paths=[],
        other_refs=[],
    )
    # No clerk call should occur — assert via AsyncMock not being awaited.
    clerk = AsyncMock(return_value="NO_CHANGE")
    with patch("src.activities.briefing._call_clerk", new=clerk):
        result = await propose_briefing_matter_update(
            target=target,
            observed=observed,
            args={"slot": "morning", "prior_state": "", "as_of": None},
        )
    assert result is None
    clerk.assert_not_awaited()


async def test_propose_returns_mutation_on_json_response(fake_vault):
    target = {
        "frontmatter": {"path": "matter/alpha.md", "current_state": "prior"},
        "body": "",
    }
    observed = ObservedWindow(
        start=briefing_mod._parse_iso_or_none("2026-05-12T18:00:00Z"),
        end=briefing_mod._parse_iso_or_none("2026-05-13T07:00:00Z"),
        signal_paths=["signal/s1.md", "signal/s2.md"],
        decision_paths=[],
        other_refs=[],
    )
    clerk_reply = json.dumps({
        "narrative": "Buyer offer arrived; sir's response is required.",
        "confidence": 0.91,
    })
    with patch(
        "src.activities.briefing._call_clerk",
        new=AsyncMock(return_value=clerk_reply),
    ):
        result = await propose_briefing_matter_update(
            target=target,
            observed=observed,
            args={
                "slot": "morning",
                "prior_state": "prior",
                "as_of": "2026-05-12T18:00:00Z",
                "matter_slug": "alpha",
            },
        )
    assert result is not None
    assert result.confidence == 0.91
    assert result.fields["current_state"].startswith("Buyer offer arrived")
    assert "as_of" in result.fields
    assert "last_briefing_at" in result.fields
    # as_of + last_briefing_at both stamped from observed.end (Z-suffix).
    assert result.fields["as_of"] == "2026-05-13T07:00:00Z"
    assert result.fields["last_briefing_at"] == "2026-05-13T07:00:00Z"


# ---------------------------------------------------------------------------
# compose_and_write_briefing — Phase 2 reads post-mutation state
# ---------------------------------------------------------------------------


async def test_compose_reads_post_mutation_state(fake_vault):
    """The composer must observe the post-mutation matter snapshot.

    Phase 1 (mocked) mutated matter/alpha.md. compose_and_write_briefing
    re-reads the matter via vault and the snapshot it passes to the
    clerk must reflect the new current_state, not the pre-mutation one.
    """
    # Set up post-mutation matter state — this is what Phase 2's
    # composer pass will see after Phase 1 wrote the v2 patch through
    # ctrl-api.
    fake_vault.records_by_path["matter/alpha.md"] = {
        "frontmatter": {
            "name": "Alpha",
            "current_state": "POST-MUTATION: Buyer offer received.",
            "as_of": "2026-05-13T07:00:00Z",
            "state": "active",
        },
        "body": "",
    }
    captured_prompts: list[str] = []

    async def fake_clerk(prompt: str, raw: bool = False) -> str:  # noqa: ARG001
        captured_prompts.append(prompt)
        return "Sir — the morning is calm. [[matter/alpha]] now stands changed."

    visit_results = [{
        "matter_path": "matter/alpha.md",
        "applied": True,
        "state_changed": True,
        "audit_record_path": "event/state-change-alpha.md",
        "new_as_of": "2026-05-13T07:00:00Z",
        "retried_count": 0,
        "error_message": None,
    }]
    with patch("src.activities.briefing._call_clerk", side_effect=fake_clerk):
        path = await compose_and_write_briefing(
            slot="morning",
            window_start_iso="2026-05-12T18:00:00Z",
            window_end_iso="2026-05-13T07:00:00Z",
            visit_results=visit_results,
            prior_briefing_path="briefing/2026-05-12-evening.md",
        )

    assert path.startswith("briefing/")
    assert path.endswith("-morning.md")
    # The composer prompt must include the POST-MUTATION text — proves
    # it re-read the matter rather than reusing a pre-mutation snapshot.
    assert any("POST-MUTATION" in p for p in captured_prompts)
    # The write went through ctrl-api with record_type=briefing.
    assert fake_vault.write_calls
    rtype, name, content = fake_vault.write_calls[0]
    assert rtype == "briefing"
    assert name.endswith("-morning")
    assert "record_type: briefing" in content
    assert "slot: morning" in content
    assert "composed_at: 2026-05-13T07:00:00Z" in content
    assert "prior_briefing: briefing/2026-05-12-evening.md" in content


# ---------------------------------------------------------------------------
# BriefingWorkflow integration — 3 matters: 2 mutate, 1 no-change
# ---------------------------------------------------------------------------


async def test_briefing_workflow_three_matters_two_mutate_one_no_change(
    fake_vault, install_transport, monkeypatch
):
    """End-to-end BriefingWorkflow simulation.

    We exercise the workflow's run logic by invoking the underlying
    activities in sequence (the workflow itself is a thin orchestrator;
    the meaningful behavior lives in the activities). For a true
    workflow replay test we'd need a Temporal test environment; the
    activity-level integration here proves the contract that matters:
    Phase 1 → Phase 2 with two-phase read-after-write.
    """
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    monkeypatch.setenv("AAS_API_KEY", "test-key")

    # Three active matters — two will mutate via the propose clerk
    # returning JSON, one will return NO_CHANGE.
    alpha = _matter_record("alpha")
    beta = _matter_record("beta")
    gamma = _matter_record("gamma")
    fake_vault.records_by_type["matter"] = [alpha, beta, gamma]
    fake_vault.records_by_path["matter/alpha.md"] = {
        "frontmatter": dict(alpha["frontmatter"]),
        "body": "",
    }
    fake_vault.records_by_path["matter/beta.md"] = {
        "frontmatter": dict(beta["frontmatter"]),
        "body": "",
    }
    fake_vault.records_by_path["matter/gamma.md"] = {
        "frontmatter": dict(gamma["frontmatter"]),
        "body": "",
    }
    # Some signals so the propose function actually invokes the clerk.
    fake_vault.records_by_type["signal"] = [
        _signal_record("signal/a.md", "matter/alpha.md", "2026-05-13T06:00:00Z"),
        _signal_record("signal/b.md", "matter/beta.md", "2026-05-13T06:05:00Z"),
        _signal_record("signal/g.md", "matter/gamma.md", "2026-05-13T06:10:00Z"),
    ]
    fake_vault.records_by_type["decision"] = []
    fake_vault.records_by_type["briefing"] = []  # first morning briefing

    # Script the v2 round-trip responses per matter — alpha + beta get
    # OK responses, gamma gets nothing (propose returns None → no POST).
    install_transport.queue(
        "matter/alpha.md",
        _ok_state_change_response(
            "event/state-change-alpha.md", "2026-05-13T07:00:00Z",
        ),
    )
    install_transport.queue(
        "matter/beta.md",
        _ok_state_change_response(
            "event/state-change-beta.md", "2026-05-13T07:00:00Z",
        ),
    )

    # Clerk responses per matter (propose pass) + one composition pass.
    clerk_calls: list[str] = []

    async def fake_clerk(prompt: str, raw: bool = False) -> str:  # noqa: ARG001
        clerk_calls.append(prompt)
        if "MATTER: alpha" in prompt:
            return json.dumps({
                "narrative": "Alpha moved — buyer offer arrived.",
                "confidence": 0.9,
            })
        if "MATTER: beta" in prompt:
            return json.dumps({
                "narrative": "Beta moved — vendor sent revised quote.",
                "confidence": 0.88,
            })
        if "MATTER: gamma" in prompt:
            return "NO_CHANGE"
        # Composition pass — referenced by the absence of MATTER: in the
        # propose prompt; the composer prompt mentions WINDOW: + matter
        # snapshots as JSON.
        return "Sir — three matters were reviewed; two moved."

    with patch("src.activities.briefing._call_clerk", side_effect=fake_clerk):
        # Phase 1 — visit each matter.
        visits = []
        for mp in ["matter/alpha.md", "matter/beta.md", "matter/gamma.md"]:
            out = await briefing_visit_matter(
                matter_path=mp,
                slot="morning",
                window_start_iso="2026-05-12T18:00:00Z",
                window_end_iso="2026-05-13T07:00:00Z",
                prior_briefing_path=None,
            )
            visits.append(out)
            # Simulate ctrl-api's atomic write — patch our fake's
            # records_by_path to reflect the mutated current_state so
            # Phase 2's read sees POST-mutation state.
            if out["state_changed"]:
                if mp == "matter/alpha.md":
                    fake_vault.records_by_path[mp]["frontmatter"]["current_state"] = (
                        "Alpha moved — buyer offer arrived."
                    )
                elif mp == "matter/beta.md":
                    fake_vault.records_by_path[mp]["frontmatter"]["current_state"] = (
                        "Beta moved — vendor sent revised quote."
                    )
                fake_vault.records_by_path[mp]["frontmatter"]["as_of"] = (
                    "2026-05-13T07:00:00Z"
                )

        # Phase 2 — compose.
        brief_path = await compose_and_write_briefing(
            slot="morning",
            window_start_iso="2026-05-12T18:00:00Z",
            window_end_iso="2026-05-13T07:00:00Z",
            visit_results=visits,
            prior_briefing_path=None,
        )

    # Assertions on Phase 1 outcomes:
    assert visits[0]["state_changed"] is True
    assert visits[0]["audit_record_path"] == "event/state-change-alpha.md"
    assert visits[1]["state_changed"] is True
    assert visits[1]["audit_record_path"] == "event/state-change-beta.md"
    assert visits[2]["state_changed"] is False
    assert visits[2]["audit_record_path"] is None
    assert visits[2]["error_message"] is None

    # Exactly two POSTs to /api/v1/state-changes (alpha + beta).
    posted_targets = [r["target_path"] for r in install_transport.requests]
    assert posted_targets == ["matter/alpha.md", "matter/beta.md"]
    # Both envelopes carry source=briefing.morning + the briefing fields.
    for req in install_transport.requests:
        assert req["source"] == "briefing.morning"
        assert "last_briefing_at" in req["fields"]
        assert "current_state" in req["fields"]
        assert "as_of" in req["fields"]

    # Phase 2 wrote the briefing snapshot.
    assert brief_path.endswith("-morning.md")
    assert fake_vault.write_calls
    rtype, _name, content = fake_vault.write_calls[-1]
    assert rtype == "briefing"
    assert "state_changes_count: 2" in content
    assert "observed_matters_count: 3" in content
    # The composition pass re-read every matter post-mutation.
    composition_prompts = [
        p for p in clerk_calls if "WINDOW:" in p
    ]
    assert len(composition_prompts) == 1
    # The composition prompt sees the post-mutation paragraphs. The
    # composer json-dumps the snapshot block, which escapes non-ASCII
    # (em-dash → —), so we check for ascii-safe substrings.
    assert "Alpha moved" in composition_prompts[0]
    assert "buyer offer arrived" in composition_prompts[0]
    assert "Beta moved" in composition_prompts[0]
    assert "vendor sent revised quote" in composition_prompts[0]


# ---------------------------------------------------------------------------
# briefing_visit_matter — invalid path safely returns error
# ---------------------------------------------------------------------------


async def test_briefing_visit_matter_invalid_path(fake_vault):
    out = await briefing_visit_matter(
        matter_path="not-a-matter-path",
        slot="morning",
        window_start_iso="2026-05-12T18:00:00Z",
        window_end_iso="2026-05-13T07:00:00Z",
    )
    assert out["applied"] is False
    assert out["state_changed"] is False
    assert out["error_message"] == "invalid matter_path"
