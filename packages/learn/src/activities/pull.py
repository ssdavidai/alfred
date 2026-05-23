"""Pull engine activities — HTTP fetch, auth resolution, event ingestion."""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config
from src.integrations.composio_client import execute_action
from src.parsers import get_parser

logger = logging.getLogger("alfred-learn")

# #180: Temporal caps an activity result (and argument) at 4MB over gRPC. A
# fresh-inbox GMAIL_FETCH_EMAILS backfill comes back ~4.88MB, so returning the
# raw batch from composio_pull fails respond_activity_task_completed and the
# whole pull errors out with 0 events ingested. When a pull response is at or
# above this threshold AND the caller gave composio_pull a stream context, the
# activity ingests the events itself and returns a small summary instead of the
# batch. 3MB leaves headroom under the 4MB ceiling for envelope + cursor.
_MAX_PULL_RESULT_BYTES = 3_000_000


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
) -> dict[str, int]:
    """Parse raw items and ingest as stream events via POST /api/v1/streams/ingest.

    Returns ``{"ingested": int, "rejected": int}``.

    Cross-tenant ingest guard (defense-in-depth for #408-class leaks): every
    parsed event that carries a Google-shaped identity claim (``self: true``
    attendee on calendar events, owner-email field on Gmail full messages)
    is checked against the tenant's ``OWNER_EMAIL``. A mismatch means the
    upstream OAuth token is scoped to a different Google account — the
    event belongs on someone else's vault and must not be written here.
    Events with no identity claim (e.g. external meeting invites that the
    owner is merely attending, unauthenticated webhook payloads) are always
    allowed through; this guard never false-rejects.

    If ``OWNER_EMAIL`` is unset the guard is skipped entirely so an
    onboarding-in-progress tenant still ingests.
    """
    return await _ingest_raw_items(stream_id, stream_type, parser_name, raw_items)


async def _ingest_raw_items(
    stream_id: str,
    stream_type: str,
    parser_name: str,
    raw_items: list[dict[str, Any]],
) -> dict[str, int]:
    """Core parse-guard-ingest loop shared by ``ingest_events`` (the activity)
    and ``composio_pull`` (which ingests internally when its response is too
    large to return as a Temporal activity result — see #180). Plain async
    function so it can be called from inside another activity without a nested
    ``execute_activity``.
    """
    parser = get_parser(parser_name)
    config = load_config()
    ingested = 0
    rejected = 0
    owner_email = _resolve_owner_email()
    if not owner_email:
        logger.warning(
            "ingest_events: OWNER_EMAIL unset for stream %s — cross-tenant "
            "guard disabled (accepting all events). Set OWNER_EMAIL in the "
            "tenant .env or /alfred-data/onboard.json to enable rejection.",
            stream_id,
        )

    async with _ctrl_client(config) as client:
        for raw_item in raw_items:
            try:
                parsed_events = parser(raw_item)
            except Exception as exc:
                logger.warning("Parser '%s' failed on item: %s", parser_name, exc)
                continue

            for event in parsed_events:
                # Cross-tenant sanity check: drop events whose Google
                # identity claim doesn't match this tenant's owner.
                if owner_email and not _event_belongs_to_owner(event.raw, owner_email):
                    rejected += 1
                    logger.warning(
                        "ingest_events: REJECTED cross-tenant event "
                        "stream=%s parser=%s source_ref=%s owner=%s "
                        "claimed=%s",
                        stream_id,
                        parser_name,
                        event.source_ref,
                        owner_email,
                        _extract_claimed_email(event.raw) or "<unknown>",
                    )
                    continue

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

    return {"ingested": ingested, "rejected": rejected}


# ---------------------------------------------------------------------------
# Cross-tenant ingest guard helpers
# ---------------------------------------------------------------------------

