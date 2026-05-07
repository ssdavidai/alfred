"""ReversalCalibrationWorkflow — periodic reversal-driven calibration sweep.

Phase 6.7 (T6.7.5) wraps the
``process_reversals_for_calibration`` activity in a Temporal workflow
so the daily steward.tick path doesn't need to run the discovery glob
on every per-matter loop. A standalone schedule runs every 10 min,
gated at registration time on
``STEWARD_REVERSAL_CALIBRATION_ENABLED``.

Why a separate workflow (vs. baking into StewardWorkflow)?
----------------------------------------------------------

  * StewardWorkflow runs per-matter, every 30 min on each matter's
    cadence. Folding reversal scanning into each tick would mean N
    tenants × M matters worth of glob scans per cycle, where the
    answer is identical for every matter on the same tenant.

  * The reversal scan is fleet-state, not matter-state — there's no
    per-matter input, just "scan the whole vault for new reversals
    and update the source-type calibration cache". A singleton
    schedule maps cleanly to that shape.

  * Failure isolation. A glob-search wedge or cache-write failure
    inside StewardWorkflow's per-tick path would block normal Steward
    evaluation. As a separate workflow, a wedge at most stalls the
    reversal-calibration cycle while normal Steward evaluation
    continues unaffected.

Pattern mirrors ``StreamEventPurgeWorkflow`` (T6.6.3) — same RetryPolicy,
same dataclass-result shape, same workflow-sandbox imports_passed_through.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.calibration_reversal import (
        process_reversals_for_calibration,
    )


@dataclass
class ReversalCalibrationResult:
    """Per-tick outcome — surfaced in Temporal UI."""

    processed: int = 0
    skipped: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)
    applied_keys: list[str] = field(default_factory=list)


@workflow.defn(name="ReversalCalibrationWorkflow")
class ReversalCalibrationWorkflow:
    """Singleton 10-min scan for new reversal records.

    Schedule: ``al-reversal-calibration``, every 10 min. Gated on
    ``STEWARD_REVERSAL_CALIBRATION_ENABLED`` at registration time and
    re-checked inside the activity body.
    """

    @workflow.run
    async def run(self) -> ReversalCalibrationResult:
        workflow.logger.info("reversal_calibration.start")

        retry = RetryPolicy(
            maximum_attempts=2,
            initial_interval=timedelta(seconds=5),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=30),
        )

        try:
            outcome: dict[str, Any] = await workflow.execute_activity(
                process_reversals_for_calibration,
                # 5-min envelope: discovery glob is cheap (frontmatter
                # already in memory at the API layer) and per-record
                # work is two reads + one cache write. A healthy run
                # finishes in <10s on a saturated tenant. Cap protects
                # against a wedged ctrl-api blocking the schedule.
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            workflow.logger.warning(
                "reversal_calibration.failed err=%s", exc,
            )
            return ReversalCalibrationResult(
                errors=1,
                error_messages=[
                    f"process_reversals_for_calibration: {exc}"[:500],
                ],
            )

        result = ReversalCalibrationResult(
            processed=int(outcome.get("processed", 0)),
            skipped=int(outcome.get("skipped", 0)),
            errors=int(outcome.get("errors", 0)),
            error_messages=list(outcome.get("error_messages", []))[:10],
            applied_keys=list(outcome.get("applied_keys", []))[:50],
        )
        workflow.logger.info(
            "reversal_calibration.done processed=%d skipped=%d "
            "errors=%d keys=%d",
            result.processed,
            result.skipped,
            result.errors,
            len(result.applied_keys),
        )
        return result
