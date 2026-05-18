"""Stamp ``decision_origin`` on every existing vault task that lacks it.

[TASK-LIFECYCLE-3] groundwork — establish the audit-chain invariant
"no task exists without a recorded gesture" by giving every legacy
task a provenance value of ``legacy/pre-arch11``. This is a one-shot
grandfather, not a value users should ever set going forward.

Three legitimate decision_origin shapes (defined per the lifecycle
RFC):

  * ``decision/<ts>.md``    — principal-click parentage (Desk).
  * ``instinct/<id>.md``    — autonomous-fire parentage (an instinct
                              decided on the principal's behalf; a
                              synthetic decision/<ts>.md with
                              intent=auto_dispatch is also written).
  * ``legacy/pre-arch11``   — historical grandfather. This script.

Idempotent: skips any task already carrying a ``decision_origin``
value, regardless of which of the three shapes.

USAGE
-----

Inside the alfred-learn container::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.stamp_decision_origin [--dry-run]

Flags::

    --dry-run     Print what would happen without PATCHing.
    --batch-size  Log progress every N tasks (default 200).
    --verbose     DEBUG-level logging.

The script touches BOTH open and archived tasks — the audit chain is
about provenance, not about active state.
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


logger = logging.getLogger("stamp-decision-origin")


LEGACY_VALUE = "legacy/pre-arch11"


def _ctrl_url() -> str:
    return os.environ.get("ALFRED_CTRL_URL", "http://ctrl-api:3100")


def _ctrl_auth_headers() -> dict[str, str]:
    api_key = os.environ.get("AAS_API_KEY", "")
    if not api_key:
        raise RuntimeError(
            "AAS_API_KEY is not set — run inside alfred-learn container."
        )
    return {"Authorization": f"Bearer {api_key}"}


@dataclass
class Stats:
    scanned: int = 0
    already_stamped: int = 0
    stamped_now: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)


async def _run(args: argparse.Namespace) -> Stats:
    stats = Stats()
    async with httpx.AsyncClient(
        base_url=_ctrl_url(),
        timeout=30.0,
        headers=_ctrl_auth_headers(),
    ) as client:
        resp = await client.get("/api/v1/vault/list/task")
        resp.raise_for_status()
        tasks = resp.json().get("results", []) or []
        stats.scanned = len(tasks)
        logger.info("scanned %d task records", len(tasks))

        for idx, t in enumerate(tasks):
            if idx and idx % args.batch_size == 0:
                logger.info(
                    "progress %d/%d stamped=%d already=%d",
                    idx, len(tasks), stats.stamped_now, stats.already_stamped,
                )

            fm = t.get("frontmatter", {}) or {}
            path = t.get("path") or t.get("relPath") or ""
            if not path:
                continue

            existing = fm.get("decision_origin")
            if isinstance(existing, str) and existing.strip() and existing != "null":
                stats.already_stamped += 1
                continue

            if args.dry_run:
                logger.debug("DRY-RUN would stamp: %s", path)
                stats.stamped_now += 1
                continue

            try:
                patch_resp = await client.patch(
                    f"/api/v1/vault/records/{path}",
                    json={"set": {"decision_origin": LEGACY_VALUE}},
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
    parser.add_argument("--batch-size", type=int, default=200)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    stats = asyncio.run(_run(args))
    print(f"scanned:          {stats.scanned}")
    print(f"already_stamped:  {stats.already_stamped}")
    print(f"stamped_now:      {stats.stamped_now}")
    print(f"errors:           {stats.errors}")
    if stats.error_messages:
        print("first errors:")
        for m in stats.error_messages[:5]:
            print(f"  - {m}")
    return 1 if stats.errors else 0


if __name__ == "__main__":
    sys.exit(main())