def _resolve_owner_email() -> str:
    """Resolve the tenant owner's canonical email.

    Priority: OWNER_EMAIL env var → /alfred-data/onboard.json
    ("user_email" or "owner_email" keys — neither is canonical today but
    some onboarding variants have set them).

    Returns an empty string when nothing is found. Callers MUST treat an
    empty string as "guard disabled" and accept all events (so a
    provisioning-time bug doesn't also block ingest).
    """
    env_val = (os.environ.get("OWNER_EMAIL") or "").strip()
    if env_val:
        return env_val.lower()

    # Fallback: try onboard.json
    onboard_path = os.environ.get("ONBOARD_PATH", "/alfred-data/onboard.json")
    try:
        import json

        with open(onboard_path, encoding="utf-8") as f:
            data = json.load(f)
        for key in ("owner_email", "user_email"):
            val = (data.get(key) or "").strip() if isinstance(data, dict) else ""
            if val:
                return val.lower()
    except (OSError, ValueError):
        pass
    return ""


def _event_belongs_to_owner(raw: Any, owner_email: str) -> bool:
    """Return False iff ``raw`` makes an identity claim that mismatches ``owner_email``.

    Conservative by design: events with no identity claim always pass. We
    only reject when we find a clear "this event was retrieved as user X"
    marker and X is not the owner.

    Current identity claim shapes:
      - Google Calendar: ``attendees: [{..., self: true, email: X}]``
        (the ``self`` attendee IS the calendar owner from Google's view)
      - Gmail: no per-message identity claim — messages in a mailbox can
        be from/to anyone. Guard is a no-op for Gmail. The wrong-tenant
        failure mode is caught at the OAuth layer (oauthTenantEmailGuard)
        which verifies the connected Google account matches the tenant.
      - Other sources (Slack, GitHub, Notion, webhooks): no identity
        claim → always accept.
    """
    if not isinstance(raw, dict):
        return True
    claimed = _extract_claimed_email(raw)
    if not claimed:
        return True
    return claimed.strip().lower() == owner_email.strip().lower()


def _extract_claimed_email(raw: Any) -> str:
    """Extract the ``self: true`` attendee email from a calendar event.

    Returns an empty string if no such claim is present. Handles both
    the Composio-wrapped shape (attendees under the item) and the raw
    Google Calendar shape.
    """
    if not isinstance(raw, dict):
        return ""
    attendees = raw.get("attendees")
    if not isinstance(attendees, list):
        return ""
    for att in attendees:
        if not isinstance(att, dict):
            continue
        if att.get("self") is True:
            email = att.get("email")
            if isinstance(email, str) and email.strip():
                return email.strip()
    return ""


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


# ---------------------------------------------------------------------------
# Activity: list_due_streams (StreamSweepWorkflow — issue #53)
# ---------------------------------------------------------------------------

# Default pull interval for a stream whose config carries no
# ``schedule_interval_seconds``. Mirrors the 300s default ctrl-api
# stamps on newly-created streams (see streams.ts / integrations.ts).
_DEFAULT_STREAM_INTERVAL_SECONDS = 300


def _stream_pull_due(
    interval_seconds: Any,
    last_pull_at: Any,
    now: datetime,
) -> bool:
    """Return True iff a stream is due for a pull.

    A stream is due when ``now - last_pull_at >= schedule_interval_seconds``.
    A stream that has never been pulled (empty / missing / unparseable
    ``last_pull_at``) is always due — a malformed cursor must never pin a
    stream out of the sweep forever. ``last_pull_at`` round-trips as an
    ISO-8601 string from the stream config; ``Z`` and naive timestamps
    are tolerated.
    """
    try:
        interval = int(interval_seconds)
    except (TypeError, ValueError):
        interval = _DEFAULT_STREAM_INTERVAL_SECONDS
    if interval <= 0:
        interval = _DEFAULT_STREAM_INTERVAL_SECONDS

    if not last_pull_at or not isinstance(last_pull_at, str):
        return True
    s = last_pull_at.strip()
    if not s:
        return True
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return True
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (now - dt).total_seconds() >= interval


