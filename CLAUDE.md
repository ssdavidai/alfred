# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in the `alfred-black` repo.

## What this repo is

`alfred-black` is the single-VM, `docker compose up` reframing of the
`alfred-platform` SaaS fleet: **one repo, one VM, one stack** — no Hetzner
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

## Bug-fixing protocol (SOURCE OF TRUTH — this is how bugs get fixed here)

Two modes: **investigate** (read-only fan-out → reports) then **fix**
(gate-protected lane fan-out). The point is to run as many parallel agents as
the work allows **without conflicts or contract violations** — by making a bad
commit *impossible to land*, not by trusting agents to behave. Anchored by
`docs/FAILURE-MODES.md` (the audit), `docs/FIX-PLAN.md` (the lane plan),
`docs/FIX-CONTRACTS.md` (frozen cross-lane interfaces), and `scripts/hooks/`
(the commit gate).

### Mode A — Investigation fan-out (read-only)
For mapping unknown breakage (e.g. a pass over the live product):
- **One agent per issue**, scoped narrowly, run as parallel background agents.
- **Strictly read-only**: no code edits, no live writes. Say so explicitly
  ("no POST/PUT/DELETE, no `docker` writes"); require each agent to **disclose
  any unavoidable probe side-effect** (a connect/init probe *can* mint stray
  rows — it happened).
- Each writes ONE report to a git-ignored **`debug/<MMDD>/<issue>-findings.md`**:
  exact code path (`file:line`), live evidence, **root-cause vs environmental
  caveat** (separate real bugs from credit/quota/stale-deploy noise), a "desired
  happy path", and a prioritized list.
- Track each as a task; surface each as it lands; then **synthesize** all
  reports into one plan grouped by **cross-cutting root cause** (most symptoms
  collapse into a few seams).
- Live access is read-only SSH; **inline the SSH options on every call** (a
  shell variable won't word-split under zsh).

### Mode B — Fix fan-out (gate-protected, parallel-safe)
1. **Rank bugs in `FAILURE-MODES.md` with the exact code path. Failing-test-first:**
   write a red repro test, then fix to green — never fix against an assumption.
2. **Phase 0 first, sequentially (orchestrator only):** build shared foundations
   everything sits on (migration runner, the contracts, the gate). These are
   forbidden-zone files; nothing parallel starts until they land.
3. **Freeze the contracts** (`FIX-CONTRACTS.md`, C1…) *before any lane codes*.
   A consumer lane builds against the frozen shape and never needs the
   provider's code. **If a contract is wrong, the lane STOPs and reports — it
   never improvises across the boundary.**
4. **Package-scoped lanes**, non-overlapping glob territory (→ conflict-free
   merges by construction): **I**·ctrl `packages/ctrl/**` · **II**·learn
   `packages/learn/**` · **III**·web `packages/web/**` · **IV**·alfred-vault
   `packages/alfred-vault/**` · **V**·edges/infra (`packages/{hermes,mcp-server,vault-init}/**`,
   `scripts/**`, `caddy/**`, `docker-compose.yaml`, `.env.example`, `Makefile`,
   `docs/**`). **At most one agent per lane at a time** — lanes parallel, tasks
   within a lane serial.
5. **The commit gate makes violations impossible to land** (`scripts/hooks/`,
   `bash scripts/hooks/install.sh` sets `core.hooksPath`, inherited by every
   worktree). On `git commit`, `check_lane.py` rejects the diff if it: (a) leaves
   the lane's `allowed` globs, (b) touches the **forbidden zone** (`schema.sql`,
   `db/migrations/**`, `migrate.ts`, `api/server.ts`, `**/CONTRACT.md`, the
   `FIX-*`/`FAILURE-MODES` docs, `scripts/hooks/**`, `CLAUDE.md`), (c) exceeds
   **~200 net LOC**, or (d) fails the lane **VERIFY** (build / `tsc` / pytest /
   `compose config` — the regression gate). The lane is declared by a `.lane`
   manifest at the worktree root (`{"lane":"II","verify":"…"}`). The **main
   checkout (no `.lane`) is `phase0`** — orchestrator, allow-all. A linked
   worktree with **no `.lane` is rejected** (fail-safe). **Never use
   `ALFRED_SKIP_VERIFY`.**
6. **Agent brief** = LANE / GOAL (one sentence) / ALLOWED + FORBIDDEN globs /
   VERIFY / CONTRACT (the package `CONTRACT.md` + the relevant `FIX-CONTRACTS.md`
   clause) / SCOPE ~200 LOC (if bigger, STOP and report) / WHEN DONE: 3-line PR
   note, start nothing else. Standing preamble: *first action — write `.lane`;
   read your contracts; touch only ALLOWED; code against the frozen contracts; a
   blocked commit means re-scope, not override.*
7. **Sequence vs parallelize.** Fan out lanes **in parallel** when their globs
   are disjoint **and** the boundary contract is frozen. **Sequence** (provider
   PR → consumer PR) when a consumer needs a provider's new shape, or when a
   "disjoint" file turns out shared (move it to the forbidden zone, Phase-0-owned,
   and lanes consume it). Merge order = **providers before consumers**. The gate
   surfaces any cross-lane collision *immediately* as a blocked commit, never as
   a tangled merge.
8. **One PR per logical change → build → deploy to the verify VM → smoke → only
   then the next PR.** Push to `main` lets CI build `:latest`; never clobber a
   production `:latest` or push public `main` without explicit confirmation —
   verify on a throwaway tag/VM first.

### Hard-won rules (these bit me — do not relearn them)
- **`isolation: worktree` does NOT guarantee isolation.** Agents have shared the
  working tree and overwritten each other's `.lane`. Either confirm each agent
  got a real separate worktree, **or** run coordinated cross-package work
  yourself in the main checkout (phase0), one commit at a time. **Always
  `git show --stat` each agent's commit** to confirm it touched only its own
  files before trusting it.
- **Agents must never run `npm install/ci/prune`** — it corrupts the shared
  symlinked `node_modules`. VERIFY uses existing deps.
- **Stage only your own files** (`git add <paths>`, never `git add -A`) — never
  sweep up `node_modules`/lockfile churn or another lane's work.
- **Clean up a stale `.lane`** before an orchestrator (phase0) commit — a
  leftover lane marker blocks a legitimate cross-cutting commit.
- Forbidden-zone files (contracts, migrations, `schema.sql`, `server.ts`,
  `scripts/hooks/**`, `CLAUDE.md`) are **orchestrator-only**, edited centrally —
  never inside a lane.
