"""Workflow: Onboarding Pipeline v3 — 4 Opus calls, 5-minute intelligence.

Replaces the 101-sequential-Clerk-call pipeline with 4 direct Opus 4.6
calls. Full email corpus as context. User sees First Brief ~15 min after
signup. Vault builds in background via curator.

Stages:
1. Fetch email metadata + snippets (30-60s)
2. Extract facts (1 Opus call)
3. Discover patterns (1 Opus call)
4. Personalize: USER.md + SOUL.md + MEMORY.md + TOOLS.md (1 Opus call)
5. First Brief — high-EQ butler welcome letter (1 Opus call)
6. Mark done → show brief
7. Background: full email backfill → batch to inbox → curator builds vault
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError

with workflow.unsafe.imports_passed_through():
    from src.activities.onboarding import (
        init_onboard_json,
        persist_onboarding_mode,
        record_stage_degrade,
        update_onboard_stage,
        update_onboard_progress,
    )
    from src.activities.onboarding_v3 import (
        fetch_email_metadata,
        extract_facts_opus,
        discover_patterns_opus,
        personalize_opus,
        write_brief_opus,
        write_brief_and_opportunities_opus,
    )
    from src.activities.pull import (
        backfill_gmail_as_events,
        composio_backfill_gmail_as_events,
        composio_fetch_email_metadata,
    )
    from src.activities.batch_processor import process_stream_batch
    from src.activities.profiler import run_behavioral_profiler
    from src.activities.packs import (
        generate_stream_pack,
        generate_matter_pack,
        generate_instinct_pack,
        generate_errand_pack,
    )
    from src.activities.packs_opus import (
        generate_errand_pack_opus,
        generate_instinct_pack_opus,
        generate_matter_pack_opus,
        materialize_matter_entities,
    )
    from src.activities.assign_chores import assign_initial_chores
    from src.activities.chore_generation import restart_learn_worker
    from src.activities.desk_seed import seed_day_one_desk_cards
    from src.activities.first_brief_email import send_first_brief_email

ONBOARD_PATH = "/alfred-data/onboard.json"


# ``_record_stage_degrade`` is re-exported from activities.onboarding so
# unit tests can import it from this workflow module (it pairs naturally
# with ``_safe_stage_wrapper`` below). The workflow body itself calls the
# ACTIVITY ``record_stage_degrade`` through workflow.execute_activity —
# the sync helper is test-only.
with workflow.unsafe.imports_passed_through():
    from src.activities.onboarding import (
        _record_stage_degrade,  # noqa: F401 — re-exported for tests
    )

STAGE_ORDER = [
    "metadata",              # Stage 1: fetch email metadata + snippets
    "profiler",              # Stage 2: behavioral profiler (pure Python/ML, no LLM)
    "facts",                 # Stage 3: extract facts (Opus) — enhanced with profiler data
    "patterns",              # Stage 4: discover patterns (Opus) — enhanced with profiler data
    "personalize",           # Stage 5: USER.md + SOUL.md + MEMORY.md + TOOLS.md (Opus)
    "awaiting_verification", # Stage 5.5: wait for user to verify key facts
    "brief",                 # Stage 6: First Brief (Opus) — with corrections
    "packs",                 # Stage 7: generate four packs from profiler data
    "chores",                # Stage 7.5: assign initial chores (templates + schedules)
    "done",                  # Stage 8: complete — show brief, start background vault build
]


def _stage_index(stage: str) -> int:
    """Resolve a stage name to its index in STAGE_ORDER.

    Raises ValueError on an unknown stage instead of silently collapsing it
    to 0. A bad stage name (e.g. the legacy ``"backfill"`` default, which is
    NOT in STAGE_ORDER) used to swallow the error and restart the whole
    pipeline from ``metadata`` — losing every completed stage. Surfacing the
    error makes a bad stage a loud, debuggable failure instead of a silent
    full restart.
    """
    try:
        return STAGE_ORDER.index(stage)
    except ValueError:
        raise ValueError(
            f"Unknown onboarding stage {stage!r} — not in STAGE_ORDER "
            f"({', '.join(STAGE_ORDER)}). onboard.json is corrupt or a "
            f"caller passed a bad resume_stage."
        )


@dataclass
class OnboardingInput:
    user_id: str
    stream_id: str = ""
    # Gmail backfill mode — decided ONCE at workflow start by the caller
    # (the SaaS, from server-side env) and carried in the workflow input.
    # The email stages branch on this field; they MUST NOT read env inside
    # the workflow body, or a replay on a host with different env would
    # diverge from history (Temporal non-determinism).
    #
    #   "google"   — legacy direct-Gmail path: a `google` OAuthCredential in
    #                the SaaS DB, fetched via /api/internal/oauth2/token.
    #   "composio" — Composio managed OAuth: GMAIL_FETCH_EMAILS via the
    #                composio_pull machinery, no Google token needed.
    #
    # Defaults to "google" so onboardings started before P2 stamps the
    # field (older `OnboardingInput` payloads) keep the existing behaviour
    # unchanged. New Composio onboardings must set gmail_mode="composio".
    #
    # P2-RECONCILED: the web/ctrl-api side (P2, ctrl-api
    # routes/workflows.ts `onboarding/start`) already stamps this exact
    # field name `gmail_mode` ("composio" | "google") into the
    # workflow-start `--input`. Names match — no reconciliation needed.
    gmail_mode: str = "google"
    # The exact Composio fetch action for the email stages — P2 sends
    # "GMAIL_FETCH_EMAILS" alongside gmail_mode="composio". Carried for
    # forward-compat / so the brief-stage resume path can re-stamp it;
    # the P3 email activities hard-target GMAIL_FETCH_EMAILS regardless.
    composio_action: str = ""
    # Explicit resume stage — carried in the workflow input so a restart
    # can resume DETERMINISTICALLY at a named stage instead of re-deriving
    # it from onboard.json's facts-presence (#74).
    #
    # The brief stage runs as a *separate* OnboardingPipelineWorkflow,
    # started by ctrl-api's POST /api/v1/onboarding/corrections after the
    # user verifies their facts. That workflow MUST resume at "brief" —
    # past the awaiting_verification hard-return. Re-deriving the stage
    # from onboard.json could not express "skip past awaiting_verification"
    # and silently restarted from metadata, making the brief stage
    # structurally unreachable.
    #
    # When set to a STAGE_ORDER member, the workflow trusts THIS value as
    # the resume point and ignores onboard.json's persisted stage. When
    # empty (the default — every pre-#74 caller and the initial
    # onboarding/start), the workflow falls back to the onboard.json stage,
    # exactly as before. A new dataclass field with a default is
    # Temporal-replay-safe: historical OnboardingInput payloads that lack
    # the field deserialize with resume_stage="" and take the unchanged
    # legacy path.
    resume_stage: str = ""


def _state_count(state: dict[str, Any], kind: str) -> int:
    """Read a facts/patterns count from an ``init_onboard_json`` result.

    ``init_onboard_json`` now returns a SMALL summary carrying explicit
    ``facts_count`` / ``patterns_count`` ints (issue #76 — the full
    onboard dict, with its ~5000-email corpus, must not travel through
    Temporal's 4 MB activity-completion payload).

    This helper is replay-safe: a workflow that recorded the activity
    result in history under the OLD shape — the full onboard dict with a
    ``facts`` / ``patterns`` LIST — replays that historical result, so we
    fall back to ``len(list)`` when the explicit count key is absent.
    Both shapes resolve to the same int, so history stays deterministic.

    ``kind`` is ``"facts"`` or ``"patterns"``.
    """
    count_key = f"{kind}_count"
    if count_key in state:
        value = state.get(count_key)
        return value if isinstance(value, int) else 0
    legacy = state.get(kind)
    return len(legacy) if isinstance(legacy, list) else 0


@dataclass
class OnboardingResult:
    brief_path: str = ""
    facts_count: int = 0
    patterns_count: int = 0
    error: str | None = None
    # #B3: durable, queryable record of whether the First Brief email was
    # actually delivered. ``None`` = delivery not attempted on this run
    # (e.g. a non-finale resume) or a pre-#B3 payload; ``True``/``False``
    # = the send_first_brief_email outcome. A False here is a never-
    # delivered brief — visible instead of swallowed in a warning.
    brief_email_delivered: bool | None = None
    brief_email_reason: str = ""


async def _safe_stage_wrapper(
    stage_name: str,
    activity_callable: Any,
    args: list[Any],
    onboard_path: str,
    *,
    start_to_close_timeout: timedelta,
    heartbeat_timeout: timedelta | None = None,
    schedule_to_start_timeout: timedelta | None = None,
    retry_policy: RetryPolicy | None = None,
) -> dict[str, Any]:
    """Run an activity stage; downgrade unhandled exceptions to a degrade.

    Phase 4 / Lane II Commit 2 — every onboarding stage MUST reach
    ``stage=done`` even when an activity exhausts its retry budget. This
    wrapper takes the same parameters as ``workflow.execute_activity`` and:

      * dispatches the activity through Temporal's normal retry machinery,
      * on success returns the activity result (or ``{}`` for ``None``),
      * on failure (post-retries) logs a workflow-level warning, calls the
        ``record_stage_degrade`` activity to stamp
        ``onboard.json["degraded_stages"]``, and returns a sentinel
        ``{"degraded": True, "stage": ..., "reason": ..., "error": ...}``.

    Downstream stages tolerate the gap: ``personalize_opus`` /
    ``write_brief_*`` / ``generate_*_pack_opus`` already key off
    ``onboard.get("facts") or []`` and bail out cleanly when upstream
    produced nothing. Today, by contrast, a stage failure → workflow
    failure → ``stage`` never gets stamped ``done`` → UI hangs.

    Credit-aware activities (extract_facts_opus / discover_patterns_opus /
    ...) already handle 402 INTERNALLY via Commit 1, so the wrapper here
    catches the rarer residual class: hard failures, transients that
    outlast the retry budget, schedule-to-start timeouts, etc.
    """
    kwargs: dict[str, Any] = {"start_to_close_timeout": start_to_close_timeout}
    if heartbeat_timeout is not None:
        kwargs["heartbeat_timeout"] = heartbeat_timeout
    if schedule_to_start_timeout is not None:
        kwargs["schedule_to_start_timeout"] = schedule_to_start_timeout
    if retry_policy is not None:
        kwargs["retry_policy"] = retry_policy
    try:
        result = await workflow.execute_activity(
            activity_callable, args=args, **kwargs,
        )
    except Exception as exc:  # noqa: BLE001 — degrade-and-continue
        reason = f"{type(exc).__name__}: {exc}"
        workflow.logger.warning(
            "onboarding_pipeline: stage=%s activity exhausted retries — "
            "marking degraded and continuing: %s", stage_name, reason,
        )
        try:
            await workflow.execute_activity(
                record_stage_degrade,
                args=[onboard_path, stage_name, reason],
                start_to_close_timeout=timedelta(seconds=10),
            )
        except Exception as record_exc:  # noqa: BLE001 — bookkeeping last
            workflow.logger.warning(
                "onboarding_pipeline: record_stage_degrade(%s) also failed: %s",
                stage_name, record_exc,
            )
        return {
            "degraded": True, "stage": stage_name,
            "reason": "stage_failure", "error": reason[:300],
        }
    if result is None:
        return {}
    if isinstance(result, dict):
        return result
    return {"result": result}


@workflow.defn(name="OnboardingPipelineWorkflow")
class OnboardingPipelineWorkflow:
    @workflow.run
    async def run(self, input: OnboardingInput) -> OnboardingResult:
        onboard_path = ONBOARD_PATH

        # Init onboard.json (preserves existing data for resume)
        current_state: dict[str, Any] = await workflow.execute_activity(
            init_onboard_json,
            args=[onboard_path, input.user_id],
            start_to_close_timeout=timedelta(seconds=10),
        )

        # Resolve the resume point. When the caller supplied an explicit
        # resume_stage (a STAGE_ORDER member), TRUST it — this is how the
        # brief-stage workflow (#74) resumes past the awaiting_verification
        # hard-return. Otherwise fall back to onboard.json's persisted
        # stage. A persisted stage that is NOT a STAGE_ORDER member (the
        # legacy "backfill" default) falls back to "metadata" so a fresh /
        # corrupt onboard.json starts from the real first stage instead of
        # raising. An explicit resume_stage, by contrast, MUST be valid —
        # a bad one is a caller bug and should raise loudly.
        if input.resume_stage:
            if input.resume_stage not in STAGE_ORDER:
                # A bad explicit resume_stage is a caller bug. Raise a
                # NON-retryable ApplicationError so the workflow FAILS
                # loudly and immediately — a plain exception in the
                # workflow body is a workflow-task failure that Temporal
                # retries forever, which would hang onboarding silently.
                raise ApplicationError(
                    f"OnboardingInput.resume_stage={input.resume_stage!r} "
                    f"is not a STAGE_ORDER member "
                    f"({', '.join(STAGE_ORDER)}).",
                    type="InvalidResumeStage",
                    non_retryable=True,
                )
            current_stage = input.resume_stage
        else:
            persisted_stage = current_state.get("stage", "metadata")
            current_stage = (
                persisted_stage if persisted_stage in STAGE_ORDER else "metadata"
            )
        resume_idx = _stage_index(current_stage)

        # Gmail backfill mode — read ONCE from the workflow input. Replay-safe:
        # this is a deterministic field on the input, never an env read. Every
        # email-stage branch below keys off this local, so a resume (which
        # carries the same OnboardingInput) always takes the same path.
        use_composio_gmail = input.gmail_mode == "composio"

        # Persist the Gmail-mode contract into onboard.json so the
        # brief-stage resume path (ctrl-api /onboarding/corrections, #69)
        # can rebuild this same OnboardingInput and stay on the same path.
        # Idempotent — a resume just re-writes the same values.
        await workflow.execute_activity(
            persist_onboarding_mode,
            args=[
                onboard_path,
                input.stream_id,
                input.gmail_mode,
                input.composio_action,
            ],
            start_to_close_timeout=timedelta(seconds=10),
        )

        # If already done, skip everything
        if current_stage == "done":
            return OnboardingResult(
                brief_path="briefing/First Brief.md",
                facts_count=_state_count(current_state, "facts"),
                patterns_count=_state_count(current_state, "patterns"),
            )

        # -----------------------------------------------------------------
        # Stage 1: Fetch email metadata + snippets
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("metadata"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "metadata"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            # Activity writes emails directly to onboard.json (too large for
            # Temporal activity result — 5000 emails exceeds 4MB gRPC limit).
            # Composio path: GMAIL_FETCH_EMAILS via managed OAuth (no Google
            # token). Google path: the legacy direct-Gmail fetch. Both write
            # the SAME onboard.json `emails` shape so every downstream stage
            # (profiler, Opus) is mode-agnostic.
            #
            # Phase 4: wrapped — a complete metadata failure (e.g. Composio
            # auth wedge) is downgraded to a degrade so the pipeline still
            # reaches `done`. Downstream stages will see an empty
            # ``emails`` list and bail out cleanly.
            email_metadata_activity = (
                composio_fetch_email_metadata
                if use_composio_gmail
                else fetch_email_metadata
            )
            await _safe_stage_wrapper(
                "metadata", email_metadata_activity,
                [input.user_id], onboard_path,
                start_to_close_timeout=timedelta(minutes=30),
                # Bumped from 60s → 300s for #74: a single Composio
                # GMAIL_FETCH_EMAILS page can take 10-30s, and a
                # quota-backoff sleep (heartbeated every 10s) can
                # legitimately delay the next response by 60-90s.
                # 300s leaves comfortable slack so a legitimately
                # slow Composio call doesn't trip the timeout.
                heartbeat_timeout=timedelta(seconds=300),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

        # -----------------------------------------------------------------
        # Stage 2: Behavioral profiler (pure Python/ML, no LLM)
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("profiler"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "profiler"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            await _safe_stage_wrapper(
                "profiler", run_behavioral_profiler,
                [onboard_path], onboard_path,
                start_to_close_timeout=timedelta(minutes=10),
                heartbeat_timeout=timedelta(seconds=120),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

        # -----------------------------------------------------------------
        # Stage 3: Extract facts (1 Opus call) — enhanced with profiler data
        # -----------------------------------------------------------------
        # Phase 4: wrapped in _safe_stage_wrapper. A 402 is degraded INSIDE
        # the activity (Commit 1) and never raises out of execute_activity.
        # The wrapper catches the rarer residual class — hard failures /
        # transients that outlast the retry budget — and marks the stage
        # degraded so the workflow advances. Downstream stages tolerate
        # missing facts (they check ``onboard.get("facts") or []``).
        if resume_idx <= _stage_index("facts"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "facts"],
                start_to_close_timeout=timedelta(seconds=10),
            )
            await _safe_stage_wrapper(
                "facts", extract_facts_opus, [onboard_path], onboard_path,
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=60),
                schedule_to_start_timeout=timedelta(minutes=15),
                retry_policy=RetryPolicy(maximum_attempts=4),
            )

        # -----------------------------------------------------------------
        # Stage 3: Discover patterns (1 Opus call)
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("patterns"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "patterns"],
                start_to_close_timeout=timedelta(seconds=10),
            )
            await _safe_stage_wrapper(
                "patterns", discover_patterns_opus, [onboard_path], onboard_path,
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=4),
            )

        # -----------------------------------------------------------------
        # Stage 4: Personalize (1 Opus call)
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("personalize"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "personalize"],
                start_to_close_timeout=timedelta(seconds=10),
            )
            await _safe_stage_wrapper(
                "personalize", personalize_opus, [onboard_path], onboard_path,
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=4),
            )

        # -----------------------------------------------------------------
        # Stage 4.5: Wait for user verification of key identity facts
        # The workflow RETURNS here. A separate trigger (from the SaaS
        # submitFactCorrections operation) restarts the workflow to
        # continue from the "brief" stage.
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("awaiting_verification"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "awaiting_verification"],
                start_to_close_timeout=timedelta(seconds=10),
            )
            # Return — dashboard shows the fact verification card.
            # When the user confirms, the workflow is re-triggered
            # and resumes from "brief" stage.
            return OnboardingResult(
                brief_path="",
                facts_count=_state_count(current_state, "facts"),
                patterns_count=_state_count(current_state, "patterns"),
            )

        # -----------------------------------------------------------------
        # Stage 5: First Brief (1 Opus call) — with user corrections
        # -----------------------------------------------------------------
        brief_path = ""
        if resume_idx <= _stage_index("brief"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "brief"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            # Stage 6 now uses write_brief_and_opportunities_opus which
            # generates the welcome brief AND a structured chore-opportunity
            # list in one Opus call (see PR S2-1). The old write_brief_opus
            # is kept as the activity's internal fallback for when the
            # structured-output parse fails across all retries.
            #
            # Phase 4: wrapped — 402 is handled inside the activity (Commit
            # 1); the wrapper catches the residual failure class so the
            # workflow still reaches `done` even when both Opus paths fail.
            await _safe_stage_wrapper(
                "brief", write_brief_and_opportunities_opus,
                [onboard_path], onboard_path,
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=4),
            )
            # The First Brief is a `briefing` record — a canonical vault
            # type. `event` is demoted by the promotion contract and
            # ctrl-api rejects an `event` vault write with a 422 (#75).
            brief_path = "briefing/First Brief.md"

        # -----------------------------------------------------------------
        # Stage 7: Generate four packs from profiler data
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("packs"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "packs"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            # Run pack generators sequentially. Each is wrapped so a
            # complete failure (after the activity's own rule-based
            # fallback also failed) is downgraded to a stage degrade
            # instead of failing the whole workflow.
            await _safe_stage_wrapper(
                "packs.matter", generate_matter_pack_opus,
                [onboard_path], onboard_path,
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=90),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            await _safe_stage_wrapper(
                "packs.instinct", generate_instinct_pack_opus,
                [onboard_path], onboard_path,
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=90),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            await _safe_stage_wrapper(
                "packs.errand", generate_errand_pack_opus,
                [onboard_path], onboard_path,
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=90),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            await _safe_stage_wrapper(
                "packs.stream", generate_stream_pack,
                [onboard_path], onboard_path,
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            # F36 — deterministic post-pack stage: materialise person/org
            # stub records + backlinks for the matter-named entities the
            # matter pack just wikilinked (F37), so matter↔entity graph
            # edges resolve. Rich entity bodies are left to the LLM curator
            # (Wave-5). Best-effort; never blocks onboarding.
            try:
                await workflow.execute_activity(
                    materialize_matter_entities,
                    args=[onboard_path],
                    start_to_close_timeout=timedelta(minutes=5),
                    heartbeat_timeout=timedelta(seconds=60),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as exc:  # noqa: BLE001
                workflow.logger.warning(
                    "onboarding_pipeline: materialize_matter_entities failed: %s", exc
                )

        # -----------------------------------------------------------------
        # Stage 7.5: Assign initial chores from profile
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("chores"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "chores"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            # Assign initial chores runs the full chain:
            #  - Opus template matching (Step 3)
            #  - S4-8 generation chain for unmatched opportunities
            #    (generate → validate → smoke → deploy, up to 3 templates)
            # Timeout extended to 20 minutes because each generation attempt
            # can make up to 3 Opus calls (_call_llm total timeout 600s per
            # call) and we can generate up to 3 templates in one run.
            #
            # Phase 4: wrapped so a complete chores-stage failure is
            # downgraded to a degrade instead of failing the workflow.
            chore_result = await _safe_stage_wrapper(
                "chores", assign_initial_chores,
                [onboard_path, input.user_id], onboard_path,
                start_to_close_timeout=timedelta(minutes=20),
                heartbeat_timeout=timedelta(seconds=90),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            # Stash the chore_result for the post-done worker-restart
            # bookkeeping below — we want to mark onboarding DONE and
            # email the brief BEFORE the activity that kills its own
            # worker, so a restart-activity failure cannot fail the
            # whole workflow and leave the user stuck at "chores" with
            # the brief sitting unread on disk.
            templates_generated = (
                isinstance(chore_result, dict)
                and chore_result.get("generated", 0) > 0
                and not chore_result.get("degraded")
            )

            # C-OB3 — day-one Desk seed. The Desk currently lands empty
            # on day one; this activity reads the 2-3 most time-critical
            # matters (those whose body carries a real date phrase) and
            # writes a ``needs_attention`` card for each. Idempotent
            # (records ``onboard["day_one_desk_seeded"]``) so a resume or
            # retry doesn't double-seed. Best-effort: a failure here
            # doesn't fail the whole pipeline — Sir still gets the brief
            # and chores; the Desk just lands empty as before.
            try:
                await workflow.execute_activity(
                    seed_day_one_desk_cards,
                    args=[onboard_path],
                    start_to_close_timeout=timedelta(minutes=2),
                    heartbeat_timeout=timedelta(seconds=60),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as exc:  # noqa: BLE001 — advisory
                workflow.logger.warning(
                    "onboarding_pipeline: seed_day_one_desk_cards "
                    "failed: %s", exc,
                )
        else:
            templates_generated = False

        # -----------------------------------------------------------------
        # Mark done BEFORE background processing
        # -----------------------------------------------------------------
        await workflow.execute_activity(
            update_onboard_stage,
            args=[onboard_path, "done"],
            start_to_close_timeout=timedelta(seconds=10),
        )

        # -----------------------------------------------------------------
        # Send the First Brief via email as the user-visible finale of
        # onboarding. Non-blocking: failures here (AgentMail disabled,
        # network hiccup) just log and continue — Sir can still read the
        # brief on the dashboard, and this is recoverable via a manual
        # resend later. No retries: if AgentMail isn't configured, further
        # attempts won't help.
        # -----------------------------------------------------------------
        # #B3: capture the delivery outcome so a never-delivered brief is
        # visible on OnboardingResult instead of being swallowed here. The
        # pipeline still does NOT crash on a delivery failure — Sir can read
        # the brief on the dashboard and resend later — but the result now
        # distinguishes delivered (True) from not-delivered (False).
        brief_email_delivered: bool = False
        brief_email_reason: str = "not attempted"
        try:
            email_outcome = await workflow.execute_activity(
                send_first_brief_email,
                args=[brief_path],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=1),
            )
            if isinstance(email_outcome, dict):
                brief_email_delivered = bool(email_outcome.get("sent"))
                brief_email_reason = str(email_outcome.get("reason", ""))
            if not brief_email_delivered:
                workflow.logger.warning(
                    "First Brief email NOT delivered: %s", brief_email_reason
                )
        except Exception as err:  # pragma: no cover — advisory
            brief_email_delivered = False
            brief_email_reason = f"activity error: {err}"
            workflow.logger.warning(
                "send_first_brief_email failed, continuing with background: %s",
                err,
            )

        # -----------------------------------------------------------------
        # Pick up newly generated chore templates by restarting the
        # alfred-learn worker. This activity KILLS its own worker
        # mid-flight: the ctrl-api restart endpoint stops the container
        # the activity is running in, so the HTTP response never returns
        # and Temporal sees a heartbeat timeout. Two reasons it can't
        # fail the workflow:
        #
        #   1) Done-stage + brief email have ALREADY completed above —
        #      the user-visible outcome is in place.
        #   2) The restart only loads new dynamic chore TEMPLATES; the
        #      brief, matter/instinct/errand packs, and the 6 default
        #      chores were already written by the activities that ran
        #      before this point.
        #
        # We wrap the call in try/except so any failure (heartbeat
        # timeout, retries exhausted) is downgraded to a warning. The
        # activity-side already handles the common ConnectError case by
        # returning ok=True; heartbeat_timeout is bumped to 180s (longer
        # than the observed ~150s killing window) so the FIRST attempt
        # has a real chance to land. Retries are capped at 1 — a second
        # attempt on the restarted worker just trips the 30-second
        # ctrl-api rate limiter or kills the worker again.
        # -----------------------------------------------------------------
        if templates_generated:
            workflow.logger.info(
                "Stage 7.5 generated chore templates — triggering worker restart"
            )
            try:
                await workflow.execute_activity(
                    restart_learn_worker,
                    start_to_close_timeout=timedelta(minutes=3),
                    heartbeat_timeout=timedelta(seconds=180),
                    retry_policy=RetryPolicy(maximum_attempts=1),
                )
            except Exception as err:  # pragma: no cover — advisory
                workflow.logger.warning(
                    "restart_learn_worker failed (templates load on next "
                    "scheduled restart): %s",
                    err,
                )

        # -----------------------------------------------------------------
        # Background: full email backfill → batch to inbox → curator
        # -----------------------------------------------------------------
        if input.stream_id:
            # Fetch full emails as stream events. Composio path uses the
            # GMAIL_FETCH_EMAILS paginated loop → composio parser → ingest;
            # Google path uses the legacy direct-Gmail full-message fetch.
            backfill_activity = (
                composio_backfill_gmail_as_events
                if use_composio_gmail
                else backfill_gmail_as_events
            )
            await workflow.execute_activity(
                backfill_activity,
                args=[input.stream_id, input.user_id, 100, 5000],
                start_to_close_timeout=timedelta(minutes=60),
                heartbeat_timeout=timedelta(seconds=120),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            # Batch process into inbox for curator
            await workflow.execute_activity(
                process_stream_batch,
                args=[input.stream_id, "gmail"],
                start_to_close_timeout=timedelta(minutes=30),
                heartbeat_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

        return OnboardingResult(
            brief_path=brief_path,
            facts_count=_state_count(current_state, "facts"),
            patterns_count=_state_count(current_state, "patterns"),
            brief_email_delivered=brief_email_delivered,
            brief_email_reason=brief_email_reason,
        )
