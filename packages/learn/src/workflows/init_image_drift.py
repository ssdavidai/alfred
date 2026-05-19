"""InitImageDriftWorkflow — daily check for ``ssdavidai00/alfred-init:latest``.

Background — 11:14Z incident on 2026-05-19
-------------------------------------------
The CI smoke step in ``.github/workflows/build-alfred.yml`` catches the
case where CI's OWN build produces a stale image. This workflow catches
drift from ANY other source — every tenant pulls the same
``ssdavidai00/alfred-init:latest``, so one bad push silently breaks the
whole fleet on the next init restart.

The check
---------
1. ``check_init_image_drift`` — pulls the manifest from DockerHub,
   walks the layers (newest-first) for ``setup/entrypoint.sh``, and
   asserts the OPS-TOKEN-1 markers (``chmod 0640 "$TOKEN_FILE"`` present,
   ``chmod 600 "$TOKEN_FILE"`` absent).
2. ``emit_init_image_drift_audit`` — only on a positive drift result,
   posts an ``image-drift`` row to ctrl-api's ``POST /api/v1/audit``.

Scheduled daily via ``al-init-image-drift`` (registered in
``scripts/register_schedules.py``). One activity → one audit row →
``/decisions`` lights up. ``overlap=SKIP`` per the schedule defense
standard (#931): a stuck registry call must not pile on more zombies.

Why a workflow at all
---------------------
The same reasoning as ``StuckPipelineAlertWorkflow`` and
``OpenclawSessionSweepWorkflow``: keeping the periodic check in Temporal
means the result is visible in Temporal history without log spelunking,
a wedge surfaces as one stuck schedule run rather than a missing cron
line, and the SKIP overlap guarantees we don't paper a broken layer
fetch with another instance of the same broken layer fetch.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.init_image_drift import (
        check_init_image_drift,
        emit_init_image_drift_audit,
    )


@dataclass
class InitImageDriftResult:
    """Compact summary surfaced to Temporal history."""

    checked: bool = False
    drift: bool = False
    image: str = ""
    has_chmod_0640: bool = False
    has_chmod_600: bool = False
    reasons: list[str] | None = None
    audit_posted: bool = False
    error: str | None = None


@workflow.defn(name="InitImageDriftWorkflow")
class InitImageDriftWorkflow:
    """Daily drift check for the init container image."""

    @workflow.run
    async def run(self) -> InitImageDriftResult:
        workflow.logger.info("init_image_drift.start")

        # 90s envelope for the registry call. The check downloads only
        # the last 1-2 layers of the image (entrypoint.sh sits in a
        # small late layer); a healthy run completes in <10s. The
        # retry policy adds one shot in case DockerHub's CDN flakes.
        report = await workflow.execute_activity(
            check_init_image_drift,
            start_to_close_timeout=timedelta(seconds=90),
            retry_policy=RetryPolicy(
                maximum_attempts=2,
                initial_interval=timedelta(seconds=10),
                backoff_coefficient=2.0,
            ),
        )

        result = _result_from_report(report)

        if not result.drift:
            workflow.logger.info(
                "init_image_drift.healthy image=%s checked=%s",
                result.image, result.checked,
            )
            return result

        # Drift! Forward to the audit ledger. emit_init_image_drift_audit
        # is best-effort — a failed audit POST still leaves a record in
        # Temporal history, so we surface the outcome but don't fail the
        # workflow.
        try:
            audit = await workflow.execute_activity(
                emit_init_image_drift_audit,
                args=[report],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=2,
                    initial_interval=timedelta(seconds=5),
                ),
            )
            result.audit_posted = bool(audit.get("posted")) if audit else False
        except Exception as exc:  # noqa: BLE001
            workflow.logger.warning(
                "init_image_drift.audit_failed err=%s", exc,
            )

        workflow.logger.warning(
            "init_image_drift.drift image=%s reasons=%s audit_posted=%s",
            result.image, result.reasons, result.audit_posted,
        )
        return result


def _result_from_report(report: dict[str, Any]) -> InitImageDriftResult:
    """Map the activity's dict report into the workflow's dataclass.

    Keeps the workflow body free of dict-key spelunking so a missing
    field is a typed attribute access, not a silent KeyError.
    """
    return InitImageDriftResult(
        checked=bool(report.get("checked", False)),
        drift=bool(report.get("drift", False)),
        image=str(report.get("image") or ""),
        has_chmod_0640=bool(report.get("has_chmod_0640", False)),
        has_chmod_600=bool(report.get("has_chmod_600", False)),
        reasons=list(report.get("reasons") or []),
        error=report.get("error"),
    )
