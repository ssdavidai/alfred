"""Tests for ``steward.apply_state_change`` covering the Phase 3 live
cutover (#839) plus the existing Phase 0.5 shadow path.

The Phase 0.5 contract still has to hold under the new code:

* mode="shadow" never mutates the task and never posts to Plane;
* the audit record always lands in event/;
* the undo_recipe.plane_revert is null in shadow mode.

The Phase 3 contract:

* mode="live" + STEWARD_LIVE_MODE=shadow downgrades to shadow.
* mode="live" + STEWARD_LIVE_MODE=live + confidence < threshold lands as
  pending_confirmation=true on the vault, no Plane writes.
* mode="live" + STEWARD_LIVE_MODE=live + confidence >= threshold drives
  the full live path: vault patch with the new state, Plane comment +
  transition, undo_recipe.plane_revert populated.
* multi-matter dispatch fires one steward:dependency_change record per
  related_to entry.

We mock the VaultClient so the tests don't need ctrl-api running. The
mock surfaces the SAME async methods apply_state_change calls plus a
counter so the assertions can verify exact ctrl-api call shapes.
"""
from __future__ import annotations

import json
import os
from typing import Any
from unittest.mock import patch

import pytest

from src.activities.steward import apply_state_change


class FakeVaultClient:
    """Stand-in for utils.vault_client.VaultClient — captures every call."""

    def __init__(
        self,
        task_fm: dict[str, Any] | None = None,
        matter_fm: dict[str, Any] | None = None,
        plane_post_response: dict[str, Any] | None = None,
        plane_post_raises: Exception | None = None,
    ) -> None:
        self.task_fm = task_fm or {}
        self.matter_fm = matter_fm or {}
        self.plane_post_response = plane_post_response
        self.plane_post_raises = plane_post_raises
        self.write_record_calls: list[tuple[str, str, str]] = []
        self.patch_structured_calls: list[dict[str, Any]] = []
        self.patch_scalar_calls: list[dict[str, Any]] = []
        self.plane_post_calls: list[dict[str, Any]] = []
        self.plane_revert_calls: list[dict[str, Any]] = []
        self.read_calls: list[str] = []

    async def close(self) -> None:
        pass

    async def read_record(self, path: str) -> dict[str, Any]:
        self.read_calls.append(path)
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
        self.plane_post_calls.append(kwargs)
        if self.plane_post_raises:
            raise self.plane_post_raises
        return self.plane_post_response or {
            "ok": True,
            "comment_id": "comment-123",
            "transitioned_to_state_id": "state-completed",
            "transitioned_to_state_group": "completed",
            "prior_state_id": "state-started",
            "prior_archived": False,
            "archived": False,
        }

    async def plane_revert_steward_action(self, **kwargs: Any) -> dict[str, Any]:
        self.plane_revert_calls.append(kwargs)
        return {"ok": True}


@pytest.fixture
def fake_vault_factory():
    """Returns a callable that installs a FakeVaultClient via patching."""
    def _make(**kwargs):
        fake = FakeVaultClient(**kwargs)
        ctx = patch("src.activities.steward.VaultClient", return_value=fake)
        ctx.start()
        return fake, ctx
    return _make


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _decision(
    *,
    decision: str = "likely_done",
    confidence: float = 0.9,
    evidence: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "decision": decision,
        "confidence": confidence,
        "evidence": evidence or [{"source": "vault:record", "ref": "edit-1"}],
        "reasoning": "test reasoning",
        "source_contributions": {"vault:record": 0.9},
    }


def _read_audit_payload(content: str) -> dict[str, Any]:
    """Extract the JSON-as-YAML frontmatter of an audit record."""
    body = content.split("---", 2)[1]
    payload: dict[str, Any] = {}
    # parse line-by-line: scalars on their own line, nested keys followed
    # by a JSON object/array.
    lines = body.strip().split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        key, _, rest = line.partition(":")
        key = key.strip()
        rest = rest.strip()
        if rest in ("{", "[") or rest.startswith("{") or rest.startswith("["):
            # Collect until balanced. Walk forward including current rest.
            buf = rest
            depth = 0
            for ch in rest:
                if ch in "{[":
                    depth += 1
                elif ch in "}]":
                    depth -= 1
            j = i + 1
            while depth > 0 and j < len(lines):
                buf += "\n" + lines[j]
                for ch in lines[j]:
                    if ch in "{[":
                        depth += 1
                    elif ch in "}]":
                        depth -= 1
                j += 1
            payload[key] = json.loads(buf)
            i = j
        else:
            # scalar
            value = rest
            if value.startswith('"') and value.endswith('"'):
                value = value[1:-1]
            elif value == "true":
                value = True
            elif value == "false":
                value = False
            elif value == "null":
                value = None
            else:
                # Try int/float else keep string
                try:
                    if "." in value:
                        value = float(value)
                    else:
                        value = int(value)
                except ValueError:
                    pass
            payload[key] = value
            i += 1
    return payload


