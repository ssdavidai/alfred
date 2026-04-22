"""Rematerialize historical stream events as vault records.

Walks /alfred-data/streams/*.jsonl, re-renders each event through the
CURRENT stream_vault templates, and writes the result back to the
vault. Because `_event_slug` is a deterministic hash of
`source_ref + received_at date`, re-rendering overwrites in place
for records whose target type hasn't changed. For record types that
migrated (omi-audio / voice-call moved from `event/` to
`conversation/` in PR #519), a new record is written at the new
path; the old orphan at `event/<slug>.md` can be cleaned up via
`--delete-orphans`.

Invocation (runs inside the alfred-learn container):

    docker exec compose-alfred-learn-1 \\
        python -m scripts.streams_rematerialize [--flags]

Default is dry-run. Pass --write to mutate.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from src.activities.stream_vault import (
    _build_vault_content,
    _event_slug,
    _render_event,
)
from src.config import load_config
from src.utils.vault_client import VaultClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("streams-rematerialize")

DEFAULT_STREAMS_DIR = "/alfred-data/streams"
DEFAULT_LIMIT = 10_000


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m scripts.streams_rematerialize",
        description=(
            "Re-render historical stream events through current "
            "stream_vault templates. Default is dry-run; pass --write "
            "to mutate the vault."
        ),
    )
    parser.add_argument(
        "--stream-type",
        default=None,
        help=(
            "Comma-separated stream types to include (e.g. "
            "omi-audio,voice-call). Default: all types."
        ),
    )
    parser.add_argument(
        "--since",
        default=None,
        help="Only rematerialize events received on/after this ISO date (YYYY-MM-DD).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        help=f"Max events to process per run (default {DEFAULT_LIMIT}).",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        default=False,
        help="Actually write to the vault. Omit for dry-run.",
    )
    parser.add_argument(
        "--delete-orphans",
        action="store_true",
        default=False,
        help=(
            "When a template's record_type has changed (omi-audio / "
            "voice-call → conversation), delete the orphan old "
            "event/<slug>.md record. No effect without --write."
        ),
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        default=False,
        help="Per-event logging.",
    )
    parser.add_argument(
        "--streams-dir",
        default=os.environ.get("STREAMS_DIR", DEFAULT_STREAMS_DIR),
        help="Override the streams JSONL directory (default /alfred-data/streams).",
    )
    return parser.parse_args(argv)


def _iter_events(streams_dir: Path) -> list[dict[str, Any]]:
    """Walk every *.jsonl file in streams_dir and yield each event dict."""
    events: list[dict[str, Any]] = []
    if not streams_dir.is_dir():
        logger.warning("streams dir not found: %s", streams_dir)
        return events
    for jsonl_path in sorted(streams_dir.glob("*.jsonl")):
        try:
            with open(jsonl_path, "r", encoding="utf-8") as f:
                for line_no, raw_line in enumerate(f, start=1):
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        events.append(json.loads(line))
                    except json.JSONDecodeError as e:
                        logger.warning(
                            "malformed JSON in %s:%d (%s)",
                            jsonl_path.name, line_no, e,
                        )
        except OSError as e:
            logger.warning("could not read %s: %s", jsonl_path, e)
    return events


def _filter_events(
    events: list[dict[str, Any]],
    stream_types: set[str] | None,
    since_date: str | None,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Apply --stream-type / --since filters. Returns (kept, drop_reasons)."""
    kept: list[dict[str, Any]] = []
    reasons: Counter = Counter()
    for e in events:
        st = e.get("stream_type", "")
        if stream_types and st not in stream_types:
            reasons["filtered_stream_type"] += 1
            continue
        if since_date:
            rec = (e.get("received_at") or "")[:10]
            if rec and rec < since_date:
                reasons["filtered_by_since"] += 1
                continue
        # Basic malformed-event skip: need source_ref + raw.
        raw = e.get("raw")
        if not e.get("source_ref") or not isinstance(raw, dict):
            reasons["skipped_malformed"] += 1
            continue
        kept.append(e)
    return kept, dict(reasons)


