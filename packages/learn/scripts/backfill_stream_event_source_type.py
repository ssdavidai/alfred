"""Rewrite mislabeled ``source_type`` on stream_event records.

Historic curator bug: ``stream_vault._resolve_source_type`` used to
treat ``stream_type: "scheduled"`` as a calendar marker, but
``"scheduled"`` is the puller's transport tag for *every* pull-mode
stream (gmail, slack-list, github, gcal, ...). Result on david: 359
gmail records were typed ``source_type: gcal``.

The curator is now fixed (source_ref prefix is consulted first), so
new ingests are correct. This script narrowly targets the historic
mislabel pattern only: a stream_event whose ``source_type`` disagrees
with what the prefix of ``source_ref`` says it should be.

Idempotent: skips records whose stored ``source_type`` already
matches the source_ref prefix, or that lack a known source_ref
prefix entirely (legacy / non-pull / openclaw-chat records).

USAGE
-----

Inside the alfred-learn container::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.backfill_stream_event_source_type [--dry-run]

Flags::

    --dry-run         Print what would be patched without writing.
    --batch-size N    Log progress every N records (default 200).
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from dataclasses import dataclass, field

import httpx


logger = logging.getLogger("backfill-stream-event-source-type")


# Map of source_ref prefix → canonical Phase 6 source_type.
# Mirrors the ordering in ``stream_vault._resolve_source_type``.
_PREFIX_MAP: list[tuple[str, str]] = [
    ("gmail:", "gmail"),
    ("gcal:", "gcal"),
    ("googlecalendar:", "gcal"),
    ("slack:", "slack"),
    ("github:", "github"),
    ("notion:", "notion"),
    ("linear:", "linear"),
]


def _expected_type(source_ref: str) -> str | None:
    """Return the canonical source_type implied by source_ref, or None
    when source_ref has no known toolkit prefix (legacy / openclaw-chat
    / synthetic records). The script only patches records where we
    have positive evidence of the correct type."""
    sr = (source_ref or "").strip().lower()
    for prefix, value in _PREFIX_MAP:
        if sr.startswith(prefix):
            return value
    return None


def _ctrl_url() -> str:
    return os.environ.get("ALFRED_CTRL_URL", "http://ctrl-api:3100")


def _auth() -> dict[str, str]:
    api_key = os.environ.get("AAS_API_KEY", "")
    if not api_key:
        raise RuntimeError("AAS_API_KEY unset")
    return {"Authorization": f"Bearer {api_key}"}


@dataclass
class Stats:
    scanned: int = 0
    already_correct: int = 0
    no_source_ref_prefix: int = 0
    no_stored_source_type: int = 0
    rewritten: int = 0
    skipped_no_path: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)


async def _patch_record(
    client: httpx.AsyncClient, path: str, new_source_type: str,
) -> bool:
    """PATCH a stream_event's source_type via ctrl-api's --set channel."""
    try:
        resp = await client.patch(
            f"/api/v1/vault/records/{path}",
            json={"set": {"source_type": new_source_type}},
        )
        resp.raise_for_status()
        return True
    except httpx.HTTPError as exc:
        logger.warning("patch failed path=%s err=%s", path, exc)
        return False


async def _run(args: argparse.Namespace) -> Stats:
    stats = Stats()

    async with httpx.AsyncClient(
        base_url=_ctrl_url(), timeout=60.0, headers=_auth(),
    ) as client:
        try:
            resp = await client.get("/api/v1/vault/list/stream_event?preview=2000")
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            stats.errors += 1
            stats.error_messages.append(f"list stream_event: {exc}"[:300])
            return stats

        records = resp.json().get("results", []) or []
        stats.scanned = len(records)
        logger.info("scanned %d stream_event records", len(records))

        for idx, rec in enumerate(records):
            if idx and idx % args.batch_size == 0:
                logger.info(
                    "progress %d/%d rewritten=%d already=%d no_prefix=%d",
                    idx, len(records), stats.rewritten,
                    stats.already_correct, stats.no_source_ref_prefix,
                )
            path = rec.get("path") or rec.get("relPath") or ""
            if not path:
                stats.skipped_no_path += 1
                continue
            fm = rec.get("frontmatter") or {}
            if not isinstance(fm, dict):
                fm = {}
            stored = str(fm.get("source_type") or "").strip()
            source_ref = str(fm.get("source_ref") or "").strip()

            expected = _expected_type(source_ref)
            if expected is None:
                stats.no_source_ref_prefix += 1
                continue
            if not stored:
                # Phase-6.6 stamp absent; we won't introduce a new field
                # on legacy records (different schema, separate concern).
                stats.no_stored_source_type += 1
                continue
            if stored == expected:
                stats.already_correct += 1
                continue

            if args.dry_run:
                logger.info(
                    "DRY-RUN would rewrite %s: %s -> %s (source_ref=%s)",
                    path, stored, expected, source_ref[:40],
                )
                stats.rewritten += 1
                continue

            ok = await _patch_record(client, path, expected)
            if ok:
                stats.rewritten += 1
            else:
                stats.errors += 1
                stats.error_messages.append(
                    f"{path}: patch failed (was {stored} -> {expected})"[:300]
                )

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
    print(f"scanned:                 {stats.scanned}")
    print(f"already_correct:         {stats.already_correct}")
    print(f"no_source_ref_prefix:    {stats.no_source_ref_prefix}")
    print(f"no_stored_source_type:   {stats.no_stored_source_type}")
    print(f"rewritten:               {stats.rewritten}")
    print(f"skipped_no_path:         {stats.skipped_no_path}")
    print(f"errors:                  {stats.errors}")
    if stats.error_messages:
        print("first errors:")
        for m in stats.error_messages[:5]:
            print(f"  - {m}")
    return 1 if stats.errors else 0


if __name__ == "__main__":
    sys.exit(main())
