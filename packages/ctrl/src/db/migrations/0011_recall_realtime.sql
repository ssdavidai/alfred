-- 0011_recall_realtime — Recall.ai in-meeting voice (#113 PR5).
--
-- Extends migration 0007_recall with the columns + the table that drive
-- the active half of Recall: bots that not only listen but speak into the
-- meeting when summoned by the wake word.
--
-- New on recall_bot:
--
--   realtime_url             — Recall's per-bot WebSocket endpoint for
--                              real-time audio + transcript streaming.
--                              Populated either by the create-bot response
--                              (if Recall returns it) or by the first
--                              webhook event that carries it. NULL until
--                              we have it.
--   meeting_context_json     — pre-baked persona context for the bot's
--                              voice-bridge session: calendar event title,
--                              attendees, agenda hints, Sir's recent
--                              decisions about the attendees. Populated
--                              once on dispatch + refreshed lazily.
--   wake_word_triggers       — counter: how many times the wake word fired
--                              for this bot. Surfaces on the live-bots
--                              card so Sir can see how chatty Alfred was
--                              in the meeting.
--   muted                    — operator toggle. When 1, the wake-word
--                              detector still runs (we keep the audit
--                              trail) but Alfred does NOT speak. Resumes
--                              on /unmute.
--
-- New table recall_transcript_event:
--
--   Append-only ledger of transcript fragments arriving over the bot's
--   real-time WS. Both `partial` and `final` fragments are persisted —
--   partial fragments overwrite their predecessor in the SSE stream view
--   but live as separate rows for forensic replay. The wake-word matcher
--   looks at `final` rows only (a partial that says "Hey Alf…" shouldn't
--   trigger a response that ends up addressed to the wrong context).
--
-- Index choices:
--   - recall_transcript_event.bot_id is the only hot read path; the SSE
--     endpoint streams "all events for bot X after timestamp T".
--   - PRIMARY KEY id (autoincrement) gives a stable cursor for SSE
--     resumption.

ALTER TABLE recall_bot ADD COLUMN realtime_url TEXT;
ALTER TABLE recall_bot ADD COLUMN meeting_context_json TEXT;
ALTER TABLE recall_bot ADD COLUMN wake_word_triggers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recall_bot ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS recall_transcript_event (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id        TEXT    NOT NULL,
  kind          TEXT    NOT NULL,                  -- 'partial' | 'final' | 'response'
  speaker       TEXT,                              -- best-effort speaker label
  text          TEXT    NOT NULL,
  ts_ms         INTEGER NOT NULL,                  -- ms since epoch when received
  meeting_ms    INTEGER                            -- ms since meeting start (if known)
);

CREATE INDEX IF NOT EXISTS idx_recall_transcript_bot_ts
  ON recall_transcript_event(bot_id, ts_ms);
