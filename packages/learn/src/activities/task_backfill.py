"""Sir-matter-task #2 — one-shot backfill of orphan task→matter linkage.

Symptom on the live tenant (2026-05-24): 32 tasks written by the
pre-Fix-A onboarding pipeline carry only a freeform ``related_matter``
string and no ``parent_matter`` / ``matter_ref``. The matters
aggregator (ctrl/src/api/routes/matters.ts) reads ``parent_matter`` for
task→matter linkage, so every ``/matters/:id.tasks`` returns ``[]``.

Fix A patches the WRITER — every new onboarding task lands with the
rich shape. This module patches the READER side of the existing 32
tasks via a one-shot backfill:

  1. List all task records (``GET /api/v1/vault/list/task``).
  2. For each task missing ``parent_matter``/``matter_ref``/``matter``:
     - If ``related_matter`` (freeform Opus string) fuzzy-matches an
       existing matter's ``name`` by Jaccard token overlap ≥ 0.5,
       patch ``parent_matter: matter/<slug>.md`` + ``matter_ref`` +
       ``state: pending`` + ``status: queued``.
     - Else fall back to ``matter/inbox.md`` (the canonical orphan home)
       and increment ``unmatched`` so the orchestrator sees what was
       indeterminate.
  3. Tasks already linked are skipped (idempotent re-run).
  4. Returns ``{total, linked, unmatched, errors}`` for the
     orchestrator's deploy-verification.

No Temporal workflow wrapper is needed — the orchestrator invokes this
as ``python -c "import asyncio; from src.activities.task_backfill
import backfill_orphan_task_matter_refs; print(asyncio.run(
backfill_orphan_task_matter_refs()))"`` from inside the
``alfred-black-alfred-learn-1`` container.

Hard rules (mirrors the alfred-learn contract):
  * All vault writes go through ``VaultClient.patch_frontmatter`` —
    NEVER direct filesystem writes.
  * Lazy imports for httpx etc. inside the body so Temporal's
    workflow sandbox doesn't see them at module import (this module
    is also registered as a Temporal activity for orchestration
    flexibility).
"""
from __future__ import annotations

import logging
import re
from typing import Any

from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Sir-matter-task #2: matches the inbox fallback used by Fix A
# (packs_opus._INBOX_MATTER_PATH) and ``task_creation.DEFAULT_PARENT_MATTER``.
# Keep all three in sync.
INBOX_MATTER_PATH = "matter/inbox.md"

# Jaccard token-overlap threshold for fuzzy matching a freeform
# ``related_matter`` string against an existing matter's ``name``.
# ≥0.5 catches the realistic Opus paraphrasing drift ("Pat collaboration
# update" vs "Pat collaboration") without claiming spurious matches.
JACCARD_THRESHOLD = 0.5


# ---------------------------------------------------------------------------
# Tokeniser (Jaccard-friendly, matches packs_opus._matter_name_tokens)
# ---------------------------------------------------------------------------


def _name_tokens(name: str) -> set[str]:
    """Lowercase, strip punctuation, return a token set.

    Mirrors ``packs_opus._matter_name_tokens`` so backfill and onboarding
    agree on what "the same matter" means.
    """
    if not name:
        return set()
    cleaned = re.sub(r"[^\w\s]+", " ", name.casefold(), flags=re.UNICODE)
    return {t for t in cleaned.split() if t}


def _jaccard(a: set[str], b: set[str]) -> float:
    """Standard Jaccard index. Returns 0.0 for empty inputs."""
    if not a or not b:
        return 0.0
    inter = a & b
    union = a | b
    if not union:
        return 0.0
    return len(inter) / len(union)


# ---------------------------------------------------------------------------
# Matter index
# ---------------------------------------------------------------------------


def _resolve_matter_path(
    related_matter: str,
    matter_index: list[tuple[str, set[str]]],
) -> str | None:
    """Resolve a freeform ``related_matter`` string to a matter path via
    fuzzy Jaccard match.

    Returns the best matter path (``matter/<slug>.md``) above
    ``JACCARD_THRESHOLD``, or ``None`` if no candidate clears the bar.
    """
    if not related_matter or not related_matter.strip():
        return None
    cand_tokens = _name_tokens(related_matter)
    if not cand_tokens:
        return None
    best_path: str | None = None
    best_score: float = 0.0
    for path, tokens in matter_index:
        score = _jaccard(cand_tokens, tokens)
        if score > best_score:
            best_score = score
            best_path = path
    if best_score < JACCARD_THRESHOLD:
        return None
    return best_path


