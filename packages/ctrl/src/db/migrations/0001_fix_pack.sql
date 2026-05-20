-- 0001_fix_pack — Part-1 storage-cutover columns.
--
-- observation.processed_at: stamped when Reflection has consumed an observation
-- so it is not re-fed to Opus nightly. Fixes FAILURE-MODES bug #2
-- (mark_observations_processed wrote to the vault, never state.db) and underpins
-- the observation-count / progressive-autonomy fix (bug #1, FIX-CONTRACTS C1).
--
-- schema.sql is CREATE-IF-NOT-EXISTS only and cannot evolve an existing table,
-- so this column can ONLY be added through the migration runner.
ALTER TABLE observation ADD COLUMN processed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_observation_processed ON observation(processed_at);
