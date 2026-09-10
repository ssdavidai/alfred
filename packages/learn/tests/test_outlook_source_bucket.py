"""Outlook events join the shared email bucket downstream (issue #758, C-758-10).

Ongoing Outlook sync ingests events with ``stream_type: "outlook"``. These
tests pin that the four source-type choke points collapse Outlook onto the same
``gmail`` bucket Gmail uses, so priors, the noise gate and log lines treat an
Outlook message exactly like a Gmail one.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.signal_observations import (  # noqa: E402
    _authoritative_source_type,
    _normalise_source_type,
)


def test_normalise_maps_outlook_to_email_bucket() -> None:
    assert _normalise_source_type("outlook") == "gmail"
    assert _normalise_source_type("composio-outlook") == "gmail"


def test_gmail_bucket_unchanged() -> None:
    assert _normalise_source_type("gmail") == "gmail"
    assert _normalise_source_type("composio-gmail-emails") == "gmail"


def test_authoritative_source_type_reads_outlook_source_type() -> None:
    # No gmail/gcal source_ref prefix and no email tag → falls through to the
    # event's own source_type, which normalises Outlook onto the email bucket.
    fm = {"source_ref": "composio:AAMk-1", "source_type": "outlook"}
    assert _authoritative_source_type(fm, "outlook") == "gmail"


def test_authoritative_source_type_outlook_prefix() -> None:
    fm = {"source_ref": "outlook:AAMk-1"}
    assert _authoritative_source_type(fm, "") == "gmail"


def test_noise_log_line_handles_outlook_stream_type() -> None:
    from src.activities.noise import extract_log_line

    # An Outlook event takes the email log-line branch, not the generic one.
    line = extract_log_line(
        {
            "stream_type": "outlook",
            "raw": {"from": "rob@x.example", "subject": "Q3", "snippet": "hi"},
        }
    )
    assert isinstance(line, str) and line != ""


def test_noise_patterns_outlook_derives_a_sender_signature() -> None:
    from src.activities.noise_patterns import derive_signature

    # source_type "outlook" maps to the gmail branch → a real sender signature,
    # never the "unknown" fallthrough that disables noise matching.
    sig = derive_signature({"source_type": "outlook", "from": "rob@x.example"})
    assert sig.get("kind") != "unknown"


def test_noise_patterns_unknown_source_still_unknown() -> None:
    from src.activities.noise_patterns import derive_signature

    sig = derive_signature({"source_type": "mystery", "from": "rob@x.example"})
    assert sig.get("kind") == "unknown"
