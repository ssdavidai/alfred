"""Per-day email sampling — onboarding context-budget guard.

Live failure (Lane II / harden, 2026-05-23): the onboarding metadata
stage fetches up to 5000 Gmail messages with snippets and feeds them to
the heavy Hermes profile (``extract_facts_opus``). With ~33k tokens of
persona/tool overhead plus ~150k tokens of email data, the prompt
overflowed gpt-5.5's context window — Hermes raised "Context length
exceeded: max compression attempts (3) reached".

Fix is option D from Sir's spec: keep the fetch path identical but
bucket emails by day before they leave the activity, randomly sampling
``_PER_DAY_EMAIL_CAP`` per bucket. Across the 100-day onboarding window
that caps the corpus at ~2000 emails with representative coverage,
regardless of inbox volume. Predictable token cost; structurally
better than "5000 most recent" (which clumped on heavy weeks).

Determinism: ``random.Random`` is seeded by today's UTC day-number, so
retries within a day pick the same sample (safe for Temporal retries)
but the seed rotates day-to-day (no accidental fixation forever).

Imported by both ``activities/pull.py`` (Composio onboarding — the path
that actually fired live) and ``activities/onboarding_v3.py`` (direct
Google OAuth) so the two fetchers stay behaviorally identical.
"""

from __future__ import annotations

import logging
import random
import time
from typing import Any

logger = logging.getLogger("alfred-learn")

# 20 × 100 onboarding days ≈ 2000 emails — comfortable headroom under
# any reasonable model context window after Hermes persona overhead.
_PER_DAY_EMAIL_CAP = 20


def _email_day_bucket(email: dict[str, Any]) -> str:
    """Extract a ``YYYY-MM-DD`` bucket key from an email's ``date`` field.

    Handles both shapes the fetchers produce: Composio's ISO-ish
    ``messageTimestamp`` and direct-Gmail's RFC 2822 ``Date:`` header.
    Anything unparseable buckets under ``"unknown"`` so it still gets a
    sample cap rather than blowing up the helper.
    """
    raw = email.get("date") or ""
    if not isinstance(raw, str) or not raw.strip():
        return "unknown"
    raw = raw.strip()

    # ISO 8601 prefix: "2026-05-23..." or "2026-05-23T..."
    if len(raw) >= 10 and raw[4] == "-" and raw[7] == "-":
        head = raw[:10]
        if head[:4].isdigit() and head[5:7].isdigit() and head[8:10].isdigit():
            return head

    # RFC 2822: "Fri, 23 May 2026 10:14:00 +0000"
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(raw)
        if dt is not None:
            return dt.strftime("%Y-%m-%d")
    except (TypeError, ValueError):
        pass

    return "unknown"


def _day_rotated_seed() -> int:
    """Seed stable within a UTC day, rotated across days (retry-safe)."""
    return int(time.time() // 86400)


def sample_emails_per_day(
    emails: list[dict[str, Any]],
    cap: int = _PER_DAY_EMAIL_CAP,
) -> list[dict[str, Any]]:
    """Bucket emails by day, sample at most ``cap`` per day.

    Buckets under ``cap`` are kept whole. Buckets over ``cap`` are
    randomly sampled (deterministic within a UTC day). Result is the
    union of all per-day samples, sorted newest-first by raw ``date``
    string. Full snippets preserved (option D — no truncation).
    """
    if not emails:
        return []

    rng = random.Random(_day_rotated_seed())
    buckets: dict[str, list[dict[str, Any]]] = {}
    for e in emails:
        buckets.setdefault(_email_day_bucket(e), []).append(e)

    sampled: list[dict[str, Any]] = []
    for items in buckets.values():
        if len(items) <= cap:
            sampled.extend(items)
        else:
            sampled.extend(rng.sample(items, cap))

    sampled.sort(key=lambda e: str(e.get("date") or ""), reverse=True)

    logger.info(
        "per-day sampled: %d/%d emails from %d days (cap=%d/day)",
        len(sampled), len(emails), len(buckets), cap,
    )
    return sampled
