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


# Known-deprecated Composio actions get rewritten to their current replacement
# on the fly. Added because dormant tenants (not visiting the Apps page) never
# trigger the dashboard's auto-config migration — see #476.
#
# To retire another action in future: add an entry here with the replacement
# composio_action, composio_args, and pull_mode. The stream-load path will
# PATCH each stream's config in place on first access after deploy.
_DEPRECATED_COMPOSIO_ACTIONS: dict[str, dict[str, Any]] = {
    "NOTION_LIST_PAGES": {
        "composio_action": "NOTION_FETCH_DATA",
        "pull_mode": "snapshot",
        "composio_args": {
            "get_all": False,
            "get_pages": True,
            "get_databases": True,
            "page_size": 50,
        },
    },
    "GITHUB_LIST_NOTIFICATIONS": {
        "composio_action": "GITHUB_LIST_NOTIFICATIONS_FOR_THE_AUTHENTICATED_USER",
    },
}


@activity.defn
async def load_stream_config(stream_id: str) -> dict[str, Any]:
    """Load stream config from ctrl API, auto-migrating deprecated actions.

    Dormant tenants never trigger the dashboard's auto-config migration path,
    so configs pointing at actions Composio has since removed (e.g.
    NOTION_LIST_PAGES) keep 404-ing forever. Catch those here and rewrite
    before handing the config to the pull workflow.
    """
    config = load_config()
    async with _ctrl_client(config) as client:
        resp = await client.get(f"/api/v1/streams/{stream_id}")
        resp.raise_for_status()
        stream_cfg = resp.json().get("stream", {})

        action = stream_cfg.get("composio_action", "")
        rewrite = _DEPRECATED_COMPOSIO_ACTIONS.get(action)
        if rewrite:
            logger.warning(
                "Auto-migrating stream %s: %s → %s",
                stream_id, action, rewrite["composio_action"],
            )
            stream_cfg.update(rewrite)
            # Clear stale cursor state so we start fresh on the new action.
            for k in ("cursor_value", "last_pull_at", "last_pull_status", "last_pull_count"):
                stream_cfg.pop(k, None)
            try:
                patch = await client.patch(
                    f"/api/v1/streams/{stream_id}",
                    json=stream_cfg,
                )
                patch.raise_for_status()
            except Exception as exc:
                # Log and proceed — even if persistence fails, the in-memory
                # config reaches the puller for this invocation. The next
                # pull tries to migrate again.
                logger.warning(
                    "Failed to persist auto-migration for %s: %s", stream_id, exc,
                )

        return stream_cfg


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
async def update_cursor(
    stream_id: str,
    cursor_value: str,
    status: str = "ok",
) -> None:
    """Update stream cursor + last-pull state via PATCH /api/v1/streams/:id.

    `status` must be the real outcome of the upstream pull — "ok" on success,
    "error" / "payload_too_large" / etc. on failure. Previously this was
    hardcoded to "ok" which masked real failures and caused silent data gaps
    (#474).
    """
    config = load_config()
    async with _ctrl_client(config) as client:
        resp = await client.patch(
            f"/api/v1/streams/{stream_id}",
            json={
                "cursor_value": cursor_value,
                "last_pull_at": _now_iso(),
                "last_pull_status": status,
            },
        )
        resp.raise_for_status()


