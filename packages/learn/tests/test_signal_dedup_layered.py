"""Sir #2 — layered dedup for needs_attention cards.

Symptom on /desk: 5 duplicate cards (Rayon ×3, Soft Murmur ×2). All came
from distinct ingest events (so source_event_path didn't match) and the
existing 0.7 full-body Jaccard fell below threshold because ``raw_quote``
carries divergent email bodies — "Rayon payment failed (May invoice)" vs
"Rayon card charge failed again — autopay" share the actor + topic but
differ wildly in body.

Fix: layer two cheaper checks BEFORE the existing 0.7 full-body Jaccard:

  Layer 1 — headline-only Jaccard ≥ 0.6 → dup.
            The display_headline is the curator's distilled subject; two
            headlines about the same matter overlap heavily even when the
            underlying email bodies diverge.

  Layer 2 — same first-3-token stem of action_proposal.what → dup.
            "Reply to Rayon with updated card" vs "Reply to Rayon about
            failed payment" both stem to {"reply", "to", "rayon"} — same
            instruction, different prose.

Both layers are conservative: headline at 0.6 still requires real overlap
("Rayon's payment failed" / "Rayon's May payment failed" → ~0.75 jaccard),
and the 3-token stem requires the action to start with the same verb +
target.

Genuine non-duplicates ("Reply to Mailgun about SMTP" vs "Reply to Rayon
about payment") fall through to the original 0.7 full-body gate, which is
the correct behaviour: different subjects must card independently.
"""
from __future__ import annotations

import asyncio
from typing import Any

import src.activities.signal_actions as sa


class _ListClient:
    """Minimal VaultClient stub — only list_records("needs_attention")."""

    def __init__(self, open_cards: list[dict[str, Any]]) -> None:
        self.open_cards = open_cards

    async def list_records(
        self, record_type: str, status=None, limit: int = 100
    ) -> list[dict[str, Any]]:
        if record_type != "needs_attention":
            return []
        return list(self.open_cards)[:limit]


def _card(
    *,
    headline: str,
    what: str,
    raw_quote: str,
    source_event_path: str,
    status: str = "pending",
    path: str = "needs_attention/existing.md",
) -> dict[str, Any]:
    """A card-shape dict suitable for both .open_cards seed and as the
    incoming-signal frontmatter we're checking against."""
    return {
        "path": path,
        "status": status,
        "source_event_path": source_event_path,
        "display_headline": headline,
        "raw_quote": raw_quote,
        "action_proposal": {"what": what},
    }


def test_same_headline_different_body_is_dup(monkeypatch):
    """Rayon ×3 case: same actor + topic in headline, divergent email bodies.

    Without the headline layer the full-body Jaccard falls under 0.7 because
    raw_quote dominates and each retry email has different wording. The
    headline-only layer catches it.
    """
    existing = _card(
        headline="Rayon's May payment failed",
        what="Reply to Rayon with updated card",
        raw_quote=(
            "Dear Sir,\n\nWe regret to inform you that the autopay charge on "
            "your Rayon account for the May invoice was declined by the "
            "issuing bank with code R1. Please update your billing details "
            "by the end of the week to avoid a service interruption.\n\n"
            "—The Rayon Billing Team"
        ),
        source_event_path="ingest:evt-rayon-001",
        path="needs_attention/2026-05-20T07-00-00Z-aaaa1111.md",
    )
    incoming = _card(
        headline="Rayon's May payment failed again",
        what="Reply to Rayon about failed payment",
        raw_quote=(
            "Hello — this is the second attempt to charge your Rayon "
            "subscription. The card on file came back declined yet again "
            "(decline reason: insufficient funds). Reach out to our support "
            "desk if the funds are available and we'll retry the charge."
        ),
        source_event_path="ingest:evt-rayon-002",  # different event
    )

    client = _ListClient([existing])
    result = asyncio.run(sa._recent_open_card_exists(client, incoming))

    assert result == existing["path"], (
        f"headline-overlap dedup must catch Rayon ×3 case; got {result!r}"
    )


def test_same_action_proposal_stem_is_dup(monkeypatch):
    """Soft Murmur ×2 case: same first-3 tokens of action_proposal.what."""
    existing = _card(
        headline="Soft Murmur asks for a meeting",
        what="Schedule call with Soft Murmur to discuss roadmap",
        raw_quote=(
            "Hi Sir, would love to find time on your calendar this week to "
            "walk through the Q3 roadmap and align on the deliverables."
        ),
        source_event_path="ingest:evt-sm-001",
        path="needs_attention/2026-05-21T07-00-00Z-bbbb2222.md",
    )
    incoming = _card(
        headline="Roadmap sync request from Soft Murmur",
        what="Schedule call with Soft Murmur about Q3 deliverables",
        raw_quote=(
            "Following up on my note from earlier — let's lock in 30 min to "
            "cover the new Q3 commitments. Tuesday or Wednesday afternoon "
            "would work best on my end."
        ),
        source_event_path="ingest:evt-sm-002",  # different event
    )

    client = _ListClient([existing])
    result = asyncio.run(sa._recent_open_card_exists(client, incoming))

    assert result == existing["path"], (
        f"action_proposal stem dedup must catch Soft Murmur ×2 case; "
        f"got {result!r}"
    )


def test_genuinely_different_signals_still_card(monkeypatch):
    """Distinct subjects with no headline/stem/body overlap must NOT dedup.

    A regression guard: the layered dedup is conservative and must not
    swallow real distinct actions. "Reply to Mailgun about SMTP setup"
    and "Reply to Rayon about failed payment" share the verb "reply to"
    but the rest diverges — neither layer should fire.
    """
    existing = _card(
        headline="Mailgun wants SMTP config confirmed",
        what="Confirm Mailgun SMTP versus API choice",
        raw_quote=(
            "Hi — our records show your account hasn't yet selected an SMTP "
            "or API integration mode. Please pick one in the dashboard."
        ),
        source_event_path="ingest:evt-mg-001",
        path="needs_attention/2026-05-22T07-00-00Z-cccc3333.md",
    )
    incoming = _card(
        headline="DigitalOcean droplet reboot scheduled",
        what="Acknowledge DigitalOcean maintenance window for droplet abc",
        raw_quote=(
            "We are performing emergency maintenance on the hypervisor that "
            "hosts your droplet abc on Friday between 02:00 and 04:00 UTC. "
            "The droplet will be unavailable for approximately 30 minutes."
        ),
        source_event_path="ingest:evt-do-001",
    )

    client = _ListClient([existing])
    result = asyncio.run(sa._recent_open_card_exists(client, incoming))

    assert result is None, (
        f"genuinely distinct signals must NOT be dedup'd; got {result!r}"
    )


def test_same_source_event_still_dedups(monkeypatch):
    """Existing source_event_path equality path still works (regression guard)."""
    existing = _card(
        headline="Whatever",
        what="Whatever action",
        raw_quote="body",
        source_event_path="ingest:evt-shared-001",
        path="needs_attention/2026-05-23T07-00-00Z-dddd4444.md",
    )
    incoming = _card(
        headline="Unrelated text",
        what="Totally different action",
        raw_quote="totally different body",
        source_event_path="ingest:evt-shared-001",  # SAME event
    )

    client = _ListClient([existing])
    result = asyncio.run(sa._recent_open_card_exists(client, incoming))

    assert result == existing["path"], (
        f"source_event_path equality must still dedup; got {result!r}"
    )
