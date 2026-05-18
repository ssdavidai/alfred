"""Composio tool-belt Temporal activities.

These activities expose the Composio client to Temporal workflows,
enabling execution tasks to call third-party tools (Gmail, Notion,
Calendar, etc.) with managed OAuth credentials that never touch the
tenant VPS.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity


@activity.defn
async def list_composio_tools(toolkit_slug: str) -> list[dict[str, Any]]:
    """List available Composio actions for a toolkit.

    Returns OpenAI-format tool definitions the subagent can use.
    """
    from src.integrations.composio_client import list_toolkit_actions

    return list_toolkit_actions(toolkit_slug)


@activity.defn
async def execute_composio_action(
    action_slug: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    """Execute a Composio action (e.g. GMAIL_FETCH_EMAILS).

    Called by TaskRunner when an execution task needs third-party tool access.
    The Composio client resolves the connected account from the tenant's
    COMPOSIO_USER_ID and executes the action server-side.
    """
    from src.integrations.composio_client import execute_action

    result = execute_action(action_slug, arguments)
    activity.heartbeat(f"Composio action {action_slug} completed")
    return result


@activity.defn
async def check_composio_readiness(tools_required: list[str]) -> dict[str, Any]:
    """Check if the tenant has connected accounts for the required tools.

    Called before spawning an execution task to verify the tools it needs
    are actually available. Returns {ready: bool, missing: [...], available: [...]}.
    """
    from src.integrations.composio_client import check_readiness

    return check_readiness(tools_required)


@activity.defn
async def list_composio_connected_accounts() -> list[dict[str, Any]]:
    """List all connected Composio accounts for this tenant.

    Returns [{id, toolkit_slug, status, auth_scheme, user_id, created_at}].
    """
    from src.integrations.composio_client import list_connected_accounts

    return list_connected_accounts()
