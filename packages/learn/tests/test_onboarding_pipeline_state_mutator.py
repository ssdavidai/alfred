"""W12 no-op regression — Phase D audit of onboarding (spec §7 W12).

The W12 audit concluded that ``OnboardingPipelineWorkflow`` and its
delegated activities only **create** vault records — they never mutate
the state fields of existing matters or tasks. The relevant inventory:

* ``init_onboard_json`` / ``update_onboard_stage`` /
  ``update_onboard_progress`` (``onboarding.py``) — write to
  ``/alfred-data/onboard.json``. Not vault records.
* ``fetch_email_metadata``, ``extract_facts_opus``,
  ``discover_patterns_opus``, ``personalize_opus`` (``onboarding_v3.py``)
  — read/write ``onboard.json`` and ``USER.md`` / ``SOUL.md`` /
  ``MEMORY.md`` / ``TOOLS.md`` workspace files. Not vault matter/task.
* ``write_brief_opus`` / ``write_brief_and_opportunities_opus`` — write
  ``event/First Brief.md``. Event records are out of scope per §2.
* ``write_facts_to_vault`` — writes ``observation/*`` + entity records
  (``person/*``, ``org/*``, ``project/*``, ``location/*``). None are
  matter/task per §2.
* ``generate_matter_pack`` / ``generate_matter_pack_opus`` — CREATE
  ``matter/*`` records when none exists; deduplicate against existing
  records and skip rather than mutate (see ``packs.py`` lines 433-436
  and ``packs_opus.py`` lines 472-481).
* ``generate_errand_pack`` / ``generate_errand_pack_opus`` — CREATE
  ``task/*`` records with the same dedup-skip behaviour
  (``packs_opus.py`` lines 893-902).
* ``generate_instinct_pack`` / ``generate_instinct_pack_opus`` — CREATE
  ``instinct/*`` records. Instincts are out of scope per §2.
* ``generate_stream_pack`` — writes stream-routing suggestions to
  ``onboard.json``. Not vault state.
* ``assign_initial_chores`` (``assign_chores.py``) — CREATES
  ``chore/*`` records. Chores are out of scope per §2; their lifecycle
  is recorded via ``record_chore_run``.
* ``backfill_gmail_as_events`` / ``process_stream_batch`` — pull and
  batch raw stream events into the inbox; no matter/task touches.

Spec §7 W12 says: *"Source=onboarding; arguably initial seed isn't
'mutation' but for uniformity, route through v2 with prior_as_of=null."*
We took the "arguably not a mutation" branch, consistent with W10
(``task_creation``) which the project already retrofitted with the same
reasoning ("creation ≠ mutation; no retrofit"). The ``v2`` endpoint
PATCHes state fields on existing records — using it to PATCH a newly
created record's state fields would be a redundant second hop after the
``write_record`` create. The cleaner contract is: creation goes through
the create endpoint; *mutation of existing state* goes through v2.

If onboarding ever grows a code path that mutates an existing matter or
task (rather than creating one fresh), this regression will trip and the
new path MUST be retrofitted through ``state_mutator.apply_state_change_v2``
with source=``onboarding``.
"""
from __future__ import annotations

from pathlib import Path


_ROOT = Path(__file__).resolve().parent.parent / "src"
_ONBOARDING_FILES = (
    _ROOT / "workflows" / "onboarding_pipeline.py",
    _ROOT / "activities" / "onboarding.py",
    _ROOT / "activities" / "onboarding_v3.py",
)

# State fields declared in spec §2 — Matter + Task.
STATE_FIELDS = (
    "current_state",
    "surface_class",
    "last_briefing_at",
    "last_steward_outcome",
    "pending_confirmation",
)


def _read(path: Path) -> str:
    assert path.exists(), f"onboarding source missing: {path}"
    return path.read_text(encoding="utf-8")


