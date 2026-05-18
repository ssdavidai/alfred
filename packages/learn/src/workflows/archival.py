"""ArchivalSweepWorkflow — daily 90-day Parquet roll-out for state.db.

STORE-P5-1: Phase 5 of the Storage Architecture migration (epic #898).

state.db carries three hot tables (``audit``, ``signal``,
``observation``) that grow linearly with tenant activity. This workflow
rolls rows older than the per-table TTL (default 90 days, env-tunable)
into columnar Parquet bundles under
``/vault/_archive/<YYYY-MM>/<table>.parquet``, then DELETEs the
archived rows from state.db. The Parquet path is read by STORE-P5-2's
DuckDB reader (not in scope here) so the hot/cold split is transparent
to the UI.

Schedule: daily at 03:00 UTC via ``al-archival-sweep`` (registered by
``scripts/register_schedules.py``). The schedule check happens at
registration time only; rechecking env inside ``@workflow.run`` would
violate Temporal determinism rules. SKIP overlap so a long sweep
doesn't pile on with itself.

Replay note
-----------
This is a NEW workflow with no pre-existing replay history at deploy,
so the three ``workflow.execute_activity(compact_to_parquet, ...)``
calls below do NOT need ``workflow.patched()`` gating. Future
additions inside the ``@workflow.run`` body MUST use the standard
patched-gate contract from CLAUDE.md (adding new activity calls
without a patched gate breaks replay for in-flight workflows that
spanned the deploy boundary).

Output: an ``ArchivalSweepResult`` carrying per-table outcomes plus
the timestamps used for each TTL cutoff. Surfaced in the Temporal UI.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.archive import (
        compact_to_parquet,
        compute_before_ts_ns,
    )


@dataclass
class TableArchiveOutcome:
    """Per-table outcome — one of these per (audit / signal / observation)."""

    table: str
    copied: int = 0
    deleted: int = 0
    parquet_paths: list[str] = field(default_factory=list)
    ms: int = 0
    skipped: str | None = None
    error: str | None = None


@dataclass
class ArchivalSweepResult:
    """Per-tick outcome — surfaced in Temporal UI."""

    outcomes: list[TableArchiveOutcome] = field(default_factory=list)
    error: str | None = None


# Sweep order matters only insofar as ``observation.signal_id`` is a
# soft FK into ``signal.id`` — neither table enforces the constraint at
# the SQL layer (state.db migration 004 declares them in different
# CREATE TABLEs without REFERENCES), but archiving observations before
# their parent signals keeps the in-flight invariants tidier for
# anyone inspecting a partial archive. Audit is independent and goes
# first because it's the largest by row count.
_SWEEP_ORDER: tuple[str, ...] = ("audit", "observation", "signal")


@workflow.defn(name="ArchivalSweepWorkflow")
class ArchivalSweepWorkflow:
    """Daily Parquet roll-out for state.db audit/signal/observation.

    Schedule: daily at 03:00 UTC via ``al-archival-sweep``. SKIP
    overlap. Each table runs as a separate ``compact_to_parquet``
    activity invocation with its own retry policy — a failure on one
    table doesn't stall the others.
    """

    @workflow.run
    async def run(self) -> ArchivalSweepResult:
        workflow.logger.info("archival_sweep.start")

        retry = RetryPolicy(
            maximum_attempts=2,
            initial_interval=timedelta(seconds=10),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(minutes=1),
        )

        # Compute the ns cutoff once per workflow attempt so all three
        # tables see the same "now" reference even if the activities
        # straggle. workflow.now() is deterministic across replay.
        now_ns = int(workflow.now().timestamp() * 1_000_000_000)

        outcomes: list[TableArchiveOutcome] = []
        for table in _SWEEP_ORDER:
            cutoff = compute_before_ts_ns(table, now_ns=now_ns)
            try:
                result: dict[str, Any] = await workflow.execute_activity(
                    compact_to_parquet,
                    args=[table, cutoff],
                    # 15 min envelope per table. David's heaviest
                    # table is audit (~80k rows today, ~years to
                    # accumulate the first hundred-thousand-row
                    # rollout); the bulk read + Parquet write + delete
                    # finishes in seconds on a healthy DB. Headroom
                    # protects against an I/O-stalled vault mount.
                    start_to_close_timeout=timedelta(minutes=15),
                    retry_policy=retry,
                )
            except Exception as exc:  # noqa: BLE001
                workflow.logger.warning(
                    "archival_sweep.table_failed table=%s err=%s",
                    table, exc,
                )
                outcomes.append(TableArchiveOutcome(
                    table=table, error=str(exc)[:500],
                ))
                continue

            outcomes.append(TableArchiveOutcome(
                table=str(result.get("table", table)),
                copied=int(result.get("copied", 0)),
                deleted=int(result.get("deleted", 0)),
                parquet_paths=list(result.get("parquet_paths", []) or []),
                ms=int(result.get("ms", 0)),
                skipped=(
                    str(result["skipped"]) if result.get("skipped") else None
                ),
            ))

        for o in outcomes:
            workflow.logger.info(
                "archival_sweep.table_done table=%s copied=%d deleted=%d "
                "skipped=%s error=%s",
                o.table, o.copied, o.deleted, o.skipped, o.error,
            )
        return ArchivalSweepResult(outcomes=outcomes)


__all__ = [
    "ArchivalSweepResult",
    "ArchivalSweepWorkflow",
    "TableArchiveOutcome",
]
