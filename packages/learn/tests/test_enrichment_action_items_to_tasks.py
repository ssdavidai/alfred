"""Tests for action_items → task/ vault record materialization (#518)."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.enrichment import (  # noqa: E402
    _create_task_for_action_item,
    _slug_for_action_item,
    _split_vault_path,
)


# ---------------------------------------------------------------------------
# _split_vault_path
# ---------------------------------------------------------------------------

def test_split_vault_path_basic() -> None:
    assert _split_vault_path("event/foo.md") == ("event", "foo")


def test_split_vault_path_conversation() -> None:
    assert _split_vault_path("conversation/bar.md") == ("conversation", "bar")


def test_split_vault_path_nested_slug() -> None:
    assert _split_vault_path("note/deeply/nested/thing.md") == ("note", "deeply/nested/thing")


def test_split_vault_path_strips_leading_slash() -> None:
    assert _split_vault_path("/event/foo.md") == ("event", "foo")


def test_split_vault_path_invalid_returns_empty_tuple() -> None:
    assert _split_vault_path("") == ("", "")
    assert _split_vault_path("no-slash.md") == ("", "")


# ---------------------------------------------------------------------------
# _slug_for_action_item
# ---------------------------------------------------------------------------

def test_slug_deterministic_for_same_inputs() -> None:
    a = _slug_for_action_item("event/foo.md", "Follow up with Sam")
    b = _slug_for_action_item("event/foo.md", "Follow up with Sam")
    assert a == b
    # 8-char hash prefix + kebab summary
    assert len(a.split("-")[0]) == 8


def test_slug_differs_by_event_path() -> None:
    a = _slug_for_action_item("event/a.md", "Same action")
    b = _slug_for_action_item("event/b.md", "Same action")
    assert a != b


def test_slug_differs_by_action_text() -> None:
    a = _slug_for_action_item("event/x.md", "action one")
    b = _slug_for_action_item("event/x.md", "action two")
    assert a != b


def test_slug_survives_unicode() -> None:
    slug = _slug_for_action_item("event/x.md", "Küldj emlékeztetőt holnap péntekig")
    assert slug  # no crash on non-ASCII chars
    # Non-ASCII gets replaced by hyphens after lowercase → only hash + empty summary → "<hash>-task" fallback
    assert "-" in slug


# ---------------------------------------------------------------------------
# _create_task_for_action_item — happy path + idempotency
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_creates_task_with_propagated_related_fields() -> None:
    client = MagicMock()
    client.read_record = AsyncMock(side_effect=Exception("not found"))  # 404 sim
    client.write_record = AsyncMock(return_value="task/abc-follow-up.md")

    ok = await _create_task_for_action_item(
        client=client,
        action_item="Follow up with Sam on equipment order",
        source_event_path="event/2026-04-22-example-bank-meeting.md",
        related_matters=["matter/example-bank-agentic-coding-makerspace.md"],
        related_persons=["person/Sam Riley.md"],
        related_orgs=["org/Example Bank.md"],
    )
    assert ok is True
    client.write_record.assert_called_once()
    args, _ = client.write_record.call_args
    record_type, slug, content = args
    assert record_type == "task"
    assert "type: task" in content
    assert "Follow up with Sam on equipment order" in content
    assert "matter/example-bank-agentic-coding-makerspace.md" in content
    assert "person/Sam Riley.md" in content
    assert "org/Example Bank.md" in content
    assert "source_event:" in content
    assert "auto-from-enrichment" in content


@pytest.mark.asyncio
async def test_idempotent_when_task_already_exists() -> None:
    client = MagicMock()
    client.read_record = AsyncMock(return_value={"path": "task/abc.md"})
    client.write_record = AsyncMock(return_value="")

    ok = await _create_task_for_action_item(
        client=client,
        action_item="Same item",
        source_event_path="event/foo.md",
        related_matters=[],
        related_persons=[],
        related_orgs=[],
    )
    assert ok is False
    client.write_record.assert_not_called()


@pytest.mark.asyncio
async def test_extracts_inline_wikilinks_as_related() -> None:
    """If the action_item text contains [[person/X]], [[matter/Y]], etc., the
    task's related_* lists should include those refs even if the caller
    didn't pass them explicitly."""
    client = MagicMock()
    client.read_record = AsyncMock(side_effect=Exception("not found"))
    client.write_record = AsyncMock(return_value="task/slug.md")

    await _create_task_for_action_item(
        client=client,
        action_item="Email [[person/Pat Brown]] about [[matter/anytown-property-land-development]] budget",
        source_event_path="event/x.md",
        related_matters=[],
        related_persons=[],
        related_orgs=[],
    )
    args, _ = client.write_record.call_args
    _, _, content = args
    assert "person/Pat Brown.md" in content
    assert "matter/anytown-property-land-development.md" in content


