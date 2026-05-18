-- 003_audit.sql
--
-- Phase 2 of the Storage Architecture migration (epic #898).
-- Adds the unified `audit` table that replaces six markdown
-- audit-record types currently filed under /vault/event/
-- (state-change-*, signal-action-*, steward-action-*,
-- desk-action-*, needs-attention-action-*, auto-task-created-*).
--
-- Layout follows STORAGE-ARCHITECTURE.md §5: one row per audited
-- action, keyed by id (UUIDv4 or content-derived), with ts in
-- unix nanoseconds. payload carries the action-type-specific JSON.
--
-- Subsequent issues (P2-2 writers, P2-3 bulk migration, P2-4
-- SaaS read-side) build on this foundation.

CREATE TABLE IF NOT EXISTS audit (
  id              TEXT PRIMARY KEY,            -- UUIDv4 or content-derived
  ts              INTEGER NOT NULL,            -- unix ns
  actor           TEXT NOT NULL,               -- 'steward' | 'desk' | 'router' | 'signal_router' | 'task_creation' | 'state_mutator'
  action_type     TEXT NOT NULL,               -- 'state_change' | 'signal_action' | 'steward_action' | 'desk_action' | 'needs_attention_action' | 'auto_task_created'
  target_type     TEXT NOT NULL,               -- 'matter' | 'task' | 'signal' | 'needs_attention' | etc.
  target_id       TEXT NOT NULL,               -- vault path or signal id
  decision_origin TEXT,                        -- nullable
  reasoning       TEXT,                        -- nullable
  payload         TEXT NOT NULL,               -- JSON; varies by action_type
  reversible      INTEGER NOT NULL DEFAULT 0,  -- 0/1
  reversed_by     TEXT                         -- FK into audit(id), nullable
);

CREATE INDEX IF NOT EXISTS audit_ts              ON audit(ts DESC);
CREATE INDEX IF NOT EXISTS audit_target          ON audit(target_type, target_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_actor           ON audit(actor, ts DESC);
CREATE INDEX IF NOT EXISTS audit_action          ON audit(action_type, ts DESC);
CREATE INDEX IF NOT EXISTS audit_reversible_open ON audit(reversible) WHERE reversible = 1 AND reversed_by IS NULL;
