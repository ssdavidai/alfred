"""StreamEventPurgeWorkflow — daily purge of post-extraction stream events.

Phase 6.6 retention policy (RFC #842 §6.6):

  * ``vault/stream_event/`` records are EPHEMERAL. Their job is to
    feed the signal extractor; once extraction succeeds the relevant
    ``raw_quote`` is preserved on the resulting ``signal/`` record.
    The stream-event itself is then redundant after a 7-day grace
    window (kept around for human inspection during incident
    triage).

  * Records under ``event/`` and ``conversation/`` are NOT purged by
    this workflow. The migrator (T6.6.1) is responsible for
    relocating any stragglers; if a record is still under those
    paths post-migration it's the operator's call to keep it.

  * Signal records (``signal/*.md``) are NEVER purged. They are the
    permanent audit trail for the routing decision.

The purge runs daily at 03:00 UTC, gated on
``STEWARD_STREAM_EVENT_PURGE_ENABLED=true``. The schedule is
registered by ``scripts/register_schedules.py``; the env-flag check
runs at registration time only. Once enabled, the workflow ticks
unconditionally — re-checking the env inside ``@workflow.run`` would
violate Temporal determinism rules.

Per-record contract:

  1. List ``stream_event/*.md`` via ctrl-api.
  2. For each record where ``frontmatter.signal_extracted_at`` is
     set AND ``frontmatter.created`` is older than 7 days:
       - DELETE the record via ctrl-api.
  3. Per-record try/except — one corrupted record does not stall
     the whole purge.

Output: a ``PurgeResult`` carrying counts (listed / purged / kept /
errors). Surfaced in the Temporal UI for visibility.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.maintenance import purge_old_stream_events


@dataclass
class PurgeResult:
    """Per-tick outcome — surfaced in Temporal UI."""

    listed: int = 0
    purged: int = 0
    kept: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)


@workflow.defn(name="StreamEventPurgeWorkflow")
class StreamEventPurgeWorkflow:
    """Daily purge of post-extraction stream-event records.

    Schedule: daily at 03:00 UTC via ``al-stream-event-purge``. Gated
    on ``STEWARD_STREAM_EVENT_PURGE_ENABLED`` at registration time.
    The activity itself does the actual deletion and counting.
    """

    @workflow.run
    async def run(self) -> PurgeResult:
        workflow.logger.info("stream_event_purge.start")

        retry = RetryPolicy(
            maximum_attempts=2,
            initial_interval=timedelta(seconds=5),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=30),
        )

        try:
            outcome: dict[str, Any] = await workflow.execute_activity(
                purge_old_stream_events,
                # 5 min envelope for david's ~10K stream-event vault.
                # The activity reads frontmatter for each record but
                # uses ctrl-api list (preview=0) so the per-record cost
                # is small. Headroom for 5x growth.
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            workflow.logger.warning(
                "stream_event_purge.failed err=%s", exc,
            )
            return PurgeResult(
                errors=1,
                error_messages=[f"purge_old_stream_events: {exc}"[:500]],
            )

        result = PurgeResult(
            listed=int(outcome.get("listed", 0)),
            purged=int(outcome.get("purged", 0)),
            kept=int(outcome.get("kept", 0)),
            errors=int(outcome.get("errors", 0)),
            error_messages=list(outcome.get("error_messages", []))[:10],
        )
        workflow.logger.info(
            "stream_event_purge.done listed=%d purged=%d kept=%d errors=%d",
            result.listed, result.purged, result.kept, result.errors,
        )
        return result
