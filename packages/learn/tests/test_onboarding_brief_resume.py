"""Tests for the onboarding brief-stage resume fix (issues #74 + #75).

#74 — the brief stage runs as a *separate* OnboardingPipelineWorkflow,
started by ctrl-api's POST /api/v1/onboarding/corrections after the user
verifies their facts. That workflow MUST resume at the "brief" stage,
past the awaiting_verification hard-return. It used to re-derive its
resume point from onboard.json (facts-presence) and could not express
"resume past awaiting_verification" — so it restarted from metadata and
the brief stage was structurally unreachable. The fix carries an
explicit ``resume_stage`` on OnboardingInput which the workflow trusts.

#75 — the First Brief was written as ``type: event``, a non-canonical
vault type the promotion contract rejects with a 422. It must be written
as ``type: briefing`` (a canonical type).

Replay-safety: ``resume_stage`` is a new dataclass field with a default;
historical OnboardingInput payloads deserialize with resume_stage="" and
take the unchanged legacy path. The workflow branches only on this
deterministic input field — no env, no time, no randomness — so a replay
always takes the same path as the original execution.
"""
from __future__ import annotations

import asyncio
import json
import sys
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from temporalio import activity
from temporalio.client import Client
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment, WorkflowEnvironment
from temporalio.worker import Worker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.onboarding import init_onboard_json  # noqa: E402
from src.workflows.onboarding_pipeline import (  # noqa: E402
    STAGE_ORDER,
    OnboardingInput,
    OnboardingPipelineWorkflow,
    _stage_index,
)


# ===========================================================================
# #74 — _stage_index no longer swallows unknown stages
# ===========================================================================


def test_stage_index_resolves_known_stages() -> None:
    """Every STAGE_ORDER member resolves to its list index."""
    for i, stage in enumerate(STAGE_ORDER):
        assert _stage_index(stage) == i


def test_stage_index_raises_on_unknown_stage() -> None:
    """An unknown stage RAISES instead of silently collapsing to index 0.

    The legacy behaviour returned 0 for a bad stage (e.g. "backfill",
    which is NOT in STAGE_ORDER) — that silently restarted the whole
    pipeline from metadata. A loud ValueError makes a corrupt stage a
    debuggable failure.
    """
    with pytest.raises(ValueError, match="Unknown onboarding stage"):
        _stage_index("backfill")
    with pytest.raises(ValueError, match="not in STAGE_ORDER"):
        _stage_index("totally-bogus")


# ===========================================================================
# #74 — OnboardingInput.resume_stage field
# ===========================================================================


def test_onboarding_input_has_resume_stage_defaulting_to_empty() -> None:
    """resume_stage exists and defaults to "" — a pre-#74 OnboardingInput
    payload deserializes with resume_stage="" and takes the unchanged
    legacy path (Temporal replay-safety).
    """
    inp = OnboardingInput(user_id="u1")
    assert inp.resume_stage == ""
    # Explicitly settable for the brief-stage resume path.
    assert (
        OnboardingInput(user_id="u1", resume_stage="brief").resume_stage
        == "brief"
    )


def test_workflow_body_never_reads_env() -> None:
    """The resume-logic change must stay env-free — the resume point comes
    only from OnboardingInput / onboard.json, never from os.environ, or
    Temporal replay determinism breaks.
    """
    src = (ROOT / "src" / "workflows" / "onboarding_pipeline.py").read_text()
    assert "os.environ" not in src
    assert "import os" not in src


# ===========================================================================
# #74 — end-to-end: resume_stage="brief" resumes at the brief stage
# ===========================================================================


def _make_stubs(
    init_stage: str,
) -> tuple[list, dict[str, Any]]:
    """No-op stubs for every onboarding activity. Each records its name in
    ``state["ran"]`` so a test can assert which stages executed.

    ``init_onboard_json`` returns a state whose ``stage`` field is
    ``init_stage`` — this is what onboard.json persists. The point of #74
    is that an explicit resume_stage on the input OVERRIDES this.
    """
    state: dict[str, Any] = {"ran": []}

    def _rec(name: str):
        @activity.defn(name=name)
        async def _stub(*args: Any, **kwargs: Any) -> dict[str, Any]:
            state["ran"].append(name)
            return {}

        return _stub

    @activity.defn(name="init_onboard_json")
    async def stub_init(onboard_path: str, user_id: str) -> dict[str, Any]:
        state["ran"].append("init_onboard_json")
        return {
            "user_id": user_id,
            "stage": init_stage,
            "facts": [],
            "patterns": [],
            "progress": {"current_day": 0, "total_days": 0},
        }

    @activity.defn(name="update_onboard_stage")
    async def stub_stage(onboard_path: str, stage: str) -> None:
        state["ran"].append(f"stage:{stage}")
        return None

    @activity.defn(name="persist_onboarding_mode")
    async def stub_persist(
        onboard_path: str, stream_id: str, gmail_mode: str, composio_action: str,
    ) -> None:
        return None

    @activity.defn(name="assign_initial_chores")
    async def stub_chores(onboard_path: str, user_id: str) -> dict[str, Any]:
        state["ran"].append("assign_initial_chores")
        return {"generated": 0}

    stubs = [
        stub_init,
        stub_stage,
        stub_persist,
        stub_chores,
        _rec("fetch_email_metadata"),
        _rec("composio_fetch_email_metadata"),
        _rec("run_behavioral_profiler"),
        _rec("extract_facts_opus"),
        _rec("discover_patterns_opus"),
        _rec("personalize_opus"),
        _rec("write_brief_and_opportunities_opus"),
        _rec("generate_matter_pack_opus"),
        _rec("generate_instinct_pack_opus"),
        _rec("generate_errand_pack_opus"),
        _rec("generate_stream_pack"),
        _rec("restart_learn_worker"),
        _rec("send_first_brief_email"),
        _rec("backfill_gmail_as_events"),
        _rec("composio_backfill_gmail_as_events"),
        _rec("process_stream_batch"),
    ]
    return stubs, state


