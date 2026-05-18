"""Unit tests for plane_mapping.py — bidirectional vault ↔ Plane field mapping.

No external dependencies; all pure-function tests.
"""
from __future__ import annotations

import pytest

from src.utils.plane_mapping import (
    ALFRED_LABELS,
    LOOP_GUARD_FIELDS,
    MAX_LABELS_PER_ISSUE,
    PLANE_PRIORITY_TO_VAULT,
    PLANE_STATE_GROUP_TO_VAULT_TASK,
    VAULT_PRIORITY_TO_PLANE,
    VAULT_TASK_TO_PLANE_STATE_GROUP,
    _body_to_description_html,
    _coerce_label_list,
    _iso_date_string,
    _sanitize_label_name,
    compute_loop_guard_hash,
    plane_issue_to_vault_patch,
    plane_project_to_matter_patch,
    vault_matter_to_plane_update,
    vault_task_to_plane_update,
)


# ── Constants sanity ────────────────────────────────────────────────────────

class TestConstants:
    def test_vault_to_plane_state_group_covers_all_vault_statuses(self):
        # The canonical schema set plus fleet-drift values we tolerate —
        # see mapping file for rationale per extra key.
        canonical = {"queued", "todo", "active", "blocked", "done", "cancelled"}
        fleet_drift = {"pending"}
        assert set(VAULT_TASK_TO_PLANE_STATE_GROUP.keys()) == canonical | fleet_drift

    def test_pending_is_mapped_to_backlog(self):
        """Fleet-drift value 'pending' must not collapse to 'backlog'
        via fallback only — explicit mapping keeps the round-trip stable."""
        assert VAULT_TASK_TO_PLANE_STATE_GROUP["pending"] == "backlog"

    def test_critical_priority_maps_to_urgent(self):
        """Fleet-drift value 'critical' — curator emits it though the
        schema doesn't define it. We mirror to Plane's strongest priority
        instead of collapsing to 'none'."""
        assert VAULT_PRIORITY_TO_PLANE["critical"] == "urgent"

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

    def test_backlog_maps_to_todo(self):
        # PR #590: vault schema doesn't have "queued" — collapsed to "todo"
        issue = self._make_issue("backlog")
        patch = plane_issue_to_vault_patch(issue)
        assert patch["status"] == "todo"

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


# ── Label allow-list + list coercion ────────────────────────────────────────


class TestSanitizeLabelName:
    def test_accepts_lowercase_alnum(self):
        assert _sanitize_label_name("budget") == "budget"

    def test_accepts_hyphens_mid(self):
        assert _sanitize_label_name("alfred-managed") == "alfred-managed"

    def test_rejects_leading_hyphen(self):
        assert _sanitize_label_name("-bad") is None

    def test_rejects_uppercase(self):
        # Deliberate: we don't silently lower-case — leaves the
        # caller's intent visible and rejects pollution from free-text.
        assert _sanitize_label_name("Budget") is None

    def test_rejects_whitespace(self):
        assert _sanitize_label_name("has space") is None

    def test_rejects_special_chars(self):
        assert _sanitize_label_name("ampersand&") is None
        assert _sanitize_label_name("dotted.name") is None
        assert _sanitize_label_name("slash/name") is None

    def test_rejects_too_long(self):
        # 33 chars — one over the cap
        assert _sanitize_label_name("a" + "b" * 32) is None

    def test_accepts_exactly_32_chars(self):
        name = "a" + "b" * 31
        assert _sanitize_label_name(name) == name

    def test_rejects_empty_string(self):
        assert _sanitize_label_name("") is None

    def test_rejects_non_string(self):
        assert _sanitize_label_name(None) is None
        assert _sanitize_label_name(42) is None
        assert _sanitize_label_name(["budget"]) is None


class TestCoerceLabelList:
    def test_empty_list(self):
        assert _coerce_label_list([]) == []

    def test_none(self):
        assert _coerce_label_list(None) == []

    def test_list_of_valid_strings(self):
        assert _coerce_label_list(["budget", "urgent", "gtd"]) == [
            "budget", "urgent", "gtd",
        ]

    def test_drops_invalid_entries(self):
        # Valid ones kept, invalid silently dropped
        assert _coerce_label_list(["budget", "Has Space", "ok", "BAD"]) == [
            "budget", "ok",
        ]

    def test_string_split_on_commas(self):
        assert _coerce_label_list("budget, urgent, gtd") == [
            "budget", "urgent", "gtd",
        ]

    def test_string_split_on_whitespace(self):
        assert _coerce_label_list("budget urgent gtd") == [
            "budget", "urgent", "gtd",
        ]

    def test_malformed_type_returns_empty(self):
        assert _coerce_label_list(42) == []
        assert _coerce_label_list({"a": "b"}) == []


