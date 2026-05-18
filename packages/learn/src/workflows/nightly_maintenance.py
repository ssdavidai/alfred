"""Workflow: Nightly Maintenance — distiller (formerly: janitor + distiller).

Runs once per night (2am tenant time). Each tool runs as a bounded one-shot
via ctrl-api, not as a continuous daemon. Serialized execution ensures we
never exceed 60% of the Gemini 4M TPM limit even with multiple tenants.

Throttling math:
- maxConcurrent=1 on openclaw-workers → 1 LLM call at a time per tenant
- Each call ~30K tokens → ~30K TPM per tenant
- 10 tenants running simultaneously → ~300K TPM (7.5% of 4M limit)
- Well within the 60% target (2.4M TPM)

STORE-P0-4: The janitor scan/fix step was removed 2026-05-18 after it
rewrote every file in ``/vault/event/`` on the david tenant (73,652
files in 5 minutes) just to stamp ``janitor_note: ORPHAN001 -- No
inbound wikilinks from any other record`` onto each one. event/ records
are write-once audit trails and will never have inbound wikilinks, so
the tag adds zero forward value while saturating ctrl-api and starving
concurrent workflows. Removal is gated with ``workflow.patched()`` so
in-flight runs replay correctly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.maintenance import (
        run_distiller_batch,
    )


@dataclass
class MaintenanceResult:
    janitor_issues_found: int = 0
    janitor_issues_fixed: int = 0
    distiller_learnings: int = 0
    errors: list[str] = field(default_factory=list)


@workflow.defn(name="NightlyMaintenanceWorkflow")
class NightlyMaintenanceWorkflow:
    @workflow.run
    async def run(self) -> MaintenanceResult:
        result = MaintenanceResult()

        # --- Janitor: scan + fix (REMOVED — STORE-P0-4) ---
        # Old code ran ``run_janitor_scan_and_fix`` here. We gate the
        # removal with ``workflow.patched`` so any in-flight history
        # started under the pre-patch worker still replays the call.
        # New runs skip the activity entirely.
        if not workflow.patched("store-p0-4-drop-janitor-step"):
            from src.activities.maintenance import run_janitor_scan_and_fix
            try:
                janitor_result = await workflow.execute_activity(
                    run_janitor_scan_and_fix,
                    start_to_close_timeout=timedelta(minutes=30),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                result.janitor_issues_found = janitor_result.get(
                    "issues_found", 0
                )
                result.janitor_issues_fixed = janitor_result.get(
                    "issues_fixed", 0
                )
            except Exception as e:
                result.errors.append(f"janitor: {e}")

        # --- Distiller: extract learnings (bounded) ---
        try:
            distiller_result = await workflow.execute_activity(
                run_distiller_batch,
                start_to_close_timeout=timedelta(minutes=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            result.distiller_learnings = distiller_result.get("learnings_created", 0)
        except Exception as e:
            result.errors.append(f"distiller: {e}")

        return result
