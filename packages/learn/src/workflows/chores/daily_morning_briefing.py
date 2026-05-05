"""DailyMorningBriefingWorkflow — skill-driven, agent-invoked.

Thin wrapper: asks the main Alfred agent to produce + deliver the morning
briefing, guided by the `alfred-daily-briefing` skill. All content work
happens INSIDE Sir's main agent — his model, his memory, his skills, his
channel bindings. No workers subagent, no per-step Python pipeline, no
double LLM round-trip, no reversed delivery role.

Flow
----
1. Load chore context (check `status`, `quarantine_remaining`).
2. Phase 5 (#841): compute Steward-aware briefing context — filtered
   open tasks (Steward auto-resolved tasks dropped) + a "Closed since
   last brief" list. Pure cache read, no LLM.
3. POST to ctrl-api `/api/v1/agents/main/task` with a short task prompt
   that points Alfred at his `alfred-daily-briefing` skill, embedding
   the Steward context payload so the skill can render without re-
   querying.
4. ctrl-api submits a one-shot openclaw cron job (`--at 1s
   --delete-after-run --announce --channel <ch>`) that fires almost
   immediately against Sir's main agent.
5. Alfred reads the skill, makes his `self` tool calls, writes the
   briefing in his voice, and his reply posts to his channel (Slack DM
   by default) via the normal channel adapter's outbound path.
6. Stamp ``last_brief_at`` so the next brief's "Closed since last
   brief" prefix uses the correct cutoff.
7. Record a run-log line on the chore vault record.

Temporal owns the SCHEDULE (when to fire). Openclaw owns the
EXECUTION (how Alfred runs + delivers). Clean split.

Params (from `chore/daily-morning-briefing.md` frontmatter `params` JSON)
------------------------------------------------------------------------
preview_only : bool   When true, the agent-task endpoint is called with
                      `announce=false` so no channel push fires. Used
                      for operator review via openclaw logs or a
                      preview run the operator can inspect.
channel      : str    Default "last" (agent's primary active channel).
                      Pass "slack" / "telegram" / etc. to force a
                      specific delivery target.
"""
from __future__ import annotations

import json
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
    from src.activities.briefing_cache import (
        compute_briefing_context,
        stamp_brief_completed,
    )


# Terse prompt — Alfred opens the skill and follows it. Keep this short;
# long prompts dilute the skill's instructions. Phase 5 prepends a
# concise summary of the Steward-aware context so the skill renders the
# "Closed since last brief" prefix and the filtered open list without
# re-querying — see ``_compose_briefing_prompt`` below.
BRIEFING_TASK_PROMPT = (
    "It's time for Sir's morning briefing. Follow the "
    "`alfred-daily-briefing` skill precisely. Your reply IS the briefing "
    "— no preamble, no acknowledgement, just the content or the silence "
    "line per the skill."
)


def _compose_briefing_prompt(context: dict) -> str:
    """Embed the Steward-aware context into the briefing prompt.

    Pure (deterministic, no I/O) — safe to call from inside the
    workflow body. Truncates the JSON payload at 32 KB so a tenant with
    thousands of open tasks doesn't blow the prompt budget; the skill
    will then re-query for full detail if it needs more.
    """
    closed = context.get("closed_since_last_brief") or []
    open_tasks = context.get("open_tasks") or []
    filter_summary = context.get("filter_summary") or {}
    cutoff = context.get("last_brief_at") or ""

    payload = {
        "closed_since_last_brief": closed,
        "open_tasks": open_tasks,
        "filter_summary": filter_summary,
        "last_brief_at": cutoff,
    }
    blob = json.dumps(payload, ensure_ascii=False, default=str, indent=2)
    if len(blob) > 32 * 1024:
        # Truncate to first N open tasks; closed list is bounded by the
        # recent-actions endpoint's limit (200) so it's already small.
        truncated_open = open_tasks[:200]
        payload["open_tasks"] = truncated_open
        payload["open_tasks_truncated"] = True
        payload["open_tasks_omitted"] = len(open_tasks) - len(truncated_open)
        blob = json.dumps(payload, ensure_ascii=False, default=str, indent=2)

    closed_count = len(closed)
    surfaced_count = filter_summary.get("surfaced", len(open_tasks))
    filtered_count = filter_summary.get("filtered_likely_done", 0)

    summary_line = (
        f"Steward summary since {cutoff or '(no prior brief)'}: "
        f"{closed_count} task(s) closed by Steward, "
        f"{surfaced_count} open task(s) need attention, "
        f"{filtered_count} task(s) filtered out as Steward-resolved.\n"
    )

    return (
        f"{BRIEFING_TASK_PROMPT}\n\n"
        f"{summary_line}"
        "STEWARD_CONTEXT (already cached — do not re-query unless the "
        "skill explicitly tells you to):\n"
        f"```json\n{blob}\n```"
    )


@dataclass
class DailyMorningBriefingInput:
    chore_slug: str


@dataclass
class DailyMorningBriefingResult:
    scheduled: bool = False
    job_name: str = ""
    notes: str = ""


@workflow.defn(name="DailyMorningBriefingWorkflow")
class DailyMorningBriefingWorkflow:
    @workflow.run
    async def run(
        self, input: DailyMorningBriefingInput
    ) -> DailyMorningBriefingResult:
        ctx = await workflow.execute_activity(
            load_chore_context,
            args=[input.chore_slug],
            start_to_close_timeout=timedelta(seconds=15),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        if ctx.get("status") != "active":
            return DailyMorningBriefingResult(notes="chore not active")

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
            return DailyMorningBriefingResult(notes=summary)

        params = ctx.get("params", {}) or {}
        preview_only = bool(params.get("preview_only", False))
        channel = str(params.get("channel") or "last")

        # Phase 5 (#841): build the Steward-aware briefing prompt by
        # pre-computing context (filtered open tasks + closed-since-last-
        # brief). Gated with workflow.patched() so in-flight workflows
        # started under the Phase 0/4 code keep replaying deterministically.
        if workflow.patched("steward-phase-5-briefing-cache"):
            context = await workflow.execute_activity(
                compute_briefing_context,
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            briefing_prompt = _compose_briefing_prompt(context or {})
            closed_count = len((context or {}).get("closed_since_last_brief") or [])
        else:
            context = {}
            briefing_prompt = BRIEFING_TASK_PROMPT
            closed_count = 0

        resp = await workflow.execute_activity(
            call_self,
            args=[
                "/api/v1/agents/main/task",
                "POST",
                {
                    "task": briefing_prompt,
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

        # Stamp last_brief_at AFTER scheduling — same patch gate so
        # replay determinism holds across the Phase 5 cutover.
        stamped_at = ""
        if scheduled and workflow.patched("steward-phase-5-briefing-cache"):
            stamped_at = await workflow.execute_activity(
                stamp_brief_completed,
                args=[closed_count],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

        if scheduled:
            notes = (
                f"scheduled job={job_name} preview_only={preview_only} "
                f"closed_since={closed_count} stamped={stamped_at or 'skipped'}"
            )
        else:
            notes = f"agent-task endpoint returned status={status}"

        await workflow.execute_activity(
            record_chore_run,
            args=[input.chore_slug, notes],
            start_to_close_timeout=timedelta(seconds=15),
        )

        return DailyMorningBriefingResult(
            scheduled=scheduled,
            job_name=job_name or "",
            notes=notes,
        )
