"""hermes-shim — residual OpenClaw `/tools/invoke` compatibility + `/v1` proxy.

One instance per Hermes profile. Binds the legacy OpenClaw gateway port
(``main`` → :18789, ``workers`` → :18790) — the only port the Hermes runtime
exposes on the compose network, because the Hermes API server itself binds
``127.0.0.1`` inside the container.

Phase 1 of the OpenClaw→Hermes swap re-exposed the *entire* OpenClaw
``sessions_*`` surface here so callers needed zero diffs. Subsequent phases
retired all of it:

  * ``learn`` (clerk.py / ephemeral_agent.py) and the ``alfred`` vault-daemon
    ``openclaw-wrapper`` were rewritten to call Hermes ``/v1/runs`` natively.
  * The ``sessions_spawn`` / ``sessions_history`` / ``sessions_delete`` /
    ``sessions_send`` handlers were **removed** — nothing speaks them anymore.
  * ``sessions_list`` was **removed** (issue #39): it existed only so ctrl-api
    could resolve a delivery target from a shim-owned run→channel registry.
    ctrl-api now reads the native Hermes gateway session index
    (``profiles/<p>/sessions/sessions.json``) directly — see ctrl-api
    ``api/hermes-sessions.ts``. The shim no longer keeps any session state.

What this shim still does:

    /v1/*  (any method)         transparent reverse proxy → the Hermes API
                                server. This is what every native caller
                                (openclaw-wrapper, clerk, ephemeral_agent,
                                ctrl-api crossTenant/channelsEmail) now uses.
    POST /tools/invoke
        message                 no-op acknowledgement — channel delivery is
                                native to the Hermes gateway; autonomous code
                                reaches the principal via ctrl-api →
                                alfred__notify_principal.
    GET /health, /healthz       proxy Hermes GET /health.

Auth: every inbound request is validated against the *legacy* bearer token
(the value of ``/alfred-data/.gateway-token``). The shim then calls Hermes
with ``HERMES_API_KEY`` (the same token, kept as a separate concept so the
two can diverge later).

Environment:
    HERMES_SHIM_PROFILE       "main" | "workers"            (required)
    HERMES_SHIM_PORT          legacy port to bind            (default per profile)
    HERMES_SHIM_HOST          bind address                   (default 0.0.0.0)
    HERMES_API_URL            Hermes API server base URL     (default per profile)
    HERMES_API_KEY            Bearer key for the Hermes API server
    HERMES_GATEWAY_TOKEN_FILE legacy token file              (default /alfred-data/.gateway-token)
"""

from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

logging.basicConfig(
    level=os.environ.get("HERMES_SHIM_LOG_LEVEL", "INFO"),
    format="%(asctime)s [hermes-shim] %(levelname)s %(message)s",
)
log = logging.getLogger("hermes-shim")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PROFILE = os.environ.get("HERMES_SHIM_PROFILE", "main").strip().lower()
if PROFILE not in ("main", "workers"):
    raise SystemExit(f"HERMES_SHIM_PROFILE must be 'main' or 'workers', got {PROFILE!r}")

# Legacy OpenClaw ports — what the shim binds and what callers already hit.
_LEGACY_PORT = {"main": 18789, "workers": 18790}[PROFILE]
# Internal Hermes API server ports — what the shim forwards to.
_HERMES_PORT = {"main": 18799, "workers": 18800}[PROFILE]

SHIM_HOST = os.environ.get("HERMES_SHIM_HOST", "0.0.0.0")
SHIM_PORT = int(os.environ.get("HERMES_SHIM_PORT", str(_LEGACY_PORT)))

HERMES_API_URL = os.environ.get(
    "HERMES_API_URL", f"http://127.0.0.1:{_HERMES_PORT}"
).rstrip("/")
HERMES_API_KEY = os.environ.get("HERMES_API_KEY", "")

GATEWAY_TOKEN_FILE = os.environ.get(
    "HERMES_GATEWAY_TOKEN_FILE", "/alfred-data/.gateway-token"
)


# ---------------------------------------------------------------------------
# Legacy token validation
# ---------------------------------------------------------------------------

