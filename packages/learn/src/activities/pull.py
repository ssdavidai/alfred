"""Pull engine activities — HTTP fetch, auth resolution, event ingestion."""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config
from src.parsers import get_parser

logger = logging.getLogger("alfred-learn")


@activity.defn
async def load_stream_config(stream_id: str) -> dict[str, Any]:
    """Load stream config from ctrl API (GET /api/v1/streams/:id)."""
    config = load_config()
    async with _ctrl_client(config) as client:
        resp = await client.get(f"/api/v1/streams/{stream_id}")
        resp.raise_for_status()
        return resp.json().get("stream", {})


@activity.defn
async def resolve_auth_header(auth_config: dict[str, Any]) -> dict[str, str]:
    """Resolve auth header from config. Returns dict of headers to inject.

    Supports:
    - "none": no auth
    - "static": uses auth_config.header_name + auth_config.header_value
    - "bearer": uses auth_config.token
    - "oauth2": calls SaaS internal endpoint for token refresh
    """
    auth_type = auth_config.get("auth_type", "none")

    if auth_type == "none":
        return {}

    if auth_type == "static":
        header_name = auth_config.get("header_name", "Authorization")
        header_value = auth_config.get("header_value", "")
        if header_value:
            return {header_name: header_value}
        return {}

    if auth_type == "bearer":
        token = auth_config.get("token", "")
        if token:
            return {"Authorization": f"Bearer {token}"}
        return {}

    if auth_type == "oauth2":
        # Call SaaS internal endpoint to get fresh OAuth2 token.
        # The SaaS stores encrypted refresh tokens and handles auto-refresh.
        saas_url = os.environ.get("SAAS_API_URL", "https://alfred.black")
        provider = auth_config.get("provider", "")
        user_id = auth_config.get("user_id", "")

        if not provider:
            logger.warning("OAuth2 auth_config missing provider, skipping auth")
            return {}

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{saas_url}/api/internal/oauth2/token",
                    json={
                        "provider": provider,
                        "userId": user_id,
                    },
                    headers={"Authorization": f"Bearer internal"},
                )
                resp.raise_for_status()
                data = resp.json()
                access_token = data.get("access_token", "")
                if access_token:
                    logger.info("OAuth2 token resolved for provider=%s", provider)
                    return {"Authorization": f"Bearer {access_token}"}
        except Exception as exc:
            logger.error("OAuth2 token refresh failed: %s", exc)
            raise

        return {}

    logger.warning("Unknown auth_type: %s", auth_type)
    return {}


@activity.defn
async def http_pull(
    endpoint: str,
    method: str,
    headers: dict[str, str],
    params: dict[str, str],
) -> dict[str, Any]:
    """Generic HTTP fetch — pull data from an external API."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.request(
            method=method.upper(),
            url=endpoint,
            headers=headers,
            params=params if method.upper() == "GET" else None,
            json=params if method.upper() != "GET" else None,
        )
        resp.raise_for_status()
        return resp.json()


@activity.defn
async def http_pull_detail(
    detail_endpoint: str,
    ids: list[str],
    headers: dict[str, str],
) -> list[dict[str, Any]]:
    """Fetch individual items by ID (for list->get patterns like Gmail)."""
    results: list[dict[str, Any]] = []

    async with httpx.AsyncClient(timeout=60.0) as client:
        for item_id in ids:
            # Replace {id} placeholder in detail endpoint
            url = detail_endpoint.replace("{id}", str(item_id))
            try:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                results.append(resp.json())
            except Exception as exc:
                logger.warning("Detail fetch failed for %s: %s", item_id, exc)
                continue

    return results


@activity.defn
async def notion_fetch_blocks(page_id: str, auth_headers: dict) -> list[dict]:
    """Fetch all blocks (content) for a Notion page."""
    blocks = []
    cursor = None
    headers = {**auth_headers, "Notion-Version": "2022-06-28"}
    async with httpx.AsyncClient(timeout=30.0) as client:
        while True:
            url = f"https://api.notion.com/v1/blocks/{page_id}/children"
            params = {"page_size": "100"}
            if cursor:
                params["start_cursor"] = cursor
            resp = await client.get(url, headers=headers, params=params)
            if resp.status_code != 200:
                logger.warning("Notion block fetch failed for page %s: %s", page_id, resp.status_code)
                break
            data = resp.json()
            blocks.extend(data.get("results", []))
            if not data.get("has_more"):
                break
            cursor = data.get("next_cursor")
    return blocks


@activity.defn
async def ingest_events(
    stream_id: str,
    stream_type: str,
    parser_name: str,
    raw_items: list[dict[str, Any]],
) -> int:
    """Parse raw items and ingest as stream events via POST /api/v1/streams/ingest."""
    parser = get_parser(parser_name)
    config = load_config()
    ingested = 0

    async with _ctrl_client(config) as client:
        for raw_item in raw_items:
            try:
                parsed_events = parser(raw_item)
            except Exception as exc:
                logger.warning("Parser '%s' failed on item: %s", parser_name, exc)
                continue

            for event in parsed_events:
                try:
                    resp = await client.post(
                        "/api/v1/streams/ingest",
                        json={
                            "stream_id": stream_id,
                            "stream_type": stream_type,
                            "source_ref": event.source_ref,
                            "received_at": event.received_at,
                            "raw": event.raw,
                            "summary": event.summary,
                            "metadata": {
                                **event.metadata,
                                "event_type": event.event_type,
                                "parser": parser_name,
                            },
                        },
                    )
                    if resp.status_code in (200, 201):
                        status = resp.json().get("status", "")
                        if status != "duplicate":
                            ingested += 1
                except Exception as exc:
                    logger.warning("Ingest failed for %s: %s", event.source_ref, exc)
                    continue

    return ingested


@activity.defn
async def update_cursor(stream_id: str, cursor_value: str) -> None:
    """Update stream cursor via PATCH /api/v1/streams/:id."""
    config = load_config()
    async with _ctrl_client(config) as client:
        resp = await client.patch(
            f"/api/v1/streams/{stream_id}",
            json={
                "cursor_value": cursor_value,
                "last_pull_at": _now_iso(),
                "last_pull_status": "ok",
            },
        )
        resp.raise_for_status()


def _ctrl_client(config: Any) -> httpx.AsyncClient:
    """Create an authenticated httpx client for the ctrl API."""
    import os

    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    return httpx.AsyncClient(
        base_url=config.alfred_ctrl_url,
        timeout=30.0,
        headers=headers,
    )


def _now_iso() -> str:
    """Return current UTC time as ISO string."""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
