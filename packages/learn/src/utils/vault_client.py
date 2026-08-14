"""HTTP client for alfred-ctrl vault API.

All vault writes go through alfred-ctrl API — NEVER direct filesystem writes.
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

import httpx

from src.config import Config


def _encode_path(path: str) -> str:
    """URL-encode a vault path for use in a request URL.

    Preserves ``/`` as a path separator but escapes everything else
    (notably ``#``, which httpx otherwise interprets as a URL fragment
    delimiter and silently drops, causing 500s on records like
    ``omi-Anthropic receipt (PBC #2327-3261-2957).md``).
    """
    return quote(path, safe="/")


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
        resp = await self._client.get(f"/api/v1/vault/records/{_encode_path(path)}")
        resp.raise_for_status()
        return resp.json()

    async def update_record(self, path: str, content: str) -> None:
        """Update an existing vault record."""
        resp = await self._client.patch(
            f"/api/v1/vault/records/{_encode_path(path)}",
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
            f"/api/v1/vault/records/{_encode_path(path)}",
            json={"set": set_map},
        )
        resp.raise_for_status()

    async def patch_frontmatter_structured(
        self,
        path: str,
        scalar_updates: dict[str, Any] | None = None,
        json_updates: dict[str, Any] | None = None,
    ) -> None:
        """Update frontmatter with structured (lists/dicts/bools/nums) values.

        Phase 2 (#838) added a ``json_set`` body to ctrl-api's PATCH that
        keeps native JSON shape end-to-end via direct YAML manipulation.
        Use this when you need structured frontmatter (e.g. Steward's
        ``signal_sources`` list-of-dicts, ``last_steward_outcome`` dict)
        to round-trip without becoming Python repr strings.

        ``scalar_updates`` still goes through the alfred-CLI ``--set``
        path so the response shape stays compatible with consumers that
        rely on the CLI's validation.
        """
        body: dict[str, Any] = {}
        if scalar_updates:
            set_map: dict[str, str] = {}
            for k, v in scalar_updates.items():
                if isinstance(v, bool):
                    set_map[k] = "true" if v else "false"
                elif v is None:
                    set_map[k] = ""
                else:
                    set_map[k] = str(v)
            if set_map:
                body["set"] = set_map
        if json_updates:
            # Don't coerce — ctrl-api PATCH preserves native shape via the
            # json_set path.
            body["json_set"] = json_updates
        if not body:
            return
        resp = await self._client.patch(
            f"/api/v1/vault/records/{_encode_path(path)}",
            json=body,
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
        resp = await self._client.delete(f"/api/v1/vault/records/{_encode_path(path)}")
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

    async def record_exists(self, record_type: str, slug: str) -> bool:
        """Exact-slug existence check for a vault record.

        ``search_records`` is a grep substring search — using it as an
        existence guard means a slightly-renamed re-onboard run (e.g.
        ``weekly-stripe-reviews`` vs an existing ``weekly-stripe-review``)
        either false-positives (substring match → silently skips a real
        new record) or false-negatives (no substring → writes a duplicate,
        the matter 9→16 / chore 7→14 class). This compares the canonical
        ``<record_type>/<slug>.md`` path and the record ``slug`` field
        exactly against the typed listing, so a re-run dedups reliably.
        """
        target_path = f"{record_type}/{slug}.md"
        records = await self.list_records(record_type, limit=1000)
        for r in records:
            if r.get("slug") == slug or r.get("path") == target_path:
                return True
        return False

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

    async def list_decisions(
        self, *, since: str | None = None, state: str | None = None, limit: int = 500
    ) -> list[dict[str, Any]]:
        """List decision records via ctrl's dedicated decisions route."""
        params: dict[str, Any] = {"limit": limit}
        if since:
            params["since"] = since
        if state:
            params["state"] = state
        resp = await self._client.get("/api/v1/decisions", params=params)
        resp.raise_for_status()
        return resp.json().get("decisions", [])

    async def notify(
        self, path: str, summary: str, *, solicited: int | None = None
    ) -> None:
        """Send a proactive notification to Sir via the alfred-deliver surface.

        ``solicited`` must be 0 (Alfred-initiated, e.g. briefings, weekly
        digests, escalations) or omitted (ambiguous — stays NULL in the DB).
        Never pass 1 here; that value is for principal-reply paths only.
        The column feeds the NAR interruption term (#580).
        """
        message = f"Alfred Learn: {summary}\nPath: {path}"
        body: dict[str, Any] = {"message": message, "urgency": "normal"}
        # Only stamp 0; any other value is left out so it stays NULL.
        if solicited == 0:
            body["solicited"] = 0
        resp = await self._client.post("/api/v1/alfred-deliver", json=body)
        # Best-effort — don't raise on failure
        if resp.status_code >= 500:
            resp.raise_for_status()

    # --- Plane Steward action helpers (#839 Phase 3) -----------------------

    async def plane_post_steward_action(
        self,
        *,
        project_id: str,
        issue_id: str,
        decision: str,
        confidence: float,
        evidence: list[dict[str, Any]],
        audit_record_path: str,
    ) -> dict[str, Any]:
        """Post a Steward auto-action to Plane via ctrl-api.

        Wraps ``POST /api/v1/plane/steward-action`` which posts a comment
        (``"Auto-update by Alfred ..."``) and, when the decision implies
        a state transition (``likely_done`` → ``completed``,
        ``stale_archive_candidate`` → archived), transitions the Plane
        issue's state. Returns the full response so the caller can
        record the comment id + prior state into the undo recipe.

        Response shape::

            {
              "ok": true,
              "comment_id": "<uuid>" | null,
              "transitioned_to_state_id": "<uuid>" | null,
              "transitioned_to_state_group": "completed" | null,
              "prior_state_id": "<uuid>" | null,
              "prior_archived": false,
              "archived": false
            }
        """
        resp = await self._client.post(
            "/api/v1/plane/steward-action",
            json={
                "project_id": project_id,
                "issue_id": issue_id,
                "decision": decision,
                "confidence": confidence,
                "evidence": evidence,
                "audit_record_path": audit_record_path,
            },
        )
        resp.raise_for_status()
        return resp.json()

    async def plane_revert_steward_action(
        self,
        *,
        project_id: str,
        issue_id: str,
        delete_comment_id: str | None,
        restore_state_id: str | None,
        restore_archived: bool | None,
    ) -> dict[str, Any]:
        """Reverse a previously-posted Steward Plane action via ctrl-api.

        Wraps ``POST /api/v1/plane/steward-action/revert``. Idempotent —
        a 404 on comment delete is treated as success (already gone).
        """
        resp = await self._client.post(
            "/api/v1/plane/steward-action/revert",
            json={
                "project_id": project_id,
                "issue_id": issue_id,
                "delete_comment_id": delete_comment_id,
                "restore_state_id": restore_state_id,
                "restore_archived": restore_archived,
            },
        )
        resp.raise_for_status()
        return resp.json()
