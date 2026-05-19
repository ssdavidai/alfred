"""Tests for OnboardingPipelineWorkflow's Gmail-mode branch (issue #70, P3).

P3 gives the onboarding pipeline's email stages a Composio fetch path,
selected by ``OnboardingInput.gmail_mode``:

  * ``gmail_mode == "composio"`` → ``composio_fetch_email_metadata`` /
    ``composio_backfill_gmail_as_events`` (GMAIL_FETCH_EMAILS via managed
    OAuth).
  * ``gmail_mode == "google"`` (the default) → the legacy direct-Gmail
    ``fetch_email_metadata`` / ``backfill_gmail_as_events`` — UNCHANGED.

Temporal-replay safety: the mode is a deterministic field on the workflow
input. The workflow reads it ONCE into a local and branches on that local;
it never touches ``os.environ`` inside the workflow body. These tests pin
both the runtime branch (end-to-end through WorkflowEnvironment) and the
replay-safety invariant (static source check).
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path
from typing import Any

import pytest
from temporalio import activity
from temporalio.client import Client
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.onboarding import persist_onboarding_mode  # noqa: E402
from src.workflows.onboarding_pipeline import (  # noqa: E402
    OnboardingInput,
    OnboardingPipelineWorkflow,
)


# ---------------------------------------------------------------------------
# persist_onboarding_mode — writes the mode contract into onboard.json.
# ---------------------------------------------------------------------------


async def test_persist_onboarding_mode_writes_contract_fields(tmp_path: Path) -> None:
    import json

    onboard_path = tmp_path / "onboard.json"
    onboard_path.write_text(json.dumps({"user_id": "u1", "stage": "metadata"}))

    await persist_onboarding_mode(
        str(onboard_path), "stream-9", "composio", "GMAIL_FETCH_EMAILS",
    )

    data = json.loads(onboard_path.read_text())
    assert data["stream_id"] == "stream-9"
    assert data["gmail_mode"] == "composio"
    assert data["composio_action"] == "GMAIL_FETCH_EMAILS"
    # Existing keys preserved.
    assert data["user_id"] == "u1"
    assert data["stage"] == "metadata"


async def test_persist_onboarding_mode_normalises_unknown_mode(tmp_path: Path) -> None:
    import json

    onboard_path = tmp_path / "onboard.json"
    onboard_path.write_text(json.dumps({"user_id": "u1"}))

    # A garbage mode falls back to the safe "google" default.
    await persist_onboarding_mode(str(onboard_path), "", "bogus", "")

    data = json.loads(onboard_path.read_text())
    assert data["gmail_mode"] == "google"
    # No composio_action written when empty.
    assert "composio_action" not in data


# ---------------------------------------------------------------------------
# Replay-safety static invariant — the workflow body must NOT read env.
# ---------------------------------------------------------------------------


def test_workflow_body_never_reads_env_for_gmail_mode() -> None:
    """The workflow file must not read os.environ — the Gmail mode comes
    only from OnboardingInput. An env read inside @workflow.run is a
    Temporal non-determinism bug (replay on a host with different env
    diverges from history).
    """
    src = (ROOT / "src" / "workflows" / "onboarding_pipeline.py").read_text()
    assert "os.environ" not in src, (
        "onboarding_pipeline.py reads os.environ — the Gmail mode must "
        "come from OnboardingInput.gmail_mode, never from env, or replay "
        "determinism breaks."
    )
    assert "import os" not in src, (
        "onboarding_pipeline.py imports os — the workflow body must stay "
        "env-free for replay safety."
    )


def test_onboarding_input_has_gmail_mode_field_defaulting_to_google() -> None:
    """gmail_mode exists and defaults to 'google' so onboardings started
    before P2 stamps the field keep the legacy behaviour unchanged.
    """
    inp = OnboardingInput(user_id="u1")
    assert inp.gmail_mode == "google"
    # Explicitly settable for the Composio path.
    assert OnboardingInput(user_id="u1", gmail_mode="composio").gmail_mode == "composio"


# ---------------------------------------------------------------------------
# End-to-end workflow runs — which email activity fires per mode.
# ---------------------------------------------------------------------------


def _make_stubs(init_stage: str) -> tuple[list, dict[str, Any]]:
    """Build no-op stubs for every onboarding activity.

    The four email activities are stubbed under their REAL registered
    names and record their invocation in ``state`` so a test can assert
    which path the workflow took. ``init_onboard_json`` returns a state
    whose ``stage`` controls where the workflow resumes.
    """
    state: dict[str, Any] = {"email_calls": [], "backfill_calls": []}

    @activity.defn(name="init_onboard_json")
    async def stub_init(onboard_path: str, user_id: str) -> dict[str, Any]:
        return {
            "user_id": user_id,
            "stage": init_stage,
            "facts": [],
            "patterns": [],
            "progress": {"current_day": 0, "total_days": 0},
        }

    @activity.defn(name="persist_onboarding_mode")
    async def stub_persist_mode(
        onboard_path: str, stream_id: str, gmail_mode: str, composio_action: str,
    ) -> None:
        state["persisted_mode"] = gmail_mode
        return None

    @activity.defn(name="update_onboard_stage")
    async def stub_stage(onboard_path: str, stage: str) -> None:
        return None

    # --- the two email-metadata activities (Stage 1) ---
    @activity.defn(name="fetch_email_metadata")
    async def stub_fetch(user_id: str) -> dict[str, Any]:
        state["email_calls"].append("google")
        return {"count": 0, "domains": 0}

    @activity.defn(name="composio_fetch_email_metadata")
    async def stub_composio_fetch(user_id: str) -> dict[str, Any]:
        state["email_calls"].append("composio")
        return {"count": 0, "domains": 0}

    # --- the two background-backfill activities ---
    @activity.defn(name="backfill_gmail_as_events")
    async def stub_backfill(
        stream_id: str, user_id: str, days: int = 100, max_messages: int = 5000,
    ) -> int:
        state["backfill_calls"].append("google")
        return 0

    @activity.defn(name="composio_backfill_gmail_as_events")
    async def stub_composio_backfill(
        stream_id: str, user_id: str, days: int = 100, max_messages: int = 5000,
    ) -> int:
        state["backfill_calls"].append("composio")
        return 0

    # --- everything else: trivial no-ops ---
    @activity.defn(name="run_behavioral_profiler")
    async def stub_profiler(onboard_path: str) -> dict[str, Any]:
        return {}

    @activity.defn(name="extract_facts_opus")
    async def stub_facts(onboard_path: str) -> dict[str, Any]:
        return {"facts": [], "count": 0}

    @activity.defn(name="discover_patterns_opus")
    async def stub_patterns(onboard_path: str) -> dict[str, Any]:
        return {"patterns": [], "count": 0}

    @activity.defn(name="personalize_opus")
    async def stub_personalize(onboard_path: str) -> dict[str, Any]:
        return {}

    @activity.defn(name="write_brief_and_opportunities_opus")
    async def stub_brief(onboard_path: str) -> dict[str, Any]:
        return {}

    @activity.defn(name="generate_matter_pack_opus")
    async def stub_matter(onboard_path: str) -> dict[str, Any]:
        return {}

    @activity.defn(name="generate_instinct_pack_opus")
    async def stub_instinct(onboard_path: str) -> dict[str, Any]:
        return {}

    @activity.defn(name="generate_errand_pack_opus")
    async def stub_errand(onboard_path: str) -> dict[str, Any]:
        return {}

    @activity.defn(name="generate_stream_pack")
    async def stub_stream_pack(onboard_path: str) -> dict[str, Any]:
        return {}

    @activity.defn(name="assign_initial_chores")
    async def stub_chores(onboard_path: str, user_id: str) -> dict[str, Any]:
        return {"generated": 0}

    @activity.defn(name="restart_learn_worker")
    async def stub_restart() -> dict[str, Any]:
        return {}

    @activity.defn(name="send_first_brief_email")
    async def stub_send(brief_path: str) -> dict[str, Any]:
        return {}

    @activity.defn(name="process_stream_batch")
    async def stub_batch(stream_id: str, stream_type: str = "gmail") -> dict[str, Any]:
        return {}

    return [
        stub_init, stub_persist_mode, stub_stage, stub_fetch,
        stub_composio_fetch, stub_backfill, stub_composio_backfill,
        stub_profiler, stub_facts, stub_patterns, stub_personalize,
        stub_brief, stub_matter, stub_instinct, stub_errand,
        stub_stream_pack, stub_chores, stub_restart, stub_send, stub_batch,
    ], state


async def _run(stubs: list, inp: OnboardingInput) -> None:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"onboarding-mode-test-{uuid.uuid4()}"
        worker = Worker(
            client,
            task_queue=tq,
            workflows=[OnboardingPipelineWorkflow],
            activities=stubs,
        )
        async with worker:
            await client.execute_workflow(
                OnboardingPipelineWorkflow.run,
                inp,
                id=f"onboarding-mode-run-{uuid.uuid4()}",
                task_queue=tq,
            )


@pytest.mark.parametrize(
    "mode,expected", [("google", "google"), ("composio", "composio")],
)
async def test_metadata_stage_picks_activity_by_mode(mode: str, expected: str) -> None:
    """Stage 1 runs the email-metadata activity matching gmail_mode.

    init_stage='metadata' → the workflow runs the metadata stage and
    returns early at awaiting_verification (background backfill not
    reached).
    """
    stubs, state = _make_stubs(init_stage="metadata")
    await _run(stubs, OnboardingInput(user_id="u1", gmail_mode=mode))
    assert state["email_calls"] == [expected]
    # Returned at awaiting_verification — backfill stage not reached.
    assert state["backfill_calls"] == []
    # The mode is persisted to onboard.json so a brief-stage resume
    # stays on the same Gmail path (#69 P2 contract).
    assert state["persisted_mode"] == expected


async def test_metadata_stage_defaults_to_google_when_mode_unset() -> None:
    """An OnboardingInput with no gmail_mode (pre-P2 payload) uses the
    legacy direct-Gmail path — the Composio path is opt-in only.
    """
    stubs, state = _make_stubs(init_stage="metadata")
    await _run(stubs, OnboardingInput(user_id="u1"))
    assert state["email_calls"] == ["google"]


@pytest.mark.parametrize(
    "mode,expected", [("google", "google"), ("composio", "composio")],
)
async def test_background_backfill_picks_activity_by_mode(
    mode: str, expected: str,
) -> None:
    """The background full-email backfill runs the activity matching
    gmail_mode.

    init_stage='brief' resumes past awaiting_verification so the workflow
    runs through to the background backfill; stream_id is set so the
    backfill block executes.
    """
    stubs, state = _make_stubs(init_stage="brief")
    await _run(
        stubs,
        OnboardingInput(user_id="u1", stream_id="stream-1", gmail_mode=mode),
    )
    # Metadata stage not re-run on a brief-stage resume.
    assert state["email_calls"] == []
    assert state["backfill_calls"] == [expected]
