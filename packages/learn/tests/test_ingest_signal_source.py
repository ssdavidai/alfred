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
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.signals import (  # noqa: E402
    MAX_CLERK_BODY_CHARS,
    _INGEST_REF_PREFIX,
    _ingest_row_to_record,
    _infer_source_type,
    _event_body,
    _gmail_sender_domain,
    _is_unknown_source_only_drop,
    _pre_filter,
)

# Use a timestamp relative to now (well inside the signal pre-filter's
# MAX_EVENT_AGE_DAYS_DEFAULT=14 window) so the fixtures never expire. The
# same value is reused for both the fixture and the `created` assertion below.
_recent_iso = (datetime.now(timezone.utc) - timedelta(days=1)).strftime(
    "%Y-%m-%dT%H:%M:%SZ"
)


def _gmail_ingest_row() -> dict:
    """An ingest.db row mirroring a composio Gmail StreamEvent."""
    payload = {
        "stream_type": "composio",
        "source_ref": "composio:19e42a18b0d4116e",
        "received_at": _recent_iso,
        "summary": '"Acme" <ceo@acme.com>: Q2 contract — please review by Friday',
        "sender": '"Acme" <ceo@acme.com>',
        "subject": "Q2 contract — please review by Friday",
        "metadata": {
            "from": '"Acme" <ceo@acme.com>',
            "to": "owner@example.com",
            "subject": "Q2 contract — please review by Friday",
            "body": "Hi Jane, attached is the Q2 contract. We need your "
            "signature by Friday to keep the project on schedule. Let me "
            "know if anything needs adjusting before then.",
            "event_type": "email",
            "parser": "composio",
        },
    }
    return {
        "id": "01J9ABCXYZ",
        "ts": _recent_iso,
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
    assert fm["created"] == _recent_iso
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
    row = {"id": "x", "ts": _recent_iso, "payload_json": json.dumps(payload)}
    rec = _ingest_row_to_record(row)
    assert _infer_source_type(rec) == "unknown"
    accepted, _ = _pre_filter(rec)
    assert not accepted
    # ...and it is consumed (garbage drop + mark processed), NOT retry-looped:
    # the empty-poll noise filter catches the composio "no results" envelope.
    assert _is_unknown_source_only_drop(rec) is False


def test_adapter_tolerates_garbage_payload() -> None:
    for bad in ("", "not json", "[]", "null"):
        rec = _ingest_row_to_record({"id": "x", "ts": "t", "payload_json": bad})
        assert rec["frontmatter"]["from"] == ""
        assert rec["content"] == ""


def test_ingest_ref_prefix_constant() -> None:
    assert _INGEST_REF_PREFIX == "ingest:"


# ---------------------------------------------------------------------------
# Webhook source_type passthrough — the shape ctrl-api's webhook route
# actually writes to ingest.db, pasted verbatim from the live store evidence.
# The pre-#520-fix failure: _ingest_row_to_record never read payload.source_type,
# so kind="webhook" fell through to _normalize_source_type which returned
# "unknown", causing the retry loop to spin indefinitely.
# ---------------------------------------------------------------------------

def _webhook_ingest_row(label: str = "Fathom meeting content") -> dict:
    """Real ingest.db row shape for a ctrl-api webhook event.

    Keys match the live store evidence:
      row.kind    = "webhook"
      row.channel = "webhook:<label>"
      payload_json is a JSON *string* with exactly the four keys the
      ctrl-api webhook route writes, plus a summary so the body check
      in _pre_filter (MIN_CONTENT_LENGTH=20) has something to read.
    """
    payload = {
        "source_type": f"webhook:{label}",
        "source_ref": f"webhook:{label}:1723280000",
        "received_at": _recent_iso,
        "payload": {"text": "Meeting complete. Action items: schedule follow-up."},
        # _ingest_row_to_record reads payload.summary as the body fallback.
        "summary": "Meeting complete. Action items: schedule follow-up by Friday.",
    }
    return {
        "id": "01JABCWEBHOOK",
        "ts": _recent_iso,
        "stream": "webhook-stream",
        # row.channel mirrors the source_type that ctrl-api writes.
        "channel": f"webhook:{label}",
        # row.kind is just the bare transport class — no colon.
        "kind": "webhook",
        "payload_json": json.dumps(payload),
    }


def test_webhook_row_source_type_passthrough() -> None:
    """payload.source_type must win over row.kind in the fallback chain.

    Before this fix, _ingest_row_to_record skipped payload.source_type and
    fell through to row.kind ("webhook"), which _normalize_source_type
    then classified as "unknown", triggering the retry valve.
    """
    rec = _ingest_row_to_record(_webhook_ingest_row())
    fm = rec["frontmatter"]
    # The explicit payload.source_type must propagate into frontmatter
    # (case-preserved as ctrl-api wrote it).
    assert fm["source_type"] == "webhook:Fathom meeting content", (
        f"expected 'webhook:Fathom meeting content', got {fm['source_type']!r}"
    )
    # _infer_source_type lowercases before normalizing, so the returned
    # token is the lowercased labelled form — not "unknown".
    inferred = _infer_source_type(rec)
    assert inferred == "webhook:fathom meeting content", (
        f"expected 'webhook:fathom meeting content', got {inferred!r}"
    )
    assert inferred != "unknown"


def test_webhook_row_accepted_by_pre_filter() -> None:
    """A webhook ingest row with a labelled source_type must pass pre_filter."""
    rec = _ingest_row_to_record(_webhook_ingest_row())
    accepted, reason = _pre_filter(rec)
    assert accepted, f"webhook ingest row must be accepted, got: {reason!r}"
    assert not _is_unknown_source_only_drop(rec)


def test_bare_webhook_kind_no_payload_source_type_classifies_as_webhook() -> None:
    """kind='webhook' with no payload.source_type → 'webhook', not 'unknown'.

    A producer that only stamps kind="webhook" (bare, no colon label) must
    not trigger the unknown-source retry valve. Fix 2 in _normalize_source_type
    makes bare "webhook" a classified transport.
    """
    payload = {
        "source_ref": "webhook:anon:1723280000",
        "received_at": _recent_iso,
        "payload": {"text": "Some webhook payload with enough content to clear the filter."},
    }
    row = {
        "id": "01JBARE",
        "ts": _recent_iso,
        "kind": "webhook",
        "payload_json": json.dumps(payload),
    }
    rec = _ingest_row_to_record(row)
    # Must classify as "webhook" — not "unknown".
    inferred = _infer_source_type(rec)
    assert inferred == "webhook", f"expected 'webhook', got {inferred!r}"
    # Must not be flagged as a retry-only unknown-source drop.
    assert not _is_unknown_source_only_drop(rec)


def test_composio_ordering_not_regressed_by_payload_source_type() -> None:
    """Adding payload.source_type must not affect composio rows.

    Composio rows derive source_type from stream_id (ahead of
    payload.source_type in the chain) — the fix must leave that untouched.
    """
    rec = _ingest_row_to_record(_gmail_ingest_row())
    # Composio Gmail must still classify as "gmail", not fall through to
    # payload.source_type or any other field.
    assert _infer_source_type(rec) == "gmail"


def test_no_transport_markers_still_unknown_and_defers() -> None:
    """A row with no transport markers at all must still be 'unknown' and deferred."""
    payload = {
        "received_at": _recent_iso,
        "payload": {"text": "Some content long enough to clear the body-length check."},
    }
    row = {
        "id": "01JNONE",
        "ts": _recent_iso,
        "payload_json": json.dumps(payload),
    }
    rec = _ingest_row_to_record(row)
    assert _infer_source_type(rec) == "unknown"
    accepted, reason = _pre_filter(rec)
    assert not accepted and "unknown" in reason
    assert _is_unknown_source_only_drop(rec) is True


# ---------------------------------------------------------------------------
# Webhook body extraction — #465 gap 3
#
# The real webhook envelope ctrl-api writes to ingest.db has exactly four
# top-level keys: source_type, source_ref, received_at, payload.  None of
# the composio-shape body keys (metadata.body, raw.messageText, summary)
# exist.  Before the gap-3 fix _ingest_row_to_record produced body="" for
# every webhook row, so _pre_filter dropped all of them as "body too short".
#
# Fixtures here use the verified four-key shape.  No "summary" workaround,
# no extra keys — the exact shape the live store had at the time of the bug.
# ---------------------------------------------------------------------------


def _real_webhook_ingest_row(
    label: str = "meeting-notes",
    nested_payload: dict | None = None,
) -> dict:
    """Ingest row with the exact four-key envelope shape ctrl-api writes.

    payload_json is a JSON string with exactly:
      source_type, source_ref, received_at, payload
    No "summary", no "metadata", no "raw".
    """
    if nested_payload is None:
        nested_payload = {
            "transcript": "The team agreed to deliver the feature spec by end of sprint."
        }
    return {
        "id": "test-real-wh-001",
        "kind": "webhook",
        "channel": f"webhook:{label}",
        "ts": _recent_iso,
        "payload_json": json.dumps({
            "source_type": f"webhook:{label}",
            "source_ref": f"wh-{label}-001",
            "received_at": _recent_iso,
            "payload": nested_payload,
        }),
    }


def test_real_webhook_row_body_from_nested_transcript_field() -> None:
    """Body must come from payload.payload.transcript for the real envelope shape."""
    rec = _ingest_row_to_record(_real_webhook_ingest_row())
    body = _event_body(rec)
    assert body, "body must be non-empty when payload.payload has a transcript field"
    assert "feature spec" in body


def test_real_webhook_row_passes_pre_filter() -> None:
    """A real webhook row (no summary key) must pass _pre_filter after the gap-3 fix."""
    rec = _ingest_row_to_record(_real_webhook_ingest_row())
    accepted, reason = _pre_filter(rec)
    assert accepted, f"expected accept, got: {reason!r}"


def test_real_webhook_oversized_payload_capped_at_word_boundary() -> None:
    """A 25 000-char nested payload must be capped at MAX_CLERK_BODY_CHARS."""
    oversized = {"transcript": ("word " * 5000).strip()}  # ~25 000 chars
    rec = _ingest_row_to_record(_real_webhook_ingest_row(nested_payload=oversized))
    body = _event_body(rec)
    # Cap leaves at most MAX_CLERK_BODY_CHARS chars before the ellipsis.
    assert len(body) <= MAX_CLERK_BODY_CHARS + 1  # +1 for the appended "…"
    assert body.endswith("…"), "capped body must end with ellipsis"
    # Word boundary: the cut must not land inside the word "word".
    assert not body[:-1].endswith("wor"), "cut must not land mid-word"


def test_real_webhook_json_fallback_for_opaque_schema() -> None:
    """When nested payload has no text field, compact JSON is the body fallback."""
    opaque = {"meeting_id": "mtg-42", "attendee_count": 5, "status": "completed"}
    rec = _ingest_row_to_record(_real_webhook_ingest_row(nested_payload=opaque))
    body = _event_body(rec)
    assert body, "JSON fallback must yield non-empty body for an opaque schema"
    assert "meeting_id" in body, "compact JSON must include the key"
    accepted, reason = _pre_filter(rec)
    assert accepted, f"opaque-schema webhook must pass pre_filter: {reason!r}"
