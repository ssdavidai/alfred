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

## Retiring the OpenClaw compat surface

Phase 1 re-exposed the **entire** OpenClaw `POST /tools/invoke`
`sessions_*` surface so the runtime swap landed with zero caller diffs.
Subsequent phases retired that scaffolding once the native rewrites landed:

* `learn` (`clerk.py`, `ephemeral_agent.py`) and the `alfred` vault-daemon
  `openclaw-wrapper` now call Hermes `/v1/runs` directly.
* ctrl-api `crossTenant.ts` / `channelsEmail.ts` now call `/v1/runs` directly.
* The `sessions_spawn` / `sessions_history` / `sessions_delete` /
  `sessions_send` handlers were **removed** — they now return `410 Gone`.
* `sessions_list` was **removed** (issue #39). It existed only so ctrl-api
  could resolve a delivery target from a shim-owned run→channel registry;
  ctrl-api now reads the native Hermes gateway session index
  (`profiles/<p>/sessions/sessions.json`) directly — see ctrl-api
  `api/hermes-sessions.ts`. The shim no longer keeps any session state.

## What the shim does now

| Surface | Behaviour |
|---------|-----------|
| `/v1/*` (any method) | **transparent reverse proxy** → the Hermes API server. The native surface every caller uses. |
| `POST /tools/invoke` `message` | no-op ack (channel delivery is native to the Hermes gateway). |
| `POST /tools/invoke` `sessions_spawn`/`_history`/`_delete`/`_send`/`_list` | retired — `410 Gone` with a pointer to the native surface. |
| `GET /health` `/healthz` | proxy `GET /health` (reports degraded if Hermes is down). |

## Auth

Inbound requests are validated against the **legacy** token
(`/alfred-data/.gateway-token`) — so no caller's token logic changes.
The shim calls the Hermes API server with `API_SERVER_KEY` (the same
token value, kept as a separate concept so the two can diverge later).

## Configuration

All via environment (see the module docstring in `hermes_shim.py`):
`HERMES_SHIM_PROFILE`, `HERMES_SHIM_PORT`, `HERMES_API_URL`,
`HERMES_API_KEY`, `HERMES_GATEWAY_TOKEN_FILE`.

## Run standalone (dev)

```bash
pip install -r requirements.txt
HERMES_SHIM_PROFILE=main \
HERMES_API_URL=http://127.0.0.1:18799 \
HERMES_API_KEY=$(cat /alfred-data/.gateway-token) \
python hermes_shim.py
```
