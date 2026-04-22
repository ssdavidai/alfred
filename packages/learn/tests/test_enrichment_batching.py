"""Tests for size-based enrichment batch packing (#517)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.enrichment import (  # noqa: E402
    MAX_BODY_CHARS_PER_EVENT,
    MAX_INPUT_CHARS_PER_BATCH,
    pack_enrichment_batches,
)


def _r(body_len: int, name: str = "e") -> dict:
    return {"path": f"event/{name}.md", "name": name, "body": "X" * body_len}


def test_empty_list_gives_empty_batches() -> None:
    assert pack_enrichment_batches([]) == []


def test_short_records_fit_one_batch() -> None:
    records = [_r(200, f"r{i}") for i in range(50)]
    batches = pack_enrichment_batches(records)
    assert len(batches) == 1
    assert len(batches[0]) == 50


def test_long_records_split_into_multiple_batches() -> None:
    # Each record is 20k chars + 200 overhead → 3 records fill 60k, so
    # two records per batch keeps well under 80k.
    records = [_r(MAX_BODY_CHARS_PER_EVENT, f"long-{i}") for i in range(5)]
    batches = pack_enrichment_batches(records)
    # Each batch holds at most floor(80k / 20.2k) = 3 records.
    assert len(batches) >= 2
    for batch in batches:
        total = sum(len(r["body"]) + 200 for r in batch)
        assert total <= MAX_INPUT_CHARS_PER_BATCH or len(batch) == 1


def test_single_oversized_record_goes_in_its_own_batch() -> None:
    # Body smaller than MAX_INPUT_CHARS_PER_BATCH but larger than typical
    # per-event cap — simulate a record whose cap was raised.
    records = [_r(90_000, "huge"), _r(1000, "small")]
    batches = pack_enrichment_batches(records)
    assert len(batches) == 2
    # Huge record alone in first batch (its size already exceeds the
    # per-batch budget, so the small record can't join it).
    assert batches[0][0]["name"] == "huge"
    assert batches[1][0]["name"] == "small"


def test_preserves_record_order_within_batch() -> None:
    records = [_r(100, f"r{i}") for i in range(5)]
    batches = pack_enrichment_batches(records, max_chars=1000)
    flat = [r["name"] for batch in batches for r in batch]
    assert flat == ["r0", "r1", "r2", "r3", "r4"]


def test_uses_body_preview_fallback() -> None:
    """Records built with the old body_preview key still pack correctly."""
    records = [
        {"path": "event/a.md", "name": "a", "body_preview": "X" * 500},
        {"path": "event/b.md", "name": "b", "body_preview": "Y" * 500},
    ]
    batches = pack_enrichment_batches(records)
    assert len(batches) == 1
    assert len(batches[0]) == 2
