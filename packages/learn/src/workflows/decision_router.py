"""DecisionRouterWorkflow — fans out the side-effects of human clicks.

Every click on the Desk's Delegate / Defer / Delete / Do buttons
becomes a ``decision/<ts>-<short>.md`` vault record. This workflow,
fired every 60 seconds, picks up new decisions and runs the downstream
mutations: needs_attention status flips, signal re-arms / agent
dispatches, to_do spawns, outcome linkage when delegated agents
complete, and inverse side-effects for reversed decisions.

Schedule: every-60s — singleton (overlap policy: skip if already
running, so a slow clerk doesn't stack up). All work is per-decision
idempotent (state transitions are atomic PATCHes via ctrl-api), so a
retry can't double-fire side effects.

The workflow runs three passes per tick, sequentially:

  1. Open decisions  → route_decision (forward side effects).
  2. Reversed decisions → reverse_decision (inverse side effects).
  3. Executing decisions → check_decision_outcomes (poll for agent
     outcome signals matching open delegate decisions).

Each pass heartbeats every 5 records so a busy tenant doesn't trip
Temporal's workflow-task timeout.
"""
from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.decision_router import (
        apply_decision_outcome_link_v2,
        check_decision_outcomes,
        list_decisions_by_state,
        reverse_decision,
        route_decision,
    )


# SM-D-W7: patched gate for the universal state-mutator (v2) audit
# path on the delegate-loop outcome linkage. ``check_decision_outcomes``
# continues to do the decision-side write (state=completed +
# outcome_record stamped on the decision record); the new code below
# layers the matching task-side write on top so the task's status
# flips to "closed" with an ``outcome=...`` summary AND a
# state_change audit + timeline entry lands with
# source=decision_router.outcome_link. In-flight workflow histories
# started before this gate replay through the un-patched branch and
# skip the v2 fan-out entirely, preserving deterministic replay per
# packages/learn/CLAUDE.md.
DECISION_ROUTER_OUTCOME_STATE_MUTATOR_PATCH = (
    "decision_router_outcome_state_mutator_v1"
)


HEARTBEAT_EVERY = 5
_ROUTE_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=5),
    maximum_interval=timedelta(seconds=30),
    maximum_attempts=3,
)


@workflow.defn
class DecisionRouterWorkflow:
    """Single-shot per-tick: process opens, reverseds, outcomes."""

    @workflow.run
    async def run(self) -> dict:
        opens_processed = 0
        reverseds_processed = 0
        outcomes_matched = 0

        # ---- Pass 1: forward routing on new decisions ----
        opens = await workflow.execute_activity(
            list_decisions_by_state,
            "open",
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=_ROUTE_RETRY,
        )
        for i, d in enumerate(opens or []):
            try:
                await workflow.execute_activity(
                    route_decision,
                    d,
                    start_to_close_timeout=timedelta(seconds=60),
                    retry_policy=_ROUTE_RETRY,
                )
                opens_processed += 1
            except Exception as exc:  # noqa: BLE001
                workflow.logger.warning(
                    "decision_router: route_decision failed for %s: %s",
                    d.get("id"), exc,
                )
            if (i + 1) % HEARTBEAT_EVERY == 0:
                workflow.logger.info(
                    "decision_router: routed %d/%d opens", i + 1, len(opens),
                )

        # ---- Pass 2: reverse routing on undone decisions ----
        reverseds = await workflow.execute_activity(
            list_decisions_by_state,
            "reversed",
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=_ROUTE_RETRY,
        )
        for i, d in enumerate(reverseds or []):
            # Skip if we've already processed this reversal (router
            # stamps ``side_effects.reversal_processed=true`` after
            # running the inverse).
            side_effects = d.get("side_effects") or {}
            if (
                isinstance(side_effects, dict)
                and side_effects.get("reversal_processed") is True
            ):
                continue
            try:
                await workflow.execute_activity(
                    reverse_decision,
                    d,
                    start_to_close_timeout=timedelta(seconds=60),
                    retry_policy=_ROUTE_RETRY,
                )
                reverseds_processed += 1
            except Exception as exc:  # noqa: BLE001
                workflow.logger.warning(
                    "decision_router: reverse_decision failed for %s: %s",
                    d.get("id"), exc,
                )

        # ---- Pass 3: outcome linkage for executing decisions ----
        outcome_result: dict | None = None
        try:
            outcome_result = await workflow.execute_activity(
                check_decision_outcomes,
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=_ROUTE_RETRY,
            )
            if isinstance(outcome_result, dict):
                outcomes_matched = int(outcome_result.get("matched") or 0)
        except Exception as exc:  # noqa: BLE001
            workflow.logger.warning(
                "decision_router: check_decision_outcomes failed: %s", exc,
            )

        # SM-D-W7 — task-side outcome linkage through state_mutator v2.
        # The decision-side write (state=completed, outcome_record on
        # the decision) has already landed inside
        # ``check_decision_outcomes``. The v2 fan-out below is what
        # actually flips the associated task's status to "closed"
        # with an ``outcome=...`` summary AND emits the state_change
        # audit + timeline entry on the task. Gated by
        # workflow.patched so pre-deploy histories replay
        # deterministically.
        if (
            outcome_result is not None
            and isinstance(outcome_result, dict)
            and workflow.patched(DECISION_ROUTER_OUTCOME_STATE_MUTATOR_PATCH)
        ):
            matches = outcome_result.get("matches") or []
            if isinstance(matches, list):
                for m in matches:
                    if not isinstance(m, dict):
                        continue
                    task_ref = str(m.get("task_ref") or "").strip()
                    if not task_ref:
                        # Decision didn't carry an explicit task linkage —
                        # skip (the decision-side flip is the only write
                        # we can do safely without a task to point at).
                        continue
                    decision_id = str(m.get("decision_id") or "").strip()
                    outcome_record = str(m.get("outcome_record") or "").strip()
                    intent = str(m.get("intent") or "delegate").strip()
                    source_headline = str(m.get("source_headline") or "").strip()
                    try:
                        await workflow.execute_activity(
                            apply_decision_outcome_link_v2,
                            args=[
                                task_ref,
                                decision_id,
                                outcome_record,
                                intent,
                                source_headline,
                                "live",
                            ],
                            start_to_close_timeout=timedelta(seconds=60),
                            retry_policy=_ROUTE_RETRY,
                        )
                    except Exception as exc:  # noqa: BLE001
                        # Best-effort: the decision-side write is the
                        # load-bearing flip; v2 audit emission failure
                        # logs and continues.
                        workflow.logger.warning(
                            "decision_router.v2: apply_decision_outcome_link_v2 "
                            "failed decision=%s task=%s err=%s",
                            decision_id, task_ref, exc,
                        )

        workflow.logger.info(
            "decision_router: opens=%d reverseds=%d outcomes_matched=%d",
            opens_processed, reverseds_processed, outcomes_matched,
        )
        return {
            "opens_processed": opens_processed,
            "reverseds_processed": reverseds_processed,
            "outcomes_matched": outcomes_matched,
        }
