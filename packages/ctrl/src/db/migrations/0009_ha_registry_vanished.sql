-- 0009_ha_registry_vanished — tombstone column for the HA registry (#110 PR5).
--
-- HaBootstrapWorkflow Phase A (alfred-learn, every 6h + on demand) pulls the
-- HA install's full entity / area / device / automation surface and POSTs it
-- to ctrl-api's new `/api/v1/channels/ha/registry/bulk` route. The route
-- upserts the rows it received AND tombstones (NOT deletes) every existing
-- ha_registry row whose ha_id wasn't in the new pull.
--
-- The tombstone is a `vanished_at` timestamp instead of a row delete because:
--
--   * the principal can investigate "where did the kitchen light go?" — the
--     row remains queryable until they explicitly clear it on disconnect;
--   * a transient HA outage that produces a partial pull (one domain failed)
--     should not silently wipe rows the next-tick refresh will restore;
--   * the loop-guard's audit ledger (ha_run) carries entity_ids that may
--     reference vanished entities — keeping the row preserves the audit join.
--
-- The bulk route stamps vanished_at exactly ONCE per row — a re-run with the
-- same vanished set does NOT re-stamp (the route's UPDATE filters on
-- `vanished_at IS NULL`). This is asserted by channels_ha_pr5.test.ts.
--
-- We also add an index over `last_seen_at` because the dashboard's
-- "recently-seen entities" surface (PR6) needs an O(log n) scan, and the
-- partial index over `vanished_at IS NULL` keeps the "live entities" read
-- cheap regardless of how many tombstones accumulate.

ALTER TABLE ha_registry ADD COLUMN vanished_at TEXT;

CREATE INDEX IF NOT EXISTS idx_ha_registry_live
  ON ha_registry(kind, ha_id)
  WHERE vanished_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ha_registry_last_seen
  ON ha_registry(last_seen_at DESC);
