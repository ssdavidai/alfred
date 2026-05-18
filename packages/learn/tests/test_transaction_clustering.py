"""Tests for src/profiler/transaction_clustering.py."""

from __future__ import annotations

from src.profiler.transaction_clustering import (
    DEFAULT_CATEGORY_RULES,
    ClusterProposal,
    clean_name,
    cluster_transactions,
)


def _txn(
    *,
    id: str,
    name: str,
    amount_cents: int = -1000,
    currency: str = "HUF",
    date: str = "2026-04-01",
    account_name: str = "Example Bank HUF",
) -> dict:
    return {
        "id": id,
        "name": name,
        "signed_amount_cents": amount_cents,
        "amount_cents": abs(amount_cents),
        "currency": currency,
        "date": date,
        "account": {"id": "acc", "name": account_name},
        "category": None,
        "merchant": {"id": "m", "name": name},
        "tags": [],
        "transfer": None,
    }


# ---------------------------------------------------------------------------
# clean_name
# ---------------------------------------------------------------------------


def test_clean_name_strips_postcodes_and_card_numbers():
    raw = "5473 **** **** 7151 20260428 101755 1990.00 HUF APPLE.COM/BILL 3227365"
    out = clean_name(raw)
    assert "apple" in out
    assert "5473" not in out
    assert "7151" not in out
    assert "huf" not in out


def test_clean_name_idempotent_on_clean_input():
    assert clean_name("Tesco Express") == "tesco express"


def test_clean_name_handles_none():
    assert clean_name(None) == ""
    assert clean_name("") == ""


def test_clean_name_collapses_whitespace():
    assert clean_name("FoodCo   \t  Hungary") == "wolt hungary"


# ---------------------------------------------------------------------------
# cluster_transactions — small synthetic dataset
# ---------------------------------------------------------------------------


def test_alias_group_collapses_tesco_variants():
    txns = [
        _txn(id="1", name="Tesco 41520 O:nkiszolg"),
        _txn(id="2", name="BUDAORS TESCO 41520"),
        _txn(id="3", name="Tesco 41710"),
        _txn(id="4", name="Tesco Express"),
    ]
    props = cluster_transactions(txns, min_group_size=2)
    # All 4 should land in one proposal
    tesco = [p for p in props if "tesco" in p.canonical_name.lower()]
    assert len(tesco) == 1
    assert tesco[0].txn_count == 4
    assert tesco[0].proposed_category == "Groceries"
    assert tesco[0].proposed_tag == "Grocery"
    assert tesco[0].role == "merchant"


def test_separate_merchants_stay_separate():
    txns = [
        _txn(id="1", name="Tesco 41520"),
        _txn(id="2", name="Tesco 41710"),
        _txn(id="3", name="FoodCo"),
        _txn(id="4", name="FoodCo"),
    ]
    props = cluster_transactions(txns, min_group_size=2)
    tescos = [p for p in props if "tesco" in p.canonical_name.lower()]
    wolts = [p for p in props if "wolt" in p.canonical_name.lower()]
    assert len(tescos) == 1
    assert len(wolts) == 1
    assert wolts[0].proposed_category == "Food & Drink"


def test_empty_input_returns_empty_list():
    assert cluster_transactions([]) == []


def test_below_min_group_size_dropped():
    txns = [_txn(id="x", name="OneOff Merchant")]
    props = cluster_transactions(txns, min_group_size=2)
    assert props == []


def test_unknown_merchant_role_when_no_rule_matches():
    txns = [
        _txn(id="1", name="Random Local Shop"),
        _txn(id="2", name="Random Local Shop"),
    ]
    props = cluster_transactions(txns, min_group_size=2)
    assert len(props) == 1
    assert props[0].proposed_category is None
    assert props[0].role == "unknown"


def test_transfer_role_for_wise():
    txns = [
        _txn(id="1", name="Example Bank"),
        _txn(id="2", name="Example Bank"),
        _txn(id="3", name="Example Bank"),
    ]
    props = cluster_transactions(txns, min_group_size=2)
    assert len(props) == 1
    assert props[0].role == "transfer"
    assert props[0].proposed_category == "Transfers"
    assert props[0].proposed_tag == "Transfer"


