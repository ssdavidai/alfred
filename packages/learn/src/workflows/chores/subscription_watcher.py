"""SubscriptionWatcherWorkflow — weekly subscription anomaly watcher.

Runs weekly. Pulls financial events from the last 7 days, diffs against last
week's snapshot, filters out routine activity, and ONLY calls the LLM if there
is something potentially worth bothering the user about. Most weeks make zero
LLM calls.

This is the canonical reference template — it demonstrates the
"Python does the work, LLM only judges" pattern that all chore templates
should follow.

Params (from chore vault record):
    matter_domains: list[str]   # which domains to watch (e.g. stripe.com, polar.sh)
    alert_threshold: float       # 0.0-1.0 — minimum confidence to bother the user
    session_id: str              # OpenClaw session id for delivery (default "main")
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.workflows.chores._base import load_chore_context, record_chore_run
    from src.activities.chore_actions import (
        ask_alfred_to_judge_anomalies,
        diff_subscriptions,
        fetch_financial_events,
        filter_anomalies_by_threshold,
        load_subscription_snapshot,
        save_subscription_snapshot,
        send_chore_notification,
    )


@dataclass
class SubscriptionWatcherInput:
    chore_slug: str


@dataclass
class SubscriptionWatcherResult:
    anomalies_found: int = 0
    notified: bool = False
    llm_called: bool = False
    notes: str = ""


@workflow.defn(name="SubscriptionWatcherWorkflow")
class SubscriptionWatcherWorkflow:
    @workflow.run
    async def run(self, input: SubscriptionWatcherInput) -> SubscriptionWatcherResult:
        # 1. Load chore context (params, status, last_run)
        ctx = await workflow.execute_activity(
            load_chore_context,
            args=[input.chore_slug],
            start_to_close_timeout=timedelta(seconds=15),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        if ctx.get("status") != "active":
            return SubscriptionWatcherResult(notes="chore not active")

        params = ctx.get("params", {})
        matter_domains = params.get("matter_domains", [])
        alert_threshold = float(params.get("alert_threshold", 0.7))
        session_id = params.get("session_id", "main")

        if not matter_domains:
            return SubscriptionWatcherResult(notes="no matter_domains configured")

        # 2. Pure Python: fetch events for the watched domains in the last 7 days
        events = await workflow.execute_activity(
            fetch_financial_events,
            args=[matter_domains, 7],
            start_to_close_timeout=timedelta(minutes=2),
            heartbeat_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )

        # 3. Pure Python: load last week's snapshot from disk
        snapshot = await workflow.execute_activity(
            load_subscription_snapshot,
            args=[input.chore_slug],
            start_to_close_timeout=timedelta(seconds=15),
        )

        # 4. Pure Python: diff this week vs last week
        diffs = await workflow.execute_activity(
            diff_subscriptions,
            args=[events, snapshot],
            start_to_close_timeout=timedelta(seconds=15),
        )

        # 5. Pure Python: filter to suspicious only (above threshold)
        suspicious = await workflow.execute_activity(
            filter_anomalies_by_threshold,
            args=[diffs, alert_threshold],
            start_to_close_timeout=timedelta(seconds=10),
        )

        result = SubscriptionWatcherResult(anomalies_found=len(suspicious))

        # 6. ONLY now do we ask the LLM — and only about the suspicious slice.
        # Most weeks (no anomalies) skip this entirely.
        if suspicious:
            verdict = await workflow.execute_activity(
                ask_alfred_to_judge_anomalies,
                args=[input.chore_slug, suspicious],
                start_to_close_timeout=timedelta(minutes=5),
                heartbeat_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            result.llm_called = True

            # 7. Pure Python: deliver if the LLM said it was worth it
            if verdict.get("should_notify"):
                await workflow.execute_activity(
                    send_chore_notification,
                    args=[input.chore_slug, session_id, verdict.get("message", "")],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
                result.notified = True

        # 8. Save the new snapshot for next week's diff
        await workflow.execute_activity(
            save_subscription_snapshot,
            args=[input.chore_slug, events],
            start_to_close_timeout=timedelta(seconds=30),
        )

        # 9. Update the chore record with a run-log line
        summary = (
            f"{result.anomalies_found} anomalies, "
            f"{'notified' if result.notified else 'silent'}, "
            f"llm={'yes' if result.llm_called else 'no'}"
        )
        await workflow.execute_activity(
            record_chore_run,
            args=[input.chore_slug, summary],
            start_to_close_timeout=timedelta(seconds=15),
        )

        result.notes = summary
        return result