@activity.defn
async def list_due_streams(batch_limit: int = 100) -> list[str]:
    """Return the ids of enabled streams that are due for a pull.

    Single ctrl-api ``GET /api/v1/streams`` scan — the list response
    merges each stream's config so ``enabled``,
    ``schedule_interval_seconds`` and ``last_pull_at`` are available
    without an N+1 per-stream fetch. A stream is "due" iff it is enabled
    and ``now - last_pull_at >= schedule_interval_seconds`` (a
    never-pulled stream is always due).

    System streams (``system: true`` — openclaw sessions, inbox) are
    excluded: they have no pull engine, they receive events by push.
    Webhook-type streams are likewise skipped (they have no
    ``schedule_interval_seconds`` / pull config — events arrive via the
    SaaS proxy). The sweep only drives pull-engine streams.

    The returned list is the work set for one ``StreamSweepWorkflow``
    run, capped at ``batch_limit`` streams per tick and returned in
    sorted-id order so the cap is deterministic across ticks (no
    starvation). Streams are far fewer than matters so the cap is mostly
    a defensive ceiling.

    Errors from ctrl-api propagate so Temporal's retry policy can take
    over — better to retry the whole listing than to sweep a partial
    stream set.
    """
    config = load_config()
    async with _ctrl_client(config) as client:
        resp = await client.get("/api/v1/streams")
        resp.raise_for_status()
        streams = resp.json().get("streams", [])

    now = _now_dt()
    due: list[str] = []
    for stream in streams:
        if not isinstance(stream, dict):
            continue
        stream_id = stream.get("id")
        if not stream_id or not isinstance(stream_id, str):
            continue
        # System streams have no pull engine — they are push-fed.
        if stream.get("system") is True:
            continue
        # Webhook streams receive events by push; they carry no
        # schedule_interval_seconds / pull config.
        if stream.get("type") == "webhook":
            continue
        if not stream.get("enabled", False):
            continue
        if _stream_pull_due(
            stream.get("schedule_interval_seconds"),
            stream.get("last_pull_at"),
            now,
        ):
            due.append(stream_id)

    ordered = sorted(due)
    capped = ordered[: max(0, int(batch_limit))]
    logger.info(
        "list_due_streams: due=%d returned=%d (cap=%d)",
        len(ordered), len(capped), batch_limit,
    )
    return capped


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


# ---------------------------------------------------------------------------
# Composio Gmail onboarding backfill (issue #70)
#
# The recurring stream puller drives GMAIL_FETCH_EMAILS through
# ``composio_pull`` + ``SYNC_CONFIGS`` — but that path inherits the
# ``verbose:true`` schema default which Composio caps at ``max_results:30``
# (the #474 artifact). Onboarding needs a 100-day backfill of thousands of
# messages, so it must set ``verbose:false`` explicitly — that unlocks
# ``max_results:500`` and a plain ``nextPageToken`` pagination loop
# (~10 calls / ~90s per 5000 messages, per the epic #66 probe verdict).
#
# These two activities are the Composio variants of the direct-Gmail
# ``fetch_email_metadata`` / ``backfill_gmail_as_events``. They take no
# OAuth token — Composio holds the credential, resolved per-tenant from
# COMPOSIO_USER_ID inside ``execute_action``.
# ---------------------------------------------------------------------------

# Gmail query for the onboarding backfill window. Mirrors the direct-Gmail
# path's filter (drafts/spam/trash/chats excluded); ``-category:promotions``
# is intentionally dropped here because it is a Gmail-UI categorisation that
# the probe did not confirm is honoured under Composio's GMAIL_FETCH_EMAILS.
_COMPOSIO_GMAIL_EXCLUDES = "-in:drafts -in:spam -in:trash -in:chats"

# verbose:false unlocks max_results up to 500 (verbose:true forces 30 — #474).
_COMPOSIO_GMAIL_PAGE_SIZE = 500

