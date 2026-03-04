"""Workflow 3: Daily Digest — interactive end-of-day summary.

After writing the digest to vault, sends an interactive EOD prompt to the main
Alfred agent via the OpenClaw gateway.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from src.activities.clerk import clerk_daily_digest
    from src.activities.notify import notify_digest_ready, notify_eod_prompt
    from src.activities.vault import collect_daily_activity, write_digest_record


@dataclass
class DigestResult:
    path: str = ""
    eod_sent: bool = False


@workflow.defn(name="DailyDigestWorkflow")
class DailyDigestWorkflow:
    @workflow.run
    async def run(self) -> DigestResult:
        # 1. Collect today's vault activity
        activity_data = await workflow.execute_activity(
            collect_daily_activity,
            start_to_close_timeout=timedelta(seconds=30),
        )

        # 2. Ask Clerk to summarize
        digest = await workflow.execute_activity(
            clerk_daily_digest,
            args=[activity_data],
            start_to_close_timeout=timedelta(seconds=60),
        )

        # 3. Write event record
        path: str = await workflow.execute_activity(
            write_digest_record,
            args=[digest],
            start_to_close_timeout=timedelta(seconds=30),
        )

        # 4. Notify main Alfred agent (legacy)
        summary = digest.get("summary", "Daily digest ready.")
        await workflow.execute_activity(
            notify_digest_ready,
            args=[path, summary],
            start_to_close_timeout=timedelta(seconds=15),
        )

        # 5. Send interactive EOD prompt via OpenClaw gateway
        eod_prompt = digest.get("eod_prompt", "")
        if not eod_prompt:
            # Build a default interactive prompt
            eod_prompt = _build_eod_prompt(digest)

        eod_sent = False
        try:
            await workflow.execute_activity(
                notify_eod_prompt,
                args=[eod_prompt, path],
                start_to_close_timeout=timedelta(seconds=30),
            )
            eod_sent = True
        except Exception:
            pass  # Best-effort — don't fail the digest if EOD prompt fails

        return DigestResult(path=path, eod_sent=eod_sent)


def _build_eod_prompt(digest: dict) -> str:
    """Build the interactive EOD message from digest data."""
    sessions = digest.get("sessions_detected", 0)
    tasks_completed = digest.get("tasks_completed", 0)
    tasks_open = digest.get("tasks_open", 0)
    orphans = digest.get("orphan_records", 0)
    open_tasks = digest.get("open_tasks_carrying_forward", [])

    lines = [
        "Good evening, sir. Here's today's summary:",
        "",
        f"Sessions: {sessions}",
        f"Tasks completed: {tasks_completed}",
        f"Tasks open: {tasks_open}",
    ]

    if orphans:
        lines.append(f"{orphans} records unassigned to any session")

    if open_tasks:
        lines.append("")
        lines.append("Open tasks carrying forward:")
        for i, task in enumerate(open_tasks, 1):
            lines.append(f"{i}. {task}")

    lines.append("")
    lines.append("Anything to close out or reassign before end of day?")

    return "\n".join(lines)
