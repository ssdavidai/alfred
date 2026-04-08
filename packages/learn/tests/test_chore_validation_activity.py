"""Tests for the validate_generated_template activity (Step 4, S4-5).

The underlying static validator is exhaustively tested in
test_dynamic_loader.py. These tests focus on the THIN ACTIVITY WRAPPER:
  - returns a serializable dict (not a dataclass)
  - never raises on validation failure (returns structured result)
  - shape matches {ok, violations, violation_count}
  - delegates correctly to validate_template_source

Uses asyncio.run + ActivityEnvironment directly (no pytest-asyncio
dependency) to match the rest of the learn test suite.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from temporalio.testing import ActivityEnvironment

from src.activities.chore_generation import validate_generated_template


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_activity(source: str) -> dict:
    """Execute validate_generated_template in an ActivityEnvironment."""
    env = ActivityEnvironment()
    return asyncio.run(env.run(validate_generated_template, source))


def _good_template_source() -> str:
    return '''"""Valid generated template used by activity wrapper tests."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.workflows.chores._base import load_chore_context, record_chore_run
    from src.activities.chore_actions import fetch_financial_events


@dataclass
class TestInput:
    chore_slug: str


@dataclass
class TestResult:
    notes: str = ""


@workflow.defn(name="ActivityWrapperTestWorkflow")
class ActivityWrapperTestWorkflow:
    @workflow.run
    async def run(self, input: TestInput) -> TestResult:
        await workflow.execute_activity(
            load_chore_context,
            args=[input.chore_slug],
            start_to_close_timeout=timedelta(seconds=15),
        )
        return TestResult(notes="ok")
'''


def _bad_template_source() -> str:
    """Contains a forbidden import — should fail validation."""
    return '''from __future__ import annotations
import os  # forbidden

from dataclasses import dataclass
from temporalio import workflow


@workflow.defn
class BrokenWorkflow:
    @workflow.run
    async def run(self) -> str:
        return os.environ.get("OOPS", "")
'''


# ---------------------------------------------------------------------------
# Activity wrapper happy path
# ---------------------------------------------------------------------------

class TestValidateActivityHappyPath:
    def test_valid_source_returns_ok_true(self):
        result = _run_activity(_good_template_source())

        assert result["ok"] is True
        assert result["violations"] == []
        assert result["violation_count"] == 0

    def test_result_is_plain_dict_not_dataclass(self):
        """Temporal activity results must be JSON-serializable."""
        result = _run_activity(_good_template_source())

        assert isinstance(result, dict)
        # violations must be a list, not a tuple or dataclass field
        assert isinstance(result["violations"], list)
        assert isinstance(result["ok"], bool)
        assert isinstance(result["violation_count"], int)

    def test_result_keys_are_exactly_the_contract(self):
        result = _run_activity(_good_template_source())

        assert set(result.keys()) == {"ok", "violations", "violation_count"}


# ---------------------------------------------------------------------------
# Activity wrapper failure path
# ---------------------------------------------------------------------------

class TestValidateActivityFailurePath:
    def test_invalid_source_does_not_raise(self):
        """The activity must return a structured result, never raise,
        so the caller's retry loop can feed violations back into the
        next generation prompt."""
        # Must not raise
        result = _run_activity(_bad_template_source())

        assert result["ok"] is False
        assert result["violation_count"] > 0
        assert len(result["violations"]) == result["violation_count"]

    def test_forbidden_import_reported_in_violations(self):
        result = _run_activity(_bad_template_source())

        assert result["ok"] is False
        combined = " ".join(result["violations"])
        assert "os" in combined  # forbidden import name appears

    def test_syntax_error_reported(self):
        broken = "from __future__ import annotations\n\nthis is not valid python ::: ???"
        result = _run_activity(broken)

        assert result["ok"] is False
        assert any("syntax" in v.lower() for v in result["violations"])

    def test_empty_source_fails_gracefully(self):
        result = _run_activity("")

        assert result["ok"] is False
        # Empty source has no @workflow.defn class
        assert result["violation_count"] >= 1

    def test_oversized_source_rejected(self):
        oversized = "x = 1\n" * 50_000  # > 100KB
        result = _run_activity(oversized)

        assert result["ok"] is False
        assert any("too large" in v for v in result["violations"])


# ---------------------------------------------------------------------------
# Regression: existing standard-library templates must pass via the activity
# ---------------------------------------------------------------------------

class TestValidateActivityAgainstStandardLibrary:
    def test_subscription_watcher_validates_via_activity(self):
        path = Path("src/workflows/chores/subscription_watcher.py")
        if not path.exists():
            return  # running outside the learn package directory

        result = _run_activity(path.read_text())

        assert result["ok"] is True, f"subscription_watcher failed via activity: {result['violations']}"

    def test_weekly_matter_digest_validates_via_activity(self):
        path = Path("src/workflows/chores/weekly_matter_digest.py")
        if not path.exists():
            return  # running outside the learn package directory

        result = _run_activity(path.read_text())

        assert result["ok"] is True, f"weekly_matter_digest failed via activity: {result['violations']}"