# Per-page retry budget for Composio bulk-fetch + Gmail quota flake (#74).
#
# Two failure modes observed in production:
#
#   (a) Composio bulk-fetch flake — one bad message in a 500-batch fails
#       the whole page with ``successful:false``. Transient; retry of the
#       same args within seconds usually succeeds.
#
#   (b) Gmail per-user-per-minute quota exhaustion. Surfaces inside
#       Composio's error envelope sometimes as "HTTP 403: Quota
#       exceeded for ... 'Queries per minute per user'" and sometimes
#       (confusingly) as "Your Gmail connection uses a restricted
#       scope". A retry-storm against an exhausted quota digs the hole
#       deeper — we MUST wait long enough for the per-minute window to
#       roll forward (~60s) before trying again, or we never recover.
#
# 8 attempts with a quota-aware backoff (≥30s when the error looks like
# a quota or scope-mask) gives the per-minute window time to reset
# while still bounding per-page wall time to a few minutes.
_PAGE_MAX_RETRIES = 8
# Tokens we use to recognise "this is really a quota error, back off
# hard" vs "ordinary flake, short retry is fine".
_QUOTA_HINT_TOKENS = ("quota", "rate", "restricted scope", "per minute")


def _composio_gmail_messages(
    raw_response: dict[str, Any],
) -> tuple[list[dict[str, Any]], str, str | None]:
    """Extract (messages, nextPageToken, error) from a GMAIL_FETCH_EMAILS response.

    Composio wraps the Gmail payload at varying nesting depths
    (``data`` / ``data.response_data``).

    Returns:
        (messages, page_token, error)
        - ``error`` is ``None`` on success.
        - ``error`` is a short string when Composio reports
          ``successful: false`` at the top level (e.g. Gmail returned a
          400 fetching one message's metadata — the whole page fails in
          Composio's bulk implementation). Distinguishes a Composio
          failure from a truly empty page so the caller can retry.

    A "truly empty page" — Composio returned ``successful: true`` with
    no messages, i.e. backfill is complete — surfaces as
    ``([], "", None)``.
    """
    if not isinstance(raw_response, dict):
        return [], "", "non-dict response"

    # Composio v3 SDK returns {"successful": bool, "data": {...}, "error": str|None}
    # at the top level. When successful is False the `data` payload is
    # an error envelope, NOT a Gmail page — surface this to the caller
    # instead of silently returning an empty page. Without this check,
    # transient flakiness in Composio's bulk-metadata fetch (Gmail 400
    # on one message → whole page fails) was indistinguishable from a
    # backfill-complete signal and the loop terminated with 0 emails.
    if raw_response.get("successful") is False:
        err = raw_response.get("error")
        if not err:
            data = raw_response.get("data")
            if isinstance(data, dict):
                err = data.get("message") or data.get("error")
        return [], "", str(err or "composio reported successful=false")[:300]

    # Walk the known Composio wrapper shapes to the payload dict.
    payload: Any = raw_response
    for _ in range(3):
        if not isinstance(payload, dict):
            break
        if "messages" in payload or "nextPageToken" in payload:
            break
        nxt = payload.get("data")
        if nxt is None:
            nxt = payload.get("response_data")
        if nxt is None:
            break
        payload = nxt
    if not isinstance(payload, dict):
        return [], "", None
    messages = payload.get("messages")
    if not isinstance(messages, list):
        messages = []
    token = payload.get("nextPageToken") or ""
    return [m for m in messages if isinstance(m, dict)], str(token), None


def _composio_msg_to_email(msg: dict[str, Any]) -> dict[str, Any]:
    """Map one verbose:false GMAIL_FETCH_EMAILS message to the profiler shape.

    The behavioral profiler (src/profiler/features.py) reads onboard.json
    ``emails`` entries by the keys ``from``/``to``/``subject``/``date``/
    ``snippet``/``domain`` — the exact shape the direct-Gmail
    ``fetch_email_metadata`` emits. This adapts Composio's per-message
    fields (``sender``/``to``/``subject``/``messageTimestamp``/
    ``preview.body``) to that shape so the profiler is mode-agnostic.
    """
    sender = str(msg.get("sender") or msg.get("from") or "")
    domain = sender.split("@")[-1].strip(">").strip() if "@" in sender else "unknown"
    preview = msg.get("preview")
    snippet = ""
    if isinstance(preview, dict):
        snippet = str(preview.get("body") or "")
    if not snippet:
        snippet = str(msg.get("snippet") or "")
    return {
        "from": sender,
        "to": str(msg.get("to") or ""),
        "subject": str(msg.get("subject") or ""),
        "date": str(msg.get("messageTimestamp") or msg.get("date") or ""),
        "snippet": snippet,
        "domain": domain,
    }


