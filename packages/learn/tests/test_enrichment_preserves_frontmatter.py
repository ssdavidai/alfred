"""Regression tests for #525 — apply_enrichments must NOT strip the
frontmatter of the source record during write-back.

ctrl-api's vault read returns {path, frontmatter: dict, body: str} —
NOT a `content` field. Before #525, apply_enrichments did:

    full_content = record.get("content", record.get("body", ""))

which fell through to `body`, wrote body-only to ctrl-api, and
destroyed every touched record's YAML block. Thousands of vault
records across the fleet had to be rematerialized to recover.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


@pytest.mark.asyncio
async def test_apply_enrichments_preserves_frontmatter_when_no_content_field() -> None:
    """The ctrl-api vault read response is the realistic shape.
    apply_enrichments must reconstruct the full markdown from it."""
    from src.activities.enrichment import apply_enrichments

    # Realistic shape from GET /api/v1/vault/records/<path>
    fake_record = {
        "path": "event/foo.md",
        "frontmatter": {
            "type": "event",
            "name": "Test event",
            "created": "2026-04-22T10:00:00Z",
            "stream_type": "gmail",
            "tags": ["gmail"],
            "enrichment_status": "pending",
        },
        "body": "# Test event\n\nSome event body text here.\n",
    }

    client = MagicMock()
    client.read_record = AsyncMock(return_value=fake_record)
    client.write_record = AsyncMock(return_value="event/foo.md")
    client.close = AsyncMock()

    with patch("src.activities.enrichment.VaultClient", return_value=client):
        enrichments = [{
            "event_index": 0,
            "entities": [{"name": "Alice", "type": "person"}],
            "topic_tags": ["testing"],
            "related_matters": [],
            "action_items": [],
            "priority": "normal",
        }]
        result = await apply_enrichments(enrichments, ["event/foo.md"])

    assert result["records_enriched"] == 1
    # Inspect what got written
    record_type, slug, written_content = client.write_record.call_args.args
    assert record_type == "event"
    # Must start with YAML frontmatter delimiter
    assert written_content.startswith("---\n"), (
        f"Write destroyed frontmatter! Got:\n{written_content[:200]}"
    )
    # Must close the YAML block properly
    assert "\n---\n" in written_content
    # Must preserve original body
    assert "Some event body text here." in written_content
    # Must inject enrichment fields
    assert "enrichment_status: enriched" in written_content
    assert "entities:" in written_content


@pytest.mark.asyncio
async def test_apply_enrichments_handles_empty_frontmatter_gracefully() -> None:
    """Records with no frontmatter fall through without crashing — the
    write is skipped since there's nothing to inject into safely."""
    from src.activities.enrichment import apply_enrichments

    fake_record = {
        "path": "event/bare.md",
        "frontmatter": {},
        "body": "body only",
    }
    client = MagicMock()
    client.read_record = AsyncMock(return_value=fake_record)
    client.write_record = AsyncMock(return_value="event/bare.md")
    client.close = AsyncMock()

    with patch("src.activities.enrichment.VaultClient", return_value=client):
        enrichments = [{"event_index": 0, "entities": [], "topic_tags": [],
                        "related_matters": [], "action_items": [], "priority": "low"}]
        # Should not raise, even with no frontmatter. _inject_frontmatter_fields
        # returns content unchanged if no YAML block; we just accept that.
        await apply_enrichments(enrichments, ["event/bare.md"])


@pytest.mark.asyncio
async def test_apply_enrichments_uses_content_field_when_present() -> None:
    """Backwards compat: if read_record ever returns a `content` field
    (the old shape some code assumes), use it directly."""
    from src.activities.enrichment import apply_enrichments

    fake_record = {
        "path": "event/legacy.md",
        "content": (
            "---\n"
            "type: event\n"
            "name: Legacy\n"
            "enrichment_status: pending\n"
            "---\n"
            "\n"
            "Legacy body\n"
        ),
    }
    client = MagicMock()
    client.read_record = AsyncMock(return_value=fake_record)
    client.write_record = AsyncMock(return_value="event/legacy.md")
    client.close = AsyncMock()

    with patch("src.activities.enrichment.VaultClient", return_value=client):
        enrichments = [{"event_index": 0, "entities": [], "topic_tags": ["t"],
                        "related_matters": [], "action_items": [], "priority": "low"}]
        await apply_enrichments(enrichments, ["event/legacy.md"])

    _, _, written = client.write_record.call_args.args
    assert written.startswith("---\n")
    assert "Legacy body" in written
