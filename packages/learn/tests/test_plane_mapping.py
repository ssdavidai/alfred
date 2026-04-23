"""Unit tests for plane_mapping.py — bidirectional vault ↔ Plane field mapping.

No external dependencies; all pure-function tests.
"""
from __future__ import annotations

import pytest

from src.utils.plane_mapping import (
    ALFRED_LABELS,
    LOOP_GUARD_FIELDS,
    PLANE_PRIORITY_TO_VAULT,
    PLANE_STATE_GROUP_TO_VAULT_TASK,
    VAULT_PRIORITY_TO_PLANE,
    VAULT_TASK_TO_PLANE_STATE_GROUP,
    compute_loop_guard_hash,
    plane_issue_to_vault_patch,
    plane_project_to_matter_patch,
    vault_task_to_plane_update,
)


# ── Constants sanity ────────────────────────────────────────────────────────

class TestConstants:
    def test_vault_to_plane_state_group_covers_all_vault_statuses(self):
        expected = {"queued", "todo", "active", "blocked", "done", "cancelled"}
        assert set(VAULT_TASK_TO_PLANE_STATE_GROUP.keys()) == expected

    def test_plane_to_vault_state_group_covers_all_plane_groups(self):
        expected = {"backlog", "unstarted", "started", "completed", "cancelled"}
        assert set(PLANE_STATE_GROUP_TO_VAULT_TASK.keys()) == expected

    def test_priority_maps_are_inverses(self):
        """Every Plane priority (except 'none' → None) round-trips back."""
        for plane_prio, vault_prio in PLANE_PRIORITY_TO_VAULT.items():
            if plane_prio == "none":
                assert vault_prio is None
            else:
                assert VAULT_PRIORITY_TO_PLANE[vault_prio] == plane_prio

    def test_alfred_labels_contains_managed(self):
        assert "alfred:managed" in ALFRED_LABELS

    def test_alfred_labels_contains_needs_approval(self):
        assert "alfred:needs-approval" in ALFRED_LABELS

    def test_alfred_labels_contains_blocked(self):
        assert "blocked" in ALFRED_LABELS


# ── vault_task_to_plane_update ───────────────────────────────────────────────

class TestVaultTaskToPlaneUpdate:
    def test_basic_todo_task(self):
        fm = {"name": "Write a report", "status": "todo", "priority": "medium"}
        result = vault_task_to_plane_update(fm)
        assert result["name"] == "Write a report"
        assert result["state_group"] == "unstarted"
        assert result["priority"] == "medium"
        assert "alfred:managed" in result["labels"]

    def test_active_maps_to_started(self):
        fm = {"name": "In progress", "status": "active"}
        result = vault_task_to_plane_update(fm)
        assert result["state_group"] == "started"

    def test_queued_maps_to_backlog(self):
        fm = {"name": "Not started yet", "status": "queued"}
        result = vault_task_to_plane_update(fm)
        assert result["state_group"] == "backlog"

    def test_done_maps_to_completed(self):
        fm = {"name": "Finished", "status": "done"}
        result = vault_task_to_plane_update(fm)
        assert result["state_group"] == "completed"

    def test_cancelled_maps_to_cancelled(self):
        fm = {"name": "Dropped", "status": "cancelled"}
        result = vault_task_to_plane_update(fm)
        assert result["state_group"] == "cancelled"

    def test_blocked_maps_to_unstarted_plus_label(self):
        """blocked status → state_group=unstarted + 'blocked' label."""
        fm = {"name": "Stuck task", "status": "blocked"}
        result = vault_task_to_plane_update(fm)
        assert result["state_group"] == "unstarted"
        assert "blocked" in result["labels"]

    def test_requires_approval_adds_label(self):
        fm = {"name": "Needs sign-off", "status": "todo", "requires_approval": True}
        result = vault_task_to_plane_update(fm)
        assert "alfred:needs-approval" in result["labels"]

    def test_no_requires_approval_omits_label(self):
        fm = {"name": "Auto task", "status": "todo", "requires_approval": False}
        result = vault_task_to_plane_update(fm)
        assert "alfred:needs-approval" not in result["labels"]

    def test_none_priority_maps_to_none_string(self):
        fm = {"name": "No priority", "status": "todo", "priority": None}
        result = vault_task_to_plane_update(fm)
        assert result["priority"] == "none"

    def test_missing_priority_key_maps_to_none_string(self):
        fm = {"name": "Missing priority key", "status": "todo"}
        result = vault_task_to_plane_update(fm)
        assert result["priority"] == "none"

    def test_name_truncated_to_255_chars(self):
        long_name = "x" * 300
        fm = {"name": long_name, "status": "todo"}
        result = vault_task_to_plane_update(fm)
        assert len(result["name"]) == 255

    def test_empty_name_becomes_untitled(self):
        fm = {"name": "", "status": "todo"}
        result = vault_task_to_plane_update(fm)
        assert result["name"] == "Untitled task"

    def test_missing_name_becomes_untitled(self):
        fm = {"status": "todo"}
        result = vault_task_to_plane_update(fm)
        assert result["name"] == "Untitled task"

    def test_labels_are_sorted(self):
        fm = {"name": "Multi-label", "status": "blocked", "requires_approval": True}
        result = vault_task_to_plane_update(fm)
        assert result["labels"] == sorted(result["labels"])

    def test_unknown_status_falls_back_to_backlog(self):
        fm = {"name": "Weird status", "status": "mystery"}
        result = vault_task_to_plane_update(fm)
        assert result["state_group"] == "backlog"


