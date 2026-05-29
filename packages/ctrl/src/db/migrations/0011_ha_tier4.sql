-- 0011_ha_tier4 — Tier 4 HA autonomy (#115/#158 PR1).
--
-- Three new state.db tables backing the Tier 4 verbs:
--
--   ha_backup_ref      — every HA backup Alfred triggers (auto-snapshot
--                        before destructive verbs + explicit user requests).
--                        Carries the decision_ref that triggered the snapshot
--                        so a rollback can be tied back to the Desk click.
--   ha_integration_ref — which config_entry_ids Alfred installed vs the
--                        ones the principal added directly through HA's UI.
--                        Lets the Desk surface "the 3 integrations Alfred
--                        added this week" cleanly without grepping ha_run.
--   ha_user_ref        — per-HA-user record for accounts Alfred provisioned
--                        (PR8). Holds the Vaultwarden item id where the
--                        per-user LLAT lives (NEVER stored here directly).
--
-- This migration is additive only — it does NOT touch the existing
-- `ha_event` table (shipped in 0005_ha_channel.sql with a ulid PK + signaled
-- column + entity_id index). The Tier 4 WS client drains into the SAME
-- ha_event table by writing `signaled=0` rows so the existing loop guard
-- and #110 PR3 watcher contract continue to apply. New event types
-- (area_registry_updated / device_registry_updated / entity_registry_updated
-- / config_entries_updated) sit alongside state_changed without a schema
-- change — `event_type` already varies on every existing PR4 subscription.
--
-- The PR1 spec called this slot "0009_ha_tier4.sql" but 0009 + 0010 were
-- already taken by #110 PR5 + #114 PR5 between spec draft and PR1 build.
-- 0011 is the next free slot; the table definitions are unchanged from
-- spec §5.3.

-- ────────────────────────────────────────────────────────────────────────
-- ha_backup_ref — auto-snapshot ledger.
-- ────────────────────────────────────────────────────────────────────────
-- Written by `triggerBackupBeforeAction` (api/lib/ha_snapshot.ts) every
-- time a destructive verb (core_restart, core_update, addon_install,
-- integration_add, …) runs. Carries the trigger reason + the Desk
-- decision_ref so rollback flows can tie a snapshot back to "the click
-- that caused it". `ha_backup_id` is the id HA itself returned from
-- `backup/generate`, not the same as our local `id` (a ulid).
CREATE TABLE IF NOT EXISTS ha_backup_ref (
  id            TEXT PRIMARY KEY,                 -- ulid (ours)
  ha_backup_id  TEXT NOT NULL,                    -- HA's own backup id
  triggered_by  TEXT NOT NULL,                    -- 'ha__core_restart' / 'ha__addon_install' / 'ha__user_request' / …
  decision_ref  TEXT,                             -- Desk decision id when triggered by a destructive verb; NULL for user-initiated
  ts            TEXT NOT NULL                     -- ISO8601
);
CREATE INDEX IF NOT EXISTS idx_ha_backup_ref_ts        ON ha_backup_ref(ts DESC);
CREATE INDEX IF NOT EXISTS idx_ha_backup_ref_decision  ON ha_backup_ref(decision_ref) WHERE decision_ref IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────
-- ha_integration_ref — "Alfred installed this integration".
-- ────────────────────────────────────────────────────────────────────────
-- Populated by PR4 (`ha__integration_configure` final step) and by the
-- WS event drain when a `config_entries_updated` event lands. The
-- `installed_by` column distinguishes alfred-added entries from
-- principal-added ones so the Desk can show them separately.
CREATE TABLE IF NOT EXISTS ha_integration_ref (
  entry_id      TEXT PRIMARY KEY,                 -- HA config_entry id
  installed_by  TEXT NOT NULL,                    -- 'alfred' | 'sir'
  decision_ref  TEXT,                             -- Desk decision id when installed_by='alfred'
  installed_at  TEXT NOT NULL                     -- ISO8601
);
CREATE INDEX IF NOT EXISTS idx_ha_integration_ref_installed_by ON ha_integration_ref(installed_by);

-- ────────────────────────────────────────────────────────────────────────
-- ha_user_ref — HA-side user accounts Alfred provisioned (PR8).
-- ────────────────────────────────────────────────────────────────────────
-- The LLAT for each provisioned user lives in Vaultwarden — `llat_vw_id`
-- references that item. Never store the LLAT itself.
CREATE TABLE IF NOT EXISTS ha_user_ref (
  ha_user_id    TEXT PRIMARY KEY,                 -- HA's user id
  name          TEXT,                             -- the user's display name
  decision_ref  TEXT,                             -- Desk decision id that authorised the create
  llat_vw_id    TEXT,                             -- Vaultwarden item id holding the LLAT (NEVER the LLAT itself)
  created_at    TEXT NOT NULL                     -- ISO8601
);
CREATE INDEX IF NOT EXISTS idx_ha_user_ref_created ON ha_user_ref(created_at DESC);