async def _composio_gmail_pages(
    query: str,
    max_messages: int,
    page_size: int = _COMPOSIO_GMAIL_PAGE_SIZE,
    connected_account_id: str | None = None,
):
    """Yield pages of GMAIL_FETCH_EMAILS messages — the backfill loop.

    A paginated loop: each call passes ``verbose:false`` and
    ``max_results`` and the running ``page_token``; follows
    ``nextPageToken`` and terminates on a truly empty page or when
    ``max_messages`` is reached. ``verbose:false`` is mandatory — it
    is the difference between ``max_results:500`` and the
    ``verbose:true`` 30-cap (#474).

    Composio's GMAIL_FETCH_EMAILS is FLAKY: it fetches each message's
    metadata under the hood, and if Gmail returns a 400 on any one
    message in the batch (an entirely transient, message-specific
    failure observed live), the whole page comes back as
    ``successful:false`` with ``data.error="HTTP 400 error while
    fetching message metadata: ..."``. Without retry handling, the
    parser used to treat that envelope as "empty page" and break the
    loop → onboarding silently received 0 emails and produced a
    no-data brief (#74).

    Retry strategy: per page, attempt up to ``_PAGE_MAX_RETRIES`` with
    exponential backoff. On terminal failure raise ``RuntimeError`` so
    Temporal retries the whole activity (its ``RetryPolicy
    maximum_attempts=3`` covers genuine prolonged Composio outages).
    """
    import asyncio

    page_token = ""
    fetched = 0
    while True:
        args: dict[str, Any] = {
            "userId": "me",
            "query": query,
            "verbose": False,
            "max_results": page_size,
        }
        if page_token:
            args["page_token"] = page_token

        # Per-page retry on Composio bulk-fetch flake. 5 attempts with
        # exponential backoff covers the observed transient failure
        # mode (one bad message in a 500-batch) while still bounding
        # total per-page wall time. When a specific Gmail
        # ``connected_account_id`` is pinned (see below), the flake
        # also includes Composio's auto-routing picking a stale
        # restricted-scope connection — pinning eliminates that
        # variability, so the retry is for genuine transient errors.
        messages: list[dict[str, Any]] = []
        token: str = ""
        last_err: str | None = None
        for attempt in range(1, _PAGE_MAX_RETRIES + 1):
            raw_response = await composio_pull(
                "GMAIL_FETCH_EMAILS",
                args,
                connected_account_id=connected_account_id,
            )
            messages, token, last_err = _composio_gmail_messages(raw_response)
            if last_err is None:
                break
            logger.warning(
                "composio GMAIL_FETCH_EMAILS page attempt %d/%d failed: %s",
                attempt,
                _PAGE_MAX_RETRIES,
                last_err,
            )
            try:
                activity.heartbeat(
                    f"composio gmail page retry {attempt}: {last_err[:80]}"
                )
            except Exception:
                pass
            if attempt < _PAGE_MAX_RETRIES:
                # Quota-aware backoff. If the error looks like a Gmail
                # per-minute-quota cap or a scope-mask of one (Composio
                # collapses both into similar 403 envelopes), wait long
                # enough for the per-user quota window to roll forward
                # (Gmail's window is 60s; we sleep ≥35s with jitter).
                # Anything else gets the short exponential backoff
                # appropriate for transient bulk-fetch flake.
                err_lower = (last_err or "").lower()
                if any(tok in err_lower for tok in _QUOTA_HINT_TOKENS):
                    delay = 35 + (attempt * 5)  # 40, 45, 50, … capped below
                else:
                    delay = min(1.5 ** attempt, 30)
                delay = min(delay, 90)
                # Heartbeat through the sleep so Temporal's heartbeat
                # timeout (60s in the calling activity) doesn't fire while
                # we wait out a quota window. A naive ``await asyncio.sleep
                # (delay)`` of 40-90s used to kill the activity at the 60s
                # mark, turning a recoverable quota dip into a workflow
                # failure (#74).
                slept = 0.0
                while slept < delay:
                    step = min(10.0, delay - slept)
                    await asyncio.sleep(step)
                    slept += step
                    try:
                        activity.heartbeat(
                            f"composio gmail backoff: waited {slept:.0f}/{delay:.0f}s "
                            f"after attempt {attempt}"
                        )
                    except Exception:
                        pass

        if last_err is not None:
            # All retries exhausted — surface the failure to Temporal
            # so the activity-level RetryPolicy can take a fresh swing
            # (or, after that's also exhausted, the workflow fails
            # loudly rather than silently producing a no-data brief).
            raise RuntimeError(
                "composio GMAIL_FETCH_EMAILS failed after "
                f"{_PAGE_MAX_RETRIES} page-level retries: {last_err}"
            )

        page_token = token
        if not messages:
            # Truly empty page (Composio said ok, no messages) — backfill done.
            break
        yield messages
        fetched += len(messages)
        try:
            activity.heartbeat(f"composio gmail: fetched {fetched} messages")
        except Exception:
            pass
        if not page_token or fetched >= max_messages:
            break


