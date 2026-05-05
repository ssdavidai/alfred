"""One-shot migration: ensure ``matter/inbox.md`` exists + parent every orphan task.

Steward treats ``parent_matter`` as a hard invariant — every task must
belong to a matter so the per-matter Schedule has somewhere to find it.
Tasks with no resolvable matter ref get reparented to ``matter/inbox.md``,
a per-tenant catch-all.

Idempotent: re-running after a partial run is a no-op for already-fixed
tasks. Safe to chain after ``migrate_steward_schema.py``.

USAGE
-----

::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.migrate_inbox_matter [--dry-run]

Steps
-----

1. Ensure ``matter/inbox.md`` exists. If absent, create it with minimal
   frontmatter + the Steward schema fields already populated (so the
   schema migration doesn't need to revisit it).
2. List every task. For each task whose ``parent_matter`` is unset
   (and whose legacy fields ``matter`` / ``related_matters`` also fail
   to resolve), PATCH ``parent_matter: matter/inbox.md``.
3. Print a summary.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx

from src.config import load_config

logger = logging.getLogger("migrate-inbox-matter")


INBOX_MATTER_PATH = "matter/inbox.md"
INBOX_MATTER_NAME = "Inbox"
INBOX_MATTER_DESCRIPTION = "Steward home for orphan tasks."


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _next_check_iso() -> str:
    # +0s — Steward's first sweep on the inbox matter picks every
    # reparented task up immediately.
    return (datetime.now(timezone.utc) + timedelta(seconds=0)).isoformat(
        timespec="seconds",
    )


# ---------------------------------------------------------------------------
# ctrl-api client
# ---------------------------------------------------------------------------

class CtrlClient:
    def __init__(self) -> None:
        cfg = load_config()
        api_key = os.environ.get("AAS_API_KEY", "")
        if not api_key:
            raise RuntimeError(
                "AAS_API_KEY is not set — this script must run inside the "
                "alfred-learn container (or with env exported)."
            )
        self._client = httpx.AsyncClient(
            base_url=cfg.alfred_ctrl_url,
            timeout=30.0,
            headers={"Authorization": f"Bearer {api_key}"},
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def list_records(self, record_type: str) -> list[dict[str, Any]]:
        resp = await self._client.get(
            f"/api/v1/vault/list/{record_type}", params={"preview": 0}
        )
        resp.raise_for_status()
        return resp.json().get("results", [])

    async def read_record(self, path: str) -> Optional[dict[str, Any]]:
        resp = await self._client.get(f"/api/v1/vault/records/{path}")
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()

    async def create_record_with_content(
        self, record_type: str, name: str, content: str
    ) -> str:
        resp = await self._client.post(
            "/api/v1/vault/records",
            json={"type": record_type, "name": name, "content": content},
        )
        resp.raise_for_status()
        return resp.json().get("path") or ""

    async def patch_set(self, path: str, set_fields: dict[str, Any]) -> None:
        body = {"set": {k: _stringify(v) for k, v in set_fields.items()}}
        resp = await self._client.patch(
            f"/api/v1/vault/records/{path}", json=body
        )
        resp.raise_for_status()


def _stringify(v: Any) -> str:
    """Coerce a Python value to the string form ctrl-api PATCH /set
    expects. Migrate-inbox only writes scalar fields (parent_matter is
    a string), so structured values are unexpected here.
    """
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return ""
    if isinstance(v, (list, dict)):
        # Defensive — migrate_inbox doesn't write structured fields.
        raise ValueError(
            f"_stringify: structured value {type(v).__name__} is not "
            f"supported via PATCH set",
        )
    return str(v)


# ---------------------------------------------------------------------------
# Inbox bootstrap
# ---------------------------------------------------------------------------

def _build_inbox_content() -> str:
    """Render the markdown body for ``matter/inbox.md``.

    Frontmatter lines come first, body second. Carries the full
    Steward Phase 0 schema so the schema migration doesn't have to
    revisit it. ``status: active`` keeps the legacy matter status
    machine happy alongside the new ``state`` field.
    """
    now = _now_iso()
    next_check = _next_check_iso()
    fm_lines = [
        "---",
        "type: matter",
        f'name: "{INBOX_MATTER_NAME}"',
        "status: active",
        "state: open",
        "surface_class: none",
        f"description: \"{INBOX_MATTER_DESCRIPTION}\"",
        "last_steward_check_at: ",
        "last_steward_outcome: ",
        f"next_check_after: {next_check}",
        "signal_sources: []",
        "pending_confirmation: false",
        "blocked_on: ",
        "staleness_score: 0",
        f"created: {now}",
        "---",
    ]
    body = (
        "# Inbox\n\n"
        "Steward home for orphan tasks. Tasks land here automatically "
        "when they're created without an explicit `parent_matter`. Move "
        "them into a real matter by editing `parent_matter` on the task.\n"
    )
    return "\n".join(fm_lines) + "\n\n" + body


async def _ensure_inbox_matter(
    ctrl: CtrlClient, *, dry_run: bool
) -> tuple[bool, bool]:
    """Ensure ``matter/inbox.md`` exists. Returns ``(existed, created)``."""
    existing = await ctrl.read_record(INBOX_MATTER_PATH)
    if existing is not None:
        logger.info("inbox matter already exists at %s", INBOX_MATTER_PATH)
        return (True, False)

    if dry_run:
        logger.info("DRY-RUN: would create %s", INBOX_MATTER_PATH)
        return (False, True)

    content = _build_inbox_content()
    path = await ctrl.create_record_with_content("matter", INBOX_MATTER_PATH, content)
    logger.info("created inbox matter at %s", path or INBOX_MATTER_PATH)
    return (False, True)


# ---------------------------------------------------------------------------
# Orphan detection + reparent
# ---------------------------------------------------------------------------

def _has_parent_matter(fm: dict[str, Any]) -> bool:
    val = fm.get("parent_matter")
    if isinstance(val, str):
        return bool(val.strip())
    return False


def _resolve_legacy_matter(fm: dict[str, Any]) -> Optional[str]:
    """Try to find a real matter ref in the legacy fields.

    If a task has ``matter`` or ``related_matters`` we prefer that over
    bumping it to inbox — the task isn't actually orphan, just missing
    the new ``parent_matter`` mirror. Returns the canonicalized
    ``matter/<slug>.md`` form, or None when no legacy ref is present.
    """
    direct = fm.get("matter")
    if isinstance(direct, str) and direct.strip():
        return _canonical_matter_ref(direct)
    rm = fm.get("related_matters")
    if isinstance(rm, list) and rm:
        first = rm[0]
        if isinstance(first, str) and first.strip():
            return _canonical_matter_ref(first)
    return None


def _canonical_matter_ref(value: str) -> str:
    s = value.strip().strip('"').strip("'")
    if s.startswith("[[") and s.endswith("]]"):
        s = s[2:-2]
    if not s.startswith("matter/"):
        s = f"matter/{s}"
    if not s.endswith(".md"):
        s = f"{s}.md"
    return s


async def _reparent_orphans(
    ctrl: CtrlClient, *, dry_run: bool
) -> tuple[int, int, int, int]:
    """Walk every task, fix orphans + tasks missing the parent_matter mirror.

    Returns ``(examined, fixed_to_inbox, fixed_to_legacy, skipped)``.
    """
    try:
        tasks = await ctrl.list_records("task")
    except httpx.HTTPError as exc:
        logger.error("list_records(task) failed: %s — aborting", exc)
        return (0, 0, 0, 0)

    examined = 0
    to_inbox = 0
    to_legacy = 0
    skipped = 0

    for rec in tasks:
        examined += 1
        path = rec.get("path") or ""
        if not path.startswith("task/") or not path.endswith(".md"):
            skipped += 1
            continue
        fm = rec.get("frontmatter") or {}

        if _has_parent_matter(fm):
            skipped += 1
            continue

        legacy = _resolve_legacy_matter(fm)
        target = legacy if legacy else INBOX_MATTER_PATH

        if dry_run:
            logger.info(
                "DRY-RUN reparent %s → %s%s",
                path, target, " (legacy)" if legacy else " (inbox)",
            )
            if legacy:
                to_legacy += 1
            else:
                to_inbox += 1
            continue

        try:
            await ctrl.patch_set(path, {"parent_matter": target})
        except httpx.HTTPError as exc:
            logger.warning(
                "PATCH parent_matter on %s failed: %s — leaving for next run",
                path, exc,
            )
            continue

        if legacy:
            to_legacy += 1
        else:
            to_inbox += 1

        if examined % 100 == 0:
            logger.info(
                "reparent: progress examined=%d to_inbox=%d to_legacy=%d skipped=%d",
                examined, to_inbox, to_legacy, skipped,
            )

    return (examined, to_inbox, to_legacy, skipped)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def _run(args: argparse.Namespace) -> int:
    ctrl = CtrlClient()
    try:
        existed, created = await _ensure_inbox_matter(ctrl, dry_run=args.dry_run)
        if not existed and not created:
            # Possible only if both list+create failed without raising,
            # which is implausible but covered defensively.
            logger.warning(
                "inbox matter neither existed nor created — orphan reparent will fail"
            )

        examined, to_inbox, to_legacy, skipped = await _reparent_orphans(
            ctrl, dry_run=args.dry_run,
        )
    finally:
        await ctrl.close()

    print("\n" + "=" * 60)
    print("INBOX MATTER MIGRATION SUMMARY")
    print("=" * 60)
    print(f"  mode:                     {'DRY-RUN' if args.dry_run else 'LIVE'}")
    print(f"  inbox existed:            {existed}")
    print(f"  inbox created:            {created}")
    print(f"  tasks examined:           {examined}")
    print(f"  reparented to inbox:      {to_inbox}")
    print(f"  reparented to legacy ref: {to_legacy}")
    print(f"  skipped (already parented): {skipped}")
    print("=" * 60)
    return 0


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="migrate_inbox_matter",
        description=(
            "Create matter/inbox.md if missing + reparent every orphan task "
            "(no parent_matter, no legacy matter ref) to it. Idempotent."
        ),
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Compute every action but write nothing.",
    )
    p.add_argument(
        "--verbose", action="store_true",
        help="DEBUG-level logging.",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    started = time.time()
    try:
        rc = asyncio.run(_run(args))
    except KeyboardInterrupt:
        print("\nmigrate_inbox_matter: interrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001
        logger.exception("migrate_inbox_matter: failed: %s", exc)
        return 1
    logger.info("migrate_inbox_matter: total runtime %.1fs", time.time() - started)
    return rc


if __name__ == "__main__":
    sys.exit(main())
