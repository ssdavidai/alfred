"""Omi parser — parse Omi wearable conversation objects into ParsedEvents.

Handles finalized conversation objects from the Omi real-time watcher:
{
  "date": "2026-03-27",
  "time_range": "14:45-15:10",
  "languages": ["hu", "en"],
  "segments": 12,
  "duration_seconds": 1500,
  "word_count": 2847,
  "files": ["2026-03-27/14-45-19_uid.json", ...],
  "text": "Date: 2026-03-27 | ... [14:45] text ..."
}
"""

from __future__ import annotations

from datetime import datetime, timezone

from . import ParsedEvent


def parse(raw: dict) -> list[ParsedEvent]:
    """Parse an Omi conversation object into a single ParsedEvent."""
    date = raw.get("date", "")
    time_range = raw.get("time_range", "")
    languages = raw.get("languages", [])
    segments = raw.get("segments", 0)
    duration = raw.get("duration_seconds", 0)
    word_count = raw.get("word_count", 0)
    text = raw.get("text", "")

    # Build source_ref for dedup: omi:{date}:{time_range}
    source_ref = f"omi:{date}:{time_range}" if date and time_range else ""

    # Build human-readable summary
    langs_str = ", ".join(languages) if languages else "unknown"
    duration_str = f"{duration // 60}m{duration % 60}s" if duration else "?"
    summary = f"Omi conversation ({date} {time_range}, {duration_str}, {word_count} words, {langs_str})"

    # First 200 chars of actual transcript for preview
    # Skip the metadata header line
    lines = text.split("\n\n", 1)
    preview = lines[1][:200] if len(lines) > 1 else text[:200]

    return [
        ParsedEvent(
            source_ref=source_ref,
            summary=summary,
            raw=raw,
            event_type="omi-conversation",
            received_at=datetime.now(timezone.utc).isoformat(),
            metadata={
                "date": date,
                "time_range": time_range,
                "languages": languages,
                "segments": segments,
                "duration_seconds": duration,
                "word_count": word_count,
                "preview": preview,
                "parser": "omi",
            },
        )
    ]
