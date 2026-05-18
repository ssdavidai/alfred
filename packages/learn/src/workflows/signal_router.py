"""SignalRouterWorkflow — routes signals → mutations + actions (T6.3.3).

Schedule: every 2 minutes (registered in ``scripts/register_schedules.py``
as ``al-signal-router`` with overlap=SKIP).

Gated at registration time on ``STEWARD_SIGNAL_ROUTER_ENABLED=true``.
The workflow itself does not re-check the env var — env reads inside
``@workflow.run`` would violate Temporal determinism rules. The
registration-time gate is the single source of truth: a tenant without
the flag never gets the schedule created, so the workflow never runs.

Pipeline per tick:

  1. ``list_unrouted_signals`` — return paths of signal records whose
     ``frontmatter.status`` is ``unrouted`` (or null/missing for
     defensive backward-compatibility), oldest-first by ``created``.
     Limit ``BATCH_LIMIT`` (50) per tick to keep p95 well within the
     2-min schedule envelope.
  2. For each signal:

     a. If ``effect=mutation`` →
        ``apply_signal_mutation(signal_path, mode=ROUTER_MODE)``. The
        activity owns the mode-resolution + env-veto + idempotent
        status-write semantics; the workflow's only job is to count
        outcomes.

     b. If ``effect=action`` → mark ``status=action_pending`` so we
        don't reprocess (Phase 6.4 will pick up). The activity-level
        router for actions ships in T6.4.x.

     c. If ``effect=none``/informational → mark ``status=skipped`` so
        we don't reprocess.

  Per-signal try/except: a single bad signal (transient ctrl-api error,
  malformed proposal, etc.) increments the error counter but doesn't
  sink the rest of the batch. The 2-min cadence is the natural retry
  boundary; persistent failures show up as an un-advanced
  ``status=unrouted`` cursor on individual signals.

The router-mode argument passed to ``apply_signal_mutation`` is
hardcoded as ``"live"`` because the activity's env veto
(``STEWARD_SIGNAL_ROUTER_LIVE_MODE``) is the operator-controlled
shadow/live switch. Passing ``"shadow"`` from the workflow side would
forfeit the ability to flip on live without a code redeploy. The
workflow defers ALL gating to the activity's env-read so a single env
var on the worker controls behaviour.

Phase 6 hard rules respected:

  * NO env reads inside ``@workflow.run`` — the activity reads the
    env on each invocation.
  * NO mocks — every workflow.execute_activity call dispatches to a
    real activity registered in ``src/worker.py``.
  * NO direct vault filesystem — writes flow through ctrl-api via
    ``VaultClient``.
  * NO direct Anthropic — the router does not call any LLM (signal
    extraction already classified the proposal).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

# NB: httpx is NOT imported at module level. Temporal's workflow sandbox
# scans this file during validation and chokes on httpx's
# proxied-subclass C-extension imports ("Restriction state not present.
# Using subclasses of proxied objects is unsupported"). The httpx-using
# code lives inside @activity.defn function bodies, which the sandbox
# tolerates as opaque. Lazy-import inside each activity instead.
from temporalio import activity, workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.signal_actions import route_signal_action
    from src.activities.signal_mutations import (
        apply_signal_mutation,
        list_unrouted_signals,
    )


# Max signals processed per tick. Sized so the worst-case run (every
# signal hits the apply_state_change live path with a Plane write)
# still finishes inside the 2-min schedule envelope.
BATCH_LIMIT: int = 50

# Mode argument we pass to apply_signal_mutation. Hardcoded "live" so
# the operator's env-veto (STEWARD_SIGNAL_ROUTER_LIVE_MODE) is the
# single source of truth for shadow/live cutover. Passing "shadow"
# would preempt the env-veto and require a redeploy to flip on.
ROUTER_INTENT_MODE: str = "live"


# ---------------------------------------------------------------------------
# Mark-status activity — light-weight bookkeeping for action / skip paths
# ---------------------------------------------------------------------------

@activity.defn
async def mark_signal_status(
    signal_path: str,
    status: str,
) -> None:
    """Patch a signal record's status field to one of the terminal
    values: ``"action_pending"`` (effect=action — Phase 6.4 will pick
    up) or ``"skipped"`` (effect=none/informational).

    Errors propagate so Temporal's retry policy handles a transient
    ctrl-api outage. The workflow's per-signal try/except records the
    failure on the result counter so a permanent failure stays loud.
    """
    if not signal_path or not isinstance(signal_path, str):
        raise ValueError(
            f"mark_signal_status: invalid signal_path={signal_path!r}"
        )
    if status not in ("action_pending", "skipped"):
        raise ValueError(
            f"mark_signal_status: invalid status={status!r}"
        )

    # Lazy imports — keep the module-level surface light and match
    # apply_signal_mutation's pattern (config + client constructed
    # inside the activity body). httpx in particular MUST be lazy
    # because Temporal's workflow sandbox can't proxy its C-extension
    # subclasses; importing it at module top crashes worker validation.
    import logging
    from datetime import datetime, timezone

    import httpx
    from src.config import load_config
    from src.utils.vault_client import VaultClient

    logger = logging.getLogger("alfred-learn")

    cfg = load_config()
    client = VaultClient(cfg)
    try:
        try:
            await client.patch_frontmatter_structured(
                signal_path,
                scalar_updates={
                    "status": status,
                    "applied_at": datetime.now(timezone.utc).isoformat(
                        timespec="seconds"
                    ),
                    "audit_record_path": "",
                },
            )
            logger.info(
                "signal_router.mark_signal_status: path=%s status=%s",
                signal_path, status,
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "signal_router.mark_signal_status: PATCH failed path=%s "
                "status=%s err=%s",
                signal_path, status, exc,
            )
            raise
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Workflow result dataclass
# ---------------------------------------------------------------------------

@dataclass
class SignalRouterResult:
    """Per-tick outcome — surfaced in Temporal UI for visibility.

    Counter semantics:
      * ``listed`` — total signal paths returned by
        ``list_unrouted_signals`` for this tick.
      * ``routed_mutation`` — signals successfully passed through
        ``apply_signal_mutation`` (regardless of whether the
        downstream action fired in shadow vs. live).
      * ``routed_action`` — signals marked ``action_pending`` for
        Phase 6.4 to pick up.
      * ``skipped`` — signals marked ``status=skipped`` (effect=none /
        informational / malformed past the validation gate).
      * ``errors`` — count of per-signal exceptions surfaced from the
        try/except. ``error_messages`` carries the first ~10 messages
        for surfacing in Temporal UI.
    """

    started: bool = False
    listed: int = 0
    routed_mutation: int = 0
    routed_action: int = 0
    skipped: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers — workflow-safe accessors on the signal record we list
# ---------------------------------------------------------------------------
#
# The list_unrouted_signals activity returns just ``list[str]`` of paths
# (the workflow doesn't need full record bodies — apply_signal_mutation
# reads them inside the activity). We dispatch one apply per signal and
# the activity decides what to do with the effect; for the action /
# skip branches we need ONE more activity to peek at the effect, which
# we co-locate with apply_signal_mutation by passing through the
# ``signal_status`` field on the result. That keeps the workflow free
# of any vault reads — every read goes through an activity.


# ---------------------------------------------------------------------------
# Workflow
# ---------------------------------------------------------------------------

@workflow.defn(name="SignalRouterWorkflow")
class SignalRouterWorkflow:
    """Signals → mutations / actions (Phase 6 T6.3.3).

    Schedule: every 2 minutes via ``al-signal-router``. Gated on
    ``STEWARD_SIGNAL_ROUTER_ENABLED`` at registration time only —
    re-reading the env inside ``@workflow.run`` would break Temporal
    determinism.
    """

    @workflow.run
    async def run(self) -> SignalRouterResult:
        workflow.logger.info("signal_router.start")
        result = SignalRouterResult()
        result.started = True

        retry = RetryPolicy(
            maximum_attempts=3,
            initial_interval=timedelta(seconds=1),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=15),
        )

        # 1. List unrouted signals.
        try:
            paths: list[str] = await workflow.execute_activity(
                list_unrouted_signals,
                args=[BATCH_LIMIT, None],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            result.errors += 1
            result.error_messages.append(
                f"list_unrouted_signals: {exc}"[:500]
            )
            workflow.logger.warning(
                "signal_router.list_failed err=%s", exc,
            )
            return result

        result.listed = len(paths)
        if not paths:
            workflow.logger.info("signal_router.no_signals")
            return result

        # 2. Route each signal. We dispatch apply_signal_mutation for
        #    every path; the activity validates the effect field
        #    internally and returns a ``signal_status`` field telling
        #    us how to count it. That keeps the workflow free of any
        #    vault reads — all I/O lives in activities.
        #
        #    For action/skip branches we route via mark_signal_status
        #    after a separate effect-peek… BUT the activity only
        #    handles the mutation case. For the action / informational
        #    branches the workflow needs to know the effect; we read
        #    it via apply_signal_mutation's signal_status return on
        #    the "skipped" path, then dispatch mark_signal_status if
        #    the skip_reason indicates effect-mismatch.
        #
        #    Concretely:
        #      apply_signal_mutation returns:
        #        signal_status="applied"          → routed_mutation++
        #        signal_status="skipped",
        #          skip_reason="effect_is_action"  → action_pending
        #          skip_reason="effect_is_none"    → skipped
        #          (other reasons)                 → skipped
        for path in paths[:BATCH_LIMIT]:
            try:
                outcome: dict[str, Any] = await workflow.execute_activity(
                    apply_signal_mutation,
                    args=[path, ROUTER_INTENT_MODE],
                    # Generous 90s envelope: covers the apply_state_change
                    # vault reads, Plane comment + state transition, audit
                    # record write, and signal-status PATCH. Healthy ticks
                    # finish in <5s; the cap protects against a wedged
                    # ctrl-api during a Plane outage.
                    start_to_close_timeout=timedelta(seconds=90),
                    retry_policy=retry,
                )
            except Exception as exc:  # noqa: BLE001
                result.errors += 1
                if len(result.error_messages) < 10:
                    result.error_messages.append(
                        f"apply path={path}: {exc}"[:500]
                    )
                workflow.logger.warning(
                    "signal_router.apply_failed path=%s err=%s",
                    path, exc,
                )
                # Don't mark — next tick retries. Idempotent
                # apply_state_change + the deterministic signal-record
                # status field protect against double-application.
                continue

            if not isinstance(outcome, dict):
                result.errors += 1
                if len(result.error_messages) < 10:
                    result.error_messages.append(
                        f"apply path={path}: non-dict outcome"[:500]
                    )
                continue

            signal_status = str(outcome.get("signal_status") or "").strip()
            if signal_status == "applied":
                result.routed_mutation += 1
                continue

            if signal_status != "skipped":
                # Defensive — unknown signal_status code from a future
                # activity revision. Count as error so it stays loud.
                result.errors += 1
                if len(result.error_messages) < 10:
                    result.error_messages.append(
                        f"apply path={path}: unknown signal_status="
                        f"{signal_status!r}"[:500]
                    )
                continue

            skip_reason = str(outcome.get("skip_reason") or "").strip()

            # Branch: effect=action → Phase 6.4 router. We dispatch
            # ``route_signal_action`` which owns the discretion-gated
            # decision between agent dispatch (HIGH path) and the
            # ``needs_attention/`` human surface (HUMAN path), AND
            # owns its own status-marking + audit emission. Per-signal
            # try/except so a wedged clerk on one signal doesn't sink
            # the rest of the batch; the activity re-raises on transient
            # ctrl-api / clerk failures so Temporal retry kicks in
            # naturally on the next tick.
            #
            # Mode argument hardcoded to "live" for the same reason
            # the mutation branch does: the env-veto
            # (STEWARD_SIGNAL_ACTION_LIVE_MODE) is the operator-
            # controlled shadow/live switch. Passing "shadow" from
            # here would forfeit the ability to flip on autonomous
            # dispatch without a code redeploy.
            if skip_reason == "effect_is_action":
                try:
                    action_outcome = await workflow.execute_activity(
                        route_signal_action,
                        args=[path, ROUTER_INTENT_MODE],
                        # 1000s envelope: covers list-instincts +
                        # match + (AGENT path) ephemeral lifecycle +
                        # clerk-style spawn/poll (≤900s in _call_clerk)
                        # + outcome signal write + audit + queue wait.
                        # Sized to comfortably absorb the 900s agent
                        # ceiling plus ~100s for pre/post work. HUMAN
                        # path still completes in ≤2s typically.
                        start_to_close_timeout=timedelta(seconds=1000),
                        retry_policy=retry,
                    )
                    if isinstance(action_outcome, dict):
                        action_status = str(
                            action_outcome.get("signal_status") or ""
                        )
                        if action_status in ("routed_agent", "routed_human"):
                            result.routed_action += 1
                        elif action_status == "skipped":
                            # Defensive — route_signal_action's own
                            # validation (no proposal / 404 / bad
                            # shape). Don't double-count as routed.
                            result.skipped += 1
                        else:
                            result.errors += 1
                            if len(result.error_messages) < 10:
                                result.error_messages.append(
                                    f"route_action path={path}: "
                                    f"unknown signal_status="
                                    f"{action_status!r}"[:500]
                                )
                    else:
                        result.errors += 1
                        if len(result.error_messages) < 10:
                            result.error_messages.append(
                                f"route_action path={path}: non-dict "
                                f"outcome"[:500]
                            )
                except Exception as exc:  # noqa: BLE001
                    result.errors += 1
                    if len(result.error_messages) < 10:
                        result.error_messages.append(
                            f"route_action path={path}: {exc}"[:500]
                        )
                    workflow.logger.warning(
                        "signal_router.route_action_failed path=%s err=%s",
                        path, exc,
                    )
                continue

            # Branch: effect=none / informational / malformed →
            # apply_signal_mutation already patched status=skipped via
            # _mark_signal_skipped for most validation-fail reasons.
            # For "effect_is_none" specifically the activity DOES NOT
            # mark — that's a router responsibility — so we patch here.
            if skip_reason == "effect_is_none":
                try:
                    await workflow.execute_activity(
                        mark_signal_status,
                        args=[path, "skipped"],
                        start_to_close_timeout=timedelta(seconds=15),
                        retry_policy=retry,
                    )
                    result.skipped += 1
                except Exception as exc:  # noqa: BLE001
                    result.errors += 1
                    if len(result.error_messages) < 10:
                        result.error_messages.append(
                            f"mark_skipped path={path}: {exc}"[:500]
                        )
                    workflow.logger.warning(
                        "signal_router.mark_skipped_failed path=%s err=%s",
                        path, exc,
                    )
                continue

            # All other skip reasons (no_target_path, no_decision_label,
            # bad_target_kind_*, no_mutation_proposal,
            # signal_not_found, bad_record_shape) — the activity
            # already marked the signal status=skipped via
            # _mark_signal_skipped. Just count it.
            result.skipped += 1

        workflow.logger.info(
            "signal_router.done listed=%d routed_mutation=%d "
            "routed_action=%d skipped=%d errors=%d",
            result.listed,
            result.routed_mutation,
            result.routed_action,
            result.skipped,
            result.errors,
        )
        return result
