"""PlaneReconciliationWorkflow — hourly sweep that mirrors Plane REST deletes.

Plane 1.3.0 emits ``issue.deleted`` webhooks only for UI-driven deletions.
Programmatic DELETEs via the REST API silently return 204 with no webhook,
so the reverse-sync workflow never learns about them. Forward-sync catches
stragglers when a vault task gets modified (the 404-on-update branch in
``sync_task_to_plane`` archives the task), but tasks whose mtime never
advances past the cursor stay stuck pointing at a gone Plane issue.

This workflow is the catch-up path. Runs once an hour, scans every project
in the forward-sync ``project_map``, and archives any vault task whose
``plane_id`` isn't in the live Plane set.

Cadence: every hour, SKIP overlap policy — consistent with the other
Plane schedules. The single activity contains all I/O; the workflow is
a thin wrapper that just enforces the feature flag and surfaces counters.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.plane_reconciliation import (
        plane_reconciliation_is_enabled,
        reconcile_plane_deletes,
    )


@dataclass
class PlaneReconciliationResult:
    started: bool = False
    projects_scanned: int = 0
    plane_issues_found: int = 0
    map_entries_checked: int = 0
    stale_map_entries: int = 0
    vault_archived: int = 0
    errors: int = 0
    early_exit: bool = False
    skipped_reason: str = ""
    error_messages: list[str] = field(default_factory=list)


@workflow.defn(name="PlaneReconciliationWorkflow")
class PlaneReconciliationWorkflow:
    """Hourly sweep to detect Plane deletes that never emitted webhooks.

    Single-activity workflow. Returns counters for Temporal history +
    ad-hoc debugging; nothing else in the system depends on the result.
    """

    @workflow.run
    async def run(self) -> PlaneReconciliationResult:
        workflow.logger.info("plane_reconciliation.start")
        result = PlaneReconciliationResult()

        enabled: bool = await workflow.execute_activity(
            plane_reconciliation_is_enabled,
            start_to_close_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )
        if not enabled:
            result.skipped_reason = "PLANE_SYNC_ENABLED is not 'true'"
            workflow.logger.info(
                "plane_reconciliation: feature flag off — skipping run"
            )
            return result

        result.started = True

        # Reconciliation pages every project's issues and patches vault
        # frontmatter for each stale entry. A 10-minute ceiling is generous
        # for a fleet tenant (3-4k issues × ~1s/page throttle = single digit
        # minutes typical). Single retry to avoid rescanning on transient
        # Plane 500s — next hour picks up anyway.
        counters: dict[str, Any] = await workflow.execute_activity(
            reconcile_plane_deletes,
            start_to_close_timeout=timedelta(minutes=10),
            retry_policy=RetryPolicy(
                maximum_attempts=2,
                initial_interval=timedelta(seconds=5),
                backoff_coefficient=2.0,
                maximum_interval=timedelta(seconds=30),
            ),
        )

        result.projects_scanned = int(counters.get("projects_scanned", 0) or 0)
        result.plane_issues_found = int(
            counters.get("plane_issues_found", 0) or 0
        )
        result.map_entries_checked = int(
            counters.get("map_entries_checked", 0) or 0
        )
        result.stale_map_entries = int(
            counters.get("stale_map_entries", 0) or 0
        )
        result.vault_archived = int(counters.get("vault_archived", 0) or 0)
        result.errors = int(counters.get("errors", 0) or 0)
        result.early_exit = bool(counters.get("early_exit", False))

        workflow.logger.info(
            "plane_reconciliation.done projects_scanned=%d "
            "plane_issues_found=%d map_entries_checked=%d "
            "stale_map_entries=%d vault_archived=%d errors=%d early_exit=%s",
            result.projects_scanned,
            result.plane_issues_found,
            result.map_entries_checked,
            result.stale_map_entries,
            result.vault_archived,
            result.errors,
            result.early_exit,
        )
        return result