async def _run(stubs: list, inp: OnboardingInput) -> Any:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"onboarding-brief-test-{uuid.uuid4()}"
        worker = Worker(
            client,
            task_queue=tq,
            workflows=[OnboardingPipelineWorkflow],
            activities=stubs,
        )
        async with worker:
            return await client.execute_workflow(
                OnboardingPipelineWorkflow.run,
                inp,
                id=f"onboarding-brief-run-{uuid.uuid4()}",
                task_queue=tq,
            )


async def test_resume_stage_brief_runs_the_brief_stage() -> None:
    """resume_stage="brief" resumes AT the brief stage — the brief activity
    runs, the metadata/facts/patterns stages do NOT re-run, and the
    workflow does NOT stop at awaiting_verification.

    onboard.json reports stage="awaiting_verification" (where the prior
    workflow stopped). Without the #74 fix the resume point would be
    re-derived and the workflow would restart from metadata; with the fix
    the explicit resume_stage="brief" wins.
    """
    stubs, state = _make_stubs(init_stage="awaiting_verification")
    result = await _run(
        stubs,
        OnboardingInput(user_id="u1", resume_stage="brief"),
    )
    ran = state["ran"]
    # The brief activity ran.
    assert "write_brief_and_opportunities_opus" in ran
    # The earlier stages did NOT re-run.
    assert "fetch_email_metadata" not in ran
    assert "extract_facts_opus" not in ran
    assert "discover_patterns_opus" not in ran
    assert "personalize_opus" not in ran
    # The workflow did NOT return early at awaiting_verification — it ran
    # past it into packs/chores/done.
    assert "assign_initial_chores" in ran
    assert "stage:done" in ran
    # The result carries the canonical briefing path (#75), not event/.
    assert result.brief_path == "briefing/First Brief.md"


async def test_no_resume_stage_falls_back_to_onboard_json_stage() -> None:
    """With no resume_stage (a pre-#74 / initial-start input), the workflow
    resumes from onboard.json's persisted stage — unchanged legacy path.

    onboard.json says "awaiting_verification" → the workflow stops there
    (hard return), exactly as before #74.
    """
    stubs, state = _make_stubs(init_stage="awaiting_verification")
    result = await _run(stubs, OnboardingInput(user_id="u1"))
    ran = state["ran"]
    # Stopped at awaiting_verification — brief stage NOT reached.
    assert "stage:awaiting_verification" in ran
    assert "write_brief_and_opportunities_opus" not in ran
    assert "assign_initial_chores" not in ran
    assert result.brief_path == ""


async def test_legacy_backfill_stage_in_onboard_json_does_not_raise() -> None:
    """A persisted (non-resume_stage) stage that is NOT a STAGE_ORDER
    member — the legacy "backfill" value — falls back to "metadata"
    instead of raising. The pipeline runs from the start cleanly.
    """
    stubs, state = _make_stubs(init_stage="backfill")
    await _run(stubs, OnboardingInput(user_id="u1"))
    ran = state["ran"]
    # Fell back to metadata — the first real stage ran.
    assert "fetch_email_metadata" in ran
    assert "stage:metadata" in ran


async def test_bad_explicit_resume_stage_fails_workflow() -> None:
    """An explicit resume_stage that is not a STAGE_ORDER member is a
    caller bug and must FAIL the workflow loudly — unlike a corrupt
    onboard.json stage, which falls back to metadata.

    The workflow raises a non-retryable ApplicationError; Temporal
    surfaces it as a WorkflowFailureError. A plain (retryable) exception
    would be a workflow-task failure that retries forever and hangs
    onboarding — the non_retryable flag is what makes this terminal.
    """
    from temporalio.client import WorkflowFailureError

    stubs, _ = _make_stubs(init_stage="metadata")
    with pytest.raises(WorkflowFailureError) as exc_info:
        await _run(stubs, OnboardingInput(user_id="u1", resume_stage="bogus"))
    # The cause is the non-retryable ApplicationError we raised.
    cause = exc_info.value.cause
    assert isinstance(cause, ApplicationError)
    assert cause.non_retryable is True
    assert "not a STAGE_ORDER member" in str(cause)


