"""Stream event read/mark activities."""

from __future__ import annotations

from typing import Any

from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient


@activity.defn
async def fetch_unprocessed_events() -> list[dict[str, Any]]:
    """Fetch unprocessed stream events (max per run from config)."""
    config = load_config()
    client = VaultClient(config)
    try:
        return await client.fetch_unprocessed_events(limit=config.max_events_per_run)
    finally:
        await client.close()


@activity.defn
async def mark_event_processed(
    event_id: str,
    vault_path: str,
    classification: str,
) -> None:
    """Mark a stream event as processed."""
    config = load_config()
    client = VaultClient(config)
    try:
        await client.mark_event_processed(event_id, vault_path, classification)
    finally:
        await client.close()


@activity.defn
async def quarantine_event(event: dict[str, Any], errors: list[str]) -> None:
    """Quarantine a stream event that failed validation."""
    config = load_config()
    client = VaultClient(config)
    try:
        event_id = event.get("id", "")
        await client.quarantine_event(event_id, errors)
    finally:
        await client.close()
