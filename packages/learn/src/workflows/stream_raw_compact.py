"""StreamRawCompactWorkflow — daily compaction of /vault/_raw/<date>.jsonl.

STORE-P4-1: Phase 4 of the Storage Architecture migration (epic #898).

Replaces the old "scan /vault/stream_event/*.md and DELETE each one" pattern
with a single ctrl-api call that:

  * Compacts partitions older than 7 days, keeping only events whose id is
    not in stream_event_processed.
  * Drops partitions older than 30 days outright (hard TTL).
  * Garbage-collects stale stream_event_processed rows.

Schedule: daily at 03:00 UTC via ``al-stream-raw-compact`` (registered by
``scripts/register_schedules.py``). The schedule check stays at registration
time only; rechecking env inside ``@workflow.run`` would violate Temporal
determinism rules.

Output: a ``CompactResult`` carrying per-action counts. Surfaced in the
Temporal UI for visibility.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.maintenance import compact_stream_raw_jsonl


@dataclass
class CompactResult:
    """Per-tick outcome — surfaced in Temporal UI."""

    partition_count: int = 0
    deleted: int = 0
    compacted: int = 0
    skipped: int = 0
    dropped_events: int = 0
    kept_events: int = 0
    processed_rows_pruned: int = 0
    error: str | None = None


@workflow.defn(name="StreamRawCompactWorkflow")
class StreamRawCompactWorkflow:
    """Daily compaction of the date-partitioned /vault/_raw JSONL log.

    Schedule: daily at 03:00 UTC via ``al-stream-raw-compact``. The
    activity does the actual filesystem work via a ctrl-api call so
    alfred-learn never touches the vault directly.
    """

    @workflow.run
    async def run(
        self,
        soft_compact_days: int = 7,
        hard_delete_days: int = 30,
    ) -> CompactResult:
        workflow.logger.info(
            "stream_raw_compact.start soft=%d hard=%d",
            soft_compact_days, hard_delete_days,
        )

        retry = RetryPolicy(
            maximum_attempts=2,
            initial_interval=timedelta(seconds=5),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=30),
        )

        try:
            outcome = await workflow.execute_activity(
                compact_stream_raw_jsonl,
                args=[int(soft_compact_days), int(hard_delete_days)],
                # 10 min envelope: david's heaviest single-day partition
                # is currently ~2 MB; even with full filesystem rewrite
                # the activity runs in seconds. Headroom is for fleet
                # growth past 100k events/day.
                start_to_close_timeout=timedelta(minutes=10),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            workflow.logger.warning("stream_raw_compact.failed err=%s", exc)
            return CompactResult(error=str(exc)[:500])

        result = CompactResult(
            partition_count=int(outcome.get("partition_count", 0)),
            deleted=int(outcome.get("deleted", 0)),
            compacted=int(outcome.get("compacted", 0)),
            skipped=int(outcome.get("skipped", 0)),
            dropped_events=int(outcome.get("dropped_events", 0)),
            kept_events=int(outcome.get("kept_events", 0)),
            processed_rows_pruned=int(outcome.get("processed_rows_pruned", 0)),
        )
        workflow.logger.info(
            "stream_raw_compact.done partitions=%d compacted=%d deleted=%d "
            "dropped_events=%d kept_events=%d",
            result.partition_count, result.compacted, result.deleted,
            result.dropped_events, result.kept_events,
        )
        return result
