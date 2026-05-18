"""hermes-shim — OpenClaw `/tools/invoke` contract → Hermes `/v1` translator.

One instance per Hermes profile. Binds the legacy OpenClaw gateway port
(``main`` → :18789, ``workers`` → :18790) and re-exposes the exact
``POST /tools/invoke`` surface every existing caller already speaks:

    sessions_spawn    → POST /v1/runs
    sessions_history  → GET  /v1/runs/{id}   (repackaged into the
                        OpenClaw double-encoded result.content[].text envelope)
    sessions_delete   → POST /v1/runs/{id}/stop
    sessions_send     → POST /v1/runs        (new run, same session_id)
    sessions_list     → in-memory run→channel map, persisted to a SQLite
                        sidecar so it survives a shim restart
    message           → no-op acknowledgement (channel delivery is handled
                        natively by the Hermes gateway, not via this contract)

    GET /health, GET /healthz  → proxy Hermes GET /health

This lets the OpenClaw→Hermes runtime swap land with near-zero caller
diffs — the only variable under test is Hermes itself. Native rewrites
to ``/v1/runs`` follow as Phase 2/3 (see PLAN.md Part F).

Auth: the shim validates the *legacy* bearer token (the value of
``/alfred-data/.gateway-token``) on every inbound request — so no
caller's token logic changes — and calls Hermes with ``API_SERVER_KEY``
(which is the same token, but kept as a separate concept so the two can
diverge later).

Environment:
    HERMES_SHIM_PROFILE       "main" | "workers"            (required)
    HERMES_SHIM_PORT          legacy port to bind            (default per profile)
    HERMES_SHIM_HOST          bind address                   (default 0.0.0.0)
    HERMES_API_URL            Hermes API server base URL     (default per profile)
    HERMES_API_KEY            Bearer key for the Hermes API server
    HERMES_GATEWAY_TOKEN_FILE legacy token file              (default /alfred-data/.gateway-token)
    HERMES_SHIM_STATE_DB      sessions_list sidecar SQLite    (default /alfred-data/.hermes-shim-<profile>.db)
    HERMES_SHIM_RUN_TIMEOUT   default per-run ceiling, seconds (default 900)
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
from fastapi.responses import JSONResponse

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
DEFAULT_RUN_TIMEOUT = int(os.environ.get("HERMES_SHIM_RUN_TIMEOUT", "900"))

# How long a terminal run's status is retained for sessions_history polling.
RUN_RETENTION_SECONDS = 3600


# ---------------------------------------------------------------------------
# Legacy token validation
# ---------------------------------------------------------------------------

def _read_legacy_token() -> str:
    """Read the OpenClaw gateway token from disk on every call.

    Read fresh (not cached) because the init container regenerates the
    file and the shim must not pin a stale value across a container
    restart sequence.
    """
    try:
        with open(GATEWAY_TOKEN_FILE, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def _check_auth(authorization: str | None) -> None:
    """Validate the inbound Authorization header against the legacy token.

    Fails closed: if the token file is missing/empty the shim rejects
    every request rather than running unauthenticated.
    """
    expected = _read_legacy_token()
    if not expected:
        log.error("legacy gateway token file is missing or empty: %s", GATEWAY_TOKEN_FILE)
        raise HTTPException(status_code=503, detail="gateway token not provisioned")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    presented = authorization[len("Bearer "):].strip()
    # Constant-time compare.
    if not _consteq(presented, expected):
        raise HTTPException(status_code=401, detail="invalid gateway token")


def _consteq(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    result = 0
    for x, y in zip(a, b):
        result |= ord(x) ^ ord(y)
    return result == 0


# ---------------------------------------------------------------------------
# sessions_list sidecar — SQLite-backed run→channel registry
# ---------------------------------------------------------------------------

class RunRegistry:
    """Tracks every run the shim has spawned so `sessions_list` can answer.

    Hermes has no native "list my sessions" endpoint, so the shim keeps
    its own registry. Backed by SQLite (a sidecar file, NOT the Hermes
    SessionStore) so the list survives a shim restart — callers that
    enumerate sessions after a container bounce still see history.
    """

    def __init__(self, path: str) -> None:
        self._path = path
        # check_same_thread=False — FastAPI serves requests on a threadpool;
        # the connection is guarded by an asyncio lock at the call sites.
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS runs (
                session_key   TEXT PRIMARY KEY,
                run_id        TEXT NOT NULL,
                agent_id      TEXT,
                channel       TEXT,
                status        TEXT,
                created_at    REAL NOT NULL,
                updated_at    REAL NOT NULL
            )
            """
        )
        self._db.commit()
        self._lock = asyncio.Lock()

    async def record(
        self,
        session_key: str,
        run_id: str,
        agent_id: str | None,
        channel: str | None,
        status: str,
    ) -> None:
        now = time.time()
        async with self._lock:
            self._db.execute(
                """
                INSERT INTO runs (session_key, run_id, agent_id, channel,
                                  status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_key) DO UPDATE SET
                    run_id=excluded.run_id,
                    agent_id=excluded.agent_id,
                    channel=excluded.channel,
                    status=excluded.status,
                    updated_at=excluded.updated_at
                """,
                (session_key, run_id, agent_id, channel, status, now, now),
            )
            self._db.commit()

    async def set_status(self, session_key: str, status: str) -> None:
        async with self._lock:
            self._db.execute(
                "UPDATE runs SET status=?, updated_at=? WHERE session_key=?",
                (status, time.time(), session_key),
            )
            self._db.commit()

    async def get(self, session_key: str) -> dict[str, Any] | None:
        async with self._lock:
            cur = self._db.execute(
                "SELECT session_key, run_id, agent_id, channel, status, "
                "created_at, updated_at FROM runs WHERE session_key=?",
                (session_key,),
            )
            row = cur.fetchone()
        return self._row_to_dict(row) if row else None

    async def delete(self, session_key: str) -> None:
        async with self._lock:
            self._db.execute("DELETE FROM runs WHERE session_key=?", (session_key,))
            self._db.commit()

    async def list(self) -> list[dict[str, Any]]:
        cutoff = time.time() - RUN_RETENTION_SECONDS
        async with self._lock:
            # Opportunistically prune long-dead runs so the list stays small.
            self._db.execute(
                "DELETE FROM runs WHERE status IN "
                "('completed','failed','cancelled') AND updated_at < ?",
                (cutoff,),
            )
            self._db.commit()
            cur = self._db.execute(
                "SELECT session_key, run_id, agent_id, channel, status, "
                "created_at, updated_at FROM runs ORDER BY updated_at DESC"
            )
            rows = cur.fetchall()
        return [self._row_to_dict(r) for r in rows]

    @staticmethod
    def _row_to_dict(row: tuple) -> dict[str, Any]:
        return {
            "sessionKey": row[0],
            "runId": row[1],
            "agentId": row[2],
            "channel": row[3],
            "status": row[4],
            "createdAt": row[5],
            "updatedAt": row[6],
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
# Envelope helpers — reproduce the OpenClaw double-encoded result shape
# ---------------------------------------------------------------------------

def _envelope(payload: dict[str, Any]) -> dict[str, Any]:
    """Wrap a payload in the OpenClaw `/tools/invoke` response envelope.

    OpenClaw returns:
        {"result": {"content": [{"type": "text", "text": "<json string>"}]}}
    Four-plus callers hand-parse exactly this — clerk.py, openclaw-wrapper,
    ephemeral_agent. The inner `text` is itself a JSON string.
    """
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
# Hermes API calls
# ---------------------------------------------------------------------------

async def _hermes_create_run(
    client: httpx.AsyncClient,
    input_text: str,
    session_id: str | None,
    instructions: str | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"input": input_text}
    if session_id:
        body["session_id"] = session_id
    if instructions:
        body["instructions"] = instructions
    resp = await client.post("/v1/runs", json=body)
    resp.raise_for_status()
    return resp.json()


async def _hermes_get_run(client: httpx.AsyncClient, run_id: str) -> dict[str, Any]:
    resp = await client.get(f"/v1/runs/{run_id}")
    resp.raise_for_status()
    return resp.json()


async def _hermes_stop_run(client: httpx.AsyncClient, run_id: str) -> dict[str, Any]:
    resp = await client.post(f"/v1/runs/{run_id}/stop")
    # Stop is best-effort — a 404 (already gone) is not an error to the caller.
    if resp.status_code == 404:
        return {"status": "not_found"}
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# tool handlers
# ---------------------------------------------------------------------------

async def _handle_sessions_spawn(
    app: FastAPI, args: dict[str, Any]
) -> dict[str, Any]:
    """sessions_spawn → POST /v1/runs.

    OpenClaw args: {task, agentId, mode, cleanup, sandbox, runTimeoutSeconds,
                    expectsCompletionMessage, ...}
    We use `task` as the run input and `agentId` to scope the run via both
    `session_id` (so the run is correlated) and an instructions preamble.

    Returns the OpenClaw spawn envelope whose inner JSON carries
    `childSessionKey` — every caller extracts exactly that field.
    """
    task = args.get("task") or args.get("message") or args.get("prompt") or ""
    if not task:
        return _error_envelope("sessions_spawn requires a non-empty `task`")

    agent_id = args.get("agentId") or args.get("agent_id") or "main"
    channel = args.get("channel") or args.get("source")

    # Per-task scoping lives in the instructions, not an allowlist — mirrors
    # how ephemeral_agent.py already works against the workers gateway.
    instructions = (
        f"You are running as the `{agent_id}` agent on the Alfred {PROFILE} "
        f"runtime. Complete the delegated task and return your final answer "
        f"as your last assistant message."
    )

    client: httpx.AsyncClient = app.state.http
    run = await _hermes_create_run(
        client,
        input_text=task,
        session_id=agent_id if agent_id else None,
        instructions=instructions,
    )
    run_id = run.get("run_id") or run.get("id")
    if not run_id:
        return _error_envelope(f"Hermes /v1/runs returned no run_id: {run}")

    # The OpenClaw `childSessionKey` becomes the Hermes run_id verbatim, so
    # every subsequent sessions_history / sessions_delete call addresses the
    # exact run.
    session_key = run_id

    await app.state.registry.record(
        session_key=session_key,
        run_id=run_id,
        agent_id=agent_id,
        channel=channel,
        status=run.get("status", "started"),
    )

    log.info("sessions_spawn → run_id=%s agent=%s", run_id, agent_id)
    return _envelope(
        {
            "childSessionKey": session_key,
            "runId": run_id,
            "agentId": agent_id,
            "status": run.get("status", "started"),
        }
    )


def _run_to_messages(run: dict[str, Any]) -> list[dict[str, Any]]:
    """Translate a Hermes run status into the OpenClaw `messages` array.

    OpenClaw sessions_history yields:
        {"messages": [{"role": "assistant", "content": "<text>"}, ...]}
    Callers walk this for the last assistant message. Hermes' run status
    exposes a single `output` string (the final answer) plus optional
    structured `output` items; we surface the final text as one assistant
    message, which is all every caller actually consumes.
    """
    messages: list[dict[str, Any]] = []
    status = run.get("status")

    output = run.get("output")
    text = ""
    if isinstance(output, str):
        text = output
    elif isinstance(output, list):
        # Responses-style structured output: collect message text parts.
        parts: list[str] = []
        for item in output:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "message":
                content = item.get("content", [])
                if isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict) and c.get("type") in (
                            "output_text", "text"
                        ):
                            parts.append(c.get("text", ""))
                elif isinstance(content, str):
                    parts.append(content)
        text = "\n".join(p for p in parts if p)

    if text:
        messages.append({"role": "assistant", "content": text})
    elif status == "failed":
        # Surface the failure as an assistant message so polling callers
        # (which only inspect assistant text) see the error and stop.
        err = run.get("error") or run.get("detail") or "run failed"
        messages.append({"role": "assistant", "content": f"ERROR: {err}"})

    return messages


