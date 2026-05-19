"""hermes-shim — residual OpenClaw `/tools/invoke` compatibility + `/v1` proxy.

One instance per Hermes profile. Binds the legacy OpenClaw gateway port
(``main`` → :18789, ``workers`` → :18790) — the only port the Hermes runtime
exposes on the compose network, because the Hermes API server itself binds
``127.0.0.1`` inside the container.

Phase 1 of the OpenClaw→Hermes swap re-exposed the *entire* OpenClaw
``sessions_*`` surface here so callers needed zero diffs. Phase 2 retired
most of it:

  * ``learn`` (clerk.py / ephemeral_agent.py) and the ``alfred`` vault-daemon
    ``openclaw-wrapper`` were rewritten to call Hermes ``/v1/runs`` natively.
  * The ``sessions_spawn`` / ``sessions_history`` / ``sessions_delete`` /
    ``sessions_send`` handlers were **removed** — nothing speaks them anymore.

What this shim still does:

    /v1/*  (any method)         transparent reverse proxy → the Hermes API
                                server. This is what every native caller
                                (openclaw-wrapper, clerk, ephemeral_agent,
                                ctrl-api crossTenant/channelsEmail) now uses.
    POST /tools/invoke
        sessions_list           KEPT — Hermes has no native session
                                enumeration, and ctrl-api's agents.ts /
                                notifications.ts still resolve a delivery
                                target from the run→channel registry. Retire
                                once that resolution is reworked (issue #25).
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
    HERMES_SHIM_STATE_DB      sessions_list sidecar SQLite    (default /alfred-data/.hermes-shim-<profile>.db)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import time
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response

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
STATE_DB = os.environ.get(
    "HERMES_SHIM_STATE_DB", f"/alfred-data/.hermes-shim-{PROFILE}.db"
)

# How long a terminal run's registry row is retained for sessions_list.
RUN_RETENTION_SECONDS = 3600


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
# sessions_list sidecar — SQLite-backed run→channel registry
# ---------------------------------------------------------------------------

class RunRegistry:
    """Tracks runs the shim has observed so `sessions_list` can answer.

    Hermes has no native "list my sessions" endpoint. ctrl-api's agents.ts
    and notifications.ts still resolve a delivery target (`deliveryContext.to`
    on a channel) from this registry, so the shim keeps it. Backed by SQLite
    so the list survives a shim restart.

    Rows are populated by the `/v1` proxy: when a native caller creates a run
    via `POST /v1/runs` carrying a `channel` / `session_id`, the proxy records
    it here so the run still surfaces in `sessions_list`.
    """

    def __init__(self, path: str) -> None:
        self._path = path
        # check_same_thread=False — FastAPI serves on a threadpool; the
        # connection is guarded by an asyncio lock at the call sites.
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS runs (
                session_key   TEXT PRIMARY KEY,
                run_id        TEXT NOT NULL,
                agent_id      TEXT,
                channel       TEXT,
                delivery_to   TEXT,
                status        TEXT,
                created_at    REAL NOT NULL,
                updated_at    REAL NOT NULL
            )
            """
        )
        # Older sidecar DBs predate delivery_to — add it if missing.
        cols = {r[1] for r in self._db.execute("PRAGMA table_info(runs)")}
        if "delivery_to" not in cols:
            self._db.execute("ALTER TABLE runs ADD COLUMN delivery_to TEXT")
        self._db.commit()
        self._lock = asyncio.Lock()

    async def record(
        self,
        session_key: str,
        run_id: str,
        agent_id: str | None,
        channel: str | None,
        delivery_to: str | None,
        status: str,
    ) -> None:
        now = time.time()
        async with self._lock:
            self._db.execute(
                """
                INSERT INTO runs (session_key, run_id, agent_id, channel,
                                  delivery_to, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_key) DO UPDATE SET
                    run_id=excluded.run_id,
                    agent_id=COALESCE(excluded.agent_id, runs.agent_id),
                    channel=COALESCE(excluded.channel, runs.channel),
                    delivery_to=COALESCE(excluded.delivery_to, runs.delivery_to),
                    status=excluded.status,
                    updated_at=excluded.updated_at
                """,
                (session_key, run_id, agent_id, channel, delivery_to, status, now, now),
            )
            self._db.commit()

    async def list(self) -> list[dict[str, Any]]:
        cutoff = time.time() - RUN_RETENTION_SECONDS
        async with self._lock:
            # Opportunistically prune long-dead runs so the list stays small.
            self._db.execute(
                "DELETE FROM runs WHERE status IN "
                "('completed','succeeded','failed','cancelled','error') "
                "AND updated_at < ?",
                (cutoff,),
            )
            self._db.commit()
            cur = self._db.execute(
                "SELECT session_key, run_id, agent_id, channel, delivery_to, "
                "status, created_at, updated_at FROM runs ORDER BY updated_at DESC"
            )
            rows = cur.fetchall()
        return [self._row_to_dict(r) for r in rows]

    @staticmethod
    def _row_to_dict(row: tuple) -> dict[str, Any]:
        # Shape mirrors what ctrl-api agents.ts / notifications.ts expect:
        # a `channel` and a `deliveryContext.to`, plus `updatedAt` for sort.
        return {
            "sessionKey": row[0],
            "runId": row[1],
            "agentId": row[2],
            "channel": row[3],
            "deliveryContext": {"to": row[4]} if row[4] else {},
            "status": row[5],
            "createdAt": row[6],
            "updatedAt": row[7],
        }

    def close(self) -> None:
        self._db.close()


