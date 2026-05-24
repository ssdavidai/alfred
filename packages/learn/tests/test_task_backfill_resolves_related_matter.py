"""Sir-matter-task #2 — backfill orphan tasks' matter linkage.

Symptom on the live tenant (2026-05-24): 32 tasks from the pre-Fix-A
onboarding runs sit on disk with empty / missing ``parent_matter`` and
``matter_ref``. The rich-shape writer (Fix A) handles all NEW tasks
going forward — these existing ones need a one-shot backfill.

This module ships ``backfill_orphan_task_matter_refs()`` as a Temporal
activity AND a callable from a ``python -c`` one-shot (the orchestrator
invokes it inside the alfred-learn container after deploy).

Behaviour pinned here:

  a. A task whose ``related_matter`` (freeform Opus string) fuzzy-matches
     an existing matter's ``name`` frontmatter (Jaccard token overlap
     ≥ 0.5) is patched with ``parent_matter`` + ``matter_ref`` +
     ``state: pending`` + ``status: todo``.

  b. A task with NO ``related_matter`` (or no fuzzy match) is stamped
     with the inbox fallback ``matter/inbox.md`` (Sir's chosen default).

  c. A task that ALREADY has ``parent_matter`` is left alone (idempotent
     re-run is a no-op for already-linked tasks).

  d. The activity returns counts: ``{total, linked, unmatched, errors}``.
"""
from __future__ import annotations

from typing import Any

import pytest


# ---------------------------------------------------------------------------
# Fake VaultClient — just enough to drive the backfill
# ---------------------------------------------------------------------------


