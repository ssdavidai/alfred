"""OBS-5 — pure-helper coverage for the pattern_proposal acceptor.

The activity itself is HTTP-bound (reads/writes vault via ctrl-api)
and is exercised in the on-david smoke. These tests pin the
deterministic mapping from cluster fields → instinct shape so future
edits can't silently break the matcher contract.
"""
from __future__ import annotations

from src.activities.decision_observations import (
    _intent_to_routing_rule,
    _sender_key_to_domain_patterns,
)


# ---------------------------------------------------------------------------
# _sender_key_to_domain_patterns
# ---------------------------------------------------------------------------

def test_single_word_sender_emits_bare_and_wildcard() -> None:
    p = _sender_key_to_domain_patterns("digitalocean")
    assert p == ["digitalocean", "*digitalocean*"]


def test_multi_word_sender_also_emits_head_token() -> None:
    # "digitalocean support" should ALSO match "digitalocean.com"
    # — the second token is incidental, the first is the entity.
    p = _sender_key_to_domain_patterns("digitalocean support")
    assert "*digitalocean*" in p
    assert "digitalocean" in p
    assert "digitalocean support" in p


def test_empty_sender_returns_empty() -> None:
    assert _sender_key_to_domain_patterns("") == []
    assert _sender_key_to_domain_patterns("   ") == []


def test_patterns_are_deduped() -> None:
    p = _sender_key_to_domain_patterns("acme")
    assert p == sorted(set(p), key=p.index)  # order-preserving dedup


# ---------------------------------------------------------------------------
# _intent_to_routing_rule
# ---------------------------------------------------------------------------

def test_noise_intent_routes_to_hold() -> None:
    rr = _intent_to_routing_rule("noise")
    assert rr == {"destination_type": "hold", "destination": "auto-noise"}


def test_delegate_intent_routes_to_alfred() -> None:
    rr = _intent_to_routing_rule("delegate")
    assert rr["destination_type"] == "person"
    assert rr["destination"] == "alfred"


def test_defer_intent_routes_to_hold() -> None:
    rr = _intent_to_routing_rule("defer")
    assert rr["destination_type"] == "hold"


def test_done_intent_routes_to_hold() -> None:
    rr = _intent_to_routing_rule("done")
    assert rr["destination_type"] == "hold"


def test_unknown_intent_returns_none() -> None:
    # Caller falls back to bare rule + action prose without a
    # routing_rule rather than guessing.
    assert _intent_to_routing_rule("take_mine") is None
    assert _intent_to_routing_rule("") is None
    assert _intent_to_routing_rule("approve") is None
