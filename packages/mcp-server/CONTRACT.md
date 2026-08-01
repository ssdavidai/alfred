# CONTRACT — packages/mcp-server (alfred-mcp-server)

`@alfred/mcp-server` is the single source of truth for Alfred's per-app MCP tool
catalogues. The SAME TypeScript tool definitions are served over TWO transports:
(1) an HTTP MCP server (`src/index.ts`, Express on `:8787`, OAuth 2.1 + scoped
bearer tokens) that claude.ai Custom Connectors and third-party clients reach at
`https://mcp.<DOMAIN>/<app>/mcp`, and (2) a stdio binary (`src/bin/stdio-app.ts`)
that the Hermes profiles spawn as child processes, one per app. Every tool is a
thin authenticated proxy onto ctrl-api (`src/tools/helpers.ts` →
`Authorization: Bearer <AAS_API_KEY>`, paths under `/api/v1/…`); this package
holds NO business logic and NO direct store access.

---

## Provides

### P1 — The AppId registry (`src/tools/registry.ts`)

Eight apps. `SUPPORTED_APPS` / `isAppId()` / `getToolsForApp()` are the only
lookup surface; a token or stdio arg outside this set is rejected.

| AppId | Source file | Tools | Naming | Backing |
|---|---|---|---|---|
| `alfred` | `src/tools/alfred.ts` | 29 | `list_vault_by_type`, `search_vault`, `spawn_alfred_task`, `start_workflow`, `act_on_decision`, `delegate_to_focused_agent`, `notify_principal`, … | ctrl-api vault/workflow/decision routes |
| `sure` | `src/tools/sure.ts` | 96 | `list_transactions`, `get_balance_sheet`, `get_sync_health`, `bulk_update_transactions`, …; `get_balance_sheet` passes through each account's additive `balance_provenance` and the aggregate `data_quality` unchanged | ctrl-api Sure REST proxy (`get_sync_health` → `GET /api/v1/sure/sync-health`) |
| `vaultwarden` | `src/tools/vaultwarden.ts` | 14 | `list_vault_items`, `create_vault_item`, `generate_password`, `vault_refresh`, … | ctrl-api Vaultwarden proxy |
| `execute` | `src/tools/execute.ts` | 6 | `list_composio_tools`, `composio_execute`, `list_connections`, `create_connection`, `reconnect_connection`, `delete_connection` | ctrl-api `/api/v1/integrations/*` (Composio; execute = `/api/v1/integrations/execute`) |
| `hermes` | `src/tools/hermes.ts` | 7 | `run`, `stop_run`, `health`, `list_models`, `schedule_prompt`, `list_scheduled`, `cancel_scheduled` (all take optional `profile: main\|workers`) | ctrl-api `/api/v1/hermes/*` (schedule tools hit `/api/v1/hermes/cron`; ctrl-api bridges those to the in-container `hermes cron` CLI) |
| `hass` | `src/tools/hass.ts` | 85 | ALL prefixed `ha__` (`ha__get_state`, `ha__call_service`, `ha__propose_automation`, …) | ctrl-api `/api/v1/channels/ha/*` (ctrl-api owns the HA token; it never reaches this package) |
| `files` | `src/tools/files.ts` | 12 | `list`, `stat`, `read_text`, `read_base64`, `search`, `usage`, `set_label`, `create`, `delete`, `move`, `describe`, `hard_delete` | ctrl-api `/api/v1/files/*` (Store-5 blobs) |
| `paperclip-admin` | `src/tools/paperclip.ts` | 5 | `paperclip_create_company`, `paperclip_create_agent`, `paperclip_register_user`, `paperclip_list_companies`, `paperclip_list_agents` — **frozen by `docs/PAPERCLIP-BOOTSTRAP-CONTRACT.md` C2** | ctrl-api `/api/v1/paperclip/admin/*` |

**NOT in this package** (do not add here):

