-- 002_vault_index.sql
--
-- Phase 1 of the Storage Architecture migration (epic #898).
-- Adds the SQLite read accelerator that replaces every hot-path
-- recursive walk under /mnt/encrypted/vault.
--
-- Layout follows STORAGE-ARCHITECTURE.md §5: one row per vault record,
-- keyed by record_id, with the canonical relative path indexed for
-- replay and the three secondary indexes that back the common
-- list-by-type / open-state / parent-matter query shapes.

CREATE TABLE IF NOT EXISTS vault_index (
  record_id     TEXT PRIMARY KEY,
  record_type   TEXT NOT NULL,
  path          TEXT NOT NULL,           -- relative to vault root, e.g. 'matter/foo.md'
  mtime_ns      INTEGER NOT NULL,
  state         TEXT,                    -- 'open' / 'closed' / 'archived' / null
  parent_matter TEXT,                    -- frontmatter parent_matter, if any
  frontmatter   TEXT NOT NULL,           -- raw JSON-encoded frontmatter
  body_first_n  TEXT,                    -- first ~500 chars for search (nullable)
  UNIQUE(path)
);

CREATE INDEX IF NOT EXISTS vi_type_state    ON vault_index(record_type, state);
CREATE INDEX IF NOT EXISTS vi_type_mtime    ON vault_index(record_type, mtime_ns DESC);
CREATE INDEX IF NOT EXISTS vi_parent_matter ON vault_index(parent_matter);