@activity.defn
async def composio_fetch_email_metadata(user_id: str) -> dict[str, Any]:
    """Composio variant of ``fetch_email_metadata`` (onboarding Stage 1).

    Backfills the last 100 days of Gmail through Composio's managed OAuth
    (no Google token needed) and writes the email corpus to onboard.json
    in the same shape the direct-Gmail path produces, so the behavioral
    profiler and the Opus stages are mode-agnostic.

    ``user_id`` is accepted for activity-signature parity with the direct
    path but is unused — Composio resolves the credential from the
    tenant's COMPOSIO_USER_ID.

    The activity resolves and PINS the active Gmail
    ``connected_account_id`` before the page loop. Without pinning,
    Composio's auto-routing across stale historical connections
    intermittently picks one with restricted scope and the action
    fails with 403 "Your Gmail connection uses a restricted scope" —
    so the whole backfill silently returned 0 emails (#74).
    """
    from datetime import datetime, timedelta, timezone

    from src.integrations.composio_client import resolve_active_connected_account_id

    from_date = (datetime.now(timezone.utc) - timedelta(days=100)).strftime("%Y/%m/%d")
    query = f"after:{from_date} {_COMPOSIO_GMAIL_EXCLUDES}"

    conn_id = resolve_active_connected_account_id("gmail")
    if conn_id:
        logger.info("composio_fetch_email_metadata: pinned gmail connection %s", conn_id)
    else:
        logger.warning(
            "composio_fetch_email_metadata: no active gmail connection — "
            "falling back to auto-routing (may flake on restricted-scope)"
        )

    emails: list[dict[str, Any]] = []
    async for page in _composio_gmail_pages(
        query, max_messages=5000, connected_account_id=conn_id
    ):
        for msg in page:
            emails.append(_composio_msg_to_email(msg))
            if len(emails) >= 5000:
                break
        if len(emails) >= 5000:
            break

    # Per-day sample BEFORE handing the corpus to downstream Opus
    # stages. The pre-sample 5000-cap above stays as defense-in-depth
    # against a pathological single day; see ``_email_sampling`` for
    # the rationale (Hermes context-window overflow, 2026-05-23).
    from src.activities._email_sampling import sample_emails_per_day
    emails = sample_emails_per_day(emails)

    by_domain: dict[str, int] = {}
    for e in emails:
        by_domain[e["domain"]] = by_domain.get(e["domain"], 0) + 1

    logger.info(
        "composio_fetch_email_metadata: fetched %d emails from %d domains",
        len(emails), len(by_domain),
    )

    # Write emails directly to onboard.json — same contract as the direct
    # path (5000 emails exceeds Temporal's 4MB activity-result limit).
    import json

    onboard_path = os.environ.get("ONBOARD_PATH", "/alfred-data/onboard.json")
    try:
        with open(onboard_path, encoding="utf-8") as f:
            onboard = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        onboard = {}
    if not isinstance(onboard.get("progress"), dict):
        onboard["progress"] = {"current_day": 0, "total_days": 0, "facts_count": 0, "patterns_count": 0}
    onboard["emails"] = emails
    onboard["top_domains"] = sorted(by_domain.items(), key=lambda x: -x[1])[:30]
    onboard["progress"]["current_day"] = len(emails)
    onboard["progress"]["total_days"] = len(emails)
    onboard["progress"]["messages_read"] = len(emails)
    os.makedirs(os.path.dirname(onboard_path), exist_ok=True)
    with open(onboard_path, "w", encoding="utf-8") as f:
        json.dump(onboard, f, indent=2)

    # Live butler narration of the real inbox for the onboarding "reading the
    # room" screen — one cheap pass through Hermes (workers gateway). Best
    # effort: never blocks or fails the fetch.
    try:
        from src.activities.inbox_narration import generate_inbox_narration

        narration = await generate_inbox_narration(emails)
        if narration:
            onboard["narration"] = narration
            with open(onboard_path, "w", encoding="utf-8") as f:
                json.dump(onboard, f, indent=2)
    except Exception as e:  # noqa: BLE001
        logger.warning("composio_fetch_email_metadata: narration skipped: %s", e)

    return {"count": len(emails), "domains": len(by_domain)}


