"""Bulk-archive every orphan vault task (no matter linkage) via ctrl-api PATCH.

An orphan is any vault task with no scalar ``matter`` / ``related_matter`` AND
no non-empty ``related_matters`` list. These tasks have accumulated over time
from curator runs that couldn't resolve a matter, speculative "while you're at
it" nudges from the generator, and stream-ingested nudges that never got
linked. On David's vault this pool numbers in the thousands.

Running this script is **destructive-ish**: it PATCHes `archived: true`,
`status: cancelled`, `archived_at`, and `archived_reason` onto every orphan's
frontmatter. No files are deleted from disk — the vault retains the record so
an ``unarchive`` script can flip ``archived`` back to false later. The
companion forward-sync change (PR #580) cascades the archive to a Plane issue
DELETE within one ~15s tick.

USAGE
-----

Runs inside the ``alfred-learn`` container (reads ``AAS_API_KEY`` from the
tenant env; the script refuses to run without it)::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.archive_orphan_tasks [flags]

Flags::

    --dry-run                  Print what would happen without PATCHing (default off).
    --batch-size 50            Log a progress line every N archived tasks (default 50).
    --reason <string>          Value for ``archived_reason`` frontmatter
                               (default "plane_sync_orphan_cleanup").
    --skip-recent-days N       Leave tasks updated/created in the last N days
                               alone (default 0 = archive all orphans).
    --verbose                  DEBUG-level logging.
    --tenant-id <id>           Optional — for summary output only.

SAFETY RULES (enforced programmatically)
----------------------------------------

1. We re-fetch every task's CURRENT frontmatter right before the PATCH. If in
   the time between the initial listing and the PATCH a concurrent process
   (e.g. the matter-linkage backfill) added a ``related_matters`` entry, we
   abort the PATCH — that task is no longer an orphan.
2. Agent-managed tasks (``agent_id`` or ``skill_entry`` frontmatter) are
   skipped regardless of matter linkage. Those are task-runner execution
   rows, not user errands.
3. Status is coerced to ``cancelled`` (schema-valid) in the SAME PATCH as
   the archive flag so the vault edit validator doesn't bounce a task with
   a legacy ``pending`` status.
4. The script is idempotent: if the task is already archived when we re-read
   it, we skip without a write.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx

from src.config import load_config

logger = logging.getLogger("archive-orphan-tasks")


# -----------------------------------------------------------------------------
# CLI parsing
# -----------------------------------------------------------------------------


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="archive_orphan_tasks",
        description="Archive every orphan vault task (no matter linkage).",
    )
    p.add_argument(
        "--tenant-id",
        default=os.environ.get("TENANT_ID", ""),
        help="Optional tenant identifier (logging/summary only).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would happen without writing anything.",
    )
    p.add_argument(
        "--batch-size",
        type=int,
        default=50,
        help="Tasks per progress heartbeat line (default 50).",
    )
    p.add_argument(
        "--reason",
        default="plane_sync_orphan_cleanup",
        help=(
            "Value for the `archived_reason` frontmatter field "
            "(default 'plane_sync_orphan_cleanup')."
        ),
    )
    p.add_argument(
        "--skip-recent-days",
        type=int,
        default=0,
        help=(
            "Leave tasks updated/created within the last N days alone. "
            "Default 0 = archive every orphan regardless of recency."
        ),
    )
    p.add_argument("--verbose", action="store_true", help="DEBUG-level logging.")
    return p.parse_args(argv)


# -----------------------------------------------------------------------------
# Matter-resolution helper — reuse the exact rules from plane_sync so we
# agree with the forward-sync worker on what counts as "orphan".
# -----------------------------------------------------------------------------

from src.activities.plane_sync import _resolve_task_matter  # noqa: E402


# -----------------------------------------------------------------------------
# ctrl-api client
# -----------------------------------------------------------------------------


class CtrlClient:
    """Minimal async client for the vault endpoints we need here."""

    def __init__(self) -> None:
        cfg = load_config()
        api_key = os.environ.get("AAS_API_KEY", "")
        if not api_key:
            raise RuntimeError(
                "AAS_API_KEY is not set — this script must run inside the "
                "alfred-learn container (or with the env exported).",
            )
        self._client = httpx.AsyncClient(
            base_url=cfg.alfred_ctrl_url,
            timeout=30.0,
            headers={"Authorization": f"Bearer {api_key}"},
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def list_tasks(self) -> list[dict[str, Any]]:
        resp = await self._client.get("/api/v1/vault/list/task")
        resp.raise_for_status()
        return resp.json().get("results", [])

    async def read_record(self, path: str) -> dict[str, Any]:
        resp = await self._client.get(f"/api/v1/vault/records/{path}")
        resp.raise_for_status()
        return resp.json()

    async def patch_record(
        self,
        path: str,
        *,
        set_fields: dict[str, Any],
    ) -> None:
        body = {"set": {k: _stringify(v) for k, v in set_fields.items()}}
        resp = await self._client.patch(
            f"/api/v1/vault/records/{path}", json=body
        )
        resp.raise_for_status()


def _stringify(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return ""
    return str(v)


# -----------------------------------------------------------------------------
# Orphan filter — the same shape as plane_sync's _resolve_task_matter but
# we add the agent-managed + recency guards.
# -----------------------------------------------------------------------------


def _is_agent_managed(fm: dict[str, Any]) -> bool:
    """Skip task-runner execution rows. These have `agent_id` (ephemeral
    agent owner) or `skill_entry` (chore deployment marker).
    """
    return bool(fm.get("agent_id") or fm.get("skill_entry"))


def _is_archived(fm: dict[str, Any]) -> bool:
    val = fm.get("archived")
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.strip().lower() == "true"
    return False


def _is_orphan(fm: dict[str, Any]) -> bool:
    """Mirror the negative of plane_sync._resolve_task_matter: no matter
    ref resolves across any of the three field conventions.
    """
    return _resolve_task_matter(fm) is None


def _parse_iso_ts(s: Any) -> datetime | None:
    if not isinstance(s, str) or not s.strip():
        return None
    t = s.strip().replace(" ", "T", 1)
    # Trim Python-incompatible sub-microsecond fractional parts
    if "." in t:
        base, _, rest = t.partition(".")
        frac_digits = ""
        tz_rest = ""
        for i, ch in enumerate(rest):
            if ch.isdigit():
                frac_digits += ch
            else:
                tz_rest = rest[i:]
                break
        frac_digits = frac_digits[:6]
        t = f"{base}.{frac_digits}{tz_rest}" if frac_digits else f"{base}{tz_rest}"
    t = t.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(t)
    except ValueError:
        # Date-only form like "2026-04-08"
        try:
            dt = datetime.strptime(t, "%Y-%m-%d")
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _most_recent_timestamp(
    fm: dict[str, Any], top_level: dict[str, Any]
) -> datetime | None:
    """Derive the most recent "activity" time from a task — used by the
    --skip-recent-days gate. Checks ``updated`` / ``modified`` / ``created``
    on the frontmatter, falling back to top-level ``created``.
    """
    best: datetime | None = None
    for key in ("updated", "modified", "created"):
        dt = _parse_iso_ts(fm.get(key))
        if dt and (best is None or dt > best):
            best = dt
    top_dt = _parse_iso_ts(top_level.get("created"))
    if top_dt and (best is None or top_dt > best):
        best = top_dt
    return best


# -----------------------------------------------------------------------------
# Stats
# -----------------------------------------------------------------------------


@dataclass
class ArchiveStats:
    tasks_examined: int = 0
    orphans_detected: int = 0
    agent_managed_skipped: int = 0
    already_archived_skipped: int = 0
    recent_skipped: int = 0
    not_orphan_on_reread_skipped: int = 0
    archived: int = 0
    write_errors: int = 0
    error_messages: list[str] = field(default_factory=list)
    started_at: float = 0.0
    finished_at: float = 0.0


# -----------------------------------------------------------------------------
# Core loop
# -----------------------------------------------------------------------------


async def _archive_one(
    ctrl: CtrlClient,
    path: str,
    fm_current: dict[str, Any],
    *,
    reason: str,
    dry_run: bool,
) -> None:
    """Issue the PATCH. Assumes the caller already verified the task is
    still an orphan + not already archived + not agent-managed.
    """
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    set_fields: dict[str, Any] = {
        "archived": True,
        "status": "cancelled",
        "archived_at": now_iso,
        "archived_reason": reason,
    }
    if dry_run:
        logger.info("DRY-RUN: would archive %s (reason=%s)", path, reason)
        return
    await ctrl.patch_record(path, set_fields=set_fields)


async def _run(args: argparse.Namespace) -> ArchiveStats:
    stats = ArchiveStats()
    stats.started_at = time.time()

    ctrl = CtrlClient()
    try:
        logger.info(
            "archive_orphan_tasks: tenant=%s, dry_run=%s, reason=%s, "
            "batch_size=%d, skip_recent_days=%d",
            args.tenant_id or "(unspecified)",
            args.dry_run,
            args.reason,
            args.batch_size,
            args.skip_recent_days,
        )

        records = await ctrl.list_tasks()
        stats.tasks_examined = len(records)
        logger.info("archive_orphan_tasks: %d total tasks in vault", len(records))

        # First-pass filter — identify candidates on the in-memory list.
        now = datetime.now(timezone.utc)
        recent_cutoff: datetime | None = None
        if args.skip_recent_days > 0:
            from datetime import timedelta
            recent_cutoff = now - timedelta(days=args.skip_recent_days)

        candidates: list[tuple[str, dict[str, Any]]] = []
        for rec in records:
            path = rec.get("path", "")
            if not path.startswith("task/") or not path.endswith(".md"):
                continue
            fm = rec.get("frontmatter") or {}
            if _is_archived(fm):
                stats.already_archived_skipped += 1
                continue
            if _is_agent_managed(fm):
                stats.agent_managed_skipped += 1
                continue
            if not _is_orphan(fm):
                continue
            if recent_cutoff is not None:
                ts = _most_recent_timestamp(fm, rec)
                if ts is not None and ts >= recent_cutoff:
                    stats.recent_skipped += 1
                    continue
            candidates.append((path, fm))

        stats.orphans_detected = len(candidates)
        logger.info(
            "archive_orphan_tasks: candidates=%d "
            "(agent_managed_skipped=%d, already_archived_skipped=%d, "
            "recent_skipped=%d)",
            len(candidates),
            stats.agent_managed_skipped,
            stats.already_archived_skipped,
            stats.recent_skipped,
        )

        if not candidates:
            logger.info("archive_orphan_tasks: nothing to do.")
            return stats

        # Second pass — for each candidate, RE-READ the record's current
        # frontmatter and re-verify orphan status. This is the race guard
        # against the concurrent matter-linkage backfill script.
        for idx, (path, _fm_initial) in enumerate(candidates, start=1):
            try:
                latest = await ctrl.read_record(path)
            except httpx.HTTPError as exc:
                stats.write_errors += 1
                msg = f"read {path}: {exc}"[:500]
                stats.error_messages.append(msg)
                logger.warning("archive_orphan_tasks: %s", msg)
                continue

            fm_current = latest.get("frontmatter") or {}

            # Re-check the guards against the freshly read frontmatter.
            if _is_archived(fm_current):
                stats.already_archived_skipped += 1
                continue
            if _is_agent_managed(fm_current):
                stats.agent_managed_skipped += 1
                continue
            if not _is_orphan(fm_current):
                # Backfill just linked this task; leave it alone.
                stats.not_orphan_on_reread_skipped += 1
                logger.debug(
                    "archive_orphan_tasks: %s no longer orphan on re-read, "
                    "skipping",
                    path,
                )
                continue

            try:
                await _archive_one(
                    ctrl, path, fm_current,
                    reason=args.reason,
                    dry_run=args.dry_run,
                )
                stats.archived += 1
            except httpx.HTTPError as exc:
                stats.write_errors += 1
                msg = f"patch {path}: {exc}"[:500]
                stats.error_messages.append(msg)
                logger.warning("archive_orphan_tasks: %s", msg)
                continue

            if stats.archived % args.batch_size == 0:
                logger.info(
                    "archive_orphan_tasks: archived %d/%d (latest: %s)",
                    stats.archived,
                    len(candidates),
                    path,
                )
    finally:
        await ctrl.close()

    stats.finished_at = time.time()
    _print_summary(args, stats)
    return stats


def _print_summary(args: argparse.Namespace, stats: ArchiveStats) -> None:
    runtime = stats.finished_at - stats.started_at
    print("\n" + "=" * 72)
    print("ARCHIVE ORPHAN TASKS SUMMARY")
    print("=" * 72)
    print(f"tenant:                         {args.tenant_id or '(unspecified)'}")
    print(f"mode:                           {'DRY-RUN' if args.dry_run else 'LIVE'}")
    print(f"archive_reason:                 {args.reason}")
    print(f"skip_recent_days:               {args.skip_recent_days}")
    print(f"tasks examined:                 {stats.tasks_examined}")
    print(f"orphans detected:               {stats.orphans_detected}")
    print(f"agent-managed skipped:          {stats.agent_managed_skipped}")
    print(f"already archived skipped:       {stats.already_archived_skipped}")
    print(f"recent-updated skipped:         {stats.recent_skipped}")
    print(f"no-longer-orphan on re-read:    {stats.not_orphan_on_reread_skipped}")
    print(f"archived:                       {stats.archived}")
    print(f"write errors:                   {stats.write_errors}")
    print(f"runtime:                        {runtime:0.1f}s")
    if stats.error_messages:
        print("\nfirst 5 error messages:")
        for msg in stats.error_messages[:5]:
            print(f"  - {msg}")
    print("=" * 72)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        asyncio.run(_run(args))
    except KeyboardInterrupt:
        print("\narchive_orphan_tasks: interrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001 — top-level, non-zero exit
        logger.exception("archive_orphan_tasks: failed: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
