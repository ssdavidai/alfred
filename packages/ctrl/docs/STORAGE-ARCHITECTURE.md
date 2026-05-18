# Storage Architecture — the four stores

> alfred-black is born with four stores instead of forcing markdown to do six
> jobs. The vault is the principal's published output, not the system's
> database. See `docs/PLAN.md` Part I for the rationale.

This document is the contract for how alfred-black persists data. It is the
source of truth for ctrl-api, alfred-learn, and the alfred vault daemon.

---

## The four stores

| # | Store | Backing | Owner | Holds |
|---|-------|---------|-------|-------|
| 1 | **Vault** | Markdown files (`vault_data` volume) | alfred daemon, via ctrl-api | The principal's knowledge surface — the ~12 canonical record types. |
| 2 | **`state.db`** | SQLite + WAL + sqlite-vec (`state_data` volume) | **ctrl-api (sole writer)** | The machine's working memory — signals, observations, routing decisions, audit ledger, link graph, vault read-index, embeddings. |
| 3 | **Cold archive** | DuckDB / Parquet | — | Forensic long tail. **Deferred** — see "Store 3" below. |
| 4 | **`ingest.db`** | SQLite (`ingest_data` volume) | ctrl-api (sole writer) | Raw inbound stream events. Hard 7-day TTL, consume-then-delete. |

Separate from all four is the **`web-db` Postgres** — Wasp's own store for
`User`/auth/`ApiKey`/`OAuthCredential`. That is a framework requirement and is
out of scope here.

---

## Store 1 — the Vault (markdown)

The principal's knowledge surface: Obsidian-compatible, grep-able,
hand-editable, restic-backed. State transitions move files
(`matter/x.md` → `matter/_closed/x.md`).

### The 12 canonical record types

```
matter  task  note  person  org  place  asset  chore  instinct  decision  briefing  daybook
```

Plus the singletons `SOUL.md`, `RULES.md`, and the `_templates/` directory.
The vault seed scaffolds **only** these — `packages/ctrl/src/templates/vault-seed/_templates/`
has exactly one template per canonical type.

### The promotion contract — the hard rule

> **A record exists in the vault only if the principal has a reason to read or
> edit it. Everything else is SQLite.**

ctrl-api is the **sole vault writer**, and every vault write route calls
`assertCanonicalVaultPath()` (`src/db/promotionContract.ts`) before touching
the filesystem. A write to a non-canonical path is rejected with HTTP 422
`PROMOTION_CONTRACT_VIOLATION` — the error names the correct store.

**Demoted types and where they now live:**

| Was a vault type | Now lives in |
|------------------|--------------|
| `signal-action`, `steward-action`, `desk-action`, `state-change`, `needs_attention_action`, `event` | `state.db` → `audit` |
| `signal` | `state.db` → `signal` |
| `observation`, `pattern_proposal`, `synthesis`, `contradiction`, `assumption`, `constraint` | `state.db` → `observation` |
| `stream_event` | `ingest.db` → `stream_event` |

---

## Store 2 — `state.db`

ctrl-api's own SQLite file (`node:sqlite`). The machine's working memory.

- **Single-writer discipline.** ctrl-api is the **only** process with a write
  handle. `alfred-learn` and the alfred vault daemon write through ctrl-api
  HTTP endpoints. Other services may open it read-only. This eliminates
  multi-process write contention and makes `vault_index` drift structurally
  impossible.
- **PRAGMAs:** `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`,
  `synchronous=NORMAL` — applied at open in `src/db/state.ts`.
