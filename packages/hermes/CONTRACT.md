# CONTRACT.md — alfred-hermes

> Frozen cross-lane interface for `packages/hermes/**`. What this package
> provides to the rest of the stack and what it requires from it. Lane agents
> code against this file; if reality diverges, STOP and report (see Change
> protocol).

`packages/hermes` is the AI runtime of alfred-black. It produces the
**Hermes runtime image** (one container supervising one Hermes gateway per
registered profile — `main` :18789 / `workers` :18790 / `heavy` :18791, plus
the flag-gated `codex-builder` :18793 and dynamic user-facing profiles
:18794–18799), the **init image** (the one-shot bootstrap that scaffolds the
vault, renders every profile's config/.env, and mints the gateway token), and
the **alfred-worker image** (the vault daemon that drives curator/janitor/
distiller runs through the workers gateway). Every other service consumes
Hermes over plain HTTP on the compose network using one shared bearer token.

---

## Provides

### 1. Three Docker images

| Image | Dockerfile | CI workflow | Trigger paths | Build context |
|---|---|---|---|---|
| `ssdavidai00/alfred-black-hermes:latest` | `packages/hermes/Dockerfile` | `.github/workflows/build-hermes.yml` | `packages/hermes/**` | repo root (bundles `packages/mcp-server` stage) |
| `ssdavidai00/alfred-init:latest` | `packages/hermes/init/Dockerfile` | `.github/workflows/build-init.yml` | `packages/hermes/init/**`, the two `.njk` templates, `packages/hermes/mcp/**`, `packages/hermes/workspace-template/**`, `packages/mcp-server/**` | repo root |
| `ssdavidai00/alfred-worker:latest` | `packages/hermes/dockerfiles/alfred.Dockerfile` | `.github/workflows/build-alfred-worker.yml` | `packages/hermes/dockerfiles/alfred.Dockerfile`, `…/alfred-entrypoint.sh`, `packages/hermes/openclaw-wrapper`, `packages/alfred-vault/**` (NOT `dockerfiles/openclaw.Dockerfile`) | repo root |

`docker compose up` never builds — CI is the only publisher. Both hermes/init
workflows accept a `workflow_dispatch` `tag` input for canary builds that do
not clobber production `:latest`.

Version pins baked into the runtime image (`packages/hermes/Dockerfile`):

| Pin | Value | Note |
|---|---|---|
| `HERMES_VERSION` | `0.17.0` | **PyPI wheel**, not a git ref — the wheel ships `web_dist` (dashboard SPA), the git install does not |
| `OPENAI_VERSION` | `2.24.0` | openai SDK pinned to the golden-box version; still needs the null-output patch |
| `HERMES_LCM_REF` | `2d108b7…` (SHA) | hermes-lcm plugin, baked at `/opt/hermes-lcm` |
| `PAPERCLIP_MCP_REF` | `2026.525.0` | `@paperclipai/mcp-server` npm, baked at `/opt/paperclip-mcp` |
| `CODEX_CLI_REF` | `0.135.0` | `@openai/codex` npm — inert except for the codex-builder profile |

Four upstream patches are applied at build time, each idempotent and
**tripwired** (a grep after the patch fails the build loudly if the upstream
needle moved): HTML-attachment whitelist (`patch_upstream_hermes.py`),
openai-SDK `response.output=None` streaming fix (`patch_openai_sdk.py`),
profile-dir-aware `secure_parent_dir` chmod (`patch_upstream_hermes_auth.py`,
GH #119), fd-safe atomic writes (`patch_upstream_hermes_channeldir.py`,
GH #222). A `HERMES_VERSION` bump must re-verify all four.

### 2. The profile supervisor (`packages/hermes/docker/supervisor.sh`)

One container, one gateway process per registered profile, supervised with
restart + backoff (container exits after >20 restarts of one process). tini
is PID 1; the supervisor is its single child.

| Profile | Port | Role | Launch condition |
|---|---|---|---|
| `main` | **18789** | User-facing chat. Memory + channels + plugins enabled | always |
| `workers` | **18790** | Background agents (clerk, curator, janitor, distiller, ephemeral runs). No memory, no channels, concurrency cap 1 | always |
| `heavy` | **18791** | Heavy reasoning (onboarding, Reflection) on an Opus-class model. Workers posture, stronger model | always |
| `codex-builder` | **18793** | Sealed builder runtime, uid 10001, iptables egress jail, `mcp_servers: {}` | only when `ENABLE_CODEX_BUILDER=true` (boot-only — never spawned by reconcile) |
| user-facing profiles | **18794–18799** | Created via ctrl-api `POST /api/v1/agent-profiles`; rendered main-like (`is_main_like` in `init/render_hermes.py`) | registry-driven |

Profile enumeration is **registry-driven**: the supervisor reads
`$HERMES_HOME/profiles/_registry.json` (written by init's
`render_registry.py` from ctrl-api's `agent_profile` table, and re-written by
ctrl-api on every profile create/archive). On registry-read failure it falls
back to the hard-coded reserved set above. **SIGUSR1** = reconcile: ctrl-api
signals the container after every profile create/archive; the handler spawns
new gateways / SIGTERMs archived ones without a restart. A profile missing
its rendered dir at runtime is **self-rendered inline** by the supervisor
using the same renderer scripts + `.njk` templates baked at
`/opt/hermes-init` (#120 Lane IIb) — byte-identical to an init-time render.

After each gateway's `/health` goes 200, the supervisor POSTs
`{"status":"running"}` to
`http://ctrl-api:3100/api/v1/agent-profiles/<slug>/status` with
`Authorization: Bearer <AAS_API_KEY>` read from `profiles/main/.env`.

Supervisor boot-time side effects (all idempotent):

| Step | Behaviour |
|---|---|
| Sticky default | `hermes profile use main` — bare `hermes` in a `docker exec` opens the Alfred main profile |
| auth.json propagation | If `profiles/main/auth.json` exists, mirror to `workers` + `heavy` whenever theirs is missing or smaller (one OAuth identity for all profiles). With `ENABLE_CODEX_BUILDER=1` also mirrored to `codex-builder/auth.json` AND `codex-builder/.codex/auth.json` (codex-CLI auth), chowned 10001 mode 0600 |
| SOUL.md consolidation | Copies `profiles/main/SOUL.md` → `$HERMES_HOME/SOUL.md` (the file Hermes actually loads as persona) only if the source is >200 bytes AND the destination is missing, smaller, or contains the stock marker `You are Hermes Agent`. A hand-edited global SOUL is preserved |
| hermes-lcm install | Copies `/opt/hermes-lcm` → `profiles/main/plugins/hermes-lcm` once (guard: `! -e`). Main only |
| one-alfred install | Copies `/opt/one-alfred` → `profiles/main/plugins/one-alfred`, refreshed whenever the baked source mtime is newer. Main only |
| hermes-relay install | Copies `/opt/hermes-relay` → `profiles/main/plugins/hermes-relay` (mtime-refresh) + creates the site-packages `plugin` import-shim symlink. Main only |
| `verify_lcm` probe | Background: waits for main `/health` (≤240 s), then checks `GET /v1/tools` for `lcm_*` tools (CLI `hermes -p main plugins list` fallback); logs one `hermes-lcm OK` / `WARNING` line. A broken LCM install is otherwise silent |
| codex-builder egress jail | `codex-builder-setup-egress.sh` installs the uid-10001-scoped iptables OUTPUT allowlist **before** that gateway launches; on failure the codex-builder launch is skipped (main/workers/heavy stay up) |

Each gateway is launched as
`cd <profile_dir> && set -a && . .env && set +a && TERMINAL_CWD=<profile_dir> exec hermes -p <slug> gateway run --replace`
— the process cwd is the profile dir (so Hermes auto-discovers the profile's
`AGENTS.md`) and the profile `.env` is source-and-exported into the process
env (auth key visible in `/proc/<pid>/environ`; the 2026-05-28 hardening).

### 3. hermes-relay (:8767) + main dashboard (:9119)

Supervised alongside the gateways when `HERMES_RELAY_ENABLED` is truthy
(**default ON**; set `0/false/no/off` to opt out) and the relay plugin dir
exists:

| Process | Port | What |
|---|---|---|
| `relay` | **8767** | Native-app bridge (`python3 -m plugin.relay`): QR pairing, android/desktop remote control, provider-native realtime voice. Fronts the main gateway (`--webapi-url http://127.0.0.1:18789`) |
| `dashboard` | **9119** | `hermes -p main dashboard --isolated --skip-build --no-open --insecure --host 0.0.0.0` — the 0.17 wheel's bundled `web_dist` SPA scoped to the main profile |

Both bind 0.0.0.0 **inside the container only** (`hermes:8767` /
`hermes:9119` on the compose network). Tailnet/host exposure is a separate
per-tenant `tailscale serve` step — never done here, never public.
`--insecure` on the dashboard is required for the non-loopback bind under
0.17's OAuth gate; an authed DashboardAuthProvider is an open follow-up.

> Supersedes the 0.14-era claim (CLAUDE.md §9.3/§15.6) that the dashboard is
> unusable: the 0.17.0 **wheel** ships `web_dist` and the dashboard is now a
> supervised process. What is still NOT provided: any public or host-port
> exposure of it.

### 4. HTTP API contract (what callers get)

Hermes speaks the **OpenAI Responses API natively** — no shim (the
hermes-shim was retired in issue #40; gateways bind the canonical ports
directly, `API_SERVER_HOST=0.0.0.0`).

| Endpoint | Profiles | Known consumers |
|---|---|---|
| `POST /v1/responses` | all | alfred-learn clerk + ephemeral executors (:18790), onboarding/Reflection heavy calls (:18791), ctrl-api chat surfaces (:18789) |
| `POST /v1/runs` + `GET /v1/runs/{id}` | all | alfred-worker's `openclaw-wrapper` (create + poll, :18790) |
| `GET /health` | all | compose healthcheck, supervisor probes |
| `GET /v1/models` | all | advertises `API_SERVER_MODEL_NAME` (= the profile slug) |
| `GET /v1/tools` | all | supervisor `verify_lcm` probe |

**Auth**: every call carries `Authorization: Bearer <token>` where the token
is the content of **`/alfred-data/.gateway-token`** (written by init,
`chmod 644` so uid-1000 consumers like alfred-learn can read it). The same
value is rendered into every profile's `.env` as `API_SERVER_KEY`. The
`HERMES_API_SERVER_KEY` in `/opt/alfred/.env` is only a **first-boot seed**;
the live key is authoritative in the per-profile `.env`
(`packages/ctrl/src/api/routes/agents.ts` `readWorkersApiKey` pattern).
`:18789` is reserved for the principal's live chat; autonomous traffic goes
to `:18790`/`:18791`.

**Port exposure**: only `main` is published on the host, and only on
loopback (`127.0.0.1:18789:18789` in `docker-compose.yaml`) for SSH
local-forward access. All other ports are compose-network-only. The image
`EXPOSE`s 18789/18790 only; the deployed healthcheck is the compose-level
one (fd-pressure leading indicator across all `gateway run` pids at ≥90% of
the 65536 nofile limit, then HTTP probes of **both** :18789 and :18790 — a
dead workers gateway keeps the container unhealthy so alfred-learn's
`depends_on: service_healthy` never boots against a dead clerk gateway).

### 5. Per-profile config (`hermes-config.yaml.njk` + `hermes-profile.env.njk`)

Rendered by `init/render_hermes.py` (Jinja2; the `.njk` files are a
Jinja2-compatible subset) into `<profile_dir>/config.yaml` + `.env`.
Ownership split — **the load-bearing rule**:

- `config.yaml` is **operator-owned**: seeded once, never overwritten by a
  re-render. New template features reach existing tenants only via the
  idempotent ADD-only mutators run by init on every boot:
  `render_mcp_servers.py` (backfill missing required MCP servers),
  `migrate_main_profile_tool_trim.py` (issue #175 `tools.include`
  whitelists + `kanban.dispatch_in_gateway: false` add-if-unset — an
  explicit operator setting is preserved),
  `render_workers_pruning.py` (workers/heavy session-GC crons),
  `render_sms_gateway.py` (main SMS platform block).
- `.env` **is re-rendered every init run**, with runtime-managed keys
  (channel tokens etc., `_RUNTIME_KEY_PREFIXES` in `render_hermes.py`)
  merge-preserved.

Notable rendered behaviour (verify in the template before relying on it):
`kanban.dispatch_in_gateway: false` on every profile (fleet-wide);
`session_reset` idle 30 m on workers, daily/idle on main;
`delegation.max_concurrent_children: 1` on background profiles;
`approvals.mode: smart` on main, `off` on background profiles; main-profile
`tools.include` trims for `sure` / `hass` / `paperclip` (issue #175).

### 6. MCP server registrations (per profile config.yaml)

Sources: the 5-app stdio bundle compiled from `packages/mcp-server/src`
(staged in-image at `/opt/mcp-stdio`, rsynced by init into each profile's
`mcp-stdio/`), the ctrl HTTP proxy `packages/hermes/mcp/ctrl-server.mjs`,
and upstream `@paperclipai/mcp-server` at `/opt/paperclip-mcp`. Hermes
auto-namespaces tools as `mcp_<server>_<tool>`.

| Server | Kind | main | workers | heavy | codex-builder | Notes |
|---|---|---|---|---|---|---|
| `alfred-ctrl` | stdio Node → HTTP proxy to ctrl-api (`self` tool; + `tenant`/`ask_alfred` on Alfred Prime) | ✓ | ✓ | ✓ | — | env: `CTRL_API_URL`, `AAS_API_KEY` |
| `alfred` | stdio (bundle) | ✓ | ✓ | ✓ | — | vault + delegation + workflows |
| `sure` | stdio (bundle) | ✓ (trimmed) | ✓ | ✓ | — | ~95 tools; main gets a #175 `tools.include` whitelist |
| `vaultwarden` | stdio (bundle) | ✓ | ✓ | ✓ | — | |
| `execute` | stdio (bundle) | ✓ | ✓ | ✓ | — | Composio surface |
| `hass` | stdio (bundle) | ✓ (trimmed) | — | — | — | main-only (#110); proxies ctrl-api `/api/v1/channels/ha/*`; the HA token never reaches the MCP server |
| `paperclip` | stdio (upstream npm) | ✓ (trimmed) | ✓ | ✓ | — | needs `PAPERCLIP_API_KEY` = **board key** (`pcp_board_…`, minted by `init/bootstrap-paperclip.sh` step 12 into the profile `.env`) + `PAPERCLIP_COMPANY_ID`/`PAPERCLIP_AGENT_ID` |
| `files` | stdio (bundle) | ✓ | ✓ | — | — | Store-5 blob surface onto ctrl-api `/api/v1/files/*` (#114) |

Counts on `main` branch: main 8, workers 7, heavy 6, codex-builder 0
(`mcp_servers: {}` — the hard fence). User-facing dynamic profiles render
main-like and get the main set.

On every init boot, `render_mcp_servers.py` runs against every profile's
operator-owned `config.yaml`. Its reconciliation is idempotent: the ADD pass
backfills missing required registrations, then the REMOVE pass deletes retired
server keys (currently `plane`) from `mcp_servers`; unrelated operator-owned
blocks are preserved.

A deployment-conformance test pins the resulting graph: configured MCP server
keys must not include any retired key, and every HTTP-based server URL's host
must map to a service declared in the root `docker-compose.yaml`.

### 7. Init container responsibilities (`init/entrypoint.sh`)

One-shot, idempotent; every other service gates on
`service_completed_successfully`. In order:

| # | Step |
|---|---|
| 0 | Enumerate profiles via `render_registry.py` (ctrl-api's `agent_profile` table at `/ctrl-data/alfred-state.db`, **read-only**; falls back to the 4 reserved profiles when unreadable) and write `profiles/_registry.json`. Zero profiles = FATAL |
| 1 | Scaffold `/vault` from the `alfred-vault` package template (`rsync --ignore-existing`); ensure entity dirs; `memories/` dir chmod 0777 (cross-container writes from alfred-learn uid 1000) |
| 2 | Deploy per profile (skip codex-builder): skills (vault-worker + platform-native, hash-gated), `TOOLS.md`, `ctrl-server.mjs`, the mcp-stdio bundle (**unconditional `rsync -a --delete` — the image is authoritative**), `AGENTS.md`, `SOUL.md` (onboarding `/vault/SOUL.md` wins over the bundled baseline; hand-edited SOULs preserved) |
| 3 | Seed `/alfred-data/config.yaml` for the alfred vault daemon (from `config.yaml.tpl`; preserved once present) |
| 4 | Gateway token: honour `OPENCLAW_GATEWAY_TOKEN` if set, else generate `token_urlsafe(32)` → `/alfred-data/.gateway-token`, chmod **644** |
| 5 | Seed `/vault/intuition/index.md` + `matter/inbox.md` (the orphan-task fallback target) |
| 6 | Render each profile's `config.yaml` + `.env` (`render_hermes.py`) and run the ADD-only mutators (§5). Writes via `/hermes-state`, bakes runtime paths from `HERMES_RUNTIME_HOME` |
| 7 | `chown -R 10000:10000` on the hermes volume + `/vault`; codex-builder subtree re-owned 10001 mode 0711 + deploy-key write + negative-assert spot-checks (uid 10001 must NOT read `/vault`, `/alfred-data/.gateway-token`, other profiles' `.env` — NOT the rest of `/alfred-data`, which is deliberately 777) |
| 8–9 | Mirror `COMPOSIO_USER_ID` → `/alfred-data/.composio-user-id`; seed `/vault/.auth/authorized_senders.json` from `OWNER_EMAIL` |
| 10 | Stage Sure bootstrap inputs (email/password files + `bootstrap.rb` + the 16 `sure-*-mutate.rb` scripts) for the separate `sure-init` service |
| 11 | Stage Plane bootstrap inputs — **DORMANT**: the code still runs (gated `PLANE_ENABLED`, default true) but no `plane`/`plane-init` services exist in `docker-compose.yaml` since PR #279, so nothing consumes the staged files |

Telegram is deliberately NOT config-rendered: Hermes reads channel secrets
from the per-profile `.env`, owned by ctrl-api's
`PUT /api/v1/channels/telegram/token` (docker-exec write + gateway bounce).

`bootstrap-paperclip.sh` ships in this image but runs as the entrypoint of
the separate `paperclip-init` compose service (needs the docker socket), not
as part of `entrypoint.sh`.

### 8. alfred-worker + the `openclaw-wrapper` (carried forward, re-verified)

The `alfred` compose service runs `ssdavidai00/alfred-worker:latest` — the
Python vault daemon (`packages/alfred-vault`, vendored in-repo) plus the
Hermes-native `packages/hermes/openclaw-wrapper` (legacy filename kept so
`config.yaml.tpl`'s `OPENCLAW_WRAPPER_PATH` and the Dockerfile COPY keep
resolving). Contract:

| Connection | Address | Protocol |
|---|---|---|
| Hermes runtime | `http://hermes:18790` (workers profile — never main) | `POST /v1/runs` to create, `GET /v1/runs/{id}` to poll |

Gateway URL resolution: `HERMES_GATEWAY_URL` → `OPENCLAW_GATEWAY_URL` →
default `http://hermes:18790`; `ws://` is normalised to `http://`. Token
resolution: `/app/data/.gateway-token` → `/alfred-data/.gateway-token` →
`HERMES_API_KEY` / `OPENCLAW_GATEWAY_TOKEN` env → `OPENCLAW_GATEWAY_TOKEN_FILE`.
Hermes returns a flat run JSON (no double-encoded `result.content[].text`
envelope). The daemon shares `alfred_data` (mounted at `/app/data`) with the
stack so the wrapper can read prompt/manifest files. Provider keys are
deliberately blanked in this container — Hermes is the sole key holder.

---

## Requires

### hermes runtime service (`docker-compose.yaml`)

| Requirement | Value | Why |
|---|---|---|
| `HERMES_HOME` | `/hermes-state` (compose; image default `/opt/data`) | profile-state root |
| Volumes | `hermes_data:/hermes-state`, `vault_data:/vault`, `alfred_data:/alfred-data`, `hermes_codex_work:/work`, `files_data:/files:ro`, tmpfs `/tmp` | NO state_data mount — hermes never touches ctrl-api's DBs |
| `OPENCLAW_GATEWAY_TOKEN_FILE` | `/alfred-data/.gateway-token` | supervisor self-render token source |
| `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` | from `/opt/alfred/.env` | provider keys (everything else propagates via `main/.env`) |
| `CTRL_API_URL` | `http://ctrl-api:3100` | status callbacks + MCP children |
| `HERMES_HEAVY_MODEL` | default `anthropic/claude-opus-4-6` | heavy profile model |
| `ENABLE_CODEX_BUILDER` | default `false` | flag-gates the :18793 launch (profile dir renders everywhere regardless) |
| `HERMES_CODEX_BUILDER_MODEL` | default `gpt-5-codex` | |
| `HERMES_RELAY_ENABLED` | not set by compose → **on** | relay :8767 + dashboard :9119 |
| `HERMES_CRON_TIMEOUT` | `1800` | per-cron-job wall clock; must stay ≥ the largest Temporal execution_timeout being migrated (#56) |
| depends_on | `init` completed, `temporal` healthy | |
| caps | `cap_drop: ALL` + `DAC_OVERRIDE`, `NET_ADMIN`, `SETUID`, `SETGID` | last three exist for the codex-builder jail/uid-drop |
| ulimits / mem / pids | nofile 65536, `mem_limit: 12g`, `pids_limit: 2048 ` | #222 fd headroom; 12 g per PR #279 |

### init service

| Requirement | Value |
|---|---|
| Volumes | `vault_data:/vault`, `hermes_data:/hermes-state`, `alfred_data:/alfred-data`, `hermes_codex_work:/work`, `state_data:/ctrl-data:ro` |
| `HERMES_DATA_DIR` / `HERMES_RUNTIME_HOME` | both `/hermes-state` (init view / path baked into rendered configs) |
| `STATE_DB_PATH` | `/ctrl-data/alfred-state.db` (RO; registry + tool dispositions; graceful fallback when absent) |
| env_file `.env` | provider keys, `AAS_API_KEY`, `COMPOSIO_*`, `HERMES_MAIN_MODEL` (default `x-ai/grok-4.3`), `HERMES_WORKERS_MODEL` (default `openai/gpt-4.1-nano`), `HERMES_HEAVY_MODEL`, `OWNER_EMAIL`, `ALFRED_PRIME`/`CROSS_TENANT_PEERS` |
| Optional | `OPENCLAW_GATEWAY_TOKEN` (pre-set token), `ENABLE_CODEX_BUILDER`, `CODEX_BUILDER_DEPLOY_KEY_B64` |

### Consumed by

| Consumer | Connection | Uses |
|---|---|---|
| alfred-worker (`alfred` service) | `http://hermes:18790` | `/v1/runs` create+poll (vault subagents); `SURVEYOR_HERMES_GATEWAY_URL` same target |
| alfred-learn | `http://hermes:18790`, `:18791` | `POST /v1/responses` (clerk / ephemeral / onboarding-heavy) |
| ctrl-api | `:18789`–`:18799` + `docker exec` + SIGUSR1 | chat proxying, per-profile `.env` channel-token writes, agent-profile registry + reconcile signal, `/agent-profiles/:slug/status` callback receiver |
| voice-bridge, paperclip adapter | compose network | responses / runs on the relevant profile port |
| Operator | `docker exec` | `hermes` CLI (`alfred` = `hermes -p main`, `workers-cli`, `heavy-cli` wrappers baked in the image); SSH local-forward to `127.0.0.1:18789` for Hermes Desktop |

---

## Invariants (other lanes rely on these)

1. **One bearer, one file.** The Hermes API bearer for every profile ==
   the content of `/alfred-data/.gateway-token` == each profile `.env`'s
   `API_SERVER_KEY`. `HERMES_API_SERVER_KEY` in the tenant `.env` is a
   first-boot seed only; resolve the live key from the profile `.env`.
2. **Canonical ports are frozen**: 18789 main / 18790 workers / 18791 heavy
   / 18793 codex-builder / 18794–18799 dynamic. No shim, no compat layer.
   Only 18789 is host-published, loopback-only.
3. **Boot ordering**: init completes before hermes starts (compose gate);
   the supervisor additionally waits for `_registry.json` then each
   profile's `config.yaml` + `.env` (FATAL after 300 s/profile).
4. **`config.yaml` is operator-owned** — never overwrite; extend only via
   ADD-only mutators. **`.env` is deployment-owned** — re-rendered every
   init with `_RUNTIME_KEY_PREFIXES` merge-preservation. The mcp-stdio
   bundle is **image-owned** — rsync `--delete` on every init; never
   hand-edit it on the volume.
5. **codex-builder is sealed**: uid 10001, `mcp_servers: {}`,
   positive-allowlist `.env` (no `AAS_API_KEY`, no provider keys, no
   `PAPERCLIP_API_KEY`), iptables egress allowlist installed before launch,
   uid-10001 negative ACLs on `/vault` + `/alfred-data/.gateway-token` +
   other profiles' `.env`/`auth.json`/`config.yaml` (the rest of
   `/alfred-data` stays 777-readable). Adding an MCP server or env key
   there is a contract change.
6. **Workers stay lean**: no channels, no memory, concurrency cap 1,
   approvals off, hard-stop loop guardrails on. Principal-facing chat
   traffic goes to main only.
7. **Kanban dispatcher is disabled fleet-wide** (`kanban.
   dispatch_in_gateway: false` on every profile) — do not re-enable; work
   coordination flows through Paperclip.
8. **One OAuth identity**: `hermes auth login` on main is sufficient; the
   supervisor mirrors `auth.json` to the other profiles at every boot.
9. **Plugins are main-only** (hermes-lcm, one-alfred, hermes-relay) and
   installed by the supervisor from image-baked sources — never `pip
   install`ed, never installed on workers/heavy.
10. **Hermes never writes ctrl-api's stores** — no `state_data` mount in
    the runtime container; everything persistent goes through ctrl-api
    HTTP (single-writer discipline, CLAUDE.md §5.2).
11. **Container-unhealthy semantics**: the compose healthcheck requires
    BOTH main and workers `/health` plus fd-pressure <90%; dependents may
    trust `service_healthy` to mean "a live clerk gateway exists".
12. **Plane is dormant, not deployed** (PR #279): no plane compose
    services, no plane MCP registration. In-tree plane code (init step 11
    staging, the `plane` stdio app, learn/ctrl plane_sync) must be treated
    as dead surface; deleting it is an open follow-up — do not wire new
    features to it.

---

## Change protocol

`CONTRACT.md` is **forbidden-zone** (the commit gate rejects lane edits —
`scripts/hooks/check_lane.py`). Changes land only via an orchestrator/phase0
commit, together with the code that makes them true.

If you are a lane agent and this contract disagrees with the code you are
reading: **STOP and report the divergence** — do not improvise across the
boundary, do not "fix" the contract, do not code to the observed-but-
undocumented behaviour. Providers merge before consumers; a consumer lane
builds against the frozen shape here, never against the provider's branch.
