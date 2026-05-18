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

    async def fetch_unprocessed_events(
        self,
        limit: int = 20,
        consumer: str | None = "event_processor",
    ) -> list[dict[str, Any]]:
        """Fetch unprocessed stream events.

        STORE-P4-1: when ``consumer`` is set (default), reads from the
        date-partitioned JSONL log at /vault/_raw/<date>.jsonl via the
        consumer-aware endpoint, which atomically advances the
        per-consumer offset in state.db. The returned entries follow the
        new StreamLogEntry shape ({id, ts_ns, source_type, source_id,
        received_at, headers?, payload}).

        When ``consumer`` is None, falls back to the legacy status-keyed
        scan over /mnt/encrypted/alfred/streams/*.jsonl.
        """
        params: dict[str, Any]
        if consumer:
            params = {"consumer": consumer, "max": limit}
        else:
            params = {"status": "unprocessed", "limit": limit}
        resp = await self._client.get("/api/v1/streams/events", params=params)
        resp.raise_for_status()
        return resp.json().get("events", [])

    async def mark_event_processed(
        self,
        event_id: str,
        vault_path: str,
        classification: str,
        *,
        date: str | None = None,
        consumer: str = "event_processor",
    ) -> None:
        """Mark a stream event as processed.

        STORE-P4-1: writes both to stream_event_processed (state.db,
        authoritative for the JSONL compactor) and to the legacy
        processed-events.json mirror. ``date`` is the YYYY-MM-DD
        partition the event came from — pass through from the event's
        own ``received_at`` if known, otherwise the server defaults to
        today UTC.
        """
        body: dict[str, Any] = {
            "vault_path": vault_path,
            "classification": classification,
            "consumer": consumer,
        }
        if date:
            body["date"] = date
        resp = await self._client.post(
            f"/api/v1/streams/events/{event_id}/processed",
            json=body,
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

    # --- Audit (STORE-P2-1) ------------------------------------------------

    async def write_audit(
        self,
        *,
        actor: str,
        action_type: str,
        target_type: str,
        target_id: str,
        payload: dict[str, Any],
        decision_origin: str | None = None,
        reasoning: str | None = None,
        reversible: bool = False,
    ) -> dict[str, Any]:
        """POST one row to the unified audit table via ctrl-api.

        Wraps ``POST /api/v1/audit`` (STORE-P2-1). The server assigns
        ``id`` (UUIDv4) and ``ts`` (unix ns). ``ts`` is returned as a
        decimal STRING so nanosecond precision survives JSON's
        ``Number.MAX_SAFE_INTEGER`` ceiling.

        ``payload`` is sent as a JSON object; ctrl-api stringifies for
        storage. Keep it serialisable — ``datetime`` and similar
        non-JSON-native types should be coerced by the caller before
        invocation.

        Returns ``{"id": "<uuid>", "ts": "<unix-ns-string>"}``.
        """
        body: dict[str, Any] = {
            "actor": actor,
            "action_type": action_type,
            "target_type": target_type,
            "target_id": target_id,
            "payload": payload,
            "reversible": bool(reversible),
        }
        if decision_origin is not None:
            body["decision_origin"] = decision_origin
        if reasoning is not None:
            body["reasoning"] = reasoning
        resp = await self._client.post("/api/v1/audit", json=body)
        resp.raise_for_status()
        return resp.json()

    # --- Signal + Observation rows (STORE-P3-3) ---------------------------

    async def write_signal(
        self,
        *,
        source_type: str,
        body: str,
        source_event: str | None = None,
        target_matter: str | None = None,
        target_kind: str | None = None,
        actor: str | None = None,
        decision_required: bool = False,
        display_headline: str | None = None,
        display_body: str | None = None,
        classified_noise: bool = False,
    ) -> dict[str, Any]:
        """POST one row to the signal table via ctrl-api.

        Wraps ``POST /api/v1/signals`` (STORE-P3-2). The server assigns
        ``id`` (UUIDv4) and ``ts`` (unix ns, returned as decimal STRING
        so nanosecond precision survives JSON's ``Number.MAX_SAFE_INTEGER``
        ceiling).

        Returns ``{"id": "<uuid>", "ts": "<unix-ns-string>"}``.
        """
        payload: dict[str, Any] = {
            "source_type": source_type,
            "body": body,
            "decision_required": bool(decision_required),
            "classified_noise": bool(classified_noise),
        }
        if source_event is not None:
            payload["source_event"] = source_event
        if target_matter is not None:
            payload["target_matter"] = target_matter
        if target_kind is not None:
            payload["target_kind"] = target_kind
        if actor is not None:
            payload["actor"] = actor
        if display_headline is not None:
            payload["display_headline"] = display_headline
        if display_body is not None:
            payload["display_body"] = display_body
        resp = await self._client.post("/api/v1/signals", json=payload)
        resp.raise_for_status()
        return resp.json()

    async def write_observation(
        self,
        *,
        instinct_id: str,
        signal_id: str | None = None,
        confidence: float | None = None,
        embedding: list[float] | None = None,
        embedding_id: int | None = None,
    ) -> dict[str, Any]:
        """POST one row to the observation table via ctrl-api.

        Wraps ``POST /api/v1/observations`` (STORE-P3-2). Pass either
        an inline ``embedding`` (number[768]) or a pre-allocated
        ``embedding_id`` rowid — never both. Returns
        ``{"id", "ts", "embedding_id"}``.
        """
        if embedding is not None and embedding_id is not None:
            raise ValueError(
                "supply either `embedding` or `embedding_id`, not both"
            )
        payload: dict[str, Any] = {"instinct_id": instinct_id}
        if signal_id is not None:
            payload["signal_id"] = signal_id
        if confidence is not None:
            payload["confidence"] = float(confidence)
        if embedding is not None:
            payload["embedding"] = embedding
        if embedding_id is not None:
            payload["embedding_id"] = int(embedding_id)
        resp = await self._client.post("/api/v1/observations", json=payload)
        resp.raise_for_status()
        return resp.json()

    # --- Signal + Observation reads (STORE-P3-5) --------------------------

    async def list_signals(
        self,
        *,
        target_matter: str | None = None,
        source_type: str | None = None,
        since_ns: int | None = None,
        until_ns: int | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        """GET /api/v1/signals with filters. Returns the raw JSON rows.

        Wraps the STORE-P3-2 endpoint. Each row carries the SQL columns
        ``{id, ts, source_type, source_event, target_matter, target_kind,
        actor, decision_required, display_headline, display_body, body,
        processed_at, classified_noise}`` — ``ts``/``processed_at`` are
        decimal STRINGS so nanosecond precision survives JSON's
        ``Number.MAX_SAFE_INTEGER`` ceiling. Pure read; callers convert
        to whatever internal shape they want.
        """
        params: dict[str, Any] = {"limit": int(limit)}
        if target_matter is not None:
            params["target_matter"] = target_matter
        if source_type is not None:
            params["source_type"] = source_type
        if since_ns is not None:
            params["since"] = str(int(since_ns))
        if until_ns is not None:
            params["until"] = str(int(until_ns))
        resp = await self._client.get("/api/v1/signals", params=params)
        resp.raise_for_status()
        return resp.json().get("results", []) or []

    async def list_observations(
        self,
        *,
        instinct_id: str | None = None,
        signal_id: str | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        """GET /api/v1/observations with filters. Returns the raw JSON rows.

        Wraps the STORE-P3-2 endpoint. Each row carries the SQL columns
        ``{id, ts, signal_id, instinct_id, confidence, embedding_id}`` —
        ``ts`` is a decimal string for the same nanosecond-precision
        reason as ``list_signals``.
        """
        params: dict[str, Any] = {"limit": int(limit)}
        if instinct_id is not None:
            params["instinct_id"] = instinct_id
        if signal_id is not None:
            params["signal_id"] = signal_id
        resp = await self._client.get("/api/v1/observations", params=params)
        resp.raise_for_status()
        return resp.json().get("results", []) or []

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
