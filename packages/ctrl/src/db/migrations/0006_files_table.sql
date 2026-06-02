-- 0003_files_table — the metadata index for Store 5 (files).
--
-- This is PR 1 of issue #114: a tenant-local place to drop arbitrary
-- binary files (PDFs, images, spreadsheets, code archives, audio,
-- video) that Alfred can later read, summarise, and search. The full
-- spec is at docs/specs/issue-114-local-file-storage.md; this migration
-- ships the minimum PR 1 shape:
--
--   * one row per file, keyed by ULID
--   * unique blob path under `/files/<ULID>/<safe-original-name>`
--   * principal-friendly label + original filename
--   * uploader identity, upload timestamp, soft-delete tombstone
--   * sha256 for integrity + future de-dupe
--
-- PR 2 / PR 3 / PR 4 (MCP tools, dashboard page, content extraction)
-- intentionally do not land here — see the spec §6 for sequencing.
--
-- The metadata lives in Store 2 (alfred-state.db). The blob lives on
-- the `files_data` named Docker volume, mounted into ctrl-api `:rw`
-- at `/files` and into hermes + alfred ro at `/files` (see
-- docker-compose.yaml). ctrl-api is the SOLE writer of both layers,
-- matching the single-writer discipline the other state.db tables
-- already follow.

CREATE TABLE IF NOT EXISTS files (
  id                 TEXT PRIMARY KEY,             -- ULID (Crockford-base32, 26 chars)
  path               TEXT NOT NULL UNIQUE,         -- relative under /files/, e.g. "01H…/contract.pdf"
  size_bytes         INTEGER NOT NULL,
  sha256             TEXT NOT NULL,                -- hex content hash
  content_type       TEXT,                         -- MIME, best-effort
  original_filename  TEXT,                         -- as received from the uploader
  principal_label    TEXT,                         -- principal-friendly display label
  uploaded_by        TEXT NOT NULL,                -- 'principal' | 'alfred' | 'chore:<slug>' | …
  uploaded_at        INTEGER NOT NULL,             -- unix milliseconds
  last_accessed_at   INTEGER,                      -- unix milliseconds; null until first read
  deleted_at         INTEGER                       -- unix milliseconds; null = live
);

-- Live-row path uniqueness lookup. The `WHERE deleted_at IS NULL`
-- filter means a soft-deleted row is invisible to the hot list path,
-- while the column-level UNIQUE keeps the absolute (id, path) tuple
-- unique forever — preserving audit-trail integrity if we ever undelete.
CREATE INDEX IF NOT EXISTS idx_files_path
  ON files(path)
  WHERE deleted_at IS NULL;

-- Hash index for future PR-4 de-dupe + integrity checks.
CREATE INDEX IF NOT EXISTS idx_files_sha256
  ON files(sha256);

-- Chronological list path (the dashboard / MCP `files__list` will
-- ORDER BY uploaded_at DESC).
CREATE INDEX IF NOT EXISTS idx_files_uploaded_at
  ON files(uploaded_at DESC);
