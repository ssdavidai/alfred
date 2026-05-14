"""OBS-8 — noise-instinct pre-filter coverage.

The matcher is pure over (event_fm, noise_instincts) so we can pin
the glob semantics without going through the vault. The HTTP-bound
``load_noise_instincts`` is exercised in the on-david smoke.
"""
from __future__ import annotations

from src.activities.noise_patterns import event_matches_noise_instinct


def _gmail_event(sender: str) -> dict:
    return {
        "source_type": "gmail",
        "from": sender,
    }


def _gcal_event(organiser_email: str) -> dict:
    return {
        "source_type": "gcal",
        "organizer": {"email": organiser_email},
    }


# ---------------------------------------------------------------------------
# Match path
# ---------------------------------------------------------------------------

def test_gmail_sender_matches_exact_glob() -> None:
    event = _gmail_event("ops@digitalocean.com")
    instincts = [
        {"path": "instinct/x.md", "sender_domains": ["*digitalocean*"]},
    ]
    m = event_matches_noise_instinct(event, instincts)
    assert m is not None
    assert m["path"] == "instinct/x.md"
    assert m["matched_glob"] == "*digitalocean*"


def test_gmail_sender_matches_bare_glob() -> None:
    # The bare key (no wildcard) only matches an exact equal sender
    # — but the OBS-5 adopter emits both the bare key AND a wildcarded
    # variant, so the broader glob catches real-world senders.
    event = _gmail_event("digitalocean")  # contrived match
    instincts = [
        {"path": "instinct/x.md", "sender_domains": ["digitalocean"]},
    ]
    assert event_matches_noise_instinct(event, instincts) is not None


def test_gmail_sender_case_insensitive() -> None:
    event = _gmail_event("OPS@DigitalOcean.COM")
    instincts = [
        {"path": "instinct/x.md", "sender_domains": ["*digitalocean*"]},
    ]
    assert event_matches_noise_instinct(event, instincts) is not None


def test_gmail_sender_no_match_returns_none() -> None:
    event = _gmail_event("hello@example.com")
    instincts = [
        {"path": "instinct/x.md", "sender_domains": ["*digitalocean*"]},
    ]
    assert event_matches_noise_instinct(event, instincts) is None


def test_empty_instinct_list_returns_none() -> None:
    event = _gmail_event("anyone@anywhere.com")
    assert event_matches_noise_instinct(event, []) is None


def test_unsignaturable_event_returns_none() -> None:
    # Generic / unknown source_type → derive_signature kind is not in
    # the matchable allowlist (gmail_sender / gcal_organiser / slack_user).
    event = {"source_type": "generic", "from": "x@y"}
    instincts = [
        {"path": "instinct/x.md", "sender_domains": ["*y*"]},
    ]
    assert event_matches_noise_instinct(event, instincts) is None


def test_first_matching_instinct_wins() -> None:
    event = _gmail_event("ops@digitalocean.com")
    instincts = [
        {"path": "instinct/first.md", "sender_domains": ["*digitalocean*"]},
        {"path": "instinct/second.md", "sender_domains": ["*digitalocean*"]},
    ]
    m = event_matches_noise_instinct(event, instincts)
    assert m is not None
    assert m["path"] == "instinct/first.md"


def test_match_payload_carries_glob_for_audit() -> None:
    event = _gmail_event("anything@digitalocean.com")
    instincts = [
        {"path": "instinct/x.md", "sender_domains": ["foo", "*digital*"]},
    ]
    m = event_matches_noise_instinct(event, instincts)
    assert m is not None
    assert m["matched_glob"] == "*digital*"
    # kind is prefixed with `instinct_` so callers can distinguish
    # the new path from the legacy signal_noise_pattern hits.
    assert m["kind"].startswith("instinct_")