def test_income_role_for_salary_keyword():
    txns = [
        _txn(id="1", name="Pm-Abacus Fizetoaut", currency="HUF"),
        _txn(id="2", name="Pm-Abacus Fizetoaut", currency="HUF"),
    ]
    props = cluster_transactions(txns, min_group_size=2)
    assert len(props) == 1
    assert props[0].role == "income"
    assert props[0].proposed_category == "Income"


def test_proposals_sorted_by_txn_count_desc():
    txns = (
        [_txn(id=f"a{i}", name="FoodCo") for i in range(10)]
        + [_txn(id=f"b{i}", name="Tesco") for i in range(20)]
        + [_txn(id=f"c{i}", name="Spotify") for i in range(5)]
    )
    props = cluster_transactions(txns, min_group_size=2)
    counts = [p.txn_count for p in props]
    assert counts == sorted(counts, reverse=True)
    assert counts[0] == 20
    assert counts[1] == 10
    assert counts[2] == 5


def test_huf_volume_uses_raw_signed_amount_cents():
    """HUF stores raw integer; should not be divided by 100."""
    txns = [
        _txn(id="1", name="Tesco", amount_cents=-5000, currency="HUF"),
        _txn(id="2", name="Tesco", amount_cents=-7000, currency="HUF"),
    ]
    props = cluster_transactions(txns, min_group_size=2)
    assert len(props) == 1
    # Both negative → abs total = 12000 HUF
    assert props[0].total_volume_huf == 12000.0


def test_usd_volume_converts_with_static_rate():
    """USD signed_amount_cents=2900 ($29) → 29 * 350 = 10150 HUF (default rate)."""
    txns = [
        _txn(id="1", name="Apple.com/bill", amount_cents=-2900, currency="USD"),
        _txn(id="2", name="Apple.com/bill", amount_cents=-2900, currency="USD"),
    ]
    props = cluster_transactions(txns, min_group_size=2)
    assert len(props) == 1
    # 2 * 29 * 350 = 20300
    assert props[0].total_volume_huf == 20300.0


def test_pattern_keyword_is_lowercase_first_token():
    txns = [
        _txn(id="1", name="Tesco 41520"),
        _txn(id="2", name="Tesco 41710"),
    ]
    props = cluster_transactions(txns, min_group_size=2)
    assert props[0].pattern_keyword == "tesco"


def test_dominant_currency_and_account():
    txns = [
        _txn(id="1", name="FoodCo", currency="HUF", account_name="Example Bank HUF"),
        _txn(id="2", name="FoodCo", currency="HUF", account_name="Example Bank HUF"),
        _txn(id="3", name="FoodCo", currency="EUR", account_name="Example Bank EUR"),
    ]
    props = cluster_transactions(txns, min_group_size=2)
    assert len(props) == 1
    assert props[0].dominant_currency == "HUF"
    assert props[0].dominant_account == "Example Bank HUF"


def test_confidence_higher_for_matched_category_and_size():
    base = [_txn(id=f"u{i}", name="Random Local Shop") for i in range(20)]
    matched = [_txn(id=f"t{i}", name="Tesco") for i in range(20)]
    props = cluster_transactions(base + matched, min_group_size=2)
    by_name = {p.canonical_name.lower(): p for p in props}
    # Tesco gets +0.4 (category) + 0.15 (>=5) + 0.1 (>=20) = 0.95 cap
    # Random Shop gets only size boosts: 0.3 + 0.15 + 0.1 = 0.55
    assert by_name["tesco"].confidence > by_name["random"].confidence


# ---------------------------------------------------------------------------
# Real-data smoke test
# ---------------------------------------------------------------------------


def test_default_rules_are_well_formed():
    """Every rule entry is a 4-tuple and the regex compiles."""
    import re
    for entry in DEFAULT_CATEGORY_RULES:
        assert len(entry) == 4
        rx, cat, tag, role = entry
        re.compile(rx)
        assert isinstance(cat, str) and cat
        assert tag is None or isinstance(tag, str)
        assert role in ("merchant", "transfer", "income", "fee")


def test_proposal_serialises_to_dict():
    txns = [_txn(id="1", name="Tesco"), _txn(id="2", name="Tesco")]
    props = cluster_transactions(txns, min_group_size=2)
    d = props[0].asdict()
    assert d["canonical_name"] == "Tesco"
    assert d["proposed_category"] == "Groceries"
    assert isinstance(d["member_names"], list)
    assert isinstance(d["txn_count"], int)
