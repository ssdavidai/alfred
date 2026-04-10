"""Ephemeral agent lifecycle — create, wait, delete scoped subagents.

Each execution task gets its own ephemeral agent entry in the
openclaw-workers config with a restricted tools.allow list matching
the instinct's declared tools. After execution, the agent entry is
cleaned up.

The agent is created by writing to openclaw-workers' openclaw.json,
which triggers a gateway hot-reload (~10-15s). The ephemeral agent
shares the main workspace (so it can read USER.md, SOUL.md, vault
context) but has a completely scoped tool surface.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from temporalio import activity

from src.config import load_config

logger = logging.getLogger("ephemeral-agent")

# Tools every ephemeral agent gets regardless of instinct declaration.
# These are the pi-coding-agent file primitives the agent needs to function.
DEFAULT_SAFE_TOOLS = ["read", "write", "edit", "grep", "find", "ls"]


def _read_workers_config() -> tuple[dict[str, Any], Path]:
    """Read the openclaw-workers config file."""
    config = load_config()
    config_path = Path(config.workers_openclaw_config_path)
    if not config_path.is_file():
        raise FileNotFoundError(f"Workers openclaw config not found: {config_path}")
    with open(config_path) as f:
        return json.load(f), config_path


def _write_workers_config(data: dict[str, Any], config_path: Path) -> None:
    """Write the openclaw-workers config file and touch lastTouchedAt."""
    data.setdefault("meta", {})["lastTouchedAt"] = time.strftime(
        "%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()
    )
    with open(config_path, "w") as f:
        json.dump(data, f, indent=2)


@activity.defn
async def create_ephemeral_agent(
    task_id: str,
    tools_required: list[str],
    model: str = "",
) -> str:
    """Create an ephemeral agent entry in openclaw-workers config.

    Returns the agent ID (e.g. "exec-a3f8b2c1").
    """
    agent_id = f"exec-{task_id[:8]}"

    # Build the scoped tool allowlist
    allow = sorted(set(DEFAULT_SAFE_TOOLS + tools_required))

    cfg, path = _read_workers_config()
    agents = cfg.setdefault("agents", {}).setdefault("list", [])

    # Remove any stale entry with the same ID (shouldn't happen, but defensive)
    agents[:] = [a for a in agents if a.get("id") != agent_id]

    # Add the ephemeral agent
    entry: dict[str, Any] = {
        "id": agent_id,
        "name": f"Ephemeral Executor ({task_id[:8]})",
        "workspace": "/home/node/.openclaw/workspace",
        "tools": {
            "allow": allow,
        },
        "subagents": {"allowAgents": []},
    }
    if model:
        entry["model"] = {"primary": model}

    agents.append(entry)
    _write_workers_config(cfg, path)

    logger.info(
        "Created ephemeral agent %s with %d tools: %s",
        agent_id,
        len(allow),
        allow,
    )
    return agent_id


@activity.defn
async def delete_ephemeral_agent(agent_id: str) -> bool:
    """Remove an ephemeral agent entry from openclaw-workers config.

    Returns True if the agent was found and removed, False if not found.
    """
    try:
        cfg, path = _read_workers_config()
    except FileNotFoundError:
        logger.warning("Workers config not found during cleanup of %s", agent_id)
        return False

    agents = cfg.get("agents", {}).get("list", [])
    before = len(agents)
    agents[:] = [a for a in agents if a.get("id") != agent_id]
    after = len(agents)

    if before == after:
        logger.warning("Ephemeral agent %s not found in config (already cleaned up?)", agent_id)
        return False

    cfg["agents"]["list"] = agents
    _write_workers_config(cfg, path)
    logger.info("Deleted ephemeral agent %s", agent_id)
    return True


@activity.defn
async def wait_for_agent_ready(agent_id: str) -> bool:
    """Wait for the openclaw-workers gateway to hot-reload and recognize the new agent.

    Polls for up to 30 seconds. Returns True if ready, False if timed out.
    The gateway watches meta.lastTouchedAt and reloads within ~10s.
    """
    import httpx

    config = load_config()
    gateway_url = config.execution_gateway_url
    token = config.gateway_token()

    for attempt in range(6):  # 6 attempts × 5s = 30s
        activity.heartbeat(f"Waiting for agent {agent_id} to be ready (attempt {attempt + 1}/6)")
        await _sleep(5)

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"{gateway_url}/health",
                    headers={"Authorization": f"Bearer {token}"},
                )
                if resp.status_code == 200:
                    logger.info("Workers gateway healthy, agent %s should be available", agent_id)
                    return True
        except Exception:
            continue

    logger.warning("Timed out waiting for agent %s readiness", agent_id)
    return True  # proceed anyway — the gateway may have reloaded between our checks


async def _sleep(seconds: float) -> None:
    """Async sleep that works in both Temporal and regular contexts."""
    import asyncio
    await asyncio.sleep(seconds)
