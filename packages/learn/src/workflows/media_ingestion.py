"""Workflow 7: Media Ingestion — per-file processing for media uploads.

Triggered by EventProcessor when stream_type == "media".
1. Detect file type (Python — deterministic)
2. Call Clerk for transcription/OCR/description
3. Classify the extracted content
4. For braindumps → topic-splitting extraction
5. Write vault records
6. Extract entities
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
    from src.activities.clerk import (
        CLERK_ACTIVITY_HEARTBEAT_SECONDS,
        CLERK_ACTIVITY_TIMEOUT_SECONDS,
    )
    from src.activities.media import (
        detect_file_type,
        process_audio,
        process_document,
        process_image,
    )
    from src.activities.vault import ensure_entities_exist, write_vault_record
    from src.validators.frontmatter import validate_classification


# The clerk-backed activities in this workflow (process_audio/document/image,
# classify_event, extract_braindump) all block on ``_call_clerk`` (HTTP
# ``POST /v1/responses``) up to the 900s completion budget, so a sub-budget
# ``start_to_close`` would let Temporal kill + retry while the billable run
# continued server-side → double spend. They are scheduled below with
# ``start_to_close_timeout=CLERK_ACTIVITY_TIMEOUT_SECONDS`` and
# ``heartbeat_timeout=CLERK_ACTIVITY_HEARTBEAT_SECONDS`` — the shared clerk
# constants are the single source of truth (FAILURE-MODES Hermes runtime, S2).


@dataclass
class MediaResult:
    file_type: str = ""
    vault_paths: list[str] = field(default_factory=list)
    is_braindump: bool = False


@workflow.defn(name="MediaIngestionWorkflow")
class MediaIngestionWorkflow:
    @workflow.run
    async def run(self, event: dict[str, Any]) -> MediaResult:
        # 1. Detect file type (Python — deterministic)
        file_type: str = await workflow.execute_activity(
            detect_file_type,
            args=[event],
            start_to_close_timeout=timedelta(seconds=10),
        )

        # 2. Process based on type — call Clerk
        media_result: dict[str, Any] = {}
        if file_type == "audio":
            media_result = await workflow.execute_activity(
                process_audio,
                args=[event],
                start_to_close_timeout=timedelta(seconds=CLERK_ACTIVITY_TIMEOUT_SECONDS),
                heartbeat_timeout=timedelta(seconds=CLERK_ACTIVITY_HEARTBEAT_SECONDS),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        elif file_type == "document":
            media_result = await workflow.execute_activity(
                process_document,
                args=[event],
                start_to_close_timeout=timedelta(seconds=CLERK_ACTIVITY_TIMEOUT_SECONDS),
                heartbeat_timeout=timedelta(seconds=CLERK_ACTIVITY_HEARTBEAT_SECONDS),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        elif file_type == "image":
            media_result = await workflow.execute_activity(
                process_image,
                args=[event],
                start_to_close_timeout=timedelta(seconds=CLERK_ACTIVITY_TIMEOUT_SECONDS),
                heartbeat_timeout=timedelta(seconds=CLERK_ACTIVITY_HEARTBEAT_SECONDS),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        else:
            # Unknown type — write as note
            classification = {
                "type": "note",
                "title": f"Media file: {event.get('file_name', 'unknown')}",
                "summary": f"Uploaded media file of type: {file_type}",
                "entities": [],
                "action_items": [],
                "tags": ["media"],
            }
            path = await workflow.execute_activity(
                write_vault_record,
                args=[classification],
                start_to_close_timeout=timedelta(seconds=30),
            )
            return MediaResult(file_type=file_type, vault_paths=[path])

        # 3. Build an event-like dict from the Clerk result for classification
        extracted_text = media_result.get("extracted_text", "")
        synth_event = {
            "raw": {"content": extracted_text},
            "summary": media_result.get("summary", ""),
            "stream_type": f"media-{file_type}",
            "source_ref": event.get("file_path", ""),
        }

        metadata = await workflow.execute_activity(
            extract_metadata,
            args=[synth_event],
            start_to_close_timeout=timedelta(seconds=10),
        )

        classification = await workflow.execute_activity(
            classify_event,
            args=[synth_event, metadata],
            start_to_close_timeout=timedelta(seconds=CLERK_ACTIVITY_TIMEOUT_SECONDS),
            heartbeat_timeout=timedelta(seconds=CLERK_ACTIVITY_HEARTBEAT_SECONDS),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )

        # Merge entities from media processing
        existing_entities = classification.get("entities", [])
        media_entities = media_result.get("entities", [])
        all_entities = existing_entities + [e for e in media_entities if e not in existing_entities]
        classification["entities"] = all_entities

        # Merge tags
        existing_tags = classification.get("tags", [])
        media_tags = media_result.get("tags", [])
        classification["tags"] = list(set(existing_tags + media_tags))[:5]

        # 4. Check for braindump
        is_braindump = await workflow.execute_activity(
            detect_braindump,
            args=[synth_event, metadata],
            start_to_close_timeout=timedelta(seconds=10),
        )

        paths: list[str] = []

        if is_braindump or classification.get("type") == "braindump":
            braindump_results = await workflow.execute_activity(
                extract_braindump,
                args=[synth_event, metadata, classification],
                start_to_close_timeout=timedelta(seconds=CLERK_ACTIVITY_TIMEOUT_SECONDS),
                heartbeat_timeout=timedelta(seconds=CLERK_ACTIVITY_HEARTBEAT_SECONDS),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            for br in braindump_results:
                paths.append(br.get("path", ""))
        else:
            # 5. Write vault record
            validated = await workflow.execute_activity(
                validate_classification,
                args=[classification],
                start_to_close_timeout=timedelta(seconds=10),
            )
            if validated.valid:
                path = await workflow.execute_activity(
                    write_vault_record,
                    args=[classification],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                paths.append(path)

        # 6. Entity extraction
        if all_entities:
            await workflow.execute_activity(
                ensure_entities_exist,
                args=[all_entities],
                start_to_close_timeout=timedelta(seconds=30),
            )

        return MediaResult(
            file_type=file_type,
            vault_paths=paths,
            is_braindump=is_braindump,
        )