# ── plane_issue_to_vault_patch ───────────────────────────────────────────────

class TestPlaneIssueToVaultPatch:
    def _make_issue(self, state_group: str, priority: str = "none", labels: list[str] | None = None) -> dict:
        label_objs = [{"name": n} for n in (labels or [])]
        return {
            "name": "Test issue",
            "state_detail": {"group": state_group},
            "priority": priority,
            "labels": label_objs,
        }

    def test_started_maps_to_active(self):
        issue = self._make_issue("started")
        patch = plane_issue_to_vault_patch(issue)
        assert patch["status"] == "active"

    def test_backlog_maps_to_queued(self):
        issue = self._make_issue("backlog")
        patch = plane_issue_to_vault_patch(issue)
        assert patch["status"] == "queued"

    def test_unstarted_maps_to_todo(self):
        issue = self._make_issue("unstarted")
        patch = plane_issue_to_vault_patch(issue)
        assert patch["status"] == "todo"

    def test_completed_maps_to_done(self):
        issue = self._make_issue("completed")
        patch = plane_issue_to_vault_patch(issue)
        assert patch["status"] == "done"

    def test_cancelled_maps_to_cancelled(self):
        issue = self._make_issue("cancelled")
        patch = plane_issue_to_vault_patch(issue)
        assert patch["status"] == "cancelled"

    def test_blocked_label_wins_over_state_group(self):
        """Even if state_group=started, 'blocked' label → status=blocked."""
        issue = self._make_issue("started", labels=["blocked"])
        patch = plane_issue_to_vault_patch(issue)
        assert patch["status"] == "blocked"

    def test_priority_none_maps_to_python_none(self):
        issue = self._make_issue("started", priority="none")
        patch = plane_issue_to_vault_patch(issue)
        assert patch["priority"] is None

    def test_priority_urgent_round_trips(self):
        issue = self._make_issue("started", priority="urgent")
        patch = plane_issue_to_vault_patch(issue)
        assert patch["priority"] == "urgent"

    def test_name_preserved(self):
        issue = self._make_issue("started")
        issue["name"] = "Important meeting"
        patch = plane_issue_to_vault_patch(issue)
        assert patch["name"] == "Important meeting"

    def test_patch_does_not_include_protected_fields(self):
        """related_matters / related_persons / source_event must not appear."""
        issue = self._make_issue("started")
        patch = plane_issue_to_vault_patch(issue)
        for field in ("related_matters", "related_persons", "source_event"):
            assert field not in patch

    def test_handles_empty_labels_list(self):
        issue = self._make_issue("started", labels=[])
        patch = plane_issue_to_vault_patch(issue)
        assert patch["status"] == "active"  # no blocked label interference

    def test_handles_labels_as_non_list(self):
        """Malformed webhook payload with labels=None should not crash."""
        issue = self._make_issue("started")
        issue["labels"] = None
        patch = plane_issue_to_vault_patch(issue)
        assert patch["status"] == "active"

    def test_missing_state_detail_falls_back_to_state_group_key(self):
        """Plane webhook payloads may omit state_detail and include
        state_group directly at the top level."""
        issue = {
            "name": "Flat payload",
            "state_group": "completed",
            "priority": "high",
            "labels": [],
        }
        patch = plane_issue_to_vault_patch(issue)
        assert patch["status"] == "done"

    def test_round_trip_todo(self):
        """todo → Plane unstarted → back to todo."""
        fm = {"name": "Round trip", "status": "todo", "priority": "low"}
        plane_payload = vault_task_to_plane_update(fm)
        # Simulate what Plane would echo back
        fake_issue = {
            "name": fm["name"],
            "state_detail": {"group": plane_payload["state_group"]},
            "priority": plane_payload["priority"],
            "labels": [{"name": lb} for lb in plane_payload["labels"]],
        }
        patch = plane_issue_to_vault_patch(fake_issue)
        assert patch["status"] == "todo"
        assert patch["priority"] == "low"

    def test_round_trip_blocked(self):
        """blocked → Plane unstarted + blocked label → back to blocked."""
        fm = {"name": "Blocked task", "status": "blocked"}
        plane_payload = vault_task_to_plane_update(fm)
        fake_issue = {
            "name": fm["name"],
            "state_detail": {"group": plane_payload["state_group"]},
            "priority": plane_payload["priority"],
            "labels": [{"name": lb} for lb in plane_payload["labels"]],
        }
        patch = plane_issue_to_vault_patch(fake_issue)
        assert patch["status"] == "blocked"


