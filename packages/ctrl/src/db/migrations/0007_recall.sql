-- 0007_recall — Recall.ai channel tables (#113 PR2).
--
-- Replaces the retired Vexa stack (#113 PR1) with the SaaS Recall.ai
-- bot model. Three tables land here; the routes in
-- routes/channels_recall.ts and routes/webhooks/recall.ts read/write
-- them. Subsequent PRs (3a/3b for the /channels card, PR4 for the
-- alfred-learn workflows, PR5/6 for the voice/webpage path) extend
-- this schema additively — never edit this file once merged; append
-- a numbered follow-up migration instead (state.db migration rule).
--
-- Schema overview (spec §5.4.1):
--
--   recall_config — singleton row (id=1) carrying the operator-tunable
--     dials the /channels card edits. `cost_alert_thresholds_json` is
--     a JSON array of percentage thresholds (e.g. [80, 100]); the
--     monthly-hours-cap enforcer (PR7) reads it on each rollup.
--
--   recall_bot — one row per dispatched bot. `id` is Recall's own bot
--     id (we use it as primary key so the webhook handler can update
--     by id without a separate lookup). `json` holds the full bot
--     payload Recall returned at create time — kept verbatim so we
--     can re-derive any field without a migration.
--
--   recall_event — append-only ledger of webhook deliveries. Every
--     verified inbound webhook lands one row here; the lifecycle
--     events (bot.joined / bot.left / transcript.done / etc.) also
--     update the parent `recall_bot.status` row in the same
--     transaction. The full payload is preserved in
--     `payload_json` for forensic replay.

CREATE TABLE IF NOT EXISTS recall_config (
  id                          INTEGER PRIMARY KEY CHECK(id = 1),
  region                      TEXT    NOT NULL DEFAULT 'us-east-1',
  bot_name                    TEXT    NOT NULL DEFAULT 'Alfred''s note-taker',
  announces_on_join           INTEGER NOT NULL DEFAULT 1,
  auto_join_policy            TEXT    NOT NULL DEFAULT 'principal_attendee',
  calendar_source             TEXT    NOT NULL DEFAULT 'composio',
  monthly_hours_cap           INTEGER NOT NULL DEFAULT 60,
  leave_after_minutes         INTEGER NOT NULL DEFAULT 90,
  respond_mode                TEXT    NOT NULL DEFAULT 'on_mention',
  wake_word                   TEXT    NOT NULL DEFAULT 'Alfred',
  cost_alert_thresholds_json  TEXT    NOT NULL DEFAULT '[80, 100]',
  updated_at                  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recall_bot (
  id                  TEXT PRIMARY KEY,            -- Recall's bot id
  calendar_event_id   TEXT,                        -- gcal event id (Composio)
  meeting_url         TEXT,                        -- raw meet/zoom/teams URL
  status              TEXT NOT NULL,               -- requested|joining|in_meeting|leaving|done|fail
  created_at          INTEGER NOT NULL,
  joined_at           INTEGER,
  left_at             INTEGER,
  transcript_url      TEXT,
  json                TEXT NOT NULL                -- full Recall create-bot payload
);

CREATE TABLE IF NOT EXISTS recall_event (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id        TEXT,                              -- nullable: lifecycle events with no bot
  event_type    TEXT    NOT NULL,                  -- e.g. bot.joined, transcript.done
  event_at      INTEGER NOT NULL,
  payload_json  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recall_bot_status
  ON recall_bot(status);

CREATE INDEX IF NOT EXISTS idx_recall_bot_calendar
  ON recall_bot(calendar_event_id);

CREATE INDEX IF NOT EXISTS idx_recall_event_bot
  ON recall_event(bot_id);
