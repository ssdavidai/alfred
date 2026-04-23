"""Unit tests for plane_mapping.py — bidirectional vault ↔ Plane field mapping.

No external dependencies; all pure-function tests.
"""
from __future__ import annotations

import pytest

from src.utils.plane_mapping import (
    ALFRED_LABELS,
    PLANE_PRIORITY_TO_VAULT,
    PLANE_STATE_GROUP_TO_VAULT_TASK,
    VAULT_PRIORITY_TO_PLANE,
    VAULT_TASK_TO_PLANE_STATE_GROUP,
    plane_issue_to_vault_patch,
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
