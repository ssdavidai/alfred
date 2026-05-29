-- 0012_ha_integration_ref_removed_at — Tier 4 PR4 follow-up to migration 0011.
--
-- The PR1 migration 0011 added `ha_integration_ref` (entry_id, installed_by,
-- decision_ref, installed_at). The PR4 spec called for a soft-delete marker so
-- the Desk can render "the 3 integrations Alfred installed this week" without
-- losing the row when Alfred (or the principal) removes the entry.
--
-- The PR4 spec text reads:
--
--     On `remove`, mark the row as removed (add a `removed_at` column? Add to
--     migration 0012 as a follow-up SQL if needed — or do a soft-delete with
--     a sentinel).
--
-- We add the column. A NULL `removed_at` means the integration is still
-- installed; a non-NULL value is the ISO8601 timestamp at which PR4's
-- `ha__integration_remove` (or a future `config_entries_updated` event drain)
-- marked the entry removed. The PR4 surface NEVER hard-deletes a row from
-- `ha_integration_ref` — the row is the audit trail "Alfred installed and
-- then removed this integration".
--
-- Idempotent: `ALTER TABLE … ADD COLUMN` followed by `CREATE INDEX IF NOT
-- EXISTS`. The ALTER is not gated on a PRAGMA check because SQLite has no
-- "ADD COLUMN IF NOT EXISTS" — `runMigrations` skips this delta entirely
-- once user_version >= 12, so the ALTER only ever runs once per DB.

ALTER TABLE ha_integration_ref ADD COLUMN removed_at TEXT;

-- Index on removed_at for the "still installed by Alfred" filter.
CREATE INDEX IF NOT EXISTS idx_ha_integration_ref_removed
  ON ha_integration_ref(removed_at);
