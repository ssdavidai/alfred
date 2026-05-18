"""Tests for the Opus-driven chore matcher (Step 3, S3-2).

Most coverage is on the helpers (template registry, prompt builder, response
validator) since the actual `_call_clerk` invocation requires the OpenClaw
gateway and is exercised end-to-end in the smoke test on david's tenant.
"""
from __future__ import annotations

from src.activities.chore_matching import (
    _build_match_prompt,
    _list_known_templates,
    _validate_match_response,
    _workflow_class_to_template_id,
)


# ---------------------------------------------------------------------------
# Workflow class → template id conversion
# ---------------------------------------------------------------------------

class TestWorkflowClassToTemplateId:
    def test_subscription_watcher(self):
        assert _workflow_class_to_template_id("SubscriptionWatcherWorkflow") == "subscription_watcher"

    def test_weekly_matter_digest(self):
        assert _workflow_class_to_template_id("WeeklyMatterDigestWorkflow") == "weekly_matter_digest"

    def test_no_workflow_suffix(self):
        # Should still work without the trailing "Workflow"
        assert _workflow_class_to_template_id("FooBar") == "foo_bar"

    def test_single_word(self):
        assert _workflow_class_to_template_id("FooWorkflow") == "foo"

    def test_already_lowercase(self):
        # Lowercase input has no boundaries to insert underscores at
        assert _workflow_class_to_template_id("foo_bar") == "foo_bar"


# ---------------------------------------------------------------------------
# Template registry
# ---------------------------------------------------------------------------

class TestListKnownTemplates:
    def test_returns_known_templates(self):
        templates = _list_known_templates()
        assert len(templates) > 0
        ids = {t["template_id"] for t in templates}
        assert "subscription_watcher" in ids
        assert "weekly_matter_digest" in ids

    def test_each_template_has_id_and_class(self):
        for t in _list_known_templates():
            assert "template_id" in t
            assert "workflow_name" in t
            assert t["workflow_name"].endswith("Workflow")


# ---------------------------------------------------------------------------
# Prompt builder
# ---------------------------------------------------------------------------

class TestBuildMatchPrompt:
    def _opps(self) -> list[dict]:
        return [
            {
                "id": "watch-subscriptions",
                "name": "Watch subscriptions",
                "description": "Catch billing failures",
                "goal": "Prevent service interruptions",
                "trigger": {"kind": "cron", "hint": "weekly"},
                "frequency_hint": "weekly",
                "tags": ["financial"],
            },
        ]

    def _templates(self) -> list[dict]:
        return [
            {"template_id": "subscription_watcher", "workflow_name": "SubscriptionWatcherWorkflow"},
        ]

    def test_includes_opportunity_data(self):
        prompt = _build_match_prompt(
            opportunities=self._opps(),
            templates=self._templates(),
            manifest_block="(manifest)",
            template_examples={},
        )
        assert "watch-subscriptions" in prompt
        assert "Catch billing failures" in prompt

    def test_includes_template_listing(self):
        prompt = _build_match_prompt(
            opportunities=self._opps(),
            templates=self._templates(),
            manifest_block="(manifest)",
            template_examples={},
        )
        assert "subscription_watcher" in prompt
        assert "SubscriptionWatcherWorkflow" in prompt

    def test_includes_manifest_block(self):
        prompt = _build_match_prompt(
            opportunities=self._opps(),
            templates=self._templates(),
            manifest_block="MANIFEST_BLOCK_MARKER",
            template_examples={},
        )
        assert "MANIFEST_BLOCK_MARKER" in prompt

    def test_includes_examples_when_provided(self):
        prompt = _build_match_prompt(
            opportunities=self._opps(),
            templates=self._templates(),
            manifest_block="(manifest)",
            template_examples={"subscription_watcher": "EXAMPLE_SOURCE_BODY"},
        )
        assert "EXAMPLE_SOURCE_BODY" in prompt
        assert "Template `subscription_watcher`" in prompt

    def test_skips_empty_example_sources(self):
        prompt = _build_match_prompt(
            opportunities=self._opps(),
            templates=self._templates(),
            manifest_block="(manifest)",
            template_examples={"subscription_watcher": ""},
        )
        # No "Template `subscription_watcher`" header when source is empty
        assert "Template `subscription_watcher`" not in prompt

    def test_includes_retry_feedback(self):
        prompt = _build_match_prompt(
            opportunities=self._opps(),
            templates=self._templates(),
            manifest_block="(manifest)",
            template_examples={},
            retry_feedback="previous response was malformed",
        )
        assert "previous response was malformed" in prompt
        assert "previous attempt failed" in prompt

    def test_no_retry_block_when_feedback_empty(self):
        prompt = _build_match_prompt(
            opportunities=self._opps(),
            templates=self._templates(),
            manifest_block="(manifest)",
            template_examples={},
        )
        assert "previous attempt failed" not in prompt