async def _handle_sessions_history(
    app: FastAPI, args: dict[str, Any]
) -> dict[str, Any]:
    """sessions_history → GET /v1/runs/{id}.

    Repackages the run status into the OpenClaw `{messages: [...]}` envelope.
    While the run is still in flight, returns an empty `messages` array —
    exactly what OpenClaw did before the assistant turn completed, so
    polling callers keep polling.
    """
    session_key = args.get("sessionKey") or args.get("session_key")
    if not session_key:
        return _error_envelope("sessions_history requires `sessionKey`")

    entry = await app.state.registry.get(session_key)
    run_id = entry["runId"] if entry else session_key

    client: httpx.AsyncClient = app.state.http
    try:
        run = await _hermes_get_run(client, run_id)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            # Unknown run — return an empty transcript rather than erroring,
            # matching OpenClaw's behaviour for an unknown/expired session.
            return _envelope({"messages": [], "status": "unknown"})
        raise

    status = run.get("status", "running")
    if entry and status != entry.get("status"):
        await app.state.registry.set_status(session_key, status)

    messages = _run_to_messages(run)
    payload: dict[str, Any] = {"messages": messages, "status": status}

    # Echo usage if present — harmless extra field; callers ignore unknown keys.
    if "usage" in run:
        payload["usage"] = run["usage"]

    return _envelope(payload)


