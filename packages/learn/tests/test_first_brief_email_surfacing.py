"""#B3 — a never-delivered First Brief email must be VISIBLE.

FAILURE-MODES Brief, S2: ``send_first_brief_email`` returns
``{"sent": False, ...}`` on every failure path, and the onboarding
pipeline swallowed that dict in a warning-only ``try/except`` — so a brief
that was never emailed looked identical to one that was, and onboarding
reported ``done`` either way.

The fix surfaces the delivery outcome on ``OnboardingResult`` (a durable,
queryable Temporal workflow result) without crashing the pipeline. These
tests assert the result distinguishes delivered from not-delivered.
"""
from __future__ import annotations

import uuid
from typing import Any

from temporalio import activity
from temporalio.client import Client
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from src.workflows.onboarding_pipeline import (
    OnboardingInput,
    OnboardingPipelineWorkflow,
    OnboardingResult,
)


def _make_stubs(email_result: dict[str, Any]) -> list:
    """No-op stubs for every onboarding activity; ``send_first_brief_email``
    returns ``email_result`` so a test can drive the delivery outcome.
    init_onboard_json reports stage="brief" so the pipeline runs the brief
    finale (email step) and reaches done.
    """

    def _rec(name: str):
        @activity.defn(name=name)
        async def _stub(*args: Any, **kwargs: Any) -> dict[str, Any]:
            return {}

        return _stub

    @activity.defn(name="init_onboard_json")
    async def stub_init(onboard_path: str, user_id: str) -> dict[str, Any]:
        return {"user_id": user_id, "stage": "brief", "facts": [],
                "patterns": [], "progress": {"current_day": 0, "total_days": 0}}

    @activity.defn(name="update_onboard_stage")
    async def stub_stage(onboard_path: str, stage: str) -> None:
        return None

    @activity.defn(name="persist_onboarding_mode")
    async def stub_persist(onboard_path: str, stream_id: str,
                           gmail_mode: str, composio_action: str) -> None:
        # Real signature returns None — a dict here fails payload decode.
        return None

    @activity.defn(name="assign_initial_chores")
    async def stub_chores(onboard_path: str, user_id: str) -> dict[str, Any]:
        return {"generated": 0}

    @activity.defn(name="send_first_brief_email")
    async def stub_email(brief_path: str | None) -> dict[str, Any]:
        return email_result

    return [
        stub_init, stub_stage, stub_persist, stub_chores, stub_email,
        _rec("write_brief_and_opportunities_opus"),
        _rec("generate_matter_pack_opus"),
        _rec("generate_instinct_pack_opus"),
        _rec("generate_errand_pack_opus"),
        _rec("generate_stream_pack"),
        _rec("restart_learn_worker"),
        _rec("process_stream_batch"),
    ]


async def _run(email_result: dict[str, Any]) -> OnboardingResult:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"first-brief-email-test-{uuid.uuid4()}"
        worker = Worker(
            client, task_queue=tq,
            workflows=[OnboardingPipelineWorkflow],
            activities=_make_stubs(email_result),
        )
        async with worker:
            return await client.execute_workflow(
                OnboardingPipelineWorkflow.run,
                OnboardingInput(user_id="u1", resume_stage="brief"),
                id=f"first-brief-email-run-{uuid.uuid4()}",
                task_queue=tq,
            )


async def test_result_has_brief_email_delivered_field() -> None:
    """OnboardingResult exposes a delivery field defaulting to a not-True
    sentinel (so an unset / pre-#B3 payload is never mistaken for sent)."""
    r = OnboardingResult()
    assert hasattr(r, "brief_email_delivered")
    assert r.brief_email_delivered is not True


async def test_failed_delivery_is_visible_in_result() -> None:
    """A {sent: False} delivery surfaces as brief_email_delivered=False —
    NOT swallowed — while the pipeline still completes (no crash)."""
    result = await _run({"sent": False, "reason": "no OWNER_EMAIL configured"})
    assert result.brief_email_delivered is False


async def test_successful_delivery_is_visible_in_result() -> None:
    result = await _run({"sent": True, "reason": "ok", "status_code": 202})
    assert result.brief_email_delivered is True
