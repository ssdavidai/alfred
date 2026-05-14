"""Backfill ``observation/`` records for signals that don't have one yet.

[OBS-2] Companion script. After the live wiring lands in
SignalExtractWorkflow, every new signal triggers an observation
write. This script walks signals already on disk and synthesises the
missing observations using the same logic as the live activity.

Idempotent: tracks "covered" signals by the observation's
``source_path`` field; skips signals already covered.

USAGE
-----

Inside the alfred-learn container::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.backfill_signal_observations [--dry-run]

Flags::

    --dry-run         Print what would happen without writing.
    --window-days N   Only backfill signals created in the last N days
                      (default 30). Older signals are usually too stale
                      to be useful for current pattern detection and we
                      avoid bloating the observation pool.
    --batch-size N    Log progress every N signals (default 100).
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx


logger = logging.getLogger("backfill-signal-obs")


def _ctrl_url() -> str:
    return os.environ.get("ALFRED_CTRL_URL", "http://ctrl-api:3100")


def _auth() -> dict[str, str]:
    api_key = os.environ.get("AAS_API_KEY", "")
    if not api_key:
        raise RuntimeError("AAS_API_KEY unset")
    return {"Authorization": f"Bearer {api_key}"}


@dataclass
class Stats:
    signals_scanned: int = 0
    in_window: int = 0
    already_covered: int = 0
    backfilled: int = 0
    skipped_no_path: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)


async def _list_covered_signal_paths(
    client: httpx.AsyncClient,
) -> set[str]:
    """Read every observation/ record and collect the ``source_path``
    values where ``source_kind == 'signal'``. Lets us skip signals
    that already have an observation, even after multiple runs."""
    covered: set[str] = set()
    try:
        resp = await client.get(
            "/api/v1/vault/list/observation?preview=200",
        )
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning("covered list failed: %s", exc)
        return covered
    for r in (resp.json().get("results") or []):
        fm = r.get("frontmatter") or {}
        if str(fm.get("source_kind") or "").strip() != "signal":
            continue
        sp = str(fm.get("source_path") or "").strip()
        if sp:
            covered.add(sp)
    logger.info("found %d signals already covered by observations", len(covered))
    return covered


async def _run(args: argparse.Namespace) -> Stats:
    """Drive the backfill end-to-end. Uses the live activity from
    ``src.activities.signal_observations`` so the schema stays in
    lock-step with the production writer — no copy-paste of the
    derivation logic."""
    # Import the live activity. Backfill script runs inside the
    # alfred-learn container where the package is on PYTHONPATH.
    from src.activities.signal_observations import extract_observation_from_signal

    stats = Stats()
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.window_days)

    async with httpx.AsyncClient(
        base_url=_ctrl_url(), timeout=30.0, headers=_auth(),
    ) as client:
        covered = await _list_covered_signal_paths(client)

        # List signals. preview=200 keeps payload sensible; we only
        # need frontmatter to decide which ones to backfill.
        try:
            resp = await client.get("/api/v1/vault/list/signal?preview=200")
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            stats.errors += 1
            stats.error_messages.append(f"list signals: {exc}"[:300])
            return stats
        signals = resp.json().get("results", []) or []
        stats.signals_scanned = len(signals)
        logger.info("scanned %d signals", len(signals))

        for idx, sig in enumerate(signals):
            if idx and idx % args.batch_size == 0:
                logger.info(
                    "progress %d/%d in_window=%d backfilled=%d already=%d",
                    idx, len(signals), stats.in_window,
                    stats.backfilled, stats.already_covered,
                )
            fm = sig.get("frontmatter") or {}
            path = sig.get("path") or sig.get("relPath") or ""
            if not path:
                stats.skipped_no_path += 1
                continue
            created_raw = str(fm.get("created") or "").strip()
            try:
                created_dt = datetime.fromisoformat(
                    created_raw.replace("Z", "+00:00")
                )
            except Exception:  # noqa: BLE001
                # If we can't parse a creation timestamp, default to
                # "include" so we don't silently miss old records.
                created_dt = datetime.now(timezone.utc)
            if created_dt < cutoff:
                continue
            stats.in_window += 1
            if path in covered:
                stats.already_covered += 1
                continue

            if args.dry_run:
                logger.debug("DRY-RUN would backfill %s", path)
                stats.backfilled += 1
                continue

            try:
                result = await extract_observation_from_signal(path)
            except Exception as exc:  # noqa: BLE001
                stats.errors += 1
                stats.error_messages.append(f"{path}: {exc}"[:300])
                continue
            if isinstance(result, dict) and result.get("observation_path"):
                stats.backfilled += 1
            else:
                # Activity returned {observation_path: None, reason: ...}
                reason = (
                    result.get("reason") if isinstance(result, dict) else "unknown"
                )
                stats.errors += 1
                stats.error_messages.append(f"{path}: no obs ({reason})"[:300])

    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--window-days", type=int, default=30)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    stats = asyncio.run(_run(args))
    print(f"signals_scanned:    {stats.signals_scanned}")
    print(f"in_window ({args.window_days}d): {stats.in_window}")
    print(f"already_covered:    {stats.already_covered}")
    print(f"backfilled:         {stats.backfilled}")
    print(f"skipped_no_path:    {stats.skipped_no_path}")
    print(f"errors:             {stats.errors}")
    if stats.error_messages:
        print("first errors:")
        for m in stats.error_messages[:5]:
            print(f"  - {m}")
    return 1 if stats.errors else 0


if __name__ == "__main__":
    sys.exit(main())
