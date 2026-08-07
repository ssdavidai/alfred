"""Move commitment records from `task/` to the canonical `commitment/` type.

Phase 0d of #467. Depends on #469 (vault schema) and #470 (promotion contract);
without both, every write below returns 422.

    Dry run (default — writes nothing):
        python -m scripts.migrate_commitments_to_type

    Execute:
        python -m scripts.migrate_commitments_to_type --execute

Safety properties, in order of how much they matter:

1. **Dry run by default.** `--execute` is required to write anything.
2. **Write, verify, then delete.** There is no move primitive on the vault
   client, so a migration is create + delete. Doing it in that order means a
   failure leaves a *detectable duplicate* rather than a lost record. Never
   invert this.
3. **Idempotent.** A record whose `commitment/` twin already exists is skipped,
   so a half-finished run can simply be re-run.
4. **Read-back before delete.** The new record's identity fields are compared
   against the source. Any mismatch aborts that record and leaves the original
   in place.

OPERATIONAL HAZARD — read before running with `--execute`:

The reconciliation jobs run every weekday morning against exactly these
records. A migration racing a reconciliation produces a projection built from a
half-moved set. **Pause the jobs, migrate, verify, resume.** Do not rely on
picking a quiet hour.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import re
import sys
from typing import Any

from src.config import load_config
from src.utils.vault_client import VaultClient

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("migrate-commitments")

#: Fields whose survival defines a correct migration. Checked after the write
#: and before the delete; a mismatch on any of these aborts that record.
IDENTITY_FIELDS = (
    "commitment_id",
    "commitment_scope",
    "commitment_kind",
    "commitment_state",
    "requested_by",
    "accountable_party",
    "next_action",
    "source_type",
    "source_ref",
    "last_verified_at",
    "status",
)


def _slug(path: str) -> str:
    return path.rsplit("/", 1)[-1].removesuffix(".md")


def _retype(raw: str) -> str:
    """Rewrite the frontmatter `type:` from task to commitment.

    Operates on the first occurrence inside the frontmatter block only, so a
    body that happens to mention `type: task` is untouched.
    """
    if not raw.startswith("---"):
        return raw
    end = raw.find("\n---", 3)
    if end == -1:
        return raw
    head, rest = raw[:end], raw[end:]
    head = re.sub(
        r'^type:\s*["\']?task["\']?\s*$',
        'type: "commitment"',
        head,
        count=1,
        flags=re.MULTILINE,
    )
    return head + rest


async def _load_candidates(client: VaultClient) -> list[dict[str, Any]]:
    records = await client.list_records("task", limit=5000)
    out = []
    for r in records:
        fm = r.get("frontmatter") or {}
        if isinstance(fm, dict) and str(fm.get("commitment_id") or "").strip():
            out.append(r)
    return out


async def _already_migrated(client: VaultClient, slug: str) -> bool:
    try:
        await client.read_record(f"commitment/{slug}.md")
        return True
    except Exception:  # noqa: BLE001 — absence is the expected case
        return False


async def migrate(execute: bool) -> int:
    config = load_config()
    client = VaultClient(config)
    moved = skipped = failed = 0
    try:
        candidates = await _load_candidates(client)
        logger.info(
            "found %d task records carrying commitment_id (%s)",
            len(candidates),
            "EXECUTING" if execute else "dry run — nothing will be written",
        )

        by_scope: dict[str, int] = {}
        for r in candidates:
            fm = r.get("frontmatter") or {}
            by_scope[str(fm.get("commitment_scope") or "?")] = (
                by_scope.get(str(fm.get("commitment_scope") or "?"), 0) + 1
            )
        for scope, n in sorted(by_scope.items(), key=lambda kv: -kv[1]):
            logger.info("  %-24s %d", scope, n)

        for r in candidates:
            path = str(r.get("path") or "")
            slug = _slug(path)
            fm = r.get("frontmatter") or {}
            cid = fm.get("commitment_id")

            if await _already_migrated(client, slug):
                logger.info("SKIP  %s (%s) — commitment/ twin already exists", cid, slug)
                skipped += 1
                continue

            if not execute:
                logger.info("WOULD MOVE  %s  task/%s.md -> commitment/%s.md", cid, slug, slug)
                moved += 1
                continue

            try:
                source = await client.read_record(path)
                raw = source.get("content") or ""
                if not raw.strip():
                    raise ValueError("source record is empty")

                await client.write_record("commitment", slug, _retype(raw))

                # Read back and compare identity before removing the original.
                check = await client.read_record(f"commitment/{slug}.md")
                cfm = check.get("frontmatter") or {}
                drift = [
                    f
                    for f in IDENTITY_FIELDS
                    if str(fm.get(f) or "") != str(cfm.get(f) or "")
                ]
                if drift:
                    raise ValueError(f"identity drift on {drift}; original left in place")
                if str(cfm.get("type") or "") != "commitment":
                    raise ValueError("type did not become commitment; original left in place")

                await client.delete_record(path)
                logger.info("MOVED %s  -> commitment/%s.md", cid, slug)
                moved += 1
            except Exception as exc:  # noqa: BLE001
                logger.error("FAIL  %s (%s): %s", cid, slug, exc)
                failed += 1

        logger.info(
            "\n%s: %d moved, %d skipped, %d failed",
            "RESULT" if execute else "DRY RUN",
            moved,
            skipped,
            failed,
        )
        if execute and failed:
            logger.error(
                "Some records failed. Their originals are intact under task/. "
                "Re-running is safe: successful moves are skipped."
            )
        if execute and moved:
            logger.info(
                "Now verify behaviourally: run ONE scope's reconciliation and "
                "confirm it finds its records and regenerates an unchanged "
                "projection. A file listing proves the move; a clean "
                "reconciliation proves it was correct."
            )
        return 1 if failed else 0
    finally:
        await client.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--execute",
        action="store_true",
        help="actually write; omit for a dry run",
    )
    args = ap.parse_args()
    return asyncio.run(migrate(args.execute))


if __name__ == "__main__":
    sys.exit(main())
