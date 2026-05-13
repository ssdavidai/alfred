"""Bulk-archive every cold vault task via ctrl-api PATCH.

A "cold" task is one whose most recent touch (frontmatter ``as_of``,
``updated``, or ``created``) is older than --threshold-days (default 30).
These are tasks the system extracted at some point but nothing has acted
on, narratively or operationally, in a month or more. On David's vault
this pool is ~75% of the open-task population.

This script PATCHes four fields onto each cold task's frontmatter:

  * ``archived: true``        — boolean flag (matches the orphan-archive
                                convention)
  * ``state: archived``       — canonical state value used by matters.ts
                                so the matter counters drop
  * ``archived_at: <iso>``    — when this archival fired
  * ``archived_reason: cold_inactive_<N>d`` — provenance

Same idempotency semantics as ``archive_orphan_tasks.py``: re-running is
safe — already-archived tasks are skipped.

USAGE
-----

Inside the ``alfred-learn`` container (reads ``AAS_API_KEY`` from env)::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.cold_task_archival [flags]

Flags::

    --dry-run                  Print what would happen without PATCHing.
    --threshold-days N         Cold threshold in days (default 30).
    --batch-size N             Log progress every N tasks (default 50).
    --reason <string>          Override the default reason string.
    --verbose                  DEBUG-level logging.

SAFETY RULES
------------

1. Re-fetch the task's CURRENT frontmatter right before each PATCH. If
   it was touched in the meantime (e.g. nightly_narrative ran a fresh
   as_of), we abort the PATCH — that task is no longer cold.
2. Skip tasks that are already done (``state: done`` or ``status:
   completed``) — done is a different terminal state than archived.
3. Skip tasks that are already archived under any convention.
4. Skip agent-managed task_runner rows (``skill_entry`` in frontmatter
   only, no human-facing role).
5. ``--dry-run`` is supported and recommended for first execution per
   tenant.

SM-D-W5 — STATE-MUTATOR V2 RETROFIT
-----------------------------------

Per ``docs/STATE-MUTATION.md`` §7 W5, the archival sweep is a state
writer: every successful archive bumps ``status`` from open to
``archived``. The retrofit layers a universal v2 audit on top of the
legacy PATCH so /decisions and the task detail timeline see
``source="archival_sweep"`` entries alongside the lifecycle move. The
deterministic propose function ``archival_sweep.cold`` lives in
``src/activities/archival_sweep.py`` (registered via
``@propose_fn("archival_sweep.cold")``); it returns
``ProposedMutation({"status": "archived"}, confidence=1.0)`` for tasks
whose current vault status is not yet terminal.

The retrofit is env-gated rather than gated via ``workflow.patched`` —
the archival sweep is a standalone asyncio script, not a Temporal
workflow, so Temporal replay-determinism rules in
``packages/learn/CLAUDE.md`` don't apply here. Flip
``ARCHIVAL_SWEEP_STATE_MUTATOR_V1=true`` in the env to enable v2 audit
emission; the legacy PATCH path keeps the ``archived``, ``state``,
``archived_at``, and ``archived_reason`` writes load-bearing on its own
so a failed v2 audit never blocks the actual archival. Defaults off so
existing behaviour is unchanged.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx


logger = logging.getLogger("cold_task_archival")


# SM-D-W5 — env gate for the state-mutator v2 audit emission. Default
# off so this script continues to behave exactly as before for tenants
# still on the un-retrofitted path; flip to "true" once Phase D rollout
# has reached the tenant. See module docstring for the rationale on
# preferring an env flag to ``workflow.patched`` (no workflow here).
_STATE_MUTATOR_ENV = "ARCHIVAL_SWEEP_STATE_MUTATOR_V1"


def _state_mutator_enabled() -> bool:
    raw = (os.environ.get(_STATE_MUTATOR_ENV) or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------


@dataclass
class Config:
    alfred_ctrl_url: str = os.environ.get(
        "ALFRED_CTRL_URL", "http://ctrl-api:3100",
    )


def load_config() -> Config:
    return Config()


# -----------------------------------------------------------------------------
# ctrl-api client (mirrors archive_orphan_tasks.py shape)
# -----------------------------------------------------------------------------


def _stringify(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


class CtrlClient:
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
        self, path: str, *, set_fields: dict[str, Any],
    ) -> None:
        body = {"set": {k: _stringify(v) for k, v in set_fields.items()}}
        resp = await self._client.patch(
            f"/api/v1/vault/records/{path}", json=body,
        )
        resp.raise_for_status()


# -----------------------------------------------------------------------------
# Cold detection
# -----------------------------------------------------------------------------


def _parse_iso(s: Any) -> Optional[datetime]:
    if not isinstance(s, str) or not s.strip():
        return None
    raw = s.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def classify_age(
    fm: dict[str, Any], now: datetime, threshold_days: int,
) -> str:
    """Return 'warm' / 'cold_stale' / 'cold_untouched' / 'unknown_age'.

    Two distinct flavours of cold:

      cold_stale     — `as_of` or `updated` exists AND is >threshold_days
                       old. The system DID touch this task at some
                       point and then went quiet.
      cold_untouched — no `as_of` and no `updated` AND `created` is
                       >threshold_days old. The task landed in a bulk
                       import / extraction and nothing has ever acted
                       on it. Easy to recognise on a freshly
                       bootstrapped tenant where every task is the
                       same age.

    `unknown_age` means we can't parse any timestamp — leave alone.
    """
    as_of = _parse_iso(fm.get("as_of"))
    updated = _parse_iso(fm.get("updated"))
    created = _parse_iso(fm.get("created"))
    cutoff = now - timedelta(days=threshold_days)

    touches = [t for t in (as_of, updated) if t is not None]
    if touches:
        latest = max(touches)
        return "cold_stale" if latest < cutoff else "warm"

    if created is None:
        return "unknown_age"
    return "cold_untouched" if created < cutoff else "warm"


def is_already_terminal(fm: dict[str, Any]) -> bool:
    """Skip tasks already in a terminal state."""
    if fm.get("archived") is True or str(fm.get("archived", "")).lower() == "true":
        return True
    state = str(fm.get("state", "")).lower().strip()
    if state in ("archived", "done", "completed", "complete"):
        return True
    status = str(fm.get("status", "")).lower().strip()
    if status in ("archived", "cancelled", "canceled", "completed", "complete", "done"):
        return True
    return False


def is_agent_managed(fm: dict[str, Any]) -> bool:
    """Agent-managed task_runner execution rows aren't user errands.

    Match the rule from ``archive_orphan_tasks.py``: ``skill_entry``
    present in frontmatter is the marker. ``agent_id`` alone is not —
    learn-clerk authors real user-facing tasks too.
    """
    return "skill_entry" in fm


# -----------------------------------------------------------------------------
# Main flow
# -----------------------------------------------------------------------------


@dataclass
class Stats:
    scanned: int = 0
    cold_stale: int = 0
    cold_untouched: int = 0
    already_terminal: int = 0
    agent_managed: int = 0
    unknown_age: int = 0
    warm: int = 0
    archived_now: int = 0
    skipped_race: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)
    # SM-D-W5 — v2 audit counters. ``v2_emitted`` increments per
    # successful state-change audit; ``v2_failed`` increments when the
    # legacy PATCH landed but the v2 emit raised (audit is best-effort
    # so the script does NOT roll back the archive).
    v2_emitted: int = 0
    v2_failed: int = 0

    @property
    def cold(self) -> int:
        return self.cold_stale + self.cold_untouched


async def _run(args: argparse.Namespace) -> Stats:
    stats = Stats()
    ctrl = CtrlClient()
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=args.threshold_days)
    reason = args.reason or f"cold_inactive_{args.threshold_days}d"

    try:
        tasks = await ctrl.list_tasks()
    except httpx.HTTPError as exc:
        logger.error("list tasks failed: %s", exc)
        stats.errors += 1
        stats.error_messages.append(f"list_tasks: {exc}"[:500])
        await ctrl.close()
        return stats

    stats.scanned = len(tasks)
    logger.info(
        "scanned %d tasks; threshold %dd (cutoff %s)",
        len(tasks),
        args.threshold_days,
        cutoff.isoformat(timespec="seconds"),
    )

    for idx, task in enumerate(tasks):
        if idx and idx % args.batch_size == 0:
            logger.info(
                "progress %d/%d cold=%d archived_now=%d skipped=%d",
                idx,
                len(tasks),
                stats.cold,
                stats.archived_now,
                stats.already_terminal + stats.agent_managed + stats.unknown_age,
            )

        fm = task.get("frontmatter", {}) or {}
        path = task.get("path") or task.get("relPath") or ""
        if not path:
            continue

        if is_agent_managed(fm):
            stats.agent_managed += 1
            continue

        if is_already_terminal(fm):
            stats.already_terminal += 1
            continue

        kind = classify_age(fm, now, args.threshold_days)
        if kind == "warm":
            stats.warm += 1
            continue
        if kind == "unknown_age":
            stats.unknown_age += 1
            continue
        if kind == "cold_stale":
            stats.cold_stale += 1
        elif kind == "cold_untouched":
            stats.cold_untouched += 1

        if args.dry_run:
            logger.debug("DRY-RUN %s task: %s", kind, path)
            continue

        # Re-read to catch concurrent touches between list and patch.
        try:
            current = await ctrl.read_record(path)
        except httpx.HTTPError as exc:
            stats.errors += 1
            stats.error_messages.append(f"reread {path}: {exc}"[:500])
            continue

        current_fm = current.get("frontmatter", {}) or {}
        if is_already_terminal(current_fm):
            stats.already_terminal += 1
            continue
        current_kind = classify_age(current_fm, now, args.threshold_days)
        if current_kind == "warm":
            stats.skipped_race += 1
            continue

        try:
            await ctrl.patch_record(
                path,
                set_fields={
                    "archived": True,
                    "state": "archived",
                    "archived_at": now.isoformat(timespec="seconds"),
                    "archived_reason": reason,
                },
            )
            stats.archived_now += 1
            logger.debug("archived %s", path)
        except httpx.HTTPError as exc:
            stats.errors += 1
            stats.error_messages.append(f"patch {path}: {exc}"[:500])
            continue

        # SM-D-W5 — env-gated v2 audit emission. The legacy PATCH above
        # owns the archived/state/archived_at/archived_reason writes;
        # this call layers a ``state_change`` audit + timeline entry on
        # top so /decisions and the task detail page see
        # ``source=archival_sweep`` alongside the lifecycle move.
        # Best-effort: any failure here is recorded on stats but never
        # rolls back the archive (the PATCH already landed; rolling
        # back would mean undoing the de-clutter the sweep just did).
        if _state_mutator_enabled():
            try:
                await _emit_state_change_v2(
                    path=path,
                    prior_fm=current_fm,
                    reason=reason,
                    when=now,
                )
                stats.v2_emitted += 1
            except Exception as exc:  # noqa: BLE001 — audit is best effort
                stats.v2_failed += 1
                logger.warning(
                    "v2 audit emit failed task=%s err=%s", path, exc,
                )

    await ctrl.close()
    return stats


# -----------------------------------------------------------------------------
# SM-D-W5 — state-mutator v2 audit emission
# -----------------------------------------------------------------------------


async def _emit_state_change_v2(
    *,
    path: str,
    prior_fm: dict[str, Any],
    reason: str,
    when: datetime,
) -> None:
    """Layer a v2 ``state_change`` audit on a successful cold-task archive.

    Calls ``apply_state_change_v2`` in-process (Pattern B per
    ``docs/STATE-MUTATION.md`` §6.2) — the script is not running inside
    a Temporal workflow so there's no ``workflow.execute_activity``
    available. The propose function ``archival_sweep.cold`` is
    registered by ``src.activities.archival_sweep`` at import time;
    importing the module here is enough to populate the registry.

    The propose function returns ``None`` when the target's current
    status is already ``archived`` (idempotent — re-running the sweep
    over an already-archived task never lands a duplicate audit).
    """
    # Local imports keep this script standalone: the script can still
    # be exercised on a workstation that doesn't have all alfred-learn
    # runtime deps if the v2 flag is off.
    from src.activities import archival_sweep as _archival_sweep  # noqa: F401 — register propose_fn
    from src.activities.state_mutator import (
        ObservedWindow,
        apply_state_change_v2,
    )

    prior_as_of = prior_fm.get("as_of") if isinstance(prior_fm, dict) else None
    prior_as_of_str = (
        str(prior_as_of).strip()
        if isinstance(prior_as_of, str) and prior_as_of
        else None
    )
    end = when if when.tzinfo else when.replace(tzinfo=timezone.utc)
    start = _parse_iso(prior_as_of_str) if prior_as_of_str else None
    observed = ObservedWindow(
        start=start or end,
        end=end,
        signal_paths=[],
        decision_paths=[],
        other_refs=[],
    )
    await apply_state_change_v2(
        target_path=path,
        source="archival_sweep",
        observed=observed,
        propose_fn_name="archival_sweep.cold",
        propose_fn_args={
            "reason": reason,
            "prior_status": prior_fm.get("status") if isinstance(prior_fm, dict) else None,
            "prior_state": prior_fm.get("state") if isinstance(prior_fm, dict) else None,
        },
        mode="live",
        expected_as_of=prior_as_of_str,
    )


def _print_summary(stats: Stats, args: argparse.Namespace) -> None:
    print(f"scanned:           {stats.scanned}")
    print(f"warm:              {stats.warm}")
    print(f"agent_managed:     {stats.agent_managed}")
    print(f"already_terminal:  {stats.already_terminal}")
    print(f"unknown_age:       {stats.unknown_age}")
    print(f"cold (threshold {args.threshold_days}d):")
    print(f"  cold_stale     {stats.cold_stale}  (as_of/updated >{args.threshold_days}d old)")
    print(f"  cold_untouched {stats.cold_untouched}  (no touch since creation >{args.threshold_days}d ago)")
    print(f"archived_now:      {stats.archived_now}")
    print(f"skipped_race:      {stats.skipped_race}")
    print(f"errors:            {stats.errors}")
    if _state_mutator_enabled():
        print(f"v2_audits_emitted: {stats.v2_emitted}")
        print(f"v2_audits_failed:  {stats.v2_failed}")
    if stats.error_messages:
        print("first errors:")
        for m in stats.error_messages[:5]:
            print(f"  - {m}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--threshold-days", type=int, default=30)
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--reason", type=str, default=None)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    stats = asyncio.run(_run(args))
    _print_summary(stats, args)
    return 1 if stats.errors else 0


if __name__ == "__main__":
    sys.exit(main())
