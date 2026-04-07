"""Workflow 1: Event Processor — reads unprocessed stream events, drops raw content to inbox.

Simplified flow (2026-04-07): fetch → drop raw to inbox → mark processed.
The curator's 4-stage pipeline handles all classification, entity resolution,
interlinking, and enrichment. No LLM calls happen here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
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

            # 2. Drop raw content to inbox as markdown — curator handles the rest
            inbox_path: str = await workflow.execute_activity(
                drop_raw_event_to_inbox,
                args=[event],
                start_to_close_timeout=timedelta(seconds=30),
            )

            # 3. Mark processed
            await workflow.execute_activity(
                mark_event_processed,
                args=[event.get("id", ""), inbox_path, event.get("stream_type", "")],
                start_to_close_timeout=timedelta(seconds=10),
            )

            results.append(inbox_path)

        return ProcessorResult(
            processed=len(results),
            paths=results,
            media_triggered=media_count,
        )
