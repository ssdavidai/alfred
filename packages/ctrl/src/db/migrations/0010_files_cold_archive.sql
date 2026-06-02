-- 0010_files_cold_archive — issue #114 PR 5.
--
-- Two storage-efficiency upgrades sit on top of the PR 1 `files` table:
--
-- 1. **Dedupe at upload.** A new `file_blobs` table is added, one row
--    per UNIQUE sha256. `files.id` rows then point at a physical blob
--    indirectly via their sha256, so two uploads of the same content
--    cost one set of bytes on disk. `file_blobs.ref_count` tracks how
--    many live `files` rows share the underlying blob; the on-disk
--    bytes are only unlinked when the count drops to zero.
--
-- 2. **Cold archive.** Files unaccessed for 90+ days are read off the
--    `files_data` live volume, zstd-compressed at level 19, and
--    written to the separate `files_cold_data` volume. The blob path
--    flips from `<ULID>/<safe-name>` (live) to `cold:<ULID>` (the
--    `cold:` prefix is the on-the-wire signal that ctrl-api's blob
--    GET must transparently decompress on the way out). A new
--    `cold_promoted_at` column on both `files` and `file_blobs`
--    records when the move happened so /usage can break live vs cold.
--
-- Schema changes
-- --------------
-- PR 1's `files` table declared `path TEXT NOT NULL UNIQUE`. Dedupe
-- requires two `files.id` rows to point at the SAME on-disk path
-- (one shared blob), which violates that UNIQUE. We rebuild the
-- `files` table without the UNIQUE constraint (SQLite has no ALTER
-- TABLE … DROP CONSTRAINT, so the rename-create-copy-drop dance is
-- the only path). Indexes are recreated identically afterwards.
--
-- Migration semantics
-- -------------------
-- Atomic backfill: every live row that already lives in `files`
-- becomes one `file_blobs` row with `ref_count=N` (the count of
-- live `files` rows sharing that sha256) and `cold_promoted_at=NULL`.
-- Live `files` rows then have their `path` rewritten to the
-- file_blobs canonical path so two pre-existing duplicates share
-- the on-disk blob going forward. Soft-deleted rows keep their
-- original path (tombstones, not lookups). On-disk cleanup of any
-- now-orphaned duplicate blobs (rows that pre-existed PR 5 with
-- the same sha256 but distinct paths) is left to a one-off operator
-- command rather than running inside this transaction — deleting
-- bytes inside a SQL migration is a footgun.

-- ── 1. add the two new files columns ─────────────────────────────────
ALTER TABLE files ADD COLUMN cold_promoted_at INTEGER;
ALTER TABLE files ADD COLUMN ref_count INTEGER NOT NULL DEFAULT 1;

-- ── 2. file_blobs table ─────────────────────────────────────────────────
-- One row per unique sha256. The `path` is the on-disk location for
-- live blobs (`<ULID>/<safe-name>`) or the cold-storage filename for
-- promoted blobs (`cold:<ULID>`). `ref_count` is the count of live
-- (deleted_at IS NULL) `files` rows that share this sha256.
CREATE TABLE IF NOT EXISTS file_blobs (
  sha256            TEXT PRIMARY KEY,
  path              TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  ref_count         INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  cold_promoted_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_file_blobs_cold_promoted_at
  ON file_blobs(cold_promoted_at);

-- ── 3. backfill file_blobs from existing files rows ─────────────────────
-- For each unique sha256, pick the first (by uploaded_at) live row's
-- path as the canonical location. Compute ref_count as the count of
-- live rows sharing that sha256. Soft-deleted rows do NOT count
-- toward ref_count (matching the dedupe semantics in the upload
-- route). If a sha256 exists ONLY on soft-deleted rows we skip it —
-- the bytes can be reaped later, but the dedupe surface should not
-- accidentally resurrect tombstoned content.
INSERT OR IGNORE INTO file_blobs (sha256, path, size_bytes, ref_count, created_at, cold_promoted_at)
SELECT
  f.sha256,
  (SELECT f2.path FROM files f2
     WHERE f2.sha256 = f.sha256 AND f2.deleted_at IS NULL
     ORDER BY f2.uploaded_at ASC LIMIT 1) AS path,
  f.size_bytes,
  (SELECT COUNT(*) FROM files f3
     WHERE f3.sha256 = f.sha256 AND f3.deleted_at IS NULL) AS ref_count,
  (SELECT MIN(f4.uploaded_at) FROM files f4
     WHERE f4.sha256 = f.sha256) AS created_at,
  NULL
FROM files f
WHERE f.deleted_at IS NULL
GROUP BY f.sha256;

-- ── 4. rebuild `files` without the UNIQUE constraint on `path` ─────────
-- The PR 1 schema had `path TEXT NOT NULL UNIQUE`. Dedupe needs two
-- `files.id` rows to share a `path`. SQLite has no ALTER TABLE DROP
-- CONSTRAINT, so we do the canonical rename-create-copy-drop dance.
-- All other columns + their semantics are identical.
ALTER TABLE files RENAME TO files_old_0009;

CREATE TABLE files (
  id                 TEXT PRIMARY KEY,
  path               TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  sha256             TEXT NOT NULL,
  content_type       TEXT,
  original_filename  TEXT,
  principal_label    TEXT,
  uploaded_by        TEXT NOT NULL,
  uploaded_at        INTEGER NOT NULL,
  last_accessed_at   INTEGER,
  deleted_at         INTEGER,
  cold_promoted_at   INTEGER,
  ref_count          INTEGER NOT NULL DEFAULT 1
);

-- Copy live rows, rewriting `path` to the file_blobs canonical path
-- (so post-migration two formerly-distinct dupes share one path
-- going forward). Soft-deleted rows keep their original path.
INSERT INTO files
  (id, path, size_bytes, sha256, content_type, original_filename,
   principal_label, uploaded_by, uploaded_at, last_accessed_at,
   deleted_at, cold_promoted_at, ref_count)
SELECT
  f.id,
  CASE
    WHEN f.deleted_at IS NULL THEN COALESCE(
      (SELECT b.path FROM file_blobs b WHERE b.sha256 = f.sha256),
      f.path
    )
    ELSE f.path
  END,
  f.size_bytes,
  f.sha256,
  f.content_type,
  f.original_filename,
  f.principal_label,
  f.uploaded_by,
  f.uploaded_at,
  f.last_accessed_at,
  f.deleted_at,
  f.cold_promoted_at,
  f.ref_count
FROM files_old_0009 f;

DROP TABLE files_old_0009;

-- Recreate the PR 1 indexes against the rebuilt table.
CREATE INDEX IF NOT EXISTS idx_files_path
  ON files(path)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_files_sha256
  ON files(sha256);

CREATE INDEX IF NOT EXISTS idx_files_uploaded_at
  ON files(uploaded_at DESC);

-- ── 5. files.last_accessed_at index for the cold-archive sweep ─────────
-- The daily FilesColdArchiveWorkflow scans `files` for rows whose
-- `last_accessed_at < now - 90d AND cold_promoted_at IS NULL AND
-- deleted_at IS NULL`. Partial index keeps the lookup tight (cold +
-- deleted rows never enter the candidate set so they don't need to
-- be in the index).
CREATE INDEX IF NOT EXISTS idx_files_last_accessed
  ON files(last_accessed_at)
  WHERE deleted_at IS NULL AND cold_promoted_at IS NULL;
