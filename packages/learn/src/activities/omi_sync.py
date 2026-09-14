"""Trigger controller reconciliation; no direct database access."""
import os
import httpx
from temporalio import activity

@activity.defn
async def reconcile_omi_chat_tasks() -> dict:
    base = os.environ.get("ALFRED_CTRL_URL", "http://ctrl-api:3100").rstrip("/")
    async with httpx.AsyncClient(timeout=210) as client:
        result = await client.post(
            base + "/api/v1/channels/omi/pilot/sync",
            headers={"Authorization": "Bearer " + os.environ.get("AAS_API_KEY", "")},
        )
        result.raise_for_status()
        return result.json()
