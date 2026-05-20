"""Tests for S4-9 quarantine gate in _base.py.

Covers:
  - `_coerce_int` / `_coerce_bool` normalization of frontmatter values
    (YAML parser may hand us strings, ints, bools)
  - `is_quarantined` gate logic
  - `_format_frontmatter_value` serialization for the record rewrite
    path (used by decrement_quarantine_remaining)

The full decrement_quarantine_remaining activity is exercised by
the smoke test on david's tenant — it needs a live ctrl-api vault
client which the unit tests don't mock.
"""
from __future__ import annotations

import json

from src.workflows.chores._base import (
    _coerce_bool,
    _coerce_int,
    _format_frontmatter_value,
    _rebuild_markdown,
    is_quarantined,
)


# ---------------------------------------------------------------------------
# _coerce_int
# ---------------------------------------------------------------------------

class TestCoerceInt:
    def test_int_passthrough(self):
        assert _coerce_int(5) == 5

    def test_string_numeric(self):
        assert _coerce_int("3") == 3

    def test_string_non_numeric_returns_default(self):
        assert _coerce_int("abc") == 0
        assert _coerce_int("abc", default=99) == 99

    def test_none_returns_default(self):
        assert _coerce_int(None) == 0

    def test_negative_clamped_to_zero(self):
        assert _coerce_int(-5) == 0

    def test_float_truncates(self):
        assert _coerce_int(3.7) == 3

    def test_bool_is_int(self):
        # Python treats bool as int, normalize to concrete int
        assert _coerce_int(True) == 1
        assert _coerce_int(False) == 0


# ---------------------------------------------------------------------------
# _coerce_bool
# ---------------------------------------------------------------------------

class TestCoerceBool:
    def test_real_bool_passthrough(self):
        assert _coerce_bool(True) is True
        assert _coerce_bool(False) is False

    def test_true_strings(self):
        assert _coerce_bool("true") is True
        assert _coerce_bool("TRUE") is True
        assert _coerce_bool("True") is True
        assert _coerce_bool("yes") is True
        assert _coerce_bool("1") is True

    def test_false_strings(self):
        assert _coerce_bool("false") is False
        assert _coerce_bool("no") is False
        assert _coerce_bool("0") is False
        assert _coerce_bool("") is False

    def test_none_returns_default(self):
        assert _coerce_bool(None) is False
        assert _coerce_bool(None, default=True) is True

    def test_random_string_returns_default(self):
        assert _coerce_bool("maybe") is False


# ---------------------------------------------------------------------------
# is_quarantined gate
# ---------------------------------------------------------------------------

class TestIsQuarantined:
    def test_quarantine_flag_false_returns_false(self):
        ctx = {"quarantine": False, "quarantine_remaining": 3}
        assert is_quarantined(ctx) is False

    def test_quarantine_true_remaining_positive_returns_true(self):
        ctx = {"quarantine": True, "quarantine_remaining": 3}
        assert is_quarantined(ctx) is True

    def test_quarantine_true_remaining_zero_returns_false(self):
        """Quarantine flag true but counter hit 0 — technically released,
        should be treated as not quarantined."""
        ctx = {"quarantine": True, "quarantine_remaining": 0}
        assert is_quarantined(ctx) is False

    def test_missing_fields_returns_false(self):
        assert is_quarantined({}) is False

    def test_string_true_flag_still_works(self):
        """Vault parser sometimes hands us strings for bools."""
        ctx = {"quarantine": "true", "quarantine_remaining": "2"}
        assert is_quarantined(ctx) is True

    def test_non_dict_returns_false(self):
        assert is_quarantined(None) is False  # type: ignore[arg-type]
        assert is_quarantined("not a dict") is False  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# _format_frontmatter_value
# ---------------------------------------------------------------------------

class TestFormatFrontmatterValue:
    def test_none(self):
        assert _format_frontmatter_value(None) == "null"

    def test_bool(self):
        assert _format_frontmatter_value(True) == "true"
        assert _format_frontmatter_value(False) == "false"

    def test_int(self):
        assert _format_frontmatter_value(42) == "42"

    def test_float(self):
        assert _format_frontmatter_value(0.5) == "0.5"

    def test_plain_string(self):
        assert _format_frontmatter_value("hello") == "hello"

    def test_string_with_colon_quoted(self):
        result = _format_frontmatter_value("time: 9pm")
        assert result.startswith("'") and result.endswith("'")

    def test_string_with_single_quote_escaped(self):
        result = _format_frontmatter_value("it's")
        assert result == "'it''s'"

    def test_list_of_strings(self):
        assert _format_frontmatter_value(["a", "b", "c"]) == "[a, b, c]"

    def test_list_of_ints(self):
        assert _format_frontmatter_value([1, 2, 3]) == "[1, 2, 3]"

    def test_nested_dict_serialized_as_json_scalar(self):
        """Nested dicts blow the flat parser, so serialize as JSON scalar."""
        result = _format_frontmatter_value({"key": "value"})
        assert result.startswith("'") and result.endswith("'")
        # Should round-trip via json.loads
        inner = result[1:-1].replace("''", "'")
        assert json.loads(inner) == {"key": "value"}


# ---------------------------------------------------------------------------
# _rebuild_markdown
# ---------------------------------------------------------------------------

class TestRebuildMarkdown:
    def test_basic_roundtrip(self):
        fm = {"type": "chore", "name": "Test", "status": "active"}
        body = "# Test\n\nBody content."
        result = _rebuild_markdown(fm, body)
        assert result.startswith("---\n")
        assert "type: chore" in result
        assert "name: Test" in result
        assert "status: active" in result
        assert "# Test\n\nBody content." in result

    def test_preserves_body_newlines(self):
        fm = {"type": "chore"}
        body = "line1\nline2\nline3"
        result = _rebuild_markdown(fm, body)
        assert "line1\nline2\nline3" in result

    def test_bool_and_int_fields(self):
        fm = {
            "type": "chore",
            "quarantine": True,
            "quarantine_remaining": 2,
            "generated": True,
        }
        result = _rebuild_markdown(fm, "body")
        assert "quarantine: true" in result
        assert "quarantine_remaining: 2" in result
        assert "generated: true" in result

    def test_frontmatter_delimiters_present(self):
        result = _rebuild_markdown({"a": 1}, "body")
        # Exactly two --- delimiters (opening + closing)
        assert result.count("---\n") == 2
