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


# ---------------------------------------------------------------------------
# Phase B (#890) — state_mutator v2 retrofit
# ---------------------------------------------------------------------------
#
# These cases verify that ``apply_state_change`` (v1) now delegates the
# core state-field write through ``state_mutator.apply_state_change_v2``
# while preserving the v1 return shape + the legacy
# ``event/steward-action-*.md`` audit + Plane fan-out (choice (a) from
# the Phase B audit-shape decision: keep both audits, since
# ctrl-api/routes/steward.ts and several alfred-learn consumers read
# the legacy ``steward-action-*`` shape directly).


import httpx as _httpx
from unittest.mock import patch as _patch

from src.activities import state_mutator as _state_mutator


class _StubV2Transport(_httpx.AsyncBaseTransport):
    """Replay a list of canned ctrl-api responses for the v2 POST."""

    def __init__(self, script: list) -> None:
        self.script = list(script)
        self.requests: list[_httpx.Request] = []

    async def handle_async_request(self, request: _httpx.Request) -> _httpx.Response:
        self.requests.append(request)
        if not self.script:
            raise AssertionError(
                f"_StubV2Transport: no more responses; request was "
                f"{request.method} {request.url}"
            )
        entry = self.script.pop(0)
        if callable(entry):
            return entry(request)
        return entry


class _FakeV2VaultClient:
    """Stub for ``state_mutator.read_target``'s VaultClient.

    We capture the constructor kwargs from a FakeVaultClient and reuse
    its task/matter frontmatter so v2's read_target returns the same
    data the legacy code path observes.
    """

    def __init__(self, frontmatter: dict[str, Any]) -> None:
        self._fm = frontmatter

    async def close(self) -> None:
        pass

    async def read_record(self, path: str) -> dict[str, Any]:
        return {"frontmatter": dict(self._fm), "body": ""}


def _install_v2_mocks(
    target_fm: dict[str, Any],
    script: list,
) -> tuple[_StubV2Transport, list]:
    """Patch ``state_mutator.VaultClient`` + ``httpx.AsyncClient`` so v2
    talks to an in-memory transport instead of a real ctrl-api.

    Returns the transport (for asserting on the captured envelope) plus
    the list of started patches the caller must stop in a finally.
    """
    fake_client = _FakeV2VaultClient(target_fm)
    transport = _StubV2Transport(script)
    real_async_client = _httpx.AsyncClient

    def _factory(*args: Any, **kwargs: Any) -> _httpx.AsyncClient:
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    p1 = _patch(
        "src.activities.state_mutator.VaultClient", return_value=fake_client
    )
    p2 = _patch("src.activities.state_mutator.httpx.AsyncClient", _factory)
    p1.start()
    p2.start()
    return transport, [p1, p2]


def _ok_v2_response(
    *,
    audit_record_path: str = "event/state-change-2026-05-13T0700-steward.evaluate_task-foo.md",
    timeline_entry_id: str = "01HXYZABC",
    new_as_of: str = "2026-05-13T07:00:14Z",
) -> _httpx.Response:
    return _httpx.Response(
        200,
        json={
            "audit_record_path": audit_record_path,
            "timeline_entry_id": timeline_entry_id,
            "new_as_of": new_as_of,
        },
    )


def _v2_conflict_response(current_as_of: str = "2026-05-13T07:01:00Z") -> _httpx.Response:
    return _httpx.Response(
        409,
        json={"error": "as_of_mismatch", "current_as_of": current_as_of},
    )


