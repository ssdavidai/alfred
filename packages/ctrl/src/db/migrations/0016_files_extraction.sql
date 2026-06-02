-- 0016_files_extraction — issue #114 Lane B (extraction pipeline).
--
-- PR 1 (#125) shipped the `files` metadata table. PR 5 (#148) added
-- dedupe + the cold-archive tier. What is missing for the §14 cold-
-- start UX is the "Alfred read it" half: after every upload, alfred-
-- learn extracts the file's text by mime, summarises it with the
-- workers gateway, and stamps the row so the dashboard's /files page
-- can render an "Alfred read it" badge.
--
-- This migration adds the three columns that the FileExtractionWorkflow
-- writes back via `PATCH /api/v1/files/:id/extraction`:
--
--   * `alfred_read_at`     — unix milliseconds; null until extraction
--                            finishes. Drives the badge.
--   * `summary`            — short principal-readable paragraph; what
--                            Alfred would say when asked "what's in this
--                            file?". Null on failure or while pending.
--   * `extraction_error`   — short reason code when extraction failed
--                            (`unsupported_mime`, `extractor_failed`,
--                            `summariser_failed`, ...). Null on success.
--
-- The three columns are nullable so existing rows (pre-extraction) keep
-- a stable shape: `alfred_read_at IS NULL` ⇒ "Alfred hasn't read it yet",
-- `summary IS NOT NULL` ⇒ "show the badge + summary tooltip",
-- `extraction_error IS NOT NULL` ⇒ "show the subtle error state".
--
-- Why on `files`, not `file_blobs`. Extraction is per-row (the principal
-- uploaded THIS file with THIS original filename; the summary may
-- reference the title). Two dedupe-shared `files.id` rows pointing at
-- the same `file_blobs` row can carry distinct summaries if the
-- principal renamed one. Keeping the columns on `files` matches the
-- per-upload principal-facing semantics.

ALTER TABLE files ADD COLUMN alfred_read_at    INTEGER;
ALTER TABLE files ADD COLUMN summary           TEXT;
ALTER TABLE files ADD COLUMN extraction_error  TEXT;

-- The /files list query filters on `deleted_at IS NULL`; the dashboard
-- also wants the count of "Alfred read it" rows for the empty-state
-- copy. A partial index on `alfred_read_at` over live rows keeps that
-- aggregate cheap without bloating writes against the tombstone path.
CREATE INDEX IF NOT EXISTS idx_files_alfred_read_at
  ON files(alfred_read_at)
  WHERE deleted_at IS NULL;
