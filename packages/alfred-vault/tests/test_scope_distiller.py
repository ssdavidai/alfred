"""Bug #12 — the distiller must NOT author principal-facing `decision/` records.

These tests import ONLY the light vault modules (scope.py / schema.py) and the
pure distiller confidence helper. They never touch the surveyor embedder/labeler
or anything that pulls heavy deps (pymilvus/hdbscan/leidenalg/ollama/structlog),
so they are collectable in the worktree-local venv.
"""

from __future__ import annotations

import pytest

from alfred.vault.scope import check_scope, ScopeError
from alfred.vault.schema import (
    LEARN_TYPES,
    DISTILLER_CREATABLE_TYPES,
    TYPE_DIRECTORY,
)


# --- The distiller-creatable set ------------------------------------------


def test_decision_is_excluded_from_distiller_creatable_types():
    """`decision` maps into the principal's decision/ dir (TYPE_DIRECTORY) so
    machine inferences would be indistinguishable from the principal's real
    decisions. It must not be a distiller-creatable type."""
    assert "decision" not in DISTILLER_CREATABLE_TYPES
    # It is still a recognised learn type (the distiller may READ decisions as
    # evidence) and still a real principal-facing vault directory.
    assert "decision" in LEARN_TYPES
    assert TYPE_DIRECTORY["decision"] == "decision"


def test_distiller_creatable_is_subset_of_learn_types():
    assert DISTILLER_CREATABLE_TYPES <= LEARN_TYPES
    # Everything else the distiller reasons over is still creatable.
    assert DISTILLER_CREATABLE_TYPES == LEARN_TYPES - {"decision"}


# --- The scope gate --------------------------------------------------------


def test_distiller_cannot_create_decision():
    with pytest.raises(ScopeError):
        check_scope("distiller", "create", rel_path="decision/x.md", record_type="decision")


@pytest.mark.parametrize("rec_type", sorted(LEARN_TYPES - {"decision"}))
def test_distiller_can_create_other_learn_types(rec_type):
    # Should not raise.
    check_scope("distiller", "create", rel_path=f"{rec_type}/x.md", record_type=rec_type)


def test_distiller_cannot_create_arbitrary_type():
    with pytest.raises(ScopeError):
        check_scope("distiller", "create", rel_path="task/x.md", record_type="task")


def test_curator_still_creates_decision():
    """The scope tightening targets the distiller only; the curator (whose
    create permission is unconditional `True`) is unaffected."""
    check_scope("curator", "create", rel_path="decision/x.md", record_type="decision")
