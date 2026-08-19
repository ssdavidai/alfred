"""Bug #13 — surveyor `matter` phantom type.

Originally filed the wrong way round, and corrected here. Bug #13 saw "matter"
in `labeler.ENTITY_RECORD_TYPES`, found no "matter" in vault/schema.py
KNOWN_TYPES, and removed "matter" — keeping "project". But KNOWN_TYPES was the
stale half: it predated the four-store cutover, where `matter` is the canonical
type and `project` is the name it replaced. ctrl-api rejects `project` with 422
PROMOTION_CONTRACT_VIOLATION, so the cluster path was writing `related_project`
links at a type the system refuses — the very poison-link failure this test set
out to prevent.

NOTE on import strategy: `alfred.surveyor.labeler` imports `structlog` at
module top — a heavy runtime dep that may not be in a minimal test env. We
therefore read ENTITY_RECORD_TYPES via AST rather than a live import, and
assert it against the authoritative KNOWN_TYPES from schema.py (a light
module). The labeler edit is additionally guarded by `python3 -m py_compile`.
"""

from __future__ import annotations

from alfred.vault.schema import KNOWN_TYPES

# Expected value of labeler.ENTITY_RECORD_TYPES AFTER the fix (matter removed).
EXPECTED_ENTITY_RECORD_TYPES = frozenset({"person", "org", "matter"})


def test_entity_record_types_are_all_known_types():
    """Every surveyor entity type must be one ctrl-api will accept, else any
    `related_<type>` link it writes points at a type the system rejects.
    KNOWN_TYPES is too weak a bar — it still contains pre-cutover names."""
    from alfred.vault.schema import CANONICAL_VAULT_TYPES
    assert EXPECTED_ENTITY_RECORD_TYPES <= KNOWN_TYPES
    assert EXPECTED_ENTITY_RECORD_TYPES <= CANONICAL_VAULT_TYPES


def test_project_is_not_an_entity_record_type():
    """`project` is the pre-cutover name. ctrl-api answers 422 for it, so a
    `related_project` link is exactly the poison link bug #13 meant to stop."""
    from alfred.vault.schema import CANONICAL_VAULT_TYPES
    assert "project" not in EXPECTED_ENTITY_RECORD_TYPES
    assert "project" not in CANONICAL_VAULT_TYPES
    assert "matter" in CANONICAL_VAULT_TYPES


def test_labeler_constant_matches_expected():
    """Pin the source-of-truth: read the literal frozenset out of labeler.py
    (without importing it, to avoid the heavy deps) and confirm it equals the
    expected post-fix value."""
    import ast
    from pathlib import Path

    src = Path(__file__).resolve().parents[1] / "src" / "alfred" / "surveyor" / "labeler.py"
    tree = ast.parse(src.read_text(encoding="utf-8"))
    found: frozenset[str] | None = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "ENTITY_RECORD_TYPES":
                    # frozenset({...}) — pull the literal set out of the call arg.
                    call = node.value
                    assert isinstance(call, ast.Call), "ENTITY_RECORD_TYPES not a frozenset(...) call"
                    set_literal = ast.literal_eval(call.args[0])
                    found = frozenset(set_literal)
    assert found is not None, "ENTITY_RECORD_TYPES not found in labeler.py"
    assert found == EXPECTED_ENTITY_RECORD_TYPES