@pytest.mark.asyncio
async def test_phase_b_shadow_audit_emitted_no_plane_no_patch(
    fake_vault_factory, monkeypatch
):
    """Shadow mode: v2 propose returns None (no state-field mutation
    warranted under shadow on a task whose decision is ``likely_done``
    but effective_mode is shadow), and the legacy audit lands.

    Verifies the Phase B contract under shadow:
      * Legacy ``event/steward-action-*.md`` audit lands (1 write_record).
      * No Plane writes.
      * No legacy ``patch_frontmatter_structured`` (frontmatter
        unchanged on disk).
      * The propose function decides ``None`` under shadow (no state-
        field write needed) → no v2 POST attempted at all.
    """
    monkeypatch.setenv("STEWARD_LIVE_MODE", "shadow")
    task_fm = {
        "state": "open",
        "plane_issue_id": "issue-1",
        "as_of": "2026-05-12T18:00:02Z",
    }
    fake, ctx = fake_vault_factory(task_fm=task_fm)
    transport, patches = _install_v2_mocks(task_fm, script=[])
    try:
        result = await apply_state_change(
            "task/foo.md",
            _decision(decision="likely_done", confidence=0.95),
            {"count": 0},
            mode="shadow",
        )
    finally:
        for p in patches:
            p.stop()
        ctx.stop()

    # Legacy contract holds.
    assert result["mode"] == "shadow"
    assert result["live_action_taken"] is False
    assert fake.patch_structured_calls == []
    assert fake.plane_post_calls == []
    # Steward-action legacy audit lands.
    assert len(fake.write_record_calls) == 1
    rec_type, name, content = fake.write_record_calls[0]
    assert rec_type == "event"
    assert name.startswith("steward-action-")
    # Shadow mode + no current_state composition → propose returns None
    # → no v2 envelope POSTed.
    assert transport.requests == []


@pytest.mark.asyncio
async def test_phase_b_matter_write_fans_out_to_child_tasks(
    fake_vault_factory, monkeypatch, tmp_path
):
    """Matter-context cascade (W2): when a matter's state mutates, one
    ``steward:matter_context_changed`` signal fires per child task whose
    ``parent_matter`` points at the matter.

    Verifies:
      * Live-mode matter write enumerates child tasks via ctrl-api.
      * One signal per child lands in steward-signals.jsonl.
      * Each signal carries the canonical task path + the matter ref.
      * Non-child tasks (parent_matter pointing elsewhere) are filtered.
    """
    import json as _json
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    monkeypatch.setenv("ALFRED_DATA_DIR", str(tmp_path))
    matter_fm = {
        "status": "active",
        "as_of": "2026-05-12T18:00:02Z",
    }
    fake, ctx = fake_vault_factory(matter_fm=matter_fm)

    # Override list_records on the fake to return three task records:
    # two children of matter/client-x.md and one with a different parent.
    async def _list_records(record_type: str, *args, **kwargs):
        if record_type != "task":
            return []
        return [
            {
                "path": "task/alpha.md",
                "frontmatter": {"parent_matter": "matter/client-x.md"},
            },
            {
                "path": "task/beta.md",
                "frontmatter": {"parent_matter": "matter/client-x"},
            },
            {
                "path": "task/gamma.md",
                "frontmatter": {"parent_matter": "matter/other.md"},
            },
        ]

    fake.list_records = _list_records  # type: ignore[attr-defined]

    # v2 propose returns None for matter under matter_context-only path
    # (this Phase B propose function only writes universal fields when
    # there's a current_state or pending_confirmation to write — the
    # matter cascade fan-out is gated separately on target_kind=matter +
    # live mode, regardless of v2 outcome).
    transport, patches = _install_v2_mocks(matter_fm, script=[])
    try:
        result = await apply_state_change(
            "matter/client-x.md",
            _decision(decision="needs_input", confidence=0.95),
            {"count": 0},
            mode="live",
            target_kind="matter",
        )
    finally:
        for p in patches:
            p.stop()
        ctx.stop()

    assert result["mode"] == "live"
    # Two child tasks → two signals.
    assert result["dependency_signals_emitted"] == 2
    streams_path = tmp_path / "streams" / "steward-signals.jsonl"
    assert streams_path.exists()
    lines = [
        _json.loads(line)
        for line in streams_path.read_text().splitlines()
        if line
    ]
    assert len(lines) == 2
    refs = {l["ref"] for l in lines}
    assert refs == {"vault:task/alpha.md", "vault:task/beta.md"}
    for line in lines:
        assert line["kind"] == "steward:matter_context_changed"
        assert line["source_matter"] == "matter/client-x.md"


