"""Confidence promotion policy for distiller learning candidates.

Kept as a standalone, dependency-free module so the policy can be unit-tested
in isolation (the rest of the distiller pulls structlog and other runtime deps).

Bug #12 (D1/D2/D5): the old inline rule let source COUNT alone manufacture
`high` confidence — two agreeing `medium` candidates were auto-promoted to
`high`. Source agreement is weak evidence; it may lend modest support
(`low` → `medium`) but it must never mint `high`. `high` is reserved for an
LLM-assessed claim that genuinely warrants it.
"""

from __future__ import annotations

# Mechanical promotion ladder, indexed by the number of agreeing sources.
# Note the deliberate ceiling at `medium` — count never reaches `high`.
_LOW_TO_MEDIUM_MIN_SOURCES = 3


def bump_confidence(current: str, source_count: int) -> str:
    """Return the confidence after accounting for cross-source agreement.

    Args:
        current: the candidate's current confidence (`low` / `medium` / `high`
            or any other string, returned unchanged).
        source_count: how many independent sources agreed on this candidate.

    Returns:
        The (possibly promoted) confidence. Source count alone can promote
        `low` → `medium` but can NEVER produce `high`.
    """
    if source_count >= _LOW_TO_MEDIUM_MIN_SOURCES and current == "low":
        return "medium"
    return current
