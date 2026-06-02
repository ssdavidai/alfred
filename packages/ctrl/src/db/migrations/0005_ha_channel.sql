-- 0003_ha_channel — Home Assistant channel state.db schema (#110 PR1).
--
-- Lands the 7 ha_* tables that back the Home Assistant integration shipped
-- by issue #110 (docs/specs/issue-110-ha-deep-integration.md §5.5):
--
--   ha_connection   — the singleton record of the principal's HA install
--                     (URL, version, reachability). The LLAT itself lives
--                     in Vaultwarden, NEVER here; this table only carries
--                     a vault_item_id reference.
--   ha_registry     — cached entities / devices / areas / automations /
--                     scenes / helpers from HA. Refreshed by Phase A of
--                     HaBootstrapWorkflow (PR5) every 6h + on demand.
--   ha_proposal     — baseline automation packs Alfred proposes (Phase C,
--                     PR6). Status flows pending → approved/applied/…
--   ha_gap          — gaps Phase B finds in the HA install ("no morning
--                     routine", "no motion lighting"); each gap can
--                     produce a proposal.
--   ha_run          — every write Alfred makes against HA (service_call,
--                     automation_create, etc.). Carries the LOAD-BEARING
--                     decision_ref + created_at columns for the loop guard
--                     (see comment block on ha_run below).
--   ha_event        — capped ring buffer of HA WS events the watcher saw,
--                     populated by HaWatcherWorkflow (PR3). Diagnostic.
--   ha_snapshot     — pre-apply YAML snapshots for rollback on Phase E
--                     automation/scene writes (PR6).
--
-- Numbering note. If another PR lands a migration 0003 first, this file
-- will need a rename (next free slot) in a follow-up commit before merge.
-- The spec (§5.5) labels this `0003_ha_channel.sql`.
--
-- ────────────────────────────────────────────────────────────────────────
-- Loop guard contract (§3 of the spec, RESOLVED Q11) — load-bearing.
-- ────────────────────────────────────────────────────────────────────────
-- The fundamental safety boundary between #110 (Alfred → HA writes) and
-- #111 (HA → Alfred conversation agent) is that Alfred's OWN writes must
-- not flow back through the WS event stream as fresh principal-relevant
-- signals. Without the guard, `ha__call_service` toggling the kitchen
-- light would echo back as a state_changed event → ingest as a
-- stream_event → matter the Desk presents as a card → propose a chore
-- → call ha__call_service again. A closed loop.
--
-- The contract:
--   1. Every write (ha__call_service, ha__create_automation,
--      ha__update_automation, ha__delete_automation, ha__create_scene,
--      ha__apply_baseline) MINTS a `decision_ref` (ulid) BEFORE issuing
--      the upstream HA request.
--   2. The write is persisted in `ha_run` with that `decision_ref` and a
--      `created_at` timestamp.
--   3. HaWatcherWorkflow (PR3), on every inbound state_changed WS event,
--      looks up `ha_run` by `(entity_id, created_at > now() - 30s,
--      decision_ref IS NOT NULL)`. If a match exists, the event is
--      SUPPRESSED at the watcher's ingress — it never becomes a
--      stream_event, never lands as a signal, never reaches the Desk.
--      The `ha_event` ring still keeps it (with signaled=0) for forensic.
--
-- The partial index `idx_ha_run_entity_recent` below is what makes step 3
-- cheap: it indexes ONLY rows that participate in the loop-guard match
-- (decision_ref IS NOT NULL). The watcher's per-event lookup hits an
-- entity+time tuple inside that small set.
--
-- This index + the (decision_ref, created_at) columns MUST land in PR1
-- so #111 and PR3 can both rely on the contract without an in-flight
-- schema follow-up. This migration is the freeze point.

-- ----------------------------------------------------------------------------
-- ha_connection — the singleton row describing how to reach the principal's HA.
-- ----------------------------------------------------------------------------
-- CHECK (id = 1) enforces "one tenant, one HA" (spec §7 Q8 RESOLVED — multi-HA
-- per tenant is explicitly out of scope; revisit only on explicit request).
-- The LLAT never lives here — only the Vaultwarden item id reference.
CREATE TABLE IF NOT EXISTS ha_connection (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  ha_url              TEXT    NOT NULL,
  label               TEXT    NOT NULL DEFAULT 'Home Assistant',
  vault_item_id       TEXT    NOT NULL,                       -- Vaultwarden item id, NOT the LLAT
  ha_version          TEXT,
  state               TEXT    NOT NULL DEFAULT 'connecting',  -- unconfigured|connecting|connected|error
  last_test_at        TEXT,
  last_test_ok        INTEGER NOT NULL DEFAULT 0,
  last_test_error     TEXT,
  last_discovery_at   TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ----------------------------------------------------------------------------
-- ha_registry — cached entities/devices/areas/automations/scenes/helpers.
-- ----------------------------------------------------------------------------
-- Populated by HaBootstrapWorkflow Phase A (PR5). Read by the
-- /api/v1/channels/ha/registry route (PR1 ships the empty read).
CREATE TABLE IF NOT EXISTS ha_registry (
  kind                TEXT NOT NULL,                          -- entity|device|area|automation|scene|helper
  ha_id               TEXT NOT NULL,                          -- entity_id / device_id / area_id / automation_id
  domain              TEXT,                                   -- entity domain (light/sensor/...)
  area_id             TEXT,
  friendly_name       TEXT,
  state               TEXT,                                   -- last observed state (entities only)
  attributes_json     TEXT,
  payload_json        TEXT NOT NULL,                          -- the raw HA record
  last_seen_at        TEXT NOT NULL,
  last_changed        TEXT,
  last_updated        TEXT,
  PRIMARY KEY (kind, ha_id)
);
CREATE INDEX IF NOT EXISTS idx_ha_registry_domain ON ha_registry(kind, domain);
CREATE INDEX IF NOT EXISTS idx_ha_registry_area   ON ha_registry(kind, area_id);

-- ----------------------------------------------------------------------------
-- ha_proposal — baseline automation packs Alfred proposes for approval.
-- ----------------------------------------------------------------------------
-- Status flow: pending → approved → applied | partial_applied | rejected.
-- decision_ref points at the vault `decision/…` record minted on approval
-- (so the Desk audit loop closes).
CREATE TABLE IF NOT EXISTS ha_proposal (
  id               TEXT NOT NULL PRIMARY KEY,                 -- ulid
  ts               TEXT NOT NULL,
  scope            TEXT NOT NULL,                             -- all|rooms|away|morning|evening|motion
  summary          TEXT NOT NULL,
  payload_json     TEXT NOT NULL,                             -- full pack: automations, scenes, helpers
  status           TEXT NOT NULL DEFAULT 'pending',           -- pending|approved|applied|partial_applied|rejected
  decision_ref     TEXT,                                      -- vault path of the decision/ record
  applied_at       TEXT,
  applied_summary  TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ha_proposal_status_ts ON ha_proposal(status, ts DESC);

-- ----------------------------------------------------------------------------
-- ha_gap — gaps detected during Phase B (one per missing capability).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ha_gap (
  id            TEXT NOT NULL PRIMARY KEY,                    -- ulid
  ts            TEXT NOT NULL,
  kind          TEXT NOT NULL,                                -- no_morning_routine|no_motion_lighting|...
  evidence      TEXT,
  fix_pack      TEXT,                                         -- references a baseline pack id
  proposal_ref  TEXT,                                         -- ha_proposal.id once one is emitted
  status        TEXT NOT NULL DEFAULT 'open',                 -- open|addressed|dismissed
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ha_gap_status_ts ON ha_gap(status, ts DESC);

-- ----------------------------------------------------------------------------
-- ha_run — write-audit ledger AND the loop-guard correlation table.
-- ----------------------------------------------------------------------------
-- Carries the LOAD-BEARING `decision_ref` + `created_at` columns the loop
-- guard depends on (see the header block at the top of this migration for
-- the full contract). Every HA-write tool MUST:
--
--   1. mint `decision_ref = ulid()`
--   2. INSERT a row in ha_run with that decision_ref + the target entity_id
--      BEFORE the upstream HA request fires
--   3. pass the same decision_ref down to HA so it round-trips on the
--      eventual state_changed event (when HA exposes that hook; otherwise
--      the entity_id+time match alone is the correlation key)
--
-- HaWatcherWorkflow (PR3) then SELECTs from ha_run WHERE entity_id = ? AND
-- created_at > strftime('%s','now','-30 seconds') * 1000 AND decision_ref
-- IS NOT NULL, and SUPPRESSES the event at ingress when a row matches.
CREATE TABLE IF NOT EXISTS ha_run (
  id            TEXT    NOT NULL PRIMARY KEY,                 -- ulid
  ts            TEXT    NOT NULL,
  actor         TEXT    NOT NULL,                             -- alfred-ceo|alfred-specialist|voice|desk-click|workflow
  kind          TEXT    NOT NULL,                             -- service_call|automation_create|automation_update|automation_delete|scene_create|proposal_apply
  domain        TEXT,
  service       TEXT,
  entity_id     TEXT,
  payload_json  TEXT    NOT NULL,
  outcome       TEXT    NOT NULL,                             -- ok|error
  ha_response   TEXT,
  error         TEXT,
  decision_ref  TEXT,                                         -- ulid; LOAD-BEARING for loop-guard (see header)
  created_at    INTEGER NOT NULL                              -- LOAD-BEARING for loop-guard 30s window (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_ha_run_ts ON ha_run(ts DESC);

-- Loop-guard correlation lookup. Partial — only rows with a decision_ref
-- (i.e. Alfred-originated writes) participate in the guard, so we don't
-- index every audit row needlessly. The watcher's per-event probe is:
--
--   SELECT 1 FROM ha_run
--    WHERE entity_id = ? AND decision_ref IS NOT NULL
--      AND created_at > strftime('%s','now','-30 seconds') * 1000
--    LIMIT 1;
--
-- The (entity_id, created_at) tuple matches the partial index head-on.
CREATE INDEX IF NOT EXISTS idx_ha_run_entity_recent
  ON ha_run(entity_id, created_at)
  WHERE decision_ref IS NOT NULL;

-- ----------------------------------------------------------------------------
-- ha_event — capped ring buffer of inbound HA WS events (PR3 populates).
-- ----------------------------------------------------------------------------
-- Bound by HA_WATCHER_EVENT_RING_SIZE (default 1000) via activity-side guard.
CREATE TABLE IF NOT EXISTS ha_event (
  id            TEXT    NOT NULL PRIMARY KEY,
  ts            TEXT    NOT NULL,
  event_type    TEXT    NOT NULL,
  entity_id     TEXT,
  payload_json  TEXT    NOT NULL,
  signaled      INTEGER NOT NULL DEFAULT 0,                   -- 1 if it produced a stream_event; 0 if loop-guarded
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ha_event_ts ON ha_event(ts DESC);

-- ----------------------------------------------------------------------------
-- ha_snapshot — pre-apply YAML snapshots, for the rollback button on /channels/ha.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ha_snapshot (
  id            TEXT NOT NULL PRIMARY KEY,                    -- ulid
  ts            TEXT NOT NULL,
  kind          TEXT NOT NULL,                                -- automation|scene
  ha_id         TEXT NOT NULL,
  proposal_ref  TEXT,                                         -- ha_proposal.id if part of a pack
  payload_json  TEXT NOT NULL,                                -- pre-change full YAML
  restored_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ha_snapshot_ts ON ha_snapshot(ts DESC);