async def _process(
    events: list[dict[str, Any]],
    client: VaultClient,
    write: bool,
    delete_orphans: bool,
    verbose: bool,
) -> dict[str, int]:
    """Render each event; write + (optionally) delete orphans."""
    stats: Counter = Counter()
    per_type_writes: Counter = Counter()
    first_samples: list[str] = []

    for i, event in enumerate(events):
        stats["scanned"] += 1
        if (i + 1) % 100 == 0:
            logger.info("heartbeat: %d/%d processed", i + 1, len(events))

        try:
            name, body, tags, record_type = _render_event(event)
            slug = _event_slug(event)
            content = _build_vault_content(
                name=name,
                event=event,
                body=body,
                tags=tags,
                record_type=record_type,
            )
        except Exception as exc:
            logger.warning(
                "render failed for source_ref=%s: %s",
                event.get("source_ref"), exc,
            )
            stats["render_failed"] += 1
            continue

        target_path = f"{record_type}/{slug}.md"
        if len(first_samples) < 5:
            first_samples.append(
                f"  {event.get('stream_type','?'):<14} -> {target_path}"
            )

        if write:
            try:
                await client.write_record(record_type, slug, content)
                stats["written"] += 1
                per_type_writes[record_type] += 1
                if verbose:
                    logger.info("wrote %s (%d chars body)", target_path, len(body))
            except Exception as exc:
                logger.warning("write failed for %s: %s", target_path, exc)
                stats["write_failed"] += 1
                continue

            if delete_orphans and record_type != "event":
                orphan_path = f"event/{slug}.md"
                try:
                    removed = await client.delete_record(orphan_path)
                    if removed:
                        stats["orphans_deleted"] += 1
                        if verbose:
                            logger.info("deleted orphan %s", orphan_path)
                except Exception as exc:
                    logger.warning(
                        "orphan delete failed for %s: %s", orphan_path, exc,
                    )
                    stats["orphan_delete_failed"] += 1

    logger.info("----------- summary -----------")
    logger.info("scanned:             %d", stats["scanned"])
    logger.info("render_failed:       %d", stats["render_failed"])
    if write:
        logger.info("written:             %d", stats["written"])
        logger.info("  per record_type:")
        for rt, n in sorted(per_type_writes.items(), key=lambda x: -x[1]):
            logger.info("    %-15s %d", rt, n)
        logger.info("write_failed:        %d", stats["write_failed"])
        if delete_orphans:
            logger.info("orphans_deleted:     %d", stats["orphans_deleted"])
            logger.info("orphan_delete_failed:%d", stats["orphan_delete_failed"])
    else:
        logger.info("(dry-run — no vault mutations)")
        logger.info("sample target paths:")
        for line in first_samples:
            logger.info("%s", line)

    return dict(stats)


async def _run(args: argparse.Namespace) -> int:
    streams_dir = Path(args.streams_dir)
    logger.info("scanning stream JSONL in %s", streams_dir)

    all_events = _iter_events(streams_dir)
    logger.info("found %d total events across stream files", len(all_events))

    stream_types = (
        {s.strip() for s in args.stream_type.split(",") if s.strip()}
        if args.stream_type else None
    )
    if stream_types:
        logger.info("--stream-type filter: %s", sorted(stream_types))
    if args.since:
        # Validate YYYY-MM-DD shape
        try:
            datetime.strptime(args.since, "%Y-%m-%d")
        except ValueError:
            logger.error("--since must be YYYY-MM-DD, got %r", args.since)
            return 2
        logger.info("--since filter: on or after %s", args.since)

    kept, reasons = _filter_events(all_events, stream_types, args.since)
    logger.info("after filters: %d events eligible", len(kept))
    for reason, count in reasons.items():
        logger.info("  %-25s %d", reason, count)

    if args.limit and len(kept) > args.limit:
        logger.info("--limit: processing first %d of %d", args.limit, len(kept))
        kept = kept[: args.limit]

    # Count by stream_type for visibility
    by_type: Counter = Counter(e.get("stream_type", "") for e in kept)
    logger.info("breakdown by stream_type:")
    for st, n in by_type.most_common():
        logger.info("  %-20s %d", st, n)

    if not kept:
        logger.info("nothing to do.")
        return 0

    if not args.write:
        logger.warning(
            "DRY RUN — no --write flag supplied. Re-run with --write to mutate vault."
        )

    config = load_config()
    client = VaultClient(config)
    try:
        await _process(
            kept,
            client=client,
            write=args.write,
            delete_orphans=args.delete_orphans,
            verbose=args.verbose,
        )
    finally:
        await client.close()

    return 0


def main() -> None:
    args = _parse_args()
    try:
        rc = asyncio.run(_run(args))
    except KeyboardInterrupt:
        logger.warning("interrupted")
        rc = 130
    sys.exit(rc)


if __name__ == "__main__":
    main()
