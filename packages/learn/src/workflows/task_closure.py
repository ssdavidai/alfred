"""TaskClosureWatcherWorkflow — every 5 min, match new signals to open tasks.

Companion to ARCH-11's forward path. The forward arrow (signal →
needs_attention → click → decision → task) has been live since the
Desk surfaced decisions as first-class records. This workflow is the
backward arrow: an inbound signal that satisfies an existing open
task auto-closes the task by writing a decision(intent=done,
source=task, evidence=signal).

Why it lives as its own workflow rather than a step in
signal_router: signal_router runs every 2 min and is on the
fast-path for new-signal triage. Closure assessment is LLM-backed
(N tasks × M signals × 1 clerk call) and is decidedly slow-path.
Keeping it separate means a slow clerk doesn't back up routing.

Cadence: 5 min interval. Each tick:

  1. ``list_open_tasks`` — current open population (matter-bound only).
  2. ``list_recent_signals`` — signals created in last 30 min.
  3. For each signal, candidate-pair against every open task whose
     matter_ref matches any of the signal's target_candidates.
  4. ``assess_closure`` per pair (clerk JSON call).
  5. If ``confidence >= HIGH_CONFIDENCE_THRESHOLD``, ``write_closure_decision``.

Bounded fan-out: cap at MAX_PAIRS_PER_TICK clerk calls to keep token
spend tight on bursty inbound traffic.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.task_closure import (
        HIGH_CONFIDENCE_THRESHOLD,
        assess_closure,
        list_open_tasks,
        list_recent_signals,
        write_closure_decision,
    )


MAX_PAIRS_PER_TICK = 40


@dataclass
class TaskClosureResult:
    open_tasks: int = 0
    recent_signals: int = 0
    pairs_considered: int = 0
    pairs_assessed: int = 0
    closures_written: int = 0
    errors: list[str] = field(default_factory=list)


@workflow.defn(name="TaskClosureWatcherWorkflow")
class TaskClosureWatcherWorkflow:
    """5-min tick: find signals that satisfy open tasks and auto-close them."""

    @workflow.run
    async def run(self) -> TaskClosureResult:
        result = TaskClosureResult()
        retry = RetryPolicy(
            maximum_attempts=2,
            initial_interval=timedelta(seconds=2),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=10),
        )

        try:
            open_tasks: list[dict[str, Any]] = await workflow.execute_activity(
                list_open_tasks,
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            result.errors.append(f"list_open_tasks: {exc}"[:300])
            return result
        result.open_tasks = len(open_tasks)

        try:
            signals: list[dict[str, Any]] = await workflow.execute_activity(
                list_recent_signals,
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            result.errors.append(f"list_recent_signals: {exc}"[:300])
            return result
        result.recent_signals = len(signals)

        if not open_tasks or not signals:
            workflow.logger.info(
                "task_closure: nothing to do (open_tasks=%d signals=%d)",
                len(open_tasks), len(signals),
            )
            return result

        # Bucket tasks by matter for O(1) lookup per signal.
        tasks_by_matter: dict[str, list[dict[str, Any]]] = {}
        for t in open_tasks:
            tasks_by_matter.setdefault(t["matter_ref"], []).append(t)

        # Build the candidate pair list. Each signal × each task in any
        # of its target matters. De-dupe by (task.path, signal.path).
        seen: set[tuple[str, str]] = set()
        pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for s in signals:
            for mref in s.get("matter_refs") or []:
                for t in tasks_by_matter.get(mref, []):
                    key = (t["path"], s["path"])
                    if key in seen:
                        continue
                    seen.add(key)
                    pairs.append((t, s))
        result.pairs_considered = len(pairs)

        if len(pairs) > MAX_PAIRS_PER_TICK:
            workflow.logger.warning(
                "task_closure: pair count %d exceeds cap %d — truncating",
                len(pairs), MAX_PAIRS_PER_TICK,
            )
            pairs = pairs[:MAX_PAIRS_PER_TICK]

        for t, s in pairs:
            try:
                assessment = await workflow.execute_activity(
                    assess_closure,
                    args=[t, s],
                    start_to_close_timeout=timedelta(seconds=120),
                    retry_policy=retry,
                )
            except Exception as exc:  # noqa: BLE001
                result.errors.append(
                    f"assess_closure {t.get('stem')} × {s.get('stem')}: {exc}"[:300]
                )
                continue
            result.pairs_assessed += 1

            if not assessment.get("closes"):
                continue
            confidence = float(assessment.get("confidence", 0.0) or 0.0)
            if confidence < HIGH_CONFIDENCE_THRESHOLD:
                workflow.logger.info(
                    "task_closure: medium-confidence skip task=%s signal=%s conf=%.2f",
                    t.get("stem"), s.get("stem"), confidence,
                )
                continue

            try:
                write_result = await workflow.execute_activity(
                    write_closure_decision,
                    args=[t, s, assessment],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=retry,
                )
            except Exception as exc:  # noqa: BLE001
                result.errors.append(
                    f"write_closure_decision {t.get('stem')}: {exc}"[:300]
                )
                continue
            if write_result.get("ok"):
                result.closures_written += 1
                workflow.logger.info(
                    "task_closure: closed task=%s by signal=%s conf=%.2f",
                    t.get("stem"), s.get("stem"), confidence,
                )

        workflow.logger.info(
            "task_closure.run: open=%d signals=%d pairs=%d assessed=%d closed=%d errors=%d",
            result.open_tasks, result.recent_signals,
            result.pairs_considered, result.pairs_assessed,
            result.closures_written, len(result.errors),
        )
        return result
