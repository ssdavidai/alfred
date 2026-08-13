-- 0020_nar_entry — the per-action displacement atom for Net Attention
-- Returned. Item 3 of the #563 sequence.
--
-- What this table is for.
--
-- NAR = accepted work displaced, less the cost of supervising it. Nothing in
-- the system currently records what a displaced piece of work was WORTH: we
-- can count 33 delegations but cannot say what they would have cost the
-- principal by hand. Every other term in the formula subtracts from that
-- unknown. This table is that missing record — one row per thing Alfred did,
-- written close to the action by the nightly recap (#563 item 4).
--
-- Scope: displacement only.
--
-- This table deliberately does NOT carry per-entry prompting / review /
-- correction minutes, even though an obvious reading of the formula suggests
-- it should. Engaged time is a property of a PERIOD, not of one action —
-- twelve Desk clicks inside six minutes is six minutes of attention, not
-- twelve durations. Attributing it per entry would invent precision that the
-- evidence does not support. The subtraction terms are computed at statement
-- time: engaged time by burst-clustering timestamps (see db/engagedTime.ts),
-- interruption by counting unsolicited outbound (alfred_journal.solicited).
--
-- Acceptance is split, and the halves must never be merged.
--
-- Per #563: explicit acceptance is unambiguous and already recorded — done or
-- delegated through the Desk, a commitment reaching accepted, an approved
-- hours proposal. Inferred acceptance is the recap concluding from a session
-- that a task was carried out. Inferred is weaker evidence and must be
-- labelled as such on the statement, never blended into the explicit total.
-- Hence acceptance_path: a reader can always separate the two.
--
-- Nulls are meaningful, not missing.
--
--   baseline_minutes NULL   no defensible counterfactual was established.
--   displaced_minutes NULL  no claim is being made for this entry.
--
-- "No baseline, no claim" is the rule (#563). A NULL here must render on the
-- statement as an explicit "not established", never silently as zero and
-- never quietly dropped from the count.
--
-- Idempotency.
--
-- The recap will be re-run — by hand while the approach is being worked out,
-- and after failures once it is scheduled. dedup_key is a deterministic
-- handle the writer computes from what it observed, so a second pass over the
-- same day updates rather than duplicates. Without it, one re-run silently
-- doubles a month's displaced total.

CREATE TABLE IF NOT EXISTS nar_entry (
  id                TEXT PRIMARY KEY,           -- ULID
  dedup_key         TEXT NOT NULL UNIQUE,       -- deterministic; re-running the recap must not duplicate

  occurred_at       TEXT NOT NULL,              -- ISO-8601 UTC, when the work happened (not when recorded)
  action_class      TEXT NOT NULL,              -- 'desk_decision' | 'commitment' | 'chore_run' | 'conversational' | …
  summary           TEXT NOT NULL,              -- one line, human readable — this is what the principal reads

  -- Drill-down. "A number you cannot drill into is marketing" (#563).
  evidence_kind     TEXT NOT NULL,              -- 'decision' | 'commitment' | 'chore_run' | 'session' | 'audit'
  evidence_ref      TEXT NOT NULL,              -- id or vault path of the source record
  session_ref       TEXT,                       -- hermes session id, where the work happened in one

  -- The counterfactual.
  baseline_minutes  REAL,                       -- NULL = not established
  estimation_method TEXT,                       -- 'standard-time' | 'timed-sample' | 'observed-history'
                                                -- | 'model-estimate' | 'client-estimate'

  -- Acceptance.
  acceptance        TEXT NOT NULL DEFAULT 'unknown',  -- 'accepted' | 'rejected' | 'unknown'
  acceptance_path   TEXT,                       -- 'explicit' | 'inferred'; NULL when acceptance='unknown'
  acceptance_basis  TEXT,                       -- how we know — the sentence a sceptic gets

  displaced_minutes REAL,                       -- credited after the acceptance rule; NULL = no claim

  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  locked_at         TEXT,                       -- set once included in a signed statement; amendments need an audit note

  CHECK (acceptance IN ('accepted', 'rejected', 'unknown')),
  CHECK (acceptance_path IS NULL OR acceptance_path IN ('explicit', 'inferred')),
  CHECK (estimation_method IS NULL OR estimation_method IN
         ('standard-time', 'timed-sample', 'observed-history', 'model-estimate', 'client-estimate')),
  -- An entry claiming displacement must say how it was estimated. This is the
  -- one place a soft number could enter unchallenged, so the schema refuses it.
  CHECK (displaced_minutes IS NULL OR estimation_method IS NOT NULL)
);

-- Period aggregation: every statement query is a range scan over occurred_at.
CREATE INDEX IF NOT EXISTS idx_nar_entry_occurred ON nar_entry(occurred_at);

-- Drill-down from a source record back to what was claimed for it.
CREATE INDEX IF NOT EXISTS idx_nar_entry_evidence ON nar_entry(evidence_kind, evidence_ref);
