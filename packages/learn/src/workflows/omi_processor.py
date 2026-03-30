"""Workflow: Omi Audio Processor — scan, group, transcribe, and ingest Omi audio chunks.

Runs every 2 minutes via Temporal schedule. Scans the audio buffer directory for
unprocessed PCM files, groups them by time proximity into conversations, transcribes
each group via OpenAI Whisper API, and ingests the transcription as a stream event.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.omi_audio import (
        group_audio_segments,
        ingest_omi_transcription,
        scan_audio_buffer,
        transcribe_audio_group,
    )


@dataclass
class OmiProcessorResult:
    files_scanned: int = 0
    groups_found: int = 0
    groups_transcribed: int = 0
    events_ingested: int = 0
    errors: list[str] = field(default_factory=list)


@workflow.defn(name="OmiAudioProcessorWorkflow")
class OmiAudioProcessorWorkflow:
    @workflow.run
    async def run(self) -> OmiProcessorResult:
        result = OmiProcessorResult()

        # 1. Scan audio buffer for unprocessed PCM files
        files: list[dict[str, Any]] = await workflow.execute_activity(
            scan_audio_buffer,
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        result.files_scanned = len(files)

        if not files:
            return result

        # 2. Group audio segments by uid + time proximity
        groups: list[list[dict[str, Any]]] = await workflow.execute_activity(
            group_audio_segments,
            args=[files],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        result.groups_found = len(groups)

        if not groups:
            return result

        # 3. Transcribe each group and ingest
        for group in groups:
            try:
                # Transcribe via Whisper API
                transcription: dict[str, Any] = await workflow.execute_activity(
                    transcribe_audio_group,
                    args=[group],
                    start_to_close_timeout=timedelta(minutes=30),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                result.groups_transcribed += 1

                # Determine stream_id from the group metadata
                stream_id = group[0].get("stream_id", "")
                if not stream_id:
                    result.errors.append(
                        f"No stream_id for group uid={group[0].get('uid', '?')}"
                    )
                    continue

                # Ingest transcription as stream event
                event_id: str = await workflow.execute_activity(
                    ingest_omi_transcription,
                    args=[stream_id, transcription, group],
                    start_to_close_timeout=timedelta(seconds=60),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )

                if event_id:
                    result.events_ingested += 1

            except Exception as exc:
                error_msg = f"Group transcription/ingest failed: {exc}"
                result.errors.append(error_msg)
                workflow.logger.error("[omi] %s", error_msg)

        return result
