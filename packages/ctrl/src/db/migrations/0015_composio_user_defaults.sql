-- 0015_composio_user_defaults — Composio primary-entity defaults cache (Phase C).
--
-- Sir's "what's on my calendar tomorrow" used to fan out across all 7 of his
-- connected Google calendars: Hermes called GOOGLECALENDAR_LIST_CALENDARS,
-- then iterated GOOGLECALENDAR_EVENTS_LIST per id. After Phase A (HTTP
-- sidecar) the per-call cost dropped from ~4.5s to ~500ms, but the FANOUT
-- itself still adds ~25-30s to the wall.
--
-- Phase C caches the user's primary calendar id (and Gmail primary inbox,
-- Notion default workspace as the same pattern lands for those toolkits) so
-- the sidecar can inject `calendarId: <id>` into the args before the SDK
-- call — Hermes' single GOOGLECALENDAR_EVENTS_LIST request then targets the
-- right calendar without the LIST_CALENDARS scan.
--
-- The cache is written at OAuth-completion time by ctrl-api's
-- /api/v1/integrations/:id/auto-config handler (one call to
-- GOOGLECALENDAR_LIST_CALENDARS per connection, picks the entry where
-- `primary === true` or id === 'primary'). It can be force-refreshed via
-- POST /api/v1/integrations/:toolkit/refresh-defaults.
--
-- Composite primary key on (toolkit, user_id) — every tenant has its own
-- COMPOSIO_USER_ID, so a single tenant has at most one row per toolkit. The
-- table never grows past `(toolkits × tenants)` rows.

CREATE TABLE IF NOT EXISTS composio_user_defaults (
  toolkit TEXT NOT NULL,             -- 'googlecalendar' | 'gmail' | 'notion' | ...
  user_id TEXT NOT NULL,             -- COMPOSIO_USER_ID (per-tenant)
  default_args_json TEXT NOT NULL,   -- JSON object — args to merge into composio_execute
  updated_at TEXT NOT NULL,
  source TEXT,                       -- 'oauth_completion' | 'user_explicit' | 'discovery'
  PRIMARY KEY (toolkit, user_id)
);

CREATE INDEX IF NOT EXISTS idx_composio_user_defaults_updated
  ON composio_user_defaults (updated_at);
