"""The progressive-autonomy ladder — Asking → Confirming → Acting.

Single source of truth for reading an instinct's `tier`. Two enforcement
points depend on it and they must agree exactly:

  * ``signal_actions.route_signal_action`` (#446) — may this instinct
    dispatch an agent without Sir in the loop?
  * ``noise_patterns`` (#453) — may this instinct make an inbound email
    cease to exist before it ever becomes a signal?

Both fail CLOSED to ``Asking``. #445 was caused by the ladder being
decorative; #446 fixed the router; keeping the reader in one module is what
stops the two gates drifting apart the way ``_instinct_threshold`` and
``should_route_autonomously`` did.
"""

from __future__ import annotations

from typing import Any

TIER_ASKING = "Asking"
TIER_CONFIRMING = "Confirming"
TIER_ACTING = "Acting"
VALID_TIERS = (TIER_ASKING, TIER_CONFIRMING, TIER_ACTING)

#: The only tier permitted to act — or to suppress — without the principal.
AUTONOMOUS_TIER = TIER_ACTING


def instinct_tier(instinct: dict[str, Any]) -> str:
    """Return the instinct's ladder tier, failing CLOSED to ``Asking``.

    Accepts either a full record (with a ``frontmatter`` key) or a bare
    frontmatter mapping. Anything missing, unparseable, or outside
    ``VALID_TIERS`` degrades to ``Asking`` — a malformed instinct must never
    be able to buy autonomy it has not earned.

    Only the frontmatter ``tier`` string is authoritative. The nested
    ``execution.tier`` integer / ``execution.requires_approval`` pair is a
    legacy shape that is deliberately NOT consulted: it disagreed with the
    ladder on live data (``tier: Asking`` alongside
    ``execution: {tier: 1, requires_approval: false}``) and the weaker of
    two conflicting fields must not satisfy a safety gate.
    """
    fm = instinct.get("frontmatter") if isinstance(instinct, dict) else None
    if not isinstance(fm, dict):
        fm = instinct if isinstance(instinct, dict) else {}
    raw = fm.get("tier")
    if not isinstance(raw, str):
        return TIER_ASKING
    normalized = raw.strip().capitalize()
    if normalized not in VALID_TIERS:
        return TIER_ASKING
    return normalized
