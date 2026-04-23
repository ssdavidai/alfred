"""HTTP client for alfred-ctrl vault API.

All vault writes go through alfred-ctrl API — NEVER direct filesystem writes.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from src.config import Config


class VaultClient:
    """Async HTTP client wrapping the alfred-ctrl vault and streams API."""

    def __init__(self, config: Config) -> None:
        self._base = config.alfred_ctrl_url
        api_key = os.environ.get("AAS_API_KEY", "")
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._client = httpx.AsyncClient(
            base_url=self._base, timeout=30.0, headers=headers
        )

    async def close(self) -> None:
        await self._client.aclose()

    # --- Vault CRUD --------------------------------------------------------

    async def drop_to_inbox(self, filename: str, content: str) -> str:
        """Write a file to the vault inbox for curator processing. Returns filename."""
        resp = await self._client.post(
            "/api/v1/vault/inbox",
            json={"filename": filename, "content": content},
        )
        resp.raise_for_status()
        return resp.json().get("filename", filename)

    async def write_record(self, record_type: str, name: str, content: str) -> str:
        """Write a vault record. Returns the vault path."""
        resp = await self._client.post(
            "/api/v1/vault/records",
            json={"type": record_type, "name": name, "content": content},
        )
        resp.raise_for_status()
        return resp.json()["path"]

    async def read_record(self, path: str) -> dict[str, Any]:
        """Read a vault record by path."""
        resp = await self._client.get(f"/api/v1/vault/records/{path}")
        resp.raise_for_status()
        return resp.json()

    async def update_record(self, path: str, content: str) -> None:
        """Update an existing vault record."""
        resp = await self._client.patch(
            f"/api/v1/vault/records/{path}",
            json={"body_append": content},
        )
        resp.raise_for_status()

    async def patch_frontmatter(
        self, path: str, updates: dict[str, Any]
    ) -> None:
        """Update specific frontmatter keys on an existing vault record.

        Uses ctrl-api's ``PATCH /api/v1/vault/records/*`` with the
        ``set`` body — that endpoint routes to the ``alfred vault edit``
        CLI which validates field names against the schema. All values
        are stringified before send since the underlying CLI accepts
        only string values per field.
        """
        # All vault-frontmatter-edit CLI arguments are strings; coerce
        # booleans + numbers to lowercase string form so they round-trip
        # correctly through YAML.
        set_map: dict[str, str] = {}
        for k, v in updates.items():
            if isinstance(v, bool):
                set_map[k] = "true" if v else "false"
            elif v is None:
                set_map[k] = ""
            else:
                set_map[k] = str(v)
        resp = await self._client.patch(
            f"/api/v1/vault/records/{path}",
            json={"set": set_map},
        )
        resp.raise_for_status()

    async def delete_record(self, path: str) -> bool:
        """Delete a vault record by path. Returns True if a record was
        removed, False if it didn't exist (404). Raises on other errors.

        Used by the streams rematerializer's --delete-orphans pass when
        a template changed its record_type — e.g. Omi transcripts
        migrating from event/ to conversation/ leave the old event/
        file as an orphan that this method clears.
        """
        resp = await self._client.delete(f"/api/v1/vault/records/{path}")
        if resp.status_code == 404:
            return False
        resp.raise_for_status()
        return True

    async def list_records(
        self,
        record_type: str,
        status: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """List vault records by type, optionally filtered by status."""
        resp = await self._client.get(f"/api/v1/vault/list/{record_type}")
        resp.raise_for_status()
        results = resp.json().get("results", [])

        # Filter by status client-side if specified
        if status:
            results = [r for r in results if r.get("status") == status]

        return results[:limit]

    async def search_records(
        self,
        query: str,
        record_type: str | None = None,
    ) -> list[dict[str, Any]]:
        """Search vault records."""
        # The vault search endpoint uses 'grep' for text search
        params: dict[str, Any] = {"grep": query}
        resp = await self._client.get("/api/v1/vault/search", params=params)
        resp.raise_for_status()
        results = resp.json().get("results", [])

        # Filter by type client-side if specified
        if record_type:
            results = [r for r in results if r.get("type") == record_type]

        return results

    # --- Streams API -------------------------------------------------------

    async def fetch_unprocessed_events(self, limit: int = 20) -> list[dict[str, Any]]:
        """Fetch unprocessed stream events."""
        resp = await self._client.get(
            "/api/v1/streams/events",
            params={"status": "unprocessed", "limit": limit},
        )
        resp.raise_for_status()
        return resp.json().get("events", [])

    async def mark_event_processed(
        self,
        event_id: str,
        vault_path: str,
        classification: str,
    ) -> None:
        """Mark a stream event as processed."""
        resp = await self._client.post(
            f"/api/v1/streams/events/{event_id}/processed",
            json={"vault_path": vault_path, "classification": classification},
        )
        resp.raise_for_status()

    async def quarantine_event(self, event_id: str, errors: list[str]) -> None:
        """Quarantine a stream event."""
        reason = "; ".join(errors) if errors else "Unknown error"
        resp = await self._client.post(
            f"/api/v1/streams/events/{event_id}/quarantine",
            json={"reason": reason},
        )
        resp.raise_for_status()

    # --- Learning API ------------------------------------------------------

    async def fetch_unrouted_inputs(self, limit: int = 20) -> list[dict[str, Any]]:
        """Fetch inputs awaiting routing judgment."""
        resp = await self._client.get(
            "/api/v1/learning/queue",
            params={"limit": limit},
        )
        resp.raise_for_status()
        return resp.json().get("items", [])

    async def notify(self, path: str, summary: str) -> None:
        """Send a notification to the main Alfred agent."""
        message = f"Alfred Learn: {summary}\nPath: {path}"
        resp = await self._client.post(
            "/api/v1/notifications",
            json={"message": message, "urgency": "normal", "session_id": "main"},
        )
        # Best-effort — don't raise on failure
        if resp.status_code >= 500:
            resp.raise_for_status()