# ── ISO date parsing ────────────────────────────────────────────────────────


class TestIsoDateString:
    def test_none_returns_none(self):
        assert _iso_date_string(None) is None

    def test_empty_returns_none(self):
        assert _iso_date_string("") is None
        assert _iso_date_string("   ") is None

    def test_bare_date_passes_through(self):
        assert _iso_date_string("2026-04-23") == "2026-04-23"

    def test_iso_datetime_trims_to_date(self):
        assert _iso_date_string("2026-04-23T12:34:56") == "2026-04-23"

    def test_iso_datetime_with_z_trims(self):
        assert _iso_date_string("2026-04-23T12:34:56Z") == "2026-04-23"

    def test_iso_datetime_with_tz_offset_trims(self):
        assert _iso_date_string("2026-04-23T12:34:56+02:00") == "2026-04-23"

    def test_iso_datetime_with_space_separator(self):
        # Vault frontmatter commonly uses space instead of T
        assert _iso_date_string("2026-04-23 12:34:56") == "2026-04-23"

    def test_garbage_string_returns_none(self):
        assert _iso_date_string("not a date") is None
        assert _iso_date_string("2026-04") is None  # no day
        assert _iso_date_string("tomorrow") is None

    def test_date_object_passes_through(self):
        from datetime import date
        assert _iso_date_string(date(2026, 4, 23)) == "2026-04-23"

    def test_datetime_object_trims_to_date(self):
        from datetime import datetime
        assert _iso_date_string(datetime(2026, 4, 23, 12, 0, 0)) == "2026-04-23"


# ── Body → HTML rendering ──────────────────────────────────────────────────


class TestBodyToDescriptionHtml:
    def test_empty_body_and_empty_scalar_returns_empty(self):
        assert _body_to_description_html("", "") == ""
        assert _body_to_description_html(None, None) == ""
        assert _body_to_description_html(None, "") == ""

    def test_simple_body_wraps_in_p(self):
        assert _body_to_description_html("Hello world", None) == "<p>Hello world</p>"

    def test_double_newline_makes_separate_paragraphs(self):
        html = _body_to_description_html("First paragraph\n\nSecond paragraph", None)
        assert html == "<p>First paragraph</p><p>Second paragraph</p>"

    def test_single_newline_becomes_br(self):
        html = _body_to_description_html("Line one\nLine two", None)
        assert html == "<p>Line one<br>Line two</p>"

    def test_leading_h1_heading_stripped(self):
        """Curator commonly emits '# Title\n\nbody' — the title duplicates
        the task name so drop it from the HTML body."""
        html = _body_to_description_html(
            "# My Task Title\n\nThe real body.", None,
        )
        assert html == "<p>The real body.</p>"

    def test_h1_heading_without_blank_line_also_stripped(self):
        html = _body_to_description_html("# Title\nBody", None)
        assert html == "<p>Body</p>"

    def test_falls_back_to_scalar_when_body_empty(self):
        html = _body_to_description_html("", "Summary only")
        assert html == "<p>Summary only</p>"

    def test_body_wins_over_scalar(self):
        html = _body_to_description_html("Full body", "Scalar summary")
        assert html == "<p>Full body</p>"

    def test_html_injection_is_escaped(self):
        """HARD RULE: a '<script>' in the vault must become inert text."""
        body = "<script>alert('pwned')</script>"
        html = _body_to_description_html(body, None)
        assert "<script>" not in html
        assert "&lt;script&gt;" in html
        assert "&lt;/script&gt;" in html

    def test_ampersand_escaped(self):
        html = _body_to_description_html("A & B", None)
        assert html == "<p>A &amp; B</p>"

    def test_gt_lt_escaped(self):
        html = _body_to_description_html("a<b and x>y", None)
        assert "&lt;" in html
        assert "&gt;" in html

    def test_only_whitespace_returns_empty(self):
        assert _body_to_description_html("   \n\n   ", None) == ""

    def test_only_heading_returns_empty(self):
        # A body that is JUST the heading strips to empty
        assert _body_to_description_html("# Just a heading", None) == ""

    def test_preserves_paragraph_order(self):
        body = "para1\n\npara2\n\npara3"
        html = _body_to_description_html(body, None)
        assert html == "<p>para1</p><p>para2</p><p>para3</p>"


# ── Rich vault_task_to_plane_update extensions ──────────────────────────────


