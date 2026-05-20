"""#9 — source_type 'unknown' must not be silently dropped-and-marked.

If a parser fails to stamp ``source_type``/``event_type``/``from`` on a real
inbound event, ``_infer_source_type`` collapses it to ``unknown`` and the
pre-filter rejects it. Previously the workflow then marked the event
processed, so real mail vanished forever, never retried.

The fix (C6): an event dropped *only* because its source_type is unknown is
NOT marked processed — the extractor raises so the workflow's "extractor
failed → don't mark, retry next tick" branch fires. Genuine garbage (stored
API-errors, hard-blocked slack/github noise) is still dropped and marked.

We assert behaviour at the extractor boundary: the unknown-only event raises,
while a garbage event returns ``[]`` (which the workflow marks processed).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import src.activities.signals as signals  # noqa: E402
from src.activities.signals import (  # noqa: E402
    _is_unknown_source_only_drop,
    _pre_filter,
    extract_signals_from_event,
)


def _unparsed_mail_event() -> dict:
    """Real mail whose parser forgot to stamp source_type/from.

    Body is long enough to clear MIN_CONTENT_LENGTH, recent (no created →
    not too old), no garbage markers — the ONLY reason it fails the
    pre-filter is the source_type collapsing to 'unknown'.
    """
    return {
        "frontmatter": {
            "name": "Re: contract terms",
            "subject": "Re: contract terms",
        },
        "content": (
            "Hi, following up on the contract — can we close this by Friday? "
            "Please confirm the revised payment schedule. Thanks."
        ),
    }


def _garbage_event() -> dict:
    """A stored Composio API-error response — genuine garbage."""
    return {
        "frontmatter": {
            "name": '{"action": "SLACK_LIST_MESSAGES", "error": "not_in_channel"}',
        },
        "content": "irrelevant body that is plenty long enough to pass length",
    }


def test_unknown_source_only_classifier_true_for_unparsed_mail() -> None:
    ev = _unparsed_mail_event()
    # Pre-filter rejects it...
    accepted, reason = _pre_filter(ev)
    assert accepted is False
    assert "unknown" in reason
    # ...and the reason is *only* the unknown source type.
    assert _is_unknown_source_only_drop(ev) is True


def test_unknown_source_only_classifier_false_for_garbage() -> None:
    ev = _garbage_event()
    accepted, _ = _pre_filter(ev)
    assert accepted is False
    # Garbage is a terminal drop, not an unknown-source drop.
    assert _is_unknown_source_only_drop(ev) is False


async def test_extractor_raises_on_unknown_source(monkeypatch) -> None:
    ev = _unparsed_mail_event()

    async def _fake_read(self, path):  # noqa: ANN001
        return ev

    monkeypatch.setattr(signals.VaultClient, "read_record", _fake_read, raising=True)

    with pytest.raises(Exception) as excinfo:
        await extract_signals_from_event("stream_event/unparsed.md")
    assert "unknown" in str(excinfo.value).lower()


async def test_extractor_drops_garbage_without_raising(monkeypatch) -> None:
    ev = _garbage_event()

    async def _fake_read(self, path):  # noqa: ANN001
        return ev

    monkeypatch.setattr(signals.VaultClient, "read_record", _fake_read, raising=True)

    # Garbage returns [] (workflow marks processed) — no raise.
    result = await extract_signals_from_event("stream_event/garbage.md")
    assert result == []
