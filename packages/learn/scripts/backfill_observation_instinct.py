"""Backfill ``instinct: <path>`` on observations that were written
before the live-tagging change shipped.

Problem: when Sir opened ``/instincts`` and expanded any pattern, the
"Observations (N)" panel was always empty — the page groups
observations by ``frontmatter.instinct`` / ``frontmatter.matched_instinct``,
and 0 of david's 399 observation records carried either field. The
instinct records themselves had ``observation_count`` set, but the
back-pointer on each observation was never written.

This script walks every observation that has no ``instinct:`` field,
scores it against the live instinct set with the same deterministic
matcher judge.py uses, and writes the best-scoring instinct's path
into frontmatter when the score clears ``MATCH_THRESHOLD``.

Idempotent: skips observations that already carry an ``instinct:``
field (regardless of value, including ``null``). Re-running won't
duplicate work or downgrade existing matches.

USAGE
-----

Inside the alfred-learn container::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.backfill_observation_instinct [--dry-run]

Flags::

    --dry-run     Print what would happen without writing.
    --batch-size  Log progress every N observations (default 50).
    --verbose     DEBUG-level logging.
    --threshold   Override MATCH_THRESHOLD (default 0.15).
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from dataclasses import dataclass, field
from typing import Any  # noqa: F401  (used in type hints below)

import httpx


logger = logging.getLogger("backfill-obs-instinct")


def _ctrl_url() -> str:
    return os.environ.get("ALFRED_CTRL_URL", "http://ctrl-api:3100")


def _auth() -> dict[str, str]:
    api_key = os.environ.get("AAS_API_KEY", "")
    if not api_key:
        raise RuntimeError("AAS_API_KEY unset")
    return {"Authorization": f"Bearer {api_key}"}


@dataclass
class Stats:
    observations: int = 0
    already_tagged: int = 0
    matched: int = 0
    no_match: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)


async def _run(args: argparse.Namespace) -> Stats:
    # Import scorer here so the script can still load without the full
    # learn runtime path (temporalio etc.). The matcher only needs
    # ``src.matching`` modules — no Temporal.
    from src.matching.instinct_match import best_instinct_path
    import src.matching.instinct_match as _im

    # Optional threshold override.
    if args.threshold is not None:
        _im.MATCH_THRESHOLD = float(args.threshold)
        logger.info("MATCH_THRESHOLD overridden to %.3f", _im.MATCH_THRESHOLD)

    stats = Stats()
    async with httpx.AsyncClient(
        base_url=_ctrl_url(), timeout=60.0, headers=_auth(),
    ) as client:
        # Pull instincts once — they don't change during backfill.
        try:
            r = await client.get("/api/v1/vault/list/instinct")
            r.raise_for_status()
        except httpx.HTTPError as exc:
            stats.errors += 1
            stats.error_messages.append(f"list instincts: {exc}"[:300])
            return stats
        instincts = r.json().get("results", []) or []
        logger.info("loaded %d instincts for matching", len(instincts))

        # Pull observations — paginated by list size (ctrl-api currently
        # has no offset; 1000-cap is fine for david's ~400).
        try:
            r = await client.get("/api/v1/vault/list/observation?preview=0")
            r.raise_for_status()
        except httpx.HTTPError as exc:
            stats.errors += 1
            stats.error_messages.append(f"list observations: {exc}"[:300])
            return stats
        observations = r.json().get("results", []) or []
        stats.observations = len(observations)
        logger.info("scanned %d observation records", len(observations))

        for idx, obs in enumerate(observations):
            if idx and idx % args.batch_size == 0:
                logger.info(
                    "progress %d/%d matched=%d already=%d no_match=%d",
                    idx, len(observations),
                    stats.matched, stats.already_tagged, stats.no_match,
                )

            fm = obs.get("frontmatter") or {}
            if not isinstance(fm, dict):
                continue

            # Skip if the field is already present (even null) — that
            # means a newer write has already attempted the match.
            if "instinct" in fm:
                stats.already_tagged += 1
                continue

            path = str(obs.get("path") or "")
            if not path:
                continue

            # Walk to the upstream signal (and through it to the stream
            # event) when present. This is where real sender domains
            # and full subjects live; without them the matcher can't
            # score against instinct ``sender_domains`` patterns. Pure
            # decision-sourced observations carry only the headline +
            # display-name sender, so they continue to match through
            # keywords alone — a sparser but honest result.
            signal_fm: dict[str, Any] | None = None
            event_fm: dict[str, Any] | None = None
            source_kind = str(fm.get("source_kind") or "").lower()
            if source_kind == "signal":
                source_path = str(fm.get("source_path") or "").strip()
                if source_path:
                    try:
                        sr = await client.get(
                            f"/api/v1/vault/records/{_quote(source_path)}"
                        )
                        if sr.status_code == 200:
                            sj = sr.json()
                            sfm = sj.get("frontmatter")
                            if isinstance(sfm, dict):
                                signal_fm = sfm
                                ev_path = str(
                                    sfm.get("source_event_path") or ""
                                ).strip()
                                if ev_path:
                                    er = await client.get(
                                        f"/api/v1/vault/records/{_quote(ev_path)}"
                                    )
                                    if er.status_code == 200:
                                        efm = er.json().get("frontmatter")
                                        if isinstance(efm, dict):
                                            event_fm = efm
                    except httpx.HTTPError as exc:
                        logger.debug(
                            "upstream fetch failed for %s: %s", path, exc,
                        )

            try:
                best_path = best_instinct_path(
                    fm, instincts, signal_fm=signal_fm, event_fm=event_fm,
                )
            except Exception as exc:  # noqa: BLE001
                stats.errors += 1
                stats.error_messages.append(
                    f"match {path}: {exc}"[:300]
                )
                continue

            # Use json_set so the value lands as native YAML null when
            # there's no match (vs the "set" path which only accepts
            # strings and would turn null into the empty string).
            if best_path is None:
                stats.no_match += 1
                if args.dry_run:
                    logger.debug("DRY-RUN no-match %s", path)
                    continue
                try:
                    pr = await client.patch(
                        f"/api/v1/vault/records/{_quote(path)}",
                        json={"json_set": {"instinct": None}},
                    )
                    pr.raise_for_status()
                except httpx.HTTPError as exc:
                    stats.errors += 1
                    stats.error_messages.append(
                        f"patch null {path}: {exc}"[:300]
                    )
                continue

            stats.matched += 1
            logger.debug(
                "match %s -> %s (fact=%r)",
                path, best_path, fm.get("fact", "")[:80],
            )
            if args.dry_run:
                continue

            try:
                pr = await client.patch(
                    f"/api/v1/vault/records/{_quote(path)}",
                    json={"json_set": {"instinct": best_path}},
                )
                pr.raise_for_status()
            except httpx.HTTPError as exc:
                stats.errors += 1
                stats.error_messages.append(
                    f"patch {path}: {exc}"[:300]
                )

    return stats


def _quote(path: str) -> str:
    """ctrl-api's PATCH /api/v1/vault/records/:path expects a single
    URL-encoded path segment. The path itself contains a '/' for the
    type prefix, so we encode that too — vault_client._encode_path
    does this same thing.
    """
    from urllib.parse import quote
    return quote(path, safe="")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument(
        "--threshold", type=float, default=None,
        help="Override MATCH_THRESHOLD (default 0.15)",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    stats = asyncio.run(_run(args))
    print(f"observations:    {stats.observations}")
    print(f"already_tagged:  {stats.already_tagged}")
    print(f"matched:         {stats.matched}")
    print(f"no_match:        {stats.no_match}")
    print(f"errors:          {stats.errors}")
    if stats.error_messages:
        print("first errors:")
        for m in stats.error_messages[:5]:
            print(f"  - {m}")
    return 1 if stats.errors else 0


if __name__ == "__main__":
    sys.exit(main())
