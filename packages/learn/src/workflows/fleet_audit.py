"""FleetAuditWorkflow — daily wrong-tenant stream contamination check.

Background
----------

Runs once a day (02:00 UTC) against every tenant's own streams. For each
``composio-*.jsonl`` file under ``/alfred-data/streams/`` it pulls out
every Google-origin event with a ``self: true`` attendee and compares
that attendee's email against the tenant's canonical owner email. A
mismatch is the signature of the April 2026 tenant-a-vs-Sir leak: another
tenant's Composio user_id was misconfigured and their calendar/email
events got ingested under the wrong tenant.

Design
------

* Detection only — never modifies streams.
* Feature-gated by ``FLEET_AUDIT_ENABLED`` env var (default: ``true``).
* Emits a vault observation every run — green if clean, incident if
  mismatches found. The reflection + daily digest pipelines pick up
  observations and Alfred surfaces any red ones in the next briefing.
  Deliberately NO direct Slack/notification push: keeps the agent in
  the loop instead of firing raw alerts the user can't contextualize.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.fleet_audit import (
        audit_streams_for_owner_mismatch,
        fleet_audit_is_enabled,
        write_fleet_audit_observation,
    )


@dataclass
class FleetAuditResult:
    skipped_reason: str = ""
    audit_status: str = ""
    owner_email: str = ""
    owner_source: str = ""
    files_scanned: int = 0
    total_mismatches: int = 0
    observation_path: str = ""
    error_messages: list[str] = field(default_factory=list)


@workflow.defn(name="FleetAuditWorkflow")
class FleetAuditWorkflow:
    """Daily audit for wrong-tenant stream contamination.

    Thin wrapper around three activities:
      1. ``fleet_audit_is_enabled`` — re-check the feature flag in case
         the workflow was started manually on a tenant that's flagged off.
      2. ``audit_streams_for_owner_mismatch`` — scan the streams dir.
      3. ``write_fleet_audit_observation`` — persist findings to the vault.

    Activity #3 always runs on an enabled tenant (green observations are
    useful — absence of alerts is itself a signal the pipeline is alive).
    """

    @workflow.run
    async def run(self) -> FleetAuditResult:
        workflow.logger.info("fleet_audit.start")
        result = FleetAuditResult()

        enabled: bool = await workflow.execute_activity(
            fleet_audit_is_enabled,
            start_to_close_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )
        if not enabled:
            result.skipped_reason = "FLEET_AUDIT_ENABLED is not 'true'"
            workflow.logger.info(
                "fleet_audit: feature flag off — skipping run"
            )
            return result

        # Activity 1: scan streams.
        try:
            report: dict = await workflow.execute_activity(
                audit_streams_for_owner_mismatch,
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=RetryPolicy(
                    maximum_attempts=2,
                    initial_interval=timedelta(seconds=5),
                    backoff_coefficient=2.0,
                    maximum_interval=timedelta(seconds=30),
                ),
            )
        except Exception as exc:  # noqa: BLE001
            result.error_messages.append(
                f"audit_streams_for_owner_mismatch failed: {exc}"
            )
            workflow.logger.error("fleet_audit: scan failed: %s", exc)
            return result

        result.audit_status = str(report.get("status", "") or "")
        result.owner_email = str(report.get("owner_email", "") or "")
        result.owner_source = str(report.get("owner_source", "") or "")
        result.files_scanned = int(report.get("files_scanned", 0) or 0)
        result.total_mismatches = int(report.get("total_mismatches", 0) or 0)

        # Activity 2: write the observation (green, incident, or
        # not_audited). Idempotent at the vault layer — one record per
        # day per severity.
        try:
            obs_path: str = await workflow.execute_activity(
                write_fleet_audit_observation,
                args=[report],
                start_to_close_timeout=timedelta(minutes=2),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    initial_interval=timedelta(seconds=5),
                    backoff_coefficient=2.0,
                    maximum_interval=timedelta(seconds=30),
                ),
            )
            result.observation_path = obs_path or ""
        except Exception as exc:  # noqa: BLE001
            result.error_messages.append(
                f"write_fleet_audit_observation failed: {exc}"
            )
            workflow.logger.error(
                "fleet_audit: observation write failed: %s", exc
            )

        workflow.logger.info(
            "fleet_audit.done status=%s files=%d mismatches=%d obs=%s",
            result.audit_status,
            result.files_scanned,
            result.total_mismatches,
            result.observation_path or "(none)",
        )
        return result
