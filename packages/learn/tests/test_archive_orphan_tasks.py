"""Tests for the ``archive_orphan_tasks`` bulk cleanup script.

These cover the pure-function orphan / agent-managed / recency / archived
guards plus the Plane-cascade helper. Network I/O paths go through
``CtrlClient`` / ``PlaneClient`` which are exercised in integration
tests; unit coverage here just makes sure the predicates match the
forward-sync's own view of "orphan" and the cascade tolerates 404 as
success.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from scripts.archive_orphan_tasks import (
    _delete_plane_issue,
    _is_agent_managed,
    _is_archived,
    _is_orphan,
    _most_recent_timestamp,
    _parse_iso_ts,
    _slug_from_path,
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
    """``_is_agent_managed`` excludes ONLY tasks with ``skill_entry`` set
    — those are TaskRunner-spawned ephemeral execution rows that
    auto-cleanup. Tasks with bare ``agent_id`` (e.g. learn-clerk authored
    errands) are real user-facing records and must NOT be filtered.
    """

    def test_learn_clerk_authored_not_agent_managed(self):
        # Real user-facing errand authored by the clerk LLM during a
        # reflection / digest pass. Has agent_id but no skill_entry.
        # These must go through normal archive/sync paths.
        assert _is_agent_managed({"agent_id": "learn-clerk"}) is False

    def test_task_runner_ephemeral_is_agent_managed(self):
        # TaskRunner-spawned execution row with both markers set —
        # ephemeral, auto-cleanup, must be skipped.
        assert _is_agent_managed(
            {"agent_id": "task-runner", "skill_entry": "some-skill"}
        ) is True

    def test_skill_entry_alone_is_agent_managed(self):
        # `skill_entry` is the distinguishing marker; bare skill_entry
        # without an agent_id still means ephemeral execution row.
        assert _is_agent_managed({"skill_entry": "whatever"}) is True

    def test_empty_dict_not_agent_managed(self):
        # No fields at all — ordinary user-facing task.
        assert _is_agent_managed({}) is False

    def test_empty_skill_entry_not_agent_managed(self):
        # Empty string / None for skill_entry is falsy — not filtered.
        assert _is_agent_managed({"skill_entry": ""}) is False
        assert _is_agent_managed({"skill_entry": None}) is False

    def test_arbitrary_fields_no_filter(self):
        # Non-marker fields don't trigger the filter.
        assert _is_agent_managed({"name": "Some task"}) is False
        assert _is_agent_managed({"agent_id": "exec-123"}) is False


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


class TestSlugFromPath:
    def test_typical(self):
        assert _slug_from_path("task/foo-bar.md") == "foo-bar"

    def test_wrong_prefix(self):
        assert _slug_from_path("matter/foo.md") == ""

    def test_wrong_suffix(self):
        assert _slug_from_path("task/foo.txt") == ""

    def test_empty(self):
        assert _slug_from_path("") == ""


def _mk_http_error(status_code: int) -> httpx.HTTPStatusError:
    req = httpx.Request("DELETE", "http://x/")
    resp = httpx.Response(status_code, request=req)
    return httpx.HTTPStatusError(f"{status_code}", request=req, response=resp)


class TestDeletePlaneIssueCascade:
    """The cascade helper must:

    - Succeed when any project accepts the DELETE (204).
    - Treat 404 across all tried projects as ``already_gone`` success.
    - Try the preferred matter project first, then Inbox, then others.
    - Return a clean failure for non-404 errors (e.g. 500) without iterating.
    - Return ``no_projects_in_map`` when the project_map is empty.
    """

    @pytest.mark.asyncio
    async def test_success_on_first_project(self):
        client = MagicMock()
        client.delete_issue = AsyncMock(return_value=None)
        ok, note = await _delete_plane_issue(
            client,
            "ISSUE-1",
            {"__inbox__": "INBOX-PROJ", "my-matter": "MATTER-PROJ"},
            preferred_matter_slug="my-matter",
        )
        assert ok is True
        assert note == "deleted"
        # First call should target the preferred matter project.
        args, _kwargs = client.delete_issue.call_args
        assert args[0] == "MATTER-PROJ"
        assert args[1] == "ISSUE-1"

    @pytest.mark.asyncio
    async def test_tries_inbox_after_matter_404(self):
        client = MagicMock()
        # Matter project returns 404, Inbox succeeds.
        client.delete_issue = AsyncMock(
            side_effect=[_mk_http_error(404), None]
        )
        ok, note = await _delete_plane_issue(
            client,
            "ISSUE-2",
            {"__inbox__": "INBOX-PROJ", "my-matter": "MATTER-PROJ"},
            preferred_matter_slug="my-matter",
        )
        assert ok is True
        assert note == "deleted"
        assert client.delete_issue.call_count == 2

    @pytest.mark.asyncio
    async def test_all_404s_returns_already_gone(self):
        client = MagicMock()
        client.delete_issue = AsyncMock(
            side_effect=[
                _mk_http_error(404),
                _mk_http_error(404),
                _mk_http_error(404),
            ]
        )
        ok, note = await _delete_plane_issue(
            client,
            "ISSUE-3",
            {
                "__inbox__": "INBOX-PROJ",
                "matter-a": "PROJ-A",
                "matter-b": "PROJ-B",
            },
            preferred_matter_slug="matter-a",
        )
        assert ok is True
        assert note == "already_gone"

    @pytest.mark.asyncio
    async def test_500_error_short_circuits(self):
        client = MagicMock()
        client.delete_issue = AsyncMock(side_effect=_mk_http_error(500))
        ok, note = await _delete_plane_issue(
            client,
            "ISSUE-4",
            {"__inbox__": "INBOX-PROJ"},
            preferred_matter_slug=None,
        )
        assert ok is False
        assert note.startswith("http_500")
        # Must not keep trying after a real error.
        assert client.delete_issue.call_count == 1

    @pytest.mark.asyncio
    async def test_empty_project_map(self):
        client = MagicMock()
        client.delete_issue = AsyncMock()
        ok, note = await _delete_plane_issue(
            client,
            "ISSUE-5",
            {},
            preferred_matter_slug=None,
        )
        assert ok is False
        assert note == "no_projects_in_map"
        client.delete_issue.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_preferred_falls_back_to_inbox_first(self):
        client = MagicMock()
        client.delete_issue = AsyncMock(return_value=None)
        ok, note = await _delete_plane_issue(
            client,
            "ISSUE-6",
            {"__inbox__": "INBOX-PROJ", "other": "OTHER-PROJ"},
            preferred_matter_slug=None,
        )
        assert ok is True
        assert note == "deleted"
        args, _kwargs = client.delete_issue.call_args
        assert args[0] == "INBOX-PROJ"

    @pytest.mark.asyncio
    async def test_deduplicates_project_ids(self):
        """If the matter-resolved project == Inbox project, we must not
        issue the DELETE twice."""
        client = MagicMock()
        client.delete_issue = AsyncMock(return_value=None)
        ok, note = await _delete_plane_issue(
            client,
            "ISSUE-7",
            {"__inbox__": "P", "my-matter": "P"},
            preferred_matter_slug="my-matter",
        )
        assert ok is True
        assert note == "deleted"
        assert client.delete_issue.call_count == 1
