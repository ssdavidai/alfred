"""Workflow that harvests OpenClaw chat sessions into the vault inbox."""

from datetime import timedelta

from temporalio import workflow


@workflow.defn
class SessionHarvestWorkflow:
    """Scans OpenClaw main agent sessions and writes new messages to inbox."""

    @workflow.run
    async def run(self) -> dict:
        return await workflow.execute_activity(
            "harvest_openclaw_sessions",
            start_to_close_timeout=timedelta(seconds=120),
            result_type=dict,
        )
