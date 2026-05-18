"""Workflow: Nightly Maintenance — janitor, distiller, surveyor in sequence.

Runs once per night (2am tenant time). Each tool runs as a bounded one-shot
via ctrl-api, not as a continuous daemon. Serialized execution ensures we
never exceed 60% of the Gemini 4M TPM limit even with multiple tenants.

Throttling math:
- maxConcurrent=1 on openclaw-workers → 1 LLM call at a time per tenant
- Each call ~30K tokens → ~30K TPM per tenant
- 10 tenants running simultaneously → ~300K TPM (7.5% of 4M limit)
- Well within the 60% target (2.4M TPM)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.maintenance import (
        run_janitor_scan_and_fix,
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

        # --- Janitor: scan + fix (bounded) ---
        try:
            janitor_result = await workflow.execute_activity(
                run_janitor_scan_and_fix,
                start_to_close_timeout=timedelta(minutes=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            result.janitor_issues_found = janitor_result.get("issues_found", 0)
            result.janitor_issues_fixed = janitor_result.get("issues_fixed", 0)
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