def _read_legacy_token() -> str:
    """Read the gateway token from disk on every call.

    Read fresh (not cached) because the init container regenerates the file
    and the shim must not pin a stale value across a container restart.
    """
    try:
        with open(GATEWAY_TOKEN_FILE, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def _consteq(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    result = 0
    for x, y in zip(a, b):
        result |= ord(x) ^ ord(y)
    return result == 0


def _check_auth(authorization: str | None) -> None:
    """Validate the inbound Authorization header against the legacy token.

    Fails closed: if the token file is missing/empty the shim rejects every
    request rather than running unauthenticated.
    """
    expected = _read_legacy_token()
    if not expected:
        log.error("legacy gateway token file is missing or empty: %s", GATEWAY_TOKEN_FILE)
        raise HTTPException(status_code=503, detail="gateway token not provisioned")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    presented = authorization[len("Bearer "):].strip()
    if not _consteq(presented, expected):
        raise HTTPException(status_code=401, detail="invalid gateway token")


# ---------------------------------------------------------------------------
# Application lifespan — shared HTTP client
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(
        base_url=HERMES_API_URL,
        headers={"Authorization": f"Bearer {HERMES_API_KEY}"},
        timeout=httpx.Timeout(60.0, read=120.0),
    )
    log.info(
        "hermes-shim up — profile=%s bind=%s:%d → hermes=%s",
        PROFILE, SHIM_HOST, SHIM_PORT, HERMES_API_URL,
    )
    try:
        yield
    finally:
        await app.state.http.aclose()


app = FastAPI(title="hermes-shim", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Envelope helpers — reproduce the OpenClaw double-encoded result shape.
# Only the `message` no-op still uses this; native /v1 callers do not.
# ---------------------------------------------------------------------------

def _envelope(payload: dict[str, Any]) -> dict[str, Any]:
    """Wrap a payload in the OpenClaw `/tools/invoke` response envelope."""
    return {
        "result": {
            "content": [
                {"type": "text", "text": json.dumps(payload)}
            ]
        }
    }


def _error_envelope(message: str) -> dict[str, Any]:
    return _envelope({"error": True, "message": message})


# ---------------------------------------------------------------------------
# /v1 transparent proxy — the native surface every Phase-2 caller uses.
# ---------------------------------------------------------------------------

# Hop-by-hop headers must not be forwarded across the proxy boundary.
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}


@app.api_route(
    "/v1/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
)
async def v1_proxy(
    path: str,
    request: Request,
    authorization: str | None = Header(default=None),
) -> Response:
    """Transparent reverse proxy for the Hermes `/v1/*` API.

    The Hermes API server binds 127.0.0.1 inside the container; the shim is
    the only thing on the compose network in front of it. Native callers
    (`openclaw-wrapper`, `clerk.py`, `ephemeral_agent.py`,
    ctrl-api `crossTenant`/`channelsEmail`) issue plain `/v1/runs` requests
    against the shim port and the shim forwards them verbatim — auth
    swapped from the legacy token to HERMES_API_KEY.
    """
    _check_auth(authorization)

    body = await request.body()
    fwd_headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _HOP_BY_HOP and k.lower() != "authorization"
    }
    client: httpx.AsyncClient = app.state.http
    req = client.build_request(
        request.method,
        f"/v1/{path}",
        content=body if body else None,
        params=dict(request.query_params),
        headers=fwd_headers,
    )
    try:
        upstream = await client.send(req, stream=True)
    except httpx.RequestError as exc:
        log.error("/v1 proxy: hermes unreachable: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"error": True, "message": f"hermes API unreachable: {exc}"},
        )

    resp_headers = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in _HOP_BY_HOP
    }
    ctype = upstream.headers.get("content-type", "")

    # Server-Sent Events (GET /v1/runs/{id}/events) — re-stream chunk by
    # chunk so the dashboard chat renders tokens live, not in one burst.
    if "text/event-stream" in ctype:
        async def _passthru():
            try:
                async for chunk in upstream.aiter_bytes():
                    yield chunk
            finally:
                await upstream.aclose()
        return StreamingResponse(
            _passthru(),
            status_code=upstream.status_code,
            headers=resp_headers,
            media_type="text/event-stream",
        )

    # Non-streaming — buffer the body and return it verbatim.
    try:
        content = await upstream.aread()
    finally:
        await upstream.aclose()
    return Response(
        content=content,
        status_code=upstream.status_code,
        headers=resp_headers,
        media_type=ctype or None,
    )


