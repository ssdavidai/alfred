"""Bug #12 (D1/D2/D5) — source COUNT alone must not manufacture `high` confidence.

`alfred.distiller.confidence` is a pure module with no logging/heavy imports, so
it is importable in the worktree venv even though `alfred.distiller.pipeline`
(which now calls it) is not collectable here (it pulls `structlog`).
"""

from __future__ import annotations

import pytest

from alfred.distiller.confidence import bump_confidence


def test_three_low_sources_promote_to_medium():
    assert bump_confidence("low", 3) == "medium"


def test_two_low_sources_stay_low():
    assert bump_confidence("low", 2) == "low"


def test_count_alone_never_reaches_high():
    """The core fix: many agreeing sources can lend modest support (low→medium)
    but can NEVER mechanically mint `high` confidence."""
    for n in range(1, 50):
        assert bump_confidence("medium", n) == "medium"
        assert bump_confidence("low", n) in {"low", "medium"}


def test_high_is_preserved_not_invented():
    # An LLM-assessed `high` is honoured; count never downgrades it.
    assert bump_confidence("high", 1) == "high"
    assert bump_confidence("high", 10) == "high"


def test_unknown_input_is_returned_unchanged():
    assert bump_confidence("", 5) == ""
    assert bump_confidence("bogus", 5) == "bogus"


@pytest.mark.parametrize("count", [0, -1])
def test_non_positive_count_is_inert(count):
    assert bump_confidence("low", count) == "low"
    assert bump_confidence("medium", count) == "medium"