async def _handle_sessions_delete(
    app: FastAPI, args: dict[str, Any]
) -> dict[str, Any]:
    """sessions_delete → POST /v1/runs/{id}/stop.

    OpenClaw `sessions_delete` interrupted + removed a session. Hermes runs
    are interrupted via /stop; the run record itself ages out of the
    SessionStore on its own. The shim drops its registry row so the run
    no longer appears in sessions_list.
    """
    session_key = args.get("sessionKey") or args.get("session_key")
    if not session_key:
        return _error_envelope("sessions_delete requires `sessionKey`")

    entry = await app.state.registry.get(session_key)
    run_id = entry["runId"] if entry else session_key

    client: httpx.AsyncClient = app.state.http
    try:
        result = await _hermes_stop_run(client, run_id)
    except httpx.HTTPStatusError as exc:
        # Stop is best-effort; surface nothing fatal to the caller.
        log.warning("sessions_delete: stop run %s failed: %s", run_id, exc)
        result = {"status": "error"}

    await app.state.registry.set_status(session_key, "cancelled")
    await app.state.registry.delete(session_key)
    log.info("sessions_delete → run_id=%s stopped", run_id)
    return _envelope({"deleted": True, "sessionKey": session_key, **result})


async def _handle_sessions_send(
    app: FastAPI, args: dict[str, Any]
) -> dict[str, Any]:
    """sessions_send → POST /v1/runs against the same session_id.

    OpenClaw `sessions_send` injected a follow-up message into an existing
    session. Hermes runs are single-turn; a follow-up is a fresh run that
    reuses the same `session_id` so Hermes chains the conversation.
    """
    session_key = args.get("sessionKey") or args.get("session_key")
    text = args.get("message") or args.get("text") or args.get("task") or ""
    if not text:
        return _error_envelope("sessions_send requires a non-empty `message`")

    entry = await app.state.registry.get(session_key) if session_key else None
    agent_id = (entry or {}).get("agentId") or "main"

    client: httpx.AsyncClient = app.state.http
    run = await _hermes_create_run(
        client,
        input_text=text,
        session_id=agent_id,
        instructions=None,
    )
    run_id = run.get("run_id") or run.get("id")
    if not run_id:
        return _error_envelope(f"Hermes /v1/runs returned no run_id: {run}")

    new_key = run_id
    await app.state.registry.record(
        session_key=new_key,
        run_id=run_id,
        agent_id=agent_id,
        channel=(entry or {}).get("channel"),
        status=run.get("status", "started"),
    )
    return _envelope(
        {"childSessionKey": new_key, "runId": run_id, "status": run.get("status", "started")}
    )