# ---------------------------------------------------------------------------
# Phase 0.5 contract preserved
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_shadow_mode_writes_audit_only(fake_vault_factory):
    fake, ctx = fake_vault_factory(
        task_fm={"state": "open", "plane_issue_id": "issue-1"},
    )
    try:
        result = await apply_state_change(
            "task/foo.md",
            _decision(),
            {"count": 0},
            mode="shadow",
        )
    finally:
        ctx.stop()

    assert result["mode"] == "shadow"
    assert result["live_action_taken"] is False
    assert result["pending_confirmation"] is False
    assert len(fake.write_record_calls) == 1
    # No vault patches in shadow.
    assert fake.patch_structured_calls == []
    assert fake.patch_scalar_calls == []
    # No Plane write.
    assert fake.plane_post_calls == []

    rec_type, name, content = fake.write_record_calls[0]
    assert rec_type == "event"
    assert name.startswith("steward-action-")
    payload = _read_audit_payload(content)
    assert payload["mode"] == "shadow"
    assert payload["plane_action"] is None
    assert payload["undo_recipe"]["plane_revert"] is None


@pytest.mark.asyncio
async def test_live_mode_downgraded_when_env_is_shadow(fake_vault_factory, monkeypatch):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "shadow")
    fake, ctx = fake_vault_factory(
        task_fm={"state": "open", "plane_issue_id": "issue-1"},
    )
    try:
        result = await apply_state_change(
            "task/foo.md",
            _decision(confidence=0.95),
            {"count": 1},
            mode="live",
        )
    finally:
        ctx.stop()

    # Even though caller asked for live, env vetoed it.
    assert result["mode"] == "shadow"
    assert result["live_action_taken"] is False
    # No Plane writes in shadow.
    assert fake.plane_post_calls == []
    # No vault frontmatter patches in shadow.
    assert fake.patch_structured_calls == []


# ---------------------------------------------------------------------------
# Phase 3 — confidence gating
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_low_confidence_lands_as_pending_confirmation(
    fake_vault_factory, monkeypatch
):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    monkeypatch.setenv("STEWARD_CONFIDENCE_THRESHOLD", "0.6")
    fake, ctx = fake_vault_factory(
        task_fm={"state": "open", "plane_issue_id": "issue-1"},
    )
    try:
        result = await apply_state_change(
            "task/foo.md",
            _decision(confidence=0.4),
            {"count": 1},
            mode="live",
        )
    finally:
        ctx.stop()

    assert result["mode"] == "live"
    assert result["pending_confirmation"] is True
    assert result["live_action_taken"] is False
    # No Plane post for low-confidence.
    assert fake.plane_post_calls == []
    # Vault patched with pending_confirmation=true (no state change).
    assert len(fake.patch_structured_calls) == 1
    scalars = fake.patch_structured_calls[0]["scalar"]
    assert scalars["pending_confirmation"] is True
    assert "state" not in scalars  # state untouched on pending


@pytest.mark.asyncio
async def test_high_confidence_fires_live_action(fake_vault_factory, monkeypatch):
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
        result = await apply_state_change(
            "task/foo.md",
            _decision(decision="likely_done", confidence=0.9),
            {"count": 1},
            mode="live",
        )
    finally:
        ctx.stop()

    assert result["mode"] == "live"
    assert result["live_action_taken"] is True
    assert result["pending_confirmation"] is False
    # Plane post fired.
    assert len(fake.plane_post_calls) == 1
    plane_args = fake.plane_post_calls[0]
    assert plane_args["project_id"] == "project-uuid"
    assert plane_args["issue_id"] == "issue-1"
    assert plane_args["decision"] == "likely_done"
    # Vault patched with state=done, pending_confirmation=false.
    assert len(fake.patch_structured_calls) == 1
    scalars = fake.patch_structured_calls[0]["scalar"]
    assert scalars["pending_confirmation"] is False
    assert scalars["state"] == "done"


