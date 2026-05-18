-- ============================================================================
-- state.db — Store 2 of the alfred-black four-store architecture.
--
-- This is the machine's working memory: ctrl-api's own SQLite file
-- (node:sqlite, single-writer). See packages/ctrl/docs/STORAGE-ARCHITECTURE.md
-- and PLAN.md Part I.
--
-- The four stores:
--   Store 1  Vault (markdown)        — the principal's published knowledge.
--   Store 2  state.db (THIS FILE)    — working memory: signals, observations,
--                                      routing decisions, audit, links, the
--                                      vault read-index, and embeddings.
--   Store 3  Cold archive (DuckDB)   — deferred; TTL `ts` columns + archive
--                                      table names are reserved below.
--   Store 4  ingest.db               — raw inbound stream events (separate
--                                      file, see ingest-schema.sql).
--
-- SINGLE-WRITER DISCIPLINE: ctrl-api is the ONLY process that opens this file
-- with a write handle. alfred-learn and the alfred vault daemon write through
-- ctrl-api HTTP endpoints. Other services may open it read-only.
--
-- PRAGMAs (journal_mode, busy_timeout, foreign_keys) are applied by
-- src/db/state.ts at open time — they cannot live in a CREATE-only schema
-- file that is exec()'d idempotently.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- signal — demoted from the vault's `signal/` directory (Part I).
--
-- A signal is a unit of inbound salience the system extracted from a stream
-- event: "an email from X mentions deadline Y". Signals are machine working
-- memory, not principal-facing — they live here, never as markdown.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signal (
  id              TEXT PRIMARY KEY,            -- ulid
  ts              TEXT NOT NULL,               -- ISO8601 — creation time (TTL anchor)
  kind            TEXT NOT NULL,               -- deadline | mention | request | anomaly | …
  source          TEXT NOT NULL,               -- dotted source id, e.g. signal_extract.email
  stream_event_id TEXT,                        -- by-value ref into ingest.db.stream_event
  entity_ref      TEXT,                        -- vault path of the related record, if any
  matter_ref      TEXT,                        -- vault path of the related matter, if any
  headline        TEXT NOT NULL,
  body            TEXT,                        -- extracted detail / context
  salience        REAL NOT NULL DEFAULT 0.5,   -- [0,1]
  status          TEXT NOT NULL DEFAULT 'open',-- open | routed | dismissed | folded
  payload_json    TEXT,                        -- full structured payload
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signal_ts        ON signal(ts DESC);
CREATE INDEX IF NOT EXISTS idx_signal_status_ts ON signal(status, ts DESC);
CREATE INDEX IF NOT EXISTS idx_signal_matter    ON signal(matter_ref, ts DESC);
CREATE INDEX IF NOT EXISTS idx_signal_kind      ON signal(kind, ts DESC);

-- ----------------------------------------------------------------------------
-- observation — demoted from `signal/`-adjacent vault types (Part I).
--
-- An observation is what the intuition engine learns by watching the
-- principal act: "principal always delegates X to agent Y". Feeds the
-- instinct/pattern layer. Working memory — never markdown.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observation (
  id            TEXT PRIMARY KEY,            -- ulid
  ts            TEXT NOT NULL,               -- ISO8601 (TTL anchor)
  subject       TEXT NOT NULL,               -- principal | principal_via_alfred | alfred
  kind          TEXT NOT NULL,               -- pattern_proposal | synthesis | contradiction
                                             --   | assumption | constraint | preference
  decision_ref  TEXT,                        -- vault path of the decision/ record observed
  instinct_ref  TEXT,                        -- vault path of a matched instinct, if any
  summary       TEXT NOT NULL,
  detail        TEXT,
  confidence    REAL NOT NULL DEFAULT 0.5,   -- [0,1]
  status        TEXT NOT NULL DEFAULT 'open',-- open | promoted | retired
  payload_json  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_observation_ts      ON observation(ts DESC);
CREATE INDEX IF NOT EXISTS idx_observation_kind_ts ON observation(kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_observation_subject ON observation(subject, ts DESC);
CREATE INDEX IF NOT EXISTS idx_observation_status  ON observation(status, ts DESC);

-- ----------------------------------------------------------------------------
-- routing_decision — the insight layer's `decision` (Part I).
--
-- Named `routing_decision` (NOT `decision`) to avoid colliding with the
-- vault's principal-facing `decision/` record type. This is the machine's
-- record of how a signal was routed: ask / confirm / act, to which agent,
-- under which instinct.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routing_decision (
  id            TEXT PRIMARY KEY,            -- ulid
  ts            TEXT NOT NULL,               -- ISO8601 (TTL anchor)
  signal_id     TEXT REFERENCES signal(id) ON DELETE SET NULL,
  tier          TEXT NOT NULL,               -- ask | confirm | act
  chosen_path   TEXT NOT NULL,               -- agent | desk | dismiss | hold
  agent         TEXT,                        -- target agent id when chosen_path=agent
  instinct_ref  TEXT,                        -- vault path of the matched instinct
  discretion    REAL,                        -- discretion score that gated the choice
  reason        TEXT,
  outcome       TEXT,                        -- pending | dispatched | completed | failed
  payload_json  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_routing_decision_ts     ON routing_decision(ts DESC);
CREATE INDEX IF NOT EXISTS idx_routing_decision_signal ON routing_decision(signal_id);
CREATE INDEX IF NOT EXISTS idx_routing_decision_tier   ON routing_decision(tier, ts DESC);

-- ----------------------------------------------------------------------------
-- audit — demoted from the vault's `event/*-action-*.md` records (Part I).
--
-- Every signal-action / steward-action / desk-action / state-change /
-- needs_attention_action becomes a row here, not a markdown file. This is the
-- machine-verifiable audit ledger; the Desk audit feed and the /decisions,
-- /state-changes, /attention list routes serve from it.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit (
  id            TEXT PRIMARY KEY,            -- ulid
  ts            TEXT NOT NULL,               -- ISO8601 — when the action happened (TTL anchor)
  action_type   TEXT NOT NULL,               -- signal_action | steward_action | desk_action
                                             --   | state_change | needs_attention_action
                                             --   | decision | vault_write
  actor         TEXT NOT NULL,               -- principal | alfred | <agent-id> | <source>
  source        TEXT,                        -- dotted source id
  target_path   TEXT,                        -- vault path the action touched, if any
  target_kind   TEXT,                        -- matter | task | needs_attention | decision | …
  subject_ref   TEXT,                        -- related vault path (decision, signal, …)
  summary       TEXT NOT NULL,
  changes_json  TEXT,                        -- structured before/after diff
  mode          TEXT NOT NULL DEFAULT 'live',-- live | shadow
  confidence    REAL,
  undo_json     TEXT,                        -- undo recipe, if reversible
  payload_json  TEXT,                        -- full structured payload
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_ts        ON audit(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_type_ts   ON audit(action_type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor_ts  ON audit(actor, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target    ON audit(target_path, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_source_ts ON audit(source, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_subject   ON audit(subject_ref, ts DESC);

-- ----------------------------------------------------------------------------
-- link — the cross-record graph edge.
--
-- An explicit, queryable edge between two records. Either endpoint may be a
-- vault path (`matter/x.md`) or a state.db row id (`signal:01J…`). Replaces
-- the implicit graph that lived in scattered frontmatter `*_ref` fields.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS link (
  id            TEXT PRIMARY KEY,            -- ulid
  ts            TEXT NOT NULL,               -- ISO8601 (TTL anchor)
  src_ref       TEXT NOT NULL,               -- "matter/x.md" or "signal:<id>" etc.
  dst_ref       TEXT NOT NULL,
  rel           TEXT NOT NULL,               -- mentions | derived_from | resolves
                                             --   | blocks | child_of | observed_in | …
  weight        REAL NOT NULL DEFAULT 1.0,
  payload_json  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_link_unique ON link(src_ref, dst_ref, rel);
CREATE INDEX IF NOT EXISTS idx_link_src           ON link(src_ref);
CREATE INDEX IF NOT EXISTS idx_link_dst           ON link(dst_ref);
CREATE INDEX IF NOT EXISTS idx_link_rel           ON link(rel);

-- ----------------------------------------------------------------------------
-- vault_index — the read-index over Store 1 (the markdown vault).
--
-- One row per canonical vault record. ctrl-api is the sole vault writer, so
-- it updates this index on every write (create/edit/move/delete) — that makes
-- index drift structurally impossible (no fanotify/reconciler race). A
-- boot-time reconciler still walks the vault once to catch out-of-band edits
-- (a human editing markdown directly in Obsidian).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault_index (
  path             TEXT PRIMARY KEY,         -- vault-relative path, e.g. "matter/acme.md"
  record_type      TEXT NOT NULL,            -- one of the 12 canonical types
  title            TEXT,
  status           TEXT,                     -- frontmatter.status, if present
  as_of            TEXT,                     -- frontmatter.as_of, if present
  frontmatter_json TEXT,                     -- parsed frontmatter snapshot
  body_preview     TEXT,                     -- first ~500 chars of the body
  size_bytes       INTEGER,
  mtime            TEXT,                     -- file mtime (ISO8601)
  indexed_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vault_index_type   ON vault_index(record_type, mtime DESC);
CREATE INDEX IF NOT EXISTS idx_vault_index_status ON vault_index(record_type, status);
CREATE INDEX IF NOT EXISTS idx_vault_index_mtime  ON vault_index(mtime DESC);

-- ----------------------------------------------------------------------------
-- embedding_meta — companion to the sqlite-vec `embedding` virtual table.
--
-- Resolves the QMD memory-parity gap (PLAN.md risk 4): Hermes drops QMD, so
-- vault semantic recall becomes an MCP search tool → ctrl-api → a k-NN query
-- against the `embedding` vec0 table. The embedder is alfred-learn's surveyor
-- (Ollama `nomic-embed-text`, 768-dim).
--
-- vec0 virtual tables only hold the vector + a rowid; `embedding_meta` carries
-- the human-readable columns keyed by that same rowid. The vec0 table itself
-- is created at boot by src/db/state.ts AFTER the sqlite-vec extension loads —
-- a plain `.sql` exec cannot create a virtual table for an extension that is
-- not yet loaded. The vec0 DDL (kept in sync with state.ts):
--
--   CREATE VIRTUAL TABLE IF NOT EXISTS embedding USING vec0(
--     embedding float[768]
--   );
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS embedding_meta (
  rowid        INTEGER PRIMARY KEY,          -- shared rowid with the vec0 `embedding` table
  ref          TEXT NOT NULL,                -- vault path or "signal:<id>" the vector embeds
  ref_kind     TEXT NOT NULL,                -- vault | signal | observation
  ts           TEXT NOT NULL,                -- ISO8601 (TTL anchor)
  model        TEXT NOT NULL DEFAULT 'nomic-embed-text',
  chunk_index  INTEGER NOT NULL DEFAULT 0,   -- for records split into chunks
  text_preview TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_embedding_meta_ref  ON embedding_meta(ref);
CREATE INDEX IF NOT EXISTS idx_embedding_meta_kind ON embedding_meta(ref_kind, ts DESC);

-- ----------------------------------------------------------------------------
-- health_checks / events — KEPT from the original ctrl schema.
--
-- alfred-black is single-VM, so the `instances` provisioning table is gone.
-- These two are repurposed as single-VM equivalents: a fixed
-- `instance_id = 0` sentinel stands in for "this VM".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS health_checks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id    INTEGER NOT NULL DEFAULT 0, -- always 0 on single-VM alfred-black
  checked_at     TEXT NOT NULL DEFAULT (datetime('now')),
  status         TEXT NOT NULL,
  disk_percent   REAL,
  memory_percent REAL,
  response_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_health_checks_checked ON health_checks(checked_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id  INTEGER NOT NULL DEFAULT 0,   -- always 0 on single-VM alfred-black
  event_type   TEXT NOT NULL,
  message      TEXT NOT NULL,
  details_json TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(event_type, created_at DESC);

-- ============================================================================
-- Store 3 reservations — cold archive (DuckDB/Parquet).
--
-- Store 3 itself is DEFERRED (PLAN.md Part I: greenfield has no 90d+ cold
-- data). When the compactor lands it will roll rows older than the TTL out of
-- the hot tables above into Parquet bundles. The hot tables already carry a
-- `ts` column for exactly this. The archive table NAMES are reserved here so
-- the future compactor and the cross-tier audit reader agree on a contract:
--
--   archive_signal            ← signal            (TTL ~90d)
--   archive_observation       ← observation       (TTL ~90d)
--   archive_routing_decision  ← routing_decision  (TTL ~90d)
--   archive_audit             ← audit             (TTL ~365d — forensic long tail)
--   archive_link              ← link              (TTL ~365d)
--
-- ingest.db.stream_event has its own hard 7d TTL (see ingest-schema.sql) and
-- is never archived — it is consumed then deleted.
--
-- No archive tables are created now: Store 3 is a later phase.
-- ============================================================================
