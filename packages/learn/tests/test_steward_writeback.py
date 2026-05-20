"""Unit tests for the RFC #884 steward writeback (Deliverable 3).

Every time ``apply_state_change`` actually shifts a task's ``state``
field it must also stamp:

  * ``current_state`` — one deterministic sentence (no LLM call) of
    the form ``"<Label> — <what> on <YYYY-MM-DD>."``,
  * ``as_of`` — the same ISO timestamp the audit record uses.

When the decision is ``still_active`` (or any path that doesn't write
``state``), the writeback must NOT fire so a meaningful narrative
from the last real transition is preserved.

We reuse the existing FakeVaultClient pattern from
``test_steward_apply_state_change.py`` — both tests live in the same
package so a small duplication keeps each test file self-contained.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from src.activities.steward import (
    _compose_task_current_state,
    apply_state_change,
)


class FakeVaultClient:
    """Stand-in for utils.vault_client.VaultClient."""

    def __init__(
        self,
        task_fm: dict[str, Any] | None = None,
        matter_fm: dict[str, Any] | None = None,
        plane_post_response: dict[str, Any] | None = None,
    ) -> None:
        self.task_fm = task_fm or {}
        self.matter_fm = matter_fm or {}
        self.plane_post_response = plane_post_response
        self.write_record_calls: list[tuple[str, str, str]] = []
        self.patch_structured_calls: list[dict[str, Any]] = []
        self.patch_scalar_calls: list[dict[str, Any]] = []

    async def close(self) -> None:
        pass

    async def read_record(self, path: str) -> dict[str, Any]:
        if path.startswith("task/"):
            return {"frontmatter": dict(self.task_fm), "body": ""}
        if path.startswith("matter/"):
            return {"frontmatter": dict(self.matter_fm), "body": ""}
        return {"frontmatter": {}, "body": ""}

    async def write_record(self, record_type: str, name: str, content: str) -> str:
        self.write_record_calls.append((record_type, name, content))
        return f"{record_type}/{name}.md"

    async def patch_frontmatter_structured(
        self,
        path: str,
        scalar_updates: dict[str, Any] | None = None,
        json_updates: dict[str, Any] | None = None,
    ) -> None:
        self.patch_structured_calls.append(
            {"path": path, "scalar": scalar_updates, "json": json_updates}
        )

    async def patch_frontmatter(self, path: str, updates: dict[str, Any]) -> None:
        self.patch_scalar_calls.append({"path": path, "updates": updates})

    async def plane_post_steward_action(self, **kwargs: Any) -> dict[str, Any]:
        return self.plane_post_response or {
            "ok": True,
            "comment_id": "comment-123",
            "transitioned_to_state_id": "state-done",
            "transitioned_to_state_group": "completed",
            "prior_state_id": "state-started",
            "prior_archived": False,
            "archived": False,
        }


@pytest.fixture
def fake_vault_factory():
    def _make(**kwargs):
        fake = FakeVaultClient(**kwargs)
        ctx = patch("src.activities.steward.VaultClient", return_value=fake)
        ctx.start()
        return fake, ctx

    return _make


def _decision(
    *,
    decision: str = "likely_done",
    confidence: float = 0.95,
    reasoning: str = "Stripe payment confirmation matched invoice",
    evidence: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "decision": decision,
        "confidence": confidence,
        "reasoning": reasoning,
        "evidence": evidence or [{"source": "vault:record", "ref": "edit-1"}],
        "source_contributions": {"vault:record": confidence},
    }


# ---------------------------------------------------------------------------
# _compose_task_current_state — deterministic composer
# ---------------------------------------------------------------------------


def test_compose_uses_action_proposal_when_present():
    decision = {
        "evidence": [
            {
                "action_proposal": {
                    "what": "picked up the Carter sprint deck from your inbox at 09:14",
                },
            }
        ],
        "reasoning": "Should not be used because action_proposal wins.",
    }
    out = _compose_task_current_state(
        new_state="in_progress",
        decision=decision,
        now_iso="2026-05-11T09:14:00+00:00",
    )
    assert out.startswith("In progress — picked up the Carter sprint deck")
    assert out.endswith("on 2026-05-11.")


def test_compose_falls_back_to_reasoning_first_12_words():
    decision = {
        "reasoning": "Stripe sent a payment confirmation matching the invoice today and the bank shows the matching transaction.",
    }
    out = _compose_task_current_state(
        new_state="done",
        decision=decision,
        now_iso="2026-05-11T12:00:00+00:00",
    )
    # First 12 words of reasoning, trailing punctuation stripped.
    assert out.startswith("Done — Stripe sent a payment confirmation matching the invoice today and the bank")
    assert "matching transaction" not in out  # reasoning truncated at 12 words
    assert out.endswith("on 2026-05-11.")


def test_compose_returns_terminal_fallback_when_no_inputs():
    out = _compose_task_current_state(
        new_state="pending", decision=None, now_iso="2026-05-11T12:00:00+00:00"
    )
    assert out == "Pending — state updated on 2026-05-11."


def test_compose_caps_at_200_chars():
    decision = {"reasoning": "x " * 400}
    out = _compose_task_current_state(
        new_state="done", decision=decision, now_iso="2026-05-11T12:00:00+00:00"
    )
    assert len(out) <= 200


# ---------------------------------------------------------------------------
# apply_state_change — writeback fires on state transition
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pending_to_in_progress_writeback_stamps_both_fields(
    fake_vault_factory, monkeypatch
):
    """A live-mode state transition writes both ``state`` and
    ``current_state`` (plus ``as_of``)."""
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    monkeypatch.setenv("STEWARD_CONFIDENCE_THRESHOLD", "0.6")
    fake, ctx = fake_vault_factory(
        task_fm={
            "state": "pending",
            "plane_issue_id": "issue-1",
            "parent_matter": "matter/client-x.md",
        },
        matter_fm={"plane_project_id": "project-uuid"},
    )
    try:
        result = await apply_state_change(
            "task/foo.md",
            _decision(decision="likely_done", confidence=0.95),
            {"count": 1},
            mode="live",
        )
    finally:
        ctx.stop()

    assert result["live_action_taken"] is True
    assert len(fake.patch_structured_calls) == 1
    scalars = fake.patch_structured_calls[0]["scalar"]
    # The state transition itself.
    assert scalars["state"] == "done"
    # The writeback fields.
    assert "current_state" in scalars
    assert scalars["current_state"].startswith("Done — ")
    assert "as_of" in scalars
    # as_of and last_steward_check_at should be the same ISO instant.
    assert scalars["as_of"] == scalars["last_steward_check_at"]


@pytest.mark.asyncio
async def test_archive_decision_also_writes_current_state(
    fake_vault_factory, monkeypatch
):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    monkeypatch.setenv("STEWARD_CONFIDENCE_THRESHOLD", "0.6")
    fake, ctx = fake_vault_factory(
        task_fm={
            "state": "open",
            "plane_issue_id": "issue-1",
            "parent_matter": "matter/client-x.md",
        },
        matter_fm={"plane_project_id": "project-uuid"},
    )
    try:
        await apply_state_change(
            "task/foo.md",
            _decision(decision="stale_archive_candidate", confidence=0.95),
            {"count": 1},
            mode="live",
        )
    finally:
        ctx.stop()

    scalars = fake.patch_structured_calls[0]["scalar"]
    assert scalars["state"] == "archived"
    assert scalars["current_state"].startswith("Archived — ")
    assert "as_of" in scalars


@pytest.mark.asyncio
async def test_still_active_no_writeback(fake_vault_factory, monkeypatch):
    """still_active decision must not patch current_state — the prior
    narrative from the last real transition is preserved."""
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    monkeypatch.setenv("STEWARD_CONFIDENCE_THRESHOLD", "0.6")
    fake, ctx = fake_vault_factory(
        task_fm={
            "state": "open",
            "plane_issue_id": "issue-1",
            "parent_matter": "matter/client-x.md",
        },
        matter_fm={"plane_project_id": "project-uuid"},
    )
    try:
        await apply_state_change(
            "task/foo.md",
            _decision(decision="still_active", confidence=0.95),
            {"count": 1},
            mode="live",
        )
    finally:
        ctx.stop()

    # Live patch fired (pending_confirmation cleared, last_steward_outcome
    # bumped), but ``state`` was not written so the writeback fields are
    # absent. Critical: no current_state on this scalars dict.
    assert len(fake.patch_structured_calls) == 1
    scalars = fake.patch_structured_calls[0]["scalar"]
    assert "state" not in scalars
    assert "current_state" not in scalars
    assert "as_of" not in scalars


@pytest.mark.asyncio
async def test_low_confidence_pending_confirmation_no_writeback(
    fake_vault_factory, monkeypatch
):
    """Below-threshold decisions land as pending_confirmation: no state
    transition, no current_state writeback."""
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    monkeypatch.setenv("STEWARD_CONFIDENCE_THRESHOLD", "0.6")
    fake, ctx = fake_vault_factory(
        task_fm={
            "state": "open",
            "plane_issue_id": "issue-1",
        },
    )
    try:
        await apply_state_change(
            "task/foo.md",
            _decision(decision="likely_done", confidence=0.3),
            {"count": 1},
            mode="live",
        )
    finally:
        ctx.stop()

    scalars = fake.patch_structured_calls[0]["scalar"]
    assert scalars["pending_confirmation"] is True
    assert "state" not in scalars
    assert "current_state" not in scalars
    assert "as_of" not in scalars


@pytest.mark.asyncio
async def test_shadow_mode_no_writeback(fake_vault_factory):
    """Shadow mode never patches the task — writeback fields absent."""
    fake, ctx = fake_vault_factory(
        task_fm={"state": "open", "plane_issue_id": "issue-1"},
    )
    try:
        await apply_state_change(
            "task/foo.md",
            _decision(decision="likely_done", confidence=0.95),
            {"count": 1},
            mode="shadow",
        )
    finally:
        ctx.stop()

    # No vault patches in shadow mode.
    assert fake.patch_structured_calls == []
    assert fake.patch_scalar_calls == []


@pytest.mark.asyncio
async def test_matter_target_does_not_get_writeback(
    fake_vault_factory, monkeypatch
):
    """Matter targets are governed by the nightly_narrative workflow —
    apply_state_change must NOT stamp the writeback fields on matters."""
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    monkeypatch.setenv("STEWARD_CONFIDENCE_THRESHOLD", "0.6")
    fake, ctx = fake_vault_factory(
        matter_fm={"state": "active"},
    )
    try:
        await apply_state_change(
            "matter/carter.md",
            _decision(decision="likely_done", confidence=0.95),
            {"count": 1},
            mode="live",
            target_kind="matter",
        )
    finally:
        ctx.stop()

    # Matter targets STILL get state mutated (likely_done -> state=done)
    # but the writeback fields belong to the nightly_narrative path.
    assert len(fake.patch_structured_calls) == 1
    scalars = fake.patch_structured_calls[0]["scalar"]
    assert scalars["state"] == "done"
    assert "current_state" not in scalars
    assert "as_of" not in scalars
