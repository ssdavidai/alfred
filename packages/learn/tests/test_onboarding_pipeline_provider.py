"""OnboardingPipelineWorkflow's email-provider branch (issue #758).

The provider is a second axis alongside gmail_mode. These tests pin the
runtime branch (Outlook selects the Outlook collectors), the unknown-provider
refusal, the replay-safe defaults, and the ``persist_onboarding_provider``
activity. Reuses the Gmail-mode test's stub factory and adds the Outlook +
provider stubs so the worker has every activity the workflow may call.
"""
from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path
from typing import Any

import pytest
from temporalio import activity
from temporalio.client import Client
from temporalio.exceptions import ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # sibling test modules

from src.activities.onboarding import persist_onboarding_provider  # noqa: E402
from src.workflows.onboarding_pipeline import (  # noqa: E402
    OnboardingInput,
    OnboardingPipelineWorkflow,
)
from test_onboarding_pipeline_gmail_mode import _make_stubs  # noqa: E402


def _stubs_with_outlook(init_stage: str):
    """The Gmail-mode stub set plus Outlook + provider stubs, sharing state."""
    stubs, state = _make_stubs(init_stage=init_stage)

    @activity.defn(name="composio_fetch_email_metadata_outlook")
    async def stub_out_fetch(user_id: str) -> dict[str, Any]:
        state["email_calls"].append("outlook")
        return {"count": 0, "domains": 0}

    @activity.defn(name="composio_backfill_outlook_as_events")
    async def stub_out_backfill(
        stream_id: str, user_id: str, days: int = 100, max_messages: int = 5000,
    ) -> int:
        state["backfill_calls"].append("outlook")
        return 0

    @activity.defn(name="persist_onboarding_provider")
    async def stub_persist_provider(
        onboard_path: str, email_provider: str, connection_id: str,
    ) -> None:
        state["persisted_provider"] = email_provider
        state["persisted_connection"] = connection_id
        return None

    return stubs + [stub_out_fetch, stub_out_backfill, stub_persist_provider], state


async def _run(stubs: list, inp: OnboardingInput) -> None:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"onboarding-provider-test-{uuid.uuid4()}"
        worker = Worker(
            client, task_queue=tq,
            workflows=[OnboardingPipelineWorkflow], activities=stubs,
        )
        async with worker:
            await client.execute_workflow(
                OnboardingPipelineWorkflow.run, inp,
                id=f"onboarding-provider-run-{uuid.uuid4()}", task_queue=tq,
            )


# --- dataclass defaults (replay safety) ------------------------------------

def test_input_has_provider_fields_defaulting_to_gmail() -> None:
    inp = OnboardingInput(user_id="u1")
    assert inp.email_provider == "gmail"
    assert inp.connection_id == ""


# --- the persist activity ---------------------------------------------------

@pytest.mark.asyncio
async def test_persist_provider_writes_fields(tmp_path: Path) -> None:
    p = tmp_path / "onboard.json"
    p.write_text("{}")
    await persist_onboarding_provider(str(p), "outlook", "ca_x")
    data = json.loads(p.read_text())
    assert data["email_provider"] == "outlook"
    assert data["connection_id"] == "ca_x"


@pytest.mark.asyncio
async def test_persist_provider_normalises_unknown(tmp_path: Path) -> None:
    p = tmp_path / "onboard.json"
    p.write_text("{}")
    await persist_onboarding_provider(str(p), "yahoo", "")
    assert json.loads(p.read_text())["email_provider"] == "gmail"


# --- runtime branch ---------------------------------------------------------

async def test_metadata_stage_selects_outlook() -> None:
    stubs, state = _stubs_with_outlook(init_stage="metadata")
    await _run(stubs, OnboardingInput(
        user_id="u1", email_provider="outlook", connection_id="ca_x",
    ))
    assert state["email_calls"] == ["outlook"]
    assert state["persisted_provider"] == "outlook"
    assert state["persisted_connection"] == "ca_x"


async def test_metadata_stage_defaults_gmail_when_provider_unset() -> None:
    stubs, state = _stubs_with_outlook(init_stage="metadata")
    await _run(stubs, OnboardingInput(user_id="u1"))
    # gmail default → the direct-Gmail path, never Outlook
    assert state["email_calls"] == ["google"]
    assert "outlook" not in state["email_calls"]


async def test_background_backfill_selects_outlook() -> None:
    stubs, state = _stubs_with_outlook(init_stage="brief")
    await _run(stubs, OnboardingInput(
        user_id="u1", stream_id="s1", email_provider="outlook",
    ))
    assert state["backfill_calls"] == ["outlook"]


async def test_unknown_provider_raises() -> None:
    stubs, _ = _stubs_with_outlook(init_stage="metadata")
    with pytest.raises(Exception) as ei:
        await _run(stubs, OnboardingInput(user_id="u1", email_provider="yahoo"))
    # surfaces as a workflow failure whose cause is our non-retryable error
    cause = getattr(ei.value, "cause", None)
    blob = f"{ei.value} | {cause} | {getattr(cause, 'type', '')} | {getattr(cause, 'message', '')}"
    assert "email_provider" in blob or "InvalidEmailProvider" in blob


# --- static replay-safety guard --------------------------------------------

def test_new_activity_call_is_patched() -> None:
    """The new persist_onboarding_provider call must be gated with
    workflow.patched(), or replay of pre-#758 in-flight histories diverges."""
    src = (ROOT / "src/workflows/onboarding_pipeline.py").read_text()
    assert 'workflow.patched("758-onboarding-provider")' in src
    # the outlook activities are wired into the selection expressions
    assert "composio_fetch_email_metadata_outlook" in src
    assert "composio_backfill_outlook_as_events" in src