@pytest.mark.asyncio
async def test_high_confidence_only_mode_uses_higher_threshold(
    fake_vault_factory, monkeypatch
):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live_high_confidence_only")
    # Default high threshold is 0.85 — 0.7 should land as pending.
    fake, ctx = fake_vault_factory(
        task_fm={
            "state": "open",
            "plane_issue_id": "issue-1",
            "parent_matter": "matter/client-x.md",
        },
        matter_fm={"plane_project_id": "project-uuid"},
    )
    try:
        result = await apply_state_change(
            "task/foo.md",
            _decision(confidence=0.7),
            {"count": 1},
            mode="live",
        )
    finally:
        ctx.stop()

    assert result["pending_confirmation"] is True
    assert fake.plane_post_calls == []


@pytest.mark.asyncio
async def test_high_confidence_only_mode_above_threshold_fires(
    fake_vault_factory, monkeypatch
):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live_high_confidence_only")
    monkeypatch.setenv("STEWARD_HIGH_CONFIDENCE_THRESHOLD", "0.85")
    fake, ctx = fake_vault_factory(
        task_fm={
            "state": "open",
            "plane_issue_id": "issue-1",
            "parent_matter": "matter/client-x.md",
        },
        matter_fm={"plane_project_id": "project-uuid"},
    )
    try:
        result = await apply_state_change(
            "task/foo.md",
            _decision(confidence=0.92),
            {"count": 1},
            mode="live",
        )
    finally:
        ctx.stop()

    assert result["live_action_taken"] is True
    assert len(fake.plane_post_calls) == 1


# ---------------------------------------------------------------------------
# Phase 3 — undo recipe correctness
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_undo_recipe_captures_prior_state_and_plane_handles(
    fake_vault_factory, monkeypatch
):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    fake, ctx = fake_vault_factory(
        task_fm={
            "state": "open",
            "plane_issue_id": "issue-1",
            "parent_matter": "matter/client-x.md",
            "next_check_after": "2026-05-04T10:00:00+00:00",
        },
        matter_fm={"plane_project_id": "project-uuid"},
    )
    try:
        await apply_state_change(
            "task/foo.md",
            _decision(decision="likely_done", confidence=0.95),
            {"count": 1},
            mode="live",
        )
    finally:
        ctx.stop()

    rec_type, name, content = fake.write_record_calls[0]
    payload = _read_audit_payload(content)
    recipe = payload["undo_recipe"]
    assert recipe["vault_patch"]["target"] == "task/foo.md"
    # Vault undo restores prior state + clears pending.
    assert recipe["vault_patch"]["set"]["state"] == "open"
    # Plane revert recipe populated with comment id + project id.
    assert recipe["plane_revert"]["issue_id"] == "issue-1"
    assert recipe["plane_revert"]["project_id"] == "project-uuid"
    assert recipe["plane_revert"]["delete_comment_id"] == "comment-123"
    assert recipe["plane_revert"]["restore_state"] == "state-started"
    assert recipe["plane_revert"]["restore_archived"] is False


@pytest.mark.asyncio
async def test_plane_failure_marks_partially_applied(fake_vault_factory, monkeypatch):
    import httpx
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    # Simulate a 502 from ctrl-api.
    fake, ctx = fake_vault_factory(
        task_fm={
            "state": "open",
            "plane_issue_id": "issue-1",
            "parent_matter": "matter/client-x.md",
        },
        matter_fm={"plane_project_id": "project-uuid"},
        plane_post_raises=httpx.RequestError("plane unreachable"),
    )
    try:
        result = await apply_state_change(
            "task/foo.md",
            _decision(confidence=0.95),
            {"count": 1},
            mode="live",
        )
    finally:
        ctx.stop()

    # Audit record still landed; vault still patched; partially_applied.
    assert result["partially_applied"] is True
    assert result["live_action_taken"] is False
    # Vault patch still fired (the spec says don't roll back the vault).
    assert len(fake.patch_structured_calls) == 1


@pytest.mark.asyncio
async def test_skips_plane_when_no_issue_id(fake_vault_factory, monkeypatch):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    fake, ctx = fake_vault_factory(
        task_fm={"state": "open", "parent_matter": "matter/client-x.md"},
        matter_fm={"plane_project_id": "project-uuid"},
    )
    try:
        result = await apply_state_change(
            "task/foo.md",
            _decision(confidence=0.95),
            {"count": 1},
            mode="live",
        )
    finally:
        ctx.stop()

    assert result["partially_applied"] is True
    assert fake.plane_post_calls == []
    # Audit record still landed.
    assert len(fake.write_record_calls) == 1


