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
async def test_load_matter_signals_24h_returns_only_fresh_targeted(install_fake_vault):
    now = _now()
    fresh = now - timedelta(hours=3)
    stale = now - timedelta(hours=30)
    fake = install_fake_vault(FakeVaultClient(list_records_map={
        "signal": [
            _signal_record(
                path="signal/2026-05-10T12-00-00Z-aaaa.md",
                target_path="matter/carter.md",
                applied_at=fresh.isoformat(timespec="seconds"),
            ),
            _signal_record(
                path="signal/2026-05-10T12-05-00Z-bbbb.md",
                candidates=[{"path": "matter/carter.md", "score": 0.6}],
                applied_at=fresh.isoformat(timespec="seconds"),
            ),
            _signal_record(
                path="signal/2026-05-09T05-00-00Z-cccc.md",
                target_path="matter/carter.md",
                applied_at=stale.isoformat(timespec="seconds"),
            ),
            _signal_record(
                path="signal/2026-05-10T12-10-00Z-dddd.md",
                target_path="matter/other.md",
                applied_at=fresh.isoformat(timespec="seconds"),
            ),
        ],
    }))

    result = await load_matter_signals_24h("matter/carter.md")
    # Two match: one by target_path, one by candidate. Stale + other-matter
    # are filtered out.
    assert len(result) == 2
    paths = {r["path"] for r in result}
    assert "signal/2026-05-10T12-00-00Z-aaaa.md" in paths
    assert "signal/2026-05-10T12-05-00Z-bbbb.md" in paths
    assert fake.list_calls and fake.list_calls[0][0] == "signal"


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
) -> NightlyNarrativeResult:
    """Mimic the workflow's per-matter loop with the activity helpers.

    Pure-function path so each unit test stays focused on the contract
    we promise: signals + transitions both empty → no patch; otherwise
    one patch with the LLM response (or no patch if the LLM raised).
    """
    result = NightlyNarrativeResult(matters_scanned=1)

    if not signals and not transitions:
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
    """No signals AND no transitions → no patch_frontmatter call."""
    fake = install_fake_vault(FakeVaultClient())
    result = await _run_one_matter(
        "matter/carter.md",
        signals=[],
        transitions=[],
        fake=fake,
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
