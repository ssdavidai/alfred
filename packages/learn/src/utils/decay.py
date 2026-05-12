"""Ebbinghaus-style freshness decay for needs_attention.

A signal that arrived weeks ago is rarely as load-bearing now as when
it landed. Rather than letting the Desk silt up with origin-old cards
the principal will never click, we score each card's *freshness* on
an exponential decay curve keyed to the card's source and assign it
to one of three bands:

  fresh  (>= 0.50)  — surface normally
  aging  (0.20..0.50) — group under an "Aging" band
  stale  (< 0.20)   — drop below the fold (or auto-flip to stale)

`freshness(t) = exp(-ln(2) * age / half_life)` so that `age == half_life`
yields exactly 0.5 — the half-life *is* the band threshold for fresh.

Half-lives are deliberately per-source: a calendar invite goes stale
inside two days because the event itself passes, while a vague gmail
note from a contact can stay relevant for weeks. The numbers below
are gut estimates the principal can tune later — they are *not*
deduced from data.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

# Half-life in days, keyed by needs_attention.source or signal kind.
# Lookup order: explicit kind first, then source bucket, then default.
_HALF_LIFE_DAYS: dict[str, float] = {
    # Calendar — bound to a real event; once it passes the signal is
    # almost surely stale. Two days lets a "missed it yesterday" card
    # still surface briefly before fading.
    "gcal": 2.0,
    "calendar": 2.0,
    "google_calendar": 2.0,
    # Transactional gmail — receipts, automated notices, account alerts
    # all decay quickly. Two weeks because the principal often clears
    # these on a Sunday sweep.
    "gmail_transactional": 14.0,
    # Personal / conversational gmail — letters from people, decisions
    # in flight, longer threads. A month is long enough that genuine
    # "I'll get to it" items stay alive, short enough that drift fades.
    "gmail": 30.0,
    "gmail_personal": 30.0,
    # Composio integrations (slack, linear, github, etc.) — generally
    # transactional, slightly slower than gmail because the principal
    # treats them less frequently.
    "composio": 21.0,
    # Ambient capture — omi necklace + vexa meeting transcripts. These
    # surface a window of fresh-context; a week is enough to act on
    # something said in a meeting before the moment dissolves.
    "omi": 7.0,
    "vexa": 7.0,
    "transcript": 14.0,
    "meeting": 14.0,
    # Pattern proposals from the system itself — slower decay because
    # the principal often takes their time confirming/disabling them.
    "pattern_proposal": 30.0,
    "decision_pattern": 30.0,
    # Stale-notice signals (the "this card is about to fade — keep?"
    # ones we generate ourselves) should themselves be short-lived.
    "stale_notice": 5.0,
}

_DEFAULT_HALF_LIFE_DAYS = 21.0

# Band thresholds. These are bands on the *freshness score* (0..1),
# not on age. Numbers picked so that:
#   age = 0           -> freshness = 1.0    -> fresh
#   age = half_life   -> freshness = 0.5    -> fresh/aging boundary
#   age = 2*half_life -> freshness = 0.25   -> aging
#   age = ~2.3*half   -> freshness = 0.20   -> aging/stale boundary
#   age = ~4.3*half   -> freshness = 0.05   -> deeply stale (auto-flip)
FRESH_THRESHOLD = 0.50
AGING_THRESHOLD = 0.20
AUTO_FLIP_THRESHOLD = 0.05  # below this, flip status=stale automatically


def half_life_days(source_or_kind: str | None) -> float:
    """Lookup the half-life for a source label.

    Accepts source like ``gmail`` or kind like ``gmail_transactional``.
    Falls back to the global default when the label is unknown.
    """
    if not source_or_kind:
        return _DEFAULT_HALF_LIFE_DAYS
    key = str(source_or_kind).strip().lower()
    if key in _HALF_LIFE_DAYS:
        return _HALF_LIFE_DAYS[key]
    # Try splitting on "_" to find a bucket (e.g. "gmail_promotion" -> "gmail")
    head = key.split("_", 1)[0]
    if head in _HALF_LIFE_DAYS:
        return _HALF_LIFE_DAYS[head]
    return _DEFAULT_HALF_LIFE_DAYS


def freshness_score(
    origin_iso: str | None,
    source_or_kind: str | None,
    now: datetime | None = None,
) -> float | None:
    """Compute freshness in [0..1] using exponential decay.

    Returns None when origin_iso is missing or unparseable — the caller
    decides what to do with no signal (probably: leave alone).
    """
    if not origin_iso or not isinstance(origin_iso, str):
        return None
    s = origin_iso.strip().replace("Z", "+00:00")
    try:
        origin = datetime.fromisoformat(s)
    except ValueError:
        return None
    if origin.tzinfo is None:
        origin = origin.replace(tzinfo=timezone.utc)
    ref = now or datetime.now(timezone.utc)
    age_seconds = max(0.0, (ref - origin).total_seconds())
    half_life_seconds = half_life_days(source_or_kind) * 86400.0
    if half_life_seconds <= 0:
        return 1.0
    return math.exp(-math.log(2) * age_seconds / half_life_seconds)


def band_for(score: float | None) -> str:
    """Map a freshness score to a band label."""
    if score is None:
        return "unknown"
    if score >= FRESH_THRESHOLD:
        return "fresh"
    if score >= AGING_THRESHOLD:
        return "aging"
    return "stale"


def score_and_band(
    origin_iso: str | None,
    source_or_kind: str | None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Convenience wrapper — returns {decay_score, decay_band}."""
    s = freshness_score(origin_iso, source_or_kind, now=now)
    return {"decay_score": s, "decay_band": band_for(s)}
