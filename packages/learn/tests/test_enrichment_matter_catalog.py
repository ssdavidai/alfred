"""Tests for matter-catalog injection into the enrichment prompt."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.enrichment import (  # noqa: E402
    _build_matter_catalog_block,
    _fetch_matter_catalog,
    apply_enrichments,
)


def test_empty_catalog_renders_empty_block() -> None:
    assert _build_matter_catalog_block([]) == ""


def test_catalog_renders_as_markdown_list() -> None:
    catalog = [
        {"path": "matter/foo.md", "name": "Foo Matter", "description": "about foos"},
        {"path": "matter/bar.md", "name": "Bar", "description": ""},
    ]
    block = _build_matter_catalog_block(catalog)
    assert "matter/foo.md" in block
    assert "Foo Matter" in block
    assert "about foos" in block
    assert "matter/bar.md" in block
    assert "KNOWN MATTERS" in block


@pytest.mark.asyncio
async def test_fetch_matter_catalog_filters_to_active_only() -> None:
    client = MagicMock()
    client.list_records = AsyncMock(return_value=[
        {"path": "matter/active.md", "frontmatter": {"status": "active", "name": "Active"},
         "body": "This is an active matter."},
        {"path": "matter/done.md", "frontmatter": {"status": "resolved", "name": "Done"},
         "body": "This was closed."},
        {"path": "matter/no-status.md", "frontmatter": {"name": "No Status"},
         "body": "No status field — treated as active."},
    ])
    catalog = await _fetch_matter_catalog(client)
    paths = [m["path"] for m in catalog]
    assert "matter/active.md" in paths
    assert "matter/no-status.md" in paths
    assert "matter/done.md" not in paths


@pytest.mark.asyncio
async def test_fetch_matter_catalog_skips_non_matter_paths() -> None:
    client = MagicMock()
    client.list_records = AsyncMock(return_value=[
        {"path": "matter/valid.md", "frontmatter": {"status": "active", "name": "Valid"}, "body": ""},
        {"path": "person/x.md", "frontmatter": {"status": "active"}, "body": ""},  # wrong type
        {"path": "bad", "frontmatter": {"status": "active"}, "body": ""},  # wrong shape
    ])
    catalog = await _fetch_matter_catalog(client)
    assert [m["path"] for m in catalog] == ["matter/valid.md"]


@pytest.mark.asyncio
async def test_fetch_matter_catalog_tolerates_failure() -> None:
    client = MagicMock()
    client.list_records = AsyncMock(side_effect=RuntimeError("ctrl-api down"))
    catalog = await _fetch_matter_catalog(client)
    assert catalog == []


@pytest.mark.asyncio
async def test_apply_enrichments_validates_related_matters_path_form() -> None:
    """Ensure only properly-formed matter/<slug>.md paths get written to
    frontmatter. Hallucinated / bare / empty values are dropped."""
    fake_record = {
        "path": "event/foo.md",
        "frontmatter": {
            "type": "event",
            "name": "Test",
            "stream_type": "gmail",
            "enrichment_status": "pending",
        },
        "body": "body text",
    }
    client = MagicMock()
    client.read_record = AsyncMock(return_value=fake_record)
    client.write_record = AsyncMock(return_value="event/foo.md")
    client.close = AsyncMock()

    with patch("src.activities.enrichment.VaultClient", return_value=client):
        enrichments = [{
            "event_index": 0,
            "entities": [],
            "topic_tags": [],
            "related_matters": [
                "matter/real-matter.md",    # clean — keep
                "matter/another",           # missing .md — normalise
                "bare-name",                # no prefix — normalise
                "",                         # empty — drop
                123,                         # non-string — drop
                "matter/real-matter.md",    # dupe — drop
            ],
            "action_items": [],
            "priority": "normal",
        }]
        await apply_enrichments(enrichments, ["event/foo.md"])

    _, _, written = client.write_record.call_args.args
    # Three unique good paths
    assert "matter/real-matter.md" in written
    assert "matter/another.md" in written
    assert "matter/bare-name.md" in written
    # No dupe, no numbers, no empty
    assert written.count("matter/real-matter.md") == 1