- **Schema:** `src/db/schema.sql` (CREATE-only, exec'd idempotently at boot).

### Tables

| Table | Purpose |
|-------|---------|
| `signal` | Inbound salience extracted from a stream event. |
| `observation` | What the intuition engine learns watching the principal act. |
| `routing_decision` | How a signal was routed (ask/confirm/act). Named `routing_decision` — **not** `decision` — to avoid colliding with the vault's `decision/` type. |
| `audit` | The machine-verifiable audit ledger — every `*-action` / `state_change` / `decision`. |
| `link` | The cross-record graph edge. |
| `vault_index` | The SQL read-index over Store 1 (one row per canonical vault record). |
| `embedding` + `embedding_meta` | The sqlite-vec vector store (768-dim, `nomic-embed-text`). |
| `health_checks`, `events` | Kept from the original ctrl schema; single-VM (`instance_id` is always `0`). |

Every hot table carries a `ts` column (the Store-3 TTL anchor).

### `vault_index` — the read index

ctrl-api keeps this exact by updating it on **every** vault write
(`src/db/vaultIndex.ts`, hooked into `emitVaultEditSignal`). A **boot-time
reconciler** (`reconcileVaultIndex()`) walks the vault once at startup to catch
out-of-band edits (a human editing markdown directly in Obsidian, a restore
from backup). After boot the per-write hooks keep it current. The
`/decisions` list route and `/api/v1/vault-index` serve from here.

### `embedding` — vector store (resolves the QMD parity gap)

Hermes drops QMD. Vault semantic recall becomes an MCP search tool →
ctrl-api → a k-NN query against the sqlite-vec `embedding` virtual table. The
extension is baked into the ctrl-api image and loaded at boot
(`SQLITE_VEC_PATH`); if absent, embedding endpoints return 503 and everything
else still works.

---

## Store 3 — cold archive (DEFERRED)

Greenfield alfred-black has no 90d+ cold data for months, so the DuckDB/Parquet
compactor is a later phase. The hot `state.db` tables already carry `ts`
columns, and `schema.sql` reserves the archive table names
(`archive_signal`, `archive_observation`, `archive_routing_decision`,
`archive_audit`, `archive_link`). No archive tables are created yet.

---

## Store 4 — `ingest.db`

A **separate** SQLite file from `state.db` (`src/db/ingest.ts`) so a firehose
burst of inbound events never takes the `state.db` write lock.

- **One table:** `stream_event` — raw inbound payloads, sequential consume.
- **Hard 7-day TTL.** A periodic in-process sweep (`sweepIngestTTL`, every 6h)
  deletes events older than 7d whether or not they were consumed. There is
  **no archive** — this store is consume-then-delete by design.
- The sweep alerts on events still unprocessed at the 7d mark (`stale_dropped`
  in `ingest_sweep_log`) — that means the EventProcessor has fallen behind.
- NATS/JetStream was considered and rejected for a single-VM "just works" box
  (no daemon). It stays a documented future option.

---

## ctrl-api endpoints

### state.db (Store 2) — `/api/v1/state/*`

| Method + path | Purpose |
|---------------|---------|
| `POST/GET /signals`, `GET/PATCH /signals/:id` | signal CRUD |
| `POST/GET /observations`, `GET/PATCH /observations/:id` | observation CRUD |
| `POST/GET /routing-decisions`, `GET/PATCH /routing-decisions/:id` | routing-decision CRUD |
| `POST/GET /audit`, `GET /audit/:id` | audit ledger append + query |
| `POST/GET /links`, `DELETE /links/:id` | link graph |
| `POST /embeddings`, `POST /embeddings/search`, `DELETE /embeddings` | vector store |

### vault_index (Store 2) — `/api/v1/vault-index*`

| Method + path | Purpose |
|---------------|---------|
| `GET /api/v1/vault-index` | list canonical vault records (filter: type, status, since) |
| `GET /api/v1/vault-index/type-counts` | record count per type |
| `GET /api/v1/vault-index/*` | one record's index row by vault path |
| `POST /api/v1/vault-index/reconcile` | force a full reconcile walk |

### ingest.db (Store 4) — `/api/v1/ingest/*`

| Method + path | Purpose |
|---------------|---------|
| `POST/GET /events`, `GET /events/:id` | stream-event append + query |
| `GET /events/pending` | oldest-first feed for the EventProcessor |
| `POST /events/:id/processed` | mark an event consumed |
| `POST/GET /sweep` | run / inspect the 7d TTL sweep |

### Re-backed existing routes

`GET /api/v1/state-changes` and `GET /api/v1/state-changes/sources` now serve
from the `audit` table; `GET /api/v1/decisions` serves from `vault_index`. The
write routes (`POST /state-changes`, `POST /decisions`, the needs-attention and
desk-action routes) mirror every action into the `audit` table via
`appendAudit()`.

---

## Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `STATE_DB_PATH` | `/state/state.db` | state.db location (mount the `state_data` volume here). |
| `INGEST_DB_PATH` | `/ingest/ingest.db` | ingest.db location (mount the `ingest_data` volume here). |
| `SQLITE_VEC_PATH` | `/usr/local/lib/sqlite-vec/vec0.so` | sqlite-vec loadable extension (baked into the image). |
| `EMBEDDING_DIM` | `768` | embedding vector dimension. |
| `INGEST_TTL_DAYS` | `7` | hard TTL for `stream_event`. |
| `INGEST_SWEEP_INTERVAL_MS` | `21600000` (6h) | TTL sweep cadence. |
| `VAULT_PATH` | `/vault` | the markdown vault (Store 1) mount point. |
