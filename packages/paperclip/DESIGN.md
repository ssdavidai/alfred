# Paperclip Hermes-HTTP Adapter — Design Note

Local-only fork of upstream `hermes-paperclip-adapter@0.2.0` that swaps the
child-process backend (spawn `hermes chat -q …`) for a tenant-local HTTP call
against alfred-black's own Hermes Agent container (`hermes:18789/v1/responses`).

The Paperclip sidecar runs `ghcr.io/paperclipai/paperclip` upstream; that image
has no `hermes` CLI binary. Our Hermes Agent runs in a separate container and
already serves an OpenAI-compatible HTTP surface that every other channel
(Telegram, Slack, SMS, voice-bridge, paperclip-via-ctrl-api) routes through.
This fork makes the `hermes_local` adapter follow the same path so Paperclip
heartbeats execute against real Hermes rather than a missing binary.

## Why ship this at all

Today the seed bootstrap (PR #84, `bootstrap-paperclip.sh`) creates the CEO
agent with `adapterType: "openclaw_gateway"` — a Paperclip-bundled WebSocket
adapter that expects an OpenClaw gateway endpoint that doesn't exist on our
tenants. The adapter therefore never executes a task, even though the agent
appears configured in Paperclip's UI. Two adapter types could plausibly run
the agent locally:

| Adapter         | Backend                                 | Works on alfred-black?           |
|-----------------|-----------------------------------------|----------------------------------|
| `http`          | webhook → `ctrl-api`                    | yes (already wired, lane I)      |
| `openclaw_gateway` | WebSocket → OpenClaw gateway service | no (no such service deployed)    |
| `hermes_local`  | spawn `hermes` CLI in paperclip image   | no (binary missing)              |
| `hermes_local`* | **POST hermes:18789/v1/responses**      | **this PR — wire-up**            |

The `http` adapter via ctrl-api is the supported runtime path today, and
remains the recommended adapter for channels that need ctrl-api journaling.
The `hermes_local` HTTP backend is preferable as the *managed-employee*
runtime — it lets Paperclip own the per-agent session, retries, skill list,
and transcript surface without forcing every heartbeat through ctrl-api.

## Mapping table

| Upstream behaviour            | HTTP-mode replacement                                |
|-------------------------------|------------------------------------------------------|
| Spawn `hermes chat -q PROMPT` | `POST {HERMES_GATEWAY_URL}/v1/responses` with `{ input: PROMPT }` |
| `-Q` quiet mode               | Always quiet; `/v1/responses` JSON is structured     |
| `-m model`                    | Not passed (Hermes config.yaml owns the model)       |
| `--provider`                  | Not passed (Hermes config.yaml owns the provider)    |
| `-t toolsets`                 | Not passed (Hermes profile owns the toolset)         |
| `-w` worktree                 | Dropped (no spawn, no cwd)                           |
| `--checkpoints`               | Dropped                                              |
| `-v` verbose                  | Dropped (we surface response as-is)                  |
| `--source tool`               | Implicit — sessions are tagged by `X-Hermes-Session-Key` prefix `paperclip-<agentId>` |
| `--resume <sessionId>`        | Same `X-Hermes-Session-Key` reused across heartbeats; Hermes' own state handles continuity. `sessionParams.sessionKey` is round-tripped through Paperclip's session codec |
| `~/.hermes/skills/` scan      | Same scan if `~/.hermes/skills/` is mounted; otherwise empty list |
| `hermes --version` env test   | `GET {HERMES_GATEWAY_URL}/health`                    |
| stdout regex parsing          | Walk `output[].content[].text` from the Responses-API envelope (matches ctrl-api `extractHermesText`) |
| Token usage from stdout regex | `response.usage.{input,output}_tokens` from the JSON envelope |
| Cost regex                    | Dropped (Hermes doesn't surface USD here); `costUsd` left `null` |

## Session continuity

Upstream stores `{ sessionId: "<hermes-cli-session-id>" }` in `sessionParams`
and passes it to the next run via `--resume`. We instead derive a stable
`sessionKey` from the agent id (`paperclip-<paperclipAgentId>`) and reuse it
across heartbeats — Hermes' gateway already keys its message history off the
`X-Hermes-Session-Key` header. The codec still serializes `{ sessionKey }`
so Paperclip's UI surfaces the displayId.

Backwards-compat in the codec: if the persisted blob still holds the old
`sessionId` field, accept it as a `sessionKey` so an existing agent that's
been on `hermes_local` (e.g. while we were iterating) keeps working without
a forced reset.

## Authentication

Hermes' `/v1/responses` validates `Authorization: Bearer <key>` against
`API_SERVER_KEY` written into `/hermes-state/profiles/main/.env` by the
hermes-init container. This file is the authoritative source of truth (see
memory: `paperclip-integration` "Hermes API auth reads /hermes-state/
profiles/main/.env API_SERVER_KEY, not /opt/alfred/.env's
HERMES_API_SERVER_KEY"). We mount `hermes_data:/hermes-state:ro` into the
paperclip container and read the key at call time, matching the pattern
ctrl-api's `channels_paperclip.ts::readHermesMainApiKey()` already uses.

Provider keys (Anthropic / OpenAI / OpenRouter / Z.AI) are never touched —
they live ONLY inside the hermes container, in `config.yaml` (operator-owned).

## Vault and ctrl-api boundaries

Upstream's adapter does not write to any vault. Our patched version preserves
that — it never opens `/vault` directly. If a future upstream change adds
vault writes, the build will fail on the `HERMES_PAPERCLIP_ADAPTER_REF` needle
check (see `Dockerfile`) and force a re-review before the swap proceeds.

## Compose changes

`paperclip` service gains:

```yaml
volumes:
  - paperclip_data:/paperclip
  - hermes_data:/hermes-state:ro   # ← new, read-only
environment:
  - HERMES_GATEWAY_URL=http://hermes:18789  # ← new, optional override
```

The paperclip image is rebuilt to `ssdavidai00/alfred-black-paperclip:latest`
and the `image:` line is swapped. `image-sha` pinning carries through to a
follow-up.

## Tripwire / upstream-drift detection

Image build verifies the upstream package version is exactly `0.2.0` before
applying the overlay. If upstream ships `0.2.1` or `0.3.0`, the build fails
fast with a message telling the operator to re-audit `execute.ts` against
the new upstream source.

## Limits

* No streaming. `/v1/responses` is request/response. Paperclip's UI receives
  the full transcript at the end of the run. ctrl-api's `channels_paperclip`
  works the same way; the operator-visible difference is "one paragraph
  appears at the end" vs "the cursor visibly moves" — for the heartbeat
  cadence (every N seconds) this is the right trade-off.

* No streaming `onLog` deltas. We emit a synthetic `[hermes]` boot/exit
  prologue + the response as a single stdout chunk, then a final exit-code
  line. Paperclip's transcript UI renders this as one assistant turn.

* `--reasoning-effort` / extended-thinking knobs are dropped. Hermes config
  controls these per profile and overriding from Paperclip would let an
  operator silently change the principal's reasoning-budget posture.

## Future / out of scope

* Generic `HERMES_TRANSPORT=http|cli` mode in upstream
  `NousResearch/hermes-paperclip-adapter` — see the follow-up issue. Until
  upstream takes that PR, this fork stays local-only per Sir's
  "ask-before-upstream-for-tenant-work" rule.

* Skill *sync* (push paperclip-managed skills into Hermes' skill dir) is a
  no-op even upstream. We surface what's mounted at `~/.hermes/skills/`
  read-only and stop there.

* Cost USD propagation — would need Hermes' gateway to attach a
  `cost_usd` field to the `usage` block. Not present today.