# ===========================================================================
# #74 — init_onboard_json fresh default is a real STAGE_ORDER member
# ===========================================================================


def test_init_onboard_json_fresh_default_is_metadata(tmp_path: Path) -> None:
    """A fresh onboard.json gets stage="metadata" (a STAGE_ORDER member),
    NOT the legacy "backfill" which is not in STAGE_ORDER.
    """
    onboard_path = str(tmp_path / "onboard.json")
    env = ActivityEnvironment()

    @activity.defn(name="_test_init")
    async def _wrapper() -> dict[str, Any]:
        return await init_onboard_json(onboard_path, "u1")

    result = asyncio.run(env.run(_wrapper))
    assert result["stage"] == "metadata"
    assert result["stage"] in STAGE_ORDER
    # The file on disk also has the corrected default.
    on_disk = json.loads(Path(onboard_path).read_text())
    assert on_disk["stage"] == "metadata"


# ===========================================================================
# #75 — the First Brief is written as type: briefing (canonical)
# ===========================================================================


def _make_brief_onboard(tmp_path: Path) -> str:
    path = tmp_path / "onboard.json"
    path.write_text(
        json.dumps(
            {
                "facts": [
                    {
                        "category": "professional",
                        "fact": "Runs Example LLC",
                        "confidence": "high",
                    }
                ],
                "patterns": [
                    {"name": "p1", "description": "reviews stats on Tuesdays"}
                ],
                "user_md": "# User\n\nDavid.",
                "soul_md": "# Soul\n\nAddress as Sir.",
            }
        )
    )
    return str(path)


def _capturing_client(captured: list[dict[str, Any]]):
    """An httpx.AsyncClient stand-in that records every POST body."""
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None

    async def _post(url: str, **kwargs: Any):
        captured.append({"url": url, "json": kwargs.get("json")})
        return type(
            "R", (), {"status_code": 201, "text": "", "is_success": True}
        )()

    client.post = AsyncMock(side_effect=_post)
    return client


def _run_activity(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_test_wrapper")
    async def _wrapper() -> Any:
        return await coro_factory()

    return asyncio.run(env.run(_wrapper))


def test_write_brief_opus_writes_type_briefing(tmp_path, monkeypatch) -> None:
    """write_brief_opus writes the First Brief as a `briefing` record —
    a canonical vault type. `event` would be rejected by the promotion
    contract with a 422 (#75).
    """
    from src.activities.onboarding_v3 import write_brief_opus

    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _make_brief_onboard(tmp_path)
    captured: list[dict[str, Any]] = []

    with patch(
        "src.activities.onboarding_v3._call_llm",
        new=AsyncMock(return_value="Sir, welcome. At your disposal."),
    ), patch("httpx.AsyncClient", return_value=_capturing_client(captured)):
        _run_activity(lambda: write_brief_opus(onboard))

    record_posts = [
        c for c in captured if c["url"] == "/api/v1/vault/records"
    ]
    assert len(record_posts) == 1
    body = record_posts[0]["json"]
    assert body["type"] == "briefing"
    assert body["name"] == "First Brief"
    # The frontmatter inside `content` must agree with the `type` field.
    assert "type: briefing" in body["content"]
    assert "type: event" not in body["content"]


def test_write_brief_and_opportunities_opus_writes_type_briefing(
    tmp_path, monkeypatch
) -> None:
    """write_brief_and_opportunities_opus writes the First Brief as a
    `briefing` record too — the other legacy fix point for #75.
    """
    from src.activities.onboarding_v3 import (
        write_brief_and_opportunities_opus,
    )

    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _make_brief_onboard(tmp_path)
    captured: list[dict[str, Any]] = []

    # A well-formed brief+opportunities JSON so the activity does not fall
    # back to write_brief_opus — we want to exercise THIS function's own
    # vault write. At least one opportunity must pass ChoreOpportunity
    # validation or the activity falls back.
    good_response = json.dumps(
        {
            "brief": "Sir, welcome. At your disposal.",
            "opportunities": [
                {
                    "id": "track-stripe-stats",
                    "name": "Track Stripe stats",
                    "description": "Pull a weekly Stripe revenue digest.",
                    "goal": "Keep Sir informed of revenue trends.",
                    "trigger": {"kind": "cron", "hint": "weekly on Tuesday"},
                    "data_sources": ["stripe"],
                    "frequency_hint": "weekly",
                    "notify_when": "always",
                    "tags": ["finance"],
                }
            ],
        }
    )

    with patch(
        "src.activities.onboarding_v3._call_llm",
        new=AsyncMock(return_value=good_response),
    ), patch("httpx.AsyncClient", return_value=_capturing_client(captured)):
        result = _run_activity(
            lambda: write_brief_and_opportunities_opus(onboard)
        )

    # Did not fall back to write_brief_opus.
    assert result.get("fallback") is False
    record_posts = [
        c for c in captured if c["url"] == "/api/v1/vault/records"
    ]
    assert len(record_posts) == 1
    body = record_posts[0]["json"]
    assert body["type"] == "briefing"
    assert body["name"] == "First Brief"
    assert "type: briefing" in body["content"]
    assert "type: event" not in body["content"]
