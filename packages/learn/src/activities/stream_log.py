"""Stream log activity — appends one-line entries to the daily stream log."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.state_client import StateClient
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


async def _stamp_chore_failure(workflow_type: str, error: str | None) -> None:
    """Mark the owning chore's vault record when its workflow run failed.

    Maps ``workflow_type`` back to a chore via the ``workflow_class_name``
    frontmatter field (the same binding the dynamic loader uses), then
    patches ``last_run`` / ``last_result`` so /chores shows the failure
    instead of the last successful run. No-ops for non-chore workflows.
    """
    if not workflow_type:
        return
    config = load_config()
    client = VaultClient(config)
    try:
        chores = await client.list_records("chore", limit=500)
        target: str | None = None
        for rec in chores:
            fm = rec.get("frontmatter") if isinstance(rec, dict) else None
            if not isinstance(fm, dict):
                continue
            if str(fm.get("workflow_class_name") or "").strip() == workflow_type:
                target = str(rec.get("path") or "")
                break
        if not target:
            return  # not a chore workflow — nothing to stamp
        detail = (error or "unknown error").replace("\n", " ")[:180]
        await client.patch_frontmatter(
            target,
            {
                "last_run": datetime.now(timezone.utc).isoformat(),
                "last_result": f"FAILED: {detail}",
            },
        )
        logger.info("chore failure stamped on %s (%s)", target, workflow_type)
    finally:
        await client.close()


_STREAM_LOG_HEADER = """\
---
type: note
name: Stream Log — {date}
status: active
tags: [stream-log, daily]
---

# Stream Log — {date}

"""


async def emit_workflow_audit_event(
    *,
    workflow_id: str,
    run_id: str,
    workflow_type: str,
    outcome: str,
    error: str | None = None,
    client: StateClient | None = None,
) -> None:
    """Best-effort ctrl-api audit emission for a Temporal workflow run."""
    summary = f"{workflow_type} {outcome}"
    if outcome == "failed" and error:
        summary = f"{summary}: {error}"
    state_client = client
    try:
        if state_client is None:
            state_client = StateClient(load_config())
        await state_client.append_audit(
            action_type="workflow_run",
            actor="alfred-learn",
            source="temporal",
            target_kind="workflow",
            subject_ref=workflow_id,
            summary=summary,
            payload={
                "workflow_id": workflow_id,
                "run_id": run_id,
                "workflow_type": workflow_type,
                "outcome": outcome,
            },
        )
    except Exception as exc:  # noqa: BLE001 — audit must never affect a run
        logger.warning(
            "workflow audit POST failed for %s/%s (%s): %s",
            workflow_id,
            run_id,
            outcome,
            str(exc)[:200],
        )

    finally:
        if client is None and state_client is not None:
            try:
                await state_client.close()
            except Exception as exc:  # noqa: BLE001 — best-effort cleanup
                logger.warning("workflow audit client close failed: %s", str(exc)[:200])

    # #366 follow-up — chore failures must be visible WITHOUT SSH.
    # `record_chore_run` only fires on success paths, so a chore whose run
    # throws leaves its vault record showing the last SUCCESSFUL run and
    # the dashboard reads it as healthy. Live example: trkblint showed a
    # green last_run while Temporal had two Failed scheduled ticks.
    #
    # Done here rather than in each of the 13 chore templates: this is the
    # one place every workflow failure already passes through.
    if outcome == "failed":
        try:
            await _stamp_chore_failure(workflow_type, error)
        except Exception as exc:  # noqa: BLE001 — never affect a run
            logger.warning(
                "chore failure stamp skipped for %s: %s",
                workflow_type, str(exc)[:200],
            )


@activity.defn
async def append_to_stream_log(stream_type: str, log_line: str) -> str:
    """Append a one-line entry to today's stream log in the vault.

    Writes to memory/stream-log-YYYY-MM-DD.md via ctrl-api.
    Creates the file with a header if it doesn't exist.
    Returns the log file path.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        now = datetime.now(timezone.utc)
        date_str = now.strftime("%Y-%m-%d")
        time_str = now.strftime("%H:%M")
        log_path = f"memory/stream-log-{date_str}.md"

        entry = f"- **{time_str}** [{stream_type}] {log_line}\n"

        # NOTE (#78): ``memory/`` is NOT a canonical vault type, so ctrl-api's
        # promotion contract 422s every write here. This activity is no longer
        # called on the hot path (EventProcessor stopped invoking it), but it
        # is kept tolerant: a contract rejection (422) or any other write
        # failure is downgraded to a warning + early return so a stray caller
        # can never wedge a workflow on infinite retries again (the original
        # bug — observed at attempt #219). The stream log is an audit-class
        # convenience, never load-bearing.
        try:
            try:
                await client.read_record(log_path)
                await client.update_record(log_path, entry)
            except httpx.HTTPStatusError as exc:
                # 404 → file doesn't exist yet, create it. Any other status
                # (incl. 422 contract rejection) falls through to the outer
                # handler below.
                if exc.response is not None and exc.response.status_code == 404:
                    header = _STREAM_LOG_HEADER.format(date=date_str)
                    await client.write_record(
                        "memory", f"stream-log-{date_str}", header + entry
                    )
                else:
                    raise
        except Exception as exc:  # noqa: BLE001 — advisory, never fatal
            logger.warning(
                "stream_log.append_to_stream_log: write skipped (%s) — "
                "non-fatal, stream log is audit-class",
                str(exc)[:120],
            )

        return log_path
    finally:
        await client.close()
