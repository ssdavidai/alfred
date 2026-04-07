"""Workflow 1: Event Processor — reads unprocessed stream events, tiers them.

Three-tier flow:
- Tier 3: discard (empty/meaningless)
- Tier 2: quick-log to stream log (automated/low-value, no LLM)
- Tier 1: full processing (drop raw to inbox for curator's 4-stage pipeline)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from src.activities.classify import extract_metadata
    from src.activities.noise import extract_log_line, is_tier2, is_tier3
    from src.activities.stream_log import append_to_stream_log
    from src.activities.streams import (
        fetch_unprocessed_events,
        mark_event_processed,
    )
    from src.activities.vault import drop_raw_event_to_inbox


@dataclass
class ProcessorResult:
    processed: int = 0
    paths: list[str] = field(default_factory=list)
    media_triggered: int = 0
    tier2_logged: int = 0
    tier3_discarded: int = 0


@workflow.defn(name="EventProcessorWorkflow")
class EventProcessorWorkflow:
    @workflow.run
    async def run(self) -> ProcessorResult:
        # 1. Fetch unprocessed events from streams API (max 20 per run)
        events: list[dict[str, Any]] = await workflow.execute_activity(
            fetch_unprocessed_events,
            start_to_close_timeout=timedelta(seconds=30),
        )

        results: list[str] = []
        media_count = 0
        tier2_count = 0
        tier3_count = 0

        for event in events[:20]:
            # Media streams still get routed to their dedicated workflow
            if event.get("stream_type") == "media":
                await workflow.execute_child_workflow(
                    "MediaIngestionWorkflow",
                    event,
                    id=f"media-{event.get('id', '')[:16]}",
                )
                media_count += 1
                await workflow.execute_activity(
                    mark_event_processed,
                    args=[event.get("id", ""), "media-ingestion", "media"],
                    start_to_close_timeout=timedelta(seconds=10),
                )
                continue

            # Tier 3: discard (empty/meaningless)
            if is_tier3(event):
                await workflow.execute_activity(
                    mark_event_processed,
                    args=[event.get("id", ""), "noise-discarded", "tier3"],
                    start_to_close_timeout=timedelta(seconds=10),
                )
                tier3_count += 1
                continue

            # Extract metadata for tiering decision
            metadata: dict[str, Any] = await workflow.execute_activity(
                extract_metadata,
                args=[event],
                start_to_close_timeout=timedelta(seconds=15),
            )

            # Tier 2: quick log (no LLM, no inbox)
            if is_tier2(event, metadata):
                log_line = extract_log_line(event)
                await workflow.execute_activity(
                    append_to_stream_log,
                    args=[event.get("stream_type", "unknown"), log_line],
                    start_to_close_timeout=timedelta(seconds=15),
                )
                await workflow.execute_activity(
                    mark_event_processed,
                    args=[event.get("id", ""), "stream-log", "tier2"],
                    start_to_close_timeout=timedelta(seconds=10),
                )
                tier2_count += 1
                continue

            # Tier 1: full processing — drop raw to inbox for curator
            inbox_path: str = await workflow.execute_activity(
                drop_raw_event_to_inbox,
                args=[event],
                start_to_close_timeout=timedelta(seconds=30),
            )

            await workflow.execute_activity(
                mark_event_processed,
                args=[event.get("id", ""), inbox_path, "tier1"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            results.append(inbox_path)

        return ProcessorResult(
            processed=len(results),
            paths=results,
            media_triggered=media_count,
            tier2_logged=tier2_count,
            tier3_discarded=tier3_count,
        )