async def _handle_sessions_list(
    app: FastAPI, args: dict[str, Any]
) -> dict[str, Any]:
    """sessions_list → the shim's own run registry.

    Hermes has no native session enumeration; the shim is authoritative.
    Returns the registry rows in the OpenClaw `{sessions: [...]}` shape.
    """
    sessions = await app.state.registry.list()
    return _envelope({"sessions": sessions})


async def _handle_message(app: FastAPI, args: dict[str, Any]) -> dict[str, Any]:
    """message → no-op acknowledgement.

    `message` was OpenClaw's outbound channel-delivery primitive. Under
    Hermes, channel delivery is handled natively by the gateway (Telegram
    /Slack/email adapters) — there is no equivalent `/tools/invoke`
    operation. Autonomous code that needs to reach the principal goes
    through ctrl-api → alfred__notify_principal instead. We acknowledge
    the call so any legacy caller that still issues `message` does not
    hard-fail; the delivery itself is a no-op here.
    """
    log.info("message tool invoked — acknowledged as no-op (channel delivery is native)")
    return _envelope({"delivered": False, "noop": True, "reason": "channel delivery is native to the Hermes gateway"})


_TOOL_HANDLERS = {
    "sessions_spawn": _handle_sessions_spawn,
    "sessions_history": _handle_sessions_history,
    "sessions_delete": _handle_sessions_delete,
    "sessions_send": _handle_sessions_send,
    "sessions_list": _handle_sessions_list,
    "message": _handle_message,
}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/tools/invoke")
async def tools_invoke(
    request: Request,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """The OpenClaw gateway tool-dispatch endpoint.

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

    handler = _TOOL_HANDLERS.get(tool)
    if handler is None:
        raise HTTPException(status_code=400, detail=f"unsupported tool: {tool!r}")

    try:
        payload = await handler(app, args)
    except httpx.HTTPStatusError as exc:
        log.error("hermes API error on %s: %s", tool, exc)
        # Surface as a 502 — the upstream Hermes API failed, not the caller.
        return JSONResponse(
            status_code=502,
            content=_error_envelope(f"hermes API error: {exc.response.status_code}"),
        )
    except httpx.RequestError as exc:
        log.error("hermes API unreachable on %s: %s", tool, exc)
        return JSONResponse(
            status_code=503,
            content=_error_envelope(f"hermes API unreachable: {exc}"),
        )
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
@app.get("/v1/health")
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
