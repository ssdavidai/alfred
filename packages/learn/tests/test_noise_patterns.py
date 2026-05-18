"""Legacy noise-pattern derive_signature + event_matches_noise coverage.

These tests pin the surgical fixes for #261 and #262:

* #261 — the unanchored fallback no longer returns a broad
  ``source_type_topic`` signature. A single Noise click on an
  unanchored event must not be able to filter a whole source_type's
  downstream events.

* #262 — gmail noise patterns used to land as ``source_type_topic``
  because the composio-gmail curator stamps the sender into the
  rendered body's ``**From**: ...`` line, NOT into frontmatter.
  ``derive_signature`` now accepts an optional ``event_body`` arg and
  body-scrapes the same regex ``decision_observations`` uses.

The pure matcher is exercised here without going through the vault.
"""
from __future__ import annotations

from src.activities.noise_patterns import (
    derive_signature,
    event_matches_noise,
)


# ---------------------------------------------------------------------------
# #262 — gmail body-scrape fallback
# ---------------------------------------------------------------------------

def test_gmail_signature_from_frontmatter_sender() -> None:
    sig = derive_signature({"source_type": "gmail", "from": "Acme <a@acme.com>"})
    assert sig["kind"] == "gmail_sender"
    assert sig["value"] == "a@acme.com"


def test_gmail_signature_from_body_when_frontmatter_lacks_sender() -> None:
    # This is the #262 shape — composio-gmail curated frontmatter
    # carries source_type but never `from`/`sender`/`From`.
    fm = {"source_type": "gmail"}
    body = (
        "# Zoom: Cloud recording has been disabled\n\n"
        '**From**: Zoom <no-reply@zoom.us>\n'
        "**To**: principal@example.com\n"
    )
    sig = derive_signature(fm, event_body=body)
    assert sig["kind"] == "gmail_sender"
    assert sig["value"] == "no-reply@zoom.us"


def test_gmail_signature_body_scrape_handles_quoted_display_name() -> None:
    fm = {"source_type": "gmail"}
    body = '**From**: "Acme Video HQ Inc." <invoice+statements@acme-video.tv>\n**To**: x@y.z\n'
    sig = derive_signature(fm, event_body=body)
    assert sig["kind"] == "gmail_sender"
    assert sig["value"] == "invoice+statements@acme-video.tv"


def test_gmail_signature_body_scrape_composio_source_type() -> None:
    # The curator may stamp `source: composio-gmail-...` in addition
    # to `source_type: gmail`. The composio-gmail prefix must
    # canonicalise to "gmail".
    fm = {"source": "composio-gmail-gmail-fetch-emails"}
    body = "**From**: Supabase <noreply@supabase.com>\n**To**: x@y\n"
    sig = derive_signature(fm, event_body=body)
    assert sig["kind"] == "gmail_sender"
    assert sig["value"] == "noreply@supabase.com"


def test_gmail_frontmatter_sender_wins_over_body() -> None:
    # If frontmatter has it, don't bother scraping.
    fm = {"source_type": "gmail", "from": "real@frontmatter.com"}
    body = "**From**: someone-else@body.com\n"
    sig = derive_signature(fm, event_body=body)
    assert sig["value"] == "real@frontmatter.com"


# ---------------------------------------------------------------------------
# #261 — unanchored fallback returns "unknown" (was: "source_type_topic")
# ---------------------------------------------------------------------------

def test_unanchored_gmail_returns_unknown_kind() -> None:
    # No frontmatter sender + no body provided → unanchorable.
    sig = derive_signature({"source_type": "gmail"})
    assert sig["kind"] == "unknown"
    # value is empty — it's never used as a match key.
    assert sig["value"] == ""


def test_unanchored_gmail_with_body_lacking_from_line() -> None:
    sig = derive_signature({"source_type": "gmail"}, event_body="just some text\n")
    assert sig["kind"] == "unknown"


def test_unknown_source_type_returns_unknown_kind() -> None:
    sig = derive_signature({"source_type": "weird-thing", "alfred_tags": ["x"]})
    assert sig["kind"] == "unknown"


def test_unknown_signature_never_matches_legacy_patterns() -> None:
    # Even when a legacy record claimed signature_kind=source_type_topic,
    # the matcher must refuse to fire on an unanchored event.
    event_fm = {"source_type": "gmail"}  # unanchored
    legacy_pattern = {
        "kind": "source_type_topic",
        "value": "gmail",
        "path": "signal_noise_pattern/legacy-broken.md",
        "training_strength": "hard",
    }
    assert event_matches_noise(event_fm, [legacy_pattern]) is None


def test_unknown_signature_never_matches_unknown_kind_pattern() -> None:
    # Defensive: even if someone wrote a pattern with kind=unknown, we
    # still refuse to fire on an unanchored event.
    event_fm = {"source_type": "gmail"}
    legacy_pattern = {
        "kind": "unknown",
        "value": "",
        "path": "signal_noise_pattern/strange.md",
        "training_strength": "hard",
    }
    assert event_matches_noise(event_fm, [legacy_pattern]) is None


# ---------------------------------------------------------------------------
# Anchored matches still fire — sanity check we didn't break the happy path
# ---------------------------------------------------------------------------

def test_gmail_sender_pattern_matches_event_with_body_scrape() -> None:
    # Pattern was stamped post-fix (i.e. with a real gmail_sender
    # signature). Same pattern matches a new event whose sender lives
    # in the body.
    event_fm = {"source_type": "gmail"}
    body = "**From**: Zoom <no-reply@zoom.us>\n"
    pattern = {
        "kind": "gmail_sender",
        "value": "no-reply@zoom.us",
        "path": "signal_noise_pattern/zoom.md",
        "training_strength": "hard",
    }
    m = event_matches_noise(event_fm, [pattern], event_body=body)
    assert m is not None
    assert m["path"] == "signal_noise_pattern/zoom.md"


def test_gcal_organiser_title_signature_still_works() -> None:
    fm = {
        "source_type": "gcal",
        "name": "DigitalOcean Support account",
    }
    sig = derive_signature(fm)
    assert sig["kind"] == "gcal_organiser_title"
    # First 3 title words, lowercased.
    assert "digitalocean" in sig["value"]


def test_gcal_pattern_match() -> None:
    fm = {"source_type": "gcal", "name": "Deskin Billing Problem"}
    pattern = {
        "kind": "gcal_organiser_title",
        "value": "deskin billing problem",
        "path": "signal_noise_pattern/deskin.md",
        "training_strength": "hard",
    }
    assert event_matches_noise(fm, [pattern]) is not None
