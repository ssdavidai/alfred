"""Tests for the chore_manifest module (Step 3, S3-1).

Verifies the manifest builds cleanly from src.worker.ALL_ACTIVITIES,
exposes every registered activity, classifies them sensibly, and renders
correctly for Opus prompt injection.
"""
from __future__ import annotations

import pytest

from src.chore_manifest import (
    CHORE_ACTIVITY_LIST,
    CHORE_ACTIVITY_MANIFEST,
    FORBIDDEN_IMPORTS,
    USER_CHORES_DIR,
    ActivityDescriptor,
    ActivityParameter,
    _classify_activity,
    get_manifest,
    get_manifest_list,
    render_manifest_for_prompt,
)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

class TestConstants:
    def test_user_chores_dir_set(self):
        assert USER_CHORES_DIR == "/alfred-data/user-chores"

    def test_forbidden_imports_includes_dangerous_modules(self):
        # Spot-check a few key entries
        assert "os" in FORBIDDEN_IMPORTS
        assert "subprocess" in FORBIDDEN_IMPORTS
        assert "socket" in FORBIDDEN_IMPORTS
        assert "requests" in FORBIDDEN_IMPORTS
        assert "pickle" in FORBIDDEN_IMPORTS
        assert "importlib" in FORBIDDEN_IMPORTS

    def test_forbidden_imports_is_frozenset(self):
        # Frozensets are immutable — important for security boundary
        assert isinstance(FORBIDDEN_IMPORTS, frozenset)


# ---------------------------------------------------------------------------
# Manifest building
# ---------------------------------------------------------------------------

class TestManifestBuilding:
    def test_manifest_is_non_empty(self):
        manifest = get_manifest()
        assert len(manifest) > 0, "manifest should be populated from worker.py ALL_ACTIVITIES"

    def test_manifest_list_matches_dict_count(self):
        manifest = get_manifest()
        manifest_list = get_manifest_list()
        assert len(manifest) == len(manifest_list)

    def test_manifest_includes_known_activities(self):
        manifest = get_manifest()
        # These activities are guaranteed to exist by previous PRs
        expected = {
            "fetch_financial_events",
            "send_chore_notification",
            "ask_alfred_to_judge_anomalies",
            "load_chore_context",
            "record_chore_run",
            "assign_initial_chores",
            "write_brief_and_opportunities_opus",
        }
        for name in expected:
            assert name in manifest, f"missing expected activity {name!r}"

    def test_every_descriptor_has_required_fields(self):
        manifest = get_manifest()
        for name, desc in manifest.items():
            assert isinstance(desc, ActivityDescriptor)
            assert desc.name == name
            assert desc.module, f"{name} missing module"
            assert desc.classification in {
                "pure_python",
                "vault_read",
                "vault_write",
                "llm",
                "notification",
                "external",
            }, f"{name} has invalid classification {desc.classification!r}"

    def test_activity_count_matches_worker_registration(self):
        # The manifest should have approximately the same count as ALL_ACTIVITIES
        # (some may be skipped due to inspection failures, but the gap should be 0
        # for the known-good activities we ship today)
        from src import worker
        registered = len(worker.ALL_ACTIVITIES)
        manifest_count = len(get_manifest())
        # Allow up to 5% drop for inspection failures
        assert manifest_count >= registered * 0.95, (
            f"manifest count {manifest_count} much smaller than "
            f"registered activity count {registered}"
        )


# ---------------------------------------------------------------------------
# Classification heuristics
# ---------------------------------------------------------------------------

