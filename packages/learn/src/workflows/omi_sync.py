"""Native Omi chat/task reconciliation. All state writes belong to ctrl-api."""
from datetime import timedelta
from temporalio import workflow
from temporalio.common import RetryPolicy

@workflow.defn(name="OmiSyncWorkflow")
class OmiSyncWorkflow:
    @workflow.run
    async def run(self) -> dict:
        return await workflow.execute_activity(
            "reconcile_omi_chat_tasks", start_to_close_timeout=timedelta(minutes=4),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )
