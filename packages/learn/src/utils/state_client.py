"""HTTP client for alfred-ctrl's ``state.db`` API (Phase 2, #26/#27).

``state.db`` is Store 2 of the four-store architecture (PLAN.md Part I)
— the machine's working memory: a single SQLite file (WAL +
sqlite-vec) owned exclusively by ctrl-api. **ctrl-api is the only
process with a write handle.** ``alfred-learn`` writes through this
HTTP client, exactly the way vault writes go through ``VaultClient``.

What lives in ``state.db`` instead of the markdown vault:

  * ``signal``           — machine-extracted signals (was ``vault/signal/``)
  * ``observation``      — passive observations (was ``vault/observation/``)
  * ``routing_decision`` — routing audit (renamed from the vault's
                           principal-facing ``decision/`` to avoid a
                           name collision)
  * ``audit``            — every signal-action / steward-action /
                           desk-action / state-change record
  * ``link``             — the cross-record graph edge
  * ``embedding``        — sqlite-vec vector store (vault semantic recall)

The promotion contract (PLAN.md Part I): *a record exists in the vault
only if the principal has a reason to read or edit it; everything else
is SQLite.* These record types are demoted here.

All endpoints are under ``/api/v1/state/*`` on ctrl-api (built in
Phase 1). Auth is the same ``AAS_API_KEY`` bearer token as
``VaultClient``.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from src.config import Config


class StateClient:
    """Async HTTP client wrapping alfred-ctrl's ``/api/v1/state/*`` API.

    One client per logical unit of work; call :meth:`close` (or use it
    as an async context manager) when done. Mirrors ``VaultClient``'s
    construction so activities can swap between the two without
    surprises.
    """

    def __init__(
        self, config: Config, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._base = config.alfred_ctrl_url
        api_key = os.environ.get("AAS_API_KEY", "")
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._client = httpx.AsyncClient(
            base_url=self._base, timeout=30.0, headers=headers, transport=transport
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "StateClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    # ── signal ──────────────────────────────────────────────────────

    async def create_signal(
        self,
        *,
        kind: str,
        source: str,
        headline: str,
        body: str | None = None,
        ts: str | None = None,
        stream_event_id: str | None = None,
        entity_ref: str | None = None,
        matter_ref: str | None = None,
        salience: float | None = None,
        status: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> str:
        """Insert a ``signal`` row. Returns the ULID assigned by ctrl-api.

        ``kind``/``source``/``headline`` are required by the endpoint;
        everything else is optional. ``payload`` round-trips as JSON
        (``payload_json`` column) and is the right home for the rich
        signal fields that have no dedicated column (target_*, effect_*,
        proposals, reasoning, …).
        """
        json_body: dict[str, Any] = {
            "kind": kind,
            "source": source,
            "headline": headline,
        }
        if body is not None:
            json_body["body"] = body
        if ts is not None:
            json_body["ts"] = ts
        if stream_event_id is not None:
            json_body["stream_event_id"] = stream_event_id
        if entity_ref is not None:
            json_body["entity_ref"] = entity_ref
        if matter_ref is not None:
            json_body["matter_ref"] = matter_ref
        if salience is not None:
            json_body["salience"] = salience
        if status is not None:
            json_body["status"] = status
        if payload is not None:
            json_body["payload"] = payload
        resp = await self._client.post("/api/v1/state/signals", json=json_body)
        resp.raise_for_status()
        return resp.json()["id"]

    async def get_signal(self, signal_id: str) -> dict[str, Any]:
        """Fetch a single ``signal`` row by id."""
        resp = await self._client.get(f"/api/v1/state/signals/{signal_id}")
        resp.raise_for_status()
        return resp.json()

    async def list_signals(
        self,
        *,
        status: str | None = None,
        kind: str | None = None,
        matter: str | None = None,
        source: str | None = None,
        since: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        """List ``signal`` rows, newest first. Returns the ``signals`` array.

        ``since`` is an ISO timestamp lower bound on ``ts`` — the right
        primitive for "recent signals" queries (the brief composer and
        pattern detection use it instead of walking ``vault/signal/``).
        """
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if kind is not None:
            params["kind"] = kind
        if matter is not None:
            params["matter"] = matter
        if source is not None:
            params["source"] = source
        if since is not None:
            params["since"] = since
        if limit is not None:
            params["limit"] = limit
        resp = await self._client.get("/api/v1/state/signals", params=params)
        resp.raise_for_status()
        return resp.json().get("signals", [])

    async def update_signal(
        self,
        signal_id: str,
        *,
        status: str | None = None,
        salience: float | None = None,
        headline: str | None = None,
        body: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        """PATCH a ``signal`` row. Only supplied fields are updated."""
        json_body: dict[str, Any] = {}
        if status is not None:
            json_body["status"] = status
        if salience is not None:
            json_body["salience"] = salience
        if headline is not None:
            json_body["headline"] = headline
        if body is not None:
            json_body["body"] = body
        if payload is not None:
            json_body["payload"] = payload
        if not json_body:
            return
        resp = await self._client.patch(
            f"/api/v1/state/signals/{signal_id}", json=json_body
        )
        resp.raise_for_status()

    # ── observation ─────────────────────────────────────────────────

    async def create_observation(
        self,
        *,
        subject: str,
        kind: str,
        summary: str,
        detail: str | None = None,
        ts: str | None = None,
        decision_ref: str | None = None,
        instinct_ref: str | None = None,
        confidence: float | None = None,
        status: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> str:
        """Insert an ``observation`` row. Returns the ULID.

        ``subject``/``kind``/``summary`` are required. The rich
        observation body (routing_decision, signals, considered
        alternatives, …) belongs in ``payload``.
        """
        json_body: dict[str, Any] = {
            "subject": subject,
            "kind": kind,
            "summary": summary,
        }
        if detail is not None:
            json_body["detail"] = detail
        if ts is not None:
            json_body["ts"] = ts
        if decision_ref is not None:
            json_body["decision_ref"] = decision_ref
        if instinct_ref is not None:
            json_body["instinct_ref"] = instinct_ref
        if confidence is not None:
            json_body["confidence"] = confidence
        if status is not None:
            json_body["status"] = status
        if payload is not None:
            json_body["payload"] = payload
        resp = await self._client.post(
            "/api/v1/state/observations", json=json_body
        )
        resp.raise_for_status()
        return resp.json()["id"]

    async def get_observation(self, observation_id: str) -> dict[str, Any]:
        """Fetch a single ``observation`` row by id."""
        resp = await self._client.get(
            f"/api/v1/state/observations/{observation_id}"
        )
        resp.raise_for_status()
        return resp.json()

    async def list_observations(
        self,
        *,
        kind: str | None = None,
        subject: str | None = None,
        status: str | None = None,
        since: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        """List ``observation`` rows, newest first."""
        params: dict[str, Any] = {}
        if kind is not None:
            params["kind"] = kind
        if subject is not None:
            params["subject"] = subject
        if status is not None:
            params["status"] = status
        if since is not None:
            params["since"] = since
        if limit is not None:
            params["limit"] = limit
        resp = await self._client.get(
            "/api/v1/state/observations", params=params
        )
        resp.raise_for_status()
        return resp.json().get("observations", [])

    async def update_observation(
        self,
        observation_id: str,
        *,
        status: str | None = None,
        confidence: float | None = None,
        summary: str | None = None,
        detail: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        """PATCH an ``observation`` row. Only supplied fields are updated."""
        json_body: dict[str, Any] = {}
        if status is not None:
            json_body["status"] = status
        if confidence is not None:
            json_body["confidence"] = confidence
        if summary is not None:
            json_body["summary"] = summary
        if detail is not None:
            json_body["detail"] = detail
        if payload is not None:
            json_body["payload"] = payload
        if not json_body:
            return
        resp = await self._client.patch(
            f"/api/v1/state/observations/{observation_id}", json=json_body
        )
        resp.raise_for_status()

    # ── routing_decision ────────────────────────────────────────────

    async def create_routing_decision(
        self,
        *,
        tier: str,
        chosen_path: str,
        ts: str | None = None,
        signal_id: str | None = None,
        agent: str | None = None,
        instinct_ref: str | None = None,
        discretion: float | None = None,
        reason: str | None = None,
        outcome: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> str:
        """Insert a ``routing_decision`` row. Returns the ULID.

        ``tier``/``chosen_path`` are required. ``signal_id`` ties the
        decision back to the ``signal`` row it routed.
        """
        json_body: dict[str, Any] = {
            "tier": tier,
            "chosen_path": chosen_path,
        }
        if ts is not None:
            json_body["ts"] = ts
        if signal_id is not None:
            json_body["signal_id"] = signal_id
        if agent is not None:
            json_body["agent"] = agent
        if instinct_ref is not None:
            json_body["instinct_ref"] = instinct_ref
        if discretion is not None:
            json_body["discretion"] = discretion
        if reason is not None:
            json_body["reason"] = reason
        if outcome is not None:
            json_body["outcome"] = outcome
        if payload is not None:
            json_body["payload"] = payload
        resp = await self._client.post(
            "/api/v1/state/routing-decisions", json=json_body
        )
        resp.raise_for_status()
        return resp.json()["id"]

    async def get_routing_decision(self, decision_id: str) -> dict[str, Any]:
        """Fetch a single ``routing_decision`` row by id."""
        resp = await self._client.get(
            f"/api/v1/state/routing-decisions/{decision_id}"
        )
        resp.raise_for_status()
        return resp.json()

    async def list_routing_decisions(
        self,
        *,
        tier: str | None = None,
        signal_id: str | None = None,
        outcome: str | None = None,
        chosen_path: str | None = None,
        since: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        """List ``routing_decision`` rows, newest first."""
        params: dict[str, Any] = {}
        if tier is not None:
            params["tier"] = tier
        if signal_id is not None:
            params["signal_id"] = signal_id
        if outcome is not None:
            params["outcome"] = outcome
        if chosen_path is not None:
            params["chosen_path"] = chosen_path
        if since is not None:
            params["since"] = since
        if limit is not None:
            params["limit"] = limit
        resp = await self._client.get(
            "/api/v1/state/routing-decisions", params=params
        )
        resp.raise_for_status()
        return resp.json().get("routing_decisions", [])

    async def update_routing_decision(
        self,
        decision_id: str,
        *,
        outcome: str | None = None,
        reason: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        """PATCH a ``routing_decision`` row."""
        json_body: dict[str, Any] = {}
        if outcome is not None:
            json_body["outcome"] = outcome
        if reason is not None:
            json_body["reason"] = reason
        if payload is not None:
            json_body["payload"] = payload
        if not json_body:
            return
        resp = await self._client.patch(
            f"/api/v1/state/routing-decisions/{decision_id}", json=json_body
        )
        resp.raise_for_status()

    # ── audit ───────────────────────────────────────────────────────

    async def append_audit(
        self,
        *,
        action_type: str,
        actor: str,
        summary: str,
        ts: str | None = None,
        source: str | None = None,
        target_path: str | None = None,
        target_kind: str | None = None,
        subject_ref: str | None = None,
        changes: Any | None = None,
        mode: str | None = None,
        confidence: float | None = None,
        undo: Any | None = None,
        payload: Any | None = None,
    ) -> str:
        """Append an ``audit`` row. Returns the audit id.

        This is the home for every demoted action record:
        ``signal-action`` / ``steward-action`` / ``desk-action`` /
        ``state-change`` / ``needs_attention_action``. ``action_type``
        carries that distinction; ``mode`` is ``live`` or ``shadow``.
        """
        json_body: dict[str, Any] = {
            "action_type": action_type,
            "actor": actor,
            "summary": summary,
        }
        if ts is not None:
            json_body["ts"] = ts
        if source is not None:
            json_body["source"] = source
        if target_path is not None:
            json_body["target_path"] = target_path
        if target_kind is not None:
            json_body["target_kind"] = target_kind
        if subject_ref is not None:
            json_body["subject_ref"] = subject_ref
        if changes is not None:
            json_body["changes"] = changes
        if mode is not None:
            json_body["mode"] = mode
        if confidence is not None:
            json_body["confidence"] = confidence
        if undo is not None:
            json_body["undo"] = undo
        if payload is not None:
            json_body["payload"] = payload
        resp = await self._client.post("/api/v1/state/audit", json=json_body)
        resp.raise_for_status()
        return resp.json()["id"]

    async def get_audit(self, audit_id: str) -> dict[str, Any]:
        """Fetch a single ``audit`` row by id."""
        resp = await self._client.get(f"/api/v1/state/audit/{audit_id}")
        resp.raise_for_status()
        return resp.json()

    async def list_audit(
        self,
        *,
        action_type: str | None = None,
        actor: str | None = None,
        source: str | None = None,
        target: str | None = None,
        subject: str | None = None,
        mode: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> dict[str, Any]:
        """List ``audit`` rows, newest first.

        Returns the full envelope ``{entries, total, limit, offset}``
        because the audit endpoint is paginated (the ledger can be
        large). Callers that only want the rows take ``["entries"]``.
        """
        params: dict[str, Any] = {}
        if action_type is not None:
            params["action_type"] = action_type
        if actor is not None:
            params["actor"] = actor
        if source is not None:
            params["source"] = source
        if target is not None:
            params["target"] = target
        if subject is not None:
            params["subject"] = subject
        if mode is not None:
            params["mode"] = mode
        if since is not None:
            params["since"] = since
        if until is not None:
            params["until"] = until
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        resp = await self._client.get("/api/v1/state/audit", params=params)
        resp.raise_for_status()
        return resp.json()

    # ── link ────────────────────────────────────────────────────────

    async def create_link(
        self,
        *,
        src_ref: str,
        dst_ref: str,
        rel: str,
        ts: str | None = None,
        weight: float | None = None,
        payload: dict[str, Any] | None = None,
    ) -> str:
        """Insert a graph ``link`` edge. Idempotent on (src, dst, rel) —
        a duplicate edge returns the existing id rather than erroring."""
        json_body: dict[str, Any] = {
            "src_ref": src_ref,
            "dst_ref": dst_ref,
            "rel": rel,
        }
        if ts is not None:
            json_body["ts"] = ts
        if weight is not None:
            json_body["weight"] = weight
        if payload is not None:
            json_body["payload"] = payload
        resp = await self._client.post("/api/v1/state/links", json=json_body)
        resp.raise_for_status()
        return resp.json()["id"]

    async def list_links(
        self,
        *,
        src: str | None = None,
        dst: str | None = None,
        rel: str | None = None,
        ref: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        """List graph ``link`` edges.

        ``ref`` matches either endpoint — "all edges touching X".
        """
        params: dict[str, Any] = {}
        if src is not None:
            params["src"] = src
        if dst is not None:
            params["dst"] = dst
        if rel is not None:
            params["rel"] = rel
        if ref is not None:
            params["ref"] = ref
        if limit is not None:
            params["limit"] = limit
        resp = await self._client.get("/api/v1/state/links", params=params)
        resp.raise_for_status()
        return resp.json().get("links", [])

    async def delete_link(self, link_id: str) -> None:
        """Delete a graph ``link`` edge by id."""
        resp = await self._client.delete(f"/api/v1/state/links/{link_id}")
        resp.raise_for_status()

    # ── embedding (sqlite-vec) ──────────────────────────────────────

    async def upsert_embedding(
        self,
        *,
        ref: str,
        embedding: list[float],
        ref_kind: str | None = None,
        chunk_index: int | None = None,
        ts: str | None = None,
        model: str | None = None,
        text_preview: str | None = None,
    ) -> dict[str, Any]:
        """Store (or re-store) a vector in the sqlite-vec ``embedding`` table.

        Re-embedding the same (``ref``, ``chunk_index``) replaces the
        prior vector. ``embedding`` must be a float array of the store's
        configured dimension; ctrl-api validates the length.

        Returns ``{ok, rowid, ref}``. Raises ``httpx.HTTPStatusError``
        with status 503 if the sqlite-vec extension is not loaded —
        callers that treat embeddings as best-effort should catch that.
        """
        json_body: dict[str, Any] = {"ref": ref, "embedding": embedding}
        if ref_kind is not None:
            json_body["ref_kind"] = ref_kind
        if chunk_index is not None:
            json_body["chunk_index"] = chunk_index
        if ts is not None:
            json_body["ts"] = ts
        if model is not None:
            json_body["model"] = model
        if text_preview is not None:
            json_body["text_preview"] = text_preview
        resp = await self._client.post(
            "/api/v1/state/embeddings", json=json_body
        )
        resp.raise_for_status()
        return resp.json()

    async def search_embeddings(
        self,
        *,
        embedding: list[float],
        k: int | None = None,
        ref_kind: str | None = None,
    ) -> list[dict[str, Any]]:
        """k-NN vector search over the sqlite-vec ``embedding`` table.

        This is the QMD replacement (PLAN.md Part F risk 4 / Part I
        "QMD convergence"): vault semantic recall is a vector search
        against ``state.db`` instead of a runtime-bundled memory store.
        Returns rows ``{rowid, ref, ref_kind, ts, model, chunk_index,
        text_preview, distance}`` ordered by ascending distance
        (closest first).
        """
        json_body: dict[str, Any] = {"embedding": embedding}
        if k is not None:
            json_body["k"] = k
        if ref_kind is not None:
            json_body["ref_kind"] = ref_kind
        resp = await self._client.post(
            "/api/v1/state/embeddings/search", json=json_body
        )
        resp.raise_for_status()
        return resp.json().get("results", [])

    async def delete_embeddings(self, ref: str) -> int:
        """Delete every embedding chunk for a ``ref``. Returns the count."""
        resp = await self._client.delete(
            "/api/v1/state/embeddings", params={"ref": ref}
        )
        resp.raise_for_status()
        return int(resp.json().get("deleted", 0))
