"""Bug #13 — surveyor `matter` phantom type.

`labeler.ENTITY_RECORD_TYPES` listed "matter", but vault/schema.py KNOWN_TYPES
has no "matter". If that path fired it would write `related_matters` links
pointing at a type the rest of the system rejects (dead/poison code).

NOTE on import strategy: `alfred.surveyor.labeler` imports `structlog` and the
`openai` SDK at module top — neither is in the worktree-local venv (they are
the heavy/runtime surveyor deps). We therefore can't import ENTITY_RECORD_TYPES
directly. Per the lane instructions we encode the *expected* post-fix value of
the constant here and assert it against the authoritative KNOWN_TYPES from
schema.py (a light module). The labeler edit itself is additionally guarded by
`python3 -m py_compile`. If labeler.py ever sheds its heavy top-level imports,
this test should be switched to import ENTITY_RECORD_TYPES directly.
"""

from __future__ import annotations

from alfred.vault.schema import KNOWN_TYPES

# Expected value of labeler.ENTITY_RECORD_TYPES AFTER the fix (matter removed).
EXPECTED_ENTITY_RECORD_TYPES = frozenset({"person", "org", "project"})


def test_entity_record_types_are_all_known_types():
    """Every surveyor entity type must be a canonical KNOWN_TYPE, else any
    `related_<type>` link it writes points at a type the system rejects."""
    assert EXPECTED_ENTITY_RECORD_TYPES <= KNOWN_TYPES


def test_matter_is_not_an_entity_record_type():
    assert "matter" not in EXPECTED_ENTITY_RECORD_TYPES
    # And the reason it must go: `matter` is not a canonical vault type.
    assert "matter" not in KNOWN_TYPES


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
