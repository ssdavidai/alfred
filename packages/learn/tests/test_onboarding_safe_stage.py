"""Onboarding _safe_stage_wrapper — Phase 4 / Lane II, Commit 2.

The OnboardingPipeline must reach ``stage=done`` even when one or more
activities exhaust their retry budgets. ``_safe_stage_wrapper`` downgrades
a residual activity exception to a stage-degrade entry in
``onboard.json["degraded_stages"]`` and returns a sentinel so the workflow
continues to the next stage.

These tests run the wrapper through Temporal's ``WorkflowEnvironment`` /
``ActivityEnvironment`` so the behaviour is exercised in the same harness
the production worker uses.
"""
from __future__ import annotations

import asyncio
import json
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from temporalio import activity, workflow
from temporalio.client import Client, WorkflowFailureError
from temporalio.common import RetryPolicy
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from src.activities.onboarding import record_stage_degrade
from src.workflows.onboarding_pipeline import (
    _record_stage_degrade,
    _safe_stage_wrapper,
)


# --- sync helper used by direct-write tests ----------------------------


def _seed(tmp_path: Path) -> str:
    path = tmp_path / "onboard.json"
    path.write_text(json.dumps({
        "user_id": "u-1",
        "stage": "metadata",
        "progress": {"current_day": 0, "total_days": 0,
                     "facts_count": 0, "patterns_count": 0},
    }))
    return str(path)


def test_record_stage_degrade_appends(tmp_path) -> None:
    onboard = _seed(tmp_path)
    _record_stage_degrade(onboard, "facts", "boom")
    data = json.loads(Path(onboard).read_text())
    assert data.get("degraded_stages") == ["facts"]
    assert data.get("degraded_reasons", {}).get("facts") == "boom"


def test_record_stage_degrade_dedups(tmp_path) -> None:
    onboard = _seed(tmp_path)
    _record_stage_degrade(onboard, "facts", "first")
    _record_stage_degrade(onboard, "facts", "second")
    data = json.loads(Path(onboard).read_text())
    assert data.get("degraded_stages") == ["facts"]


def test_record_stage_degrade_multiple_stages(tmp_path) -> None:
    onboard = _seed(tmp_path)
    for s in ("facts", "patterns", "personalize"):
        _record_stage_degrade(onboard, s, f"{s} failed")
    data = json.loads(Path(onboard).read_text())
    assert data.get("degraded_stages") == ["facts", "patterns", "personalize"]


# --- Temporal-driven wrapper tests --------------------------------------


@activity.defn(name="_safe_stage_test_success")
async def _success_activity(onboard_path: str) -> dict[str, Any]:
    return {"ok": True, "facts_count": 7}


@activity.defn(name="_safe_stage_test_raise")
async def _raising_activity(onboard_path: str) -> dict[str, Any]:
    raise RuntimeError("activity boom")


@workflow.defn(name="_SafeStageProbeOk")
class _SafeStageProbeOk:
    @workflow.run
    async def run(self, onboard_path: str) -> dict[str, Any]:
        return await _safe_stage_wrapper(
            "facts", _success_activity, [onboard_path], onboard_path,
            start_to_close_timeout=timedelta(seconds=10),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )


@workflow.defn(name="_SafeStageProbeFail")
class _SafeStageProbeFail:
    @workflow.run
    async def run(self, onboard_path: str) -> dict[str, Any]:
        return await _safe_stage_wrapper(
            "facts", _raising_activity, [onboard_path], onboard_path,
            start_to_close_timeout=timedelta(seconds=10),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )


@workflow.defn(name="_SafeStageProbeMulti")
class _SafeStageProbeMulti:
    """Three-stage probe: facts FAILS, patterns succeeds, personalize FAILS.

    Mirrors the real onboarding shape — the workflow MUST still complete
    (return a dict). ``degraded_stages`` records both failures.
    """
    @workflow.run
    async def run(self, onboard_path: str) -> list[dict[str, Any]]:
        results = []
        results.append(await _safe_stage_wrapper(
            "facts", _raising_activity, [onboard_path], onboard_path,
            start_to_close_timeout=timedelta(seconds=10),
            retry_policy=RetryPolicy(maximum_attempts=1),
        ))
        results.append(await _safe_stage_wrapper(
            "patterns", _success_activity, [onboard_path], onboard_path,
            start_to_close_timeout=timedelta(seconds=10),
            retry_policy=RetryPolicy(maximum_attempts=1),
        ))
        results.append(await _safe_stage_wrapper(
            "personalize", _raising_activity, [onboard_path], onboard_path,
            start_to_close_timeout=timedelta(seconds=10),
            retry_policy=RetryPolicy(maximum_attempts=1),
        ))
        return results


