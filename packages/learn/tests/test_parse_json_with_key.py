"""Tests for the LLM JSON envelope parser used by every Opus pack stage.

The previous implementation tracked brace depth without respecting JSON
string literals — every literal ``{`` or ``}`` inside a string value
(common in Opus matter descriptions that reference URL templates, code
snippets, or schedule cron expressions) pushed the depth counter out
of sync and the parse failed.

The visible production symptom was ``generate_matter_pack_opus`` silently
falling back to the rule-based path (one matter per top domain) instead
of using Opus's semantic clustering, even though the LLM call succeeded
and the response was well-formed JSON wrapped in a ``` ```json fence.

These tests pin the harder envelope shapes the parser must handle.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.onboarding_v3 import (  # noqa: E402
    _parse_json_with_key,
    _string_aware_json_object_span,
)


def test_string_aware_span_basic_object() -> None:
    text = '{"a": 1, "b": 2}'
    assert _string_aware_json_object_span(text, 0) == len(text) - 1


def test_string_aware_span_braces_inside_string() -> None:
    # Literal `{` and `}` inside a string MUST NOT affect depth.
    text = '{"k": "uses {curly} braces"}'
    assert _string_aware_json_object_span(text, 0) == len(text) - 1


def test_string_aware_span_escaped_quote_in_string() -> None:
    # An escaped `\"` inside a string MUST NOT end the string.
    text = '{"k": "she said \\"{nope}\\" loudly"}'
    assert _string_aware_json_object_span(text, 0) == len(text) - 1


def test_string_aware_span_nested_objects() -> None:
    text = '{"outer": {"inner": "{not real}"}}'
    assert _string_aware_json_object_span(text, 0) == len(text) - 1


def test_string_aware_span_unterminated_returns_none() -> None:
    text = '{"k": "no closing'  # unterminated string
    assert _string_aware_json_object_span(text, 0) is None


def test_parse_bare_json_object() -> None:
    raw = '{"matters": [{"name": "A"}, {"name": "B"}]}'
    parsed = _parse_json_with_key(raw, "matters")
    assert parsed["matters"] == [{"name": "A"}, {"name": "B"}]


def test_parse_code_fenced_json() -> None:
    raw = '```json\n{"matters": [{"name": "X"}]}\n```'
    parsed = _parse_json_with_key(raw, "matters")
    assert parsed["matters"] == [{"name": "X"}]


def test_parse_json_with_literal_braces_in_string_value() -> None:
    # The production failure mode: Opus emits a matter whose description
    # mentions URL templates / placeholders / code with literal braces.
    # The brace-aware parser must STILL return the full list, not bail
    # out and let the caller fall back to rule_based_parse_error.
    raw = (
        '```json\n'
        '{"matters": ['
        '  {"name": "alfred-black product", '
        '   "description": "uses {userId} and {tenantId} placeholders, '
        'cron schedule like 30 4 * * * compiled from {schedule}"},'
        '  {"name": "neoterra engagement", '
        '   "description": "weekly with Rob and Caddie"}'
        ']}\n'
        '```'
    )
    parsed = _parse_json_with_key(raw, "matters")
    assert isinstance(parsed.get("matters"), list)
    assert len(parsed["matters"]) == 2
    assert parsed["matters"][0]["name"] == "alfred-black product"
    assert "{userId}" in parsed["matters"][0]["description"]


def test_parse_json_with_prose_before_and_after() -> None:
    raw = (
        "Sure, here are the matters I identified:\n\n"
        '{"matters": [{"name": "M1"}]}\n\n'
        "Let me know if you want adjustments."
    )
    parsed = _parse_json_with_key(raw, "matters")
    assert parsed["matters"] == [{"name": "M1"}]


def test_parse_json_truncated_at_max_tokens() -> None:
    # Mid-array cut-off — brace repair kicks in and gives us what we have.
    raw = '{"matters": [{"name": "A"}, {"name": "B"'
    parsed = _parse_json_with_key(raw, "matters")
    # The repair appends `}]}` so we should at least see A; B may or may
    # not survive depending on where the cut landed, but `matters` must be
    # a list with at least one well-formed item.
    assert isinstance(parsed.get("matters"), list)
    assert len(parsed["matters"]) >= 1
    assert parsed["matters"][0] == {"name": "A"}


def test_parse_json_missing_key_returns_empty() -> None:
    raw = '{"other": []}'
    assert _parse_json_with_key(raw, "matters") == {}


def test_parse_json_open_fence_no_close() -> None:
    # Opus occasionally forgets the closing fence when it ends at
    # max_tokens; the opener-only path must still find the JSON.
    raw = '```json\n{"matters": [{"name": "Y"}]}'
    parsed = _parse_json_with_key(raw, "matters")
    assert parsed.get("matters") == [{"name": "Y"}]