# ---------------------------------------------------------------------------
# Response validator
# ---------------------------------------------------------------------------

class TestValidateMatchResponse:
    def _ids(self) -> set[str]:
        return {"watch-subs", "weekly-digest", "gym-tracker"}

    def _templates(self) -> set[str]:
        return {"subscription_watcher", "weekly_matter_digest"}

    def test_happy_path(self):
        parsed = {
            "matched": [
                {
                    "opportunity_id": "watch-subs",
                    "template_id": "subscription_watcher",
                    "params": {"alert_threshold": 0.7},
                    "reason": "fits perfectly",
                },
            ],
            "unmatched": [
                {"opportunity_id": "weekly-digest", "reason": "wrong scope"},
                {"opportunity_id": "gym-tracker", "reason": "needs new template"},
            ],
        }
        matched, unmatched, err = _validate_match_response(
            parsed, self._ids(), self._templates(),
        )
        assert err == ""
        assert len(matched) == 1
        assert len(unmatched) == 2
        assert matched[0]["template_id"] == "subscription_watcher"

    def test_missing_matched_key_returns_error(self):
        matched, unmatched, err = _validate_match_response(
            {"unmatched": []}, self._ids(), self._templates(),
        )
        assert err
        assert "missing" in err

    def test_unknown_template_id_becomes_unmatched(self):
        parsed = {
            "matched": [
                {
                    "opportunity_id": "watch-subs",
                    "template_id": "imaginary_template",
                    "params": {},
                    "reason": "n/a",
                },
            ],
            "unmatched": [],
        }
        matched, unmatched, err = _validate_match_response(
            parsed, self._ids(), self._templates(),
        )
        # The matched entry is rejected and the opportunity moves to unmatched
        assert len(matched) == 0
        assert len(unmatched) == 3  # watch-subs (rejected) + 2 missing
        # All 3 opportunities should be accounted for in unmatched
        unmatched_ids = {u["opportunity_id"] for u in unmatched}
        assert unmatched_ids == self._ids()
        # The rejected one should have a reason mentioning the unknown template
        watch_entry = next(u for u in unmatched if u["opportunity_id"] == "watch-subs")
        assert "imaginary_template" in watch_entry["reason"]

    def test_omitted_opportunities_marked_unmatched(self):
        # Opus only returns 1 opportunity but we asked about 3
        parsed = {
            "matched": [
                {
                    "opportunity_id": "watch-subs",
                    "template_id": "subscription_watcher",
                    "params": {},
                    "reason": "fits",
                },
            ],
            "unmatched": [],
        }
        matched, unmatched, err = _validate_match_response(
            parsed, self._ids(), self._templates(),
        )
        assert err == ""
        assert len(matched) == 1
        # The 2 omitted ones should auto-flag as unmatched
        assert len(unmatched) == 2
        for entry in unmatched:
            assert "omitted" in entry["reason"]

    def test_unknown_opportunity_id_dropped(self):
        # Opus invented an opportunity id that wasn't in the input
        parsed = {
            "matched": [
                {
                    "opportunity_id": "made-up-id",
                    "template_id": "subscription_watcher",
                    "params": {},
                    "reason": "fits",
                },
            ],
            "unmatched": [],
        }
        matched, unmatched, err = _validate_match_response(
            parsed, self._ids(), self._templates(),
        )
        assert len(matched) == 0
        # All 3 input opportunities should be in unmatched (auto-flagged)
        assert len(unmatched) == 3

    def test_non_dict_entries_skipped(self):
        parsed = {
            "matched": ["not a dict", None, {"opportunity_id": "watch-subs", "template_id": "subscription_watcher"}],
            "unmatched": [],
        }
        matched, unmatched, err = _validate_match_response(
            parsed, self._ids(), self._templates(),
        )
        assert len(matched) == 1
        assert matched[0]["opportunity_id"] == "watch-subs"

    def test_non_dict_params_normalized_to_empty_dict(self):
        parsed = {
            "matched": [
                {
                    "opportunity_id": "watch-subs",
                    "template_id": "subscription_watcher",
                    "params": "not a dict",
                },
            ],
            "unmatched": [],
        }
        matched, _, _ = _validate_match_response(
            parsed, self._ids(), self._templates(),
        )
        assert len(matched) == 1
        assert matched[0]["params"] == {}

    def test_duplicate_opportunity_in_matched_and_unmatched_resolves(self):
        parsed = {
            "matched": [
                {
                    "opportunity_id": "watch-subs",
                    "template_id": "subscription_watcher",
                    "params": {},
                },
            ],
            "unmatched": [
                {"opportunity_id": "watch-subs", "reason": "duplicate"},
            ],
        }
        matched, unmatched, _ = _validate_match_response(
            parsed, self._ids(), self._templates(),
        )
        # The matched takes precedence; unmatched dup is dropped
        assert len(matched) == 1
        assert all(u["opportunity_id"] != "watch-subs" for u in unmatched)
