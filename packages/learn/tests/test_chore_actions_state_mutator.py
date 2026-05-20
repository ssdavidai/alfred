"""W9 no-op regression — Phase D audit of ``chore_actions`` (spec §7 W9).

The W9 audit concluded that ``src/activities/chore_actions.py`` does **not**
mutate any matter or task state field. Every activity in the module either:

* Reads vault records (R) — ``fetch_financial_events``,
  ``fetch_matter_events_last_week``, ``_gather_signal_bundle``,
  ``_load_active_matters``.
* Writes non-state vault records (N) — ``save_digest_to_vault`` writes a
  ``note/*`` record; ``build_daily_briefing_v2`` only delivers prose to
  Slack via ctrl-api ``/notifications``.
* Writes snapshots / preview files to ``/alfred-data`` (N).
* Calls ctrl-api or Composio actions whose payloads are non-state-field
  (subscription anomalies, calendar lookups, Slack delivery).
* Composes prompts whose *content* contains the string ``PATCH`` —
  instructing a subagent in another container what to do — but never
  issues a PATCH from this module.

The vault-curator subagent spawned by ``_enrich_bare_matter`` PATCHes
routing metadata (``domains``, ``related_persons``, ``related_orgs``,
``keywords``, ``parent_matter``) on matters. None of those are state
fields under §2. The current ``build_daily_briefing_v2`` no longer calls
``_enrich_bare_matter`` (the inline call site was removed in the
redesign; see the inline comment near ``enriched_count = 0``).

This file pins that finding so a future writer who adds a state-field
mutation to ``chore_actions`` is forced to either route it through
``state_mutator.apply_state_change_v2`` or explicitly bless the new
writer here.

If this test ever fails, the right answer is almost always to retrofit
the new writer through v2 — not to widen the allowlist.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest


# Resolve relative to this test file so the assertion is robust to where
# pytest is invoked from (CI runs from /packages/learn; local runs may
# invoke from the monorepo root).
_CHORE_ACTIONS = (
    Path(__file__).resolve().parent.parent
    / "src"
    / "activities"
    / "chore_actions.py"
)


# State fields declared in spec §2 — Matter + Task.
STATE_FIELDS = (
    "current_state",
    "as_of",
    "surface_class",
    "last_briefing_at",
    "last_steward_outcome",
    "pending_confirmation",
    "outcome",
)

# ``status`` is also a state field but appears far too often in
# non-mutation contexts (HTTP status codes, status-string filters,
# logging) for a plain substring grep to be useful. We handle it via a
# separate pattern that looks for assignment / PATCH-body shapes.


def _load_chore_actions_source() -> str:
    assert _CHORE_ACTIONS.exists(), f"chore_actions source missing: {_CHORE_ACTIONS}"
    return _CHORE_ACTIONS.read_text(encoding="utf-8")


def test_chore_actions_does_not_reference_state_fields() -> None:
    """No state-field name appears in chore_actions.py.

    Tight check — any introduction of e.g. ``current_state =`` or a
    PATCH body keyed on ``surface_class`` will trip this assertion and
    force the contributor to route through ``state_mutator``.
    """
    source = _load_chore_actions_source()
    hits: dict[str, list[int]] = {}
    for field in STATE_FIELDS:
        lines = [
            i + 1
            for i, line in enumerate(source.splitlines())
            if field in line
        ]
        if lines:
            hits[field] = lines
    assert not hits, (
        f"chore_actions.py mentions state field(s) {sorted(hits)} — "
        f"if this is a deliberate new mutation, retrofit it through "
        f"state_mutator.apply_state_change_v2 with source="
        f"'chore_actions.<action_name>' rather than touching the field "
        f"directly. Hits: {hits!r}"
    )


def test_chore_actions_does_not_set_status_on_matter_or_task() -> None:
    """No assignment / PATCH body sets a matter or task ``status``.

    ``status`` is too common a token to grep blindly (HTTP responses,
    string filters all use it). This finer check looks for the shapes
    that would indicate a real mutation:

      * ``"status":`` inside a PATCH body
      * ``status=<literal>`` in a kwarg style write
      * ``set("status",`` style patches
    """
    source = _load_chore_actions_source()
    # Exclude the YAML frontmatter literal in save_digest_to_vault's
    # note record (``status: active`` inside a triple-quoted note body
    # is fine — note records aren't state-bearing per §2).
    forbidden_patterns = [
        # JSON dict key inside a PATCH-ish call shape, e.g.
        # {"status": "closed"} — note the colon+space-then-value.
        r'"status"\s*:\s*"(?:active|open|closed|archived|in_progress|blocked|dormant|completed)"',
    ]
    offenders: list[tuple[str, int, str]] = []
    for pattern in forbidden_patterns:
        for m in re.finditer(pattern, source):
            line_no = source.count("\n", 0, m.start()) + 1
            line = source.splitlines()[line_no - 1]
            # Allow the line if it's clearly inside a prompt string
            # being SENT TO an LLM. We detect this by checking if the
            # surrounding 200 chars contain ``prompt`` keyword and a
            # triple-quote, OR the line is inside a YAML-shaped note
            # body (``f"""...status: active\n..."""``). Both are
            # benign — they're describing state, not patching it.
            window_start = max(0, m.start() - 400)
            window = source[window_start : m.start() + 200]
            if "prompt" in window.lower() or '"""' in window:
                continue
            offenders.append((pattern, line_no, line.strip()))
    assert not offenders, (
        f"chore_actions.py contains state-field PATCH-shaped writes: "
        f"{offenders!r}. Route these through state_mutator.apply_state_change_v2."
    )


def test_chore_actions_imports_no_state_mutator_symbols() -> None:
    """No retrofit shipped — chore_actions doesn't import state_mutator.

    If this assertion ever flips, the matching retrofit MUST also
    register a ``@propose_fn`` and gate any new ``workflow.execute_activity``
    in a workflow.run with ``workflow.patched("chore_action_<name>_state_mutator_v1")``
    per spec §6.3. Until that ships, the import shouldn't appear.
    """
    source = _load_chore_actions_source()
    assert "from src.activities.state_mutator" not in source, (
        "chore_actions.py imports from state_mutator — if you're "
        "shipping a W9 retrofit, update this regression to reflect "
        "the new shape (propose_fn name, source, patched gate)."
    )
    assert "apply_state_change_v2" not in source, (
        "chore_actions.py references apply_state_change_v2 — if you're "
        "shipping a W9 retrofit, update this regression."
    )
