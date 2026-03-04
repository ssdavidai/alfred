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
from datetime import timedelta
from typing import Any

from temporalio import workflow

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
            # Open session exists — ask Clerk if same topic
            topic_decision = await workflow.execute_activity(
                clerk_compare_topics,
                args=[
                    current_session.get("topic_summary", ""),
                    recent,
                ],
                start_to_close_timeout=timedelta(seconds=30),
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
