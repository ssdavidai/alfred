"""``_parse_json_with_keys`` — multi-key, alias-aware JSON envelope parser.

Lane II / harden: gpt-5.5 (heavy profile) sometimes emits ``identityFacts``
where the prompt asks for ``key_identity_facts``. The previous helper only
knew the canonical key — alias keys → 0 facts → silent degrade.
"""
from __future__ import annotations

import json
import logging

from src.activities.onboarding_v3 import _parse_json_with_keys


def test_parse_canonical_key_no_aliases_needed() -> None:
    parsed = _parse_json_with_keys('{"facts": [{"x": 1}, {"x": 2}]}', "facts")
    assert parsed["facts"] == [{"x": 1}, {"x": 2}]


def test_parse_with_explicit_alias_maps_to_canonical() -> None:
    """Model emits ``identityFacts``; caller asks for ``key_identity_facts``."""
    raw = '{"identityFacts": [{"field": "name", "value": "Jane"}]}'
    parsed = _parse_json_with_keys(
        raw, "key_identity_facts",
        aliases={"key_identity_facts": ["identityFacts", "identity_facts",
                                        "keyIdentityFacts"]},
    )
    assert parsed.get("key_identity_facts") == [
        {"field": "name", "value": "Jane"},
    ]


def test_parse_with_alias_for_facts_list_variant() -> None:
    raw = '{"factsList": [{"category": "personal", "fact": "x"}]}'
    parsed = _parse_json_with_keys(
        raw, "facts",
        aliases={"facts": ["factsList", "extracted_facts"]},
    )
    assert parsed.get("facts") == [{"category": "personal", "fact": "x"}]


def test_parse_multi_key_envelope_returns_both() -> None:
    raw = json.dumps({
        "brief": "Sir, welcome.",
        "opportunities": [{"id": "watch-subs", "name": "Watch subs"}],
    })
    parsed = _parse_json_with_keys(raw, "opportunities")
    assert parsed.get("brief") == "Sir, welcome."
    assert parsed.get("opportunities") == [
        {"id": "watch-subs", "name": "Watch subs"},
    ]


def test_parse_garbage_response_logs_raw_sample(caplog) -> None:
    """62-char production failure: log head/tail/length so future
    regressions are diagnosable instead of a ``len=62`` mystery."""
    raw = "I cannot return JSON for this request. Please try again. xxxxx"
    assert len(raw) == 62
    with caplog.at_level(logging.WARNING, logger="alfred-learn"):
        parsed = _parse_json_with_keys(raw, "facts")
    assert parsed == {}
    joined = "\n".join(rec.getMessage() for rec in caplog.records)
    assert "62" in joined
    assert "I cannot return JSON" in joined


def test_parse_empty_response_returns_empty_no_crash(caplog) -> None:
    with caplog.at_level(logging.WARNING, logger="alfred-learn"):
        parsed = _parse_json_with_keys("", "facts")
    assert parsed == {}


def test_parse_alias_only_for_requested_key_not_arbitrary() -> None:
    """Aliasing must NOT accept a stray list-valued key."""
    parsed = _parse_json_with_keys(
        '{"randomOther": [1, 2, 3]}', "facts",
        aliases={"facts": ["factsList"]},
    )
    assert parsed == {}
