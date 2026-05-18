"""SM-D-W5 — archival sweep state-mutator v2 propose function.

The cold-task archival sweep lives as a standalone asyncio script at
``packages/learn/scripts/cold_task_archival.py`` (no Temporal workflow,
no schedule). Under the universal state-mutation contract every
``status=archived`` flip is a state writer; this module provides the
deterministic propose function that the script invokes (via
``apply_state_change_v2``) to land a ``state_change`` audit + timeline
entry on the cold task being archived.

Why a module — and not a few lines folded into the script — even though
there's no workflow? Because the propose-fn registry lives in
``state_mutator.py`` and is keyed by stable dotted-identifier names
(``archival_sweep.cold``). Future callers (the planned
``ArchivalSweepWorkflow`` from spec §7, manual archive-button taps in
the SaaS frontend, a CLI subcommand) all dispatch the same propose
function by name. Co-locating it next to the script that drives it
today, but importable from anywhere, keeps the contract clean.

Per ``docs/STATE-MUTATION.md`` §7 W5:

    | W5 | Archival sweep | (TASK-LIFECYCLE-1) workflow | Sets
    |    | status=archived directly | v2; source=`archival_sweep` |

The propose function is purely deterministic — no clerk call — and
returns ``confidence=1.0`` because the script has already classified
the task as cold before invoking the mutator. The propose function's
sole job is to translate "this task should be archived" into a
``ProposedMutation`` envelope the universal mutator can write.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from src.activities.state_mutator import (
    ObservedWindow,
    ProposedMutation,
    propose_fn,
)


logger = logging.getLogger("alfred-learn")


# Terminal status labels the propose function should treat as "already
# archived" — re-running the sweep over an already-archived task must
# NOT land a duplicate audit. Includes both the canonical ``archived``
# and the synonyms used by the legacy lifecycle/plane mirror.
_TERMINAL_ARCHIVED_STATUS: frozenset[str] = frozenset({
    "archived",
    "cancelled",
    "canceled",
})


def _current_status(target: dict[str, Any]) -> Optional[str]:
    """Lift the target's current ``status`` from the ``read_target`` snapshot.

    ``read_target`` returns ``{frontmatter, body, as_of}``; we want the
    frontmatter's ``status`` field. Missing → ``None`` (the cold-task
    population includes records authored before lifecycle status
    landed, and the script archives them anyway).
    """
    fm = target.get("frontmatter") if isinstance(target, dict) else None
    if not isinstance(fm, dict):
        return None
    raw = fm.get("status")
    if raw is None:
        return None
    return str(raw).strip().lower() or None


@propose_fn("archival_sweep.cold")
async def propose_archival_sweep_cold(
    *,
    target: dict[str, Any],
    observed: ObservedWindow,
    args: dict[str, Any],
) -> ProposedMutation | None:
    """Deterministic propose function for the cold-task archival sweep.

    Contract:
      * ``target`` — the matter/task snapshot from ``read_target``
        (frontmatter + body + lifted ``as_of``).
      * ``observed`` — the writer's reasoning window. For the cold
        sweep we don't have signals or decisions to cite (the
        classification is purely time-based) so the window is supplied
        empty by the caller; the propose function does not consult it.
      * ``args`` — caller-supplied context. The cold-task script passes
        ``{"reason": <archived_reason>, "prior_status": ..., "prior_state": ...}``
        where ``reason`` is the same provenance string written into the
        ``archived_reason`` frontmatter field by the legacy PATCH.

    Returns ``ProposedMutation`` with ``fields={"status": "archived"}``
    and ``confidence=1.0`` when the target is not already terminal.
    Returns ``None`` (no v2 round-trip) when the target's ``status`` is
    already ``archived`` / ``cancelled`` — preserves the script's
    idempotency.
    """
    current_status = _current_status(target)
    if current_status in _TERMINAL_ARCHIVED_STATUS:
        logger.debug(
            "archival_sweep.cold: target already terminal status=%s — no mutation",
            current_status,
        )
        return None

    reason_arg = args.get("reason") if isinstance(args, dict) else None
    reason_str = (
        str(reason_arg).strip() if isinstance(reason_arg, str) and reason_arg
        else "cold_inactive"
    )
    return ProposedMutation(
        fields={"status": "archived"},
        reason=(
            f"Cold-task archival sweep — task inactive past "
            f"threshold ({reason_str})."
        ),
        confidence=1.0,
        fan_out=(),
    )


__all__ = ["propose_archival_sweep_cold"]