# ---------------------------------------------------------------------------
# Application lifespan — shared HTTP client + registry
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(
        base_url=HERMES_API_URL,
        headers={"Authorization": f"Bearer {HERMES_API_KEY}"},
        timeout=httpx.Timeout(60.0, read=120.0),
    )
    app.state.registry = RunRegistry(STATE_DB)
    log.info(
        "hermes-shim up — profile=%s bind=%s:%d → hermes=%s",
        PROFILE, SHIM_HOST, SHIM_PORT, HERMES_API_URL,
    )
    try:
        yield
    finally:
        await app.state.http.aclose()
        app.state.registry.close()


app = FastAPI(title="hermes-shim", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Envelope helpers — reproduce the OpenClaw double-encoded result shape.
# Only `sessions_list` and `message` still use this; native /v1 callers do not.
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


def _record_run_from_proxy(app: FastAPI, req_body: bytes, resp_body: bytes) -> None:
    """Best-effort: mirror a `POST /v1/runs` create into the run registry.

    Lets `sessions_list` keep answering even though the shim no longer owns
    the spawn path. A parse failure here is silently ignored — the proxy
    response is already on its way to the caller.
    """
    try:
        req = json.loads(req_body or b"{}")
        resp = json.loads(resp_body or b"{}")
    except (json.JSONDecodeError, ValueError):
        return
    if not isinstance(req, dict) or not isinstance(resp, dict):
        return
    run_id = resp.get("id") or resp.get("run_id")
    if not run_id:
        return
    channel = req.get("channel") or req.get("source")
    delivery_to = req.get("delivery_to") or req.get("to")
    agent_id = req.get("session_id") or req.get("agent_id") or "main"
    asyncio.create_task(
        app.state.registry.record(
            session_key=str(run_id),
            run_id=str(run_id),
            agent_id=str(agent_id),
            channel=str(channel) if channel else None,
            delivery_to=str(delivery_to) if delivery_to else None,
            status=str(resp.get("status", "started")),
        )
    )


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
    try:
        upstream = await client.request(
            request.method,
            f"/v1/{path}",
            content=body if body else None,
            params=dict(request.query_params),
            headers=fwd_headers,
        )
    except httpx.RequestError as exc:
        log.error("/v1 proxy: hermes unreachable: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"error": True, "message": f"hermes API unreachable: {exc}"},
        )

    # Mirror run creations into the registry so sessions_list still works.
    if request.method == "POST" and path.rstrip("/") == "runs" and upstream.is_success:
        _record_run_from_proxy(app, body, upstream.content)

    resp_headers = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in _HOP_BY_HOP
    }
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=resp_headers,
        media_type=upstream.headers.get("content-type"),
    )


# ---------------------------------------------------------------------------
# Residual /tools/invoke handlers — sessions_list + message only.
# ---------------------------------------------------------------------------

async def _handle_sessions_list(
    app: FastAPI, args: dict[str, Any]
) -> dict[str, Any]:
    """sessions_list → the shim's own run registry.

    Hermes has no native session enumeration. ctrl-api agents.ts /
    notifications.ts use this to resolve a delivery target. Retire once that
    resolution is reworked (issue #25).
    """
    sessions = await app.state.registry.list()
    return _envelope({"sessions": sessions})


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
    "sessions_list": _handle_sessions_list,
    "message": _handle_message,
}

# Tools retired in Phase 2 — callers were rewritten to native /v1/runs. A
# clear 410 (instead of a generic 400) tells anything still calling them
# exactly what happened.
_RETIRED_TOOLS = {
    "sessions_spawn": "rewritten to POST /v1/runs",
    "sessions_history": "rewritten to GET /v1/runs/{id}",
    "sessions_delete": "rewritten to POST /v1/runs/{id}/stop",
    "sessions_send": "rewritten to POST /v1/runs (same session_id)",
}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/tools/invoke")
async def tools_invoke(
    request: Request,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """Residual OpenClaw tool-dispatch endpoint — sessions_list + message only.

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