@activity.defn
async def composio_backfill_gmail_as_events(
    stream_id: str,
    user_id: str,
    days: int = 100,
    max_messages: int = 5000,
) -> int:
    """Composio variant of ``backfill_gmail_as_events`` (onboarding background).

    Same paginated GMAIL_FETCH_EMAILS loop as
    ``composio_fetch_email_metadata``, but feeds each message through the
    ``composio`` parser → ctrl ``/streams/ingest`` so the event processor
    and curator handle them normally. Takes no Google token — Composio
    holds the credential.
    """
    from datetime import datetime, timedelta, timezone

    from src.integrations.composio_client import resolve_active_connected_account_id

    config = load_config()
    parser = get_parser("composio")

    from_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y/%m/%d")
    query = f"after:{from_date} {_COMPOSIO_GMAIL_EXCLUDES}"

    # Same pin as composio_fetch_email_metadata above — the background
    # backfill hits Composio's auto-routing flake (#74) identically.
    conn_id = resolve_active_connected_account_id("gmail")
    if conn_id:
        logger.info(
            "composio_backfill_gmail_as_events: pinned gmail connection %s",
            conn_id,
        )

    ingested = 0
    seen = 0
    async with _ctrl_client(config) as ctrl:
        async for page in _composio_gmail_pages(
            query, max_messages=max_messages, connected_account_id=conn_id
        ):
            for msg in page:
                seen += 1
                try:
                    for event in parser(msg):
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
                                    "parser": "composio",
                                    "backfill": True,
                                },
                            },
                        )
                        if ingest_resp.status_code in (200, 201):
                            status = ingest_resp.json().get("status", "")
                            if status != "duplicate":
                                ingested += 1
                except Exception as exc:
                    logger.warning("composio_backfill_gmail: failed msg: %s", exc)
                    continue
            try:
                activity.heartbeat(f"composio backfill: ingested {ingested}/{seen}")
            except Exception:
                pass
            if seen >= max_messages:
                break

    logger.info(
        "composio_backfill_gmail_as_events: ingested %d events from %d messages",
        ingested, seen,
    )
    return ingested