# ── plane_project_to_matter_patch ────────────────────────────────────────────

class TestPlaneProjectToMatterPatch:
    def test_basic_active_project(self):
        project = {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "name": "Client X Engagement",
            "description_text": "Long-running advisory retainer.",
            "is_archived": False,
        }
        patch = plane_project_to_matter_patch(project)
        assert patch["name"] == "Client X Engagement"
        assert patch["description"] == "Long-running advisory retainer."
        assert patch["status"] == "active"
        assert patch["plane_project_id"] == "550e8400-e29b-41d4-a716-446655440000"

    def test_archived_flag_sets_status_archived(self):
        project = {"id": "x", "name": "Dead deal", "is_archived": True}
        patch = plane_project_to_matter_patch(project)
        assert patch["status"] == "archived"

    def test_archived_at_timestamp_sets_status_archived(self):
        """Plane sometimes reports archival via ``archived_at`` alone."""
        project = {"id": "x", "name": "Old", "archived_at": "2026-04-01T00:00:00Z"}
        patch = plane_project_to_matter_patch(project)
        assert patch["status"] == "archived"

    def test_missing_name_falls_back(self):
        patch = plane_project_to_matter_patch({"id": "x", "name": ""})
        assert patch["name"] == "Untitled matter"

    def test_null_description_becomes_empty(self):
        """Null description must not become the string 'None'."""
        patch = plane_project_to_matter_patch({
            "id": "x", "name": "Fine", "description_text": None,
        })
        assert patch["description"] == ""

    def test_prefers_description_text_over_html(self):
        patch = plane_project_to_matter_patch({
            "id": "x", "name": "X",
            "description_text": "plain",
            "description_html": "<p>html</p>",
        })
        assert patch["description"] == "plain"

    def test_falls_back_to_description_html(self):
        patch = plane_project_to_matter_patch({
            "id": "x", "name": "X",
            "description_html": "<p>only html</p>",
        })
        assert patch["description"] == "<p>only html</p>"

    def test_name_truncated_to_255(self):
        project = {"id": "x", "name": "y" * 400}
        patch = plane_project_to_matter_patch(project)
        assert len(patch["name"]) == 255

    def test_omits_plane_project_id_when_no_id(self):
        """Don't smuggle in empty string fields on partial payloads."""
        patch = plane_project_to_matter_patch({"name": "No id"})
        assert "plane_project_id" not in patch

    def test_unknown_fields_ignored(self):
        """Fields Plane sends that we don't care about never leak into the patch."""
        project = {
            "id": "x",
            "name": "Test",
            "updated_by": "user-123",
            "total_issues": 42,
            "workspace_id": "ws-456",
            "mystery_field": "boo",
        }
        patch = plane_project_to_matter_patch(project)
        # Exactly the managed keys, nothing else
        assert set(patch.keys()) == {
            "name", "description", "status", "plane_project_id",
        }

    def test_does_not_touch_protected_fields(self):
        """related_* / source_event / etc must never appear in the patch."""
        project = {
            "id": "x",
            "name": "Test",
            # Even if someone put these on the Plane side (they shouldn't),
            # the helper does not echo them.
            "related_matters": ["something"],
            "related_persons": ["someone"],
            "source_event": "bad",
        }
        patch = plane_project_to_matter_patch(project)
        for field in (
            "related_matters",
            "related_persons",
            "related_orgs",
            "related_projects",
            "source_event",
        ):
            assert field not in patch


