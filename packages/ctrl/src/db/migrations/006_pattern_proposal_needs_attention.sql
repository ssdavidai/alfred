-- 006_pattern_proposal_needs_attention.sql
--
-- Phase 6 lock-down of the Storage Architecture migration (epic #898,
-- followup #478). Adds the two remaining SQL homes required before
-- alfred-learn can drop its legacy vault writers (pattern_proposal,
-- needs_attention) and CANONICAL_PATH_ENFORCEMENT can flip from
-- `warn` to `enforce`.
--
-- The signal and event paths already moved (P3-2 → signal table,
-- P2-1 → audit table). This migration covers the remaining two:
--
--   pattern_proposal — derived intelligence records proposed by
--                      PatternDetectionWorkflow; principal approves
--                      or rejects via /instincts.
--   needs_attention  — Desk cards. The state machine the Desk swipe
--                      UI mutates (done / skipped / dispatched).
--
-- Layout follows STORAGE-ARCHITECTURE.md §5: one row per record,
-- keyed by id (UUIDv4 or content-derived), with ts in unix
-- nanoseconds. payload carries the legacy frontmatter JSON for
-- forensic / migration debugging.

CREATE TABLE IF NOT EXISTS pattern_proposal (
  id              TEXT PRIMARY KEY,
  ts              INTEGER NOT NULL,         -- unix ns
  proposed_name   TEXT NOT NULL,
  proposed_body   TEXT NOT NULL,            -- the markdown body (description, examples)
  cluster_size    INTEGER NOT NULL DEFAULT 0,
  member_observation_ids TEXT,              -- JSON array of observation ids
  status          TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected'
  reviewed_at     INTEGER,
  reviewed_by     TEXT,
  promoted_to_instinct_id TEXT,             -- if approved → vault path
  payload         TEXT                      -- JSON; raw frontmatter for forensic
);
CREATE INDEX IF NOT EXISTS pp_ts ON pattern_proposal(ts DESC);
CREATE INDEX IF NOT EXISTS pp_status ON pattern_proposal(status, ts DESC);

CREATE TABLE IF NOT EXISTS needs_attention (
  id              TEXT PRIMARY KEY,
  ts              INTEGER NOT NULL,         -- unix ns
  source_signal_id TEXT,                    -- FK-soft to signal.id
  target_matter   TEXT,                     -- vault path or null
  target_kind     TEXT,
  headline        TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'done' | 'skipped' | 'dispatched'
  resolved_at     INTEGER,
  resolved_by     TEXT,                     -- 'desk' | 'auto' | <user>
  resolution      TEXT,                     -- JSON; verb + target
  payload         TEXT                      -- JSON; full frontmatter for forensic
);
CREATE INDEX IF NOT EXISTS na_ts ON needs_attention(ts DESC);
CREATE INDEX IF NOT EXISTS na_status ON needs_attention(status, ts DESC);
CREATE INDEX IF NOT EXISTS na_target_matter ON needs_attention(target_matter, ts DESC);
CREATE INDEX IF NOT EXISTS na_pending_partial ON needs_attention(ts DESC) WHERE status = 'pending';
