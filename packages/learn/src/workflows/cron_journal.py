"""CronJournalReconcileWorkflow — journal Hermes cron outbounds (#418).

Scheduled every 6 hours (``al-cron-journal-reconcile``).  Thin wrapper:
checks the feature flag at invocation time, then calls the ctrl-api
reconcile endpoint via the ``reconcile_cron_journal`` activity.

Interval arithmetic
-------------------
Window: 48 h.  Cap: 50 sessions/call.

Hermes cron jobs with a ``deliver`` field (the only kind journaled) are
configured by Sir for outbound chores: daily briefings, weekly digests,
etc.  A busy tenant has at most ~5 such jobs.  At 6-hour intervals that
is ~1.25 sessions/interval — well under the 50-session cap.  A session
fired just after one run waits at most 6 h before the next run picks it
up, leaving 42 h of the 48-hour window to spare.  The cap would only be
exceeded if 50+ cron sessions fired in the same 6-hour window, which is
structurally impossible on any real tenant at present cadences.
"""
from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.cron_journal import (
        cron_journal_reconcile_is_enabled,
        reconcile_cron_journal,
    )


@workflow.defn(name="CronJournalReconcileWorkflow")
class CronJournalReconcileWorkflow:
    """Invoke the cron-journal reconciler on a 6-hour schedule.

    Checks CRON_JOURNAL_RECONCILE_ENABLED at invocation time so flipping
    the flag off does not require a container restart to re-run
    register_schedules (same pattern as ReversalCalibrationWorkflow).

    Never wedges — ``reconcile_cron_journal`` catches all ctrl-api
    failures and returns a dict rather than raising.
    """

    @workflow.run
    async def run(self) -> dict:
        workflow.logger.info("cron_journal_reconcile.start")

        enabled: bool = await workflow.execute_activity(
            cron_journal_reconcile_is_enabled,
            start_to_close_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )
        if not enabled:
            workflow.logger.info(
                "cron_journal_reconcile: flag off — skipping"
            )
            return {"skipped": True, "reason": "flag_off"}

        result: dict = await workflow.execute_activity(
            reconcile_cron_journal,
            start_to_close_timeout=timedelta(minutes=2),
            retry_policy=RetryPolicy(
                maximum_attempts=2,
                initial_interval=timedelta(seconds=5),
                backoff_coefficient=2.0,
                maximum_interval=timedelta(seconds=30),
            ),
        )
        workflow.logger.info("cron_journal_reconcile.done result=%s", result)
        return result
