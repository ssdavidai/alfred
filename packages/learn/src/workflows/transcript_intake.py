"""TranscriptIntakeWorkflow — post-meeting transcript → Steward signals (#840 Phase 4).

Runs every 60 seconds. Reads ``streams/vexa-transcripts.jsonl`` for
``meeting.completed`` events that haven't been processed yet, fetches
the transcript via Vexa's ``GET /transcripts/...`` API, runs the LLM
extractor, and emits one Steward signal per candidate action.

This workflow is intentionally separate from ``MeetingCaptureWorkflow``:

  * MeetingCapture is calendar-driven (gcal stream → bot dispatch).
  * TranscriptIntake is webhook-driven (Vexa post-meeting webhook →
    transcript stream → action extraction).

Both polling intervals are 60s to keep the activity surface small and
the timing forgiving. A meeting that ends at minute 0 has its actions
landing in Steward by minute 1 — fast enough for the daily digest cycle
without spamming the Clerk.

NO direct Plane writes happen here. Per the Phase 3 / Phase 4 contract
(RFC #832 §8 + #839 / #840), this workflow only emits
``transcript:action_candidate`` records into ``streams/steward-signals.jsonl``.
Phase 3's ``apply_state_change`` (when it goes live) consumes those
signals and applies the actions through the same audit/undo path as
every other Steward decision.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.transcript import (
        apply_transcript_action,
        extract_actions_from_transcript,
        list_unprocessed_transcript_events,
        mark_transcript_event_processed,
        vexa_get_transcript,
    )


@dataclass
class TranscriptIntakeResult:
    started: bool = False
    transcripts_fetched: int = 0
    actions_extracted: int = 0
    signals_emitted: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)


@workflow.defn(name="TranscriptIntakeWorkflow")
class TranscriptIntakeWorkflow:
    """Vexa transcript stream → Steward action-candidate signals.

    Schedule: every 60 seconds. Phase 4 (#840). David-only via
    ``VEXA_ENABLED`` registration-time gate.
    """

    @workflow.run
    async def run(self) -> TranscriptIntakeResult:
        workflow.logger.info("transcript_intake.start")
        result = TranscriptIntakeResult()
        result.started = True

        retry = RetryPolicy(
            maximum_attempts=3,
            initial_interval=timedelta(seconds=1),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=15),
        )

        # 1. List unprocessed transcript-completion events from the stream.
        try:
            unprocessed: list[dict[str, Any]] = await workflow.execute_activity(
                list_unprocessed_transcript_events,
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            result.errors += 1
            result.error_messages.append(f"list_unprocessed: {exc}"[:500])
            workflow.logger.warning("transcript_intake.list_failed err=%s", exc)
            return result

        if not unprocessed:
            workflow.logger.info("transcript_intake.no_events")
            return result

        # 2. For each unprocessed event, fetch the full transcript +
        #    extract actions + emit signals + mark processed.
        for evt in unprocessed:
            event_id = str(evt.get("id") or "")
            platform = str(evt.get("platform") or "google_meet")
            meeting_id = str(evt.get("meeting_id") or "")
            if not event_id or not meeting_id:
                workflow.logger.info(
                    "transcript_intake.skip_malformed event_id=%s meeting=%s",
                    event_id, meeting_id,
                )
                # Mark processed so we don't loop forever on a malformed
                # webhook payload.
                if event_id:
                    try:
                        await workflow.execute_activity(
                            mark_transcript_event_processed,
                            args=[event_id],
                            start_to_close_timeout=timedelta(seconds=10),
                            retry_policy=retry,
                        )
                    except Exception:  # noqa: BLE001
                        pass
                continue

            # 2a. Fetch the transcript. Some webhook payloads embed it;
            #     check raw.transcript first to avoid a round-trip.
            raw = evt.get("raw") if isinstance(evt.get("raw"), dict) else {}
            embedded_transcript = None
            data = raw.get("data") if isinstance(raw, dict) else None
            if isinstance(data, dict):
                t = data.get("transcript")
                if isinstance(t, dict) and isinstance(t.get("segments"), list):
                    embedded_transcript = t

            transcript: dict[str, Any]
            if embedded_transcript is not None:
                # Normalise the embedded shape into the same envelope
                # vexa_get_transcript returns so the rest of the loop
                # is shape-agnostic. Build a flat_text rendering on the
                # fly; segments are the same shape Vexa puts on disk.
                segments_in = embedded_transcript["segments"]
                speakers_set: set[str] = set()
                duration = 0.0
                norm: list[dict[str, Any]] = []
                for seg in segments_in:
                    if not isinstance(seg, dict):
                        continue
                    speaker = str(seg.get("speaker") or "Unknown").strip() or "Unknown"
                    text = str(seg.get("text") or "").strip()
                    try:
                        start = float(
                            seg.get("start_time", seg.get("start") or 0.0) or 0.0
                        )
                    except (TypeError, ValueError):
                        start = 0.0
                    try:
                        end = float(
                            seg.get("end_time", seg.get("end") or 0.0) or 0.0
                        )
                    except (TypeError, ValueError):
                        end = 0.0
                    if end > duration:
                        duration = end
                    speakers_set.add(speaker)
                    norm.append({
                        "speaker": speaker,
                        "text": text,
                        "start": start,
                        "end": end,
                    })
                flat_lines = [f'{s["speaker"]}: {s["text"]}' for s in norm if s["text"]]
                transcript = {
                    "platform": platform,
                    "native_meeting_id": meeting_id,
                    "segments": norm,
                    "speakers": sorted(speakers_set),
                    "duration_seconds": duration,
                    "flat_text": "\n".join(flat_lines),
                    "raw": embedded_transcript,
                }
            else:
                try:
                    transcript = await workflow.execute_activity(
                        vexa_get_transcript,
                        args=[platform, meeting_id],
                        start_to_close_timeout=timedelta(seconds=120),
                        retry_policy=retry,
                    )
                except Exception as exc:  # noqa: BLE001
                    result.errors += 1
                    result.error_messages.append(
                        f"vexa_get_transcript meeting={meeting_id}: {exc}"[:500]
                    )
                    workflow.logger.warning(
                        "transcript_intake.fetch_failed meeting=%s err=%s",
                        meeting_id, exc,
                    )
                    # Don't mark processed — next tick retries (Vexa
                    # may still be assembling the final transcript).
                    continue

            result.transcripts_fetched += 1

            flat_text = str(transcript.get("flat_text") or "")
            speakers = transcript.get("speakers") or []
            if not isinstance(speakers, list):
                speakers = []
            attendees: list[str] = []
            # Try to extract attendee emails from the webhook payload's
            # nested meeting / gcal hints; fall back to speaker labels
            # from the transcript itself when nothing else is available.
            meeting_block = (
                data.get("meeting") if isinstance(data, dict) else None
            )
            if isinstance(meeting_block, dict):
                m_data = meeting_block.get("data") if isinstance(meeting_block.get("data"), dict) else {}
                if isinstance(m_data, dict):
                    cal_attendees = m_data.get("calendar_attendees") or m_data.get("attendees")
                    if isinstance(cal_attendees, list):
                        for a in cal_attendees:
                            if isinstance(a, str):
                                attendees.append(a)
                            elif isinstance(a, dict) and isinstance(a.get("email"), str):
                                attendees.append(a["email"])
            if not attendees:
                attendees = list(speakers)

            # Reconstruct a minimal gcal_event-like envelope for the
            # extractor's prompt (it only reads summary, description,
            # start, attendees). The Vexa webhook doesn't carry the
            # original gcal payload, so we synthesise from what we have.
            gcal_event: dict[str, Any] = {}
            if isinstance(meeting_block, dict):
                m_data = meeting_block.get("data") if isinstance(meeting_block.get("data"), dict) else {}
                gcal_event = {
                    "summary": m_data.get("title") or m_data.get("summary") or meeting_block.get("native_meeting_id") or "",
                    "description": m_data.get("description") or "",
                    "start": {
                        "dateTime": meeting_block.get("start_time") or m_data.get("start_time") or "",
                    },
                    "attendees": [{"email": a} for a in attendees],
                }
            else:
                gcal_event = {
                    "summary": f"Meeting {platform}:{meeting_id}",
                    "description": "",
                    "start": {},
                    "attendees": [{"email": a} for a in attendees],
                }

            # 2b. Extract actions via Clerk LLM. Empty result is a valid
            #     outcome — many transcripts produce no actionable items.
            try:
                actions: list[dict[str, Any]] = await workflow.execute_activity(
                    extract_actions_from_transcript,
                    args=[flat_text, attendees, gcal_event],
                    # 6 minutes — Clerk polling has a 580s ceiling +
                    # buffer; matches the upper bound used elsewhere
                    # for clerk-backed activities.
                    start_to_close_timeout=timedelta(minutes=10),
                    retry_policy=RetryPolicy(maximum_attempts=1),
                )
            except Exception as exc:  # noqa: BLE001
                result.errors += 1
                result.error_messages.append(
                    f"extract_actions meeting={meeting_id}: {exc}"[:500]
                )
                workflow.logger.warning(
                    "transcript_intake.extract_failed meeting=%s err=%s",
                    meeting_id, exc,
                )
                # Mark processed so we don't loop on a clerk failure —
                # the audit record still exists in the transcript stream.
                try:
                    await workflow.execute_activity(
                        mark_transcript_event_processed,
                        args=[event_id],
                        start_to_close_timeout=timedelta(seconds=10),
                        retry_policy=retry,
                    )
                except Exception:  # noqa: BLE001
                    pass
                continue

            result.actions_extracted += len(actions)
            workflow.logger.info(
                "transcript_intake.extracted meeting=%s actions=%d duration=%.1fs",
                meeting_id, len(actions), float(transcript.get("duration_seconds") or 0.0),
            )

            # 2c. Emit one Steward signal per action.
            meeting_metadata = {
                "platform": platform,
                "native_meeting_id": meeting_id,
                "gcal_event_id": "",  # not in vexa webhook — Phase 5 cross-reference
                "scheduled_start": str(
                    (meeting_block or {}).get("start_time")
                    if isinstance(meeting_block, dict)
                    else ""
                ),
                "attendees": attendees,
                "vexa_meeting_id": (meeting_block or {}).get("id")
                if isinstance(meeting_block, dict)
                else "",
            }

            for action in actions:
                try:
                    await workflow.execute_activity(
                        apply_transcript_action,
                        args=[action, meeting_metadata],
                        start_to_close_timeout=timedelta(seconds=20),
                        retry_policy=retry,
                    )
                    result.signals_emitted += 1
                except Exception as exc:  # noqa: BLE001
                    result.errors += 1
                    result.error_messages.append(
                        f"apply_transcript_action meeting={meeting_id}: {exc}"[:500]
                    )
                    workflow.logger.warning(
                        "transcript_intake.signal_emit_failed meeting=%s err=%s",
                        meeting_id, exc,
                    )

            # 2d. Mark this transcript event processed so the next tick
            #     doesn't re-process it. We mark even when 0 actions
            #     were emitted — empty extraction is a valid terminal
            #     state.
            try:
                await workflow.execute_activity(
                    mark_transcript_event_processed,
                    args=[event_id],
                    start_to_close_timeout=timedelta(seconds=10),
                    retry_policy=retry,
                )
            except Exception as exc:  # noqa: BLE001
                # If we can't write the cursor, the transcript will
                # re-process next tick (re-emitting duplicate signals).
                # That's a tolerable degradation — Steward's signal
                # consumer dedupes by signal id.
                workflow.logger.warning(
                    "transcript_intake.mark_processed_failed event=%s err=%s",
                    event_id, exc,
                )

        workflow.logger.info(
            "transcript_intake.done transcripts=%d actions=%d signals=%d errors=%d",
            result.transcripts_fetched,
            result.actions_extracted,
            result.signals_emitted,
            result.errors,
        )
        return result
