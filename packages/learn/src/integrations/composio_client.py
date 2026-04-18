"""Composio tool-belt client — managed OAuth + third-party tool execution.

All Composio interactions go through this module. The client wraps the
Composio Python SDK and provides Alfred-specific helpers.

Key concepts:
  - user_id: maps to the Alfred tenant owner (e.g. "david@szabostuban.com")
  - connected_account: a per-user credential link to a toolkit (Gmail, Notion, etc.)
  - toolkit: the integrated service (gmail, notion, googlecalendar, slack, etc.)
  - tool/action: a specific operation on a toolkit (GMAIL_FETCH_EMAILS, etc.)

Credentials never touch the tenant VPS — Composio stores and manages
OAuth tokens server-side, auto-refreshing before expiry.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger("composio-client")

# Lazy-load the SDK so the rest of learn works even if composio isn't installed
_composio_instance = None


def _get_client():
    """Get or create the singleton Composio client."""
    global _composio_instance
    if _composio_instance is not None:
        return _composio_instance

    api_key = os.environ.get("COMPOSIO_API_KEY", "")
    if not api_key:
        raise RuntimeError(
            "COMPOSIO_API_KEY not set. Add it to the tenant .env to enable third-party tool execution."
        )

    try:
        from composio import Composio
    except ImportError:
        raise RuntimeError(
            "composio SDK not installed. Run: pip install composio"
        )

    _composio_instance = Composio(api_key=api_key)
    logger.info("Composio client initialized")
    return _composio_instance


def get_user_id() -> str:
    """Resolve the Composio user_id for this tenant.

    Uses COMPOSIO_USER_ID env, which MUST be set to a tenant-unique value
    (e.g. ``alfred-<slug>-<instance-id>``) by the provisioner. Raises
    RuntimeError if missing or set to the old default ``"default"`` — that
    value caused cross-tenant connection leakage. See #408.
    """
    uid = (os.environ.get("COMPOSIO_USER_ID") or "").strip()
    if not uid or uid == "default":
        # Fallback: init container writes this file for existing tenants
        # whose .env has not been backfilled. See init/entrypoint.sh step 10.
        fallback = "/alfred-data/.composio-user-id"
        try:
            if os.path.exists(fallback):
                with open(fallback) as f:
                    file_uid = f.read().strip()
                if file_uid and file_uid != "default":
                    uid = file_uid
        except OSError:
            pass
    if not uid or uid == "default":
        raise RuntimeError(
            "COMPOSIO_USER_ID is not set (or still 'default'). "
            "Every tenant must have a unique COMPOSIO_USER_ID in .env so that "
            "Composio connected_accounts are scoped per tenant. "
            "Set COMPOSIO_USER_ID=alfred-<slug>-<instance-id> and restart."
        )
    return uid


def list_connected_accounts(user_id: str | None = None) -> list[dict[str, Any]]:
    """List connected accounts for this tenant user only.

    Passes ``user_id`` to Composio for server-side scoping, with a
    defense-in-depth client-side filter on top.
    """
    client = _get_client()
    uid = user_id or get_user_id()
    try:
        # Try server-side scoping first — accepted by Composio SDK v3.
        try:
            response = client.connected_accounts.list(user_id=uid)
        except TypeError:
            # Older SDK signature — fall back to unfiltered list + client-side filter.
            response = client.connected_accounts.list()

        results = []
        for acct in response.items:
            d = acct.model_dump()
            acct_user = d.get("user_id") or d.get("member_id")
            # Defense-in-depth: require an explicit owner match. Accounts
            # with missing owner fields must NOT be exposed to this tenant —
            # cross-tenant leakage is the failure mode this guards against.
            if not acct_user:
                logger.warning(
                    "Composio account %s has no owner field; excluding from tenant view",
                    d.get("id"),
                )
                continue
            if acct_user != uid:
                continue
            toolkit = d.get("toolkit", {})
            results.append({
                "id": d.get("id", ""),
                "toolkit_slug": toolkit.get("slug", "") if isinstance(toolkit, dict) else "",
                "status": d.get("status", ""),
                "auth_scheme": d.get("authScheme", d.get("auth_scheme", "")),
                "user_id": acct_user,
                "created_at": str(d.get("created_at", "")),
            })
        return results
    except Exception as e:
        logger.error("Failed to list connected accounts: %s", e)
        return []


def list_toolkit_actions(
    toolkit_slug: str,
    user_id: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """List available actions for a toolkit (e.g. "gmail", "notion").

    Returns OpenAI-format tool dicts: {function: {name, description, parameters}}.
    """
    client = _get_client()
    uid = user_id or get_user_id()
    try:
        tools = client.tools.get(user_id=uid, toolkits=[toolkit_slug], limit=limit)
        return [t if isinstance(t, dict) else t.model_dump() for t in tools]
    except Exception as e:
        logger.error("Failed to list actions for %s: %s", toolkit_slug, e)
        return []


def execute_action(
    action_slug: str,
    arguments: dict[str, Any],
    user_id: str | None = None,
    connected_account_id: str | None = None,
) -> dict[str, Any]:
    """Execute a Composio action (e.g. GMAIL_FETCH_EMAILS).

    Args:
        action_slug: The action identifier (e.g. "GMAIL_FETCH_EMAILS")
        arguments: Action-specific parameters
        user_id: Composio user_id (defaults to tenant's COMPOSIO_USER_ID)
        connected_account_id: Specific connected account (optional — Composio
            auto-resolves from user_id if omitted)

    Returns:
        dict with execution result (varies by action)
    """
    client = _get_client()
    uid = user_id or get_user_id()
    try:
        kwargs: dict[str, Any] = {
            "slug": action_slug,
            "arguments": arguments,
            "user_id": uid,
        }
        if connected_account_id:
            kwargs["connected_account_id"] = connected_account_id

        # The Composio SDK requires either an explicit toolkit version or
        # dangerously_skip_version_check=True for manual execution.
        kwargs["dangerously_skip_version_check"] = True
        result = client.tools.execute(**kwargs)
        # Convert to plain dict
        if hasattr(result, "model_dump"):
            return result.model_dump()
        return dict(result) if result else {"error": "empty response"}
    except Exception as e:
        logger.error("Composio action %s failed: %s", action_slug, e)
        return {"error": str(e), "action": action_slug}


def check_readiness(
    tools_required: list[str],
    user_id: str | None = None,
) -> dict[str, Any]:
    """Check if the tenant has connected accounts for the required tools.

    Args:
        tools_required: List of action slugs (e.g. ["GMAIL_FETCH_EMAILS", "NOTION_CREATE_PAGE"])

    Returns:
        {ready: bool, missing: [...], available: [...]}
    """
    uid = user_id or get_user_id()
    accounts = list_connected_accounts(uid)
    connected_toolkits = {
        a["toolkit_slug"]
        for a in accounts
        if a["status"] == "ACTIVE"
    }

    # Map action slug → toolkit: GMAIL_FETCH_EMAILS → gmail
    available = []
    missing = []
    for action in tools_required:
        # Action slugs are typically TOOLKIT_ACTION_NAME
        parts = action.split("_", 1)
        toolkit = parts[0].lower() if parts else ""
        if toolkit in connected_toolkits:
            available.append(action)
        else:
            missing.append(action)

    return {
        "ready": len(missing) == 0,
        "missing": missing,
        "available": available,
        "connected_toolkits": sorted(connected_toolkits),
    }
