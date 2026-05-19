# alfred-voice-bridge

Twilio Media Streams ↔ OpenAI Realtime bridge for Alfred AgentPhone voice
calls. One process, one WebSocket server (`:9000`), one bridge session per
phone call.

## What it bridges

```
Twilio  ──WS (μ-law audio)──▶  voice-bridge  ──WS──▶  OpenAI Realtime API
 caller                           │                  (wss://api.openai.com)
                                  │
                                  └──HTTP fetch──▶  tenant ctrl-api :3100
                                                    (the `self` and
                                                     `composio_execute` tools)
```

- **Inbound WebSocket** (`src/server.ts`) — Twilio opens a Media Stream WS to
  `/voice/<tenantId>`; voice-bridge accepts it and runs `VoiceCall`.
- **Outbound WebSocket** (`src/openai-realtime.ts`) — a `ws` client to
  `wss://api.openai.com/v1/realtime`, the OpenAI Realtime API (GA schema,
  `gpt-realtime`). This is the speech model, not an agent runtime.
- **Agent functionality** — the voice agent's two function tools (`self`,
  `composio_execute`) dispatch over plain **HTTP `fetch`** from the bridge to
  the tenant's `ctrl-api` at `https://<host>:3100/api/v1/...` (`src/tools.ts`,
  `src/tenant.ts`).

## Runtime-coupling audit (issue #30)

**Finding: voice-bridge is NOT coupled to the agent runtime over a WebSocket.**
It never spoke the OpenClaw raw WebSocket, and it does not speak to Hermes
either. Its only two WebSockets are the Twilio media stream (inbound) and the
OpenAI Realtime API (outbound) — both are audio transports, not the agent
runtime. Every interaction with Alfred's tools and vault goes through ctrl-api
over HTTP, which is already the Hermes-era contract.

Consequently the Phase 3 risk-5 rework ("WebSocket chat + voice-bridge need
rework to HTTP/SSE") does **not** apply to voice-bridge: there is no raw-WS
agent path to migrate. **No functional change was made** for #30. The web chat
widget (the other half of risk 5) is handled separately.

If a future revision routes voice tool-calls through Hermes' ephemeral runtime
instead of ctrl-api, that would use `POST /v1/runs` + `GET /v1/runs/{id}/events`
(HTTP/SSE) via the shim passthrough — but that is a deliberate product change,
not a transport migration, and is out of scope for #30.
