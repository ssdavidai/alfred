# Storage Architecture — Vault + SQLite + Cold Archive

> Status: **Accepted and shipped 2026-05-18**. Originally drafted in
> response to the david-tenant degradation: 87,847 vault files, 6–7s
> list latency, /brief rendering as "quiet morning" fallback,
> al-session-tracker and al-judgment workflows looping on timeouts.
>
> Epic [#898](https://github.com/ssdavidai/alfred-platform/issues/898)
> shipped all six phases in a single session. Outcome on david:
>
> - vault file count: **88,312 → 6,981** (-92%)
> - ctrl-api list endpoint p95: **6–7s → 4–7ms** (~1000×)
> - audit table in state.db: 73,691 rows (migrated + live shadow)
> - all 4 tenants on persistent state.db (`/opt/alfred/state`), restic
>   backups verified, canonical-path enforcement in `warn` mode
>
> All originally-scoped followups closed 2026-05-19:
> - **#477** state.db bind on alfred-learn applied to all 4 tenants;
>   archival_sweep workflow now compacts SQLite to Parquet on the
>   daily 03:00 UTC schedule.
> - **#478** lockdown completed via Rounds A→G (#480–#485):
>   migration 006 added pattern_proposal + needs_attention tables;
>   migration 007 added a `payload` JSON column to the signal table;
>   alfred-learn writers migrated off all four banned types; SaaS
>   readers cut over to the SQL endpoints; downstream readers
>   (route_signal_action, dispatch_action_to_agent,
>   apply_signal_mutation, check_decision_outcomes) all read from
>   SQL now. `CANONICAL_PATH_ENFORCEMENT` default flipped to
>   `enforce` — the four-store lockdown is in effect.
>
> The only remaining open issue from this session is the
> pre-existing **#479** openclaw `.gateway-token` permission bug
> (root:root mode 600 keeps getting rewritten; blocks all
> alfred-learn clerk/LLM calls). That predates and is independent
> of this epic.

---

## 1. The problem we're actually solving

Today every persistent fact in Alfred lives as a markdown file in `/vault/<type>/<id>.md`. That includes:

- The principal's actual knowledge (matter, task, note, person, org, instinct)
- The machine's working memory (signal, observation, decision)
- The machine's audit log (signal-action, steward-action, desk-action, needs_attention_action, auto-task-created, state-change)
- Raw inbound payloads (stream_event)
- Derived intermediates (pattern_proposal, synthesis, contradiction, assumption, constraint, noise, signal_noise_pattern)
- System bookkeeping (event, _bases, _templates, _archive, run, view, index, temp, triage, input, dashboard, inbox)

On david this has produced:

| Directory | File count |
|---|---:|
| event/ | 73,653 |
| stream_event/ | 6,994 |
| task/ | 1,884 |
| note/ | 1,306 |
| org/ | 974 |
| person/ | 720 |
| observation/ | 683 |
| needs_attention/ | 515 |
| signal/ | 335 |
| decision/ | 258 |
| _all others_ | ~430 combined |
| **total** | **~87,800** |

Of those, **the principal's actual mental model is 12 matters, 1,884 tasks, 1,306 notes, 720 people, 974 orgs, 17 instincts, 9 chores — roughly 5,000 records.** The remaining ~83,000 are machine bookkeeping that has nowhere else to go.

### Why latency degrades non-linearly

Every ctrl-api list endpoint calls `walkMd(VAULT_PATH, ...)` (packages/ctrl/src/api/routes/vault.ts:681), which walks the *entire* vault and reads frontmatter on every `.md` file. So:

- A `GET /api/v1/vault/list/matter` reads 87,847 frontmatter blocks to return 12.
- A briefing visit-active-matters loop calls that endpoint and times out at the httpx default, gets an empty list back via a swallowed `httpx.HTTPError`, and writes a "quiet morning" fallback brief.
- SessionTrackerWorkflow's `fetch_recent_records` hits the same wall and accumulates 40+ retry attempts before being terminated.
- Every operation that "scans the vault" pays for every dead file ever written.

The growth pattern is roughly:

- Audit-trail accumulation: ~1,300/day on david at steady state. Linear in tenant lifetime.
- List endpoint latency: roughly linear in file count.
- Per-tick workflow load: roughly linear in latency × scheduled frequency.
- **Total system load: quadratic in tenant lifetime.**

That is what "degrading at crazy speeds" actually means: each day's audit growth makes every subsequent day's workflow tick slower.

### What set today on fire

A janitor activity scanned the vault around 12:38 UTC and rewrote every record in `event/` to add `janitor_note: ORPHAN001 -- No inbound wikilinks from any other record` to the frontmatter. On david that touched 73,652 files in five minutes (~250 writes/sec). During the burst, ctrl-api list endpoints starved, briefing/session-tracker/judgment workflows timed out and accumulated retries, and openclaw-workers leaked clerk children waiting on stuck Temporal activities. Rapali got the same treatment 20 minutes later.

The janitor was not wrong to tag orphans. It was wrong to do 73,000 writes in one tick against a flat directory.

---

## 2. Principle

**The vault is the principal's persistent knowledge surface, not the system's database.**

This is the single sentence that resolves the architecture. Restated:

- The vault exists for the human. It must remain hand-readable, hand-editable, Obsidian-compatible, grep-able, restic-cheap, plain-text.
- The machine's working memory, audit log, time-series ingest, embedding index, and wikilink graph have nothing to do with the human. They were put in the vault because there was no other store. We're going to give them one.
- Records get written to the vault only when the principal has a reason to read or edit them. Everything else is bookkeeping, and bookkeeping belongs in a database.

This is the **promotion contract**. It is enforced in code (ctrl-api rejects writes to non-canonical vault paths) and documented in CLAUDE.md so future contributors don't quietly add a new markdown record type for some new audit.

---

## 3. The four stores

```
                       ┌──────────────────────────────────┐
                       │  STORE 1 · VAULT (markdown)      │
                       │  the principal's knowledge       │
                       │  ~5,000 files, bounded           │
                       └────────────────┬─────────────────┘
                                        │ deliberate promotion
                                        │ (only principal-facing facts)
                                        │
       ┌────────────────────────────────┴────────────────────────────┐
       │                                                              │
       ▼                                                              ▼
┌──────────────────────┐                              ┌──────────────────────┐
│ STORE 2 · SQLITE     │  ──── TTL compact ─────►     │ STORE 3 · COLD       │
│ working memory       │       (per-table)            │ DuckDB / Parquet     │
│ signals, audit,      │                              │ forensic long tail   │
│ embeddings,          │                              │ never on hot path    │
│ vault_index, links   │                              └──────────────────────┘
└──────────┬───────────┘
           ▲
           │ consume + processed_at
           │
┌──────────┴───────────┐
│ STORE 4 · STREAM LOG │
│ NATS or JSONL        │
│ raw inbound, 7d TTL  │
└──────────────────────┘
```

### Store 1 — Vault (markdown, `/vault/`)

**Purpose.** The principal's persistent knowledge surface. The thing they can `cd` into, grep, edit in Obsidian, sync to their laptop, restore from restic.

**Contents (final list, ~12 types):**

```
/vault/
├── matter/           active matters; closed → matter/_closed/
├── task/             active tasks; done → task/_closed/
├── note/             principal's notes
├── person/           people in the principal's life
├── org/              organizations
├── place/            locations referenced enough to be named
├── asset/            durable things owned (laptop, car, accounts)
├── chore/            recurring work definitions (visible in /chores UI)
├── instinct/         learned patterns (Asking / Confirming / Acting)
├── briefing/         daily letterpress briefs the principal reads
├── daybook/          principal's daily journal
├── decision/         the principal's recorded decisions (the ones they care about)
├── SOUL.md           the principal's voice/aesthetic preset
├── RULES.md          the principal's standing rules
└── _templates/       templates the principal might edit
```

That's roughly 5,000 files steady-state on david. Bounded by what's actually in the principal's life.

**Properties.**
- Obsidian-compatible (no schema, just YAML frontmatter + markdown body)
- Hand-readable, hand-editable
- Backed up by restic to Hetzner S3
- Mounted into containers at `/mnt/encrypted/vault` (LUKS2)
- State transitions are file moves: `matter/x.md → matter/_closed/x.md`

**What's NOT in the vault** (moved to Store 2):

```
audit-trail        signal-action, steward-action, desk-action,
                   needs_attention_action, auto-task-created,
                   state-change, steward-source-pruned
trace              signal, observation, pattern_proposal
intermediates      synthesis, contradiction, assumption, constraint,
                   reflection, session, conversation, memory,
                   signal_noise_pattern, noise
bookkeeping        event, _bases, run, view, index, temp, triage,
                   input, dashboard, inbox, ledger_entry, skill,
                   webhook_endpoint, account, idea, audio, process,
                   project (if not principal-facing), location
                   (collapsed into place), intuition (collapsed into instinct)
```

These do not disappear — they are written to SQLite. The principal still sees them rendered (Desk shows needs_attention rows from SQL, /decisions shows audit rows from SQL, /instincts shows instinct files with observation counts from SQL).

### Store 2 — SQLite (`/var/lib/alfred/state.db`)

**Purpose.** The machine's working memory: every read/write the machine does to service its own logic and to render UI surfaces.

**Why SQLite specifically.**
- Single file. Restic-backupable in one line.
- No daemon, no port, no auth, no connection pool.
- WAL mode comfortably handles thousands of writes/sec on cheap hardware.
- Node has `node:sqlite` built in (already used by ctrl-api for `data/alfred-ctrl.db`).
- Python has `sqlite3` in stdlib.
- We are tenant-isolated single-VM by design. Postgres's operational weight buys us nothing.
- Datasette-style "the database is a file" matches Alfred's "files you can hand-touch" ethos.

**Tables.**

```sql
-- the read accelerator for the vault; replaces walkMd entirely
CREATE TABLE vault_index (
    record_id     TEXT PRIMARY KEY,
    record_type   TEXT NOT NULL,
    path          TEXT NOT NULL,           -- '/vault/matter/foo.md'
    mtime_ns      INTEGER NOT NULL,
    state         TEXT,                    -- 'open' / 'closed' / 'archived'
    parent_matter TEXT,                    -- foreign key into vault
    frontmatter   TEXT NOT NULL,           -- raw JSON
    body_first_n  TEXT,                    -- first ~500 chars for search
    UNIQUE(path)
);
CREATE INDEX vi_type_state    ON vault_index(record_type, state);
CREATE INDEX vi_type_mtime    ON vault_index(record_type, mtime_ns DESC);
CREATE INDEX vi_parent_matter ON vault_index(parent_matter);

-- decision-grade signals extracted from raw stream events
CREATE TABLE signal (
    id             TEXT PRIMARY KEY,
    ts             INTEGER NOT NULL,       -- unix ns
    source_type    TEXT NOT NULL,          -- 'gmail' | 'gcal' | 'composio' | ...
    source_event   TEXT,                   -- ref into Store 4
    target_matter  TEXT,                   -- vault matter path or null
    target_kind    TEXT,                   -- 'matter' | 'person' | 'org' | ...
    actor          TEXT,                   -- principal | alfred | <person>
    decision_required INTEGER NOT NULL,
    display_headline  TEXT,
    display_body      TEXT,
    body              TEXT NOT NULL,       -- the extracted signal text
    processed_at      INTEGER,             -- when downstream consumed
    classified_noise  INTEGER DEFAULT 0
);
CREATE INDEX sig_ts            ON signal(ts DESC);
CREATE INDEX sig_target_matter ON signal(target_matter, ts DESC);
CREATE INDEX sig_source_type   ON signal(source_type, ts DESC);
CREATE INDEX sig_unprocessed   ON signal(processed_at) WHERE processed_at IS NULL;

-- learning trace: one row per signal-tagged-as-instance-of-an-instinct
CREATE TABLE observation (
    id          TEXT PRIMARY KEY,
    ts          INTEGER NOT NULL,
    signal_id   TEXT REFERENCES signal(id),
    instinct_id TEXT NOT NULL,             -- vault path 'instinct/foo.md'
    confidence  REAL,
    embedding_id INTEGER                   -- foreign key into embedding
);
CREATE INDEX obs_instinct_ts ON observation(instinct_id, ts DESC);
CREATE INDEX obs_signal      ON observation(signal_id);

-- the unified audit log; replaces 6+ markdown record types
CREATE TABLE audit (
    id            TEXT PRIMARY KEY,
    ts            INTEGER NOT NULL,
    actor         TEXT NOT NULL,           -- 'steward' | 'desk' | 'router' | ...
    action_type   TEXT NOT NULL,           -- 'state_change' | 'signal_action' | ...
    target_type   TEXT NOT NULL,           -- 'matter' | 'task' | 'signal' | ...
    target_id     TEXT NOT NULL,           -- vault path or signal id
    decision_origin TEXT,                  -- where this decision started
    reasoning     TEXT,
    payload       TEXT NOT NULL,           -- JSON; varies by action_type
    reversible    INTEGER NOT NULL DEFAULT 0,
    reversed_by   TEXT REFERENCES audit(id)
);
CREATE INDEX audit_ts             ON audit(ts DESC);
CREATE INDEX audit_target         ON audit(target_type, target_id, ts DESC);
CREATE INDEX audit_actor          ON audit(actor, ts DESC);
CREATE INDEX audit_action         ON audit(action_type, ts DESC);
CREATE INDEX audit_reversible_open ON audit(reversible) WHERE reversible = 1 AND reversed_by IS NULL;

-- decisions (the ones the principal cares about) live in the vault as
-- markdown for human-readability; this table is for the machine's index
-- and links. The vault file is the source of truth for the human-visible
-- text; this table is the queryable surface.
CREATE TABLE decision (
    id          TEXT PRIMARY KEY,           -- matches vault file slug
    vault_path  TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    signal_id   TEXT REFERENCES signal(id),
    type        TEXT,
    outcome     TEXT,
    actor       TEXT
);
CREATE INDEX dec_ts     ON decision(ts DESC);
CREATE INDEX dec_signal ON decision(signal_id);

-- the wikilink graph; derived from frontmatter + inline [[wikilinks]]
CREATE TABLE link (
    from_id   TEXT NOT NULL,
    from_type TEXT NOT NULL,
    to_id     TEXT NOT NULL,
    to_type   TEXT NOT NULL,
    rel       TEXT NOT NULL,                -- 'parent_matter' | 'wikilink' | 'derived_from' | ...
    PRIMARY KEY (from_id, to_id, rel)
);
CREATE INDEX link_to    ON link(to_id, to_type);
CREATE INDEX link_from  ON link(from_id, from_type);

-- vector embeddings for instinct matching and clustering
-- (uses sqlite-vec extension; one shared embedding space)
CREATE VIRTUAL TABLE embedding USING vec0(
    id INTEGER PRIMARY KEY,
    record_id TEXT,
    record_type TEXT,
    embedding FLOAT[768]
);

-- workflow run history (already exists as JSONL on disk; collapse here)
CREATE TABLE chore_run (
    id          TEXT PRIMARY KEY,
    chore_slug  TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    status      TEXT NOT NULL,
    summary     TEXT
);
CREATE INDEX cr_chore_started ON chore_run(chore_slug, started_at DESC);
```

**Sizing.** At david's current velocity (~1.3k audit/day, ~50 signals/day, ~100 observations/day):
- After 1 year: ~500k audit rows, ~18k signals, ~36k observations
- SQLite database size: ~250–400 MB
- Comfortably 100× headroom on a single SSD.

**Properties.**
- One file: `/var/lib/alfred/state.db`
- WAL mode, `synchronous=NORMAL`
- Mounted on the LUKS volume alongside the vault
- Backed up the same way the vault is

### Store 3 — Cold Archive (DuckDB or Parquet/zstd bundles)

**Purpose.** TTL-compacted long tail. Audit rows older than 90 days. Signals older than 90 days. Stream events that survived past 7 days. Never touched by hot paths. Read only on explicit forensic drill-down.

**Why DuckDB / Parquet specifically.**
- Columnar compression: 10–100× smaller than SQLite rows.
- DuckDB attaches Parquet files as tables (`ATTACH '/vault/_archive/2026-04.parquet' AS apr;`). No daemon.
- DuckDB has compatible SQL with SQLite, so the audit-feed query can span both tiers with a `UNION ALL`.
- The SaaS host already runs ClickHouse for fleet analytics, but per-tenant cold storage doesn't need a daemon — DuckDB is right-sized.

**Layout.**

```
/vault/_archive/
├── 2026-04/
│   ├── audit.parquet
│   ├── signal.parquet
│   ├── observation.parquet
│   └── stream_event.parquet
├── 2026-05/
│   └── ...
```

**Compaction policy.**
- Daily job (Temporal `archival_sweep` extended): for each table with a TTL, COPY rows older than the TTL to `<month>.parquet`, then DELETE from SQLite.
- Per-table TTL:
  - `audit`: 90 days hot
  - `signal`: 90 days hot
  - `observation`: 90 days hot
  - `stream_event` payloads: 30 days warm in Store 4, then dropped (not archived — raw inbound has no forensic value beyond 30d)

### Store 4 — Stream log (NATS JetStream, or compacted JSONL as a stopgap)

**Purpose.** Raw inbound from gmail/gcal/composio/omi webhooks. Sequential consume by EventProcessor. Hard 7-day TTL on individual events.

**Why NATS specifically (if we go that way).**
- Tiny single binary, single-VM-friendly, JetStream gives durable consumer offsets and per-stream TTL.
- 7-day retention is configured at the stream, not the consumer — no janitor needed.
- Unprocessed-at-7d means a worker is stuck, which fires a Temporal alert. **The raw event is not the problem; the stuck consumer is.**

**The JSONL stopgap.** If we don't want to introduce NATS in Phase 4, we can keep `stream_event/` as a date-partitioned directory of JSONL bundles:

```
/vault/_raw/2026-05-18/stream_event.jsonl
```

One file per day. EventProcessor reads + marks `processed_at`. A compactor drops files older than 30 days. This is dumber than NATS but avoids the new dependency.

**Recommendation:** start with JSONL stopgap in Phase 4. Move to NATS only if the JSONL approach has actual problems.

---

## 4. The promotion contract

This is the load-bearing rule. Without it the system regresses to today's mess within a quarter.

### The rule

> A record is written to `/vault/<type>/` if and only if the principal has a reason to read or edit it directly. Otherwise it lives in Store 2.

### Enforcement

1. **At the writer.** ctrl-api exposes one canonical write surface per record type. There is no `POST /api/v1/vault/raw` or path-as-parameter. Every write call names the type, and ctrl-api computes the path. Writers in alfred-learn use these endpoints.

2. **At ctrl-api ingress.** The vault routes refuse any write to a path outside the canonical set of human-facing types (Store 1's 12 types). Attempting to write `/vault/event/signal-action-foo.md` returns 400 with a message pointing to the audit API.

3. **At the schema.** ctrl-api's `KNOWN_TYPES` constant is the canonical list. Anything not in it cannot be written through ctrl-api. Existing code paths in alfred-learn that bypass ctrl-api (direct filesystem writes) are migrated to ctrl-api calls in Phase 2.

4. **In CLAUDE.md.** Both the root CLAUDE.md and `packages/learn/CLAUDE.md` document the promotion contract. Future contributors (human or LLM) reading those files see: "if you find yourself wanting to write a new vault record type, ask first whether the principal needs to read it. If not, add an audit row instead."

### The decision flowchart for new persistence

When a workflow or activity wants to persist a new fact, the writer asks:

```
Does the principal read this directly?
├── yes → vault (write a .md, pick from existing 12 types or propose new)
└── no → does the principal read a derived view of it?
         ├── yes (UI surface queries this) → SQLite table
         └── no, machine-internal only      → SQLite table (audit or new)
```

A new vault record type requires a CONTRACT.md change and CODEOWNERS sign-off. A new SQLite table requires a migration in `packages/ctrl/src/db/migrations/`. The asymmetry is intentional: friction goes on the side we want to discourage.

---

## 5. Data flow under this architecture

### Inbound

```
gmail puller / gcal puller / composio webhook / omi
   │
   ▼
publish to Store 4 (NATS stream / JSONL append)
   │
   ▼
EventProcessorWorkflow consumes (Temporal, every 2 min)
   │
   ├──► curate (assign source_type, normalize)
   │
   └──► SignalExtractWorkflow per event
            │
            ▼
        clerk LLM extracts decision-grade signal
            │
            ├──► INSERT INTO signal       (Store 2)
            │
            ├──► INSERT INTO observation  (Store 2)  if instinct-tagged
            │
            ├──► INSERT INTO embedding    (Store 2)  if first observation for cluster
            │
            ├──► if decision_required + match score ≥ threshold:
            │      ├── INSERT INTO audit (autonomous decision)
            │      └── write /vault/decision/<id>.md (Store 1)
            │
            └──► if decision_required + below threshold:
                   └── write /vault/needs_attention/<id>.md (Store 1)
                       ← Desk renders this for the principal

mark stream_event.processed_at = now (Store 4)
```

### Outbound (UI queries)

```
GET /desk
  SELECT id, headline, body, ts FROM signal s
    JOIN vault_index v ON v.record_id = needs_attention_for_signal(s.id)
   WHERE v.record_type = 'needs_attention'
     AND v.state = 'open'
   ORDER BY ts DESC LIMIT 50

GET /decisions
  SELECT actor, action_type, target_type, target_id, ts, reasoning
    FROM audit
   ORDER BY ts DESC LIMIT 100
  -- UNION ALL with Store 3 if pagination crosses the 90d boundary

GET /matters
  -- the hot directory is small now; can stay file-walked, or:
  SELECT path, frontmatter FROM vault_index
   WHERE record_type='matter' AND state='open'

GET /matters/:id  (with timeline)
  read /vault/matter/<id>.md          (markdown body)
  SELECT * FROM audit
   WHERE target_type='matter' AND target_id=:id
   ORDER BY ts DESC
  SELECT * FROM signal
   WHERE target_matter='matter/<id>.md' ORDER BY ts DESC LIMIT 50

GET /brief/today
  read /vault/briefing/<latest>.md     (Store 1, always small)

GET /instincts/:id  (with observation count + recent observations)
  read /vault/instinct/<id>.md
  SELECT count(*), max(ts) FROM observation WHERE instinct_id = :id
  SELECT * FROM observation WHERE instinct_id = :id
   ORDER BY ts DESC LIMIT 20

POST /api/v1/state-changes  (already implemented for SM-A)
  INSERT INTO audit (...)
  PATCH /vault/matter/<id>.md frontmatter  (state field change visible to human)
```

### Lifecycle

```
Hot (Store 1 + Store 2)
   │
   │ daily archival_sweep (Temporal, 03:00 UTC)
   │   for each table with TTL:
   │     COPY rows where ts < now - TTL TO /vault/_archive/<month>/<table>.parquet
   │     DELETE FROM <table> WHERE ts < now - TTL
   │
   ▼
Cold (Store 3)
   │
   │ never deleted; cumulative
   ▼

Store 4 (raw stream):
   │
   │ daily compaction
   │   for events with processed_at AND age > 7d:
   │     drop from hot stream / move to /vault/_raw/<date>.jsonl
   │   for events without processed_at AND age > 7d:
   │     fire alert (worker stuck)
   │
   │ monthly compaction
   │   /vault/_raw/<date>.jsonl older than 30d: delete
   ▼
   (dropped — raw payloads have no value past 30d)
```

---

## 6. Tech choices and rejected alternatives

| Choice | Picked | Rejected | Reason |
|---|---|---|---|
| OLTP store | SQLite | Postgres | Single-VM tenancy; no daemon weight; one-file backup; matches alfred's "files you can touch" ethos |
| Vector store | sqlite-vec | Qdrant, Pinecone, Weaviate | Same DB file, no separate process, no separate backup, scale is small |
| Cold store | DuckDB/Parquet | ClickHouse per-tenant | No daemon needed for per-tenant cold; ClickHouse stays at the SaaS host for fleet analytics |
| Stream log | NATS JetStream (or JSONL stopgap) | Kafka, RabbitMQ | Single-binary, single-VM-friendly, JetStream TTL native |
| Graph store | `link` table in SQLite | Neo4j, Memgraph | Sparse small graph, two btree indexes win at this scale |
| Schema migrations | hand-rolled SQL in `packages/ctrl/src/db/migrations/` | Prisma, drizzle, knex | Ctrl-api already runs raw SQL via `node:sqlite`; one fewer dependency |

### Why not Postgres specifically

- Daemon process, separate backup target, separate failure mode, separate auth.
- Connection pooling overhead, network hop even on localhost.
- We're tenant-isolated by VM. There is no multi-tenant workload to share across.
- SQLite with WAL handles >10× our peak write rate on commodity SSD.
- We already operate one SQLite DB (ctrl-api's `data/alfred-ctrl.db`). Adding `state.db` is operationally identical.
- If we ever shard across multiple Hetzner regions, SQLite-per-region is straightforward; Postgres-per-region adds replication.

### Why not "just keep everything in markdown"

- The current pain is the proof: 87k files is the natural endpoint of "everything is a file."
- `walkMd` scoping (the #437 fix) buys time, not architecture. In 90 days `signal_action/` alone hits 50k files on david.
- An index has to exist somewhere for list endpoints to be fast. Once it exists, the markdown becomes secondary storage — already half of what we're proposing.

### Why not event-sourcing the whole thing

- The `audit` table is the event log of human-visible state changes; that's enough.
- Replaying audit to reconstruct matter/task state is overkill and would re-introduce the very accumulation we're trying to escape.
- State lives in vault + SQLite as snapshots. Audit is the historical trail. Don't conflate.

---

## 7. Migration — six phases

Each phase delivers standalone value. None requires rip-and-replace. After Phase 2 the system structurally cannot regrow into today's mess.

### Phase 0 — stop the bleeding (today, ~half day)

- **Scope `walkMd`** to `path.join(VAULT_PATH, type)` when type is known (existing task #437).
- **Bulk-mv misfiled audit records** out of `event/` into typed subdirs (split by frontmatter `type:`). One-time `find ... -exec mv` on each of the 4 tenants.
- **Find and disable the ORPHAN janitor sweep** that touched 73k files at 12:38 UTC today. Either delete the workflow or quota it to ≤500 records per tick.
- **Tighten `httpx.HTTPError` logging** in `briefing.py:1491` and `list_active_matters_for_briefing` so silent timeouts surface (existing task #438).

Result: david's brief returns in <500ms; session-tracker stops looping; brief is no longer "quiet morning" fallback.

### Phase 1 — `vault_index` as read accelerator (week 1)

- Build `/var/lib/alfred/state.db` with the `vault_index` table.
- ctrl-api boot: scan `/vault/` once, populate `vault_index`.
- ctrl-api write path: every PATCH/POST/DELETE updates `vault_index` synchronously.
- Replace **every** ctrl-api list endpoint with a SQL query against `vault_index`. No more `walkMd` in hot paths.
- A boot-time reconciler verifies index matches filesystem (handles the rare case of out-of-band writes).

Architecturally invisible to alfred-learn (which still calls the same ctrl-api routes). Vault remains the durable store. ~100× speedup on list endpoints.

**Touchpoints:**
- `packages/ctrl/src/db/schema.sql` — add `vault_index` table
- `packages/ctrl/src/api/routes/vault.ts` — rewrite list/filter to SQL
- `packages/ctrl/src/api/middleware/` — write hook updates index
- `packages/ctrl/src/index.tsx` (CLI) — `alfred-ctrl reindex` command

### Phase 2 — `audit` table (week 2)

- Add `audit` table.
- New writers (steward, decision-router, desk actions, signal-router, state-mutator) write to `audit` table, not to `event/*.md`.
- Bulk-migrate the existing ~80k audit records out of `vault/event/` into the table. Then `rm /vault/event/*.md`.
- Desk page + Decisions page + audit feed in /study switch from markdown reads to `SELECT FROM audit`.

**The vault drops by ~80% on david** after this phase.

**Touchpoints:**
- `packages/ctrl/src/api/routes/audit.ts` — new file, replaces the auditFeed endpoint
- `packages/learn/src/activities/state_mutator.py` — `apply_state_change_v2` writes audit rows
- `packages/learn/src/activities/steward.py` — same
- `packages/learn/src/activities/decision_router.py` — same
- `packages/saas/app/src/dashboard/DecisionsPage.tsx` — reads new audit endpoint
- `scripts/migrate-audit-to-sql.py` — one-time migration

### Phase 3 — `signal` + `observation` + `embedding` tables (weeks 3–4)

- Add three tables.
- SignalExtractWorkflow writes to SQL instead of markdown.
- PatternDetectionWorkflow queries SQL + sqlite-vec for clustering.
- BriefingWorkflow queries SQL for "recent signals on matter X."
- /instincts page queries SQL for observation counts.
- Bulk-migrate existing 7k stream events, 335 signals, 683 observations on david. Rapali/miguel/raj313 similar order.

**Touchpoints:**
- `packages/ctrl/src/api/routes/signals.ts` — new
- `packages/learn/src/activities/signal_extract.py` — SQL writes
- `packages/learn/src/workflows/signals.py` — same
- `packages/learn/src/activities/pattern_detection.py` — SQL queries with sqlite-vec
- `packages/learn/src/activities/briefing.py:list_active_matters_for_briefing` — replaced by SQL query

### Phase 4 — stream log + raw TTL (week 5)

- Implement Store 4 as date-partitioned JSONL (stopgap; NATS optional later).
- EventProcessorWorkflow marks `processed_at` after distillation.
- Daily compactor drops processed events older than 7 days.
- Alert on unprocessed events older than 7 days.

**Touchpoints:**
- `packages/learn/src/activities/event_processor.py` — emit `processed_at`
- `packages/learn/src/workflows/maintenance.py` — new daily compaction workflow
- `packages/ctrl/src/api/routes/streams.ts` — adjust to read JSONL

### Phase 5 — cold archive (week 6)

- Add `archival_sweep` extension: roll Store 2 tables older than 90d to `/vault/_archive/<month>/<table>.parquet`.
- Audit feed UI learns to fall back to Parquet read when pagination crosses the 90d boundary.
- DuckDB attached as needed via `duckdb` CLI or python bindings.

**Touchpoints:**
- `packages/learn/src/workflows/archival.py` — extend existing archival_sweep
- `packages/ctrl/src/api/routes/audit.ts` — tier-spanning reads

### Phase 6 — vault demotion final sweep (week 7+)

- Audit the remaining vault directory list. For every type that has zero principal-facing reason, move its data into a new SQLite table or drop entirely.
- Update CLAUDE.md to lock the 12-type vault.
- Update CONTRACT.md per package to document the promotion contract.
- ctrl-api enforces canonical-path-only writes; rejects unknown types.

---

## 8. Trade-offs and risks

### What gets harder

- **`cat /vault/audit/x.md` stops working** for new audits because there's no such file. We add a small CLI: `alfred-ctrl audit show <id>`, and the Decisions UI is already the primary read surface. The principal does not read raw audits today.
- **Two backup objects instead of one.** Restic snapshots `/vault` and `/var/lib/alfred/state.db`. Trivial config change.
- **Schema migrations are now a thing we have.** Hand-rolled SQL in `packages/ctrl/src/db/migrations/`, applied on ctrl-api boot. Small operational addition.
- **The wikilink graph is computed eagerly on write,** not lazily on read. Writers update `link` table when frontmatter changes. Mostly invisible — already most writes go through ctrl-api.

### What we lose

- **The "everything is grep-able markdown" purity.** This is the trade. The principal's stuff (~5k files) stays grep-able. The machine's stuff (~80k audit rows) becomes SQL-queryable, which is better for the things people actually want to do with audit data.
- **A small amount of LLM ergonomics.** Today an LLM agent reading "the system state" can `ls /vault/event/` and skim. Under this model the audit log is `sqlite3 state.db "SELECT ..."`. Still scriptable, but a different tool.

### Risks

| Risk | Mitigation |
|---|---|
| `vault_index` drifts from filesystem (out-of-band writes by, e.g., Obsidian sync) | Boot-time reconciler walks vault once and reconciles; optional `fanotify` watcher in v2 |
| Migration script bug loses audit history | Migration is COPY-then-VERIFY-then-DELETE, never destructive in one step. Backups taken before each phase. |
| SQLite write contention under burst | WAL mode + single writer per process; existing ctrl-api ingress already serializes writes |
| Compaction job blows up the DB | Compaction runs at 03:00 UTC with per-tick row budget; archival is INSERT-then-DELETE in a transaction |
| New SQLite extension (sqlite-vec) breaks at upgrade | sqlite-vec is bundled-into-binary; pinned version in Dockerfile |
| Audit table grows faster than expected | Lower the TTL from 90d to 30d hot; everything else still works |
| Restic backup grows | state.db compresses well; cold archive Parquet already compressed; net storage drops vs today's 87k files |

### Things we're explicitly NOT doing

- Not introducing Postgres.
- Not introducing Kafka/RabbitMQ.
- Not introducing Neo4j or any graph database.
- Not introducing per-tenant ClickHouse.
- Not collapsing multiple tenants into one DB — each tenant remains single-VM.
- Not building a generic plugin/extension system. The 12-type vault is closed-set by design.
- Not migrating to JSON-based markdown (frontmatter stays YAML; nothing changes in the principal's view).
- Not rebuilding the SaaS plane. This proposal is entirely about the tenant data plane.

---

## 9. Open questions

These are things I'm not certain about and want pushback on:

1. **Are `decision/` records actually principal-facing?** Today they're written as markdown; the Desk has a "decisions" feed. If the principal browses them as files, they stay in vault. If they only read them through the UI, they should be a SQL table. **Asking:** do you ever open `vault/decision/<x>.md` directly?

2. **Should `briefing/` stay in vault?** It's a markdown artifact the principal reads. Yes — leave it. But the *index* of briefings (for the /briefings list page) should be in SQL.

3. **`person/` and `org/` — do we need a queryable surface?** Today they're hand-edited reference data. They probably should stay as markdown files (principal might add a person via Obsidian), but a derived SQL table indexing their frontmatter would make "find person by email" fast. **Probably:** stay markdown, but appear in `vault_index`.

4. **`note/`** is 1,306 records and growing. It's the principal's actual writing. Definitely vault. But do we want a SQL full-text search index over note bodies? FTS5 in SQLite would handle this without much effort. **Recommend:** yes, FTS5 over notes in `vault_index`.

5. **Per-tenant or fleet-wide SQLite?** Each tenant has its own `state.db`. The SaaS host already has a separate plane with its own DB (Wasp/Prisma → Postgres). No change there.

6. **Migration timing.** The proposal estimates 6 phases over ~6 weeks. Is that pace right, or should Phase 1 + Phase 2 ship together for a faster recovery from today's pain? **Recommend:** Phase 0 today, Phase 1 + 2 together in week 1–2, then pause and let david/rapali run for a week before Phase 3.

7. **Does the principal want to be informed when the audit history is going cold?** Or does it just happen silently? I'd say silent unless a query spans the boundary; then a small UI note.

---

## 10. Acceptance criteria

This proposal is "accepted" when:

- [ ] You sign off on the four-store model and the promotion contract.
- [ ] You sign off on SQLite as the OLTP store and sqlite-vec for embeddings.
- [ ] We agree on the phase ordering (or revise it).
- [ ] We agree on what stays in vault (the 12-type list) and what doesn't.
- [ ] The open questions in §9 are resolved or explicitly deferred.

At that point this document is committed to the repo and tasks are broken out per phase in `/issues` or the task list. Until then, this is just a document.

---

## 11. References

- The CLAUDE.md vocabulary section — defines the principal-facing surface
- packages/learn/docs/SPEC.md — current alfred-learn architecture
- packages/learn/CLAUDE.md — Temporal replay constraints (relevant to migration safety)
- packages/ctrl/CLAUDE.md — current ctrl-api role and existing SQLite use
- TOPOLOGY.md — service connection map (will need an update post-acceptance)
- The today incident (2026-05-18 ~12:38–13:10 UTC) — david brief degraded, janitor sweep on event/, ~83k audit records uncovered
- Existing related tasks: #437 (walkMd scope), #438 (httpx logging), #439–440 (zombie investigation), #442 (audit dir routing), #443 (archival policy), #444 (janitor throttling) — most of these become subsumed or refined by this proposal
