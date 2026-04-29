"""WeeklyMoneyDayBriefWorkflow — skill-driven, agent-invoked.

Thin wrapper: asks the main Alfred agent to produce + deliver Sir's
Tuesday Money Day brief, guided by the `alfred-sure-operations` skill.
All content work happens INSIDE Sir's main agent — his model, his
memory, his skills, his channel bindings. No workers subagent, no
per-step Python pipeline, no Sure HTTP client in Python.

Schedule: every Tuesday at 06:00 UTC.

Flow
----
1. Load chore context (check `status`, `quarantine_remaining`).
2. POST to ctrl-api `/api/v1/agents/main/task` with a short task prompt
   that points Alfred at his `alfred-sure-operations` skill, calling out
   the "Money Day Tuesday brief generation" worked example.
3. ctrl-api submits a one-shot openclaw cron job (`--at 1s
   --delete-after-run --announce --channel <ch>`) that fires almost
   immediately against Sir's main agent.
4. Alfred reads the skill, triggers a sync, then assembles the brief
   (net worth + week-over-week delta, top three outflow categories,
   anomalies, per-account balance table grouped by currency) and his
   reply posts to his channel via the normal channel adapter.
5. Record a run-log line on the chore vault record.

Temporal owns the SCHEDULE (when to fire). Openclaw owns the
EXECUTION (how Alfred runs + delivers). Clean split.

Params (from `chore/weekly-money-day.md` frontmatter `params` JSON)
------------------------------------------------------------------
preview_only : bool   When true, the agent-task endpoint is called with
                      `announce=false` so no channel push fires. Used
                      for operator review via openclaw logs or a
                      preview run the operator can inspect.
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
BRIEFING_TASK_PROMPT = (
    "It's Sir's Tuesday Money Day. Follow the "
    "`alfred-sure-operations` skill — specifically the 'Money Day Tuesday "
    "brief generation' worked example. Trigger a sync, then assemble the "
    "brief: net worth with week-over-week delta, top three outflow "
    "categories, anomalies, and the per-account balance table grouped by "
    "currency. Your reply IS the brief — no preamble, no acknowledgement."
)


@dataclass
class WeeklyMoneyDayInput:
    chore_slug: str


@dataclass
class WeeklyMoneyDayResult:
    scheduled: bool = False
    job_name: str = ""
    notes: str = ""


@workflow.defn(name="WeeklyMoneyDayBriefWorkflow")
class WeeklyMoneyDayBriefWorkflow:
    @workflow.run
    async def run(
        self, input: WeeklyMoneyDayInput
    ) -> WeeklyMoneyDayResult:
        ctx = await workflow.execute_activity(
            load_chore_context,
            args=[input.chore_slug],
            start_to_close_timeout=timedelta(seconds=15),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        if ctx.get("status") != "active":
            return WeeklyMoneyDayResult(notes="chore not active")

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
            return WeeklyMoneyDayResult(notes=summary)

        params = ctx.get("params", {}) or {}
        preview_only = bool(params.get("preview_only", False))
        channel = str(params.get("channel") or "last")

        resp = await workflow.execute_activity(
            call_self,
            args=[
                "/api/v1/agents/main/task",
                "POST",
                {
                    "task": BRIEFING_TASK_PROMPT,
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

        return WeeklyMoneyDayResult(
            scheduled=scheduled,
            job_name=job_name or "",
            notes=notes,
        )
