"""MeetingCaptureWorkflow — gcal-driven Vexa bot dispatch (#840 Phase 4).

Runs every 60 seconds. Reads the gcal stream JSONL for events in the
next 90 seconds where Sir is an attendee + a Google Meet URL is
detected, and asks Vexa to dispatch its transcription bot.

Idempotency story:

  1. The activity ``find_upcoming_meet_events`` returns the meeting
     details extracted from the gcal stream.
  2. ``vexa_join_meeting`` writes ``state/steward/meeting-schedules.json``
     with one entry per ``(platform, meeting_id)`` pair that's already
     been dispatched. Re-dispatch within the same 90s window short-
     circuits via this state.
  3. Vexa itself idempotently handles duplicate ``POST /bots`` calls —
     re-requesting an active meeting returns the existing record
     instead of spawning a duplicate bot.

The 90s lookahead deliberately overlaps the 60s tick: a meeting starting
in 80 seconds gets dispatched on this tick (and the local state file
suppresses the next tick from re-dispatching). 90 > 60 ensures we never
miss a meeting just because its start lands between tick boundaries.

Feature-gated by ``VEXA_ENABLED`` (default off — david-only flag for
Phase 4). The workflow short-circuits immediately when disabled so
tenants without Vexa never pay activity cost.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.transcript import (
        find_upcoming_meet_events,
        vexa_join_meeting,
    )


# Lookahead window, in seconds. The workflow ticks every 60s. 600s
# (10 min) gives the bot a comfortable buffer for an ad-hoc meeting
# scheduled with little notice, while the activity dedupes by gcal id so
# the same meeting isn't dispatched twice across multiple ticks.
LOOKAHEAD_SECONDS = 600

# Late-join window: how far past a meeting's start time we'll still
# dispatch the bot. Useful when the gcal stream lags (Composio polls
# on a ~60s schedule) and an ad-hoc meeting created right before its
# start only shows up in our stream after it's already begun. 1800s
# (30 min) covers the long tail: a meeting Sir joins late, an event
# created seconds before start, or a Composio backend delay.
LATENESS_SECONDS = 1800


@dataclass
class MeetingCaptureResult:
    started: bool = False
    candidates: int = 0
    dispatched: int = 0
    skipped_already: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)
    skipped_reason: str = ""


@workflow.defn(name="MeetingCaptureWorkflow")
class MeetingCaptureWorkflow:
    """Calendar → Vexa bot dispatch. Schedule: every 60 seconds.

    Phase 4 (#840). Sir only initially — gated on ``VEXA_ENABLED``.
    """

    @workflow.run
    async def run(self) -> MeetingCaptureResult:
        workflow.logger.info("meeting_capture.start")
        result = MeetingCaptureResult()

        # Activities can't read env directly inside workflows (non-
        # determinism), so the gate is a tiny env-read activity. We
        # piggy-back on ``find_upcoming_meet_events`` returning [] in the
        # disabled case — but we want a cheap up-front gate for the
        # logging story, so check the flag in a 1-line nested activity.
        # Workflow-level env access is allowed via os.environ ONLY on
        # workflow start (replay-safe because the outer schedule decides
        # when the workflow runs). To stay strictly within Temporal
        # determinism rules we DO NOT read env here directly — instead
        # the worker sees the schedule fire at all only when the env
        # gate is true (the schedule is created by register_schedules
        # which checks the flag). The workflow itself is always-runnable
        # but no-ops cleanly when no upcoming meetings exist.

        retry = RetryPolicy(
            maximum_attempts=3,
            initial_interval=timedelta(seconds=1),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=15),
        )

        # 1. Find upcoming Meet events.
        try:
            events: list[dict[str, Any]] = await workflow.execute_activity(
                find_upcoming_meet_events,
                args=[LOOKAHEAD_SECONDS, "", LATENESS_SECONDS],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            result.errors += 1
            result.error_messages.append(f"find_upcoming_meet_events: {exc}"[:500])
            workflow.logger.warning(
                "meeting_capture.find_failed err=%s", exc,
            )
            return result

        result.started = True
        result.candidates = len(events)
        if not events:
            workflow.logger.info("meeting_capture.no_events lookahead=%ds", LOOKAHEAD_SECONDS)
            return result

        # 2. Dispatch each meeting through Vexa. Per-event try/except so
        #    one malformed event doesn't block the rest of the tick.
        for evt in events:
            meeting_id = str(evt.get("native_meeting_id") or "").strip()
            meet_url = str(evt.get("meet_url") or "").strip()
            scheduled_start = str(evt.get("scheduled_start") or "").strip()
            if not meeting_id or not meet_url:
                workflow.logger.info(
                    "meeting_capture.skip_malformed gcal=%s",
                    evt.get("gcal_event_id"),
                )
                continue

            try:
                outcome: dict[str, Any] = await workflow.execute_activity(
                    vexa_join_meeting,
                    args=[meeting_id, meet_url, scheduled_start],
                    start_to_close_timeout=timedelta(seconds=60),
                    retry_policy=retry,
                )
            except Exception as exc:  # noqa: BLE001
                result.errors += 1
                result.error_messages.append(
                    f"vexa_join_meeting meeting={meeting_id}: {exc}"[:500]
                )
                workflow.logger.warning(
                    "meeting_capture.dispatch_failed meeting=%s err=%s",
                    meeting_id, exc,
                )
                continue

            if outcome.get("skipped"):
                result.skipped_already += 1
            else:
                result.dispatched += 1

        workflow.logger.info(
            "meeting_capture.done candidates=%d dispatched=%d skipped=%d errors=%d",
            result.candidates,
            result.dispatched,
            result.skipped_already,
            result.errors,
        )
        return result