- `plane` — **removed** from the registry (Plane was removed from the deployed
  stack, PR #279). `skills/plane-mcp-skill.md` remains in-tree — dormant, not
  served by any registered app. Do not re-add without an orchestrator decision.
- `alfred-ctrl` (the `self` HTTP proxy) — lives at
  `packages/hermes/mcp/ctrl-server.mjs`, owned by Lane V/hermes.
- `paperclip` (the ~40-tool ops server) — upstream `@paperclipai/mcp-server`
  from npm, pinned in `packages/hermes/Dockerfile` (`PAPERCLIP_MCP_REF`).
  The name collision is a frozen decision: our admin bundle's AppId is
  `paperclip-admin`; its TOOL names stay `paperclip_*`.

### P2 — stdio transport (`src/bin/stdio-app.ts`)

```
node dist/bin/stdio-app.js <appId>      # appId ∈ SUPPORTED_APPS
```

- Registers exactly `getToolsForApp(appId)` on an `McpServer` over
  `StdioServerTransport`. Exits 2 on an unknown appId.
- Reads env: `CTRL_API_URL` (default `http://ctrl-api:3100`), `AAS_API_KEY`
  (warns to stderr if unset), optional `CF_ACCESS_CLIENT_ID/SECRET`.
  **Note the env-name split: the stdio binary reads `CTRL_API_URL`; the HTTP
  server reads `CTRL_URL` (`src/env.ts`). They are not interchangeable.**
- If `skills/<appId>-mcp-skill.md` exists (resolved relative to the compiled
  bin: `dist/bin/../../skills/`), it is exposed as MCP resource
  `alfred://skills/<appId>-mcp-skill.md`. Present for `alfred`, `sure`,
  `vaultwarden`, `execute` (+ dormant `plane`); absent for `hermes`, `hass`,
  `files` (`skills/alfred-files-skill.md` does NOT match the lookup name),
  `paperclip-admin` — those apps serve tools but no skill resource.
- stdout is reserved for the JSON-RPC stream; all diagnostics go to stderr.

### P3 — HTTP transport (`src/index.ts`, Express `:8787`)

| Route | What |
|---|---|
| `GET /health` | Liveness: `{ok, service, tenant, apps}` |
| `ALL /<app>/mcp` (one per AppId) | Streamable-HTTP MCP endpoint. Per-SESSION `McpServer` + `StreamableHTTPServerTransport` pairs in an in-memory `Map<sessionId, transport>`; a request with an unknown `mcp-session-id` gets 404 `-32001` (client must re-initialize). Single-replica by design. |
| `GET /.well-known/oauth-protected-resource/<app>/mcp` | Per-app RFC 9728 metadata; `resource` = `<PUBLIC_URL>/<app>/mcp`. Mounted BEFORE `mcpAuthRouter` (ordering is load-bearing). |
| `/register`, `/authorize`, `/token`, `/revoke`, `/.well-known/oauth-authorization-server` | SDK `mcpAuthRouter` over `SqliteOAuthProvider` (`src/oauth/provider.ts`) |
| `POST /approve` | The human approval form target: validates `MCP_APPROVAL_SECRET` (constant-time), binds `props.appId` from the form's `app` field, issues the auth code, 302s back to the client |
| `GET/POST /manage/tokens`, `POST /manage/tokens/:id/rotate`, `DELETE /manage/tokens/:id` | Scoped-token management (P5) |
| anything else | 404 |

CORS: permissive preflight short-circuit at the top of the stack (echoes
Origin, exposes `WWW-Authenticate` + `mcp-session-id`) — required for
claude.ai's browser-side connector wiring. `trust proxy` is on (behind Caddy).

### P4 — Authentication (three paths, checked in this order)

Per `index.ts` `authOrApprovalSecret()` + `src/scopedTokens.ts`:

| # | Credential | Scope | Who uses it |
|---|---|---|---|
| 1 | `Bearer <MCP_APPROVAL_SECRET>` | ALL apps (tenant master) | in-tenant services (voice-bridge, ctrl-api's token proxy), scripts |
| 2 | `Bearer <scoped token>` (`alf_<app>_<random>`) | exactly ONE app | third-party headless clients (ElevenLabs, LiveKit) — PR #278 |
| 3 | OAuth 2.1 bearer (PKCE S256, DCR, RFC 8707 resource binding) | the app bound at `/approve` time | claude.ai Custom Connectors |

TTLs (`src/oauth/provider.ts`): access token 1 h, auth code 10 min, refresh
token 90 d with rotation chaining (`rotated_to`). A token bound to app A that
hits `/<B>/mcp` fails: scoped tokens fail `verifyScopedToken`'s `app_id` check;
OAuth tokens fail the per-tool `props.appId !== appId` guard.

### P5 — Scoped-token management API (PR #278)

Gated by `MCP_APPROVAL_SECRET` (`requireMaster`). The raw token is returned
EXACTLY ONCE (on mint and on rotate); list responses carry metadata only
(`id`, `app`, `label`, `prefix`, `url`, `created_at`, `last_used_at`,
`revoked`).

| Endpoint | Behaviour |
|---|---|
| `GET /manage/tokens[?app=<app>]` | List + `{tenant, public_url, apps, transport:"streamable-http"}` for UI rendering |
| `POST /manage/tokens {app, label}` | Mint; 201 with `token` (once) |
| `POST /manage/tokens/:id/rotate` | New secret in place (same id + label); returns `token` (once) |
| `DELETE /manage/tokens/:id` | Hard delete |

Consumer chain (verified): dashboard `/claude` page
(`packages/web/src/dashboard/ClaudePage.tsx`, Wasp ops
`getMcpTokens/mintMcpToken/rotateMcpToken/deleteMcpToken`) → ctrl-api
`/api/v1/mcp/tokens/*` (`packages/ctrl/src/api/routes/mcpTokens.ts`, thin
proxy, presents `MCP_APPROVAL_SECRET` server-side; the browser never holds it)
→ this API. Preserves the "web only talks to ctrl-api" invariant.

### P6 — Storage: `$DATA_DIR/oauth.sqlite` (`src/oauth/storage.ts`)

`node:sqlite` (`--experimental-sqlite`), WAL. Tables: `clients` (DCR;
`client_secret` stored RAW — SDK string-equals requirement, documented
in-file), `auth_codes`, `access_tokens`, `refresh_tokens` (all token values
stored as SHA-256 hashes only), and `scoped_tokens`:

```
scoped_tokens(id PK, app_id, token_hash UNIQUE, prefix, label,
              created_at, last_used_at, revoked_at)
```

Schema is created/migrated in-process at boot (`migrate()`); expired rows
pruned hourly. Compose persists it in the `mcp_server_data` volume mounted at
`/data` (`docker-compose.yaml` service `mcp-server`).

---

## Requires

### Environment — HTTP server (`src/env.ts`; compose service `mcp-server`)

| Var | Required | Compose value | Notes |
|---|---|---|---|
| `CTRL_URL` | yes | `http://ctrl-api:3100` | ctrl-api base for all tool proxying |
| `AAS_API_KEY` | yes | via `env_file: .env` | Bearer for ctrl-api (bootstrap.sh-generated) |
| `MCP_APPROVAL_SECRET` | yes | via `env_file: .env` | master credential; bootstrap.sh-generated |
| `PUBLIC_URL` | yes | `https://mcp.${DOMAIN}` | OAuth issuer; MUST be https (or localhost) — enforced at boot |
| `TENANT_LABEL` | yes | `${OWNER_NAME}` | display label on the approval page / health |
| `DATA_DIR` | no (default `/data`) | `/data` | oauth.sqlite location |
| `PORT` | no (default `8787`) | `8787` | |

Container: `ssdavidai00/alfred-mcp-server:latest`, `depends_on: ctrl-api
(service_started)`, `mem_limit: 256m`, `pids_limit: 256`. Ingress:
`caddy/Caddyfile` `mcp.{$DOMAIN} → reverse_proxy mcp-server:8787` (DNS A
record `mcp` → VM required).

### Environment — stdio binary (per spawn, set by the Hermes config)

| Var | Required | Notes |
|---|---|---|
| `CTRL_API_URL` | no (default `http://ctrl-api:3100`) | NOT `CTRL_URL` — different name than the HTTP server |
| `AAS_API_KEY` | effectively yes | unset ⇒ unauthenticated ctrl-api calls (warn only) |
| `CF_ACCESS_CLIENT_ID/SECRET` | no | optional CF Access headers |

### Dependencies

Node ≥ 22 (`--experimental-sqlite`), `@modelcontextprotocol/sdk` 1.29.0,
`express` 4, `zod` 4. (`express-rate-limit` is declared in package.json but
unused in `src/` — no rate limiting is applied today.) Zero database access
other than its own `oauth.sqlite`; everything else is HTTP to ctrl-api.

---

## Consumers (who breaks if you change this package)

| Consumer | Transport | Apps consumed | Wiring |
|---|---|---|---|
| Hermes `main` profile | stdio | `alfred`, `sure` (trimmed), `vaultwarden`, `execute`, `hass` (trimmed), `files`, `paperclip-admin` | `packages/hermes/hermes-config.yaml.njk` `mcp_servers:` blocks spawn `{{mcp_stdio_dir}}/dist/bin/stdio-app.js <app>`; `paperclip-admin` is backfilled by `packages/hermes/init/render_mcp_servers.py` (idempotent mutator, every init boot) |
| Hermes `workers` profile | stdio | `alfred`, `sure` (full), `vaultwarden`, `execute`, `files`, `paperclip-admin` | same |
| Hermes `heavy` profile | stdio | `alfred`, `sure`, `vaultwarden`, `execute` | same (no `hass`/`files`/`paperclip-admin`) |
| Hermes `codex-builder` profile | — | none | `mcp_servers: {}` by design (sealed runtime) |
| claude.ai Custom Connectors | HTTP + OAuth | any app, one connector per app | `https://mcp.<DOMAIN>/<app>/mcp` |
| voice-bridge | HTTP + master secret | `alfred`, `sure`, `vaultwarden`, `execute`, `hermes` | `MCP_SERVER_URL=http://mcp-server:8787` in compose |
| Third-party voice vendors (ElevenLabs, LiveKit) | HTTP + scoped token | one app per token | connector URL from `/manage/tokens` responses |
| ctrl-api + web dashboard | HTTP `/manage/*` | token management only | see P5 chain |

The `mcp_stdio_dir` the Hermes profiles execute from is
`$HERMES_HOME/profiles/<p>/mcp-stdio/` on the persistent `hermes_data` volume
— synced there **unconditionally on every init-container run** from the copy
baked into the init image (`packages/hermes/init/entrypoint.sh` step 2e). The
hermes runtime image's own `/opt/mcp-stdio` copy (`HERMES_MCP_STDIO_SRC`) is a
staging source for runtime self-render, not the executed path.

Hermes auto-namespaces every tool as `mcp_<server>_<tool>` (e.g.
`mcp_files_list`, `mcp_hass_ha__get_state`).

---

## Invariants (other lanes rely on these)

1. **Tool names are frozen cross-lane interfaces.** Renaming a tool breaks,
   at minimum: (a) the Hermes main-profile `tools.include` whitelists in
   `packages/hermes/hermes-config.yaml.njk` (issue #175 trims for `sure`,
   `hass`, upstream `paperclip`) — a renamed tool silently VANISHES from
   main's catalogue because the include list no longer matches; (b) the skill
   files in `skills/` and `packages/hermes/workspace-template/skills/`;
   (c) claude.ai connectors and voice-vendor configs in the field. The five
   `paperclip_*` tool names are additionally frozen by
   `docs/PAPERCLIP-BOOTSTRAP-CONTRACT.md` C2 (listed in P1). Renames are an
   orchestrator-coordinated change across lanes, never a lane-local edit.
2. **stdio and HTTP serve the same catalogue from the same source.** Any tool
   added to a registry entry appears on BOTH transports; do not fork per
   transport.
3. **One app per credential.** A token (OAuth or scoped) bound to app A must
   never enumerate or call app B's tools. Enforced in three places: registry
   lookup, the per-tool `props.appId` guard, and `verifyScopedToken`'s
   `app_id` check. Keep all three.
4. **Tools are stateless ctrl-api proxies.** Every `buildRequest` returns a
   path under `/api/v1/…`; auth is always `Bearer AAS_API_KEY`
   (`src/tools/helpers.ts`). No direct store access, no docker exec, no
   secrets other than the env above. Upstream credentials (HA token, Sure
   key, Composio key) live in ctrl-api and MUST NOT be plumbed into this
   package.
5. **Secrets at rest are hashes.** OAuth/scoped token values are persisted
   SHA-256 only; the raw scoped token appears exactly once (mint/rotate). The
   single documented exception is `clients.client_secret` (raw, SDK
   requirement). List endpoints never expose raw tokens.
6. **mcp-server OWNS scoped tokens.** ctrl-api's `/api/v1/mcp/tokens/*` is a
   thin relay; validation happens locally here on every request. Don't add a
   second validation path elsewhere.
7. **Master-secret blast radius is deliberate.** `MCP_APPROVAL_SECRET` as a
   Bearer is equivalent to what `/approve` could already mint; keep the
   bypass and the form gated by the SAME secret.
8. **`plane` stays out** unless Plane returns to the deployed stack (removal:
   PR #279). Surfaces that still reference it (`skills/plane-mcp-skill.md`,
   stale header comments in `stdio-app.ts` / `hermes.ts` / `files.ts` naming
   plane in the app list, and the user-visible "one of: sure, plane"
   bad-resource error string in `src/oauth/provider.ts` `authorize()`)
   are dormant, not load-bearing.
9. **Session transports are in-memory, single-replica.** Scaling to multiple
   replicas requires a shared session store (noted in `index.ts`); do not
   naively replicate.

---

## Build, test, CI

| Concern | Command / path |
|---|---|
| Build | `cd packages/mcp-server && npm run build` (tsc → `dist/`) |
| Lane VERIFY | Package tests: `cd packages/mcp-server && npm test && npm run typecheck` (node:test; suites: `scopedTokens.test.ts`, `tools/{alfred,files,hass,paperclip}.test.ts`) — set this as the `.lane` manifest's `verify`; note `scripts/hooks/lanes.json` Lane V's DEFAULT verify is only `docker compose config -q` (there is no dedicated mcp-server lane; this package rides Lane V) |
| HTTP image | `.github/workflows/build-mcp-server.yml` → `ssdavidai00/alfred-mcp-server:latest` (context `packages/mcp-server`, own Dockerfile, `node --experimental-sqlite dist/index.js`) |
| stdio bundle → tenants | `.github/workflows/build-init.yml` **does** trigger on `packages/mcp-server/**` → `ssdavidai00/alfred-init:latest`; the init run syncs the bundle into every profile dir |
| Hermes runtime image | `.github/workflows/build-hermes.yml` does **NOT** trigger on `packages/mcp-server/**` — its baked `/opt/mcp-stdio` staging copy goes stale until the next `packages/hermes/**` change; runtime behaviour is unaffected because profiles execute the init-synced volume copy |

Deploying a tool change therefore requires: push → `build-mcp-server` +
`build-init` → on the VM `docker compose pull && docker compose up -d`
(re-runs init, which re-syncs the stdio bundle, then restart hermes).

---

## Change protocol

This CONTRACT.md is **forbidden-zone** (see `scripts/hooks/check_lane.py`):
lane commits that touch `**/CONTRACT.md` are rejected. Changes land via an
orchestrator (phase0) commit only, after the affected consumer lanes are
identified. If, while implementing against this contract, you find it is
wrong (a tool name, an env var, an auth path, a profile disposition), **STOP
and report the discrepancy** — do not improvise across the boundary, do not
"fix" the contract from inside a lane, and do not code to the observed
behaviour without flagging the divergence.

Known stale-comment debt inside the package (safe to fix in-lane, they are
comments not interfaces): `stdio-app.ts`/`hermes.ts`/`files.ts` headers still
enumerate `plane` in the app list; `hermes-config.yaml.njk`'s "base 7 /
7 baseline servers" counts predate the Plane removal.

## Reverse-proxy trust and client identity

The HTTP server must not use permissive Express proxy trust. Production deployments must set exactly one bounded topology: `MCP_TRUST_PROXY_HOPS` (currently 0–2, with the supported single-VM Caddy/cloudflared path set to `1`) or `MCP_TRUST_PROXY_IPS` (a comma-separated CIDR allowlist). The server fails during startup when production has neither, both, malformed values, or a hop count outside the bound.

The proxy must overwrite or safely append the forwarding headers it owns. Clients must not be able to select their rate-limit identity by supplying arbitrary `X-Forwarded-For` values. Direct, trusted single-hop, spoofed, multi-hop, and malformed forwarding-header cases are covered by the proxy-trust tests.
