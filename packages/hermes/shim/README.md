# hermes-shim

A thin FastAPI front-end for the Hermes Agent `/v1` API. The Hermes API
server binds `127.0.0.1` inside the container, so the shim is the only
Hermes surface on the compose network — every caller reaches Hermes
through it.

One instance runs per Hermes profile inside the `alfred-black-hermes`
container (see `../docker/supervisor.sh`):

| Profile   | Shim binds (legacy) | Forwards to Hermes API |
|-----------|---------------------|------------------------|
| `main`    | `:18789`            | `127.0.0.1:18799`      |
| `workers` | `:18790`            | `127.0.0.1:18800`      |

## Phase 1 → Phase 2

Phase 1 re-exposed the **entire** OpenClaw `POST /tools/invoke`
`sessions_*` surface so the runtime swap landed with zero caller diffs.
Phase 2 retired that scaffolding once the native rewrites landed:

* `learn` (`clerk.py`, `ephemeral_agent.py`) and the `alfred` vault-daemon
  `openclaw-wrapper` now call Hermes `/v1/runs` directly.
* ctrl-api `crossTenant.ts` / `channelsEmail.ts` now call `/v1/runs` directly.
* The `sessions_spawn` / `sessions_history` / `sessions_delete` /
  `sessions_send` handlers were **removed** — they now return `410 Gone`.

## What the shim does now

| Surface | Behaviour |
|---------|-----------|
| `/v1/*` (any method) | **transparent reverse proxy** → the Hermes API server. The native surface every Phase-2 caller uses. |
| `POST /tools/invoke` `sessions_list` | KEPT — Hermes has no native session enumeration; ctrl-api `agents.ts` / `notifications.ts` still resolve a delivery target from the run→channel registry. Rows are populated by the `/v1` proxy mirroring `POST /v1/runs` creations. |
| `POST /tools/invoke` `message` | no-op ack (channel delivery is native to the Hermes gateway). |
| `POST /tools/invoke` `sessions_spawn`/`_history`/`_delete`/`_send` | retired — `410 Gone` with a pointer to `/v1/runs`. |
| `GET /health` `/healthz` | proxy `GET /health` (reports degraded if Hermes is down). |

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
