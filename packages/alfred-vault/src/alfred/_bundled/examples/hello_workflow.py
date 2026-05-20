"""Example workflow — minimal reference for Alfred + Temporal."""

from datetime import timedelta

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from alfred.temporal.activities import SpawnResult


@workflow.defn
class HelloWorkflow:
    """Spawns an agent with a greeting message and returns the result."""

    @workflow.run
    async def run(self, message: str = "Hello from Alfred!") -> str:
        result = await workflow.execute_activity(
            "spawn_agent",
            args=[f"Respond with: {message}", "worker", 60],
            start_to_close_timeout=timedelta(seconds=120),
            result_type=SpawnResult,
        )
        return result.output if result.success else f"FAILED: {result.output}"