# ---------------------------------------------------------------------------
# Residual /tools/invoke handler — the `message` no-op only.
# ---------------------------------------------------------------------------

async def _handle_message(app: FastAPI, args: dict[str, Any]) -> dict[str, Any]:
    """message → no-op acknowledgement.

    `message` was OpenClaw's outbound channel-delivery primitive. Under Hermes
    channel delivery is native to the gateway; autonomous code that needs to
    reach the principal goes through ctrl-api → alfred__notify_principal. We
    acknowledge the call so any legacy caller does not hard-fail; the delivery
    itself is a no-op here.
    """
    log.info("message tool invoked — acknowledged as no-op (channel delivery is native)")
    return _envelope(
        {
            "delivered": False,
            "noop": True,
            "reason": "channel delivery is native to the Hermes gateway",
        }
    )


_TOOL_HANDLERS = {
    "message": _handle_message,
}

# Tools retired during the OpenClaw→Hermes swap — callers were rewritten to
# native surfaces. A clear 410 (instead of a generic 400) tells anything still
# calling them exactly what happened.
_RETIRED_TOOLS = {
    "sessions_spawn": "rewritten to POST /v1/runs",
    "sessions_history": "rewritten to GET /v1/runs/{id}",
    "sessions_delete": "rewritten to POST /v1/runs/{id}/stop",
    "sessions_send": "rewritten to POST /v1/runs (same session_id)",
    "sessions_list": (
        "removed in issue #39 — ctrl-api reads the native Hermes gateway "
        "session index (profiles/<p>/sessions/sessions.json) directly"
    ),
}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/tools/invoke")
async def tools_invoke(
    request: Request,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """Residual OpenClaw tool-dispatch endpoint — the `message` no-op only.

    Body: {"tool": "<name>", "args": {...}}
    """
    _check_auth(authorization)

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="body must be JSON")

    tool = body.get("tool")
    args = body.get("args") or {}
    if not isinstance(args, dict):
        raise HTTPException(status_code=400, detail="`args` must be an object")

    if tool in _RETIRED_TOOLS:
        raise HTTPException(
            status_code=410,
            detail=(
                f"tool {tool!r} was retired in Phase 2 — {_RETIRED_TOOLS[tool]}. "
                f"Call the Hermes /v1 API through the shim instead."
            ),
        )

    handler = _TOOL_HANDLERS.get(tool)
    if handler is None:
        raise HTTPException(status_code=400, detail=f"unsupported tool: {tool!r}")

    try:
        payload = await handler(app, args)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — last-resort guard
        log.exception("unhandled error on %s", tool)
        return JSONResponse(
            status_code=500,
            content=_error_envelope(f"shim error: {exc}"),
        )

    return JSONResponse(content=payload)


@app.get("/health")
@app.get("/healthz")
async def health() -> JSONResponse:
    """Proxy the Hermes API server's health endpoint.

    The shim reports healthy only when Hermes behind it is healthy — so a
    compose HEALTHCHECK against the legacy port reflects the real runtime.
    """
    client: httpx.AsyncClient = app.state.http
    try:
        resp = await client.get("/health", timeout=5.0)
        hermes_ok = resp.status_code == 200
    except Exception as exc:  # noqa: BLE001
        log.warning("health: hermes unreachable: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"status": "degraded", "profile": PROFILE, "hermes": "unreachable"},
        )
    if not hermes_ok:
        return JSONResponse(
            status_code=503,
            content={"status": "degraded", "profile": PROFILE, "hermes": resp.status_code},
        )
    return JSONResponse(content={"status": "ok", "profile": PROFILE, "hermes": "ok"})


def main() -> None:
    import uvicorn

    uvicorn.run(
        app,
        host=SHIM_HOST,
        port=SHIM_PORT,
        log_config=None,  # keep our own logging format
        access_log=False,
    )


if __name__ == "__main__":
    main()
