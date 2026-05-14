"""Decision → Composio action-slug hints for the executor prompt.

Deterministic mapping from a delegated decision's source_type onto a
small bounded set of Composio action slugs the executor should
*consider* invoking via ``composio_execute``. These are prompt hints,
not gateway-level enforcement (the gateway's ``composio_execute`` tool
takes the slug as a runtime argument, so per-action scoping at the
gateway level isn't actually achievable today — the safety belt is
the bounded mapping below + the executor's prompt frame).

Adding a new source_type? Edit ``_HINTS_BY_SOURCE`` below. Keep the
table small and obvious — this is the safety boundary for what an
auto-delegated action is allowed to consider, so every entry should
be reviewed deliberately.
"""
from __future__ import annotations

import logging
from typing import Any

from temporalio import activity

logger = logging.getLogger("tool-inference")


# Per-source hint table. Keys are matched as PREFIXES against the
# source signal's ``source_type`` (so ``gmail`` matches
# ``gmail_personal``, ``composio-googlecalendar-events`` matches
# ``composio-googlecalendar-*``, etc.).
#
# Each entry returns a SHORT list of slugs — long lists confuse the
# executor's tool selection. If a real action ends up needing a slug
# that isn't here, the executor's prompt allows it to ``list_composio_tools``
# at runtime (via the alfred-ctrl ``self`` MCP tool calling
# ``/api/v1/integrations/<toolkit>/actions``) — but the prompt also
# tells it to prefer the suggested slugs first.
_HINTS_BY_SOURCE: dict[str, list[str]] = {
    # Mail
    "gmail": [
        "GMAIL_SEND_EMAIL",
        "GMAIL_REPLY_TO_THREAD",
        "GMAIL_FETCH_EMAILS",
    ],
    "composio-gmail": [
        "GMAIL_SEND_EMAIL",
        "GMAIL_REPLY_TO_THREAD",
        "GMAIL_FETCH_EMAILS",
    ],
    # Calendar
    "gcal": [
        "GOOGLECALENDAR_FIND_EVENT",
        "GOOGLECALENDAR_RESPOND_TO_EVENT",
        "GOOGLECALENDAR_LIST_EVENTS",
    ],
    "googlecalendar": [
        "GOOGLECALENDAR_FIND_EVENT",
        "GOOGLECALENDAR_RESPOND_TO_EVENT",
        "GOOGLECALENDAR_LIST_EVENTS",
    ],
    "composio-googlecalendar": [
        "GOOGLECALENDAR_FIND_EVENT",
        "GOOGLECALENDAR_RESPOND_TO_EVENT",
        "GOOGLECALENDAR_LIST_EVENTS",
    ],
    # Slack
    "composio-slack": [
        "SLACK_SEND_MESSAGE",
        "SLACK_REPLY_IN_THREAD",
    ],
    # Linear
    "composio-linear": [
        "LINEAR_CREATE_COMMENT",
        "LINEAR_UPDATE_ISSUE",
    ],
    # Notion
    "composio-notion": [
        "NOTION_CREATE_PAGE",
        "NOTION_UPDATE_PAGE",
    ],
    # GitHub
    "composio-github": [
        "GITHUB_CREATE_AN_ISSUE",
        "GITHUB_CREATE_AN_ISSUE_COMMENT",
    ],
}


def _hints_for(source_type: str) -> list[str]:
    if not source_type:
        return []
    s = source_type.strip().lower()
    for prefix, hints in _HINTS_BY_SOURCE.items():
        if s.startswith(prefix):
            return list(hints)
    return []


@activity.defn
async def infer_required_tools(decision: dict[str, Any]) -> dict[str, Any]:
    """Return ``{"source_type", "tools_required", "hints"}``.

    Pulls the underlying signal's ``source_type`` from the decision
    record's chain (decision → needs_attention → source signal),
    or falls back to nothing if we can't determine it. The caller
    embeds ``hints`` in the executor's prompt verbatim.
    """
    # Best-effort source_type extraction: prefer the explicit field
    # on the decision (if signal_extract stamped it), otherwise leave
    # empty and let the executor figure it out via vault reads.
    source_type = ""
    fm = decision if isinstance(decision, dict) else {}
    candidate = (
        fm.get("source_type")
        or fm.get("source")
        or ""
    )
    if isinstance(candidate, str):
        source_type = candidate.strip().lower()

    hints = _hints_for(source_type)
    logger.info(
        "tool_inference.infer_required_tools: source_type=%s hints=%s",
        source_type, hints,
    )
    return {
        "source_type": source_type,
        "tools_required": hints,
        "hints": hints,
    }
