"""Passthrough parser — wraps raw response as-is into a single ParsedEvent."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from . import ParsedEvent


def parse(raw: dict) -> list[ParsedEvent]:
    """Wrap raw API response as a single event with no transformation."""
    source_ref = raw.get("id", raw.get("source_ref", ""))
    if not source_ref:
        source_ref = f"raw-{hash(json.dumps(raw, sort_keys=True, default=str)) & 0xFFFFFFFF:08x}"

    summary = raw.get("summary", raw.get("title", raw.get("description", "")))
    if not summary:
        # Best-effort: use first 120 chars of JSON
        summary = json.dumps(raw, default=str)[:120]

    return [
        ParsedEvent(
            source_ref=str(source_ref),
            summary=str(summary),
            raw=raw,
            event_type=raw.get("type", "unknown"),
            received_at=raw.get("received_at", datetime.now(timezone.utc).isoformat()),
            metadata={},
        )
    ]
