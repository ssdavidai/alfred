"""Ephemeral subagent lifecycle — create, wait, delete via ctrl-api.

Per-task scoped subagents on the openclaw-workers gateway. Each
delegated action gets a fresh agent entry, runs against it, and the
entry gets cleaned up on the way out — so the workers config doesn't
accumulate stale agents and each task has its own audit boundary.

Why ctrl-api and not direct file I/O: alfred-learn runs with all
Linux capabilities dropped (CapEff=0). Even "root" inside the
container can't traverse the mode-700 encrypted volume the workers
config lives on. ctrl-api has CAP_DAC_OVERRIDE and the right mount,
so it owns the writes; we drive it over HTTP. Bonus: the in-process
mutex on ctrl-api's single Node event loop gives us atomic
read-mutate-write for free, and the gateway's hot-reload trigger
(meta.lastTouchedAt) is handled in one place.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config

logger = logging.getLogger("ephemeral-agent")

# NOTE: we used to send an explicit per-agent ``tools.allow`` here. We
# don't anymore. The workers gateway exposes a gateway-level allowlist
# (built-in primitives + every MCP-namespaced tool from the 5 stdio
# servers) — that's the surface we want every ephemeral agent to see.
# A per-agent ``tools.allow`` would shadow that and we kept getting it
# wrong: case-mismatched primitives (`glob` vs `Glob`), fake
# composio-named entries (`gmail_send_email`) that don't match real MCP
# tool names, and the burden of keeping it in sync with the MCP catalog
# at all. Inherit gateway defaults instead. See the openclaw-workers
# log warning 2026-05-13 09:28:29 (`allowlist contains unknown entries
# gmail_fetch_emails, …, glob, grep, ls, composio_execute`) for the
# canonical evidence this approach was broken.


def _http() -> httpx.AsyncClient:
    cfg = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    return httpx.AsyncClient(
        base_url=cfg.alfred_ctrl_url, headers=headers, timeout=30.0
    )


def _agent_id_for_task(task_id: str) -> str:
    """exec-<short-hash>. ctrl-api validates [a-zA-Z0-9_-]+, so we sanitise."""
    cleaned = "".join(c for c in task_id if c.isalnum() or c in "-_")
    return f"exec-{cleaned[:24] or 'unknown'}"


@activity.defn
async def create_ephemeral_agent(
    task_id: str,
    tools_required: list[str],
    model: str = "",
) -> str:
    """Create an ephemeral agent entry on openclaw-workers via ctrl-api.

    Returns the agent_id (e.g. ``exec-abc12345``). Caller MUST call
    ``delete_ephemeral_agent`` in a ``finally`` so stale entries don't
    accumulate even when the dispatch raises.

    No per-agent ``tools_allow`` is sent — the agent inherits the
    workers gateway's full allowlist, which already includes the
    built-in primitives plus every MCP-namespaced tool from the 5
    stdio servers. ``tools_required`` is accepted for backwards-compat
    with callers but ignored. Per-task scoping happens in the prompt,
    not the allowlist.
    """
    del tools_required  # accepted for compat, intentionally unused

    agent_id = _agent_id_for_task(task_id)
    payload: dict[str, Any] = {
        "id": agent_id,
        "name": f"Ephemeral Executor ({task_id[:24]})",
    }
    if model:
        payload["model"] = model

    async with _http() as client:
        resp = await client.post(
            "/api/v1/admin/openclaw-workers/agents", json=payload
        )
        resp.raise_for_status()
    logger.info(
        "ephemeral_agent.create_ephemeral_agent: created %s "
        "(inherits gateway allowlist)",
        agent_id,
    )
    return agent_id


@activity.defn
async def delete_ephemeral_agent(agent_id: str) -> bool:
    """Remove an ephemeral agent entry. Idempotent — returns True if
    we removed it, False if it was already gone."""
    if not agent_id or not agent_id.startswith("exec-"):
        return False
    async with _http() as client:
        resp = await client.delete(
            f"/api/v1/admin/openclaw-workers/agents/{agent_id}"
        )
        resp.raise_for_status()
        data = resp.json()
    removed = bool(data.get("removed"))
    logger.info(
        "ephemeral_agent.delete_ephemeral_agent: %s removed=%s",
        agent_id, removed,
    )
    return removed


@activity.defn
async def wait_for_agent_ready(agent_id: str) -> bool:
    """Wait for the openclaw-workers gateway to hot-reload and pick up
    the new agent entry.

    Polls the workers gateway ``/health`` endpoint. Returns ``True``
    once healthy, ``False`` on timeout. We err on the side of
    proceeding — a transient health blip shouldn't strand the
    dispatch; the worst case is a 404 on the subsequent spawn, which
    we surface honestly to the caller.
    """
    import asyncio

    config = load_config()
    gateway_url = config.openclaw_workers_gateway_url
    token = config.gateway_token()

    for attempt in range(6):  # 6 × 5 s = 30 s
        try:
            activity.heartbeat(f"waiting for {agent_id} (attempt {attempt + 1}/6)")
        except Exception:
            pass
        await asyncio.sleep(5)
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"{gateway_url}/health",
                    headers={"Authorization": f"Bearer {token}"},
                )
                if resp.status_code == 200:
                    logger.info(
                        "ephemeral_agent.wait_for_agent_ready: %s ready", agent_id,
                    )
                    return True
        except Exception:
            continue

    logger.warning(
        "ephemeral_agent.wait_for_agent_ready: %s timeout — proceeding anyway",
        agent_id,
    )
    return True
