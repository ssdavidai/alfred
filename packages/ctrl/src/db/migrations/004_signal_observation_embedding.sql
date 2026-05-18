-- 004_signal_observation_embedding.sql
--
-- Phase 3 of the Storage Architecture migration (epic #898).
-- Adds the three Phase 3 tables:
--   - signal      — unified signal stream (replaces /vault/signal/*.md)
--   - observation — instinct-graph observation rows
--   - embedding   — sqlite-vec virtual table (FLOAT[768])
--
-- Per STORAGE-ARCHITECTURE.md §5.
--
-- STORE-P3-1 already wired sqlite-vec into state.ts via
-- enableLoadExtension + loadExtension (with a warn-only fallback in dev
-- when the .so is missing). The CREATE VIRTUAL TABLE below will only
-- succeed when sqlite-vec is actually loaded — if it is not (laptop
-- dev box without the .so), this migration will throw and the
-- transaction will rollback. That is intentional: on the tenant
-- runtime the .so is always staged by the alfred-init container, so a
-- failure here is a real environment problem worth surfacing.
--
-- Subsequent issues (P3-3 alfred-learn writers, P3-4 bulk migration,
-- P3-5 alfred-learn readers, P3-6 SaaS readers) build on this.

CREATE TABLE IF NOT EXISTS signal (
  id                 TEXT PRIMARY KEY,
  ts                 INTEGER NOT NULL,            -- unix ns
  source_type        TEXT NOT NULL,               -- gmail | gcal | composio | omi | manual | ...
  source_event       TEXT,                        -- raw event id (Store 4 ref)
  target_matter      TEXT,                        -- vault path or null
  target_kind        TEXT,                        -- 'matter' | 'person' | 'org' | ...
  actor              TEXT,                        -- principal | alfred | <person>
  decision_required  INTEGER NOT NULL DEFAULT 0,
  display_headline   TEXT,
  display_body       TEXT,
  body               TEXT NOT NULL,
  processed_at       INTEGER,                     -- when downstream consumed; null = pending
  classified_noise   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS sig_ts            ON signal(ts DESC);
CREATE INDEX IF NOT EXISTS sig_target_matter ON signal(target_matter, ts DESC);
CREATE INDEX IF NOT EXISTS sig_source_type   ON signal(source_type, ts DESC);
CREATE INDEX IF NOT EXISTS sig_unprocessed   ON signal(processed_at) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS observation (
  id           TEXT PRIMARY KEY,
  ts           INTEGER NOT NULL,
  signal_id    TEXT,                              -- FK to signal(id), may be null for pre-signal observations
  instinct_id  TEXT NOT NULL,                     -- vault path 'instinct/foo.md'
  confidence   REAL,
  embedding_id INTEGER                            -- FK into embedding rowid
);

CREATE INDEX IF NOT EXISTS obs_instinct_ts ON observation(instinct_id, ts DESC);
CREATE INDEX IF NOT EXISTS obs_signal      ON observation(signal_id);

-- sqlite-vec virtual table. Requires the sqlite-vec extension to be
-- loaded on this connection — state.ts handles that on open.
CREATE VIRTUAL TABLE IF NOT EXISTS embedding USING vec0(
  rowid INTEGER PRIMARY KEY,
  record_id TEXT,
  record_type TEXT,
  vec FLOAT[768]
);
