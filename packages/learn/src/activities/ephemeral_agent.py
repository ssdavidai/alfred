"""Ephemeral subagent lifecycle — Hermes-native (Phase 2, #22).

Before Hermes, dispatching a per-task executor was a distributed
dance: create an agent entry → mutate the workers ``openclaw.json`` →
wait for the gateway to hot-reload → spawn against it → delete the
entry. ``ephemeral_agent.py`` drove that dance over ctrl-api.

Under Hermes an ephemeral executor is just **one ``POST /v1/runs``**
against the workers profile with ``session_id = exec-<hash>`` and the
per-task scope expressed in the run's ``instructions``/prompt. There
is no config to mutate, nothing to hot-reload, and no entry to clean
up — Hermes' SQLite SessionStore owns the run's lifecycle.

So this module collapses to:

  * ``create_ephemeral_agent`` — returns a synthetic ``exec-<hash>``
    id. NO HTTP call, NO config mutation. The id is purely a
    ``session_id`` label for the subsequent ``_call_clerk`` run.
  * ``delete_ephemeral_agent`` — a no-op stub. Kept for ONE release so
    any Temporal workflow whose history still records this activity
    can replay deterministically (removing a registered activity
    mid-history breaks replay). Safe to delete in a later deploy once
    no in-flight workflow references it.
  * ``wait_for_agent_ready`` — DELETED. There is no hot-reload to wait
    on; a Hermes run is accepted immediately by ``POST /v1/runs``.

The actual dispatch happens in ``signal_actions.dispatch_action_to_agent``
via ``clerk._call_clerk(prompt, raw=True, agent_id="exec-...")`` —
``_call_clerk`` is the single Hermes ``/v1/runs`` entry point.
"""
from __future__ import annotations

import logging

from temporalio import activity

logger = logging.getLogger("ephemeral-agent")


def _agent_id_for_task(task_id: str) -> str:
    """exec-<short-hash>. Sanitised to ``[a-zA-Z0-9_-]+`` so the id is a
    safe Hermes ``session_id``."""
    cleaned = "".join(c for c in task_id if c.isalnum() or c in "-_")
    return f"exec-{cleaned[:24] or 'unknown'}"


@activity.defn
async def create_ephemeral_agent(
    task_id: str,
    tools_required: list[str] | None = None,
    model: str = "",
) -> str:
    """Return a synthetic ephemeral-executor id — purely a label.

    Phase 2 (#22): there is no longer any agent *entry* to create.
    A Hermes ephemeral executor is one ``POST /v1/runs`` whose
    ``session_id`` is this id; per-task scope lives in the run's
    prompt, not in a config-file allowlist.

    ``tools_required`` and ``model`` are accepted for backwards-compat
    with existing callers and intentionally ignored — the workers
    profile already exposes the full tool surface, and the model is
    fixed by the profile config.
    """
    del tools_required, model  # accepted for compat, intentionally unused
    agent_id = _agent_id_for_task(task_id)
    logger.info(
        "ephemeral_agent.create_ephemeral_agent: synthetic id %s "
        "(no config mutation — Hermes run session_id)",
        agent_id,
    )
    return agent_id


@activity.defn
async def delete_ephemeral_agent(agent_id: str) -> bool:
    """No-op stub — kept ONE release for Temporal replay safety (#22).

    There is nothing to delete: a Hermes run cleans up after itself via
    the SQLite SessionStore. This stub exists only so workflows whose
    history still records a ``delete_ephemeral_agent`` activity replay
    deterministically. Remove in a later deploy once no in-flight
    workflow references it.
    """
    logger.debug(
        "ephemeral_agent.delete_ephemeral_agent: no-op stub for %s "
        "(Hermes runs self-clean; activity kept for replay safety)",
        agent_id,
    )
    return True