def test_onboarding_does_not_reference_matter_task_state_fields() -> None:
    """No state-field name appears in the onboarding pipeline files
    as a vault PATCH key or frontmatter key.

    Note: ``as_of``, ``status``, and ``outcome`` are excluded from this
    check because they appear in non-mutation contexts (cron expressions,
    HTTP status codes, fact ``outcome`` summaries in LLM prompts, YAML
    frontmatter literals on newly-created records). We also tolerate the
    bare identifier ``current_state`` appearing as a *local Python
    variable name* in ``onboarding_pipeline.py`` — the workflow uses it
    for the onboard.json dict, which has nothing to do with matter
    state. We only flag occurrences in vault-write contexts (PATCH
    bodies, JSON envelopes, YAML frontmatter literals).
    """
    # Look for state fields used in matter/task PATCH-shaped contexts:
    # JSON dict keys of the shape '"<field>":' (the only unambiguous
    # signal of a vault PATCH or POST body in these files). A bare
    # ``current_state:`` on its own line is too ambiguous — Python
    # type annotations and YAML frontmatter literals share that
    # syntax — so we deliberately don't grep for it; the
    # ``imports_no_state_mutator_symbols`` test covers the import-path
    # angle and ``pack_writers_check_for_existing_records`` pins the
    # create-not-mutate contract end-to-end.
    import re as _re

    hits: dict[str, dict[str, list[int]]] = {}
    for path in _ONBOARDING_FILES:
        source = _read(path)
        per_file: dict[str, list[int]] = {}
        for field in STATE_FIELDS:
            json_pattern = _re.compile(r'"' + _re.escape(field) + r'"\s*:')
            line_numbers = [
                source.count("\n", 0, m.start()) + 1
                for m in json_pattern.finditer(source)
            ]
            if line_numbers:
                per_file[field] = sorted(set(line_numbers))
        if per_file:
            hits[path.name] = per_file
    assert not hits, (
        f"onboarding pipeline writes state field(s) in JSON body shape: "
        f"{hits!r} — if this is a deliberate retrofit, route through "
        f"state_mutator.apply_state_change_v2 with source='onboarding' "
        f"and update this regression."
    )


def test_onboarding_imports_no_state_mutator_symbols() -> None:
    """No retrofit shipped — onboarding pipeline doesn't import state_mutator.

    If this flips, the matching retrofit MUST also:
      * Register an ``@propose_fn("onboarding.<step>")`` callable.
      * Gate any new workflow-side activity call with
        ``workflow.patched("onboarding_state_mutator_v1")``.
      * Update this regression to assert the new shape.
    """
    for path in _ONBOARDING_FILES:
        source = _read(path)
        assert "from src.activities.state_mutator" not in source, (
            f"{path.name} imports state_mutator — if you're shipping a "
            f"W12 retrofit, update this regression."
        )
        assert "apply_state_change_v2" not in source, (
            f"{path.name} references apply_state_change_v2 — if you're "
            f"shipping a W12 retrofit, update this regression."
        )


def test_onboarding_pack_writers_check_for_existing_records() -> None:
    """matter_pack + errand_pack generators must dedup before write.

    The W12 audit conclusion (creation ≠ mutation) hinges on the pack
    writers SKIPPING existing records rather than overwriting them. If
    this invariant breaks, an onboarding re-run would silently rewrite a
    matter record's body — which IS a mutation, even though it lands via
    ``write_record``. Pin the dedup behaviour so the audit conclusion
    stays valid.
    """
    packs = _ROOT / "activities" / "packs.py"
    packs_opus = _ROOT / "activities" / "packs_opus.py"
    for path in (packs, packs_opus):
        source = _read(path)
        # Both files use ``client.search_records(slug, record_type="matter")``
        # / ``record_type="task"`` and skip-on-existing. Pin the search +
        # skip shape.
        assert "search_records" in source, (
            f"{path.name} dropped search_records-based dedup — onboarding "
            f"pack writers MUST skip existing matter/task records to "
            f"preserve the 'creation only, no mutation' contract."
        )
        assert "skipped_existing" in source, (
            f"{path.name} dropped skipped_existing accounting — onboarding "
            f"pack writers MUST skip existing matter/task records."
        )
