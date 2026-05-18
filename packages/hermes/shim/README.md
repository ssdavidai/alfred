# hermes-shim

A thin FastAPI translator that re-exposes the legacy OpenClaw gateway
`POST /tools/invoke` contract on top of the Hermes Agent `/v1` API.

One instance runs per Hermes profile inside the `alfred-black-hermes`
container (see `../docker/supervisor.sh`):

| Profile   | Shim binds (legacy) | Forwards to Hermes API |
|-----------|---------------------|------------------------|
| `main`    | `:18789`            | `127.0.0.1:18799`      |
| `workers` | `:18790`            | `127.0.0.1:18800`      |

## Why

The OpenClaw→Hermes runtime swap must land with **near-zero caller
diffs** — 4+ callers (`clerk.py`, `openclaw-wrapper`, `ephemeral_agent`)
hand-parse OpenClaw's double-encoded `result.content[].text` envelope and
present a bearer token from `/alfred-data/.gateway-token`. The shim keeps
that contract intact so the only thing under test is Hermes itself.
Native rewrites to `/v1/runs` follow as Phase 2/3 (see PLAN.md Part F).

## Endpoint mapping

| OpenClaw `/tools/invoke` tool | Hermes call |
|-------------------------------|-------------|
| `sessions_spawn`   | `POST /v1/runs` — `childSessionKey` = the Hermes `run_id` |
| `sessions_history` | `GET /v1/runs/{id}` — repackaged into `{messages:[...]}` |
| `sessions_delete`  | `POST /v1/runs/{id}/stop` + drop the registry row |
| `sessions_send`    | `POST /v1/runs` reusing the same `session_id` |
| `sessions_list`    | the shim's own SQLite-backed run registry (Hermes has no native enumeration) |
| `message`          | no-op ack (channel delivery is native to the Hermes gateway) |
| `GET /health` `/healthz` | proxy `GET /health` (reports degraded if Hermes is down) |

## Auth

Inbound requests are validated against the **legacy** token
(`/alfred-data/.gateway-token`) — so no caller's token logic changes.
The shim calls the Hermes API server with `API_SERVER_KEY` (the same
token value, kept as a separate concept so the two can diverge later).

## Configuration

All via environment (see the module docstring in `hermes_shim.py`):
`HERMES_SHIM_PROFILE`, `HERMES_SHIM_PORT`, `HERMES_API_URL`,
`HERMES_API_KEY`, `HERMES_GATEWAY_TOKEN_FILE`, `HERMES_SHIM_STATE_DB`.

## Run standalone (dev)

```bash
pip install -r requirements.txt
HERMES_SHIM_PROFILE=main \
HERMES_API_URL=http://127.0.0.1:18799 \
HERMES_API_KEY=$(cat /alfred-data/.gateway-token) \
python hermes_shim.py
```
