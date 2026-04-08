"""Tests for assign_initial_chores wiring the generation chain (S4-8).

Covers:
  - `_generate_chore_from_opportunity` orchestration (generate → validate
    → smoke → deploy), verifying spec shape and failure handling at each
    phase
  - `_build_chore_content` quarantine metadata for generated chores
  - `_resolve_workflow_type` picks the right path for generated vs
    standard-library chores

All network/LLM calls are mocked — the generation chain is exercised
end-to-end in the smoke test on david's tenant.
"""
from __future__ import annotations

import asyncio
from unittest.mock import patch

from temporalio.testing import ActivityEnvironment

from src.activities.assign_chores import (
    _build_chore_content,
    _generate_chore_from_opportunity,
    _resolve_workflow_type,
    _slug_from_module_name,
)


def _run_in_activity_context(coro_factory):
    """Run a coroutine inside a Temporal ActivityEnvironment so
    activity.heartbeat() calls don't raise 'Not in activity context'.
    """
    env = ActivityEnvironment()

    async def wrapper():
        return await coro_factory()

    # Wrap as a fake activity so env.run installs the context
    from temporalio import activity

    @activity.defn(name="test_wrapper")
    async def _fake_activity() -> dict:
        return await coro_factory()

    return asyncio.run(env.run(_fake_activity))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sample_opportunity() -> dict:
    return {
        "id": "test-gym-tracker",
        "name": "Track Gym Attendance",
        "description": "Watch for gym check-in emails and flag missed weeks.",
        "goal": "stay consistent with gym attendance",
        "tags": ["health", "habit"],
    }


def _sample_profile() -> dict:
    return {
        "rhythm": {
            "work_start_estimate": 9,
            "work_end_estimate": 17,
            "peak_hours": [10, 14, 11],
        },
        "meta": {"email_count": 1500},
    }


def _mock_gen_result(module_name="gym_tracker", class_name="GymTrackerWorkflow"):
    return {
        "module_name": module_name,
        "workflow_class_name": class_name,
        "python_source": f'"""gen"""\nfrom temporalio import workflow\n@workflow.defn\nclass {class_name}:\n    pass\n',
        "prompt_hash": "abc123",
        "attempts": 1,
    }


# ---------------------------------------------------------------------------
# _slug_from_module_name
# ---------------------------------------------------------------------------

class TestSlugFromModuleName:
    def test_snake_to_kebab(self):
        assert _slug_from_module_name("gym_attendance_tracker") == "gym-attendance-tracker"

    def test_single_word(self):
        assert _slug_from_module_name("tracker") == "tracker"


# ---------------------------------------------------------------------------
# _resolve_workflow_type
# ---------------------------------------------------------------------------

class TestResolveWorkflowType:
    def test_standard_template_uses_registry(self):
        chore = {"template": "subscription_watcher"}
        assert _resolve_workflow_type(chore) == "SubscriptionWatcherWorkflow"

    def test_generated_template_uses_explicit_class_name(self):
        chore = {
            "template": "my_generated_module",  # not in the registry
            "workflow_class_name": "MyGeneratedWorkflow",
        }
        assert _resolve_workflow_type(chore) == "MyGeneratedWorkflow"

    def test_unknown_standard_template_raises(self):
        import pytest
        chore = {"template": "nonexistent_template"}
        with pytest.raises(ValueError, match="Unknown chore template"):
            _resolve_workflow_type(chore)

    def test_empty_workflow_class_falls_through_to_registry(self):
        chore = {"template": "subscription_watcher", "workflow_class_name": ""}
        assert _resolve_workflow_type(chore) == "SubscriptionWatcherWorkflow"


# ---------------------------------------------------------------------------
# _build_chore_content — quarantine metadata for generated chores
# ---------------------------------------------------------------------------

class TestBuildChoreContentGenerated:
    def test_standard_chore_has_no_quarantine_metadata(self):
        chore = {
            "template": "subscription_watcher",
            "name": "Subs",
            "schedule": "0 9 * * 5",
            "description": "Watch subs",
            "tags": ["chore"],
            "params": {"matter_domains": ["stripe.com"]},
        }
        content = _build_chore_content(chore, "chore-subs")
        assert "quarantine:" not in content
        assert "generated:" not in content

    def test_generated_chore_has_quarantine_true(self):
        chore = {
            "template": "gym_tracker",
            "workflow_class_name": "GymTrackerWorkflow",
            "name": "Gym",
            "schedule": "0 18 * * 5",
            "description": "Track gym",
            "tags": ["chore", "generated"],
            "params": {"chore_slug": "gym-tracker"},
            "generated": True,
        }
        content = _build_chore_content(chore, "chore-gym-tracker")
        assert "generated: true" in content
        assert "quarantine: true" in content
        assert "quarantine_remaining: 3" in content
        assert "workflow_class_name: GymTrackerWorkflow" in content
        assert "Generated chore" in content  # body note

    def test_generated_chore_without_class_name_still_valid(self):
        chore = {
            "template": "mod",
            "name": "Mod",
            "schedule": "0 9 * * 1",
            "description": "X",
            "tags": ["chore"],
            "params": {"chore_slug": "mod"},
            "generated": True,
        }
        content = _build_chore_content(chore, "chore-mod")
        assert "generated: true" in content
        assert "quarantine: true" in content
        # No workflow_class_name line if not provided
        assert "workflow_class_name:" not in content


# ---------------------------------------------------------------------------
# _generate_chore_from_opportunity
# ---------------------------------------------------------------------------

