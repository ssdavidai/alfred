"""ComposioReconnectCleanupWorkflow — Temporal-scheduled reaper for #645.

Background
----------

PR #646's ``POST /api/v1/integrations/:id/reconnect`` endpoint creates
a fresh Composio connected_account while the old one is still alive,
then waits ``RECONNECT_GRACE_MS`` (1 hour) before deleting the old one.
Cleanup currently has two paths:

  1. In-process ``setTimeout`` fast path (works while ctrl-api stays up).
  2. Lazy reaper triggered by every reconnect call + manual
     ``POST /api/v1/integrations/reconnect-cleanup`` poke.

Gap: if no new reconnects fire and ctrl-api restarts before the grace
window elapses, the ledger entry sits forever — neither the in-process
timer nor the lazy reaper has any reason to wake up. Filed as #645.

This workflow is the safety net. Runs every 15 minutes against the
same persistent ledger file, applies the same verify-then-delete-then-
purge semantics. Coexists with the ctrl-api fast path because the
ledger has idempotent semantics — whichever side wins the race, wins,
and the loser cleanly no-ops on its next attempt.

Design
------

* Pure orchestration. All Composio interactions + ledger I/O live in
  ``src/activities/composio_reconnect.py``.
* Per-entry error isolation: a transient Composio outage on one entry
  cannot poison the workflow run or strand the others.
* Workflow is idempotent and safe to run with overlap=SKIP — every
  invocation is a fresh scan of the on-disk ledger.
* Workflow takes no arguments. The ledger is the source of truth.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.composio_reconnect import (
        delete_old_connection,
        read_reconnect_ledger,
        remove_ledger_entry,
        verify_new_connection_active,
    )


@dataclass
class ReconnectCleanupResult:
    entries_total: int = 0
    entries_skipped_future: int = 0
    deleted: list[str] = field(default_factory=list)
    purged: list[str] = field(default_factory=list)  # new connection vanished
    kept_initiated: list[str] = field(default_factory=list)
    kept_failed: list[str] = field(default_factory=list)  # FAILED / EXPIRED / other non-ACTIVE
    errors: list[str] = field(default_factory=list)


@workflow.defn(name="ComposioReconnectCleanupWorkflow")
class ComposioReconnectCleanupWorkflow:
    """Drain past-due entries from the Composio reconnect ledger.

    For each ledger entry whose ``cleanup_after_ms`` is past:

      * Verify the new connection is ``ACTIVE`` via
        ``verify_new_connection_active``.
      * If yes → ``delete_old_connection`` + ``remove_ledger_entry``.
      * If the new connection is ``INITIATED`` (OAuth handshake never
        completed) → leave the entry alone, log a warning, move on.
      * If the new connection is ``FAILED`` / ``EXPIRED`` / anything
        else non-``ACTIVE`` → also leave alone + log so we don't strand
        the user without a working connection.
      * If the new connection 404'd in Composio → purge the ledger
        entry (nothing to verify against; the ctrl-api fast path
        treats this the same way).

    Each per-entry step is wrapped in its own try/except — one bad
    entry never blocks the rest of the run.
    """

    @workflow.run
    async def run(self) -> ReconnectCleanupResult:
        workflow.logger.info("composio_reconnect_cleanup.start")
        result = ReconnectCleanupResult()

        try:
            entries: list[dict] = await workflow.execute_activity(
                read_reconnect_ledger,
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    initial_interval=timedelta(seconds=2),
                    backoff_coefficient=2.0,
                    maximum_interval=timedelta(seconds=10),
                ),
            )
        except Exception as exc:  # noqa: BLE001
            result.errors.append(f"read_reconnect_ledger failed: {exc}")
            workflow.logger.error(
                "composio_reconnect_cleanup: ledger read failed: %s", exc,
            )
            return result

        result.entries_total = len(entries)
        if not entries:
            workflow.logger.info(
                "composio_reconnect_cleanup: ledger empty — nothing to do"
            )
            return result

        # Workflow time is deterministic — `workflow.now()` returns a UTC
        # datetime backed by Temporal history, so two replays compare
        # entries against the same instant.
        now_ms = int(workflow.now().timestamp() * 1000)

        for entry in entries:
            old_id = str(entry.get("old_connection_id") or "")
            new_id = str(entry.get("new_connection_id") or "")
            cleanup_ms = int(entry.get("cleanup_after_ms") or 0)

            if not old_id or not new_id:
                # Defensive — read_reconnect_ledger should have dropped these.
                result.errors.append(
                    f"skipping entry with missing ids: old={old_id!r} new={new_id!r}"
                )
                continue

            if cleanup_ms > now_ms:
                result.entries_skipped_future += 1
                workflow.logger.info(
                    "composio_reconnect_cleanup: skip (grace not elapsed) old=%s",
                    old_id,
                )
                continue

            # ----- per-entry try/except boundary -----
            try:
                verify_result: dict = await workflow.execute_activity(
                    verify_new_connection_active,
                    args=[new_id],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(
                        maximum_attempts=3,
                        initial_interval=timedelta(seconds=2),
                        backoff_coefficient=2.0,
                        maximum_interval=timedelta(seconds=15),
                    ),
                )
            except Exception as exc:  # noqa: BLE001
                # Network/Composio outage on THIS entry — leave it for next tick.
                result.errors.append(
                    f"verify_new_connection_active({new_id}) failed: {exc}"
                )
                workflow.logger.warning(
                    "composio_reconnect_cleanup: verify failed for old=%s — "
                    "leaving entry for next tick (%s)",
                    old_id, exc,
                )
                continue

            exists = bool(verify_result.get("exists"))
            status = str(verify_result.get("status") or "").upper()

            if not exists:
                # New connection vanished → purge ledger entry; the old one
                # may or may not still be there but it's not our problem
                # to chase if its paired new id is gone.
                try:
                    await workflow.execute_activity(
                        remove_ledger_entry,
                        args=[old_id],
                        start_to_close_timeout=timedelta(seconds=10),
                        retry_policy=RetryPolicy(
                            maximum_attempts=3,
                            initial_interval=timedelta(seconds=2),
                            backoff_coefficient=2.0,
                            maximum_interval=timedelta(seconds=10),
                        ),
                    )
                    result.purged.append(old_id)
                    workflow.logger.info(
                        "composio_reconnect_cleanup: purged old=%s "
                        "(new=%s vanished from Composio)",
                        old_id, new_id,
                    )
                except Exception as exc:  # noqa: BLE001
                    result.errors.append(
                        f"remove_ledger_entry({old_id}) failed during purge: {exc}"
                    )
                    workflow.logger.warning(
                        "composio_reconnect_cleanup: purge ledger failed "
                        "for old=%s — will retry next tick (%s)",
                        old_id, exc,
                    )
                continue

            if status == "INITIATED":
                # OAuth handshake never completed — never delete the old
                # one in this state. Sir's apps still work; we just hope
                # he eventually completes the handshake.
                result.kept_initiated.append(old_id)
                workflow.logger.warning(
                    "composio_reconnect_cleanup: keep old=%s — new=%s still "
                    "INITIATED (OAuth handshake incomplete)",
                    old_id, new_id,
                )
                continue

            if status != "ACTIVE":
                # FAILED / EXPIRED / unknown — same outcome as INITIATED:
                # don't strand Sir without a working connection.
                result.kept_failed.append(old_id)
                workflow.logger.warning(
                    "composio_reconnect_cleanup: keep old=%s — new=%s status=%s "
                    "(non-ACTIVE)", old_id, new_id, status or "(empty)",
                )
                continue

            # ACTIVE → delete the old + purge ledger entry.
            try:
                await workflow.execute_activity(
                    delete_old_connection,
                    args=[old_id],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(
                        maximum_attempts=3,
                        initial_interval=timedelta(seconds=2),
                        backoff_coefficient=2.0,
                        maximum_interval=timedelta(seconds=15),
                    ),
                )
            except Exception as exc:  # noqa: BLE001
                result.errors.append(
                    f"delete_old_connection({old_id}) failed: {exc}"
                )
                workflow.logger.warning(
                    "composio_reconnect_cleanup: delete failed for old=%s — "
                    "will retry next tick (%s)",
                    old_id, exc,
                )
                continue

            try:
                await workflow.execute_activity(
                    remove_ledger_entry,
                    args=[old_id],
                    start_to_close_timeout=timedelta(seconds=10),
                    retry_policy=RetryPolicy(
                        maximum_attempts=3,
                        initial_interval=timedelta(seconds=2),
                        backoff_coefficient=2.0,
                        maximum_interval=timedelta(seconds=10),
                    ),
                )
                result.deleted.append(old_id)
                workflow.logger.info(
                    "composio_reconnect_cleanup: deleted old=%s + purged "
                    "ledger entry (new=%s ACTIVE)",
                    old_id, new_id,
                )
            except Exception as exc:  # noqa: BLE001
                # Awkward edge case: the Composio delete succeeded but the
                # ledger removal didn't. Next tick will see the entry,
                # re-verify, find the new connection still ACTIVE, attempt
                # the delete (which will 404 → treated as success), then
                # try the ledger removal again. Fully recoverable.
                result.errors.append(
                    f"remove_ledger_entry({old_id}) failed after delete: {exc}"
                )
                workflow.logger.warning(
                    "composio_reconnect_cleanup: ledger removal failed for "
                    "old=%s after delete — entry will retry next tick (%s)",
                    old_id, exc,
                )

        workflow.logger.info(
            "composio_reconnect_cleanup.done total=%d skipped_future=%d "
            "deleted=%d purged=%d kept_initiated=%d kept_failed=%d errors=%d",
            result.entries_total,
            result.entries_skipped_future,
            len(result.deleted),
            len(result.purged),
            len(result.kept_initiated),
            len(result.kept_failed),
            len(result.errors),
        )
        return result
