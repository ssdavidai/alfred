"""Tests for the Design-B (#78) ingest.db → signal-extractor adapter.

The signal extractor consumes stream events from ingest.db (Store 4) instead
of vault `stream_event/` markdown. An ingest.db row's `payload_json` is the
full StreamEvent the puller posted; `_ingest_row_to_record` maps it onto the
`{frontmatter, content}` shape the extractor's pre-filter + prompt builder
expect. These tests pin that mapping and the `ingest:<id>` ref routing.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.signals import (  # noqa: E402
    _INGEST_REF_PREFIX,
    _ingest_row_to_record,
    _infer_source_type,
    _event_body,
    _gmail_sender_domain,
    _pre_filter,
)


def _gmail_ingest_row() -> dict:
    """An ingest.db row mirroring a composio Gmail StreamEvent."""
    payload = {
        "stream_type": "composio",
        "source_ref": "composio:19e42a18b0d4116e",
        "received_at": "2026-05-19T23:45:38Z",
        "summary": '"Acme" <ceo@acme.com>: Q2 contract — please review by Friday',
        "sender": '"Acme" <ceo@acme.com>',
        "subject": "Q2 contract — please review by Friday",
        "metadata": {
            "from": '"Acme" <ceo@acme.com>',
            "to": "owner@example.com",
            "subject": "Q2 contract — please review by Friday",
            "body": "Hi Sir, attached is the Q2 contract. We need your "
            "signature by Friday to keep the project on schedule. Let me "
            "know if anything needs adjusting before then.",
            "event_type": "email",
            "parser": "composio",
        },
    }
    return {
        "id": "01J9ABCXYZ",
        "ts": "2026-05-19T23:45:38Z",
        "stream": "505d9c52-stream",
        "channel": "composio",
        "external_id": "composio:19e42a18b0d4116e",
        "kind": "email",
        "payload_json": json.dumps(payload),
    }


def test_adapter_maps_gmail_to_extractor_shape() -> None:
    rec = _ingest_row_to_record(_gmail_ingest_row())
    assert set(rec) >= {"frontmatter", "content", "_ingest_id"}
    fm = rec["frontmatter"]
    assert fm["from"] == '"Acme" <ceo@acme.com>'
    assert fm["subject"].startswith("Q2 contract")
    assert fm["created"] == "2026-05-19T23:45:38Z"
    assert rec["_ingest_id"] == "01J9ABCXYZ"
    # The composio event_type "email" must classify as gmail downstream.
    assert _infer_source_type(rec) == "gmail"
    # Body must be the email body so the LLM has content to extract from.
    assert "signature by Friday" in _event_body(rec)
    # Sender domain resolves for the newsletter blocklist check.
    assert _gmail_sender_domain(rec) == "acme.com"


def test_adapter_event_passes_pre_filter() -> None:
    rec = _ingest_row_to_record(_gmail_ingest_row())
    accepted, reason = _pre_filter(rec)
    assert accepted, f"expected accept, got reject: {reason}"


def test_adapter_handles_dict_payload_not_just_json_string() -> None:
    row = _gmail_ingest_row()
    # ingest row may arrive with payload_json already decoded (defensive).
    row["payload_json"] = json.loads(row["payload_json"])
    rec = _ingest_row_to_record(row)
    assert _infer_source_type(rec) == "gmail"


def test_adapter_composio_no_results_event_is_unknown() -> None:
    # Composio "SEARCH RETURNED NO RESULTS" envelopes get stored as events
    # with event_type "item" and no real body — they must NOT classify as a
    # processable source (the pre-filter then drops them, zero LLM cost).
    payload = {
        "stream_type": "composio",
        "summary": "SEARCH RETURNED NO RESULTS",
        "metadata": {"event_type": "item", "parser": "composio"},
    }
    row = {"id": "x", "ts": "2026-05-20T00:00:00Z", "payload_json": json.dumps(payload)}
    rec = _ingest_row_to_record(row)
    assert _infer_source_type(rec) == "unknown"
    accepted, _ = _pre_filter(rec)
    assert not accepted


def test_adapter_tolerates_garbage_payload() -> None:
    for bad in ("", "not json", "[]", "null"):
        rec = _ingest_row_to_record({"id": "x", "ts": "t", "payload_json": bad})
        assert rec["frontmatter"]["from"] == ""
        assert rec["content"] == ""


def test_ingest_ref_prefix_constant() -> None:
    assert _INGEST_REF_PREFIX == "ingest:"
