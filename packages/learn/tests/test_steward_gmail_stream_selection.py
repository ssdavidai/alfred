"""Tests for ``steward._list_gmail_stream_files`` — the Composio recurring-break
fix for discovery #293.

Background: gmail stream selection used to glob JSONLs by filename
(``composio-gmail*.jsonl``, ``gmail.jsonl``, ``gmail-*.jsonl``). That
missed UUID-id streams (e.g. ``f7446eaf-…``) created via the UI / a
non-auto-config path, even though those JSONLs were the LIVE pull
target. Steward then read a stale legacy file and reported zero
signals.

The fix selects streams by ``composio_action == "GMAIL_FETCH_EMAILS"``
in ``<streams_dir>/configs/<id>.json`` and resolves them to the
sibling ``<id>.jsonl``. The legacy filename glob remains a fallback.

These tests cover:

* the primary selector picks up UUID-named gmail streams,
* non-gmail composio streams are NOT picked up,
* the legacy filename glob still fires when the configs dir is empty
  / absent,
* config + glob results dedup correctly,
* config files with non-existent JSONLs are silently dropped,
* malformed config JSON does not crash the activity.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.steward import _list_gmail_stream_files  # noqa: E402


def _write_config(configs_dir: Path, stream_id: str, composio_action: str) -> None:
    cfg = {
        "id": stream_id,
        "name": f"test-{stream_id}",
        "enabled": True,
        "composio_action": composio_action,
    }
    (configs_dir / f"{stream_id}.json").write_text(json.dumps(cfg))


def _touch_jsonl(streams_dir: Path, stream_id: str) -> Path:
    p = streams_dir / f"{stream_id}.jsonl"
    p.write_text("")
    return p


# ---------------------------------------------------------------------------
# Primary selector — composio_action == GMAIL_FETCH_EMAILS
# ---------------------------------------------------------------------------


def test_picks_up_uuid_named_gmail_stream(tmp_path: Path) -> None:
    """The discovery-#293 case: stream id is a UUID, legacy globs miss."""
    streams_dir = tmp_path
    configs_dir = streams_dir / "configs"
    configs_dir.mkdir()

    uuid_id = "f7446eaf-b57b-4a18-a7e3-5bb05bde25fc"
    _write_config(configs_dir, uuid_id, "GMAIL_FETCH_EMAILS")
    expected = _touch_jsonl(streams_dir, uuid_id)

    result = _list_gmail_stream_files(str(streams_dir))
    assert str(expected) in result


def test_picks_up_canonical_auto_config_id(tmp_path: Path) -> None:
    """The auto-config id still works through the primary selector."""
    streams_dir = tmp_path
    configs_dir = streams_dir / "configs"
    configs_dir.mkdir()

    cid = "composio-gmail-gmail-fetch-emails"
    _write_config(configs_dir, cid, "GMAIL_FETCH_EMAILS")
    expected = _touch_jsonl(streams_dir, cid)

    result = _list_gmail_stream_files(str(streams_dir))
    assert str(expected) in result


def test_ignores_non_gmail_composio_streams(tmp_path: Path) -> None:
    """Notion / GitHub / Calendar streams must NOT be returned."""
    streams_dir = tmp_path
    configs_dir = streams_dir / "configs"
    configs_dir.mkdir()

    _write_config(configs_dir, "notion-stream", "NOTION_FETCH_DATA")
    _touch_jsonl(streams_dir, "notion-stream")
    _write_config(
        configs_dir, "calendar-stream", "GOOGLECALENDAR_EVENTS_LIST"
    )
    _touch_jsonl(streams_dir, "calendar-stream")

    result = _list_gmail_stream_files(str(streams_dir))
    assert result == []


def test_drops_config_with_missing_jsonl(tmp_path: Path) -> None:
    """A config that points at a non-existent JSONL is silently dropped.

    Freshness check downstream owns the "no data yet" decision; we
    return only files that actually exist on disk.
    """
    streams_dir = tmp_path
    configs_dir = streams_dir / "configs"
    configs_dir.mkdir()

    _write_config(configs_dir, "no-data-yet", "GMAIL_FETCH_EMAILS")
    # NOT touching the JSONL file.

    result = _list_gmail_stream_files(str(streams_dir))
    assert result == []


def test_malformed_config_does_not_crash(tmp_path: Path) -> None:
    """A garbage config file gets skipped, other configs still work."""
    streams_dir = tmp_path
    configs_dir = streams_dir / "configs"
    configs_dir.mkdir()

    (configs_dir / "broken.json").write_text("{not valid json")

    uuid_id = "f7446eaf-uuid-stream"
    _write_config(configs_dir, uuid_id, "GMAIL_FETCH_EMAILS")
    expected = _touch_jsonl(streams_dir, uuid_id)

    result = _list_gmail_stream_files(str(streams_dir))
    assert str(expected) in result


# ---------------------------------------------------------------------------
# Fallback — legacy filename glob
# ---------------------------------------------------------------------------


def test_legacy_glob_fires_when_configs_dir_absent(tmp_path: Path) -> None:
    """Tenant with no configs dir: filename glob still works."""
    streams_dir = tmp_path
    # NOT creating configs/.

    legacy = streams_dir / "composio-gmail-gmail-fetch-emails.jsonl"
    legacy.write_text("")

    result = _list_gmail_stream_files(str(streams_dir))
    assert str(legacy) in result


def test_legacy_glob_fires_when_configs_dir_empty(tmp_path: Path) -> None:
    streams_dir = tmp_path
    (streams_dir / "configs").mkdir()

    legacy = streams_dir / "gmail.jsonl"
    legacy.write_text("")

    result = _list_gmail_stream_files(str(streams_dir))
    assert str(legacy) in result


# ---------------------------------------------------------------------------
# Dedup + combined behaviour
# ---------------------------------------------------------------------------


def test_dedup_when_config_and_glob_both_hit(tmp_path: Path) -> None:
    """The canonical auto-config id hits BOTH the config selector AND
    the legacy ``composio-gmail*`` glob — must only appear once."""
    streams_dir = tmp_path
    configs_dir = streams_dir / "configs"
    configs_dir.mkdir()

    cid = "composio-gmail-gmail-fetch-emails"
    _write_config(configs_dir, cid, "GMAIL_FETCH_EMAILS")
    expected = _touch_jsonl(streams_dir, cid)

    result = _list_gmail_stream_files(str(streams_dir))
    matches = [p for p in result if p == str(expected)]
    assert len(matches) == 1


def test_returns_uuid_and_legacy_when_both_present(tmp_path: Path) -> None:
    """The home.alfred.black live state: a UUID stream AND a stale
    legacy file both exist. Both end up in the result; the freshness
    check downstream picks the live one."""
    streams_dir = tmp_path
    configs_dir = streams_dir / "configs"
    configs_dir.mkdir()

    uuid_id = "f7446eaf-b57b-4a18-a7e3-5bb05bde25fc"
    _write_config(configs_dir, uuid_id, "GMAIL_FETCH_EMAILS")
    uuid_jsonl = _touch_jsonl(streams_dir, uuid_id)

    legacy_jsonl = streams_dir / "composio-gmail-gmail-fetch-emails.jsonl"
    legacy_jsonl.write_text("")

    result = _list_gmail_stream_files(str(streams_dir))
    assert str(uuid_jsonl) in result
    assert str(legacy_jsonl) in result
