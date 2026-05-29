-- 0008_ha_event_subscription — Home Assistant event subscription registry (#110 PR4).
--
-- One row per active WS subscription. PR4 ships `ha__subscribe_events`
-- (MCP tool) → POST /api/v1/channels/ha/subscribe (ctrl-api), which spawns
-- a long-lived WS subscriber against HA's `subscribe_events`. We track the
-- live subscriptions here so:
--
--   * /channels/ha can surface them in the dashboard
--   * an operator-side restart can resume them (PR5 will wire the resume)
--   * tests can assert the lifecycle (open → events flowing → close)
--
-- This is a small registry table — the heavy lifting is the per-subscription
-- WS connection living in-process. `closed_at` IS NULL means "active";
-- DELETE /subscribe/:id sets it to a timestamp instead of removing the row,
-- so the closed-subscription history stays auditable.
--
-- Numbering: the spec didn't name a slot here (it ships under PR4's umbrella,
-- which lands after PR1's `ha_event`). 0008 is the next free migration slot
-- in this codebase (0001…0007 already taken).

CREATE TABLE IF NOT EXISTS ha_event_subscription (
  id             TEXT    NOT NULL PRIMARY KEY,            -- ulid
  filter_json    TEXT,                                    -- JSON filter (event_type, entity_id, …) or NULL = all
  started_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  last_event_at  TEXT,                                    -- bumped per inbound event the WS observes
  closed_at      TEXT                                     -- NULL while live; ISO ts on DELETE /subscribe/:id
);
CREATE INDEX IF NOT EXISTS idx_ha_event_sub_open
  ON ha_event_subscription(closed_at)
  WHERE closed_at IS NULL;
