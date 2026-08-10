"""Webhook transport classification and body-cap tests (#465).

ctrl-api stamps ``source_type: webhook:<label>`` on inbound webhook events.
Before this fix, ``_normalize_source_type`` returned ``"unknown"`` for that
token, causing a permanent retry loop (``UnknownSourceTypeRetry`` every 5 min,
0 signals written).  The fix treats ``webhook:<label>`` as a classified
transport — same open-world contract as unenumerated composio apps.

Body-cap tests: large webhook payloads (50–242 KB transcripts) must be
truncated before the LLM call to prevent the #193 context-overflow class.

Regression: an event with NO source_type must still classify as ``"unknown"``
and trigger the retry valve (#9/C6) — not a silent terminal drop.
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.signals import (  # noqa: E402
    MAX_CLERK_BODY_CHARS,
    _cap_at_word_boundary,
    _infer_source_type,
    _is_unknown_source_only_drop,
    _normalize_source_type,
    _pre_filter,
)

_recent_iso = (datetime.now(timezone.utc) - timedelta(days=1)).strftime(
    "%Y-%m-%dT%H:%M:%SZ"
)


def _webhook_rec(label: str, body: str) -> dict:
    return {
        "frontmatter": {
            "source_type": f"webhook:{label}",
            "stream_type": f"webhook:{label}",
            "created": _recent_iso,
        },
        "content": body,
    }


def test_webhook_label_normalizes_to_stable_token() -> None:
    assert _normalize_source_type("webhook:fathom") == "webhook:fathom"
    assert _normalize_source_type("webhook:zapier") == "webhook:zapier"


def test_bare_webhook_without_label_stays_unknown() -> None:
    """'webhook:' with empty label is not a classified transport."""
    assert _normalize_source_type("webhook:") == "unknown"


def test_webhook_event_inferred_source_type() -> None:
    rec = _webhook_rec("fathom", "Meeting summary: discussed Q3 roadmap and action items.")
    assert _infer_source_type(rec) == "webhook:fathom"


def test_webhook_event_accepted_by_pre_filter() -> None:
    rec = _webhook_rec("fathom", "Meeting notes: agreed to deliver the spec by end of sprint.")
    accepted, reason = _pre_filter(rec)
    assert accepted, f"webhook event must be accepted, got: {reason!r}"


def test_webhook_event_not_unknown_source_only_drop() -> None:
    rec = _webhook_rec("fathom", "Meeting notes: budget approved, next review in two weeks.")
    assert _is_unknown_source_only_drop(rec) is False


def test_cap_at_word_boundary_within_budget_unchanged() -> None:
    text = "Short text within budget."
    assert _cap_at_word_boundary(text, 100) == text


def test_cap_at_word_boundary_result_length() -> None:
    """Content before the ellipsis must be within budget."""
    big_body = ("word " * 5000).strip()  # ~25 000 chars
    result = _cap_at_word_boundary(big_body, MAX_CLERK_BODY_CHARS)
    assert result.endswith("…")
    assert len(result[:-1]) <= MAX_CLERK_BODY_CHARS


def test_webhook_large_body_pre_filter_still_accepts() -> None:
    """Pre-filter uses full body only for MIN_CONTENT_LENGTH; cap is LLM-step only."""
    rec = _webhook_rec("fathom", "word " * 50_000)
    accepted, reason = _pre_filter(rec)
    assert accepted, f"large-body webhook must pass pre-filter: {reason!r}"


def test_no_source_type_returns_unknown_and_defers() -> None:
    """No transport markers → 'unknown' → retry valve fires, not a terminal drop."""
    rec = {
        "frontmatter": {"name": "some event"},
        "content": "Content long enough to clear the minimum length check for pre-filter.",
    }
    assert _infer_source_type(rec) == "unknown"
    accepted, reason = _pre_filter(rec)
    assert accepted is False and "unknown" in reason
    assert _is_unknown_source_only_drop(rec) is True
