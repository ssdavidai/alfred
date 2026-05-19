# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in the `alfred-black` repo.

## What this repo is

`alfred-black` is the single-VM, `docker compose up` reframing of the
`alfred-platform` SaaS fleet: **one repo, one VM, one stack** — no Acme Cloud
auto-provisioning, no Tailscale, no Cloudflare, no billing. The AI runtime is
**Hermes Agent** (`NousResearch/hermes-agent`), which replaces OpenClaw's
two-container split with a single isolated runtime running two profiles.

The full design is in `docs/PLAN.md` (Parts A–I) — read it before making
structural changes.

## Structure

```
alfred-black/
├── docker-compose.yaml      # single static stack — pull-only, never builds
├── .env.example             # single env template
├── scripts/bootstrap.sh     # generates secrets, validates .env, run once pre-`up`
├── caddy/Caddyfile          # bundled reverse proxy + automatic Let's Encrypt
├── packages/
│   ├── web/        ← the Wasp dashboard (auth + UI; proxies to ctrl-api)
│   ├── ctrl/       ← ctrl-api: the tenant API server (:3100) + the four-store layer
│   ├── learn/      ← alfred-learn: the Temporal intelligence layer
│   ├── mcp-server/ ← the MCP server bundle
│   ├── vault-init/ ← Vaultwarden bootstrap
│   └── hermes/     ← the Hermes runtime image
└── docs/PLAN.md    ← the complete plan
```

## Build commands

Each package builds independently. `docker compose up` only **pulls** images.

```sh
cd packages/ctrl && npm ci && node build.mjs   # → dist/api.mjs (the only ctrl artefact)
cd packages/ctrl && npm test                   # node:test suite
```

---

## The four-store architecture (PLAN.md Part I)

> **The vault is the principal's published output, not the system's database.**

alfred-black persists data in **four stores**, not one markdown directory:

| # | Store | Backing | Owner |
|---|-------|---------|-------|
| 1 | **Vault** | Markdown (`vault_data` volume) | alfred daemon, via ctrl-api |
| 2 | **`alfred-state.db`** | SQLite + WAL + sqlite-vec (`state_data`) | **ctrl-api — sole writer** |
| 3 | **Cold archive** | DuckDB/Parquet | deferred |
| 4 | **`ingest.db`** | SQLite (`ingest_data`) | ctrl-api — sole writer |

The operational store is named **`alfred-state.db`** (not `state.db`) to avoid
a filename collision with Hermes' own gateway-session store at
`$HERMES_HOME/state.db` — a different file in a different container.

Full detail: `packages/ctrl/docs/STORAGE-ARCHITECTURE.md`.

### The promotion contract — HARD RULE

> **A record exists in the vault only if the principal has a reason to read or
> edit it. Everything else is SQLite.**

The vault (Store 1) holds **exactly 12 canonical record types**:

```
matter  task  note  person  org  place  asset  chore  instinct  decision  briefing  daybook
```

(plus the `SOUL.md` / `RULES.md` singletons and `_templates/`).

**ctrl-api is the sole vault writer**, and it **enforces this in code**: every
vault write route calls `assertCanonicalVaultPath()`
(`packages/ctrl/src/db/promotionContract.ts`) before touching the filesystem.
A write to a non-canonical path is rejected with HTTP 422
`PROMOTION_CONTRACT_VIOLATION`. **No audit-class or signal/observation record
can ever be written as markdown.**

Demoted record types and their correct store:

- `signal-action` / `steward-action` / `desk-action` / `state-change` /
  `needs_attention_action` / `event` → `alfred-state.db` **`audit`** table.
- `signal` → `alfred-state.db` **`signal`**; `observation` / `pattern_proposal` /
  `synthesis` / `contradiction` / `assumption` / `constraint` →
  `alfred-state.db` **`observation`**.
- `stream_event` → `ingest.db` **`stream_event`**.

### Single-writer discipline

ctrl-api is the **only** process with a write handle to `alfred-state.db` and
`ingest.db`. `alfred-learn` and the alfred vault daemon write through ctrl-api
HTTP endpoints — never directly. Other services may open the files read-only.
This eliminates SQLite multi-process write contention and makes the
`vault_index` read-index drift structurally impossible.

When adding code that needs to persist a record, ask: *does the principal have
a reason to read or edit it?* If yes → a canonical vault type via the vault
routes. If no → `alfred-state.db` (working memory / audit) or `ingest.db` (raw
stream) via the `/api/v1/state/*` and `/api/v1/ingest/*` endpoints. Never add a
new vault directory.

---

## Hermes runtime

OpenClaw is replaced by **Hermes**. In ctrl-api code:

- The runtime container is `hermes` (compose service). The in-container CLI is
  `hermes` (`HERMES_CMD` / `HERMES_CONTAINER` in `src/api/helpers.ts`).
- Hermes runs two profiles — `main` (:18789, user-facing) and `workers`
  (:18790, background) — each with its own `config.yaml` under the
  `hermes_data` volume.
- ctrl-api reaches the runtime through the **hermes-shim**, which preserves the
  OpenClaw `POST /tools/invoke` contract — so most caller logic is unchanged.
- ctrl-api routes live under `/api/v1/hermes/*`; the old `/api/v1/openclaw/*`
  prefix is kept as an alias for one release, then dropped.

## Deploy batching

One PR per logical change. After a push that triggers CI, wait for the deploy
to finish and verify before pushing the next change. Don't batch unrelated
fixes into rapid pushes.
