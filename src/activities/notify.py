"""Notification activities."""

from __future__ import annotations

from typing import Any

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient


@activity.defn
async def notify_digest_ready(path: str, summary: str) -> None:
    """Notify the main Alfred agent that the daily digest is ready."""
    config = load_config()
    client = VaultClient(config)
    try:
        await client.notify(path, summary)
    finally:
        await client.close()


@activity.defn
async def notify_eod_prompt(prompt: str, digest_path: str) -> None:
    """Send an interactive EOD prompt to the main Alfred agent via OpenClaw gateway.

    Posts a message to the main agent's session so the user sees an interactive
    end-of-day summary and can respond with routing/closing decisions.
    """
    config = load_config()
    token = config.gateway_token()

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{config.openclaw_gateway_url}/v1/sessions/message",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "agent_id": "alfred-main",
                "message": prompt,
                "metadata": {
                    "source": "alfred-learn",
                    "type": "eod_digest",
                    "digest_path": digest_path,
                },
            },
        )
        # Best-effort — log but don't raise on non-500 errors
        if resp.status_code >= 500:
            resp.raise_for_status()


@activity.defn
async def escalate_to_user(
    input_event: dict[str, Any],
    best_match: dict[str, Any] | None = None,
) -> None:
    """Escalate an unrouted input to the user via Alfred notification."""
    config = load_config()
    client = VaultClient(config)
    try:
        title = input_event.get("title", input_event.get("summary", "Unknown input"))
        score_info = ""
        if best_match:
            instinct_name = best_match.get("instinct", {}).get("name", "")
            score = best_match.get("score", 0)
            score_info = f" Best match: {instinct_name} ({score:.0%})"

        summary = f"Needs your judgment: {title}.{score_info}"
        path = input_event.get("path", input_event.get("id", ""))
        await client.notify(path, summary)
    finally:
        await client.close()
