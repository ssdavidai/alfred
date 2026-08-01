"""#333 — composio email events must reach the sender-domain suppress arm.

Composio-ingested email carries ``source_type="email"``; derive_signature
only recognized gmail/gcal/slack, so these events derived kind="unknown"
and sender-domain-anchored noise instincts never matched — SUPPRESS was
structurally dead for email on every composio-fed tenant.
"""
from __future__ import annotations

from src.activities.noise_patterns import (
    derive_signature,
    event_matches_noise_instinct,
)

COMPOSIO_EMAIL_EVENT = {
    "source_type": "email",
    "name": "GitHub build failed",
}
BODY = "**From**: GitHub <notifications@github.com>\n**Subject**: Run failed: build-learn"

CI_INSTINCT = {
    "path": "instinct/suppress-ci-github-workflow-noise.md",
    "sender_domains": ["github.com"],
    "subject_keywords": [],
}


class TestEmailSourceType:
    def test_email_derives_gmail_signature(self):
        sig = derive_signature(COMPOSIO_EMAIL_EVENT, event_body=BODY)
        assert sig["kind"] != "unknown", sig
        assert "github.com" in str(sig.get("value", "")).lower()

    def test_sender_domain_instinct_matches_email_event(self):
        """The end-to-end live shape: composio email + sender-domain-only
        instinct. Red before the fix (kind=unknown -> no match)."""
        matched = event_matches_noise_instinct(
            COMPOSIO_EMAIL_EVENT, [CI_INSTINCT], event_body=BODY
        )
        assert matched is not None
        assert matched["path"] == CI_INSTINCT["path"]

    def test_gmail_still_works(self):
        ev = dict(COMPOSIO_EMAIL_EVENT, source_type="composio-gmail-poll")
        assert derive_signature(ev, event_body=BODY)["kind"] != "unknown"

    def test_unrelated_source_type_still_unknown(self):
        """A Noise click must never filter a whole unrecognized source."""
        ev = {"source_type": "webhook-random"}
        assert derive_signature(ev)["kind"] == "unknown"
