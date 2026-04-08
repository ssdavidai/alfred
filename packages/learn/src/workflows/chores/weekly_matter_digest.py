"""WeeklyMatterDigestWorkflow — weekly per-matter digest.

Once a week, summarizes activity for one specific matter (project/client).
Pure Python event count + filtering. The LLM is called once at the end if
there is enough activity to warrant a digest paragraph; otherwise the chore
runs silently.

Params (from chore vault record):
    matter_slug: str             # which matter (vault path matter/<slug>.md)
    session_id: str              # OpenClaw session id for delivery (default "main")
    min_events_for_digest: int   # threshold below which the chore stays silent
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.workflows.chores._base import load_chore_context, record_chore_run
    from src.activities.chore_actions import (
        fetch_matter_events_last_week,
        save_digest_to_vault,
        send_chore_notification,
        write_matter_digest_via_llm,
    )


@dataclass
class WeeklyMatterDigestInput:
    chore_slug: str


@dataclass
class WeeklyMatterDigestResult:
    events_seen: int = 0
    digest_written: bool = False
    notified: bool = False
    notes: str = ""


@workflow.defn(name="WeeklyMatterDigestWorkflow")
class WeeklyMatterDigestWorkflow:
    @workflow.run
    async def run(self, input: WeeklyMatterDigestInput) -> WeeklyMatterDigestResult:
        ctx = await workflow.execute_activity(
            load_chore_context,
            args=[input.chore_slug],
            start_to_close_timeout=timedelta(seconds=15),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        if ctx.get("status") != "active":
            return WeeklyMatterDigestResult(notes="chore not active")

        params = ctx.get("params", {})
        matter_slug = params.get("matter_slug", "")
        session_id = params.get("session_id", "main")
        min_events = int(params.get("min_events_for_digest", 3))

        if not matter_slug:
            return WeeklyMatterDigestResult(notes="no matter_slug configured")

        # 1. Pure Python: fetch the events for this matter from the last week
        events = await workflow.execute_activity(
            fetch_matter_events_last_week,
            args=[matter_slug],
            start_to_close_timeout=timedelta(minutes=2),
            heartbeat_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )

        result = WeeklyMatterDigestResult(events_seen=len(events))

        # 2. Threshold gate — silent weeks make zero LLM calls
        if len(events) < min_events:
            await workflow.execute_activity(
                record_chore_run,
                args=[input.chore_slug, f"{len(events)} events, below threshold, silent"],
                start_to_close_timeout=timedelta(seconds=15),
            )
            result.notes = "below threshold"
            return result

        # 3. ONLY if we crossed the threshold do we ask the LLM to write a digest
        digest = await workflow.execute_activity(
            write_matter_digest_via_llm,
            args=[matter_slug, events],
            start_to_close_timeout=timedelta(minutes=10),
            heartbeat_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        result.digest_written = True

        # 4. Save the digest as a vault note for posterity
        await workflow.execute_activity(
            save_digest_to_vault,
            args=[matter_slug, digest],
            start_to_close_timeout=timedelta(seconds=30),
        )

        # 5. Deliver to the user
        await workflow.execute_activity(
            send_chore_notification,
            args=[input.chore_slug, session_id, digest],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )
        result.notified = True

        await workflow.execute_activity(
            record_chore_run,
            args=[input.chore_slug, f"{len(events)} events, digest sent"],
            start_to_close_timeout=timedelta(seconds=15),
        )
        result.notes = "digest sent"
        return result
