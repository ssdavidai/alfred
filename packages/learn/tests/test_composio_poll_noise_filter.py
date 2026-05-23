"""Generic poll/fetch-result noise filter (Commit 2 of the open-world fix).

Opening the pre-filter gate (Commit 1) means fetch/list poll artifacts now flow
— on the live tenant, 10 empty ``gmail-fetch-emails`` "SEARCH RETURNED NO
RESULTS" envelopes and full ``googlecalendar-events-list`` refreshes. A Composio
tool/fetch result with NO new content must be classified as **garbage → drop +
mark processed (consume)**, NOT as unknown (which would retry-loop) and NOT sent
to the LLM. Empty markers in payload.raw: ``composio_execution_message`` saying
"no results"/"RETURNED NO RESULTS", ``resultSizeEstimate == 0``, empty messages.

Be conservative: a fetch WITH messages/items must still pass.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.signals import (  # noqa: E402
    _ingest_row_to_record,
    _is_garbage_event,
    _is_unknown_source_only_drop,
    _pre_filter,
)


def _fetch_row(app: str, raw: dict, *, body: str = "") -> dict:
    payload = {"stream_id": f"composio-{app}-{app}-fetch-emails",
               "stream_type": "composio", "received_at": "2026-05-22T10:00:00Z",
               "summary": "fetch", "raw": raw,
               "metadata": {"body": body, "event_type": "item", "parser": "composio"}}
    return {"id": f"01J{app}", "ts": "2026-05-22T10:00:00Z", "channel": "composio",
            "kind": "item", "payload_json": json.dumps(payload)}


def test_empty_gmail_fetch_is_garbage_consumed_not_retried() -> None:
    # An empty gmail-fetch poll result: garbage-dropped, marked processed,
    # NO retry valve (so it is consumed, not re-flowed forever).
    rec = _ingest_row_to_record(_fetch_row("gmail", {
        "composio_execution_message": "SEARCH RETURNED NO RESULTS",
        "resultSizeEstimate": 0, "messages": [],
    }))
    is_garbage, reason = _is_garbage_event(rec)
    assert is_garbage, "empty poll fetch must be garbage"
    assert "poll" in reason.lower() or "result" in reason.lower()
    accepted, _ = _pre_filter(rec)
    assert accepted is False
    # consumed (mark processed), NOT retried
    assert _is_unknown_source_only_drop(rec) is False


def test_empty_gmail_fetch_zero_result_size() -> None:
    # resultSizeEstimate == 0 alone is enough to mark an empty poll.
    rec = _ingest_row_to_record(_fetch_row("gmail", {"resultSizeEstimate": 0}))
    is_garbage, _ = _is_garbage_event(rec)
    assert is_garbage


def test_gmail_fetch_with_messages_not_dropped() -> None:
    # Conservative: a fetch WITH messages must NOT be dropped by this rule.
    rec = _ingest_row_to_record(_fetch_row(
        "gmail",
        {"resultSizeEstimate": 1,
         "messages": [{"id": "m1", "subject": "Q2 contract"}]},
        body="Please sign the Q2 contract by Friday to keep us on schedule.",
    ))
    is_garbage, reason = _is_garbage_event(rec)
    assert is_garbage is False, f"non-empty fetch wrongly dropped: {reason}"
    accepted, why = _pre_filter(rec)
    assert accepted, why