class _FakeVaultClient:
    """Minimal VaultClient stub.

    The backfill activity reads:
      * ``list_records("task", limit=...)``
      * ``list_records("matter", limit=...)``
      * ``read_record(path)`` — only for the rare missing-frontmatter case
      * ``patch_frontmatter(path, updates)``
    Everything is in-memory + recorded so the test can assert on it.
    """

    def __init__(
        self,
        tasks: list[dict[str, Any]],
        matters: list[dict[str, Any]],
    ) -> None:
        self._tasks = tasks
        self._matters = matters
        self.patches: list[tuple[str, dict[str, Any]]] = []

    async def list_records(
        self,
        record_type: str,
        status: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        if record_type == "task":
            return list(self._tasks)
        if record_type == "matter":
            return list(self._matters)
        return []

    async def read_record(self, path: str) -> dict[str, Any]:
        for t in self._tasks:
            if t.get("path") == path:
                return {"frontmatter": t.get("frontmatter", {})}
        raise KeyError(path)

    async def patch_frontmatter(
        self, path: str, updates: dict[str, Any]
    ) -> None:
        self.patches.append((path, dict(updates)))

    async def close(self) -> None:
        pass


@pytest.fixture
def vault_factory(monkeypatch: pytest.MonkeyPatch):
    """Factory returning a context-managed fake vault client.

    Patches ``src.activities.task_backfill.VaultClient`` so the activity
    picks up the fake regardless of which ``VaultClient`` import path
    it uses internally.
    """
    def _make(tasks: list[dict[str, Any]], matters: list[dict[str, Any]]):
        fake = _FakeVaultClient(tasks, matters)
        import src.activities.task_backfill as tb

        monkeypatch.setattr(tb, "VaultClient", lambda cfg: fake)
        # Defang load_config — we don't need a real one.
        monkeypatch.setattr(tb, "load_config", lambda: None)
        return fake

    return _make


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_task_with_matching_related_matter_gets_linked(vault_factory):
    """A task whose ``related_matter`` text matches a matter's ``name``
    by ≥0.5 Jaccard gets patched with parent_matter + matter_ref."""
    tasks = [
        {
            "path": "task/verify-stripe-webhook.md",
            "slug": "verify-stripe-webhook",
            "frontmatter": {
                "type": "task",
                "status": "todo",
                "related_matter": "Stripe billing migration",
            },
        }
    ]
    matters = [
        {
            "path": "matter/stripe-billing-migration.md",
            "slug": "stripe-billing-migration",
            "name": "Stripe billing migration",
            "frontmatter": {"name": "Stripe billing migration"},
        }
    ]
    vc = vault_factory(tasks, matters)

    from src.activities.task_backfill import backfill_orphan_task_matter_refs

    result = await backfill_orphan_task_matter_refs()

    assert result["total"] == 1
    assert result["linked"] == 1
    assert result["unmatched"] == 0
    assert result["errors"] == 0

    assert len(vc.patches) == 1
    path, updates = vc.patches[0]
    assert path == "task/verify-stripe-webhook.md"
    assert updates.get("parent_matter") == "matter/stripe-billing-migration.md"
    assert updates.get("matter_ref") == "matter/stripe-billing-migration.md"
    assert updates.get("state") == "pending"
    assert updates.get("status") == "todo"


async def test_task_with_no_related_matter_gets_inbox_fallback(vault_factory):
    """No ``related_matter`` → stamp with ``matter/inbox.md``."""
    tasks = [
        {
            "path": "task/random-orphan.md",
            "slug": "random-orphan",
            "frontmatter": {
                "type": "task",
                "status": "todo",
            },
        }
    ]
    matters: list[dict[str, Any]] = []
    vc = vault_factory(tasks, matters)

    from src.activities.task_backfill import backfill_orphan_task_matter_refs

    result = await backfill_orphan_task_matter_refs()

    assert result["total"] == 1
    assert result["linked"] == 1
    assert result["unmatched"] == 0

    assert len(vc.patches) == 1
    path, updates = vc.patches[0]
    assert updates.get("parent_matter") == "matter/inbox.md"
    assert updates.get("matter_ref") == "matter/inbox.md"


async def test_task_with_unmatchable_related_matter_falls_to_inbox(
    vault_factory,
):
    """A freeform ``related_matter`` that doesn't fuzzy-match anything
    on disk still gets the inbox fallback (so no task is left orphan)."""
    tasks = [
        {
            "path": "task/foo.md",
            "slug": "foo",
            "frontmatter": {
                "type": "task",
                "related_matter": "Some thing that was never bootstrapped",
            },
        }
    ]
    matters = [
        {
            "path": "matter/stripe-billing-migration.md",
            "slug": "stripe-billing-migration",
            "name": "Stripe billing migration",
            "frontmatter": {"name": "Stripe billing migration"},
        }
    ]
    vc = vault_factory(tasks, matters)

    from src.activities.task_backfill import backfill_orphan_task_matter_refs

    result = await backfill_orphan_task_matter_refs()

    # Inbox-fallback counts as ``linked`` (we did patch the task); the
    # separate ``unmatched`` counter records the lack of a non-inbox
    # resolution so the orchestrator can report it.
    assert result["total"] == 1
    assert result["linked"] == 1
    assert result["unmatched"] == 1
    assert len(vc.patches) == 1
    _, updates = vc.patches[0]
    assert updates.get("parent_matter") == "matter/inbox.md"


async def test_task_already_linked_is_skipped(vault_factory):
    """Idempotent: a task with ``parent_matter`` already set is left alone."""
    tasks = [
        {
            "path": "task/already-linked.md",
            "slug": "already-linked",
            "frontmatter": {
                "type": "task",
                "status": "todo",
                "parent_matter": "matter/foo.md",
                "matter_ref": "matter/foo.md",
            },
        }
    ]
    matters: list[dict[str, Any]] = []
    vc = vault_factory(tasks, matters)

    from src.activities.task_backfill import backfill_orphan_task_matter_refs

    result = await backfill_orphan_task_matter_refs()

    assert result["total"] == 1
    assert result["linked"] == 0  # nothing newly linked
    assert result["unmatched"] == 0
    assert len(vc.patches) == 0


async def test_jaccard_fuzzy_match_at_threshold(vault_factory):
    """Slightly drifted freeform string still matches at ≥0.5 overlap.

    "Pat collaboration update" vs matter named "Pat collaboration" —
    token overlap = 2/3 = 0.66 ≥ 0.5 → match.
    """
    tasks = [
        {
            "path": "task/check-in-with-pat.md",
            "slug": "check-in-with-pat",
            "frontmatter": {
                "type": "task",
                "related_matter": "Pat collaboration update",
            },
        }
    ]
    matters = [
        {
            "path": "matter/pat-collaboration.md",
            "slug": "pat-collaboration",
            "name": "Pat collaboration",
            "frontmatter": {"name": "Pat collaboration"},
        }
    ]
    vc = vault_factory(tasks, matters)

    from src.activities.task_backfill import backfill_orphan_task_matter_refs

    result = await backfill_orphan_task_matter_refs()
    assert result["linked"] == 1
    assert result["unmatched"] == 0
    _, updates = vc.patches[0]
    assert updates.get("parent_matter") == "matter/pat-collaboration.md"


async def test_jaccard_below_threshold_falls_to_inbox(vault_factory):
    """Token overlap below 0.5 must NOT claim a match — fall to inbox
    rather than mislinking the task."""
    tasks = [
        {
            "path": "task/random.md",
            "slug": "random",
            "frontmatter": {
                "type": "task",
                # "buy groceries" vs "Stripe billing migration": one
                # word overlap ("billing"?) → ratio < 0.5
                "related_matter": "Buy groceries",
            },
        }
    ]
    matters = [
        {
            "path": "matter/stripe-billing-migration.md",
            "slug": "stripe-billing-migration",
            "name": "Stripe billing migration",
            "frontmatter": {"name": "Stripe billing migration"},
        }
    ]
    vc = vault_factory(tasks, matters)

    from src.activities.task_backfill import backfill_orphan_task_matter_refs

    result = await backfill_orphan_task_matter_refs()
    assert result["linked"] == 1
    assert result["unmatched"] == 1
    _, updates = vc.patches[0]
    assert updates.get("parent_matter") == "matter/inbox.md"


async def test_mixed_batch_counts(vault_factory):
    """Realistic batch: 4 tasks — one matchable, one inbox-orphan, one
    unmatchable-freeform, one already linked. Counts should add up."""
    tasks = [
        {
            "path": "task/matched.md",
            "frontmatter": {
                "type": "task",
                "related_matter": "Stripe billing migration",
            },
        },
        {
            "path": "task/orphan.md",
            "frontmatter": {"type": "task"},
        },
        {
            "path": "task/unmatched.md",
            "frontmatter": {
                "type": "task",
                "related_matter": "Some random other thing",
            },
        },
        {
            "path": "task/already-linked.md",
            "frontmatter": {
                "type": "task",
                "parent_matter": "matter/foo.md",
            },
        },
    ]
    matters = [
        {
            "path": "matter/stripe-billing-migration.md",
            "name": "Stripe billing migration",
            "frontmatter": {"name": "Stripe billing migration"},
        }
    ]
    vc = vault_factory(tasks, matters)

    from src.activities.task_backfill import backfill_orphan_task_matter_refs

    result = await backfill_orphan_task_matter_refs()
    assert result["total"] == 4
    assert result["linked"] == 3
    # ``unmatched`` counts only freeform-with-no-fuzzy-match. The plain
    # orphan (no related_matter at all) lands at inbox silently — that's
    # the steady state, not a signal-worthy gap.
    assert result["unmatched"] == 1
    assert result["errors"] == 0
    # 3 patches: matched, orphan, unmatched. ``already-linked`` skipped.
    assert len(vc.patches) == 3


async def test_patch_failure_increments_errors(vault_factory):
    """A patch_frontmatter exception increments ``errors`` and does NOT
    bubble — the backfill must keep going for the remaining tasks."""
    tasks = [
        {
            "path": "task/will-fail.md",
            "frontmatter": {"type": "task"},
        },
        {
            "path": "task/will-succeed.md",
            "frontmatter": {"type": "task"},
        },
    ]
    matters: list[dict[str, Any]] = []
    vc = vault_factory(tasks, matters)

    # Make the first patch raise; the second must still go through.
    real_patch = vc.patch_frontmatter

    async def _flaky_patch(path: str, updates: dict[str, Any]) -> None:
        if path == "task/will-fail.md":
            raise RuntimeError("boom")
        await real_patch(path, updates)

    vc.patch_frontmatter = _flaky_patch  # type: ignore[method-assign]

    from src.activities.task_backfill import backfill_orphan_task_matter_refs

    result = await backfill_orphan_task_matter_refs()
    assert result["total"] == 2
    assert result["errors"] == 1
    assert result["linked"] == 1  # the succeeding patch
