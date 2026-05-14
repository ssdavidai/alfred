"""Infer + stamp ``owner`` on every open vault task.

[TASK-LIFECYCLE-5] owner-inference half. Dedupe (clustering of
near-duplicate tasks per matter) is a separate follow-up.

Owner derivation rules — read from ``decision_origin`` (stamped by
LIFECYCLE-3) and fall back to source-record heuristics:

  decision_origin starts with...     owner
  ---------------------------------  ---------------------------
  decision/<ts>.md                   principal   (Sir clicked Desk)
  instinct/<id>.md                   alfred      (autonomous fire)
  signal/<path>.md                   <from-address on that signal>
                                     fallback: "external" if no from
  legacy/pre-arch11                  unknown     (pre-stamp grandfather)
  (missing/empty)                    unknown

Skipped: tasks already carrying a non-empty ``owner`` value
(idempotent). Done/archived tasks too — the owner field is about
"who is on the hook for the OPEN work".

USAGE
-----

Inside the alfred-learn container::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.infer_task_owners [--dry-run]

Flags::

    --dry-run     Print what would happen without PATCHing.
    --batch-size  Log progress every N tasks (default 50).
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from dataclasses import dataclass, field
from typing import Any

import httpx


logger = logging.getLogger("infer-task-owners")


def _ctrl_url() -> str:
    return os.environ.get("ALFRED_CTRL_URL", "http://ctrl-api:3100")


def _auth_headers() -> dict[str, str]:
    api_key = os.environ.get("AAS_API_KEY", "")
    if not api_key:
        raise RuntimeError("AAS_API_KEY unset")
    return {"Authorization": f"Bearer {api_key}"}


def _is_open_task(fm: dict[str, Any]) -> bool:
    if fm.get("archived") is True or str(fm.get("archived", "")).lower() == "true":
        return False
    state = str(fm.get("state", "")).lower().strip()
    if state in ("archived", "done", "completed", "complete"):
        return False
    status = str(fm.get("status", "")).lower().strip()
    if status in ("archived", "cancelled", "canceled", "completed", "complete", "done"):
        return False
    return True


async def _read_signal_from(client: httpx.AsyncClient, signal_path: str) -> str | None:
    """Return the signal's ``from`` address (or sender) or None."""
    if not signal_path:
        return None
    path = signal_path.lstrip("/")
    if not path.startswith("signal/"):
        return None
    try:
        resp = await client.get(f"/api/v1/vault/records/{path}")
        resp.raise_for_status()
    except httpx.HTTPError:
        return None
    fm = (resp.json().get("frontmatter") or {})
    raw = fm.get("raw") or {}
    if isinstance(raw, dict):
        for k in ("from", "sender", "from_email"):
            v = raw.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
    for k in ("from", "sender"):
        v = fm.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


async def derive_owner(
    client: httpx.AsyncClient, decision_origin: str,
) -> str:
    s = (decision_origin or "").strip()
    if not s or s == "null":
        return "unknown"
    if s.startswith("decision/"):
        return "principal"
    if s.startswith("instinct/"):
        return "alfred"
    if s.startswith("signal/"):
        sender = await _read_signal_from(client, s)
        return sender or "external"
    if s.startswith("legacy/"):
        return "unknown"
    return "unknown"


@dataclass
class Stats:
    scanned: int = 0
    open_tasks: int = 0
    already_owned: int = 0
    stamped_now: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)
    by_owner: dict[str, int] = field(default_factory=dict)


async def _run(args: argparse.Namespace) -> Stats:
    stats = Stats()
    async with httpx.AsyncClient(
        base_url=_ctrl_url(), timeout=30.0, headers=_auth_headers(),
    ) as client:
        resp = await client.get("/api/v1/vault/list/task")
        resp.raise_for_status()
        tasks = resp.json().get("results", []) or []
        stats.scanned = len(tasks)
        logger.info("scanned %d task records", len(tasks))

        for idx, t in enumerate(tasks):
            if idx and idx % args.batch_size == 0:
                logger.info(
                    "progress %d/%d stamped=%d skipped=%d",
                    idx, len(tasks), stats.stamped_now,
                    stats.already_owned,
                )
            fm = t.get("frontmatter", {}) or {}
            path = t.get("path") or t.get("relPath") or ""
            if not path:
                continue

            if not _is_open_task(fm):
                continue
            stats.open_tasks += 1

            existing_owner = str(fm.get("owner", "") or "").strip()
            if existing_owner and existing_owner.lower() != "null":
                stats.already_owned += 1
                continue

            decision_origin = str(fm.get("decision_origin", "") or "").strip()
            owner = await derive_owner(client, decision_origin)
            stats.by_owner[owner] = stats.by_owner.get(owner, 0) + 1

            if args.dry_run:
                logger.debug("DRY-RUN %s → owner=%s", path, owner)
                stats.stamped_now += 1
                continue

            try:
                patch_resp = await client.patch(
                    f"/api/v1/vault/records/{path}",
                    json={"set": {"owner": owner}},
                )
                patch_resp.raise_for_status()
                stats.stamped_now += 1
            except httpx.HTTPError as exc:
                stats.errors += 1
                stats.error_messages.append(f"{path}: {exc}"[:300])

    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    stats = asyncio.run(_run(args))
    print(f"scanned:          {stats.scanned}")
    print(f"open_tasks:       {stats.open_tasks}")
    print(f"already_owned:    {stats.already_owned}")
    print(f"stamped_now:      {stats.stamped_now}")
    print(f"errors:           {stats.errors}")
    print("by_owner:")
    for owner, n in sorted(stats.by_owner.items(), key=lambda kv: -kv[1]):
        print(f"  {owner}: {n}")
    if stats.error_messages:
        print("first errors:")
        for m in stats.error_messages[:5]:
            print(f"  - {m}")
    return 1 if stats.errors else 0


if __name__ == "__main__":
    sys.exit(main())
