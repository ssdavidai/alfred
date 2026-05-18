"""Workflow 2: Session Tracker — rolling 5-minute state machine.

Flow every 5 minutes:
1. Check: any new vault records in the last 5 minutes?
   NO → Mark current session as IDLE
        If idle for >30 min → close session (status: "paused")
        If idle for >2h → close session (status: "finished")
   YES →
2. Is there a current open session?
   NO → Create new session. Assign new records to it.
   YES →
3. Load current session summary + new records.
   Ask Clerk: "Is this new activity about the same topic as the current session?"
   SAME TOPIC → Append records to current session. Update last_activity + topic_summary.
   DIFFERENT TOPIC →
     a. Close current session (Clerk matches to vault context, writes summary)
     b. Create new session with the new records
     c. Update session state file
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.clerk import clerk_compare_topics, clerk_match_session_context
    from src.activities.session import (
        read_session_state,
        write_session_state,
        fetch_recent_records,
        close_session,
        create_session,
        append_to_session,
    )


@dataclass
class SessionResult:
    sessions_created: int = 0
    sessions_closed: int = 0


@workflow.defn(name="SessionTrackerWorkflow")
class SessionTrackerWorkflow:
    @workflow.run
    async def run(self) -> SessionResult:
        created = 0
        closed = 0

        # 1. Read current session state
        state: dict[str, Any] = await workflow.execute_activity(
            read_session_state,
            start_to_close_timeout=timedelta(seconds=10),
        )

        current_session = state.get("current_session")

        # 2. Check for new vault records in the last 5 minutes
        recent: list[dict[str, Any]] = await workflow.execute_activity(
            fetch_recent_records,
            args=[5],  # last 5 minutes
            start_to_close_timeout=timedelta(seconds=30),
        )

        if not recent:
            # No activity — handle idle
            if current_session:
                last_activity = current_session.get("last_activity", "")
                idle_minutes = current_session.get("idle_minutes", 0) + 5

                if idle_minutes >= 120:
                    # >2h idle → close as finished
                    close_result = await workflow.execute_activity(
                        close_session,
                        args=[current_session, "finished"],
                        start_to_close_timeout=timedelta(seconds=60),
                    )
                    await workflow.execute_activity(
                        write_session_state,
                        args=[{}],
                        start_to_close_timeout=timedelta(seconds=10),
                    )
                    closed += 1
                elif idle_minutes >= 30:
                    # >30min idle → close as paused
                    close_result = await workflow.execute_activity(
                        close_session,
                        args=[current_session, "paused"],
                        start_to_close_timeout=timedelta(seconds=60),
                    )
                    await workflow.execute_activity(
                        write_session_state,
                        args=[{}],
                        start_to_close_timeout=timedelta(seconds=10),
                    )
                    closed += 1
                else:
                    # Still within idle tolerance — update idle counter
                    current_session["idle_minutes"] = idle_minutes
                    await workflow.execute_activity(
                        write_session_state,
                        args=[{"current_session": current_session}],
                        start_to_close_timeout=timedelta(seconds=10),
                    )

            return SessionResult(sessions_created=created, sessions_closed=closed)

        # Has new records
        if not current_session:
            # No open session → create new one
            new_session = await workflow.execute_activity(
                create_session,
                args=[recent],
                start_to_close_timeout=timedelta(seconds=30),
            )
            await workflow.execute_activity(
                write_session_state,
                args=[{"current_session": new_session}],
                start_to_close_timeout=timedelta(seconds=10),
            )
            created += 1
        else:
            # Open session exists — check time gap before deciding
            last_activity_str = current_session.get("last_activity", "")
            newest_record_ts = recent[-1].get("timestamp", "") if recent else ""

            # Parse timestamps (handle "Z" suffix)
            gap_minutes = None
            if last_activity_str and newest_record_ts:
                last_ts = datetime.fromisoformat(
                    last_activity_str.replace("Z", "+00:00")
                )
                newest_ts = datetime.fromisoformat(
                    newest_record_ts.replace("Z", "+00:00")
                )
                gap_minutes = (newest_ts - last_ts).total_seconds() / 60

            if gap_minutes is not None and gap_minutes < 30:
                # <30 min gap — deterministic: same session, no Clerk call
                updated_session = await workflow.execute_activity(
                    append_to_session,
                    args=[current_session, recent, current_session.get("topic_summary", "")],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                await workflow.execute_activity(
                    write_session_state,
                    args=[{"current_session": updated_session}],
                    start_to_close_timeout=timedelta(seconds=10),
                )
            elif gap_minutes is not None and gap_minutes > 120:
                # >2 hr gap — deterministic: different session, no Clerk call
                await workflow.execute_activity(
                    close_session,
                    args=[current_session, "finished"],
                    start_to_close_timeout=timedelta(seconds=60),
                )
                closed += 1

                new_session = await workflow.execute_activity(
                    create_session,
                    args=[recent],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                await workflow.execute_activity(
                    write_session_state,
                    args=[{"current_session": new_session}],
                    start_to_close_timeout=timedelta(seconds=10),
                )
                created += 1
            else:
                # 30-120 min gap (or unknown) — ask Clerk to decide
                topic_decision = await workflow.execute_activity(
                    clerk_compare_topics,
                    args=[
                        current_session.get("topic_summary", ""),
                        recent,
                    ],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )

                if topic_decision.get("same_topic", False):
                    # Same topic — append records
                    updated_session = await workflow.execute_activity(
                        append_to_session,
                        args=[current_session, recent, topic_decision.get("suggested_topic_summary", "")],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                    await workflow.execute_activity(
                        write_session_state,
                        args=[{"current_session": updated_session}],
                        start_to_close_timeout=timedelta(seconds=10),
                    )
                else:
                    # Different topic — close current, create new
                    await workflow.execute_activity(
                        close_session,
                        args=[current_session, "paused"],
                        start_to_close_timeout=timedelta(seconds=60),
                    )
                    closed += 1

                    new_session = await workflow.execute_activity(
                        create_session,
                        args=[recent],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                    await workflow.execute_activity(
                        write_session_state,
                        args=[{"current_session": new_session}],
                        start_to_close_timeout=timedelta(seconds=10),
                    )
                    created += 1

        return SessionResult(sessions_created=created, sessions_closed=closed)
