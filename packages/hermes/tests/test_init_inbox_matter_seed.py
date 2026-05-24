"""Static-text pin: init seeds `matter/inbox.md` on first boot
(sir-fresh-deploy #1).

WHY THIS GUARD EXISTS
---------------------
`packs_opus._resolve_parent_matter_path()` falls back to `matter/inbox.md`
when an Opus-emitted `related_matter` field is empty or fails to slugify
into a known matter. The same path is hard-coded as the canonical orphan
home in `task_creation.DEFAULT_PARENT_MATTER` and is read by the matters
aggregator on `/matters`.

On Sir's tenant (2026-05-24), a fresh deploy produced 33 orphan tasks
whose `parent_matter` pointed at `matter/inbox.md` — but nothing in the
init stack actually created that file. The matters aggregator couldn't
resolve the parent and the orphans never surfaced; they had to be
manually relinked. The comment at `packs_opus.py:101` said "ctrl-api's
task seed scaffolds inbox.md if missing" — that was aspirational, not
implemented.

The init container is the right home: it runs once on first boot, it
already scaffolds `/vault` content (intuition index, dir tree), and it
re-runs idempotently on container recreation.

The frontmatter schema MUST match `_build_inbox_content()` in
`packages/learn/scripts/migrate_inbox_matter.py` so the one-shot
migration script (used to back-fill existing tenants) and this seed
agree on the record shape.

Idempotency: only write when the file is absent. A hand-edited
inbox.md by the principal must be preserved untouched.
"""
from pathlib import Path

HERMES = Path(__file__).resolve().parent.parent
ENTRYPOINT = HERMES / "init" / "entrypoint.sh"


def test_entrypoint_creates_inbox_matter_dir():
    """init MUST `mkdir -p /vault/matter` so the inbox seed has a home."""
    src = ENTRYPOINT.read_text()
    assert "mkdir -p /vault/matter" in src, (
        "entrypoint.sh must `mkdir -p /vault/matter` before seeding "
        "inbox.md — matter/ is not in the existing ENTITY_DIRS list."
    )


def test_entrypoint_seeds_inbox_matter_when_missing():
    """init MUST seed `matter/inbox.md` if absent."""
    src = ENTRYPOINT.read_text()
    assert "[[ ! -f /vault/matter/inbox.md ]]" in src, (
        "entrypoint.sh must guard the inbox seed with "
        "`[[ ! -f /vault/matter/inbox.md ]]` so existing hand-edited "
        "inboxes are preserved."
    )
    assert "Seeding matter/inbox.md" in src, (
        "entrypoint.sh must log when it seeds the inbox matter."
    )


def test_inbox_matter_schema_matches_migration_script():
    """The seed frontmatter MUST match the Steward Phase 0 schema used in
    `packages/learn/scripts/migrate_inbox_matter.py::_build_inbox_content`
    — if these drift, the migration script and the fresh-deploy seed
    produce different inbox records, and the next Steward sweep will
    rewrite one to match the other (churn + lost edits)."""
    src = ENTRYPOINT.read_text()
    # The exact lines `_build_inbox_content` emits, byte-equivalent (modulo
    # the dynamic timestamp). These are pinned by the migration script's
    # test suite; we mirror them here.
    required_lines = [
        "type: matter",
        'name: "Inbox"',
        "status: active",
        "state: open",
        "surface_class: none",
        'description: "Steward home for orphan tasks."',
        "last_steward_check_at:",
        "last_steward_outcome:",
        "signal_sources: []",
        "pending_confirmation: false",
        "blocked_on:",
        "staleness_score: 0",
    ]
    for line in required_lines:
        assert line in src, (
            f"inbox.md seed frontmatter is missing `{line}` — must match "
            f"the schema in migrate_inbox_matter.py::_build_inbox_content "
            f"so a fresh-deploy seed and the migration script produce "
            f"equivalent records."
        )


def test_inbox_seed_idempotent_on_existing_file():
    """The seed MUST log a 'preserving' branch when inbox.md already
    exists, so a re-run of init never clobbers principal edits."""
    src = ENTRYPOINT.read_text()
    assert "matter/inbox.md already present" in src, (
        "entrypoint.sh must take an else branch when inbox.md exists, "
        "logging that it's preserved untouched — protects principal edits "
        "across container recreation."
    )


def test_inbox_seed_runs_before_chown():
    """The mkdir + seed must happen BEFORE the final
    `chown -R 10000:10000 /vault` step, so the seeded file gets the
    same hermes-runtime ownership as the rest of the vault tree."""
    src = ENTRYPOINT.read_text()
    seed_idx = src.find("Seeding matter/inbox.md")
    chown_idx = src.find("chown -R 10000:10000 /vault")
    assert seed_idx > 0, "inbox seed block not found"
    assert chown_idx > 0, "vault chown step not found"
    assert seed_idx < chown_idx, (
        "inbox.md seed must run before the recursive `chown -R 10000:10000 "
        "/vault` step so the file lands with hermes ownership."
    )
