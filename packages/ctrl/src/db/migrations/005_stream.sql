-- 005_stream.sql
--
-- Phase 4 of the Storage Architecture migration (epic #898).
-- Adds the two Phase 4 tables that turn /vault/stream_event/*.md (one .md
-- per inbound event, ~7k files on david at steady state) into a
-- date-partitioned JSONL log (`/vault/_raw/YYYY-MM-DD.jsonl`) with
-- per-consumer offset tracking and processed-at metadata.
--
-- Per STORAGE-ARCHITECTURE.md §3 Store 4 and §5 "Lifecycle":
--
--   * stream_consumer_offset — points a named consumer (e.g.
--     'event_processor') at the next unread line of a given date file.
--     Advanced atomically by GET /api/v1/streams/events when a batch is
--     handed to the consumer; replays + restarts resume from the offset
--     instead of re-reading the whole file.
--
--   * stream_event_processed — records that a specific event id was
--     consumed. Used by:
--       (a) idempotency on POST /streams/events/:id/processed
--       (b) the daily compactor — events older than 7d that are
--           present in this table are dropped from the JSONL; events
--           older than 7d but missing here are kept (worker is stuck;
--           STORE-P4-2 will alert).
--       (c) join-on-id when re-reading historic JSONL for forensic
--           purposes.
--
-- ts_ns / processed_at are unix nanoseconds and exceed Number.MAX_SAFE_INTEGER.
-- Every SELECT that touches them in TypeScript must call
-- `stmt.setReadBigInts(true)` (STORE-P1-4 hotfix lesson).

CREATE TABLE IF NOT EXISTS stream_consumer_offset (
  consumer    TEXT NOT NULL,            -- 'event_processor' | future consumers
  date        TEXT NOT NULL,            -- 'YYYY-MM-DD' partition file
  line_offset INTEGER NOT NULL,         -- next unread 0-based line index
  updated_at  INTEGER NOT NULL,         -- unix ns
  PRIMARY KEY (consumer, date)
);

CREATE INDEX IF NOT EXISTS sco_consumer ON stream_consumer_offset(consumer);

CREATE TABLE IF NOT EXISTS stream_event_processed (
  event_id     TEXT PRIMARY KEY,
  date         TEXT NOT NULL,           -- 'YYYY-MM-DD' file the event came from
  processed_at INTEGER NOT NULL,        -- unix ns
  consumer     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sep_date         ON stream_event_processed(date);
CREATE INDEX IF NOT EXISTS sep_processed_at ON stream_event_processed(processed_at);