async def _run_probe_workflow(
    workflow_cls: type, onboard_path: str,
) -> Any:
    """Boot a time-skipping WorkflowEnvironment, register the probe, run it."""
    async with await WorkflowEnvironment.start_time_skipping() as env:
        task_queue = f"test-safe-stage-{uuid4().hex[:8]}"
        async with Worker(
            env.client,
            task_queue=task_queue,
            workflows=[workflow_cls],
            activities=[_success_activity, _raising_activity,
                        record_stage_degrade],
            # The probe workflows import _safe_stage_wrapper from a module
            # that pulls in httpx (via the activity package). Skip the
            # sandbox — the wrapper logic is what we're exercising, not
            # determinism enforcement.
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            return await env.client.execute_workflow(
                workflow_cls.run,
                onboard_path,
                id=f"wf-{uuid4().hex[:8]}",
                task_queue=task_queue,
            )


def test_safe_stage_wrapper_passes_through_success(tmp_path) -> None:
    onboard = _seed(tmp_path)
    result = asyncio.run(_run_probe_workflow(_SafeStageProbeOk, onboard))
    assert result == {"ok": True, "facts_count": 7}
    data = json.loads(Path(onboard).read_text())
    assert "degraded_stages" not in data


def test_safe_stage_wrapper_records_degrade_on_uncaught_exception(
    tmp_path,
) -> None:
    onboard = _seed(tmp_path)
    result = asyncio.run(_run_probe_workflow(_SafeStageProbeFail, onboard))
    assert result.get("degraded") is True
    assert result.get("stage") == "facts"
    # Temporal wraps the inner RuntimeError in an ActivityError; the wrapper
    # captures whichever exception class made it through to the workflow.
    assert "Error" in result.get("error", "")
    data = json.loads(Path(onboard).read_text())
    assert "facts" in data.get("degraded_stages", []), (
        f"degraded_stages must record 'facts'; got {data.get('degraded_stages')!r}"
    )


def test_safe_stage_wrapper_workflow_always_reaches_completion(
    tmp_path,
) -> None:
    """The whole workflow runs to completion (returns a list) even when
    two of three stages fail — the core "no operator on the fly" guarantee.
    Today (pre-Commit-2) the equivalent uses of execute_activity would
    propagate the RuntimeError out and the workflow would FAIL.
    """
    onboard = _seed(tmp_path)
    results = asyncio.run(_run_probe_workflow(_SafeStageProbeMulti, onboard))
    assert isinstance(results, list) and len(results) == 3
    assert results[0].get("degraded") is True
    assert results[1].get("ok") is True            # mid-stage success
    assert results[2].get("degraded") is True

    data = json.loads(Path(onboard).read_text())
    assert "facts" in data.get("degraded_stages", [])
    assert "personalize" in data.get("degraded_stages", [])
    assert "patterns" not in data.get("degraded_stages", [])


# --- assertion suite activation: workflow always reaches done -----------


def test_always_reaches_done_via_safe_stage_wrapper(tmp_path) -> None:
    """Mirrors the Phase 4 assertion from test_onboarding_quality_golden:
    the pipeline reaches a terminal state even when its LLM stages fail.

    We don't run the full OnboardingPipelineWorkflow (its real activities
    require ctrl-api + Hermes), but we exercise the wrapper that the
    pipeline now uses for every heavy stage. The contract: a failed
    activity must NEVER propagate out of the wrapper.
    """
    onboard = _seed(tmp_path)
    asyncio.run(_run_probe_workflow(_SafeStageProbeMulti, onboard))
    data = json.loads(Path(onboard).read_text())
    # The "always reaches done" promise: the principal-visible audit trail
    # is intact and the wrapper never raised.
    assert "degraded_stages" in data
    assert len(data["degraded_stages"]) == 2
