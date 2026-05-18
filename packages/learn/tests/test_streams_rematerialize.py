"""Tests for scripts/streams_rematerialize.py."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.streams_rematerialize import (  # noqa: E402
    _filter_events,
    _iter_events,
    _parse_args,
    _process,
)


# ---------------------------------------------------------------------------
# Argparse
# ---------------------------------------------------------------------------

def test_defaults_are_dry_run() -> None:
    args = _parse_args([])
    assert args.write is False
    assert args.delete_orphans is False
    assert args.stream_type is None
    assert args.since is None


def test_write_flag_required_to_mutate() -> None:
    args = _parse_args(["--write"])
    assert args.write is True


def test_stream_type_parses_csv() -> None:
    args = _parse_args(["--stream-type", "omi-audio,voice-call"])
    assert args.stream_type == "omi-audio,voice-call"


# ---------------------------------------------------------------------------
# _iter_events
# ---------------------------------------------------------------------------

def test_iter_events_reads_all_jsonl(tmp_path: Path) -> None:
    streams = tmp_path / "streams"
    streams.mkdir()
    (streams / "s1.jsonl").write_text(
        json.dumps({"id": "a", "stream_type": "gmail", "source_ref": "r1"}) + "\n"
        + json.dumps({"id": "b", "stream_type": "gmail", "source_ref": "r2"}) + "\n"
    )
    (streams / "s2.jsonl").write_text(
        json.dumps({"id": "c", "stream_type": "slack", "source_ref": "r3"}) + "\n"
    )
    events = _iter_events(streams)
    ids = sorted(e["id"] for e in events)
    assert ids == ["a", "b", "c"]


def test_iter_events_skips_malformed_lines(tmp_path: Path) -> None:
    streams = tmp_path / "streams"
    streams.mkdir()
    (streams / "s.jsonl").write_text(
        json.dumps({"id": "good", "stream_type": "x", "source_ref": "r"}) + "\n"
        + "{not valid json\n"
        + "\n"  # blank line
        + json.dumps({"id": "good2", "stream_type": "x", "source_ref": "r2"}) + "\n"
    )
    events = _iter_events(streams)
    assert [e["id"] for e in events] == ["good", "good2"]


def test_iter_events_missing_dir_returns_empty(tmp_path: Path) -> None:
    assert _iter_events(tmp_path / "does-not-exist") == []


# ---------------------------------------------------------------------------
# _filter_events
# ---------------------------------------------------------------------------

def _event(
    stream_type: str = "gmail",
    source_ref: str = "sr1",
    received_at: str = "2026-04-22T10:00:00Z",
    raw: dict | None = None,
) -> dict:
    return {
        "stream_type": stream_type,
        "source_ref": source_ref,
        "received_at": received_at,
        "raw": {"text": "body"} if raw is None else raw,
    }


def test_filter_by_stream_type() -> None:
    events = [_event("gmail"), _event("slack"), _event("omi-audio")]
    kept, reasons = _filter_events(events, {"omi-audio"}, None)
    assert len(kept) == 1
    assert kept[0]["stream_type"] == "omi-audio"
    assert reasons["filtered_stream_type"] == 2


def test_filter_by_since_drops_older() -> None:
    events = [
        _event(received_at="2026-04-20T10:00:00Z"),
        _event(received_at="2026-04-22T10:00:00Z"),
        _event(received_at="2026-04-25T10:00:00Z"),
    ]
    kept, reasons = _filter_events(events, None, "2026-04-22")
    assert len(kept) == 2
    assert reasons["filtered_by_since"] == 1


def test_filter_drops_malformed_events() -> None:
    events = [
        _event(),  # good
        {"stream_type": "x"},  # no source_ref, no raw
        {"stream_type": "x", "source_ref": "r"},  # no raw
        {"stream_type": "x", "source_ref": "r", "raw": "not a dict"},  # raw wrong type
    ]
    kept, reasons = _filter_events(events, None, None)
    assert len(kept) == 1
    assert reasons["skipped_malformed"] == 3


def test_filter_no_filters_keeps_all_valid_events() -> None:
    events = [_event("gmail"), _event("slack"), _event("omi-audio")]
    kept, reasons = _filter_events(events, None, None)
    assert len(kept) == 3


# ---------------------------------------------------------------------------
# _process (write path)
# ---------------------------------------------------------------------------

def _slack_event() -> dict:
    return {
        "stream_type": "slack",
        "source_ref": "slack:C0001:100.123",
        "received_at": "2026-04-22T10:00:00Z",
        "raw": {"text": "hello", "channel_name": "general"},
    }


def _omi_event() -> dict:
    return {
        "stream_type": "omi-audio",
        "source_ref": "omi-audio:uid1:1000000",
        "received_at": "2026-04-22T10:00:00Z",
        "raw": {
            "text": "Mock transcript body",
            "date": "2026-04-22",
            "time_range": "10:00-10:05",
            "languages": ["en"],
        },
    }


@pytest.mark.asyncio
async def test_dry_run_never_calls_write_or_delete() -> None:
    client = MagicMock()
    client.write_record = AsyncMock()
    client.delete_record = AsyncMock()

    events = [_slack_event(), _omi_event()]
    stats = await _process(
        events,
        client=client,
        write=False,
        delete_orphans=True,  # even with flag, dry-run suppresses
        verbose=False,
    )
    client.write_record.assert_not_called()
    client.delete_record.assert_not_called()
    assert stats["scanned"] == 2
    assert stats.get("written", 0) == 0


@pytest.mark.asyncio
async def test_write_path_calls_write_record_per_event() -> None:
    client = MagicMock()
    client.write_record = AsyncMock(return_value="path")
    client.delete_record = AsyncMock(return_value=False)

    events = [_slack_event()]
    stats = await _process(
        events, client=client, write=True, delete_orphans=False, verbose=False,
    )
    assert stats["written"] == 1
    client.write_record.assert_called_once()
    client.delete_record.assert_not_called()


@pytest.mark.asyncio
async def test_delete_orphans_only_fires_when_record_type_changed() -> None:
    client = MagicMock()
    client.write_record = AsyncMock(return_value="path")
    client.delete_record = AsyncMock(return_value=True)

    events = [
        _slack_event(),  # record_type stays "event" → no orphan delete
        _omi_event(),    # record_type migrates to "conversation" → orphan delete
    ]
    stats = await _process(
        events, client=client, write=True, delete_orphans=True, verbose=False,
    )
    assert stats["written"] == 2
    # Only the omi event should have triggered a delete
    assert client.delete_record.await_count == 1
    delete_path = client.delete_record.call_args.args[0]
    assert delete_path.startswith("event/")
    assert stats["orphans_deleted"] == 1


@pytest.mark.asyncio
async def test_deterministic_slug_across_runs() -> None:
    """Running twice over the same events writes to the same vault paths."""
    client = MagicMock()
    client.write_record = AsyncMock(return_value="path")
    client.delete_record = AsyncMock(return_value=False)

    events = [_slack_event()]
    await _process(events, client=client, write=True, delete_orphans=False, verbose=False)
    first_call_path = (
        client.write_record.call_args.args[0],  # record_type
        client.write_record.call_args.args[1],  # slug
    )

    client.reset_mock()
    await _process(events, client=client, write=True, delete_orphans=False, verbose=False)
    second_call_path = (
        client.write_record.call_args.args[0],
        client.write_record.call_args.args[1],
    )

    assert first_call_path == second_call_path


@pytest.mark.asyncio
async def test_write_error_counted_and_skipped() -> None:
    client = MagicMock()
    client.write_record = AsyncMock(side_effect=RuntimeError("ctrl down"))
    client.delete_record = AsyncMock(return_value=False)

    stats = await _process(
        [_slack_event()],
        client=client, write=True, delete_orphans=False, verbose=False,
    )
    assert stats["write_failed"] == 1
    assert stats.get("written", 0) == 0
