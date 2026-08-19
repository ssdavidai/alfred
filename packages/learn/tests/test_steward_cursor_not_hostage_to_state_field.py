"""The steward's cursor must not share a PATCH with a state field.

ctrl-api rejects any PATCH touching a TASK STATE FIELD when
STATE_CHANGE_ENFORCEMENT=reject — and it rejects the WHOLE request. The steward
bundled `last_steward_outcome` (a state field) with its own bookkeeping, so on
a strict tenant NONE of it landed: `last_steward_check_at`, `next_check_after`
and `steward_no_signal_streak` never advanced, and the sweep re-evaluated the
same tasks forever without recording that it had looked.

Live on the dev tenant before the split: ~170 rejected PATCHes an hour, the
same task hit twice inside one second, and a fallback that retried the very
same forbidden field through the scalar path — guaranteed to fail identically.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from src.activities.steward import STEWARD_CURSOR_FIELDS

REPO_ROOT = Path(__file__).resolve().parents[3]
CTRL_STATE_FIELDS = REPO_ROOT / "packages/ctrl/src/api/stateFields.ts"


def _ctrl_task_state_fields() -> set[str]:
    src = CTRL_STATE_FIELDS.read_text()
    block = re.search(
        r"TASK_STATE_FIELDS: readonly string\[\] = \[(.*?)\]", src, re.S
    )
    assert block, "could not find TASK_STATE_FIELDS in ctrl's stateFields.ts"
    return set(re.findall(r'"([a-z_]+)"', block.group(1)))


def test_cursor_fields_are_disjoint_from_ctrl_state_fields():
    """The seam. ctrl owns the state-field list; if a cursor field ever
    appears in it, the cursor stops advancing on strict tenants and the sweep
    silently spins."""
    if not CTRL_STATE_FIELDS.exists():
        pytest.skip("ctrl package not present")
    overlap = set(STEWARD_CURSOR_FIELDS) & _ctrl_task_state_fields()
    assert not overlap, (
        f"steward cursor fields collide with ctrl's TASK_STATE_FIELDS: "
        f"{sorted(overlap)} — ctrl 403s the whole PATCH, so the cursor "
        f"would never advance"
    )


def test_last_steward_outcome_is_a_state_field_and_not_a_cursor_field():
    """Pins the specific regression: the outcome payload belongs on the
    state-change route, not in the cursor bundle."""
    if not CTRL_STATE_FIELDS.exists():
        pytest.skip("ctrl package not present")
    assert "last_steward_outcome" in _ctrl_task_state_fields()
    assert "last_steward_outcome" not in STEWARD_CURSOR_FIELDS


def test_evaluate_task_patches_the_outcome_separately():
    """Behaviour, not just naming: the two writes must be separate calls, so a
    refusal of one cannot take the other down."""
    src = (REPO_ROOT / "packages/learn/src/activities/steward.py").read_text()
    body = src[src.index("STEWARD_CURSOR_FIELDS"):]
    cursor_call = body.index("json_updates={\"signal_sources\": updated_sources}")
    outcome_call = body.index("json_updates={\"last_steward_outcome\": last_outcome_payload}")
    assert cursor_call != outcome_call, "outcome and cursor must not share a PATCH"
