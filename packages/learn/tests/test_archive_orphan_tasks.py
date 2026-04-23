"""Tests for the ``archive_orphan_tasks`` bulk cleanup script.

These cover the pure-function orphan / agent-managed / recency / archived
guards. Network I/O paths go through ``CtrlClient`` which is exercised
in integration tests; unit coverage here just makes sure the in-memory
filter predicates match the forward-sync's own view of "orphan".
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

from scripts.archive_orphan_tasks import (
    _is_agent_managed,
    _is_archived,
    _is_orphan,
    _most_recent_timestamp,
    _parse_iso_ts,
)


class TestIsArchived:
    def test_bool_true(self):
        assert _is_archived({"archived": True}) is True

    def test_bool_false(self):
        assert _is_archived({"archived": False}) is False

    def test_string_true(self):
        assert _is_archived({"archived": "true"}) is True

    def test_string_false(self):
        assert _is_archived({"archived": "false"}) is False

    def test_missing(self):
        assert _is_archived({}) is False

    def test_none(self):
        assert _is_archived({"archived": None}) is False


class TestIsAgentManaged:
    def test_agent_id(self):
        assert _is_agent_managed({"agent_id": "exec-123"}) is True

    def test_skill_entry(self):
        assert _is_agent_managed({"skill_entry": "chore:weekly-digest"}) is True

    def test_both(self):
        assert _is_agent_managed(
            {"agent_id": "x", "skill_entry": "y"}
        ) is True

    def test_neither(self):
        assert _is_agent_managed({"name": "Some task"}) is False

    def test_empty_values(self):
        assert _is_agent_managed({"agent_id": "", "skill_entry": None}) is False


class TestIsOrphan:
    """Agreement with plane_sync._resolve_task_matter — what counts as
    orphan in the archive script must exactly match what plane_sync
    treats as "no matter linkage".
    """

    def test_no_fields(self):
        assert _is_orphan({}) is True

    def test_scalar_matter(self):
        assert _is_orphan({"matter": "client-x"}) is False

    def test_scalar_related_matter(self):
        assert _is_orphan({"related_matter": "legacy"}) is False

    def test_related_matters_populated(self):
        assert _is_orphan({"related_matters": ["matter/foo.md"]}) is False

    def test_related_matters_empty_list(self):
        assert _is_orphan({"related_matters": []}) is True

    def test_related_matters_non_list(self):
        # malformed — treated as no link
        assert _is_orphan({"related_matters": "not-a-list"}) is True

    def test_related_matters_all_empty_strings(self):
        # empty strings don't count as a valid link
        assert _is_orphan({"related_matters": [""]}) is True

    def test_scalar_matter_beats_empty_array(self):
        assert _is_orphan(
            {"matter": "x", "related_matters": []}
        ) is False


class TestParseIsoTs:
    def test_full_iso(self):
        dt = _parse_iso_ts("2026-04-08T12:30:00+00:00")
        assert dt is not None
        assert dt.year == 2026

    def test_z_suffix(self):
        dt = _parse_iso_ts("2026-04-08T12:30:00Z")
        assert dt is not None
        assert dt.tzinfo is not None

    def test_space_separator(self):
        dt = _parse_iso_ts("2026-04-08 12:30:00+00:00")
        assert dt is not None

    def test_date_only(self):
        dt = _parse_iso_ts("2026-04-08")
        assert dt is not None
        assert dt.year == 2026

    def test_microseconds_trimmed(self):
        # Postgres-style 7-digit fractional seconds must not crash
        dt = _parse_iso_ts("2026-04-23 01:13:38.8476841+00:00")
        assert dt is not None

    def test_non_string(self):
        assert _parse_iso_ts(None) is None
        assert _parse_iso_ts(42) is None

    def test_empty(self):
        assert _parse_iso_ts("") is None

    def test_garbage(self):
        assert _parse_iso_ts("not a date") is None


class TestMostRecentTimestamp:
    def test_updated_beats_created(self):
        fm = {
            "created": "2026-01-01T00:00:00+00:00",
            "updated": "2026-04-01T00:00:00+00:00",
        }
        ts = _most_recent_timestamp(fm, {})
        assert ts is not None
        assert ts.month == 4

    def test_falls_back_to_top_level_created(self):
        ts = _most_recent_timestamp({}, {"created": "2026-03-15"})
        assert ts is not None
        assert ts.month == 3

    def test_missing_everywhere(self):
        assert _most_recent_timestamp({}, {}) is None

    def test_prefers_most_recent_across_sources(self):
        # Top-level created is newer than any frontmatter field
        ts = _most_recent_timestamp(
            {"created": "2026-01-01"},
            {"created": "2026-06-01T00:00:00+00:00"},
        )
        assert ts is not None
        assert ts.month == 6


class TestRecentCutoffBehaviour:
    """Exercise the tiny bit of logic that wires --skip-recent-days
    through: a cutoff computed from datetime.now(tz=utc) - Nd, and tasks
    whose most-recent-timestamp is >= cutoff are skipped. No
    full-script boot needed; we just assert the predicates agree.
    """

    def test_cutoff_comparison_skips_recent(self):
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(days=7)
        # Task modified 2h ago — should be considered "recent"
        recent_fm = {"updated": (now - timedelta(hours=2)).isoformat()}
        ts = _most_recent_timestamp(recent_fm, {})
        assert ts is not None
        assert ts >= cutoff

    def test_cutoff_comparison_keeps_old(self):
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(days=7)
        old_fm = {"updated": (now - timedelta(days=30)).isoformat()}
        ts = _most_recent_timestamp(old_fm, {})
        assert ts is not None
        assert ts < cutoff
