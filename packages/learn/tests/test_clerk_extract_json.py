"""Hardening: _extract_json must honour its ``-> dict`` contract.

FAILURE-MODES Hermes runtime, S2 — the array-salvage branch returned a
bare ``list`` from a function annotated ``-> dict``, so single-object
callers (e.g. ``media_ingestion.py``'s ``classification.get(...)``) hit
``AttributeError: 'list' object has no attribute 'get'``. The salvaged
array is wrapped as ``{"results": [...]}`` instead — a dict, which the
one array-consumer (enrichment._call_clerk caller, which already unwraps
a ``results`` key) still reads correctly.

Tests cover both salvage paths: truncation-repair (close open braces) and
the array salvage (recover complete objects from a truncated array).
"""
from __future__ import annotations

import pytest

from src.activities.clerk import _extract_json


def test_clean_object_parses_to_dict() -> None:
    out = _extract_json('{"type": "note", "title": "x"}')
    assert isinstance(out, dict)
    assert out["type"] == "note"


def test_truncation_repair_returns_dict() -> None:
    """A truncated object (missing closing brace) is repaired into a dict —
    and a single-object caller can ``.get`` it without AttributeError."""
    truncated = '{"type": "note", "title": "hello", "tags": ["a", "b"'
    out = _extract_json(truncated)
    assert isinstance(out, dict), "truncation-repair must yield a dict"
    # The single-object caller contract: .get works.
    assert out.get("type") == "note"
    assert out.get("title") == "hello"


def test_array_salvage_returns_dict_not_bare_list() -> None:
    """A truncated JSON ARRAY salvages its complete objects into
    ``{"results": [...]}`` — never a bare list (which would break
    ``classification.get(...)`` in media_ingestion)."""
    # An array of two objects, truncated mid-third-object.
    truncated_array = (
        '[{"event_index": 0, "summary": "a"}, '
        '{"event_index": 1, "summary": "b"}, {"event_index": 2, "su'
    )
    out = _extract_json(truncated_array)
    assert isinstance(out, dict), "array salvage must NOT return a bare list"
    assert "results" in out
    salvaged = out["results"]
    assert isinstance(salvaged, list)
    # Both complete objects recovered; the truncated third is dropped.
    assert [o["event_index"] for o in salvaged] == [0, 1]
    # Single-object caller contract holds: .get is available.
    assert out.get("results") is salvaged


def test_unparseable_raises_value_error() -> None:
    """Genuinely unparseable content raises a clear ValueError rather than
    returning anything dubious."""
    with pytest.raises(ValueError, match="Could not parse JSON"):
        _extract_json("this is not json at all, just prose")


def test_empty_raises_value_error() -> None:
    with pytest.raises(ValueError, match="Empty clerk response"):
        _extract_json("   ")
