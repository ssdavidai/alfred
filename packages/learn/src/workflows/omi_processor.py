"""Workflow: Omi Audio Processor — scan, group, transcribe, and ingest Omi audio chunks.

Runs every 10 minutes via Temporal schedule. Scans the audio buffer directory for
unprocessed PCM files, groups them by time proximity into conversations, transcribes
each group via Groq Whisper API, and ingests the transcription as a stream event.

Caps at 5 groups per run to keep workflows short-lived and resilient to worker restarts.
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

        # 1. Scan audio buffer for unprocessed PCM files.
        # 5-min budget because scan_audio_buffer reads every .pcm file's
        # bytes for VAD silence check (`_has_speech`) — at OMI_SCAN_MAX=500
        # default that's ~85MB of reads. The activity itself caps the
        # file count, so this timeout is just defense; real-world scans
        # complete in ~10-30s even on a slow disk.
        files: list[dict[str, Any]] = await workflow.execute_activity(
            scan_audio_buffer,
            start_to_close_timeout=timedelta(minutes=5),
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

        # 3. Transcribe each group and ingest (cap at 5 per run to stay short-lived)
        max_groups = min(len(groups), 5)
        if len(groups) > max_groups:
            workflow.logger.info(
                "[omi] Capping to %d of %d groups this run", max_groups, len(groups)
            )

        for group in groups[:max_groups]:
            try:
                # Transcribe via Groq Whisper API (~3s per group)
                transcription: dict[str, Any] = await workflow.execute_activity(
                    transcribe_audio_group,
                    args=[group],
                    start_to_close_timeout=timedelta(seconds=90),
                    retry_policy=RetryPolicy(maximum_attempts=3),
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