# ── compute_loop_guard_hash ──────────────────────────────────────────────────

class TestLoopGuardHash:
    def test_loop_guard_fields_constant(self):
        """Explicit list — changing it breaks forward/reverse agreement."""
        assert LOOP_GUARD_FIELDS == (
            "name", "description", "state", "priority", "due_date", "assignees",
        )

    def test_deterministic(self):
        payload = {"name": "A", "state": "started", "priority": "high"}
        assert compute_loop_guard_hash(payload) == compute_loop_guard_hash(payload)

    def test_order_insensitive(self):
        """sort_keys must make dict-insertion-order irrelevant."""
        a = {"name": "A", "state": "started", "priority": "high"}
        b = {"priority": "high", "name": "A", "state": "started"}
        assert compute_loop_guard_hash(a) == compute_loop_guard_hash(b)

    def test_assignee_order_insensitive(self):
        a = {"name": "X", "assignees": ["u1", "u2"]}
        b = {"name": "X", "assignees": ["u2", "u1"]}
        assert compute_loop_guard_hash(a) == compute_loop_guard_hash(b)

    def test_unrelated_fields_do_not_affect_hash(self):
        """Adding noise Plane fields must NOT change the digest."""
        base = {"name": "X", "state": "started", "priority": "high"}
        noisy = {
            **base,
            "updated_at": "2026-04-23T12:00:00Z",
            "sequence_id": 42,
            "archived_at": None,
        }
        assert compute_loop_guard_hash(base) == compute_loop_guard_hash(noisy)

    def test_state_detail_group_matches_state_group(self):
        """Webhook (state_detail.group) and flat (state_group) payloads
        that mean the same thing hash identically."""
        webhook = {
            "name": "X", "priority": "high",
            "state_detail": {"group": "started"},
        }
        flat = {"name": "X", "priority": "high", "state_group": "started"}
        assert compute_loop_guard_hash(webhook) == compute_loop_guard_hash(flat)

    def test_outbound_inbound_agree(self):
        """Forward-sync's outbound body and the echo Plane sends back
        must hash identically — otherwise guard #2 is a no-op."""
        fm = {"name": "A task", "status": "todo", "priority": "medium"}
        outbound = vault_task_to_plane_update(fm)
        # Simulate Plane echoing the state back as an issue webhook
        inbound = {
            "name": outbound["name"],
            "state_detail": {"group": outbound["state_group"]},
            "priority": outbound["priority"],
        }
        assert compute_loop_guard_hash(outbound) == compute_loop_guard_hash(inbound)

    def test_empty_payload_stable(self):
        """Empty payload still hashes to something — and it's stable."""
        h = compute_loop_guard_hash({})
        assert len(h) == 64
        assert compute_loop_guard_hash({}) == h

    def test_priority_none_stable(self):
        """Missing priority → 'none' — forward and reverse agree."""
        a = {"name": "X"}
        b = {"name": "X", "priority": "none"}
        c = {"name": "X", "priority": None}
        assert compute_loop_guard_hash(a) == compute_loop_guard_hash(b)
        assert compute_loop_guard_hash(a) == compute_loop_guard_hash(c)
