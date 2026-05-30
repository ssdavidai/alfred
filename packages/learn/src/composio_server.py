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
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

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
    """
    try:
        result = await asyncio.to_thread(
            execute_action,
            req.action,
            req.arguments,
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
