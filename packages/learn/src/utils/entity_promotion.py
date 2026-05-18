"""Two-strike promotion for auto-discovered entities (#651).

Auto-discovered entities (org/, person/, location/) created from a single
stream observation should NOT immediately become live, queryable facts in
the vault. The Tesla incident (#651): one Omi conversation captured an
ambient mention of "Tesla", which became `/vault/org/Tesla.md` with
`status: active` and immediately polluted enrichment surfaces and
Alfred's reasoning.

Forward-defense rule: a new auto-discovered entity starts at
``status: provisional`` and is promoted to ``status: active`` when one
of these conditions is met:

1. A second *distinct* stream mentions it (cross-corroboration), OR
2. Sir explicitly references it in chat — signal: a non-stream actor
   PATCHes the record, OR
3. Dashboard approval action toggles it.

This module owns rule (1). Rules (2) and (3) are handled at the
ctrl-api / dashboard layer and write ``status: active`` directly.

Promotion state is tracked in frontmatter:

    mentioned_by_streams: ["omi-stream-1", "gmail-stream-2"]
    status: provisional   # flips to "active" once len(set) >= 2

The helper here is *additive* and does NOT touch existing ``active``
records. Only new ingest paths that opt in start auto-discoveries as
``provisional``. Existing live entities are unaffected.
"""

from __future__ import annotations

from typing import Iterable

# Entity record types eligible for two-strike provisional gating.
PROVISIONAL_ENTITY_TYPES: frozenset[str] = frozenset({"org", "person", "location"})

# Cap on per-entity mentioned_by_streams list to keep frontmatter small.
MAX_MENTIONED_STREAMS: int = 32

# Threshold of distinct streams required to flip provisional → active.
PROMOTION_THRESHOLD: int = 2


def is_provisional_entity_type(record_type: str) -> bool:
    """Return True if this record type uses the two-strike gate."""
    return record_type in PROVISIONAL_ENTITY_TYPES


def initial_status_for_auto_discovery(record_type: str) -> str:
    """Return the starting status for a NEW auto-discovered record.

    Provisional types start at ``provisional`` to avoid Tesla-style
    pollution. Everything else stays at the historical ``active`` default.
    """
    if is_provisional_entity_type(record_type):
        return "provisional"
    return "active"


def merge_mentioned_streams(
    existing: Iterable[str] | None,
    new_stream_id: str,
) -> tuple[list[str], bool]:
    """Merge a new stream mention into the per-entity stream set.

    Returns ``(new_list, added)`` where ``added`` is True iff the
    stream wasn't already known. Caps the list at ``MAX_MENTIONED_STREAMS``
    while preserving the most recent additions (FIFO eviction of oldest).
    """
    if not new_stream_id:
        # Nothing to add; preserve existing.
        current = list(existing or [])
        return current, False

    current = list(existing or [])
    if new_stream_id in current:
        return current, False

    current.append(new_stream_id)
    # Evict from the front if we exceeded the cap.
    if len(current) > MAX_MENTIONED_STREAMS:
        current = current[-MAX_MENTIONED_STREAMS:]
    return current, True


def should_promote_provisional(
    current_status: str | None,
    mentioned_by_streams: Iterable[str] | None,
) -> bool:
    """Return True if a provisional entity now qualifies for promotion.

    Only flips on ``status == "provisional"`` records that have been
    mentioned by ``PROMOTION_THRESHOLD`` or more *distinct* streams.
    Already-active records are left alone (idempotent / safe to call
    on every ingest).
    """
    if current_status != "provisional":
        return False
    streams = set(s for s in (mentioned_by_streams or []) if s)
    return len(streams) >= PROMOTION_THRESHOLD


def next_status(
    current_status: str | None,
    mentioned_by_streams: Iterable[str] | None,
) -> str:
    """Compute the post-merge status for an entity record.

    - Already-active entities stay active (never demoted).
    - Provisional entities with >= PROMOTION_THRESHOLD distinct stream
      mentions are promoted to active.
    - Otherwise the current status is preserved (or defaults to
      ``provisional`` if missing on a provisional-eligible record).
    """
    if current_status == "active":
        return "active"
    if should_promote_provisional(current_status, mentioned_by_streams):
        return "active"
    return current_status or "provisional"
