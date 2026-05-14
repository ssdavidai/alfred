"""OpenclawSessionSweepWorkflow — hourly reaper for openclaw .bak sessions.

Wraps ``sweep_openclaw_bak_sessions`` (see
``src/activities/openclaw_sessions.py``) in a 1-activity workflow so
the schedule registry can drive it on a clean interval cadence the
same way every other low-priority sweep workflow runs.

Why a workflow at all rather than a cron line inside openclaw-workers
itself: ownership stays inside the Python intelligence layer we touch
most, results are visible in Temporal history + the activity log
without spelunking container stdout, and one stuck sweep doesn't
silently fail off-radar — Temporal's overlap=SKIP + retry policy is
strictly stricter than an unsupervised cron entry.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.openclaw_sessions import sweep_openclaw_bak_sessions


@dataclass
class OpenclawSessionSweepResult:
    """Compact summary surfaced to Temporal history."""

    agents_scanned: int = 0
    files_scanned: int = 0
    files_deleted: int = 0
    bytes_freed: int = 0
    errors: int = 0
    per_agent: dict = field(default_factory=dict)
    error_messages: list = field(default_factory=list)


@workflow.defn(name="OpenclawSessionSweepWorkflow")
class OpenclawSessionSweepWorkflow:
    @workflow.run
    async def run(self) -> OpenclawSessionSweepResult:
        retry = RetryPolicy(
            maximum_attempts=2,
            initial_interval=timedelta(seconds=5),
            backoff_coefficient=2.0,
        )
        # 5 minute envelope is generous — even 10k .bak files is <30s
        # of stat+unlink on warm cache. Filesystem-bound work doesn't
        # need a higher ceiling.
        try:
            out = await workflow.execute_activity(
                sweep_openclaw_bak_sessions,
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            workflow.logger.warning(
                "openclaw_session_sweep: activity failed err=%s", exc,
            )
            return OpenclawSessionSweepResult(
                errors=1, error_messages=[f"sweep_activity: {exc}"[:300]],
            )

        return OpenclawSessionSweepResult(
            agents_scanned=int(out.get("agents_scanned") or 0),
            files_scanned=int(out.get("files_scanned") or 0),
            files_deleted=int(out.get("files_deleted") or 0),
            bytes_freed=int(out.get("bytes_freed") or 0),
            errors=int(out.get("errors") or 0),
            per_agent=out.get("per_agent") or {},
            error_messages=out.get("error_messages") or [],
        )
