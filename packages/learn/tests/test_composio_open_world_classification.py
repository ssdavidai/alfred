"""Open-world Composio transport classification (the closed-world allowlist bug).

Every composio event shares ONE envelope (stream_type/channel == "composio",
metadata.parser == "composio"); the real app is in stream_id
(composio-<app>-<trigger>). The old classifier read metadata.event_type, which
the parser stamps as the GENERIC label "item"/"cancelled" — so every composio
event collapsed to `unknown`, hit the allowlist gate, and retry-looped forever
(18 real GCal events were stuck). The fix classifies by transport, not by app.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.signals import (  # noqa: E402
    _ingest_row_to_record,
    _infer_source_type,
    _normalize_source_type,
    _is_unknown_source_only_drop,
    _pre_filter,
)


def _row(app: str, body: str, subject: str = "x") -> dict:
    payload = {"stream_id": f"composio-{app}-{app}-list", "stream_type": "composio",
               "received_at": "2026-05-22T10:00:00Z", "summary": subject, "subject": subject,
               "metadata": {"subject": subject, "body": body,
                            "event_type": "item", "parser": "composio"}}
    return {"id": f"01J{app}", "ts": "2026-05-22T10:00:00Z", "channel": "composio",
            "kind": "item", "payload_json": json.dumps(payload)}


def test_normalize_googlecalendar_no_separator() -> None:
    # composio's app token has no separators — the old normalizer missed it.
    assert _normalize_source_type("googlecalendar") == "gcal"
    assert _normalize_source_type("google-calendar") == "gcal"


def test_composio_gmail_classified_and_accepted() -> None:
    rec = _ingest_row_to_record(_row("gmail", "Please sign the Q2 contract by Friday."))
    assert _infer_source_type(rec) == "gmail"
    accepted, reason = _pre_filter(rec)
    assert accepted, reason


def test_composio_googlecalendar_classified_and_accepted() -> None:
    rec = _ingest_row_to_record(_row("googlecalendar", "Board meeting on the Q3 roadmap."))
    assert _infer_source_type(rec) == "gcal"
    accepted, reason = _pre_filter(rec)
    assert accepted, reason


def test_composio_notion_open_world_accepted_not_unknown() -> None:
    # THE open-world test: an app with no handler flows through generically.
    rec = _ingest_row_to_record(_row("notion", "The Q3 roadmap page was updated."))
    src = _infer_source_type(rec)
    assert src == "notion", f"expected open-world 'notion', got {src!r}"
    accepted, reason = _pre_filter(rec)
    assert accepted, f"open-world app must be ACCEPTED: {reason}"
    assert _is_unknown_source_only_drop(rec) is False


def test_native_gmail_via_tags_still_classified() -> None:
    # Regression: a non-composio native gmail event is unchanged.
    rec = {"frontmatter": {"stream_type": "gmail", "from": "ceo@acme.com",
                           "subject": "Re: terms", "tags": ["gmail", "email"]},
           "content": "Can we close the contract by Friday? Please confirm."}
    assert _infer_source_type(rec) == "gmail"
    accepted, reason = _pre_filter(rec)
    assert accepted, reason


def test_malformed_event_no_signal_is_unknown_only_drop() -> None:
    # Valve preserved: no transport signal at all → unknown → retry.
    rec = {"frontmatter": {"name": "Re: terms", "subject": "Re: terms"},
           "content": "Following up on the contract — can we close by Friday?"}
    assert _infer_source_type(rec) == "unknown"
    accepted, reason = _pre_filter(rec)
    assert accepted is False and "unknown" in reason
    assert _is_unknown_source_only_drop(rec) is True
