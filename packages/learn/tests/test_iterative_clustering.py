"""Tests for the iterative clustering loop and behavioural pass."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from src.profiler.iterative import iterative_cluster
from src.profiler.llm_inference import LLMProposal
from src.profiler.transaction_clustering import behavioural_groups


def _txn(
    *,
    id: str,
    name: str,
    amount_cents: int = -1000,
    currency: str = "HUF",
    date: str = "2026-04-01",
    account_id: str = "acc-1",
    account_name: str = "CIB HUF",
) -> dict:
    return {
        "id": id,
        "name": name,
        "signed_amount_cents": amount_cents,
        "amount_cents": abs(amount_cents),
        "currency": currency,
        "date": date,
        "account": {"id": account_id, "name": account_name},
        "category": None,
        "merchant": {"id": "m", "name": name},
        "tags": [],
        "transfer": None,
    }


# ---------------------------------------------------------------------------
# behavioural_groups
# ---------------------------------------------------------------------------


def test_behavioural_groups_catches_recurring_same_amount_across_months():
    """Three same-amount outflows on different months → one group."""
    txns = [
        _txn(id=f"a{i}", name=f"Random Person Variant {i}",
             amount_cents=-15000, date=f"2026-0{m}-15")
        for i, m in enumerate([1, 2, 3])
    ]
    groups = behavioural_groups(txns, min_occurrences=3, min_months=2)
    assert len(groups) == 1
    assert groups[0].txn_count == 3
    assert groups[0].role == "merchant"


def test_behavioural_groups_drops_one_off():
    """Single transaction is not a recurring pattern."""
    txns = [_txn(id="x", name="One Off", amount_cents=-12000)]
    groups = behavioural_groups(txns, min_occurrences=3)
    assert groups == []


def test_behavioural_groups_drops_same_month_repeats():
    """Three within the same month doesn't constitute monthly cadence."""
    txns = [
        _txn(id=f"a{i}", name="Same Day", amount_cents=-5000, date="2026-04-01")
        for i in range(3)
    ]
    groups = behavioural_groups(txns, min_occurrences=3, min_months=2)
    assert groups == []


def test_behavioural_groups_role_income_for_inflows():
    """Positive signed amount → income role."""
    txns = [
        _txn(id=f"a{i}", name="Random Payor", amount_cents=200000,
             date=f"2026-0{m}-01")
        for i, m in enumerate([1, 2, 3])
    ]
    groups = behavioural_groups(txns, min_occurrences=3, min_months=2)
    assert len(groups) == 1
    assert groups[0].role == "income"


def test_behavioural_groups_separates_by_account():
    """Same amount on different accounts ≠ one group."""
    txns = (
        [_txn(id=f"a{i}", name="Same Amt", amount_cents=-5000,
              date=f"2026-0{m}-01", account_id="acc-A")
         for i, m in enumerate([1, 2, 3])]
        + [_txn(id=f"b{i}", name="Same Amt", amount_cents=-5000,
                date=f"2026-0{m}-01", account_id="acc-B")
           for i, m in enumerate([1, 2, 3])]
    )
    groups = behavioural_groups(txns, min_occurrences=3, min_months=2)
    assert len(groups) == 2


def test_behavioural_groups_skips_tiny_amounts():
    """Bands below 1k HUF are ignored — that's coffee + fees, not a pattern."""
    txns = [
        _txn(id=f"a{i}", name="Tiny", amount_cents=-200,
             date=f"2026-0{m}-01")
        for i, m in enumerate([1, 2, 3])
    ]
    groups = behavioural_groups(txns)
    assert groups == []


# ---------------------------------------------------------------------------
# iterative_cluster — orchestration (LLM mocked)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_iterative_no_input_returns_empty():
    result = await iterative_cluster([])
    assert result.total_input_count == 0
    assert result.proposals == []
    assert result.stopped_reason == "empty_input"


@pytest.mark.asyncio
async def test_iterative_single_pass_with_keyword_match():
    """A keyword-matchable cluster lands in iter 1 and triggers no progress in iter 2."""
    txns = [
        _txn(id=f"t{i}", name="Tesco", amount_cents=-5000)
        for i in range(10)
    ]
    result = await iterative_cluster(
        txns,
        use_llm=False,
        use_behavioural=False,
    )
    # Tesco should match the built-in Groceries rule
    cats = {p.proposed_category for p in result.proposals}
    assert "Groceries" in cats
    # Coverage = 100% so loop stops at iter 1
    assert result.final_coverage_percent == 100.0
    assert len(result.stats) == 1
    assert result.stopped_reason == "target_coverage_reached"


@pytest.mark.asyncio
async def test_iterative_llm_pass_enriches_unknown_clusters():
    """Mock LLM returns a category for an otherwise-unknown cluster."""
    txns = [
        _txn(id=f"t{i}", name=f"Random Local Shop") for i in range(8)
    ]

    async def fake_llm_infer(*args, **kwargs):
        return [
            LLMProposal(
                canonical_name="Random",
                proposed_category="Shopping",
                proposed_tag=None,
                role="merchant",
                confidence=0.8,
            )
        ]

    with patch(
        "src.profiler.iterative.infer_categories_for_clusters",
        side_effect=fake_llm_infer,
    ):
        result = await iterative_cluster(
            txns,
            use_llm=True,
            use_behavioural=False,
            available_categories=["Shopping", "Groceries"],
            available_tags=[],
            llm_base_url="http://test",
            llm_token="tok",
        )

    cats = {p.proposed_category for p in result.proposals}
    assert "Shopping" in cats
    # LLM enriched the Random cluster → coverage = 100%
    assert result.final_coverage_percent == 100.0


@pytest.mark.asyncio
async def test_iterative_stops_at_target_coverage():
    """Loop exits early once target is hit."""
    txns = [_txn(id=f"a{i}", name="Tesco") for i in range(20)]
    result = await iterative_cluster(
        txns,
        target_coverage=0.5,
        use_llm=False,
        use_behavioural=False,
    )
    assert result.final_coverage_percent >= 50.0
    assert result.stopped_reason == "target_coverage_reached"


@pytest.mark.asyncio
async def test_iterative_stops_on_no_progress():
    """If the second iteration matches nothing new, we stop."""
    # Pure unmatched names → no rule matches, no LLM, no behavioural
    txns = [_txn(id=f"a{i}", name=f"Unique-{i}") for i in range(10)]
    result = await iterative_cluster(
        txns,
        use_llm=False,
        use_behavioural=False,
        target_coverage=1.0,
        max_iterations=5,
    )
    assert result.stopped_reason in ("no_progress", "max_iterations")
    assert result.final_coverage_percent == 0.0


@pytest.mark.asyncio
async def test_iterative_llm_disabled_when_no_token():
    """If token is empty, LLM pass is silently disabled."""
    txns = [_txn(id=f"a{i}", name="Tesco") for i in range(5)]
    result = await iterative_cluster(
        txns,
        use_llm=True,
        use_behavioural=False,
        available_categories=["Groceries"],
        llm_base_url="",
        llm_token="",
    )
    # Still works via keyword pass
    assert result.final_coverage_percent == 100.0


@pytest.mark.asyncio
async def test_iterative_records_per_iteration_stats():
    """Stats list grows by one entry per iteration."""
    txns = [_txn(id=f"a{i}", name="Tesco") for i in range(5)]
    result = await iterative_cluster(
        txns,
        use_llm=False,
        use_behavioural=False,
    )
    assert len(result.stats) >= 1
    assert result.stats[0].iteration == 1
    assert result.stats[0].keyword_proposals >= 1