# ---------------------------------------------------------------------------
# Phase 3 — multi-matter dispatch
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dependency_signals_emitted_for_related_to(
    fake_vault_factory, monkeypatch, tmp_path
):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    monkeypatch.setenv("ALFRED_DATA_DIR", str(tmp_path))
    fake, ctx = fake_vault_factory(
        task_fm={
            "state": "open",
            "plane_issue_id": "issue-1",
            "parent_matter": "matter/client-x.md",
            "related_to": ["task/bar", "task/baz.md"],
        },
        matter_fm={"plane_project_id": "project-uuid"},
    )
    try:
        result = await apply_state_change(
            "task/foo.md",
            _decision(confidence=0.95),
            {"count": 1},
            mode="live",
        )
    finally:
        ctx.stop()

    assert result["dependency_signals_emitted"] == 2
    streams_path = tmp_path / "streams" / "steward-signals.jsonl"
    assert streams_path.exists()
    lines = [
        json.loads(line) for line in streams_path.read_text().splitlines() if line
    ]
    assert len(lines) == 2
    assert {l["ref"] for l in lines} == {"vault:task/bar.md", "vault:task/baz.md"}
    for line in lines:
        assert line["kind"] == "steward:dependency_change"
        assert line["source_task"] == "task/foo.md"


@pytest.mark.asyncio
async def test_no_dependency_signals_in_shadow_mode(
    fake_vault_factory, monkeypatch, tmp_path
):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    monkeypatch.setenv("ALFRED_DATA_DIR", str(tmp_path))
    fake, ctx = fake_vault_factory(
        task_fm={
            "state": "open",
            "plane_issue_id": "issue-1",
            "parent_matter": "matter/client-x.md",
            "related_to": ["task/bar"],
        },
        matter_fm={"plane_project_id": "project-uuid"},
    )
    try:
        result = await apply_state_change(
            "task/foo.md",
            _decision(confidence=0.95),
            {"count": 1},
            mode="shadow",
        )
    finally:
        ctx.stop()

    assert result["dependency_signals_emitted"] == 0
    streams_path = tmp_path / "streams" / "steward-signals.jsonl"
    assert not streams_path.exists()


# ---------------------------------------------------------------------------
# Phase 3 — decisions that don't trigger Plane
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_still_active_does_not_post_to_plane(fake_vault_factory, monkeypatch):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    fake, ctx = fake_vault_factory(
        task_fm={
            "state": "open",
            "plane_issue_id": "issue-1",
            "parent_matter": "matter/client-x.md",
        },
        matter_fm={"plane_project_id": "project-uuid"},
    )
    try:
        result = await apply_state_change(
            "task/foo.md",
            _decision(decision="still_active", confidence=0.99),
            {"count": 1},
            mode="live",
        )
    finally:
        ctx.stop()

    # Decision implies no Plane action; no comment posted.
    assert result["live_action_taken"] is False
    assert fake.plane_post_calls == []


@pytest.mark.asyncio
async def test_archive_decision_posts_to_plane(fake_vault_factory, monkeypatch):
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    fake, ctx = fake_vault_factory(
        task_fm={
            "state": "open",
            "plane_issue_id": "issue-1",
            "parent_matter": "matter/client-x.md",
        },
        matter_fm={"plane_project_id": "project-uuid"},
    )
    try:
        result = await apply_state_change(
            "task/foo.md",
            _decision(decision="stale_archive_candidate", confidence=0.95),
            {"count": 1},
            mode="live",
        )
    finally:
        ctx.stop()

    assert result["live_action_taken"] is True
    assert len(fake.plane_post_calls) == 1
    # Vault patched with state=archived.
    scalars = fake.patch_structured_calls[0]["scalar"]
    assert scalars["state"] == "archived"


# ---------------------------------------------------------------------------
# Bad inputs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unknown_mode_raises():
    with pytest.raises(ValueError):
        await apply_state_change("task/foo.md", _decision(), {}, mode="bogus")


@pytest.mark.asyncio
async def test_empty_task_path_raises():
    with pytest.raises(ValueError):
        await apply_state_change("", _decision(), {}, mode="shadow")