class TestVaultTaskToPlaneUpdateRich:
    """Coverage of the new fields added by the rich-mapping rollout."""

    def test_description_html_from_body(self):
        fm = {"name": "Task", "status": "todo"}
        result = vault_task_to_plane_update(fm, body="The body text.")
        assert result["description_html"] == "<p>The body text.</p>"

    def test_description_html_omitted_when_body_and_scalar_empty(self):
        fm = {"name": "Task", "status": "todo"}
        result = vault_task_to_plane_update(fm)
        assert "description_html" not in result

    def test_description_falls_back_to_scalar(self):
        fm = {"name": "Task", "status": "todo", "description": "Short note."}
        result = vault_task_to_plane_update(fm)
        assert result["description_html"] == "<p>Short note.</p>"

    def test_body_beats_scalar(self):
        fm = {"name": "Task", "status": "todo", "description": "summary"}
        result = vault_task_to_plane_update(fm, body="Full body content")
        assert "Full body content" in result["description_html"]
        assert "summary" not in result["description_html"]

    def test_body_heading_duplicate_stripped(self):
        fm = {"name": "Do the thing", "status": "todo"}
        body = "# Do the thing\n\nActually do it now."
        result = vault_task_to_plane_update(fm, body=body)
        assert result["description_html"] == "<p>Actually do it now.</p>"

    def test_target_date_from_due_date(self):
        fm = {"name": "Task", "status": "todo", "due_date": "2026-05-01"}
        result = vault_task_to_plane_update(fm)
        assert result["target_date"] == "2026-05-01"

    def test_target_date_from_due(self):
        fm = {"name": "Task", "status": "todo", "due": "2026-05-01"}
        result = vault_task_to_plane_update(fm)
        assert result["target_date"] == "2026-05-01"

    def test_target_date_due_date_wins_over_due(self):
        fm = {
            "name": "Task", "status": "todo",
            "due_date": "2026-05-01", "due": "2026-06-01",
        }
        result = vault_task_to_plane_update(fm)
        assert result["target_date"] == "2026-05-01"

    def test_target_date_garbage_omitted(self):
        fm = {"name": "Task", "status": "todo", "due_date": "tomorrow"}
        result = vault_task_to_plane_update(fm)
        assert "target_date" not in result

    def test_target_date_iso_datetime_normalised_to_date(self):
        fm = {
            "name": "Task", "status": "todo",
            "due_date": "2026-05-01T09:00:00Z",
        }
        result = vault_task_to_plane_update(fm)
        assert result["target_date"] == "2026-05-01"

    def test_alfred_tags_passed_through(self):
        fm = {
            "name": "Task", "status": "todo",
            "alfred_tags": ["budget", "urgent"],
        }
        result = vault_task_to_plane_update(fm)
        assert "budget" in result["labels"]
        assert "urgent" in result["labels"]
        assert "alfred:managed" in result["labels"]

    def test_topic_tags_passed_through(self):
        fm = {
            "name": "Task", "status": "todo",
            "topic_tags": ["finance", "hr"],
        }
        result = vault_task_to_plane_update(fm)
        assert "finance" in result["labels"]
        assert "hr" in result["labels"]

    def test_invalid_tags_dropped(self):
        fm = {
            "name": "Task", "status": "todo",
            "alfred_tags": ["budget", "Has Space", "BAD", "ok"],
        }
        result = vault_task_to_plane_update(fm)
        assert "budget" in result["labels"]
        assert "ok" in result["labels"]
        assert "Has Space" not in result["labels"]
        assert "BAD" not in result["labels"]

    def test_label_cap_enforced(self):
        fm = {
            "name": "Task", "status": "todo",
            "alfred_tags": [f"tag{i}" for i in range(20)],
        }
        result = vault_task_to_plane_update(fm)
        assert len(result["labels"]) <= MAX_LABELS_PER_ISSUE

    def test_label_cap_preserves_alfred_managed(self):
        """Even when the user spams 20 tags, alfred:managed must survive
        the cap since it's always inserted first."""
        fm = {
            "name": "Task", "status": "todo", "requires_approval": True,
            "alfred_tags": [f"tag{i}" for i in range(20)],
        }
        result = vault_task_to_plane_update(fm)
        assert "alfred:managed" in result["labels"]
        assert "alfred:needs-approval" in result["labels"]

    def test_tags_deduped(self):
        fm = {
            "name": "Task", "status": "todo",
            "alfred_tags": ["dup", "dup", "dup"],
        }
        result = vault_task_to_plane_update(fm)
        assert result["labels"].count("dup") == 1

    def test_assignees_always_list(self):
        fm = {"name": "Task", "status": "todo"}
        result = vault_task_to_plane_update(fm)
        assert result["assignees"] == []
        assert isinstance(result["assignees"], list)

    def test_critical_priority_maps_to_urgent(self):
        """Fleet-drift: Sir vault has ~4 'critical' records. Must not
        collapse to 'none' — map to Plane's strongest tier."""
        fm = {"name": "Task", "status": "todo", "priority": "critical"}
        result = vault_task_to_plane_update(fm)
        assert result["priority"] == "urgent"

    def test_pending_status_maps_to_backlog(self):
        """Fleet-drift: Sir has 1212 'pending' tasks. Route them to
        backlog rather than letting them fall through to default."""
        fm = {"name": "Task", "status": "pending"}
        result = vault_task_to_plane_update(fm)
        assert result["state_group"] == "backlog"

    def test_title_field_used_when_name_missing(self):
        fm = {"title": "Via title", "status": "todo"}
        result = vault_task_to_plane_update(fm)
        assert result["name"] == "Via title"

    def test_name_wins_over_title(self):
        fm = {"name": "Via name", "title": "Via title", "status": "todo"}
        result = vault_task_to_plane_update(fm)
        assert result["name"] == "Via name"


