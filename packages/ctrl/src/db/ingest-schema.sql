-- ============================================================================
-- ingest.db — Store 4 of the alfred-black four-store architecture.
--
-- Raw inbound stream events: the firehose of everything arriving from the
-- principal's channels (email, Telegram, Slack, omi, webhooks, …) before any
-- extraction has happened.
--
-- WHY A SEPARATE FILE (not a table in state.db): a firehose burst must never
-- take the write lock on state.db. ctrl-api opens this as a second, distinct
-- SQLite handle. It is still single-writer (ctrl-api only).
--
-- HARD 7-DAY TTL: a stream event is raw input. Once consumed (extracted into
-- signals in state.db) it has no further value; uncosumed events older than
-- 7d are stale and dropped too. A periodic sweep enforces this — see
-- src/db/ingest.ts `sweepIngestTTL`. There is no archive: this store is
-- consume-then-delete by design.
--
-- NATS/JetStream was considered and rejected for the single-VM "just works"
-- box (no daemon). It stays a documented future option.
--
-- PRAGMAs are applied by src/db/ingest.ts at open time.
-- ============================================================================

CREATE TABLE IF NOT EXISTS stream_event (
  id            TEXT PRIMARY KEY,            -- ulid (also gives sequential ordering)
  ts            TEXT NOT NULL,               -- ISO8601 — arrival time (TTL anchor)
  stream        TEXT NOT NULL,               -- logical stream, e.g. "email" | "telegram"
  channel       TEXT,                        -- channel / account the event came in on
  external_id   TEXT,                        -- upstream id (dedupe key), if any
  kind          TEXT NOT NULL DEFAULT 'message', -- message | attachment | webhook | …
  payload_json  TEXT NOT NULL,               -- the raw inbound payload
  processed_at  TEXT,                        -- set when EventProcessor consumes it; NULL = pending
  processed_by  TEXT,                        -- worker / workflow that consumed it
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- Poison-event handling (#311). A malformed or unsupported event used to
  -- fail forever, burning workflow capacity and hiding genuinely new
  -- failures. Consumers report each failure; the row dead-letters when the
  -- error is non-retryable or the retry budget is exhausted.
  failure_count      INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  dead_lettered_at   TEXT,                   -- non-NULL = terminal, off the pending feed
  dead_letter_reason TEXT
);

-- Operator surface: list the poison queue newest-first.
CREATE INDEX IF NOT EXISTS idx_stream_event_dead_letter
  ON stream_event(dead_lettered_at) WHERE dead_lettered_at IS NOT NULL;

-- Sequential consume: EventProcessor walks pending events oldest-first.
CREATE INDEX IF NOT EXISTS idx_stream_event_pending
  ON stream_event(processed_at, ts) WHERE processed_at IS NULL;

-- TTL sweep walks by arrival time.
CREATE INDEX IF NOT EXISTS idx_stream_event_ts ON stream_event(ts);

-- Per-stream queries + dedupe.
CREATE INDEX IF NOT EXISTS idx_stream_event_stream ON stream_event(stream, ts DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_event_external
  ON stream_event(stream, external_id) WHERE external_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- ingest_sweep_log — one row per TTL sweep run, for observability.
--
-- The sweep also alerts on stream events still unprocessed at the 7d mark:
-- that means the EventProcessor has fallen behind or wedged. `stale_dropped`
-- counts unprocessed events that aged out without ever being consumed.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_sweep_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at          TEXT NOT NULL DEFAULT (datetime('now')),
  cutoff_ts       TEXT NOT NULL,             -- events with ts < cutoff were deleted
  total_deleted   INTEGER NOT NULL DEFAULT 0,
  processed_deleted INTEGER NOT NULL DEFAULT 0, -- consumed-then-aged-out (healthy)
  stale_dropped   INTEGER NOT NULL DEFAULT 0    -- never-consumed-then-aged-out (alert!)
);
CREATE INDEX IF NOT EXISTS idx_ingest_sweep_ran ON ingest_sweep_log(ran_at DESC);
