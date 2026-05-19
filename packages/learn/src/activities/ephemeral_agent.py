"""Ephemeral subagent lifecycle — Hermes-native (Phase 2, #22).

Before Hermes, dispatching a per-task executor was a distributed
dance: create an agent entry → mutate the workers ``hermes.json`` →
wait for the gateway to hot-reload → spawn against it → delete the
entry. ``ephemeral_agent.py`` drove that dance over ctrl-api.

Under Hermes an ephemeral executor is just **one ``POST /v1/runs``**
against the workers profile with ``session_id = exec-<hash>`` and the
per-task scope expressed in the run's ``instructions``/prompt. There
is no config to mutate, nothing to hot-reload, and no entry to clean
up — Hermes' SQLite SessionStore owns the run's lifecycle.

So this module collapses to a single helper:

  * ``create_ephemeral_agent`` — returns a synthetic ``exec-<hash>``
    id. NO HTTP call, NO config mutation. The id is purely a
    ``session_id`` label for the subsequent ``_call_clerk`` run.

``delete_ephemeral_agent`` and ``wait_for_agent_ready`` are DELETED
(#43). Neither was ever scheduled via ``workflow.execute_activity`` —
both were only ever invoked as direct Python ``await`` calls inside
the ``signal_actions.dispatch_action_to_agent`` *activity* body. An
activity body is not replayed deterministically (only its return
value is recorded in workflow history), so no workflow replay path
ever depended on these activities and removing them is replay-safe.

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