@pytest.mark.asyncio
async def test_write_error_returns_false_without_crash() -> None:
    client = MagicMock()
    client.read_record = AsyncMock(side_effect=Exception("not found"))
    client.write_record = AsyncMock(side_effect=RuntimeError("ctrl down"))

    ok = await _create_task_for_action_item(
        client=client,
        action_item="Some action",
        source_event_path="event/x.md",
        related_matters=[],
        related_persons=[],
        related_orgs=[],
    )
    assert ok is False


@pytest.mark.asyncio
async def test_yaml_safe_when_ref_contains_brackets() -> None:
    """org/claude[bot].md and similar GitHub-bot slugs contain YAML flow-
    sequence specials. Without quoting, every subsequent `vault edit`
    fails with "Malformed YAML frontmatter" and the record becomes
    permanently un-editable until manually rewritten.
    """
    import yaml

    client = MagicMock()
    client.read_record = AsyncMock(side_effect=Exception("not found"))
    client.write_record = AsyncMock(return_value="task/slug.md")

    await _create_task_for_action_item(
        client=client,
        action_item="Review PR for issue 37",
        source_event_path="event/some-pr.md",
        related_matters=["matter/alfred-platform.md"],
        related_persons=["person/octocat.md"],
        related_orgs=["org/claude[bot].md", "org/alfred-platform.md"],
    )
    _, _, content = client.write_record.call_args[0]
    fm_text = content.split("---\n", 2)[1]
    parsed = yaml.safe_load(fm_text)
    assert parsed["related_orgs"] == ["org/claude[bot].md", "org/alfred-platform.md"]


def test_format_fm_line_yaml_safe_with_specials() -> None:
    """`_format_fm_line` is the second injection point — used by
    `apply_enrichments` to overwrite enriched records' frontmatter.
    Same bracket/colon/comma hazards apply.
    """
    import yaml
    from src.activities.enrichment import _format_fm_line  # noqa: WPS433

    line = _format_fm_line("entities", ["org/claude[bot]", "person/octocat", "org/foo, bar"])
    parsed = yaml.safe_load(line)
    assert parsed["entities"] == ["org/claude[bot]", "person/octocat", "org/foo, bar"]


@pytest.mark.asyncio
async def test_deduplicates_wikilinks_with_passed_related() -> None:
    client = MagicMock()
    client.read_record = AsyncMock(side_effect=Exception("not found"))
    client.write_record = AsyncMock(return_value="task/slug.md")

    # Caller passed the matter; action text ALSO mentions it — should not
    # appear twice in related_matters
    await _create_task_for_action_item(
        client=client,
        action_item="Update [[matter/example-bank-agentic-coding-makerspace]] notes",
        source_event_path="event/x.md",
        related_matters=["matter/example-bank-agentic-coding-makerspace.md"],
        related_persons=[],
        related_orgs=[],
    )
    args, _ = client.write_record.call_args
    _, _, content = args
    # Count occurrences on the related_matters line
    lines = [l for l in content.splitlines() if l.startswith("related_matters:")]
    assert len(lines) == 1
    assert lines[0].count("example-bank-agentic-coding-makerspace") == 1
