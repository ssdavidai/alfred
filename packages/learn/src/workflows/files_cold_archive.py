"""FilesColdArchiveWorkflow — daily cold-promotion sweep for Store 5.

Background
----------

Issue #114 PR 5 adds a cold-archive tier to the principal-facing
files store: a separate ``files_cold_data`` volume, ZSTD-19
compressed, that holds blobs untouched for 90+ days.

This workflow runs once a day at 03:00 (low traffic — sits between
nightly_maintenance at 03:00 and decision_patterns also at 03:00,
but no overlap because the sweep is read-mostly + per-entry
isolated). It:

  1. Reads the list of eligible files from ctrl-api via
     ``find_cold_candidates``.
  2. Loops each one through ``promote_to_cold``, isolating per-file
     failures so one bad file never wedges the rest of the run.
  3. Returns a roll-up: how many candidates, how many promoted, how
     many bytes lifted off the live volume + landed on the cold
     volume, and the average compression ratio.

Design notes
------------

* Pure orchestration. All ctrl-api interaction lives in
  ``src.activities.files_cold_archive``; the workflow never imports
  httpx or touches the filesystem.
* Per-entry try/except boundary: one Composio-style API failure on
  one file can never poison the rest of the sweep.
* Idempotent + overlap-safe. The sweep is content-addressed; an
  already-cold file is a no-op on ctrl-api's side.
* Takes one optional argument ``older_than_ms`` so an operator can
  hand-run a tighter sweep without re-deploying.

Schedule
--------

Registered as ``al-files-cold-archive`` in
``packages/learn/scripts/register_schedules.py``, daily at
03:00 LOCAL.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.files_cold_archive import (
        find_cold_candidates,
        promote_to_cold,
    )


# 90 days in milliseconds — the default cold-promotion threshold.
DEFAULT_COLD_AFTER_MS = 90 * 24 * 60 * 60 * 1000


@dataclass
class FilesColdArchiveResult:
    candidates_total: int = 0
    promoted: list[str] = field(default_factory=list)
    already_cold: list[str] = field(default_factory=list)
    live_bytes_freed: int = 0
    cold_bytes_written: int = 0
    errors: list[str] = field(default_factory=list)

    @property
    def compression_ratio(self) -> float | None:
        if self.cold_bytes_written <= 0:
            return None
        return round(self.live_bytes_freed / self.cold_bytes_written, 3)


@workflow.defn(name="FilesColdArchiveWorkflow")
class FilesColdArchiveWorkflow:
    """Promote unaccessed files to the cold archive once a day.

    Per the PR 5 contract:

      * Cold-eligible = ``deleted_at IS NULL`` AND
        ``cold_promoted_at IS NULL`` AND
        ``COALESCE(last_accessed_at, uploaded_at) < now - older_than_ms``.
      * ``older_than_ms`` defaults to 90d (``DEFAULT_COLD_AFTER_MS``);
        ad-hoc runs can override for testing.
      * Each file is promoted via ctrl-api's
        ``POST /api/v1/files/cold-promote/:file_id``. ctrl-api owns
        the compression + the atomic SQL flip; the workflow just
        chains the activity.
    """

    @workflow.run
    async def run(
        self, older_than_ms: int = DEFAULT_COLD_AFTER_MS,
    ) -> FilesColdArchiveResult:
        workflow.logger.info(
            "files_cold_archive.start older_than_ms=%d",
            older_than_ms,
        )
        result = FilesColdArchiveResult()

        # ── pull candidates ───────────────────────────────────────────────
        try:
            candidates = await workflow.execute_activity(
                find_cold_candidates,
                args=[int(older_than_ms)],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    initial_interval=timedelta(seconds=2),
                    backoff_coefficient=2.0,
                    maximum_interval=timedelta(seconds=10),
                ),
            )
        except Exception as exc:  # noqa: BLE001
            result.errors.append(f"find_cold_candidates failed: {exc}")
            workflow.logger.error(
                "files_cold_archive: candidate fetch failed: %s", exc,
            )
            return result

        result.candidates_total = len(candidates)
        if not candidates:
            workflow.logger.info(
                "files_cold_archive: no candidates — nothing to do"
            )
            return result

        # ── per-entry promotion loop ──────────────────────────────────────
        for entry in candidates:
            file_id = str(entry.get("id") or "")
            size_bytes = int(entry.get("size_bytes") or 0)
            if not file_id:
                result.errors.append(
                    f"skipping entry with no id: {entry!r}"
                )
                continue

            try:
                promote_resp = await workflow.execute_activity(
                    promote_to_cold,
                    args=[file_id],
                    # Generous timeout: 90 days of single-file data could
                    # be hundreds of MB; zstd level 19 is the CPU sink
                    # but tenant-VM CPUs are not turbocharged.
                    start_to_close_timeout=timedelta(minutes=10),
                    retry_policy=RetryPolicy(
                        # One retry — the compression + atomic swap is
                        # already idempotent on ctrl-api's side. Re-running
                        # against an already-cold file is a no-op.
                        maximum_attempts=2,
                        initial_interval=timedelta(seconds=5),
                        backoff_coefficient=2.0,
                        maximum_interval=timedelta(seconds=20),
                    ),
                )
            except Exception as exc:  # noqa: BLE001
                # Per-file failure — log, accumulate, keep going.
                result.errors.append(
                    f"promote_to_cold({file_id}) failed: {exc}"
                )
                workflow.logger.warning(
                    "files_cold_archive: promote failed for %s — leaving "
                    "for next sweep (%s)",
                    file_id, exc,
                )
                continue

            if promote_resp.get("already_cold"):
                result.already_cold.append(file_id)
                continue

            result.promoted.append(file_id)
            result.live_bytes_freed += int(
                promote_resp.get("live_bytes") or size_bytes
            )
            result.cold_bytes_written += int(
                promote_resp.get("cold_bytes") or 0
            )

        workflow.logger.info(
            "files_cold_archive.done candidates=%d promoted=%d "
            "already_cold=%d live_freed=%d cold_written=%d errors=%d",
            result.candidates_total,
            len(result.promoted),
            len(result.already_cold),
            result.live_bytes_freed,
            result.cold_bytes_written,
            len(result.errors),
        )
        return result