class TestGenerateChoreFromOpportunity:
    def test_happy_path_all_phases_succeed(self):
        with \
            patch("src.activities.chore_generation.generate_chore_template_code") as mock_gen, \
            patch("src.activities.chore_generation.validate_generated_template") as mock_val, \
            patch("src.activities.chore_generation.smoke_test_generated_template") as mock_smoke, \
            patch("src.activities.chore_generation.deploy_generated_template") as mock_dep:

            mock_gen.return_value = _mock_gen_result()
            mock_val.return_value = {"ok": True, "violations": [], "violation_count": 0}
            mock_smoke.return_value = {"ok": True, "phase": "done", "duration_seconds": 0.5}
            mock_dep.return_value = {
                "ok": True, "path": "/alfred-data/user-chores/gym_tracker.py",
                "source_hash": "abc", "bytes_written": 100, "idempotent": False,
            }

            result = _run_in_activity_context(
                lambda: _generate_chore_from_opportunity(_sample_opportunity(), _sample_profile())
            )

        assert result["ok"] is True
        assert result["spec"]["template"] == "gym_tracker"
        assert result["spec"]["workflow_class_name"] == "GymTrackerWorkflow"
        assert result["spec"]["generated"] is True
        assert result["spec"]["params"] == {"chore_slug": "gym-tracker"}
        assert "generated" in result["spec"]["tags"]
        assert "quarantine" in result["spec"]["tags"]
        assert result["phases"] == [
            "generated:1attempts", "validated",
            "smoke_ok:0.5s", "deployed",
        ]

    def test_generate_failure_returns_structured_error(self):
        from src.activities.chore_generation import ChoreGenerationError
        with patch("src.activities.chore_generation.generate_chore_template_code") as mock_gen:
            mock_gen.side_effect = ChoreGenerationError("exhausted 3 attempts")

            result = _run_in_activity_context(
                lambda: _generate_chore_from_opportunity(_sample_opportunity(), _sample_profile())
            )

        assert result["ok"] is False
        assert result["phase"] == "generate"
        assert "exhausted" in result["error"]
        assert result["opportunity_id"] == "test-gym-tracker"

    def test_validate_failure_halts_chain(self):
        with \
            patch("src.activities.chore_generation.generate_chore_template_code") as mock_gen, \
            patch("src.activities.chore_generation.validate_generated_template") as mock_val, \
            patch("src.activities.chore_generation.smoke_test_generated_template") as mock_smoke:

            mock_gen.return_value = _mock_gen_result()
            mock_val.return_value = {
                "ok": False,
                "violations": ["forbidden import: os"],
                "violation_count": 1,
            }

            result = _run_in_activity_context(
                lambda: _generate_chore_from_opportunity(_sample_opportunity(), _sample_profile())
            )

        assert result["ok"] is False
        assert result["phase"] == "validate"
        assert "forbidden import: os" in result["error"]
        # Smoke should NOT have been called after validate failure
        mock_smoke.assert_not_called()

    def test_smoke_failure_halts_chain(self):
        with \
            patch("src.activities.chore_generation.generate_chore_template_code") as mock_gen, \
            patch("src.activities.chore_generation.validate_generated_template") as mock_val, \
            patch("src.activities.chore_generation.smoke_test_generated_template") as mock_smoke, \
            patch("src.activities.chore_generation.deploy_generated_template") as mock_dep:

            mock_gen.return_value = _mock_gen_result()
            mock_val.return_value = {"ok": True, "violations": [], "violation_count": 0}
            mock_smoke.return_value = {
                "ok": False, "phase": "import",
                "error": "ModuleNotFoundError: bogus",
            }

            result = _run_in_activity_context(
                lambda: _generate_chore_from_opportunity(_sample_opportunity(), _sample_profile())
            )

        assert result["ok"] is False
        assert result["phase"] == "smoke"
        assert "import" in result["error"]
        mock_dep.assert_not_called()

    def test_deploy_failure_returns_structured_error(self):
        with \
            patch("src.activities.chore_generation.generate_chore_template_code") as mock_gen, \
            patch("src.activities.chore_generation.validate_generated_template") as mock_val, \
            patch("src.activities.chore_generation.smoke_test_generated_template") as mock_smoke, \
            patch("src.activities.chore_generation.deploy_generated_template") as mock_dep:

            mock_gen.return_value = _mock_gen_result()
            mock_val.return_value = {"ok": True, "violations": [], "violation_count": 0}
            mock_smoke.return_value = {"ok": True, "phase": "done", "duration_seconds": 0.3}
            mock_dep.return_value = {
                "ok": False, "error": "disk full",
                "path": "", "source_hash": "", "bytes_written": 0, "idempotent": False,
            }

            result = _run_in_activity_context(
                lambda: _generate_chore_from_opportunity(_sample_opportunity(), _sample_profile())
            )

        assert result["ok"] is False
        assert result["phase"] == "deploy"
        assert "disk full" in result["error"]

    def test_idempotent_deploy_still_returns_ok(self):
        with \
            patch("src.activities.chore_generation.generate_chore_template_code") as mock_gen, \
            patch("src.activities.chore_generation.validate_generated_template") as mock_val, \
            patch("src.activities.chore_generation.smoke_test_generated_template") as mock_smoke, \
            patch("src.activities.chore_generation.deploy_generated_template") as mock_dep:

            mock_gen.return_value = _mock_gen_result()
            mock_val.return_value = {"ok": True, "violations": [], "violation_count": 0}
            mock_smoke.return_value = {"ok": True, "phase": "done", "duration_seconds": 0.3}
            mock_dep.return_value = {
                "ok": True, "idempotent": True,
                "path": "/alfred-data/user-chores/gym_tracker.py",
                "source_hash": "abc", "bytes_written": 0,
            }

            result = _run_in_activity_context(
                lambda: _generate_chore_from_opportunity(_sample_opportunity(), _sample_profile())
            )

        assert result["ok"] is True
        assert "deployed:idempotent" in result["phases"]