def _build_matter_index(
    matter_records: list[dict[str, Any]],
) -> list[tuple[str, set[str]]]:
    """Build ``[(path, name_tokens), ...]`` from a vault matter listing.

    Tolerates the two record shapes ctrl-api returns: top-level ``name``
    and ``path`` keys (current) and nested ``frontmatter.name`` (older
    callers + the test fakes).
    """
    out: list[tuple[str, set[str]]] = []
    for rec in matter_records or []:
        if not isinstance(rec, dict):
            continue
        path = rec.get("path") or ""
        if not isinstance(path, str) or not path.startswith("matter/"):
            # Defensive — if path is missing, derive it from slug.
            slug = rec.get("slug") or ""
            if isinstance(slug, str) and slug:
                path = f"matter/{slug}.md"
            else:
                continue
        name = rec.get("name")
        if not isinstance(name, str) or not name.strip():
            fm = rec.get("frontmatter")
            if isinstance(fm, dict):
                name = fm.get("name") or fm.get("title")
        if not isinstance(name, str) or not name.strip():
            continue
        out.append((path, _name_tokens(name)))
    return out


# ---------------------------------------------------------------------------
# Per-task triage
# ---------------------------------------------------------------------------


def _task_already_linked(fm: dict[str, Any]) -> bool:
    """True iff the task already carries a parent-matter linkage in
    any of the three frontmatter keys the matters aggregator reads.
    """
    for k in ("parent_matter", "matter_ref", "matter", "project"):
        v = fm.get(k)
        if isinstance(v, str) and v.strip():
            return True
    return False


# ---------------------------------------------------------------------------
# Backfill activity
# ---------------------------------------------------------------------------


@activity.defn
async def backfill_orphan_task_matter_refs() -> dict[str, int]:
    """Patch every orphan task with parent_matter + matter_ref linkage.

    Returns ``{"total": N, "linked": M, "unmatched": K, "errors": E}``.
      * ``total`` — how many task records we walked.
      * ``linked`` — how many patches we issued (matched OR inbox-fallback).
      * ``unmatched`` — how many of those landed in inbox.md (no fuzzy
        match found OR no freeform related_matter to match against).
      * ``errors`` — how many patch attempts raised (non-fatal; we keep
        going).
    """
    config = load_config()
    client = VaultClient(config)
    total = 0
    linked = 0
    unmatched = 0
    errors = 0
    try:
        try:
            tasks = await client.list_records("task", limit=10_000)
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "task_backfill: list_records('task') failed: %s",
                exc,
            )
            return {"total": 0, "linked": 0, "unmatched": 0, "errors": 1}

        try:
            matter_records = await client.list_records("matter", limit=10_000)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "task_backfill: list_records('matter') failed: %s — "
                "all unlinked tasks will fall back to inbox",
                exc,
            )
            matter_records = []

        matter_index = _build_matter_index(matter_records)
        logger.info(
            "task_backfill: walking %d tasks against %d matters",
            len(tasks), len(matter_index),
        )

        for task in tasks:
            total += 1
            fm = task.get("frontmatter") if isinstance(task, dict) else None
            if not isinstance(fm, dict):
                # The list endpoint MAY return top-level scalar keys
                # only; fall back to those.
                fm = task if isinstance(task, dict) else {}

            if _task_already_linked(fm):
                # Idempotent: already-linked tasks are no-ops.
                continue

            path = task.get("path") or ""
            if not isinstance(path, str) or not path:
                slug = task.get("slug") or ""
                if isinstance(slug, str) and slug:
                    path = f"task/{slug}.md"
            if not path:
                logger.warning(
                    "task_backfill: task missing path/slug — skipping (%r)",
                    task,
                )
                continue

            related_matter = ""
            rm = fm.get("related_matter")
            if isinstance(rm, str):
                related_matter = rm.strip()

            resolved = _resolve_matter_path(related_matter, matter_index)
            if resolved is None:
                # Inbox fallback. ``unmatched`` counts the freeform-but-
                # no-match case — actionable signal for the orchestrator
                # to surface ("3 tasks had related_matter strings that
                # didn't resolve; consider creating those matters").
                # Tasks with no freeform at all are the steady state for
                # untyped onboarding output and don't surface there.
                target_matter = INBOX_MATTER_PATH
                if related_matter:
                    unmatched += 1
            else:
                target_matter = resolved

            updates: dict[str, Any] = {
                "parent_matter": target_matter,
                "matter_ref": target_matter,
                "state": "pending",
                # alfred-vault validator vocab is active|blocked|cancelled|done|todo
                # — 'queued' is rejected with HTTP 500. The stale comment in
                # tasks.py:23 that says 'status=queued' is wrong. Use 'todo'
                # (canonical 'not yet started'); TaskRunner filter is updated
                # to match. See sir-matter-task round-2 incident 2026-05-24.
                "status": "todo",
            }
            try:
                await client.patch_frontmatter(path, updates)
                linked += 1
                logger.info(
                    "task_backfill: linked %s -> %s%s",
                    path, target_matter,
                    " (inbox fallback)" if target_matter == INBOX_MATTER_PATH else "",
                )
            except Exception as exc:  # noqa: BLE001
                errors += 1
                logger.warning(
                    "task_backfill: patch_frontmatter(%s) failed: %s",
                    path, exc,
                )
        return {
            "total": total,
            "linked": linked,
            "unmatched": unmatched,
            "errors": errors,
        }
    finally:
        await client.close()