@activity.defn
async def backfill_gmail_as_events(
    stream_id: str,
    user_id: str,
    days: int = 100,
    max_messages: int = 5000,
) -> int:
    """One-time backfill: fetch Gmail history and ingest as proper stream events.

    Unlike the onboarding backfill (which extracted facts), this feeds raw
    full-format emails through the gmail parser → ctrl ingest pipeline,
    so the event processor and curator handle them normally.
    """
    from datetime import datetime, timedelta, timezone

    config = load_config()

    # 1. Get OAuth token
    saas_url = os.environ.get("SAAS_API_URL", "https://alfred.black")
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{saas_url}/api/internal/oauth2/token",
            json={"provider": "google", "userId": user_id},
            headers={"Authorization": "Bearer internal"},
        )
        resp.raise_for_status()
        token = resp.json()["access_token"]

    # 2. Fetch message IDs
    from_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y/%m/%d")
    auth_headers = {"Authorization": f"Bearer {token}"}
    all_ids: list[str] = []
    page_token: str | None = None

    async with httpx.AsyncClient(timeout=60.0) as client:
        while True:
            params: dict[str, Any] = {"maxResults": 100, "q": f"after:{from_date} -in:drafts -in:spam -in:trash -in:chats -category:promotions"}
            if page_token:
                params["pageToken"] = page_token
            resp = await client.get(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages",
                params=params, headers=auth_headers,
            )
            resp.raise_for_status()
            data = resp.json()
            for msg in data.get("messages", []):
                all_ids.append(msg["id"])
            page_token = data.get("nextPageToken")
            if not page_token or len(all_ids) >= max_messages:
                break
            activity.heartbeat(f"Fetched {len(all_ids)} message IDs")

    logger.info("backfill_gmail_as_events: found %d messages in last %d days", len(all_ids), days)

    # 3. Fetch full messages and ingest in batches
    parser = get_parser("gmail")
    ingested = 0
    BATCH = 10

    async with httpx.AsyncClient(timeout=30.0) as gmail_client, _ctrl_client(config) as ctrl:
        for i in range(0, len(all_ids), BATCH):
            batch_ids = all_ids[i:i + BATCH]
            for msg_id in batch_ids:
                try:
                    resp = await gmail_client.get(
                        f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{msg_id}?format=full",
                        headers=auth_headers,
                    )
                    if resp.status_code != 200:
                        continue
                    raw_msg = resp.json()
                    parsed = parser(raw_msg)
                    for event in parsed:
                        ingest_resp = await ctrl.post(
                            "/api/v1/streams/ingest",
                            json={
                                "stream_id": stream_id,
                                "stream_type": "gmail",
                                "source_ref": event.source_ref,
                                "received_at": event.received_at,
                                "raw": event.raw,
                                "summary": event.summary,
                                "metadata": {
                                    **event.metadata,
                                    "event_type": event.event_type,
                                    "parser": "gmail",
                                    "backfill": True,
                                },
                            },
                        )
                        if ingest_resp.status_code in (200, 201):
                            status = ingest_resp.json().get("status", "")
                            if status != "duplicate":
                                ingested += 1
                except Exception as exc:
                    logger.warning("backfill_gmail: failed msg %s: %s", msg_id, exc)
                    continue

            activity.heartbeat(f"Ingested {ingested} emails ({i + len(batch_ids)}/{len(all_ids)})")

    logger.info("backfill_gmail_as_events: ingested %d events from %d messages", ingested, len(all_ids))
    return ingested


