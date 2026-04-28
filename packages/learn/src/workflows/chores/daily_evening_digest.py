"""DailyEveningDigestWorkflow — skill-driven, agent-invoked.

Mirror of DailyMorningBriefingWorkflow, temporally flipped: this fires in
Sir's evening to wrap the day, while the morning brief opens it. Together
they form a continuous narrative loop — the digest reads this morning's
brief as its starting point and writes the hand-off for tomorrow's brief.

Thin wrapper: asks the main Alfred agent to produce + deliver the evening
digest, guided by the `alfred-daily-digest` skill. All content work
happens INSIDE Sir's main agent — his model, his memory, his skills, his
channel bindings. No workers subagent, no per-step Python pipeline, no
double LLM round-trip.

Flow
----
1. Load chore context (check `status`, `quarantine_remaining`).
2. POST to ctrl-api `/api/v1/agents/main/task` with a short task prompt
   that points Alfred at his `alfred-daily-digest` skill.
3. ctrl-api submits a one-shot openclaw cron job (`--at 1s
   --delete-after-run --announce --channel <ch>`) that fires almost
   immediately against Sir's main agent.
4. Alfred reads the skill, reads this morning's brief from vault, makes
   his `self` tool calls to gather day-events, writes the digest in his
   voice, persists it to vault as `event/daily-digest-<date>.md`, and
   his reply posts to his channel via the normal channel adapter.
5. Record a run-log line on the chore vault record.

Temporal owns the SCHEDULE (when to fire). Openclaw owns the
EXECUTION (how Alfred runs + delivers). Clean split.

Params (from `chore/daily-evening-digest.md` frontmatter `params` JSON)
----------------------------------------------------------------------
preview_only : bool   When true, the agent-task endpoint is called with
                      `announce=false` so no channel push fires. Used
                      for operator review.
channel      : str    Default "last" (agent's primary active channel).
                      Pass "slack" / "telegram" / etc. to force a
                      specific delivery target.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.workflows.chores._base import (
        decrement_quarantine_remaining,
        is_quarantined,
        load_chore_context,
        record_chore_run,
    )
    from src.activities.chore_actions import call_self


# Terse prompt — Alfred opens the skill and follows it. Keep this short;
# long prompts dilute the skill's instructions.
DIGEST_TASK_PROMPT = (
    "It's time for Sir's evening digest. Follow the "
    "`alfred-daily-digest` skill precisely. Your reply IS the digest "
    "— no preamble, no acknowledgement, just the content or the silence "
    "line per the skill."
)


@dataclass
class DailyEveningDigestInput:
    chore_slug: str


@dataclass
class DailyEveningDigestResult:
    scheduled: bool = False
    job_name: str = ""
    notes: str = ""


@workflow.defn(name="DailyEveningDigestWorkflow")
class DailyEveningDigestWorkflow:
    @workflow.run
    async def run(
        self, input: DailyEveningDigestInput
    ) -> DailyEveningDigestResult:
        ctx = await workflow.execute_activity(
            load_chore_context,
            args=[input.chore_slug],
            start_to_close_timeout=timedelta(seconds=15),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        if ctx.get("status") != "active":
            return DailyEveningDigestResult(notes="chore not active")

        if is_quarantined(ctx):
            remaining = int(ctx.get("quarantine_remaining", 0))
            summary = (
                f"quarantine dry-run (remaining before this: {remaining})"
            )
            await workflow.execute_activity(
                record_chore_run,
                args=[input.chore_slug, summary, True],
                start_to_close_timeout=timedelta(seconds=15),
            )
            await workflow.execute_activity(
                decrement_quarantine_remaining,
                args=[input.chore_slug],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            return DailyEveningDigestResult(notes=summary)

        params = ctx.get("params", {}) or {}
        preview_only = bool(params.get("preview_only", False))
        channel = str(params.get("channel") or "last")

        resp = await workflow.execute_activity(
            call_self,
            args=[
                "/api/v1/agents/main/task",
                "POST",
                {
                    "task": DIGEST_TASK_PROMPT,
                    "channel": channel,
                    "announce": not preview_only,
                    "at_seconds": 1,
                },
                None,
            ],
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )

        status = resp.get("status") if isinstance(resp, dict) else None
        job_name = resp.get("name") if isinstance(resp, dict) else ""
        scheduled = status == "scheduled"

        notes = (
            f"scheduled job={job_name} preview_only={preview_only}"
            if scheduled
            else f"agent-task endpoint returned status={status}"
        )
        await workflow.execute_activity(
            record_chore_run,
            args=[input.chore_slug, notes],
            start_to_close_timeout=timedelta(seconds=15),
        )

        return DailyEveningDigestResult(
            scheduled=scheduled,
            job_name=job_name or "",
            notes=notes,
        )
