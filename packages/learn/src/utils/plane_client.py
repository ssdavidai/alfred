"""Async client for Plane self-hosted REST API.

Wraps /api/v1/workspaces/{slug}/projects and related endpoints. Token
auth via Personal Access Token (PAT). Callers provide the workspace
slug and PAT via env vars or config.

Env vars (all optional if passed explicitly at construction):
  PLANE_API_URL        — Base URL of the Plane instance  (default: http://plane-api:8000)
  PLANE_API_TOKEN      — Personal Access Token
  PLANE_WORKSPACE_SLUG — Workspace slug (e.g. "alfred-workspace")
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

import httpx

logger = logging.getLogger("alfred-learn")

_DEFAULT_BASE_URL = "http://plane-api:8000"


class PlaneClient:
    """Async HTTP client for the Plane REST API.

    Mirrors the shape of VaultClient — construct once, reuse across
    activity calls, call ``close()`` in the activity's finally block.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        workspace_slug: Optional[str] = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("PLANE_API_URL", _DEFAULT_BASE_URL)).rstrip("/")
        self.token = token or os.environ.get("PLANE_API_TOKEN", "")
        self.workspace_slug = workspace_slug or os.environ.get("PLANE_WORKSPACE_SLUG", "")
        self._client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=30.0,
                headers={
                    "x-api-key": self.token,
                    "Content-Type": "application/json",
                },
            )
        return self._client

    async def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    # ── Internal helpers ────────────────────────────────────────────────────

    def _ws(self) -> str:
        """Workspace path prefix."""
        return f"/api/v1/workspaces/{self.workspace_slug}"

    def _proj(self, project_id: str) -> str:
        """Project path prefix."""
        return f"{self._ws()}/projects/{project_id}"

    async def _get(self, path: str, params: Optional[dict[str, Any]] = None) -> Any:
        client = await self._get_client()
        r = await client.get(path, params=params)
        r.raise_for_status()
        return r.json()

    async def _post(self, path: str, json: dict[str, Any]) -> Any:
        client = await self._get_client()
        r = await client.post(path, json=json)
        r.raise_for_status()
        return r.json()

    async def _patch(self, path: str, json: dict[str, Any]) -> Any:
        client = await self._get_client()
        r = await client.patch(path, json=json)
        r.raise_for_status()
        return r.json()

    async def _delete(self, path: str) -> None:
        client = await self._get_client()
        r = await client.delete(path)
        r.raise_for_status()

    # ── Projects (≈ matters) ────────────────────────────────────────────────

    async def list_projects(self) -> list[dict[str, Any]]:
        """GET /api/v1/workspaces/{slug}/projects/

        Returns all projects in the workspace (paginated responses are
        unwrapped — Plane returns a flat list by default).
        """
        data = await self._get(f"{self._ws()}/projects/")
        # Plane may return {"results": [...]} or a bare list depending on version
        if isinstance(data, dict):
            return data.get("results", [])
        return data  # type: ignore[return-value]

    async def create_project(
        self,
        name: str,
        identifier: str,
        description: str = "",
    ) -> dict[str, Any]:
        """POST /api/v1/workspaces/{slug}/projects/

        ``identifier`` must be ≤ 12 characters, uppercase alphanumeric.
        ``network=2`` means secret (visible only to members).
        """
        payload: dict[str, Any] = {
            "name": name,
            "identifier": identifier[:12].upper(),
            "description_text": description,
            "network": 2,
        }
        return await self._post(f"{self._ws()}/projects/", json=payload)

    async def update_project(
        self, project_id: str, patch: dict[str, Any]
    ) -> dict[str, Any]:
        """PATCH /api/v1/workspaces/{slug}/projects/{id}/"""
        return await self._patch(f"{self._proj(project_id)}/", json=patch)

    async def archive_project(self, project_id: str) -> None:
        """POST /api/v1/workspaces/{slug}/projects/{id}/archive/

        Archives the project (sets is_archived=true). Plane does not
        expose a DELETE for projects — archive is the intended close action.
        """
        client = await self._get_client()
        r = await client.post(f"{self._proj(project_id)}/archive/")
        # 200 or 204 both indicate success
        if r.status_code not in (200, 204):
            r.raise_for_status()

    # ── Issues (≈ tasks) ─────────────────────────────────────────────────────

    async def list_issues(
        self,
        project_id: str,
        external_id: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """GET /api/v1/workspaces/{slug}/projects/{id}/issues/

        Pass ``external_id`` to filter to the single issue Alfred created
        for a given vault task path. Plane stores it under ``external_id``
        + ``external_source="alfred"``.
        """
        params: dict[str, Any] = {}
        if external_id:
            params["external_id"] = external_id
            params["external_source"] = "alfred"
        data = await self._get(f"{self._proj(project_id)}/issues/", params=params)
        if isinstance(data, dict):
            return data.get("results", [])
        return data  # type: ignore[return-value]

    async def create_issue(
        self,
        project_id: str,
        *,
        name: str,
        description: str = "",
        priority: str = "none",
        state_id: Optional[str] = None,
        label_ids: Optional[list[str]] = None,
        external_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """POST /api/v1/workspaces/{slug}/projects/{id}/issues/

        ``label_ids`` must be resolved UUIDs — use ``ensure_label()``
        before calling this method. ``external_id`` is the vault task
        path used to correlate back on webhook events.
        """
        body: dict[str, Any] = {
            "name": name,
            "description_html": description,
            "priority": priority,
        }
        if state_id:
            body["state"] = state_id
        if label_ids:
            body["labels"] = label_ids
        if external_id:
            body["external_id"] = external_id
            body["external_source"] = "alfred"
        return await self._post(f"{self._proj(project_id)}/issues/", json=body)

    async def update_issue(
        self,
        project_id: str,
        issue_id: str,
        patch: dict[str, Any],
    ) -> dict[str, Any]:
        """PATCH /api/v1/workspaces/{slug}/projects/{id}/issues/{issue_id}/"""
        return await self._patch(f"{self._proj(project_id)}/issues/{issue_id}/", json=patch)

    async def delete_issue(self, project_id: str, issue_id: str) -> None:
        """DELETE /api/v1/workspaces/{slug}/projects/{id}/issues/{issue_id}/"""
        await self._delete(f"{self._proj(project_id)}/issues/{issue_id}/")

    # ── States (per-project, for status mapping) ────────────────────────────

    async def list_states(self, project_id: str) -> list[dict[str, Any]]:
        """GET /api/v1/workspaces/{slug}/projects/{id}/states/

        Plane creates five default states at project creation time, one
        per state-group (backlog / unstarted / started / completed /
        cancelled). Use ``resolve_state_id()`` for the common look-up.
        """
        data = await self._get(f"{self._proj(project_id)}/states/")
        if isinstance(data, dict):
            return data.get("results", [])
        return data  # type: ignore[return-value]

    async def resolve_state_id(
        self, project_id: str, state_group: str
    ) -> Optional[str]:
        """Return the state UUID for the given group in this project.

        Plane guarantees at least one state per group on new projects.
        Returns ``None`` only if no state with that group exists (should
        not happen on a freshly created project).
        """
        states = await self.list_states(project_id)
        for s in states:
            if s.get("group") == state_group:
                return s.get("id")
        logger.warning(
            "plane: no state found for group=%s in project=%s", state_group, project_id
        )
        return None

    # ── Labels ──────────────────────────────────────────────────────────────

    async def list_labels(self, project_id: str) -> list[dict[str, Any]]:
        """GET /api/v1/workspaces/{slug}/projects/{id}/labels/"""
        data = await self._get(f"{self._proj(project_id)}/labels/")
        if isinstance(data, dict):
            return data.get("results", [])
        return data  # type: ignore[return-value]

    async def ensure_label(self, project_id: str, name: str) -> str:
        """Return label UUID for ``name``, creating it if missing.

        Idempotent — safe to call on every sync without accumulating
        duplicate labels.
        """
        for lb in await self.list_labels(project_id):
            if lb.get("name") == name:
                label_id: str = lb["id"]
                return label_id
        result = await self._post(
            f"{self._proj(project_id)}/labels/",
            json={"name": name},
        )
        return result["id"]

    async def ensure_labels(
        self, project_id: str, names: list[str]
    ) -> list[str]:
        """Batch version of ``ensure_label``. Returns list of UUIDs in
        the same order as ``names``.
        """
        # Fetch once, resolve locally to minimise round-trips
        existing = {lb["name"]: lb["id"] for lb in await self.list_labels(project_id)}
        ids: list[str] = []
        for name in names:
            if name in existing:
                ids.append(existing[name])
            else:
                result = await self._post(
                    f"{self._proj(project_id)}/labels/",
                    json={"name": name},
                )
                existing[name] = result["id"]
                ids.append(result["id"])
        return ids

    # ── Comments ────────────────────────────────────────────────────────────

    async def create_comment(
        self, project_id: str, issue_id: str, text: str
    ) -> dict[str, Any]:
        """POST /api/v1/workspaces/{slug}/projects/{id}/issues/{issue_id}/comments/

        ``text`` is treated as HTML — wrap plain text in ``<p>`` tags if
        needed, or pass HTML directly.
        """
        return await self._post(
            f"{self._proj(project_id)}/issues/{issue_id}/comments/",
            json={"comment_html": text},
        )

    # ── Webhooks (admin — for provisioner) ──────────────────────────────────

    async def register_webhook(
        self,
        url: str,
        secret: str,
        events: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        """POST /api/v1/workspaces/{slug}/webhooks/

        Registers a webhook for this workspace. ``events`` is accepted
        for forward-compat but Plane's current API enables event types
        via boolean flags in the payload, not an array.

        Returns the created webhook object including its server-generated
        ``secret`` (use that for HMAC validation, not the one you passed).
        """
        payload: dict[str, Any] = {
            "url": url,
            "is_active": True,
            "project": True,
            "issue": True,
            "issue_comment": True,
            "cycle": True,
            "module": True,
        }
        return await self._post(f"{self._ws()}/webhooks/", json=payload)

    async def list_webhooks(self) -> list[dict[str, Any]]:
        """GET /api/v1/workspaces/{slug}/webhooks/"""
        data = await self._get(f"{self._ws()}/webhooks/")
        if isinstance(data, dict):
            return data.get("results", [])
        return data  # type: ignore[return-value]

    async def delete_webhook(self, webhook_id: str) -> None:
        """DELETE /api/v1/workspaces/{slug}/webhooks/{id}/"""
        await self._delete(f"{self._ws()}/webhooks/{webhook_id}/")