# ── vault_matter_to_plane_update ─────────────────────────────────────────────


class TestVaultMatterToPlaneUpdate:
    def test_basic_active_matter(self):
        fm = {"name": "Client X", "status": "active", "description": "summary"}
        result = vault_matter_to_plane_update(fm)
        assert result["name"] == "Client X"
        assert result["description_text"] == "summary"
        assert result["is_archived"] is False

    def test_body_becomes_description_text(self):
        fm = {"name": "Client X", "status": "active"}
        body = "Long form notes about the engagement."
        result = vault_matter_to_plane_update(fm, body=body)
        assert body in result["description_text"]

    def test_body_becomes_description_html(self):
        fm = {"name": "Client X", "status": "active"}
        body = "Paragraph one.\n\nParagraph two."
        result = vault_matter_to_plane_update(fm, body=body)
        assert result["description_html"] == "<p>Paragraph one.</p><p>Paragraph two.</p>"

    def test_description_html_absent_with_no_content(self):
        fm = {"name": "Stub", "status": "active"}
        result = vault_matter_to_plane_update(fm)
        assert "description_html" not in result

    def test_non_active_status_marks_archived(self):
        fm = {"name": "Done", "status": "completed"}
        result = vault_matter_to_plane_update(fm)
        assert result["is_archived"] is True

    def test_empty_status_is_not_archived(self):
        """No status set is ambiguous — don't assume archived."""
        fm = {"name": "Fresh"}
        result = vault_matter_to_plane_update(fm)
        assert result["is_archived"] is False

    def test_name_falls_back_to_untitled(self):
        result = vault_matter_to_plane_update({})
        assert result["name"] == "Untitled matter"

    def test_name_truncated_to_255(self):
        fm = {"name": "x" * 400}
        result = vault_matter_to_plane_update(fm)
        assert len(result["name"]) == 255

    def test_emoji_accepted_when_single_non_alnum_char(self):
        fm = {"name": "Loved", "status": "active", "emoji": "❤"}
        result = vault_matter_to_plane_update(fm)
        assert result["emoji"] == "❤"

    def test_emoji_rejected_when_too_long(self):
        fm = {"name": "X", "status": "active", "emoji": "not an emoji"}
        result = vault_matter_to_plane_update(fm)
        assert "emoji" not in result

    def test_emoji_rejected_when_alphanumeric(self):
        # If the user wrote a word, it's not an emoji.
        fm = {"name": "X", "status": "active", "emoji": "abc"}
        result = vault_matter_to_plane_update(fm)
        assert "emoji" not in result

    def test_icon_accepted_as_alias(self):
        fm = {"name": "X", "status": "active", "icon": "🎯"}
        result = vault_matter_to_plane_update(fm)
        assert result["emoji"] == "🎯"

    def test_body_html_escapes_content(self):
        fm = {"name": "X", "status": "active"}
        body = "Contains <script> tag"
        result = vault_matter_to_plane_update(fm, body=body)
        assert "<script>" not in result["description_html"]
        assert "&lt;script&gt;" in result["description_html"]

    def test_description_preview_used_as_fallback(self):
        fm = {
            "name": "X", "status": "active",
            "description_preview": "from preview field",
        }
        result = vault_matter_to_plane_update(fm)
        assert "from preview field" in result["description_text"]

    def test_body_beats_scalar_description(self):
        fm = {
            "name": "X", "status": "active",
            "description": "scalar version",
        }
        result = vault_matter_to_plane_update(fm, body="body version")
        assert "body version" in result["description_text"]