@activity.defn
async def composio_pull(
    action_slug: str,
    arguments: dict[str, Any] | None = None,
    connected_account_id: str | None = None,
    stream_id: str | None = None,
    stream_type: str | None = None,
    parser_name: str | None = None,
) -> dict[str, Any]:
    """Execute a Composio action as a stream pull source.

    Calls the Composio SDK via the composio_client module to execute the action
    (e.g. GMAIL_FETCH_EMAILS) and returns the raw result dict. The caller
    passes this through the composio parser to extract events.

    ``connected_account_id`` pins a specific connection — required for
    Gmail to defeat Composio's flaky auto-routing across multiple
    historical connections (#74).

    ``stream_id`` / ``stream_type`` / ``parser_name`` give the activity a
    stream context so it can self-ingest an oversized response (#180). When
    they are provided AND the raw response is at/above ``_MAX_PULL_RESULT_BYTES``
    (the fresh-inbox backfill case), the activity ingests the events here and
    returns a small summary instead of the ~5MB batch — which Temporal would
    otherwise reject as too large for an activity result. Small responses (the
    common incremental pull) are returned verbatim and the workflow ingests
    them via ``ingest_events`` exactly as before.

    The underlying ``execute_action`` is a SYNCHRONOUS SDK call — it
    blocks the event loop for the duration of the Composio HTTP
    request (5-30 seconds for a 500-message GMAIL_FETCH_EMAILS page,
    occasionally longer when Composio's bulk-metadata fetch hits a
    slow Gmail response). With the call running directly on the
    activity's event loop, the heartbeat coroutine couldn't run and
    Temporal's 60s heartbeat_timeout fired even though the activity
    was making forward progress. Run it on a worker thread via
    ``asyncio.to_thread`` so the event loop stays free to heartbeat.
    """
    import asyncio
    import json

    args = arguments or {}
    # Inject sensible defaults for known actions that require parameters
    args = {**_default_args(action_slug), **args}
    result = await asyncio.to_thread(
        execute_action,
        action_slug,
        args,
        connected_account_id=connected_account_id,
    )

    if "error" in result and not result.get("data"):
        logger.warning("Composio pull %s returned error: %s", action_slug, result.get("error"))

    activity.heartbeat(f"Composio pull {action_slug} completed")

    # #180: bound the activity-result size. If this would exceed Temporal's
    # gRPC limit, ingest the batch here and hand the workflow a summary.
    if stream_id and isinstance(result, dict):
        try:
            raw_size = len(json.dumps(result).encode("utf-8"))
        except (TypeError, ValueError):
            raw_size = 0
        if raw_size >= _MAX_PULL_RESULT_BYTES:
            counts = await _ingest_raw_items(
                stream_id,
                stream_type or "composio",
                parser_name or "composio",
                [result],
            )
            logger.info(
                "composio_pull %s: response %d bytes >= %d — self-ingested %s "
                "in-activity to stay under Temporal's 4MB result limit (#180)",
                action_slug, raw_size, _MAX_PULL_RESULT_BYTES, counts,
            )
            # Return a bounded envelope: keep the status/error/cursor surface
            # the workflow inspects (_classify_composio_response, _is_sync_reset,
            # _extract_sync_cursor) but drop the bulky payload lists.
            return _summarize_pull_result(result, counts)

    return result


# Payload keys that hold the bulky per-item batch — stripped from an
# oversized response so the summary the workflow gets stays tiny while the
# cursor/continuation tokens beside them survive.
_BULK_PAYLOAD_KEYS = ("messages", "events", "results", "items", "data_list")


def _summarize_pull_result(
    result: dict[str, Any], counts: dict[str, int]
) -> dict[str, Any]:
    """Strip the bulky item lists out of a Composio response, preserving the
    status/error/cursor scaffolding the StreamPuller workflow reads. Marks the
    envelope ``_ingested`` so the workflow skips a redundant ingest."""
    def _strip(node: Any) -> Any:
        if isinstance(node, dict):
            return {
                k: ("<ingested>" if k in _BULK_PAYLOAD_KEYS else _strip(v))
                for k, v in node.items()
            }
        return node

    summary = _strip(result)
    if not isinstance(summary, dict):
        summary = {}
    summary["_ingested"] = {
        "ingested": counts.get("ingested", 0),
        "rejected": counts.get("rejected", 0),
    }
    return summary


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
    return _now_dt().isoformat()


def _now_dt() -> datetime:
    """Return the current UTC time as a timezone-aware datetime."""
    return datetime.now(timezone.utc)
