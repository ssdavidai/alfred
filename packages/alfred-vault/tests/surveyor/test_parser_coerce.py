"""Tests for parser._coerce_record_type — defends the surveyor embed path
against malformed `type:` frontmatter (e.g. one-element YAML block lists).
"""
from __future__ import annotations

from alfred.surveyor.parser import _coerce_record_type


def test_scalar_string_passes_through() -> None:
    assert _coerce_record_type("matter") == "matter"


def test_none_falls_back_to_unknown() -> None:
    assert _coerce_record_type(None) == "unknown"


def test_single_element_list_takes_first() -> None:
    # This is the Miguel crash case: curator emitted `type:\n- contradiction`
    assert _coerce_record_type(["contradiction"]) == "contradiction"


def test_multi_element_list_takes_first_non_empty() -> None:
    assert _coerce_record_type(["", "note", "extra"]) == "note"


def test_empty_list_falls_back_to_unknown() -> None:
    assert _coerce_record_type([]) == "unknown"


def test_list_of_all_non_strings_falls_back_to_unknown() -> None:
    assert _coerce_record_type([None, 42, {"k": "v"}]) == "unknown"


def test_int_coerced_to_str() -> None:
    assert _coerce_record_type(42) == "42"


def test_bool_coerced_to_str() -> None:
    assert _coerce_record_type(True) == "True"


def test_whitespace_stripped_from_list_item() -> None:
    assert _coerce_record_type(["  matter  "]) == "matter"
