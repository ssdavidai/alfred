"""Tests for the ``cleanup_plane_stragglers`` script's predicates.

The filter semantics for ``_is_agent_managed`` must match
``archive_orphan_tasks._is_agent_managed`` — ``skill_entry`` is the only
marker for task-runner ephemeral execution rows; bare ``agent_id`` (set
by learn-clerk on real user-facing errands) is NOT a filter.
"""
from __future__ import annotations

from scripts.cleanup_plane_stragglers import (
    _is_agent_managed,
    _is_archived,
    _slug_from_external_id,
)


class TestIsAgentManaged:
    """Same contract as archive_orphan_tasks — only ``skill_entry``
    marks an ephemeral task. Plane issues backing learn-clerk errands
    must not be swept by this cleanup.
    """

    def test_learn_clerk_authored_not_agent_managed(self):
        assert _is_agent_managed({"agent_id": "learn-clerk"}) is False

    def test_task_runner_ephemeral_is_agent_managed(self):
        assert _is_agent_managed(
            {"agent_id": "task-runner", "skill_entry": "some-skill"}
        ) is True

    def test_skill_entry_alone_is_agent_managed(self):
        assert _is_agent_managed({"skill_entry": "whatever"}) is True

    def test_empty_dict_not_agent_managed(self):
        assert _is_agent_managed({}) is False

    def test_empty_skill_entry_not_agent_managed(self):
        assert _is_agent_managed({"skill_entry": ""}) is False
        assert _is_agent_managed({"skill_entry": None}) is False


class TestIsArchived:
    def test_bool_true(self):
        assert _is_archived({"archived": True}) is True

    def test_bool_false(self):
        assert _is_archived({"archived": False}) is False

    def test_string_true(self):
        assert _is_archived({"archived": "true"}) is True

    def test_missing(self):
        assert _is_archived({}) is False


class TestSlugFromExternalId:
    def test_alfred_prefix(self):
        assert _slug_from_external_id("alfred:foo-bar") == "foo-bar"

    def test_missing_prefix(self):
        assert _slug_from_external_id("other:foo") is None

    def test_non_string(self):
        assert _slug_from_external_id(None) is None
        assert _slug_from_external_id(42) is None

    def test_empty_after_prefix(self):
        assert _slug_from_external_id("alfred:") is None
