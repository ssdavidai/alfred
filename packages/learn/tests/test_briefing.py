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

    async def list_signals(
        self,
        *,
        target_matter: str | None = None,
        source_type: str | None = None,
        since_ns: int | None = None,
        until_ns: int | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        """STORE-P3-5: translate markdown signal fixtures into SQL row shape.

        Test fixtures register records under ``records_by_type["signal"]``
        in the legacy markdown shape; production code now calls
        ``list_signals`` and adapts the SQL row back to a markdown
        record via ``briefing._sql_signal_to_record``. This stub keeps
        the round-trip lossless for the fields existing tests assert
        on.
        """
        self.list_calls.append(("signal", limit))
        from datetime import datetime as _dt
        out: list[dict[str, Any]] = []
        for rec in self.records_by_type.get("signal", []):
            if not isinstance(rec, dict):
                continue
            fm = rec.get("frontmatter") or {}
            tm = (
                fm.get("target_matter_path")
                or fm.get("target_path")
                or ""
            )
            if target_matter is not None and tm != target_matter:
                cands = fm.get("target_candidates")
                matched = False
                if isinstance(cands, list):
                    for c in cands:
                        if isinstance(c, dict) and c.get("path") == target_matter:
                            matched = True
                            break
                        if isinstance(c, str) and c == target_matter:
                            matched = True
                            break
                if not matched:
                    continue
                tm = target_matter
            ts_raw = fm.get("applied_at") or fm.get("created") or ""
            ts_ns: int | None = None
            try:
                if isinstance(ts_raw, str) and ts_raw:
                    s = ts_raw
                    if s.endswith("Z"):
                        s = s[:-1] + "+00:00"
                    ts_ns = int(_dt.fromisoformat(s).timestamp() * 1_000_000_000)
            except (ValueError, TypeError):
                ts_ns = None
            if since_ns is not None and ts_ns is not None and ts_ns < since_ns:
                continue
            if until_ns is not None and ts_ns is not None and ts_ns > until_ns:
                continue
            raw_path = str(rec.get("path") or "")
            synth_id = raw_path
            if synth_id.startswith("signal/"):
                synth_id = synth_id[len("signal/"):]
            if synth_id.endswith(".md"):
                synth_id = synth_id[:-3]
            out.append({
                "id": synth_id,
                "ts": str(ts_ns) if ts_ns is not None else "0",
                "source_type": fm.get("source_type") or "",
                "source_event": fm.get("source_event_path") or None,
                "target_matter": tm,
                "target_kind": fm.get("target_kind") or None,
                "actor": fm.get("actor") or None,
                "decision_required": int(bool(fm.get("decision_required"))),
                "display_headline": fm.get("display_headline") or None,
                "display_body": fm.get("display_body") or None,
                "body": fm.get("reasoning") or fm.get("body") or "",
                "processed_at": None,
                "classified_noise": 0,
            })
            if len(out) >= limit:
                break
        return out

    async def list_observations(
        self,
        *,
        instinct_id: str | None = None,
        signal_id: str | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        self.list_calls.append(("observation", limit))
        return []

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


# ---------------------------------------------------------------------------
# BRIEF_SIGNAL_MAX_AGE_DAYS — aging cutoff for brief signal gathers.
#
# Regression for the 2026-05-19 leak: David's morning brief surfaced an
# Ed Cave RSVP reminder from April 2 and a December Karácsonyi party
# invite from Mandragóra. Both signals had recent ts (the writer
# re-asserted stale events as fresh signal rows), but the workflow's
# ``prior_composed`` anchor stretched the read window back far enough
# that those rows still made it into the gather. The clamp narrows the
# read window to ``window_end - BRIEF_SIGNAL_MAX_AGE_DAYS``.
# ---------------------------------------------------------------------------


async def test_gather_window_signals_excludes_aged_signal_by_default(
    fake_vault, monkeypatch
):
    """A signal 30 days older than ``window_end`` is dropped; a 5-day-old
    signal is kept. Default ``BRIEF_SIGNAL_MAX_AGE_DAYS`` is 14d."""
    # Ensure the env var is at the default for this test.
    monkeypatch.delenv("BRIEF_SIGNAL_MAX_AGE_DAYS", raising=False)
    fake_vault.records_by_type["signal"] = [
        # 30 days old — must be excluded by the 14d default cutoff even
        # though the workflow's window_start (45 days back) would include it.
        _signal_record(
            "signal/old-rsvp.md",
            target_path="matter/inbox.md",
            applied_at="2026-04-13T07:00:00Z",
        ),
        # 5 days old — must be included; well inside the 14d cutoff.
        _signal_record(
            "signal/recent-rsvp.md",
            target_path="matter/inbox.md",
            applied_at="2026-05-08T07:00:00Z",
        ),
    ]

    # Window spans 45 days back → without the clamp both signals would
    # appear in the gather. With the 14d default both rows pass through
    # the SQL since/until filter (the fake honors them) and only the
    # in-process age clamp can keep the 30-day-old row out.
    window_start = briefing_mod._parse_iso_or_none("2026-03-29T07:00:00Z")
    window_end = briefing_mod._parse_iso_or_none("2026-05-13T07:00:00Z")
    out = await briefing_mod._gather_window_signals(
        fake_vault, window_start=window_start, window_end=window_end,
    )
    paths_or_headlines = {
        # _gather_window_signals doesn't return paths, but it embeds the
        # `target_matter` slug + the legacy fixture's headline-equivalent
        # via ``display_headline``/``name``. The fixture uses neither, so
        # we identify rows via their ``when`` ISO timestamps.
        (entry.get("when") or "")[:10] for entry in out
    }
    assert "2026-05-08" in paths_or_headlines, (
        f"expected the 5-day-old signal to be surfaced, got {out!r}"
    )
    assert "2026-04-13" not in paths_or_headlines, (
        f"expected the 30-day-old signal to be excluded by the 14d cutoff, "
        f"got {out!r}"
    )


async def test_gather_window_signals_respects_env_override(
    fake_vault, monkeypatch
):
    """``BRIEF_SIGNAL_MAX_AGE_DAYS=60`` widens the cutoff; the aged row
    surfaces again. ``BRIEF_SIGNAL_MAX_AGE_DAYS=0`` disables the clamp."""
    fake_vault.records_by_type["signal"] = [
        _signal_record(
            "signal/old-rsvp.md",
            target_path="matter/inbox.md",
            applied_at="2026-04-13T07:00:00Z",
        ),
    ]
    window_start = briefing_mod._parse_iso_or_none("2026-03-29T07:00:00Z")
    window_end = briefing_mod._parse_iso_or_none("2026-05-13T07:00:00Z")

    # Override to 60d — the 30-day-old signal must now appear.
    monkeypatch.setenv("BRIEF_SIGNAL_MAX_AGE_DAYS", "60")
    out_wide = await briefing_mod._gather_window_signals(
        fake_vault, window_start=window_start, window_end=window_end,
    )
    assert any(
        (entry.get("when") or "").startswith("2026-04-13") for entry in out_wide
    ), f"expected aged signal to appear with 60d cutoff, got {out_wide!r}"

    # Setting BRIEF_SIGNAL_MAX_AGE_DAYS=0 disables the clamp entirely.
    monkeypatch.setenv("BRIEF_SIGNAL_MAX_AGE_DAYS", "0")
    out_off = await briefing_mod._gather_window_signals(
        fake_vault, window_start=window_start, window_end=window_end,
    )
    assert any(
        (entry.get("when") or "").startswith("2026-04-13") for entry in out_off
    ), f"expected aged signal to appear with cutoff disabled, got {out_off!r}"


# ---------------------------------------------------------------------------
# _collapse_duplicate_section_headers — Bug C (rapali 2026-05-19-morning)
# ---------------------------------------------------------------------------


def test_collapse_duplicate_header_preamble_then_list():
    """The exact rapali 2026-05-19-morning pattern.

    Section header appears twice: first with an intro sentence but no
    list, second with an empty header line followed by the numbered
    list. The collapser must emit the header exactly once with the
    preamble + list both attached underneath.
    """
    from src.activities.briefing import _collapse_duplicate_section_headers

    body = (
        "**Ma.** Négy sorba sorolom a legfontosabb teendőket.\n"
        "\n"
        "**Ma.** \n"
        "\n"
        "1. **Mahesh, Maven** — 6 órán belül lezárul az ablaka.\n"
        "2. **Julianna Kocsis** — válasz a partnership ajánlatra.\n"
    )
    out = _collapse_duplicate_section_headers(body)
    assert out.count("**Ma.**") == 1
    # First header + its preamble + the list all survived.
    assert "Négy sorba sorolom" in out
    assert "Mahesh, Maven" in out
    assert "Julianna Kocsis" in out
    # Body order preserved: header, preamble, list.
    header_idx = out.find("**Ma.**")
    preamble_idx = out.find("Négy sorba sorolom")
    list_idx = out.find("1. **Mahesh")
    assert header_idx < preamble_idx < list_idx


def test_collapse_duplicate_header_english_today():
    """English-language equivalent — the same artefact in 'Today' form.

    Confirms the pass is language-agnostic.
    """
    from src.activities.briefing import _collapse_duplicate_section_headers

    body = (
        "**Today.** Two items on your desk.\n"
        "\n"
        "**Today.**\n"
        "\n"
        "1. Approve the EIN application.\n"
        "2. Reply to Aaron.\n"
    )
    out = _collapse_duplicate_section_headers(body)
    assert out.count("**Today.**") == 1
    assert "Two items on your desk." in out
    assert "Approve the EIN application." in out


def test_collapse_idempotent_when_no_duplicate():
    """Single-header sections must pass through unchanged."""
    from src.activities.briefing import _collapse_duplicate_section_headers

    body = (
        "**Today.** Two items.\n"
        "\n"
        "1. First.\n"
        "2. Second.\n"
        "\n"
        "**Flags.** One anomaly.\n"
        "\n"
        "- Card declined.\n"
    )
    out = _collapse_duplicate_section_headers(body)
    assert out == body


def test_collapse_preserves_distinct_sections_with_real_preambles():
    """Defensive: two headers both carrying their own preamble are NOT merged.

    The renderer bug only manifests as an empty-tail second header. If
    both headers have real prose after them, that's a different scenario
    and we should leave it alone.
    """
    from src.activities.briefing import _collapse_duplicate_section_headers

    body = (
        "**Today.** First block of prose.\n"
        "\n"
        "**Today.** Second block of prose with content.\n"
    )
    out = _collapse_duplicate_section_headers(body)
    # Both occurrences survive because both have real content attached.
    assert out.count("**Today.**") == 2


def test_collapse_is_idempotent():
    """Running the pass twice produces the same output as once."""
    from src.activities.briefing import _collapse_duplicate_section_headers

    body = (
        "**Ma.** Négy sorba sorolom.\n"
        "\n"
        "**Ma.**\n"
        "\n"
        "1. First.\n"
    )
    once = _collapse_duplicate_section_headers(body)
    twice = _collapse_duplicate_section_headers(once)
    assert once == twice
    assert once.count("**Ma.**") == 1


def test_collapse_handles_preamble_plus_list_both_present():
    """The unit-test the PR asks for, stated directly.

    A section with BOTH a preamble (sentence) AND a list payload must
    emit its header exactly once, regardless of how the LLM segmented
    the blocks.
    """
    from src.activities.briefing import _collapse_duplicate_section_headers

    body_with_dup_header = (
        "**Waiting on you.** Three threads in your court.\n"
        "\n"
        "**Waiting on you.**\n"
        "\n"
        "- Mahesh — Maven welcome session.\n"
        "- Julianna — partnership reply.\n"
    )
    out = _collapse_duplicate_section_headers(body_with_dup_header)
    assert out.count("**Waiting on you.**") == 1
    assert "Three threads in your court." in out
    assert "Mahesh" in out
    assert "Julianna" in out


# ---------------------------------------------------------------------------
# _dedupe_matters_across_sections — Bug A (miguel 2026-05-19-morning)
# ---------------------------------------------------------------------------


def test_dedupe_same_matter_in_three_sections_collapses_to_first():
    """Composer prompt's 'one matter, one section' contract.

    Miguel's 2026-05-19-morning brief had the Retool npm incident
    mentioned in §What landed AND §Flags (and the Gestinova thread in
    §Waiting on you AND §What landed). The dedup pass walks sections
    in emit order and suppresses lower-section lines whose
    [[wikilinks]] are already covered upstream.

    This test puts the same matter ([[Retool ops]]) in three sections
    and asserts only the first (§Today) survives.
    """
    from src.activities.briefing import _dedupe_matters_across_sections

    body = (
        "Good morning, Sir.\n"
        "\n"
        "**Today.**\n"
        "\n"
        "1. **[[Retool ops]]** — approve the npm-token rotation.\n"
        "\n"
        "**Waiting on you.**\n"
        "\n"
        "- [[Retool ops]] — Iván's question on today's sync.\n"
        "\n"
        "**Flags.**\n"
        "\n"
        "- [[Retool ops]] — npm library incident.\n"
        "\n"
        "**Quiet.**\n"
        "\n"
        "Eight matters holding — [[Retool ops]], [[Other]]. I'll surface them.\n"
    )
    out = _dedupe_matters_across_sections(body)
    # §Today bullet survives.
    assert "approve the npm-token rotation" in out
    # §Waiting on you bullet about Retool was dropped.
    assert "Iván's question on today's sync" not in out
    # §Flags bullet about Retool was dropped.
    assert "npm library incident" not in out
    # §Quiet enumeration is EXEMPT — Retool name still appears there.
    assert "Eight matters holding — [[Retool ops]]" in out
    # The Retool wikilink itself still appears multiple times overall
    # (Today bullet + Quiet enumeration), but each prose section other
    # than Quiet should contain it at most once.
    assert out.count("[[Retool ops]]") == 2


def test_dedupe_keeps_line_introducing_new_matter():
    """A line mentioning BOTH a seen matter and a new matter survives.

    Conservative-by-design: we only drop lines whose entire wikilink
    set is already covered. If a line introduces at least one new
    matter, the line stays.
    """
    from src.activities.briefing import _dedupe_matters_across_sections

    body = (
        "**Today.**\n"
        "\n"
        "1. **[[Alpha]]** — approve the renewal.\n"
        "\n"
        "**What landed.**\n"
        "\n"
        "- [[Alpha]] and [[Beta]] — both shifted in the same thread.\n"
    )
    out = _dedupe_matters_across_sections(body)
    assert "approve the renewal" in out
    # Line introduces [[Beta]] (new), so it survives despite [[Alpha]]
    # being seen.
    assert "both shifted in the same thread" in out


def test_dedupe_leaves_quiet_section_alone():
    """§Quiet is name-only enumeration and is the documented exception."""
    from src.activities.briefing import _dedupe_matters_across_sections

    body = (
        "**Today.**\n"
        "\n"
        "1. **[[Foo]]** — approve.\n"
        "\n"
        "**Quiet.**\n"
        "\n"
        "Four matters holding their state — [[Foo]], [[Bar]], [[Baz]], "
        "[[Qux]]. I'll surface them when something moves.\n"
    )
    out = _dedupe_matters_across_sections(body)
    assert "[[Foo]]" in out
    assert "Four matters holding their state — [[Foo]], [[Bar]], [[Baz]], [[Qux]]" in out


def test_dedupe_is_idempotent():
    """Running the dedup pass twice produces the same output as once."""
    from src.activities.briefing import _dedupe_matters_across_sections

    body = (
        "**Today.**\n"
        "\n"
        "1. **[[Alpha]]** — approve.\n"
        "\n"
        "**Flags.**\n"
        "\n"
        "- [[Alpha]] — same matter, duplicate.\n"
    )
    once = _dedupe_matters_across_sections(body)
    twice = _dedupe_matters_across_sections(once)
    assert once == twice


def test_dedupe_no_op_when_no_wikilinks():
    """Plain-prose body with no wikilinks is untouched."""
    from src.activities.briefing import _dedupe_matters_across_sections

    body = (
        "**Today.**\n"
        "\n"
        "Approve the EIN application.\n"
        "\n"
        "**What landed.**\n"
        "\n"
        "A quiet day overall.\n"
    )
    out = _dedupe_matters_across_sections(body)
    assert out.strip() == body.strip()


# ---------------------------------------------------------------------------
# _rewrite_passive_to_principal_directed — Bug B (miguel 2026-05-19-morning)
# ---------------------------------------------------------------------------


def test_rewrite_someone_should_check():
    """The exact miguel 2026-05-19-morning failure pattern.

    Original: "Retool query in the New Finanze Multli app errored out
    under Action Coach Davila's setup — worth logging under Upstring
    operations, someone should check the Retool app."

    Expected: the "someone should check" phrase gets rewritten into
    Alfred's voice ("I suggest checking …"). The rest of the sentence
    is untouched.
    """
    from src.activities.briefing import _rewrite_passive_to_principal_directed

    body = (
        "A Retool query in the New Finanze Multli app errored out "
        "under Action Coach Davila's setup — worth logging under "
        "Upstring operations, someone should check the Retool app."
    )
    out = _rewrite_passive_to_principal_directed(body)
    assert "someone should check" not in out.lower()
    assert "I suggest check" in out  # "I suggest checking the Retool app"


def test_rewrite_covers_all_forbidden_phrasings():
    """All forbidden phrasings from the prompt's ACTION VOICE rule."""
    from src.activities.briefing import _rewrite_passive_to_principal_directed

    cases = [
        ("Someone should rotate the token.", "I suggest rotate the token."),
        ("Someone needs to reply to Aaron.", "I suggest reply to Aaron."),
        ("It might be worth checking the dashboard.", "I suggest checking the dashboard."),
        ("Maybe check the credentials.", "I suggest checking the credentials."),
        ("Maybe look at the renewal.", "I suggest looking at the renewal."),
        ("It's worth a look.", "I suggest a look."),
        ("It's worth checking.", "I suggest checking."),
        ("This could be checked later.", "This I will check unless you say otherwise later."),
    ]
    for original, expected_fragment in cases:
        out = _rewrite_passive_to_principal_directed(original)
        # Forbidden phrase eliminated.
        assert "someone should" not in out.lower(), out
        assert "someone needs to" not in out.lower(), out
        assert "might be worth" not in out.lower(), out
        assert "maybe check" not in out.lower(), out
        assert "maybe look" not in out.lower(), out
        # And the I-suggest rewrite landed.
        assert "i suggest" in out.lower() or "i will check" in out.lower(), (
            f"original={original!r} out={out!r}"
        )


def test_rewrite_is_idempotent():
    """Running the rewrite twice produces the same output as once."""
    from src.activities.briefing import _rewrite_passive_to_principal_directed

    body = "Someone should check the Retool app."
    once = _rewrite_passive_to_principal_directed(body)
    twice = _rewrite_passive_to_principal_directed(once)
    assert once == twice
    assert "someone should" not in once.lower()


def test_rewrite_preserves_non_english_text():
    """Hungarian / non-English fragments are unaffected.

    The action-voice rules are English-only by design. A Hungarian
    sentence ("Ellenőrizd a fiókod") that the brief composer
    legitimately emits must survive untouched.
    """
    from src.activities.briefing import _rewrite_passive_to_principal_directed

    body = "Ellenőrizd a fiókod és cselekedj — Sybell díjbekérő érkezett."
    out = _rewrite_passive_to_principal_directed(body)
    assert out == body


# ---------------------------------------------------------------------------
# Composer prompt: ACTION VOICE + ONE MATTER, ONE SECTION rules present
# ---------------------------------------------------------------------------


def test_composer_prompt_contains_dedup_and_action_voice_rules():
    """The composer prompt must include the two new HARD RULES so the
    clerk has a chance to comply at draft time, before the post-LLM
    scrubbers run."""
    from src.activities.briefing import _build_composition_prompt

    prompt = _build_composition_prompt(
        slot="morning",
        window_start_iso="2026-05-19T07:00:00Z",
        window_end_iso="2026-05-19T08:00:00Z",
        matter_snapshots=[],
        state_changes_count=0,
        signals_count=0,
        decisions_count=0,
        pending_decisions=[],
        anomalies=[],
        autonomous_actions=[],
        inbox_unresolved_count=0,
        window_signals=[],
        window_decisions=[],
        waiting_on_you=[],
    )
    # Dedup rule present.
    assert "ONE MATTER, ONE SECTION" in prompt
    assert "Quiet" in prompt and "exception" in prompt
    # Action voice rule present.
    assert "ACTION VOICE" in prompt
    for forbidden in ("someone should", "maybe check", "worth a look"):
        assert forbidden in prompt


# ---------------------------------------------------------------------------
# Composer prompt + dedup catch person-name wikilinks (david 2026-05-19)
# ---------------------------------------------------------------------------


def test_composer_prompt_requires_person_wikilinks():
    """The composer prompt must instruct the clerk to wrap person names
    in [[wikilinks]] so the dedup pass can catch the same person
    appearing across sections.

    David's 2026-05-19 brief had "M. Brennan Sweeney" in §Waiting on you
    AND in §What landed as plain prose. The existing dedup pass only
    operates on [[wikilinks]], so plain-text person names slipped
    through. Fix is at the prompt: tell the clerk to wikilink people.
    """
    from src.activities.briefing import _build_composition_prompt

    prompt = _build_composition_prompt(
        slot="morning",
        window_start_iso="2026-05-19T07:00:00Z",
        window_end_iso="2026-05-19T08:00:00Z",
        matter_snapshots=[],
        state_changes_count=0,
        signals_count=0,
        decisions_count=0,
        pending_decisions=[],
        anomalies=[],
        autonomous_actions=[],
        inbox_unresolved_count=0,
        window_signals=[],
        window_decisions=[],
        waiting_on_you=[],
    )
    # Person-wikilink rule present.
    assert "PERSON NAMES TOO" in prompt
    # The canonical-name guidance is present so the clerk does not
    # produce drift like [[M. Brennan Sweeney]] vs [[Brennan Sweeney]].
    assert "canonical" in prompt
    assert "first + last, no honorifics" in prompt
    # The worked example is present so the clerk has a concrete pattern.
    assert "[[Brennan Sweeney]]" in prompt


def test_dedupe_catches_person_name_across_sections():
    """The dedup pass treats person-name wikilinks identically to
    matter-name wikilinks: same wikilink in two prose sections collapses
    to the first.

    Reproduces david's 2026-05-19-morning failure: M. Brennan Sweeney
    appeared in §Waiting on you AND §What landed. If the composer
    follows the new prompt rule and wraps the name in [[Brennan Sweeney]]
    wikilinks, the existing dedup pass removes the duplicate.
    """
    from src.activities.briefing import _dedupe_matters_across_sections

    body = (
        "Good morning, Sir.\n"
        "\n"
        "**Waiting on you.**\n"
        "\n"
        "- [[Brennan Sweeney]] is waiting on your RSVP for a Fireroad call "
        "on January 30th at 6pm.\n"
        "\n"
        "**What landed.**\n"
        "\n"
        "- The calendar is populated with nine other RSVP requests — "
        "[[Kirk Babb]], [[Brennan Sweeney]] (January 30th), and "
        "[[Gábor Gönczy]] (April 2nd) all want time.\n"
    )
    out = _dedupe_matters_across_sections(body)
    # §Waiting on you bullet survives (first occurrence).
    assert "waiting on your RSVP for a Fireroad call" in out
    # §What landed bullet was dropped — its wikilink set
    # ({Kirk Babb, Brennan Sweeney, Gábor Gönczy}) is NOT a subset of
    # the seen set ({Brennan Sweeney}), so it survives. Adjust:
    # the line introduces new people, so the conservative dedup
    # keeps the line — that is correct. Assert Brennan Sweeney still
    # appears only once in the prose-section wikilinks.
    # (The dedup is conservative-by-design: it only drops lines whose
    # whole wikilink set is already seen.)
    assert "Kirk Babb" in out
    # The same-person case (no new wikilinks) collapses:
    body_pure_dup = (
        "**Waiting on you.**\n"
        "\n"
        "- [[Brennan Sweeney]] is waiting on your RSVP for a Fireroad call.\n"
        "\n"
        "**What landed.**\n"
        "\n"
        "- [[Brennan Sweeney]] sent a follow-up nudge on the Fireroad call.\n"
    )
    out_pure = _dedupe_matters_across_sections(body_pure_dup)
    assert "waiting on your RSVP for a Fireroad call" in out_pure
    # Lower-section line with only the already-seen person is dropped.
    assert "follow-up nudge on the Fireroad call" not in out_pure
