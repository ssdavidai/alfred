"""Workflow 1: Event Processor — zero-LLM stream event processing.

All non-garbage stream events get:
1. A one-line stream log entry (pure Python, 0 LLM)
2. A structured vault event record (pure Python templates, 0 LLM)

System-inbox events (manual uploads) still route to the curator inbox.
Hourly batch enrichment adds entities/tags later via a single LLM call.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.noise import extract_log_line, is_tier3
    from src.activities.stream_log import append_to_stream_log
    from src.activities.stream_vault import create_stream_vault_record
    from src.activities.streams import (
        fetch_unprocessed_events,
        mark_event_processed,
    )
    from src.activities.vault import drop_raw_event_to_inbox


# Bounded retry so a 4xx (e.g. malformed event_id producing a 404) doesn't
# stick the activity in Temporal's default infinite-retry loop. Live
# evidence: Sir had an EventProcessorWorkflow run sit in attempt 4532
# on /streams/events//processed for 5 days before manual termination.
_MARK_RETRY = RetryPolicy(maximum_attempts=3)


@dataclass
class ProcessorResult:
    processed: int = 0
    paths: list[str] = field(default_factory=list)
    media_triggered: int = 0
    vault_records: int = 0
    tier3_discarded: int = 0
    inbox_routed: int = 0


@workflow.defn(name="EventProcessorWorkflow")
class EventProcessorWorkflow:
    @workflow.run
    async def run(self) -> ProcessorResult:
        # 1. Fetch unprocessed events from streams API (max 20 per run)
        events: list[dict[str, Any]] = await workflow.execute_activity(
            fetch_unprocessed_events,
            start_to_close_timeout=timedelta(seconds=30),
        )

        result = ProcessorResult()

        for event in events[:20]:
            # Skip events without an id. ctrl-api's mark-processed endpoint
            # is /streams/events/<id>/processed; an empty id produces
            # /streams/events//processed → 404, and Temporal's default
            # retry policy (no maximum_attempts) sticks the activity
            # forever. Better to skip and let it reappear next cycle than
            # to enter a 4532-attempt retry loop.
            event_id = event.get("id") or ""
            if not event_id:
                workflow.logger.warning(
                    "event_processor: skipping event with no id (stream_type=%s, source_ref=%s)",
                    event.get("stream_type"), event.get("source_ref"),
                )
                continue

            # Media streams still get routed to their dedicated workflow
            if event.get("stream_type") == "media":
                await workflow.execute_child_workflow(
                    "MediaIngestionWorkflow",
                    event,
                    id=f"media-{event_id[:16]}",
                )
                result.media_triggered += 1
                await workflow.execute_activity(
                    mark_event_processed,
                    args=[event_id, "media-ingestion", "media"],
                    start_to_close_timeout=timedelta(seconds=10),
                    retry_policy=_MARK_RETRY,
                )
                continue

            # Tier 3: discard (empty/meaningless)
            if is_tier3(event):
                await workflow.execute_activity(
                    mark_event_processed,
                    args=[event_id, "noise-discarded", "tier3"],
                    start_to_close_timeout=timedelta(seconds=10),
                    retry_policy=_MARK_RETRY,
                )
                result.tier3_discarded += 1
                continue

            # System-inbox (manual uploads) → existing curator path
            if event.get("stream_type") in ("system", "inbox-upload"):
                inbox_path: str = await workflow.execute_activity(
                    drop_raw_event_to_inbox,
                    args=[event],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                await workflow.execute_activity(
                    mark_event_processed,
                    args=[event_id, inbox_path, "tier1"],
                    start_to_close_timeout=timedelta(seconds=10),
                    retry_policy=_MARK_RETRY,
                )
                result.inbox_routed += 1
                result.paths.append(inbox_path)
                continue

            # --- Zero-LLM path for all other stream events ---

            # 1. Stream log entry (one line, pure Python)
            log_line = extract_log_line(event)
            await workflow.execute_activity(
                append_to_stream_log,
                args=[event.get("stream_type", "unknown"), log_line],
                start_to_close_timeout=timedelta(seconds=15),
            )

            # 2. Vault record (pure Python template, zero LLM)
            vault_path: str = await workflow.execute_activity(
                create_stream_vault_record,
                args=[event],
                start_to_close_timeout=timedelta(seconds=30),
            )

            # 3. Mark processed
            await workflow.execute_activity(
                mark_event_processed,
                args=[event_id, vault_path, "stream-vault"],
                start_to_close_timeout=timedelta(seconds=10),
                retry_policy=_MARK_RETRY,
            )

            result.vault_records += 1
            result.paths.append(vault_path)

        result.processed = len(result.paths)
        return result