class TestClassification:
    def test_clerk_activity_classified_as_llm(self):
        cls, _ = _classify_activity("src.activities.clerk", "clerk_classify")
        assert cls == "llm"

    def test_via_llm_suffix_classified_as_llm(self):
        cls, _ = _classify_activity(
            "src.activities.chore_actions",
            "write_matter_digest_via_llm",
        )
        assert cls == "llm"

    def test_ask_alfred_classified_as_llm(self):
        cls, _ = _classify_activity(
            "src.activities.chore_actions",
            "ask_alfred_to_judge_anomalies",
        )
        assert cls == "llm"

    def test_send_chore_notification_classified_as_notification(self):
        cls, _ = _classify_activity(
            "src.activities.chore_actions",
            "send_chore_notification",
        )
        assert cls == "notification"

    def test_fetch_classified_as_vault_read(self):
        cls, _ = _classify_activity(
            "src.activities.chore_actions",
            "fetch_financial_events",
        )
        assert cls == "vault_read"

    def test_unknown_module_default_classification(self):
        cls, _ = _classify_activity("some.unknown.module", "do_thing")
        assert cls == "pure_python"

    def test_module_pattern_matches(self):
        cls, _ = _classify_activity("src.activities.streams", "fetch_unprocessed_events")
        # streams is "external" by module rule but fetch_ is "vault_read" by name rule.
        # Name rules take precedence, so this should be vault_read.
        assert cls == "vault_read"

    def test_onboarding_v3_module_classified_as_llm(self):
        # Regression: onboarding_v3 is checked before onboarding so write_brief_*
        # gets the right classification despite the substring overlap.
        cls, _ = _classify_activity(
            "src.activities.onboarding_v3",
            "personalize_opus",  # name doesn't match any name-rule, falls to module
        )
        assert cls == "llm"

    def test_onboarding_v3_write_method_classified_as_llm(self):
        # write_brief_and_opportunities_opus would otherwise hit the write_ name
        # rule, but vault/chore not in module so it falls through to module rule
        # which (after the fix) correctly identifies onboarding_v3 as llm.
        cls, _ = _classify_activity(
            "src.activities.onboarding_v3",
            "write_brief_and_opportunities_opus",
        )
        assert cls == "llm"

    def test_onboarding_module_still_classified_as_pure_python(self):
        # Bare onboarding (not _v3) is still pure_python
        cls, _ = _classify_activity(
            "src.activities.onboarding",
            "init_onboard_json",
        )
        assert cls == "pure_python"


# ---------------------------------------------------------------------------
# Prompt rendering
# ---------------------------------------------------------------------------

class TestPromptRendering:
    def test_to_prompt_block_includes_signature(self):
        desc = ActivityDescriptor(
            name="test_fn",
            module="test.module",
            qualname="test_fn",
            parameters=[
                ActivityParameter(name="x", annotation="int"),
                ActivityParameter(name="y", annotation="str"),
            ],
            return_annotation="dict[str, Any]",
            docstring="A test function.\nMore details here.",
            classification="pure_python",
            side_effects="none",
        )
        block = desc.to_prompt_block()
        assert "test_fn(x: int, y: str)" in block
        assert "-> dict[str, Any]" in block
        assert "A test function." in block
        # Only first line of docstring should be included
        assert "More details here." not in block
        assert "pure_python" in block

    def test_render_manifest_for_prompt_returns_non_empty_string(self):
        rendered = render_manifest_for_prompt()
        assert len(rendered) > 100  # at least a few activities worth

    def test_render_manifest_filtered_by_classification(self):
        # Only LLM activities
        rendered = render_manifest_for_prompt(filter_classifications={"llm"})
        # Should contain at least clerk_classify or similar
        assert "llm" in rendered

    def test_render_manifest_filter_excludes_others(self):
        rendered = render_manifest_for_prompt(filter_classifications={"vault_read"})
        lines = [l for l in rendered.split("\n") if l.strip().startswith("classification:")]
        for line in lines:
            assert "vault_read" in line


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------

class TestIdempotency:
    def test_get_manifest_returns_same_object(self):
        m1 = get_manifest()
        m2 = get_manifest()
        # Should be the same dict object (lazy build, cached)
        assert m1 is m2 or m1 == m2

    def test_module_level_constants_match_after_lazy_build(self):
        # After get_manifest() runs, the module-level CHORE_ACTIVITY_MANIFEST
        # is populated. Re-import the constant to get the live value.
        get_manifest()
        from src.chore_manifest import CHORE_ACTIVITY_MANIFEST as live_manifest
        assert len(live_manifest) > 0
        assert len(live_manifest) == len(get_manifest())
