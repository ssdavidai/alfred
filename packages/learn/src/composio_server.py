"""Composio HTTP sidecar.

A small FastAPI app embedded inside the alfred-learn container that
replaces the ``docker exec alfred-learn python3 -c <script>`` shell-out
ctrl-api previously used for every Composio call. The shell-out paid
~4.5s per call to spin up Python + import the Composio SDK; the sidecar
pays that once at process boot and then serves each call in ~300-500ms.

Surface:

    GET  /health                   → {"ok": true}
    POST /composio/execute         → result of execute_action(...)

The endpoint contract mirrors what ctrl-api already constructed in its
Python script literal:

    {
      "action": "GMAIL_FETCH_EMAILS",
      "arguments": {...},
      "user_id": "alfred-<slug>",
      "connected_account_id": "ca_..."
    }

The response is the raw ``execute_action`` return value (a dict). When
``execute_action`` itself returns an error envelope ({"error": "...",
"action": "..."}) we keep the HTTP status at 200 — that's the same shape
the shell-out path returned and ctrl-api already understands it.

For *transport* errors (bad JSON, exception inside the activity) we
return HTTP 500 with a structured envelope:

    {"error": {"code": "...", "message": "...", "type": "..."}}

Run via uvicorn from entrypoint.sh:

    uvicorn src.composio_server:app --host 0.0.0.0 --port 8788 &
    exec python -m src.worker

Binds to all interfaces because ctrl-api reaches it via Docker DNS
(``http://alfred-learn:8788``); the alfred-learn container only exposes
its ports inside the per-tenant docker network.

------------------------------------------------------------------------

Phase C — primary-entity defaults cache.

Before each ``/composio/execute`` we ask ctrl-api what default args are
cached for ``(toolkit, user_id)``. If anything is cached (e.g. Sir's
primary Google calendar id under ``googlecalendar``), we merge those
defaults *under* the LLM-supplied arguments so the agent's request still
overrides if it explicitly named a calendar. This short-cuts the "what's
on my calendar tomorrow" fanout: Hermes' single
GOOGLECALENDAR_EVENTS_LIST gets ``calendarId: <primary>`` injected and
hits the right calendar in one shot.

The lookup is cached for ``CTRL_DEFAULTS_TTL_SECONDS`` (default 300s) per
(toolkit, user_id) so a flurry of executes inside one Hermes turn don't
each hit ctrl-api. Failures are logged + swallowed — the execute still
goes through with the LLM-supplied args verbatim (== pre-Phase-C
behaviour).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

logger = logging.getLogger("composio-server")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

# IMPORTANT: do NOT import composio_client at module top — it lazily loads
# the Composio SDK on first call. Importing here is fine because the import
# itself is cheap; the SDK init only happens when _get_client() runs.
from src.integrations.composio_client import execute_action  # noqa: E402


# ---------------------------------------------------------------------------
# Singleton warm-up via lifespan
# ---------------------------------------------------------------------------
# The latency win comes from keeping the Composio SDK client warm in process
# memory. ``composio_client._get_client()`` already memoises the instance in
# its module-global ``_composio_instance``. We call it once at startup so the
# first real ``/composio/execute`` request doesn't pay the cold init.

@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """Prime the Composio SDK client so the first request is fast."""
    try:
        # Import lazily — _get_client touches env vars and raises if
        # COMPOSIO_API_KEY isn't set. We don't want startup to crash the
        # sidecar in that case (the rest of alfred-learn keeps running);
        # we just defer the work until the first request.
        from src.integrations.composio_client import _get_client

        if os.environ.get("COMPOSIO_API_KEY"):
            await asyncio.to_thread(_get_client)
            logger.info("composio sdk warmed at startup")
        else:
            logger.warning(
                "COMPOSIO_API_KEY unset — skipping warm-up (will init on first request)"
            )
    except Exception as exc:  # noqa: BLE001 — keep startup resilient
        logger.warning("composio warm-up failed (will retry per-request): %s", exc)
    yield


app = FastAPI(title="alfred-learn composio sidecar", version="1.0", lifespan=_lifespan)


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class ExecuteRequest(BaseModel):
    action: str = Field(..., description="Composio action slug, e.g. GMAIL_FETCH_EMAILS")
    arguments: dict[str, Any] = Field(default_factory=dict)
    user_id: str | None = Field(default=None, description="Composio user_id; defaults to env")
    connected_account_id: str | None = Field(default=None)


# ---------------------------------------------------------------------------
# Phase C — defaults lookup
# ---------------------------------------------------------------------------
#
# Toolkit derivation matches the convention ctrl-api uses elsewhere
# (action_slug.split('_')[0].lower()). For Composio action names like
# ``GOOGLECALENDAR_EVENTS_LIST`` or ``GMAIL_FETCH_EMAILS`` the first
# underscore-delimited segment IS the toolkit slug — confirmed in
# packages/ctrl/src/api/routes/integrations.ts where the execute route
# uses the same rule.

CTRL_API_URL = os.environ.get("CTRL_API_URL", "http://alfred-ctrl-api:3100")
CTRL_API_KEY = os.environ.get("AAS_API_KEY", "")
CTRL_DEFAULTS_TTL_SECONDS = int(os.environ.get("COMPOSIO_DEFAULTS_TTL_SECONDS", "300"))

# Process-local cache: (toolkit, user_id) -> (expires_at_epoch, defaults_dict)
_defaults_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
_defaults_cache_lock = asyncio.Lock()


def derive_toolkit_from_action(action_slug: str) -> str:
    """Pull the toolkit slug out of an action name.

    ``GOOGLECALENDAR_EVENTS_LIST`` → ``googlecalendar``
    ``GMAIL_FETCH_EMAILS`` → ``gmail``
    ``NOTION_CREATE_PAGE`` → ``notion``

    Returns lowercase. Empty string if the action has no underscore.
    """
    if not action_slug:
        return ""
    head = action_slug.split("_", 1)[0]
    return head.lower()


async def fetch_user_defaults(toolkit: str, user_id: str) -> dict[str, Any]:
    """Fetch cached default args from ctrl-api with a process-local TTL.

    Returns an empty dict on any failure — execute_action then proceeds
    with only the LLM-supplied args (== pre-Phase-C behaviour). We DO
    NOT block the request on ctrl-api availability.
    """
    if not toolkit or not user_id:
        return {}
    key = (toolkit, user_id)
    now = time.monotonic()
    async with _defaults_cache_lock:
        cached = _defaults_cache.get(key)
        if cached and cached[0] > now:
            return cached[1]

    url = f"{CTRL_API_URL}/api/v1/integrations/defaults"
    headers = {}
    if CTRL_API_KEY:
        headers["Authorization"] = f"Bearer {CTRL_API_KEY}"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(2.5)) as client:
            resp = await client.get(
                url,
                params={"toolkit": toolkit, "user_id": user_id},
                headers=headers,
            )
        if resp.status_code != 200:
            logger.warning(
                "defaults lookup non-200 (%s) for toolkit=%s user_id=%s",
                resp.status_code,
                toolkit,
                user_id,
            )
            return {}
        body = resp.json()
        defaults = body.get("defaults") or {}
        if not isinstance(defaults, dict):
            defaults = {}
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning(
            "defaults lookup failed for toolkit=%s user_id=%s: %s", toolkit, user_id, exc
        )
        defaults = {}

    async with _defaults_cache_lock:
        _defaults_cache[key] = (now + CTRL_DEFAULTS_TTL_SECONDS, defaults)
    return defaults


def _invalidate_defaults_cache() -> None:
    """Clear the in-process TTL cache. Exposed for tests + future admin route."""
    _defaults_cache.clear()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health() -> dict[str, Any]:
    """Cheap liveness probe used by ctrl-api + tests."""
    return {"ok": True, "service": "composio-sidecar"}


@app.post("/composio/execute")
async def composio_execute(req: ExecuteRequest) -> JSONResponse:
    """Execute a Composio action via the warm SDK client.

    The blocking SDK call runs in a worker thread (``asyncio.to_thread``)
    so concurrent requests don't serialize on the event loop. The Composio
    SDK is thread-safe for execute_action calls (each call constructs its
    own httpx request).

    Phase C: cached primary-entity defaults are merged in under the
    LLM-supplied arguments. The agent's explicit args always win (e.g. if
    the LLM names a non-primary calendar, we don't overwrite it with the
    primary id).
    """
    try:
        toolkit = derive_toolkit_from_action(req.action)
        defaults: dict[str, Any] = {}
        if toolkit and req.user_id:
            defaults = await fetch_user_defaults(toolkit, req.user_id)

        # LLM args override cached defaults.
        merged_args: dict[str, Any] = {**defaults, **(req.arguments or {})}
        if defaults:
            logger.info(
                "merged defaults toolkit=%s user_id=%s keys=%s",
                toolkit,
                req.user_id,
                sorted(defaults.keys()),
            )

        result = await asyncio.to_thread(
            execute_action,
            req.action,
            merged_args,
            req.user_id,
            req.connected_account_id,
        )
        return JSONResponse(content=result, status_code=200)
    except Exception as exc:  # noqa: BLE001
        # Transport-layer failure (not a Composio-side error — those land
        # inside the result dict and we pass through with 200). Surface a
        # structured envelope so ctrl-api can attach a useful message.
        logger.exception("composio_execute crashed: %s", exc)
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "COMPOSIO_SIDECAR_ERROR",
                    "message": str(exc)[:500],
                    "type": type(exc).__name__,
                }
            },
        )
