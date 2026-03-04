"""Workflow 1: Event Processor — reads unprocessed stream events, classifies, writes vault records.

Enhancements:
- Detects stream_type=='media' and triggers MediaIngestionWorkflow
- Detects braindumps and triggers deep extraction
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.braindump import detect_braindump, extract_braindump
    from src.activities.classify import classify_event, extract_metadata
    from src.activities.judge import attempt_judgment
    from src.activities.streams import (
        fetch_unprocessed_events,
        mark_event_processed,
        quarantine_event,
    )
    from src.activities.vault import ensure_entities_exist, write_vault_record
    from src.validators.frontmatter import validate_classification


@dataclass
class ProcessorResult:
    processed: int = 0
    paths: list[str] = field(default_factory=list)
    media_triggered: int = 0
    braindumps_extracted: int = 0


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
        braindump_count = 0

        for event in events[:20]:
            # Check for media stream — trigger MediaIngestionWorkflow
            if event.get("stream_type") == "media":
                await workflow.execute_child_workflow(
                    "MediaIngestionWorkflow",
                    event,
                    id=f"media-{event.get('id', '')[:16]}",
                )
                media_count += 1
                # Mark as processed
                await workflow.execute_activity(
                    mark_event_processed,
                    args=[event.get("id", ""), f"media-ingestion", "media"],
                    start_to_close_timeout=timedelta(seconds=10),
                )
                continue

            # 2. Extract metadata (Python — deterministic)
            metadata = await workflow.execute_activity(
                extract_metadata,
                args=[event],
                start_to_close_timeout=timedelta(seconds=10),
            )

            # 3. Classify via Clerk (LLM — creative)
            classification = await workflow.execute_activity(
                classify_event,
                args=[event, metadata],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            # 4. Validate (Python — structural)
            validated = await workflow.execute_activity(
                validate_classification,
                args=[classification],
                start_to_close_timeout=timedelta(seconds=10),
            )

            if not validated.valid:
                # Quarantine on validation failure
                await workflow.execute_activity(
                    quarantine_event,
                    args=[event, validated.errors],
                    start_to_close_timeout=timedelta(seconds=10),
                )
                continue

            # 4b. Check for braindump — deep extraction
            is_braindump = await workflow.execute_activity(
                detect_braindump,
                args=[event, metadata],
                start_to_close_timeout=timedelta(seconds=10),
            )

            if is_braindump or classification.get("type") == "braindump":
                braindump_results = await workflow.execute_activity(
                    extract_braindump,
                    args=[event, metadata, classification],
                    start_to_close_timeout=timedelta(seconds=120),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                braindump_count += 1
                for br in braindump_results:
                    results.append(br.get("path", ""))

                # Mark processed
                await workflow.execute_activity(
                    mark_event_processed,
                    args=[event.get("id", ""), "braindump-extraction", "braindump"],
                    start_to_close_timeout=timedelta(seconds=10),
                )
                continue

            # 5. Write to vault
            vault_path: str = await workflow.execute_activity(
                write_vault_record,
                args=[classification],
                start_to_close_timeout=timedelta(seconds=30),
            )

            # 6. Mark processed
            await workflow.execute_activity(
                mark_event_processed,
                args=[event.get("id", ""), vault_path, classification.get("type", "")],
                start_to_close_timeout=timedelta(seconds=10),
            )

            # 7. Entity extraction — ensure person/org records exist
            entities = classification.get("entities", [])
            if entities:
                await workflow.execute_activity(
                    ensure_entities_exist,
                    args=[entities],
                    start_to_close_timeout=timedelta(seconds=30),
                )

            # 8. Attempt judgment (router) if instincts exist
            await workflow.execute_activity(
                attempt_judgment,
                args=[event, metadata, classification],
                start_to_close_timeout=timedelta(seconds=30),
            )

            results.append(vault_path)

        return ProcessorResult(
            processed=len(results),
            paths=results,
            media_triggered=media_count,
            braindumps_extracted=braindump_count,
        )