@activity.defn
async def composio_pull(
    action_slug: str,
    arguments: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Execute a Composio action as a stream pull source.

    Calls the Composio SDK via the composio_client module to execute the action
    (e.g. GMAIL_FETCH_EMAILS) and returns the raw result dict. The caller
    passes this through the composio parser to extract events.
    """
    from src.integrations.composio_client import execute_action

    args = arguments or {}
    # Inject sensible defaults for known actions that require parameters
    args = {**_default_args(action_slug), **args}
    result = execute_action(action_slug, args)

    if "error" in result and not result.get("data"):
        logger.warning("Composio pull %s returned error: %s", action_slug, result.get("error"))

    activity.heartbeat(f"Composio pull {action_slug} completed")
    return result


# Default arguments for known Composio actions that require parameters.
# Without these, the action returns empty or errors.
_ACTION_DEFAULTS: dict[str, dict[str, Any]] = {
    "GOOGLECALENDAR_EVENTS_LIST": {"calendarId": "primary"},
    "GOOGLECALENDAR_FIND_EVENT": {"calendarId": "primary"},
    "GOOGLECALENDAR_LIST_CALENDARS": {},
    "GMAIL_FETCH_EMAILS": {"userId": "me"},
    "GMAIL_LIST_LABELS": {"userId": "me"},
}


def _default_args(action_slug: str) -> dict[str, Any]:
    """Return default arguments for known actions."""
    return _ACTION_DEFAULTS.get(action_slug, {})


# ---------------------------------------------------------------------------
# Incremental sync configs per Composio action
# ---------------------------------------------------------------------------

SYNC_CONFIGS: dict[str, dict[str, Any]] = {
    "GOOGLECALENDAR_EVENTS_LIST": {
        "pull_mode": "sync",
        "backfill_args": {
            "timeMin": "{backfill_start}",
            "timeMax": "{backfill_end}",
            "maxResults": 2500,
        },
        "incremental_args": {
            "syncToken": "{cursor_value}",
        },
        "cursor_response_field": "nextSyncToken",
        "backfill_past_days": 30,
        "backfill_future_days": 90,
    },
    "GMAIL_FETCH_EMAILS": {
        # Gmail's `after:` operator accepts seconds-since-epoch AND YYYY/MM/DD.
        # We use the timestamp form so 5-minute pulls actually get ~5 minutes
        # of new mail, not everything since midnight. Day-granularity caused
        # snowballing response size → Composio 413 "payload too large" (#474).
        "pull_mode": "append",
        "backfill_args": {
            "query": "after:{backfill_ts} -in:drafts -in:spam -in:trash -in:chats",
            "max_results": 30,
        },
        "incremental_args": {
            "query": "after:{last_pull_ts} -in:drafts -in:spam -in:trash -in:chats",
            "max_results": 30,
        },
        "cursor_response_field": "",
        "backfill_past_days": 30,
    },
    "SLACK_FETCH_CONVERSATION_HISTORY": {
        "pull_mode": "append",
        "backfill_args": {"oldest": "{backfill_ts}", "limit": 200},
        "incremental_args": {"oldest": "{last_pull_ts}", "limit": 200},
        "cursor_response_field": "",
        "backfill_past_days": 7,
    },
    "GITHUB_LIST_NOTIFICATIONS": {
        # Legacy slug — Composio renamed in early 2026. Retained for tenants
        # still on pre-migration configs; new auto-configs pick the new slug.
        "pull_mode": "append",
        "backfill_args": {"since": "{backfill_iso}", "all": True},
        "incremental_args": {"since": "{last_pull_iso}", "all": True},
        "cursor_response_field": "",
        "backfill_past_days": 14,
    },
    "GITHUB_LIST_NOTIFICATIONS_FOR_THE_AUTHENTICATED_USER": {
        "pull_mode": "append",
        "backfill_args": {"since": "{backfill_iso}", "all": True},
        "incremental_args": {"since": "{last_pull_iso}", "all": True},
        "cursor_response_field": "",
        "backfill_past_days": 14,
    },
    "NOTION_LIST_PAGES": {
        # Legacy — Composio removed this action in early 2026. Kept here for
        # tenants still running pre-migration; the auto-config migration path
        # in ctrl-api now rewrites these configs to NOTION_FETCH_DATA.
        "pull_mode": "append",
        "backfill_args": {
            "filter": {"timestamp": "last_edited_time", "last_edited_time": {"after": "{backfill_iso}"}},
        },
        "incremental_args": {
            "filter": {"timestamp": "last_edited_time", "last_edited_time": {"after": "{last_pull_iso}"}},
        },
        "cursor_response_field": "",
        "backfill_past_days": 30,
    },
    "NOTION_FETCH_DATA": {
        # NOTION_FETCH_DATA has no last_edited_time filter — it wraps Notion's
        # /search endpoint which sorts by last_edited_time desc. We run it in
        # snapshot mode and rely on StreamEvent's (streamId, sourceRef) unique
        # index to dedupe across pulls.
        "pull_mode": "snapshot",
        "backfill_args": {"get_all": False, "get_pages": True, "get_databases": True, "page_size": 50},
        "incremental_args": {"get_all": False, "get_pages": True, "get_databases": True, "page_size": 50},
        "cursor_response_field": "",
        "backfill_past_days": 30,
    },
}


@activity.defn
async def build_sync_args(
    action_slug: str,
    cursor_value: str,
    last_pull_at: str,
) -> dict[str, Any]:
    """Compute arguments for an incremental or backfill pull based on sync config."""
    sync_cfg = SYNC_CONFIGS.get(action_slug)
    if not sync_cfg:
        return {}

    pull_mode = sync_cfg.get("pull_mode", "snapshot")

    # Determine if incremental or backfill
    if pull_mode == "sync":
        is_incremental = bool(cursor_value)
    else:  # append
        is_incremental = bool(last_pull_at)

    template = sync_cfg["incremental_args"] if is_incremental else sync_cfg["backfill_args"]
    args = _resolve_placeholders(template, cursor_value, last_pull_at, sync_cfg)
    logger.info(
        "build_sync_args: %s mode=%s incremental=%s args_keys=%s",
        action_slug, pull_mode, is_incremental, list(args.keys()),
    )
    return args


def _resolve_placeholders(
    template: Any,
    cursor_value: str,
    last_pull_at: str,
    sync_cfg: dict[str, Any],
) -> Any:
    """Recursively replace placeholder strings in a template dict/list/str."""
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    past_days = sync_cfg.get("backfill_past_days", 30)
    future_days = sync_cfg.get("backfill_future_days", 0)
    backfill_start = now - timedelta(days=past_days)
    backfill_end = now + timedelta(days=future_days)

    # Parse last_pull_at into datetime for formatting
    lp_dt = now - timedelta(days=1)  # default: 1 day ago
    if last_pull_at:
        try:
            lp_dt = datetime.fromisoformat(last_pull_at.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            pass

    replacements = {
        "{cursor_value}": cursor_value,
        "{last_pull_date}": lp_dt.strftime("%Y/%m/%d"),
        "{last_pull_iso}": lp_dt.isoformat(),
        "{last_pull_ts}": str(int(lp_dt.timestamp())),
        "{backfill_start}": backfill_start.isoformat(),
        "{backfill_end}": backfill_end.isoformat(),
        "{backfill_date}": backfill_start.strftime("%Y/%m/%d"),
        "{backfill_iso}": backfill_start.isoformat(),
        "{backfill_ts}": str(int(backfill_start.timestamp())),
    }

    return _replace_recursive(template, replacements)


def _replace_recursive(value: Any, replacements: dict[str, str]) -> Any:
    """Recursively replace placeholders in nested structures."""
    if isinstance(value, str):
        for placeholder, replacement in replacements.items():
            if placeholder in value:
                # If the entire value is just the placeholder, return the replacement directly
                if value == placeholder:
                    return replacement
                value = value.replace(placeholder, replacement)
        return value
    if isinstance(value, dict):
        return {k: _replace_recursive(v, replacements) for k, v in value.items()}
    if isinstance(value, list):
        return [_replace_recursive(item, replacements) for item in value]
    return value


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
