"""Tests for the Omi-specific stream_vault template (#517)."""
from __future__ import annotations

import sys
from pathlib import Path

# Make `src.` imports resolve the same way they do inside the container.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.stream_vault import (  # noqa: E402
    _render_event,
    _build_vault_content,
    _template_omi,
)


def _make_omi_event(text: str, **meta_overrides) -> dict:
    raw = {
        "date": "2026-04-22",
        "time_range": "14:00-14:30",
        "languages": ["hu"],
        "segments": 54,
        "duration_seconds": 1800,
        "word_count": 4821,
        "conversation_id": "conv-abc123",
        "part": 1,
        "total_parts": 1,
        "text": text,
    }
    return {
        "stream_type": "omi-audio",
        "source_ref": "omi-audio:uid-1:1698765432",
        "received_at": "2026-04-22T14:00:00+00:00",
        "stream_id": "omi-stream-1",
        "raw": raw,
        "metadata": {
            "uid": "uid-1",
            "date": "2026-04-22",
            "time_range": "14:00-14:30",
            "languages": ["hu"],
            "segments": 54,
            "duration_seconds": 1800,
            "word_count": 4821,
            "parser": "omi",
            **meta_overrides,
        },
    }


def test_render_event_routes_omi_audio_to_omi_template() -> None:
    event = _make_omi_event("Beszéljünk a makerspace projektről…")
    name, body, tags, record_type = _render_event(event)
    assert "Omi conversation" in name
    assert record_type == "conversation"
    assert "omi-audio" in tags
    assert body.startswith("Beszéljünk")  # Full body preserved, not truncated


def test_omi_template_preserves_full_transcript() -> None:
    long_text = "X" * 25_000  # 25k chars — bigger than old 500-char cap
    event = _make_omi_event(long_text)
    name, body, tags, record_type = _template_omi(event, event["raw"], event["metadata"])
    # Body is returned untruncated at this stage — cap happens later in the
    # enrichment fetcher (MAX_BODY_CHARS_PER_EVENT), not in the vault write.
    assert body == long_text
    assert record_type == "conversation"


def test_omi_template_includes_language_tag() -> None:
    event = _make_omi_event("mock content")
    name, body, tags, record_type = _template_omi(event, event["raw"], event["metadata"])
    assert "lang/hu" in tags


def test_build_vault_content_surfaces_omi_metadata() -> None:
    event = _make_omi_event("Mock transcript body.")
    content = _build_vault_content(
        name="Omi conversation — 2026-04-22 14:00-14:30 (hu)",
        event=event,
        body="Mock transcript body.",
        tags=["omi-audio", "lang/hu"],
        record_type="conversation",
    )
    assert "type: conversation" in content
    assert 'conversation_id: "conv-abc123"' in content
    assert "duration_seconds: 1800" in content
    assert "segments: 54" in content
    assert "word_count: 4821" in content
    # No part/total_parts lines when total_parts == 1
    assert "\npart: " not in content


def test_build_vault_content_surfaces_part_info_when_split() -> None:
    event = _make_omi_event("Part 2 body.", part=2, total_parts=3)
    # Template reads from raw OR metadata for part info; match how the
    # real activity writes it.
    event["raw"]["part"] = 2
    event["raw"]["total_parts"] = 3
    content = _build_vault_content(
        name="Omi conversation — 2026-04-22 14:00-14:30 (hu) pt 2/3",
        event=event,
        body="Part 2 body.",
        tags=["omi-audio"],
        record_type="conversation",
    )
    assert "part: 2" in content
    assert "total_parts: 3" in content


def test_non_omi_streams_still_render_as_event() -> None:
    event = {
        "stream_type": "slack",
        "received_at": "2026-04-22T10:00:00+00:00",
        "raw": {"text": "hello from slack", "channel": "general"},
        "metadata": {},
    }
    name, body, tags, record_type = _render_event(event)
    assert record_type == "event"
    assert "slack" in tags
