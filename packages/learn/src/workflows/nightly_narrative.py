"""Workflow 7: Nightly Narrative — model-written matter status paragraphs.

RFC #884 (Living matters & tasks) introduces a narrative layer that
turns each matter into a living document: every night the clerk
drafts a fresh ``current_state`` paragraph describing where the
matter stands today, given the signals routed to it and the task
transitions Steward applied in the last 24h. The paragraph slots into
the matter's frontmatter so the daily-digest composer can read it
directly instead of re-walking the same events.

Schedule: Temporal cron ``0 2 * * *`` (02:00 local, per tenant). One
schedule id ``al-nightly-narrative`` — singleton, fan-out happens
inside the workflow so we don't multiply Temporal history records per
matter.

Per matter the flow is:

  1. ``read_matter_summary`` — fetch the matter's current frontmatter
     (name, prior current_state).
  2. ``load_matter_signals_24h`` — state.db ``signal`` rows (storage
     cutover #27) filtered by matter target match within the lookback
     window. The ctrl-api matters route reads the same store (F9), so the
     composer and the matters timeline agree on one signal store.
  3. ``load_task_transitions_24h`` — task/*.md whose
     last_steward_outcome.evaluated_at is fresh.
  4. ``load_source_events`` — back-pointer expand signals -> events.
  5. ``generate_matter_narrative`` — single clerk call.
  6. ``patch_matter_narrative`` — atomic vault PATCH.

Idempotency: if signals AND transitions are both empty the workflow
short-circuits — no LLM call, no patch. The previous narrative stays
in place because re-drafting "nothing happened" would just stamp a
new as_of without changing anything meaningful.

Concurrency: matters process sequentially. The clerk is rate-limited
and a typical matter takes a few seconds; fanning out via
``execute_activity`` parallelism would tax the gateway for no
appreciable wall-clock win. We heartbeat every 5 matters so a slow
night doesn't trip Temporal's workflow-task timeout.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.nightly_narrative import (
        apply_matter_narrative_v2,
        generate_matter_narrative,
        list_active_matters,
        load_matter_signals_24h,
        load_source_events,
        load_task_transitions_24h,
        patch_matter_narrative,
        read_matter_summary,
    )


HEARTBEAT_EVERY = 5

# Patched-gate name for Phase C (#891) — must match across this file
# and any history-replay safety review. Adding the
# ``apply_matter_narrative_v2`` activity dispatch inside
# ``NightlyNarrativeWorkflow.run`` is a non-additive change to the
# workflow history: pre-deploy histories have no record of the v2
# activity calls, so we gate the new branch on ``workflow.patched``.
# Histories started under the old code re-run the legacy direct-PATCH
# branch verbatim; new histories started after the deploy take the v2
# branch. See ``packages/learn/CLAUDE.md`` for the replay-safety
# contract.
NIGHTLY_NARRATIVE_STATE_MUTATOR_PATCH = "nightly_narrative_state_mutator_v1"


@dataclass
class NightlyNarrativeResult:
    """Compact run summary surfaced to Temporal history + tests."""

    matters_scanned: int = 0
    matters_refreshed: int = 0
    matters_skipped_no_activity: int = 0
    matters_errored: int = 0
    # Phase C aggregate counters — only populated on the patched branch.
    # We keep them separate from the legacy fields so dashboards reading
    # the schedule history can tell which branch ran.
    matters_mutated_v2: int = 0
    matters_no_change_v2: int = 0
    matters_errored_v2: int = 0
    error_messages: list[str] = field(default_factory=list)


@workflow.defn(name="NightlyNarrativeWorkflow")
class NightlyNarrativeWorkflow:
    """Per-tenant nightly narrative refresh. Cron: 02:00 local."""

    @workflow.run
    async def run(self) -> NightlyNarrativeResult:
        result = NightlyNarrativeResult()
        workflow.logger.info("nightly_narrative.run: start")

        retry = RetryPolicy(
            maximum_attempts=3,
            initial_interval=timedelta(seconds=2),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=30),
        )

        try:
            matter_paths: list[str] = await workflow.execute_activity(
                list_active_matters,
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            result.matters_errored += 1
            result.error_messages.append(f"list_active_matters: {exc}"[:500])
            workflow.logger.error("nightly_narrative.run: list failed: %s", exc)
            return result

        result.matters_scanned = len(matter_paths)
        workflow.logger.info(
            "nightly_narrative.run: scanning %d active matters", len(matter_paths),
        )

        use_v2 = workflow.patched(NIGHTLY_NARRATIVE_STATE_MUTATOR_PATCH)
        if use_v2:
            # New path (Phase C, #891): route every per-matter write
            # through ``apply_state_change_v2`` so we land a
            # ``state_change`` timeline entry + ``event/state-change-*``
            # audit record per spec §4. The wrapper activity does the
            # read + load + propose + POST internally; per-matter
            # 409-retry is handled inside v2 (bounded at 3) — we don't
            # reimplement it here.
            #
            # Stamp the observed-window end with workflow.now() so the
            # propose function's reasoning window closes deterministically
            # across retries (replay-safe).
            as_of_iso = (
                workflow.now()
                .astimezone(timezone.utc)
                .isoformat(timespec="seconds")
            )
            workflow.logger.info(
                "nightly_narrative.run: patched gate ON — using state_mutator v2",
            )
            for idx, matter_path in enumerate(matter_paths):
                if idx and idx % HEARTBEAT_EVERY == 0:
                    workflow.logger.info(
                        "nightly_narrative.run: v2 progress %d/%d",
                        idx, len(matter_paths),
                    )
                try:
                    outcome = await workflow.execute_activity(
                        apply_matter_narrative_v2,
                        args=[matter_path, as_of_iso],
                        start_to_close_timeout=timedelta(minutes=10),
                        retry_policy=retry,
                    )
                except Exception as exc:  # noqa: BLE001
                    result.matters_errored_v2 += 1
                    result.error_messages.append(
                        f"{matter_path}: v2 dispatch failed: {exc}"[:500]
                    )
                    workflow.logger.warning(
                        "nightly_narrative.run: v2 dispatch failed matter=%s err=%s",
                        matter_path, exc,
                    )
                    continue

                status = (outcome or {}).get("status") if isinstance(outcome, dict) else None
                if status == "mutated":
                    result.matters_mutated_v2 += 1
                elif status == "no_change":
                    result.matters_no_change_v2 += 1
                    workflow.logger.info(
                        "nightly_narrative.run: no change warranted for %s",
                        matter_path,
                    )
                else:
                    result.matters_errored_v2 += 1
                    err = (
                        (outcome or {}).get("error_message")
                        if isinstance(outcome, dict)
                        else "unknown_status"
                    )
                    result.error_messages.append(
                        f"{matter_path}: {err}"[:500]
                    )

            workflow.logger.info(
                "nightly_narrative.run: v2 done scanned=%d mutated=%d no_change=%d errors=%d",
                result.matters_scanned,
                result.matters_mutated_v2,
                result.matters_no_change_v2,
                result.matters_errored_v2,
            )
            return result

        for idx, matter_path in enumerate(matter_paths):
            if idx and idx % HEARTBEAT_EVERY == 0:
                workflow.logger.info(
                    "nightly_narrative.run: progress %d/%d",
                    idx, len(matter_paths),
                )

            try:
                summary = await workflow.execute_activity(
                    read_matter_summary,
                    args=[matter_path],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=retry,
                )

                signals = await workflow.execute_activity(
                    load_matter_signals_24h,
                    args=[matter_path],
                    start_to_close_timeout=timedelta(seconds=60),
                    retry_policy=retry,
                )

                transitions = await workflow.execute_activity(
                    load_task_transitions_24h,
                    args=[matter_path],
                    start_to_close_timeout=timedelta(seconds=60),
                    retry_policy=retry,
                )

                # Idempotency gate — skip the LLM AND the patch entirely
                # when nothing happened. The previous narrative stays
                # authoritative because re-drafting "nothing changed"
                # would just bump as_of without producing better text.
                if not signals and not transitions:
                    result.matters_skipped_no_activity += 1
                    workflow.logger.info(
                        "nightly_narrative.run: matter=%s no activity — skipped",
                        matter_path,
                    )
                    continue

                signal_paths = [s.get("path", "") for s in signals if s.get("path")]
                events = await workflow.execute_activity(
                    load_source_events,
                    args=[signal_paths],
                    start_to_close_timeout=timedelta(seconds=120),
                    retry_policy=retry,
                )

                narrative: str = await workflow.execute_activity(
                    generate_matter_narrative,
                    args=[summary, signals, transitions, events],
                    start_to_close_timeout=timedelta(seconds=300),
                    retry_policy=RetryPolicy(
                        maximum_attempts=2,
                        initial_interval=timedelta(seconds=5),
                    ),
                )

                if not narrative or not narrative.strip():
                    # The clerk returned empty — don't blow away a prior
                    # narrative with whitespace. Count as errored so the
                    # log surfaces it.
                    result.matters_errored += 1
                    result.error_messages.append(
                        f"empty narrative for {matter_path}"[:500]
                    )
                    workflow.logger.warning(
                        "nightly_narrative.run: matter=%s empty narrative — skipped patch",
                        matter_path,
                    )
                    continue

                # Stamp as_of with workflow time so retries see the same
                # value (Temporal-determinism friendly).
                as_of = workflow.now().astimezone(timezone.utc).isoformat(timespec="seconds")

                await workflow.execute_activity(
                    patch_matter_narrative,
                    args=[matter_path, narrative, as_of, len(signals)],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=retry,
                )
                result.matters_refreshed += 1
            except Exception as exc:  # noqa: BLE001
                # Per-matter failure: log + continue. A clerk billing
                # error on one matter shouldn't kill the rest of the
                # night.
                result.matters_errored += 1
                result.error_messages.append(
                    f"{matter_path}: {exc}"[:500]
                )
                workflow.logger.warning(
                    "nightly_narrative.run: matter=%s failed: %s",
                    matter_path, exc,
                )

        workflow.logger.info(
            "nightly_narrative.run: done scanned=%d refreshed=%d skipped=%d errors=%d",
            result.matters_scanned,
            result.matters_refreshed,
            result.matters_skipped_no_activity,
            result.matters_errored,
        )
        return result