@pytest.mark.asyncio
async def test_phase_b_v1_shim_returns_legacy_dict_shape(
    fake_vault_factory, monkeypatch
):
    """The v1 ``apply_state_change`` signature + return shape remains
    backwards-compatible after the Phase B retrofit. Steward callers
    expect exactly these keys; v2's ``MutationResult`` is internal."""
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    fake, ctx = fake_vault_factory(
        task_fm={
            "state": "open",
            "plane_issue_id": "issue-1",
            "parent_matter": "matter/client-x.md",
            "as_of": "2026-05-12T18:00:02Z",
        },
        matter_fm={"plane_project_id": "project-uuid"},
    )
    transport, patches = _install_v2_mocks(
        {
            "state": "open",
            "plane_issue_id": "issue-1",
            "as_of": "2026-05-12T18:00:02Z",
        },
        script=[_ok_v2_response()],
    )
    try:
        result = await apply_state_change(
            "task/foo.md",
            _decision(decision="likely_done", confidence=0.95),
            {"count": 1},
            mode="live",
        )
    finally:
        for p in patches:
            p.stop()
        ctx.stop()

    # Keys per the v1 docstring + existing test contract — all present,
    # no v2-internal fields leaked into the v1 return shape.
    expected_keys = {
        "path",
        "mode",
        "timestamp",
        "live_action_taken",
        "pending_confirmation",
        "vault_patch_applied",
        "plane_action",
        "partially_applied",
        "dependency_signals_emitted",
    }
    assert expected_keys <= set(result.keys())
    # No leakage of v2 audit pointers into the v1 return.
    assert "audit_record_path" not in result
    assert "timeline_entry_id" not in result
    # Legacy fields carry sane values.
    assert result["mode"] == "live"
    assert isinstance(result["timestamp"], str) and result["timestamp"]
    assert isinstance(result["live_action_taken"], bool)
    assert result["path"].startswith("event/steward-action-")


@pytest.mark.asyncio
async def test_phase_b_v2_409_retry_then_succeeds(
    fake_vault_factory, monkeypatch
):
    """A 409 inside v2 (optimistic-concurrency mismatch) is transparently
    retried by ``apply_state_change_v2``. From Steward's perspective the
    call succeeds on the retry; the legacy code path still runs and the
    v1 return shape is unaffected."""
    monkeypatch.setenv("STEWARD_LIVE_MODE", "live")
    task_fm = {
        "state": "open",
        "plane_issue_id": "issue-1",
        "parent_matter": "matter/client-x.md",
        "as_of": "2026-05-12T18:00:02Z",
    }
    fake, ctx = fake_vault_factory(
        task_fm=task_fm,
        matter_fm={"plane_project_id": "project-uuid"},
    )
    transport, patches = _install_v2_mocks(
        task_fm,
        script=[
            _v2_conflict_response("2026-05-13T07:01:00Z"),
            _ok_v2_response(new_as_of="2026-05-13T07:02:00Z"),
        ],
    )
    try:
        result = await apply_state_change(
            "task/foo.md",
            _decision(decision="likely_done", confidence=0.95),
            {"count": 1},
            mode="live",
        )
    finally:
        for p in patches:
            p.stop()
        ctx.stop()

    # v2 made two HTTP attempts (409 then 200).
    assert len(transport.requests) == 2
    # Legacy contract still holds end-to-end despite the retry.
    assert result["mode"] == "live"
    assert result["live_action_taken"] is True
    # Steward-action legacy audit still lands.
    assert len(fake.write_record_calls) == 1
    rec_type, name, _content = fake.write_record_calls[0]
    assert rec_type == "event"
    assert name.startswith("steward-action-")
    # Plane fan-out still fired.
    assert len(fake.plane_post_calls) == 1
